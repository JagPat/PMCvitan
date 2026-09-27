import { describe, it, expect } from 'vitest';
import { AccountRosterError, parseAccountRoster, refusedBackfillProblems, type AccountSpec } from './account-roster';

/**
 * 4d-ii-a / A3a — `ensure-accounts` judges its WHOLE roster before its first write (plan §A.1,
 * P28b): an `architect` entry is refused with the entry named, and nothing is written.
 */
describe('the provisioning roster (4d-ii-a / A3a)', () => {
  const defaults: AccountSpec[] = [{ role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' }];

  it('uses the default roster when ACCOUNTS_JSON is absent or blank', () => {
    expect(parseAccountRoster(undefined, defaults)).toEqual(defaults);
    expect(parseAccountRoster('   ', defaults)).toEqual(defaults);
  });

  it('admits a pmc-only file, and a role beyond the default four (the roster is the deployment\'s)', () => {
    const roster = [
      { role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' },
      { role: 'consultant', name: 'Structural', email: 'sc@vitan.in' },
    ];
    expect(parseAccountRoster(JSON.stringify(roster), defaults)).toEqual(roster);
  });

  it('refuses a roster holding an architect entry, naming the entry, whatever else it holds', () => {
    const raw = JSON.stringify([
      { role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' },
      { role: 'architect', name: 'Ar. Mehta', email: 'mehta@vitan.in' },
    ]);
    const refusal = (() => { try { parseAccountRoster(raw, defaults); } catch (e) { return e; } })();
    expect(refusal).toBeInstanceOf(AccountRosterError);
    expect((refusal as AccountRosterError).problems).toEqual([
      expect.stringMatching(/^entry #2 \(Ar\. Mehta, mehta@vitan\.in\) has role "architect"/),
    ]);
    expect((refusal as Error).message).toMatch(/NOTHING was written/);
  });

  it('refuses malformed input before any write: bad JSON, not an array, entries without a role or name', () => {
    expect(() => parseAccountRoster('{', defaults)).toThrow(/not valid JSON/);
    expect(() => parseAccountRoster('{"role":"pmc"}', defaults)).toThrow(/must be a JSON array/);
    const refusal = (() => { try { parseAccountRoster(JSON.stringify([7, { name: 'X' }, { role: 'pmc' }]), defaults); } catch (e) { return e as AccountRosterError; } })()!;
    expect(refusal.problems).toEqual([
      'entry #1 is not an object',
      'entry #2 (X) has no role',
      'entry #3 (unnamed) has no name',
    ]);
  });

  it('refuses a non-string email or phone before any write, and admits a null or absent one (#645 Codex 4114271547)', () => {
    const refusal = (() => {
      try {
        parseAccountRoster(JSON.stringify([
          { role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' },
          { role: 'client', name: 'Mr. Shah', email: 7 },
          { role: 'engineer', name: 'Site', phone: { n: 1 } },
        ]), defaults);
      } catch (e) { return e as AccountRosterError; }
    })()!;
    expect(refusal).toBeInstanceOf(AccountRosterError);
    expect(refusal.problems).toEqual([
      'entry #2 (Mr. Shah) has a non-string email (7)',
      'entry #3 (Site) has a non-string phone ({"n":1})',
    ]);
    const roster = [{ role: 'engineer', name: 'Site', email: null, phone: '9000000000' }];
    expect(parseAccountRoster(JSON.stringify(roster), defaults)).toEqual(roster);
  });

  it('names a legacy architect User.role the membership backfill would grant, and only that', () => {
    const problems = refusedBackfillProblems([
      { id: 'u1', role: 'engineer', email: null, phone: '9000000000' },
      { id: 'u2', role: 'architect', email: 'old@vitan.in', phone: null },
    ]);
    expect(problems).toEqual([expect.stringMatching(/^legacy user old@vitan\.in has User\.role "architect"/)]);
  });
});
