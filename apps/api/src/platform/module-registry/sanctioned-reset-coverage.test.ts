import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 6 unit 4c-0 — EVERY SANCTIONED RESET GOES THROUGH THE SHARED HELPER.
 *
 * The reset was centralized into `prisma/sanctioned-reset.ts` so that installing a statement-level
 * `BEFORE TRUNCATE` seal is one entry in `TRUNCATE_SEALS` rather than an edit to fifty suites. That
 * promise is only worth anything if no caller still issues raw `TRUNCATE`: a single bypassing reset
 * hits the new seal in setup and takes the whole integration battery down with it — a worse outcome
 * than the forgery the seal prevents.
 *
 * **Why this is a test and not a note in the plan.** The sweep that introduced the helper was
 * declared complete twice and was incomplete both times. The first pass matched only the
 * `const TRUNCATE = …` shape and missed every inline reset; the second missed the resets that live
 * inside `it(...)` blocks — `finally` teardowns and post-probe cleanup. Prose describing the rule
 * did not catch either. This does.
 *
 * **The one thing that must NOT be converted.** A `TRUNCATE` inside a test body is usually an
 * assertion ABOUT a seal, not a reset: either a hostile probe proving the seal REFUSES the
 * statement, or a precision probe proving an empty-table truncate is PERMITTED *without* the
 * bypass. Routing either through the helper — which disables seals — destroys the assertion while
 * leaving it green. So this check does not demand zero raw truncates; it pins the exact set that
 * remains, and a new one has to be justified by whoever adds it.
 */
describe('Phase 6 unit 4c-0 — sanctioned resets route through the shared helper', () => {
  const apiRoot = join(__dirname, '../../..');
  const integrationDir = join(apiRoot, 'test/integration');

  const rawTruncateSites = (source: string): number[] => {
    const sites: number[] = [];
    source.split('\n').forEach((line, i) => {
      if (/\$executeRawUnsafe\(\s*[`'"]?\s*TRUNCATE/iu.test(line)) sites.push(i + 1);
    });
    return sites;
  };

  it('prisma/seed.ts issues no raw TRUNCATE at all', () => {
    // The seed is the least ambiguous caller in the repository: it contains no probes, only the
    // destructive reset. Any raw TRUNCATE here is a bypass, full stop — and it was missed once,
    // because the file holds TWO reset statements and only the first was converted.
    const seed = readFileSync(join(apiRoot, 'prisma/seed.ts'), 'utf8');
    expect(
      rawTruncateSites(seed),
      'prisma/seed.ts must reset through sanctionedReset so a new seal needs no edit here',
    ).toEqual([]);
  });

  it('the integration suites keep raw TRUNCATE only where it is the assertion', () => {
    // Pinned by FILE, not by a total count: a bare number would be satisfied by deleting one probe
    // and adding one bypass. Each file listed here holds truncates that prove something ABOUT a
    // seal and must stay raw; every other suite must hold none.
    const PROBE_FILES: Record<string, number> = {
      // 942 asserts the writing transaction is REFUSED; 954 asserts a maintenance truncate of
      // inert history is PERMITTED without the bypass.
      'decision-option-kinds.test.ts': 2,
      // The DecisionEvent approval-evidence seal and the DecisionOptionTouch same-transaction seal,
      // each probed for both refusal and the permitted empty case.
      'phase6-t4a-withdraw.test.ts': 5,
      // The TRUNCATE-vs-writer race: the truncate must inspect the register after the writer commits.
      'phase6-t4b-approval-attribution.test.ts': 1,
      // P16 refusal + permitted-empty, and P36's fixed-snapshot arms.
      'schedule-dependency-graph.test.ts': 5,
      // The repair register's seal must REFUSE the truncate — routing it through the helper, which
      // disables seals, would invert the probe.
      'phase4-t3-correction3.test.ts': 1,
    };

    const offenders: string[] = [];
    for (const file of readdirSync(integrationDir).filter((f) => f.endsWith('.ts'))) {
      const sites = rawTruncateSites(readFileSync(join(integrationDir, file), 'utf8'));
      const allowed = PROBE_FILES[file] ?? 0;
      if (sites.length !== allowed) {
        offenders.push(`${file}: ${sites.length} raw TRUNCATE (expected ${allowed}) at lines ${sites.join(', ')}`);
      }
    }

    expect(
      offenders.sort(),
      'A sanctioned reset must call sanctionedReset() from prisma/sanctioned-reset.ts, so that '
      + 'adding a statement-level TRUNCATE seal is one entry in TRUNCATE_SEALS and not an edit to '
      + 'every suite. If the new raw TRUNCATE is a PROBE — it asserts a seal refuses the statement, '
      + 'or that an empty-table truncate is permitted WITHOUT the bypass — add it to PROBE_FILES '
      + 'above with a note saying which. Do not route a probe through the helper: the helper '
      + 'disables the seal, which makes the assertion vacuous while leaving it green.',
    ).toEqual([]);
  });
});
