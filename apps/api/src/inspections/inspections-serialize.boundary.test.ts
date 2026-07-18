import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 2 Task 10 (Module 3) CORRECTION — the serializer source boundary.
 *
 * `computeInspectionsBase` is the ONE canonical inspections read (shared by the live snapshot slice and
 * the rebuildable projection). The correction's core invariant is that it reads ONLY inspection-owned
 * facts — never a FOREIGN module's persistence — so every serialized field is refreshed by an
 * `inspection.*` event and the projection can never silently go stale.
 *
 * The projection dependency-matrix bug was exactly a serializer reading `Activity.name` and the `Media`
 * evidence table through Prisma relation includes: those foreign reads changed under `activity.*`/`media.*`
 * events the inspections.inbox consumer treats as no-ops, so the ordered cursor advanced without
 * refreshing. This source-scan REGRESSION GUARD fails if that shape is ever reintroduced — it is the
 * structural half of the boundary the runtime tests prove behaviourally.
 */
describe('inspections-serialize source boundary — no foreign-owned reads in computeInspectionsBase', () => {
  const src = readFileSync(join(__dirname, 'inspections-serialize.ts'), 'utf8');

  // The body of computeInspectionsBase (up to the next top-level `export function`).
  const fnStart = src.indexOf('export async function computeInspectionsBase');
  const fnEnd = src.indexOf('export function bakeInspections');
  const body = src.slice(fnStart, fnEnd);

  it('exists as the one serializer entry the projection + live read share', () => {
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  it('does NOT include the `activity` or `media` Prisma relation (the reintroduced-staleness shape)', () => {
    // a relation include like `include: { items: ..., activity: true }` or `media: { ... }`
    expect(body, 'reintroduced an `activity` relation read — activityName is the inspection-owned column').not.toMatch(/\bactivity\s*:/);
    expect(body, 'reintroduced a `media` relation read — evidence is the inspection-owned InspectionEvidence link').not.toMatch(/\bmedia\s*:/);
  });

  it('does NOT read the foreign `activity` / `media` Prisma delegates directly', () => {
    expect(body, 'reads the foreign activity delegate').not.toMatch(/\.\s*activity\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy)/);
    expect(body, 'reads the foreign media delegate').not.toMatch(/\.\s*media\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy)/);
  });

  it('reads the inspection-owned facts instead: the InspectionEvidence link + the activityName column', () => {
    expect(body, 'must read the inspection-owned evidence link').toMatch(/inspectionEvidence\.findMany/);
    expect(body, 'must project the inspection-owned activityName column').toMatch(/activityName:\s*i\.activityName/);
  });
});
