import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 6 unit 4d-i — every raw `INSERT INTO "DomainEvent"` in this repository is classified.
 *
 * WHY THIS EXISTS. `ProjectEventStream_t4d_allocation_bound` states, at COMMIT, that the
 * allocator is ahead of every position the stream actually uses. A raw plant that picks its own
 * position — a literal `90001`, a `max + 500` guess — satisfies nothing at the moment it runs and
 * leaves the allocator permanently BEHIND that project's stream; the abort then lands on the next
 * legitimate `emitEvent`, in a different test, in a different file. That is exactly how it
 * presented: `event-envelope.test.ts`'s append-only arm failed on an `emit` three tests after the
 * plant that broke it, and nothing in the failure named the plant.
 *
 * So the contract (§A.3 obligation 7's raw-insert finding; §D 4d-i) admits raw plants two ways
 * and no third:
 *
 *   · through the ALLOCATOR — `allocateStreamPositions` (take the next slots) or
 *     `reserveStreamPosition` (declare a slot and advance the counter past it), or
 *   · under a NAMED BYPASS — a legacy-SHAPE plant, pre-4d by definition and unable to satisfy the
 *     4d seals, that disables `ProjectEventStream_t4d_allocation` / `DomainEvent_t4d_envelope` BY
 *     NAME inside its own plant transaction and re-enables them after.
 *
 * A named bypass is visible and reviewable. An implicit hole is neither, and this tripwire is what
 * keeps the third way from being invented by the next person who needs a raw row.
 *
 * SCOPE, MEASURED. This is a TEXT tripwire over `test/` and `scripts/`. It proves each FILE that
 * plants raw events declares one of the two sanctioned mechanisms; it does NOT prove that a
 * particular plant statement inside such a file uses the one on the line above it. That limit is
 * stated rather than papered over: an earlier draft of this suite claimed the stronger property
 * and could be driven GREEN with a bare plant restored, so the claim was withdrawn rather than
 * dressed up. What closes the gap in practice is the database — an unallocated plant aborts the
 * next emission in the same suite, which is how the four sites this unit fixed were found.
 */

const API_ROOT = join(__dirname, '..', '..');
const ROOTS = ['test', 'scripts'];
const RAW_INSERT = /INSERT\s+INTO\s+"DomainEvent"/i;

/** Every mechanism that makes a raw plant legitimate. A file must show at least one. */
const SANCTIONED = [
  'allocateStreamPositions',
  'reserveStreamPosition',
  'ProjectEventStream_t4d_allocation',
  'DomainEvent_t4d_envelope',
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|sh|sql|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every file under `test/` and `scripts/` that carries at least one raw plant. */
function planters(): Array<{ path: string; body: string; count: number }> {
  const found: Array<{ path: string; body: string; count: number }> = [];
  for (const root of ROOTS) {
    for (const file of walk(join(API_ROOT, root))) {
      const body = readFileSync(file, 'utf8');
      const count = body.split('\n').filter((l) => RAW_INSERT.test(l)).length;
      if (count > 0) found.push({ path: relative(API_ROOT, file), body, count });
    }
  }
  return found;
}

describe('phase 6 unit 4d-i — raw DomainEvent plants are allocated or named-bypassed', () => {
  it('there ARE raw plants to classify — a tripwire over an empty set proves nothing', () => {
    const files = planters();
    expect(files.length, 'the repository plants raw events; if this is 0 the matcher broke').toBeGreaterThan(0);
    expect(files.reduce((n, f) => n + f.count, 0)).toBeGreaterThan(4);
  });

  it('every planting file declares an allocator call or a NAMED seal bypass', () => {
    const unclassified = planters()
      .filter((f) => !SANCTIONED.some((m) => f.body.includes(m)))
      .map((f) => f.path);
    expect(
      unclassified,
      'these files plant raw "DomainEvent" rows without taking a position from the allocator '
      + '(allocateStreamPositions / reserveStreamPosition) and without a NAMED bypass of '
      + 'ProjectEventStream_t4d_allocation / DomainEvent_t4d_envelope. An unallocated plant leaves '
      + 'the allocator behind the stream and aborts the NEXT legitimate emitEvent, in a different '
      + 'test, with a message that names neither this file nor this plant.',
    ).toEqual([]);
  });

  it('a shell plant that bypasses re-ENABLES what it disabled', () => {
    const offenders = planters()
      .filter((f) => f.path.endsWith('.sh') && f.body.includes('DISABLE TRIGGER "ProjectEventStream_t4d_allocation"'))
      .filter((f) => !f.body.includes('ENABLE TRIGGER "ProjectEventStream_t4d_allocation"'))
      .map((f) => f.path);
    expect(
      offenders,
      'a bypass that is never re-enabled is not a bypass, it is a removed seal',
    ).toEqual([]);
  });
});
