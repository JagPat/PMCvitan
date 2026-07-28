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
      ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'inventory', 'labour', 'media', 'nodes', 'orgs', 'platform', 'procurement'],
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

  // Phase 4 Task 1 correction 4 — pin the Labour manifest contract: WorkerSkill (the normalized
  // worker-skill relation from correction 3) must be Labour-OWNED and Labour-READ-ENCAPSULATED, so
  // the boundary analyzer flags any foreign read of it. Assert the COMPLETE expected read-encapsulated
  // set so a future model added to ownsModels but forgotten in readEncapsulated is caught here.
  it('the Labour manifest owns AND read-encapsulates WorkerSkill (complete read-encapsulated set)', () => {
    const labour = MODULE_MANIFESTS.find((m) => m.id === 'labour');
    expect(labour, 'the labour manifest exists').toBeDefined();
    expect(moduleModelOwnership().get('workerSkill')).toBe('labour');
    const expected = [
      'approvedSkillSubstitution', 'capacityCommitment', 'capacityPromise', 'crew', 'crewMembership',
      'labourAttendance', 'labourDemandSlice',
      'labourMismatch', 'labourMismatchResolution',
      'labourPurchaseOrder', 'labourPurchaseOrderLine', 'labourPurchaseOrderVersion',
      'labourQuoteComparison',
      'labourReadinessProjection', 'labourRequirementSpec', 'labourRequisition',
      'labourRequisitionLine',
      'labourRfq', 'labourSkill', 'labourTrade', 'labourWorkFact', 'supplierLabourQuote',
      'supplierLabourQuoteLine', 'vendorLabourProfile', 'worker', 'workerAllocation', 'workerSkill',
    ];
    expect([...(labour!.readEncapsulated ?? [])].sort()).toEqual(expected);
    expect(labour!.readEncapsulated).toContain('workerSkill');
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
      activities: ['decisions', 'drawings', 'inspections', 'inventory', 'labour'], 'daily-log': ['decisions'], nodes: ['decisions'],
      // Phase 4 Task 3 — the orgs-owned WorkerDevice bind command reads the trusted-worker
      // lifecycle through Labour's query contract (`Worker` is Labour-owned + read-encapsulated).
      // Labour is a LEAF, so orgs → labour closes no cycle.
      orgs: ['decisions', 'inspections', 'labour'], drawings: ['decisions'],
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
      // requisition lines reference the requirement (the §F explicit-disposition guard).
      // Phase 4 Task 1 adds the labour participant: a type='labour' requirement writes its
      // Labour-owned detail (spec + slices) through LabourRequirementParticipant — the
      // cycle-exempt activities → labour edge that keeps labour a leaf (dependsOn: []).
      activities: ['inspections', 'drawings', 'procurement', 'labour'],
      'daily-log': ['activities'], // material-mismatch blocks the activity's readiness (edge 4)
      // Phase 3 Task 4 adds the inventory participant to media: the delete tx refuses while the
      // photo is immutable stock-ledger quality evidence (assertMediaDisposable)
      // Phase 4 Task 3 correction (F2) — deleting a photo also consults LABOUR: a muster's presence
      // evidence cannot be deleted while cited (cycle-exempt, and labour is a LEAF).
      media: ['inspections', 'inventory', 'labour'], // evidence add/remove (edges via the media create/remove tx)
      // Phase 3 Task 4 — the §G inventory→procurement edge: the receipt tx invokes the
      // procurement-owned PO-line lock + received-progress fact (§F bound 3); procurement does
      // not depend back on inventory, so the graph stays acyclic. Task 5 adds the activities
      // participant: reserve/issue validate their named activity through materialTarget (the
      // cycle-exempt channel — §G's READ edge runs activities → inventory in Task 6)
      inventory: ['procurement', 'activities'],
      // Task 10 Module 4 (+ correction): node deletion unfiles placed inspections, filed activities,
      // filed drawings AND staged site materials — each through its owning module's participant,
      // appending inspection.unfiled / activity.unfiled / drawing.unfiled / material.unfiled
      nodes: ['inspections', 'activities', 'drawings', 'daily-log'],
      orgs: ['nodes', 'activities', 'inspections'], // project-init instantiates each owning module
      inspections: ['activities'], // the closing-inspection decide writes the activity sign-off
      // Phase 4 Task 2 — the labour commercial chain validates the reused procurement Vendor/
      // ProjectVendor binding through ProcurementParticipant.assertVendorBound (+ resolveOrgVendor):
      // a CYCLE-EXEMPT labour → procurement workflow edge, not a dependsOn read, so labour stays a
      // LEAF (dependsOn: []) and the graph is still acyclic.
      // Phase 4 Task 3 adds `activities`: an allocation names the activity it serves, validated
      // through ActivityParticipant.labourTarget — also cycle-exempt (§G's READ edge runs
      // activities → labour, so a labour → activities READ would close a cycle).
      // Task 3 correction 3 (round 3h) adds `orgs`: the t3c repair engine validates a revoker's
      // ROLE-QUALIFIED standing through OrgsParticipant.hasProjectRoleStanding (round 3l: mere
      // project standing was not authority — the roles come from ROLE_POLICY['attendance.revoke'])
      // — the owner answers the membership question; Membership/Project/OrgMembership are never
      // queried from labour. Cycle-exempt for
      // the same reason (orgs.dependsOn includes labour, so a labour → orgs READ would close a
      // cycle; the participant channel does not).
      labour: ['procurement', 'activities', 'orgs'],
    };
    for (const m of MODULE_MANIFESTS) {
      expect(m.workflowParticipants, `${m.id} workflowParticipants`).toEqual(expectedParticipants[m.id] ?? []);
    }
  });

  // Phase 4 Task 4 — the §G acyclic-graph ACCEPTANCE test (plan round 3). (a) The exact edge
  // table: labour is a LEAF that CONSUMES the Activities-owned requirement events (the FIRST
  // non-empty consumesEvents in the registry — an async channel, never a dependsOn edge), and
  // activities carries the coverage read edge. (b) A topological sort of the COMPLETE dependsOn
  // graph succeeds — proven RED against the round-2 cyclic manifest (labour.dependsOn:
  // ['activities','decisions','procurement'] closed activities → labour → activities), which the
  // validator rejects with `cycle` and the sort reports unsortable.
  it('§G acyclic-graph acceptance: exact labour edges + a topological sort of dependsOn succeeds', () => {
    const labour = MODULE_MANIFESTS.find((m) => m.id === 'labour')!;
    const activities = MODULE_MANIFESTS.find((m) => m.id === 'activities')!;
    expect(labour.dependsOn).toEqual([]);
    expect(labour.consumesEvents).toEqual(['requirement.created', 'requirement.revised', 'requirement.cancelled']);
    expect(activities.producesEvents).toEqual(expect.arrayContaining([...labour.consumesEvents]));
    expect(activities.dependsOn).toContain('labour');
    expect(activities.workflowParticipants).toContain('labour');

    // Kahn's algorithm over the LIVE manifests: every module must be emitted (no cycle).
    const topologicalOrder = (manifests: readonly ModuleManifest[]): string[] | null => {
      const ids = manifests.map((m) => m.id);
      const inDegree = new Map(ids.map((id) => [id, 0]));
      const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
      for (const m of manifests) {
        for (const dep of m.dependsOn) {
          if (!inDegree.has(dep)) continue; // dangling deps are a separate validator finding
          inDegree.set(m.id, (inDegree.get(m.id) ?? 0) + 1);
          dependents.get(dep)!.push(m.id);
        }
      }
      const queue = ids.filter((id) => inDegree.get(id) === 0).sort();
      const order: string[] = [];
      while (queue.length) {
        const id = queue.shift()!;
        order.push(id);
        for (const d of dependents.get(id) ?? []) {
          inDegree.set(d, inDegree.get(d)! - 1);
          if (inDegree.get(d) === 0) queue.push(d);
        }
      }
      return order.length === ids.length ? order : null;
    };
    const order = topologicalOrder(MODULE_MANIFESTS);
    expect(order, 'the dependsOn graph has a cycle — no topological order exists').not.toBeNull();
    // A leaf sorts before its dependents: labour precedes activities in every valid order.
    expect(order!.indexOf('labour')).toBeLessThan(order!.indexOf('activities'));

    // RED fixture — the round-2 cyclic manifest the plan's correction removed: substituting
    // labour.dependsOn: ['activities','decisions','procurement'] closes
    // activities → labour → activities, the validator raises `cycle`, and no topological order
    // exists. Coupled to the LIVE manifests so the proof can never drift from reality.
    const cyclic = MODULE_MANIFESTS.map((m) =>
      m.id === 'labour' ? { ...m, dependsOn: ['activities', 'decisions', 'procurement'] } : m,
    );
    const codes = new Set(validateRegistry(cyclic, KNOWN_ROLES).map((e) => e.code));
    expect(codes.has('cycle')).toBe(true);
    expect(topologicalOrder(cyclic)).toBeNull();
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
