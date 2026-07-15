import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Phase 2 Task 1 — CHARACTERIZATION TRIPWIRE for the cross-module call graph.
 *
 * Today the backend is one flat AppModule and modules reach INTO each other two
 * ways: (a) a domain service writes another domain's tables through the shared
 * PrismaService, and (b) every mutating service is handed SnapshotService +
 * RealtimeGateway and calls them directly. Phase 2 (Tasks 6–10) turns these into
 * declared events / atomic workflow contracts / FK actions per the plan's edge
 * decision table (docs/reviews/phase2-projection-matrix.md).
 *
 * This test PINS the boundary graph exactly as it is at Task 1 so that any later
 * task which removes or reroutes an edge produces a FAILING, reviewable diff here
 * — an extraction can never silently change the boundary. It scans source text
 * (the same technique as route-policy.test.ts), so it never needs a database.
 *
 * When Task 7 reroutes an edge, DELETE that row from EXPECTED_CROSS_DOMAIN_WRITES
 * in the same PR — do not weaken the matcher.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

// The eight mutating domain services that today receive SnapshotService +
// RealtimeGateway and end each mutation by rebuilding the full snapshot + emitting
// the content-free `changed` signal.
const MUTATING_SERVICES = [
  'decisions/decisions.service.ts',
  'activities/activities.service.ts',
  'activities/phases.service.ts',
  'inspections/inspections.service.ts',
  'drawings/drawings.service.ts',
  'daily-log/daily-log.service.ts',
  'nodes/nodes.service.ts',
  'media/media.service.ts',
];

// A cross-domain Prisma write = a `<model>.<method>` where <model> is owned by a
// DIFFERENT domain than the service. These are the boundary VIOLATIONS the plan's
// edge decision table assigns to a workflow contract / FK action / event.
// Matched as substrings against source text (receiver-agnostic: `tx.`, `prisma.`,
// `this.prisma.` all count) — the point is the edge exists, not how it's spelled.
const EXPECTED_CROSS_DOMAIN_WRITES: Record<string, string[]> = {
  // activity completion creates the closing Inspection; activity delete unlinks Drawings
  'activities/activities.service.ts': ['.inspection.create', '.drawing.updateMany'],
  // closing-inspection approval/rejection writes Activity status/doneAt
  'inspections/inspections.service.ts': ['.activity.updateMany', '.activity.update'],
  // material mismatch writes the linked Activity's stored gate/status/block
  'daily-log/daily-log.service.ts': ['.activity.update'],
  // node delete nulls the (projectId,nodeId) FK across five foreign domains
  'nodes/nodes.service.ts': [
    '.activity.updateMany',
    '.inspection.updateMany',
    '.media.updateMany',
    '.drawing.updateMany',
    '.siteMaterial.updateMany',
  ],
  // createProject instantiates structure by writing four foreign domains directly
  'orgs/orgs.service.ts': ['.projectNode.create', '.phase.create', '.activity.create', '.inspection.create'],
};

// Services whose mutations write ONLY their own domain today — pinned so that a
// later change which introduces a NEW cross-domain write here becomes visible.
const OWN_DOMAIN_ONLY: Record<string, string[]> = {
  // decisions writes Decision/DecisionOption/DecisionEvent/ChangeRequest only
  'decisions/decisions.service.ts': ['.activity.', '.inspection.', '.drawing.', '.siteMaterial.'],
  // drawings writes Drawing/DrawingRevision/DrawingRecipient/DrawingAck only
  'drawings/drawings.service.ts': ['.activity.update', '.inspection.create', '.decision.update'],
};

describe('Phase 2 Task 1 — cross-module call-graph baseline', () => {
  describe('cross-domain Prisma writes (the boundary edges Phase 2 reroutes)', () => {
    for (const [file, patterns] of Object.entries(EXPECTED_CROSS_DOMAIN_WRITES)) {
      const src = read(file);
      for (const pattern of patterns) {
        it(`${file} still writes a foreign domain via ${pattern}`, () => {
          expect(src, `${file} no longer contains ${pattern} — if Phase 2 rerouted this edge, remove it from EXPECTED_CROSS_DOMAIN_WRITES`).toContain(pattern);
        });
      }
    }
  });

  describe('services that write only their own domain today', () => {
    for (const [file, forbidden] of Object.entries(OWN_DOMAIN_ONLY)) {
      const src = read(file);
      for (const pattern of forbidden) {
        it(`${file} does not write a foreign domain via ${pattern}`, () => {
          expect(src, `${file} newly writes ${pattern} — a NEW cross-module edge appeared; add it to the edge decision table`).not.toContain(pattern);
        });
      }
    }
  });

  describe('read + signal coupling (SnapshotService + RealtimeGateway injected everywhere)', () => {
    it('every mutating service depends on SnapshotService today', () => {
      for (const file of MUTATING_SERVICES) {
        expect(read(file), `${file} no longer references SnapshotService`).toContain('SnapshotService');
      }
    });

    it('the content-free `changed` signal is emitted from many call sites today', () => {
      const emits = MUTATING_SERVICES.reduce((n, file) => n + (read(file).match(/notifyChanged\(/g)?.length ?? 0), 0);
      // agent-observed baseline was ~30 emit sites across the mutating services;
      // pin a floor so a later task that centralizes the signal must update this.
      expect(emits).toBeGreaterThanOrEqual(20);
    });
  });
});
