import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 6 task 4d-iii / R0a-2 — the DIRECT `emitEvent` WRITER INVENTORY tripwire
 * (`docs/superpowers/plans/2026-10-05-4d-iii-additive-units.md`, "The writer inventory rule").
 *
 * Since R0a-2, `emitEvent` refuses a HUMAN event whose frozen pair does not resolve on the project
 * (the Board's Decision 2). A delivered command reaches it only after `ProjectAccessService.authorize`,
 * which admits exactly what the pair predicate admits, or through the orgs owner/admin paths, which
 * act in a project role (Decision 1). A TEST that calls `emitEvent` directly simulates a writer, so
 * each one is classified here, and the inventory is derived MECHANICALLY: the scan below re-runs the
 * search over `test/`, `prisma/seed.ts` and `scripts/`, and any caller not in {@link CLASSIFIED},
 * or a file whose number of call sites moved, turns this RED until it is classified.
 *
 * Verdicts:
 * - `current: <who>` — the simulated actor stands on the project the event lands on, so its pair
 *   resolves, as a delivered writer's does;
 * - `system: <why>` — a `system` actor, which carries no pair until R0b admits one and R0c writes it;
 * - `subject: <what>` — the suite's subject IS the actor envelope or the refusal, so its unresolved
 *   cases assert the refusal.
 * No direct caller takes a LEGACY bypass: R0a-2 installs no seal, so there is nothing to bypass.
 */
const API = join(__dirname, '..', '..');
const ROOTS = ['test', 'prisma/seed.ts', 'scripts'];

const OWNER = 'current: the org owner, who stands as `pmc` on every orgA project (the windowed owner/admin arm)';
const ENGINEER = 'current: an engineer enrolled on each fresh project by `freshProject`';
const SYSTEM = 'system: a `system` actor — no pair until R0b admits and R0c writes one';

const CLASSIFIED: Record<string, { calls: number; verdict: string }> = {
  'test/integration/activities-projection.test.ts': { calls: 1, verdict: SYSTEM },
  'test/integration/daily-log-isolation.test.ts': { calls: 2, verdict: ENGINEER },
  'test/integration/daily-log-projection.test.ts': { calls: 3, verdict: ENGINEER },
  'test/integration/decisions-projection.test.ts': { calls: 1, verdict: `${OWNER}; the surrounding plant bypasses decision seals by name, never the event pair` },
  'test/integration/drawings-isolation.test.ts': { calls: 1, verdict: SYSTEM },
  'test/integration/drawings-projection.test.ts': { calls: 2, verdict: SYSTEM },
  'test/integration/event-envelope.test.ts': { calls: 3, verdict: 'current: the projectA pmc member; on the counter-less project, an owner of its org' },
  'test/integration/inspections-projection.test.ts': { calls: 1, verdict: SYSTEM },
  'test/integration/outbox-operations.test.ts': { calls: 1, verdict: OWNER },
  'test/integration/outbox-reliability.test.ts': { calls: 1, verdict: OWNER },
  'test/integration/outbox-scanner.test.ts': { calls: 2, verdict: OWNER },
  'test/integration/outbox.test.ts': { calls: 2, verdict: OWNER },
  'test/integration/phase5-t7bia-money-invalidation.test.ts': { calls: 2, verdict: 'current: the pmc member of the project it emits on' },
  'test/integration/phase6-t4a-withdraw.test.ts': { calls: 8, verdict: 'current: the pmc member of projectA and of each wedge project, enrolled as it is made' },
  'test/integration/phase6-t4d-ii-a1-actor-envelope.test.ts': { calls: 2, verdict: 'subject: the actor envelope — its unresolved cases assert the R0a-2 refusal' },
  'test/integration/phase6-t4d-ii-a6d-delivery-seals.test.ts': { calls: 4, verdict: 'current: the projectA pmc member' },
  'test/integration/phase6-t4d-iii-r0a2-emit-refusal.test.ts': { calls: 5, verdict: 'subject: the R0a-2 refusal and attribution proofs' },
  'test/integration/projection.test.ts': { calls: 1, verdict: OWNER },
};

/** Source with its comments blanked, so a call quoted in a comment is not a call. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));

const files = (root: string): string[] => {
  const abs = join(API, root);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((name) => files(join(root, name)));
};

describe('the direct emitEvent writer inventory (4d-iii / R0a-2)', () => {
  const found: Record<string, number> = {};
  for (const file of ROOTS.flatMap(files).filter((f) => /\.(ts|mjs|js|sh|sql)$/u.test(f))) {
    const calls = (code(readFileSync(file, 'utf8')).match(/\bemitEvent\(/gu) ?? []).length;
    if (calls > 0) found[relative(API, file)] = calls;
  }

  it('every direct caller is classified, with its call count', () => {
    const counted = Object.fromEntries(Object.entries(CLASSIFIED).map(([f, c]) => [f, c.calls]));
    expect(found).toEqual(counted);
  });

  it('every verdict names its kind', () => {
    for (const [file, { verdict }] of Object.entries(CLASSIFIED)) {
      expect(verdict, file).toMatch(/^(current|system|subject): \S/u);
    }
  });
});
