import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Phase 2 Task 1 — CHARACTERIZATION CLASSIFIER for the cross-module call graph.
 *
 * Today the backend is one flat AppModule and modules reach INTO each other two
 * ways: (a) a domain service writes ANOTHER domain's tables through the shared
 * PrismaService, and (b) every mutating service is handed SnapshotService +
 * RealtimeGateway and calls them directly. Phase 2 (Tasks 6–10) turns these into
 * declared events / atomic workflow contracts / FK actions per the plan's edge
 * decision table (docs/reviews/phase2-projection-matrix.md).
 *
 * This is an EXHAUSTIVE classifier, not a presence scan: for each service it
 * extracts EVERY `<model>.<write>` in the source, classifies each model as own /
 * foreign / shared-infra by an explicit ownership map, and asserts the foreign
 * set EXACTLY equals the expected edge set — so it fails on a MISSING edge (Phase 2
 * rerouted one → delete that row in the same PR) AND on an UNKNOWN edge (a new
 * cross-module write appeared → add it to the edge decision table). It also pins
 * the exact `notifyChanged` call-site count per service. Source-text only (same
 * technique as route-policy.test.ts), so it never needs a database.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string =>
  // strip block + line comments so a commented-out write is never counted
  readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Prisma model → the domain (boundary unit) that OWNS its table. A write to a
// model whose owner ≠ the writing service's domain is a cross-module edge.
// `phases` is its own boundary unit (it writes Activity — the edge finding 3 adds).
const MODEL_OWNER: Record<string, string> = {
  decision: 'decisions', decisionOption: 'decisions', decisionEvent: 'decisions', changeRequest: 'decisions',
  activity: 'activities', gateOverride: 'activities',
  phase: 'phases',
  inspection: 'inspections', inspectionItem: 'inspections',
  drawing: 'drawings', drawingRevision: 'drawings', drawingRecipient: 'drawings', drawingAck: 'drawings',
  dailyLog: 'daily-log', crewRow: 'daily-log', siteMaterial: 'daily-log',
  projectNode: 'nodes',
  media: 'media',
  org: 'orgs', orgMembership: 'orgs', membership: 'orgs', project: 'orgs', projectCompany: 'orgs',
  projectTemplate: 'orgs', templateModule: 'orgs', user: 'orgs', workerDevice: 'orgs',
  // shared infrastructure every module appends to — NOT a cross-module edge
  auditLog: 'SHARED', notification: 'SHARED', pushSubscription: 'SHARED',
};

// service file → its domain, its EXACT set of foreign (cross-module) write targets,
// and its EXACT number of `notifyChanged(` call sites.
const SERVICES: Record<string, { domain: string; foreign: string[]; notify: number }> = {
  'decisions/decisions.service.ts': { domain: 'decisions', foreign: [], notify: 5 },
  // activity completion creates the closing Inspection; activity delete unlinks Drawings
  'activities/activities.service.ts': { domain: 'activities', foreign: ['drawing', 'inspection'], notify: 7 },
  // phase delete nulls Activity.phaseId (the edge finding 3 adds)
  'activities/phases.service.ts': { domain: 'phases', foreign: ['activity'], notify: 2 },
  // closing-inspection approval/rejection writes Activity status/doneAt
  'inspections/inspections.service.ts': { domain: 'inspections', foreign: ['activity'], notify: 3 },
  'drawings/drawings.service.ts': { domain: 'drawings', foreign: [], notify: 5 },
  // material mismatch writes the linked Activity's stored gate/status/block
  'daily-log/daily-log.service.ts': { domain: 'daily-log', foreign: ['activity'], notify: 4 },
  // node delete nulls the (projectId,nodeId) FK across five foreign domains
  'nodes/nodes.service.ts': { domain: 'nodes', foreign: ['activity', 'drawing', 'inspection', 'media', 'siteMaterial'], notify: 1 },
  'media/media.service.ts': { domain: 'media', foreign: [], notify: 3 },
  // createProject instantiates structure by writing four foreign domains directly
  'orgs/orgs.service.ts': { domain: 'orgs', foreign: ['activity', 'inspection', 'phase', 'projectNode'], notify: 0 },
};

const WRITE = /\.(\w+)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;

/** Every distinct model written via `<model>.<create|update|...>` in the source. */
function modelsWritten(src: string): string[] {
  const models = new Set<string>();
  for (const m of src.matchAll(WRITE)) {
    const model = m[1];
    if (model === 'prisma' || model === 'tx' || model === 'this') continue;
    models.add(model);
  }
  return [...models];
}

describe('Phase 2 Task 1 — cross-module call-graph classifier', () => {
  describe('every service writes EXACTLY its expected foreign-domain set', () => {
    for (const [file, spec] of Object.entries(SERVICES)) {
      it(`${file}: foreign writes === [${spec.foreign.join(', ') || '∅'}]`, () => {
        const src = read(file);
        const written = modelsWritten(src);
        // any model whose owner is neither this service's domain nor shared infra
        const foreign = written
          .filter((m) => {
            const owner = MODEL_OWNER[m];
            expect(owner, `${file} writes model "${m}" with no ownership mapping — add it to MODEL_OWNER`).toBeTruthy();
            return owner !== spec.domain && owner !== 'SHARED';
          })
          .sort();
        // EXACT equality: fails on a MISSING edge (rerouted → delete the row) AND
        // on an UNKNOWN edge (new cross-module write → add it to the matrix).
        expect(foreign, `${file} cross-module edges drifted — reconcile with docs/reviews/phase2-projection-matrix.md`).toEqual([...spec.foreign].sort());
      });
    }
  });

  describe('the content-free `changed` signal is emitted from an EXACT set of sites', () => {
    for (const [file, spec] of Object.entries(SERVICES)) {
      it(`${file}: exactly ${spec.notify} notifyChanged() call site(s)`, () => {
        const count = read(file).match(/notifyChanged\(/g)?.length ?? 0;
        expect(count, `${file} notifyChanged() call-site count changed`).toBe(spec.notify);
      });
    }
    it('30 notifyChanged() call sites total across the mutating services', () => {
      const total = Object.keys(SERVICES).reduce((n, file) => n + (read(file).match(/notifyChanged\(/g)?.length ?? 0), 0);
      expect(total).toBe(30);
    });
  });

  describe('command inventory surface is pinned (docs/reviews/phase2-projection-matrix.md §4)', () => {
    // every mutating HTTP route is a command the Task-1 inventory documents and Task 10's
    // gate must verify migrated onto the CommandExecution ledger. Pin the exact count per
    // controller so a NEW undocumented route fails here until the inventory is updated.
    const CONTROLLER_MUTATIONS: Record<string, number> = {
      'orgs/orgs.controller.ts': 12,
      'auth/auth.controller.ts': 9,
      'activities/activities.controller.ts': 7,
      'drawings/drawings.controller.ts': 6,
      'nodes/nodes.controller.ts': 5,
      'decisions/decisions.controller.ts': 5,
      'daily-log/daily-log.controller.ts': 4,
      'orgs/members.controller.ts': 3,
      'orgs/companies.controller.ts': 3,
      'media/media.controller.ts': 3,
      'inspections/inspections.controller.ts': 3,
      'activities/phases.controller.ts': 2,
      'push/push.controller.ts': 1,
    };
    const MUTATION = /@(Post|Patch|Put|Delete)\(/g;
    for (const [file, n] of Object.entries(CONTROLLER_MUTATIONS)) {
      it(`${file}: ${n} mutating route(s)`, () => {
        expect(read(file).match(MUTATION)?.length ?? 0, `${file} route count changed — update the §4 command inventory`).toBe(n);
      });
    }
    it('63 mutating routes total (the documented command inventory)', () => {
      const total = Object.keys(CONTROLLER_MUTATIONS).reduce((s, f) => s + (read(f).match(MUTATION)?.length ?? 0), 0);
      expect(total).toBe(63);
    });
  });

  describe('read + signal coupling (SnapshotService + RealtimeGateway injected everywhere)', () => {
    // the eight pillar services that end each mutation by rebuilding the full
    // snapshot + emitting `changed` (orgs manages projects and does neither).
    const emitters = Object.entries(SERVICES).filter(([, s]) => s.notify > 0).map(([f]) => f);
    it('all eight emitting services depend on SnapshotService today', () => {
      expect(emitters.length).toBe(8);
      for (const file of emitters) {
        expect(read(file), `${file} no longer references SnapshotService`).toContain('SnapshotService');
      }
    });
  });
});
