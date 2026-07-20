import { describe, it, expect } from 'vitest';
import { DOMAIN_EVENT_TYPES, validateRegistry, type ModuleManifest } from '@vitan/shared';
import { MODULE_MANIFESTS, KNOWN_ROLES, validateModuleRegistry, enabledModuleIds, moduleModelOwnership } from './registry';

/**
 * Phase 2 Task 7 — the module registry validates. This is the SAME check
 * {@link ModuleRegistryService} runs at API startup: a malformed boundary must fail
 * here (CI), long before boot.
 */
describe('Phase 2 Task 7 — module registry', () => {
  it('the compiled registry has NO validation errors', () => {
    expect(validateModuleRegistry()).toEqual([]);
  });

  it('enablement is every compiled module — the single source of truth (finding 7)', () => {
    expect(enabledModuleIds()).toEqual(
      ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'inventory', 'media', 'nodes', 'orgs', 'platform', 'procurement'],
    );
  });

  it('each Prisma model has exactly one owning module', () => {
    // building the owner map throws nothing and no model is double-claimed (validateRegistry
    // already asserts this; here we prove the derived map is total over the declared models).
    const owner = moduleModelOwnership();
    for (const m of MODULE_MANIFESTS) {
      for (const model of m.ownsModels) expect(owner.get(model)).toBe(m.id);
    }
  });

  it('every produced/consumed event is a known catalog type', () => {
    const known = new Set<string>(DOMAIN_EVENT_TYPES);
    for (const m of MODULE_MANIFESTS) {
      for (const e of [...m.producesEvents, ...m.consumesEvents]) expect(known.has(e), `${m.id} references unknown event ${e}`).toBe(true);
    }
  });

  it('every referenced permission is a known role', () => {
    for (const m of MODULE_MANIFESTS) {
      for (const role of m.permissions) expect(KNOWN_ROLES.has(role), `${m.id} references unknown role ${role}`).toBe(true);
    }
  });

  it('the dependsOn graph is acyclic; the activity↔inspection atomic edge is a workflow participation (cycle-exempt)', () => {
    // Task 8/10 — one-directional query-contract dependencies. The decision consumers declare
    // `dependsOn: ['decisions']`; Task 10 extracts `daily-log`, whose sole cross-module reader (media,
    // the linked-`dailyLogId` check) additionally declares `daily-log`. The Module-3 correction makes
    // the inspection query edges TRUTHFUL: `activities` reads the inspection-gate readiness + next-id
    // (readinessSlice/nextInspectionId); `media` validates an evidence target (assertEvidenceTarget);
    // `orgs` reads the existing inspection ids at init (allIds) — all through the InspectionsQueryService
    // contract, so each declares `inspections`. `inspections` depends on NOTHING (dependsOn: []), so
    // every X→inspections edge is one-directional and the graph stays ACYCLIC. The reverse edges
    // (inspections→activities sign-off; the media/nodes/orgs evidence/unfile/init participants) are
    // WORKFLOW PARTICIPATIONS, cycle-exempt.
    const expectedDependsOn: Record<string, string[]> = {
      // Task 10 — `activities` additionally reads the DRAWING gate through the drawings query
      // (read-encapsulation), so it declares `drawings` too; `drawings` depends only on `decisions`,
      // so activities→drawings→decisions stays ACYCLIC (drawings never depends back on activities).
      activities: ['decisions', 'drawings', 'inspections'], 'daily-log': ['decisions'], nodes: ['decisions'],
      orgs: ['decisions', 'inspections'], drawings: ['decisions'],
      media: ['decisions', 'daily-log', 'inspections'],
      // Phase 3 Task 2 — procurement reads requirement revisions through the activities query
      // (the §F bound-1 allocation lock) and approved specifications through decisions; neither
      // target depends back on procurement (the requirements-cancel disposition guard is a
      // WORKFLOW PARTICIPATION, cycle-exempt), so the graph stays acyclic.
      procurement: ['activities', 'decisions'],
    };
    for (const m of MODULE_MANIFESTS) {
      expect(m.dependsOn, `${m.id} dependsOn`).toEqual(expectedDependsOn[m.id] ?? []);
    }
    // The reverse (inspection-owned) consequences are workflow participations, not dependsOn edges —
    // pin the exact participant edges the Module-3 correction relies on so a boundary can't drift.
    const expectedParticipants: Record<string, string[]> = {
      // completion creates the closing inspection (edge 1) + relabel; the Module-4 correction adds
      // the drawings participant: activity deletion unlinks governed drawings (drawing.activity_unlinked)
      // Phase 3 Task 2 adds the procurement participant: requirements.cancel refuses while open
      // requisition lines reference the requirement (the §F explicit-disposition guard)
      activities: ['inspections', 'drawings', 'procurement'],
      'daily-log': ['activities'], // material-mismatch blocks the activity's readiness (edge 4)
      // Phase 3 Task 4 adds the inventory participant to media: the delete tx refuses while the
      // photo is immutable stock-ledger quality evidence (assertMediaDisposable)
      media: ['inspections', 'inventory'], // evidence add/remove (edges via the media create/remove tx)
      // Phase 3 Task 4 — the §G inventory→procurement edge: the receipt tx invokes the
      // procurement-owned PO-line lock + received-progress fact (§F bound 3); procurement does
      // not depend back on inventory, so the graph stays acyclic
      inventory: ['procurement'],
      // Task 10 Module 4 (+ correction): node deletion unfiles placed inspections, filed activities,
      // filed drawings AND staged site materials — each through its owning module's participant,
      // appending inspection.unfiled / activity.unfiled / drawing.unfiled / material.unfiled
      nodes: ['inspections', 'activities', 'drawings', 'daily-log'],
      orgs: ['nodes', 'activities', 'inspections'], // project-init instantiates each owning module
      inspections: ['activities'], // the closing-inspection decide writes the activity sign-off
    };
    for (const m of MODULE_MANIFESTS) {
      expect(m.workflowParticipants, `${m.id} workflowParticipants`).toEqual(expectedParticipants[m.id] ?? []);
    }
  });

  it('a deliberately broken registry (shared model + cycle + unknown role) is rejected', () => {
    // guardrail: prove the validator actually fails on the shapes Phase 2 forbids.
    const base: ModuleManifest = { id: '', title: '', kind: 'domain', ownsModels: [], dependsOn: [], workflowParticipants: [], producesEvents: [], consumesEvents: [], commands: [], queries: [], routes: [], permissions: [] };
    const bad: ModuleManifest[] = [
      { ...base, id: 'x', ownsModels: ['decision'], dependsOn: ['y'], permissions: ['nope'] }, // 'decision' double-owned + unknown role
      { ...base, id: 'y', dependsOn: ['x'] }, // x -> y -> x cycle
      ...MODULE_MANIFESTS.filter((m) => m.id === 'decisions'), // the real owner of 'decision'
    ];
    const codes = new Set(validateRegistry(bad, KNOWN_ROLES).map((e) => e.code));
    expect(codes.has('shared-model')).toBe(true); // 'decision' owned by both decisions and x
    expect(codes.has('cycle')).toBe(true); // x -> y -> x
    expect(codes.has('unknown-permission')).toBe(true); // role 'nope'
  });
});
