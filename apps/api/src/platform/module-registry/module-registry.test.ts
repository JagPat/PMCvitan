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
      ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'],
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
    // Task 8/10 — one-directional query-contract dependencies. The six decision consumers declare
    // `dependsOn: ['decisions']`; Task 10 extracts `daily-log`, whose sole cross-module reader (media,
    // the linked-`dailyLogId` check) additionally declares `daily-log`. `decisions` and `daily-log`
    // depend on nothing that depends back, so the graph stays ACYCLIC. The mutual activity↔inspection
    // sign-off remains a workflow participation, NOT a dependsOn cycle.
    const expectedDependsOn: Record<string, string[]> = {
      // Task 10 — `activities` additionally reads the DRAWING gate through the drawings query
      // (read-encapsulation), so it declares `drawings` too; `drawings` depends only on `decisions`,
      // so activities→drawings→decisions stays ACYCLIC (drawings never depends back on activities).
      activities: ['decisions', 'drawings'], 'daily-log': ['decisions'], nodes: ['decisions'], orgs: ['decisions'], drawings: ['decisions'],
      media: ['decisions', 'daily-log'],
    };
    for (const m of MODULE_MANIFESTS) {
      expect(m.dependsOn, `${m.id} dependsOn`).toEqual(expectedDependsOn[m.id] ?? []);
    }
    const activities = MODULE_MANIFESTS.find((m) => m.id === 'activities')!;
    const inspections = MODULE_MANIFESTS.find((m) => m.id === 'inspections')!;
    expect(activities.workflowParticipants).toContain('inspections');
    expect(inspections.workflowParticipants).toContain('activities');
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
