import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MANIFEST_BY_ID, moduleModelOwnership, validateModuleRegistry } from './registry';

/**
 * Phase 2 Task 7 — the BOUNDARY CI CHECK.
 *
 * Enforces the edge decision table (docs/reviews/phase2-projection-matrix.md §1) against
 * the compiled source: after Task 7, NO module's service/participant writes a Prisma model
 * OWNED BY ANOTHER DOMAIN MODULE. The atomic cross-module edges (1–4) route their foreign
 * write through the owning module's transaction-bound WORKFLOW PARTICIPANT, so the write
 * physically lives in the owner's file; the referential edges (5–7) became database
 * `ON DELETE SET NULL` FK actions; project-init (8) writes through the owning modules'
 * INITIALIZER participants. Shared platform tables (audit/event/outbox/notification/…) are
 * appendable from anywhere by design (their owner's manifest is `kind: 'platform'`).
 *
 * The ONE remaining cross-module persistence edge is a DECLARED, BOUNDED waiver: auth's
 * first-sign-in provisioning writes the orgs-owned identity rows (the actor does not yet
 * exist, so the command ledger's subject is undefined). Its removal task is Task 10's
 * identity-command work — a bounded waiver, not an indefinite one, so the Phase-2 final
 * gate does not (yet) fail on it. There are NO indefinite waivers.
 *
 * Source-text scan (same technique as cross-module-graph.test.ts), so it never needs a DB.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string): string => stripComments(readFileSync(join(SRC, rel), 'utf8'));

function walk(rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(SRC, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(r));
    else out.push(r);
  }
  return out;
}
const isSrc = (f: string, suffix: string) => f.endsWith(suffix) && !f.includes('.spec.') && !f.includes('.test.');
const ALL_FILES = walk('');
// every file that can persist: domain services + the Task-7 workflow/init participants.
const WRITER_FILES = ALL_FILES.filter((f) => isSrc(f, '.service.ts') || isSrc(f, '.participant.ts')).sort();

// A source file's top-level directory → its owning module id. Infra directories that only
// touch shared/platform tables (or nothing) map to 'platform'.
const DIR_TO_MODULE: Record<string, string> = {
  decisions: 'decisions',
  activities: 'activities',
  inspections: 'inspections',
  drawings: 'drawings',
  'daily-log': 'daily-log',
  nodes: 'nodes',
  media: 'media',
  orgs: 'orgs',
  auth: 'auth',
  platform: 'platform',
  push: 'platform',
  realtime: 'platform',
  snapshot: 'platform',
  common: 'platform',
};
const moduleOf = (file: string): string => {
  const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '';
  return DIR_TO_MODULE[top] ?? 'platform'; // root-level infra files (prisma.service.ts, …)
};

const WRITE = /\.(\w+)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;
function writesByModel(src: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of src.matchAll(WRITE)) {
    const model = m[1];
    if (model === 'prisma' || model === 'tx' || model === 'this') continue;
    counts[model] = (counts[model] ?? 0) + 1;
  }
  return counts;
}

/** The bounded, declared cross-module persistence waivers (writerModule → foreign model). */
const WAIVERS: ReadonlyArray<{ module: string; model: string; owner: string; removalTask: string }> = [
  { module: 'auth', model: 'user', owner: 'orgs', removalTask: 'Task 10 — identity command work' },
  { module: 'auth', model: 'membership', owner: 'orgs', removalTask: 'Task 10 — identity command work' },
  { module: 'auth', model: 'workerDevice', owner: 'orgs', removalTask: 'Task 10 — identity command work' },
];
const isWaived = (module: string, model: string) => WAIVERS.some((w) => w.module === module && w.model === model);

describe('Phase 2 Task 7 — module boundary check', () => {
  const ownership = moduleModelOwnership();

  it('the module registry validates (acyclic dependsOn, one owner per model, known events/roles)', () => {
    expect(validateModuleRegistry()).toEqual([]);
  });

  it('NO service/participant writes a model owned by ANOTHER domain module (except the declared bounded waivers)', () => {
    const violations: string[] = [];
    for (const file of WRITER_FILES) {
      const module = moduleOf(file);
      for (const [model, n] of Object.entries(writesByModel(read(file)))) {
        const owner = ownership.get(model);
        expect(owner, `${file} writes model "${model}" with no manifest owner — add it to a module's ownsModels`).toBeTruthy();
        if (!owner) continue;
        if (MANIFEST_BY_ID.get(owner)?.kind === 'platform') continue; // shared infra, appendable everywhere
        if (owner === module) continue; // own-module write
        if (isWaived(module, model)) continue; // declared, bounded cross-module exception
        violations.push(`${file} (module '${module}') writes ${n}× foreign model '${model}' owned by '${owner}'`);
      }
    }
    expect(violations, `cross-module persistence write(s) with no declared waiver:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the only cross-module persistence edge is the auth→identity provisioning waiver, and it is BOUNDED (has a removal task)', () => {
    // every waiver names a real removal task (no indefinite waivers → the Phase-2 final gate can pass)
    for (const w of WAIVERS) expect(w.removalTask, `waiver ${w.module}->${w.model} must name a removal task`).toBeTruthy();
    // and the waived edge is REAL: auth.service.ts still writes those identity rows today
    const authWrites = writesByModel(read('auth/auth.service.ts'));
    expect(Object.keys(authWrites).sort()).toEqual(['membership', 'user', 'workerDevice']);
  });

  it('the four atomic edges are gone from their former writer services (writes moved to participants)', () => {
    // edges 1 (activities→inspection) and 5 (activities→drawing) no longer appear in activities.service
    const act = writesByModel(read('activities/activities.service.ts'));
    expect(act.inspection ?? 0).toBe(0);
    expect(act.drawing ?? 0).toBe(0);
    // edges 2/3 (inspections→activity) gone from inspections.service
    expect(writesByModel(read('inspections/inspections.service.ts')).activity ?? 0).toBe(0);
    // edge 4 (daily-log→activity) gone from daily-log.service
    expect(writesByModel(read('daily-log/daily-log.service.ts')).activity ?? 0).toBe(0);
    // edge 6 (phases→activity) gone from phases.service; edge 7 (nodes→5 domains) gone from nodes.service
    expect(writesByModel(read('activities/phases.service.ts')).activity ?? 0).toBe(0);
    const nodesWrites = writesByModel(read('nodes/nodes.service.ts'));
    for (const m of ['activity', 'inspection', 'media', 'drawing', 'siteMaterial']) expect(nodesWrites[m] ?? 0).toBe(0);
    // edge 8 (orgs→node/phase/activity/inspection) gone from orgs.service (routed through init participants)
    const orgWrites = writesByModel(read('orgs/orgs.service.ts'));
    for (const m of ['projectNode', 'phase', 'activity', 'inspection']) expect(orgWrites[m] ?? 0).toBe(0);
  });

  it('each participant writes ONLY its owning module\'s tables', () => {
    const participants = WRITER_FILES.filter((f) => f.endsWith('.participant.ts'));
    expect(participants.length).toBeGreaterThan(0);
    for (const file of participants) {
      const module = moduleOf(file);
      for (const model of Object.keys(writesByModel(read(file)))) {
        const owner = ownership.get(model);
        expect(owner === module || MANIFEST_BY_ID.get(owner ?? '')?.kind === 'platform', `${file} writes non-owned model '${model}'`).toBe(true);
      }
    }
  });
});
