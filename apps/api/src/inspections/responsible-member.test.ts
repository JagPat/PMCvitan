import { describe, it, expect, vi } from 'vitest';
import { heldNamings, RESPONSIBLE_ROLES } from './responsible-member';

/**
 * Codex #1297 r1 — the read judges every naming from ONE orgs answer (one statement, one snapshot). Two role reads under
 * READ COMMITTED could straddle a consultant -> contractor re-role's commit and miss the member in both, hiding a naming
 * that never broke. A straddle cannot be forced across one statement, which is the point; this pins that there is one.
 */
describe('heldNamings', () => {
  const client = {} as never;
  it('asks orgs once, for every named member, and keeps a naming only while its member stands with the stored mark', async () => {
    const roleStandingMarks = vi.fn(async () => new Map([
      ['a', { stands: true, mark: 2 }],
      ['b', { stands: true, mark: 5 }],
      ['c', { stands: false, mark: 1 }],
    ]));
    const held = await heldNamings({ roleStandingMarks }, client, 'p1', [
      { inspectionId: 'i1', memberId: 'a', mark: 2 }, // stands, unchanged: kept
      { inspectionId: 'i2', memberId: 'b', mark: 4 }, // stands, but changed since: dropped
      { inspectionId: 'i3', memberId: 'c', mark: 1 }, // does not stand: dropped
      { inspectionId: 'i4', memberId: 'd', mark: 0 }, // not in the answer: dropped (fail closed)
    ]);
    expect(roleStandingMarks).toHaveBeenCalledTimes(1);
    expect(roleStandingMarks).toHaveBeenCalledWith(client, 'p1', ['a', 'b', 'c', 'd'], RESPONSIBLE_ROLES);
    expect(held.map((n) => n.inspectionId)).toEqual(['i1']);
  });

  it('asks nothing when no one is named', async () => {
    const roleStandingMarks = vi.fn();
    expect(await heldNamings({ roleStandingMarks }, client, 'p1', [])).toEqual([]);
    expect(roleStandingMarks).not.toHaveBeenCalled();
  });
});
