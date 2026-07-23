import { describe, it, expect } from 'vitest';
import { ACTIVITIES_COMMANDS, ACTIVITIES_QUERIES, type ActivitiesModuleResult } from '@vitan/shared';
import { activitiesManifest } from './activities.manifest';
import { ActivitiesQueryService } from './activities.query';
import { ActivitiesService } from './activities.service';
import { PhasesService } from './phases.service';

/**
 * Phase 2 Task 10 (Module 4) — the activities module is reachable ONLY through its shared contract
 * (commands + queries) + its `activity.*`/`phase.*` events. This test pins that contract against the
 * implementation: the manifest's command/query lists equal the shared contract's, the module
 * read-encapsulates every model it owns (incl. its rebuildable projection), and the query service
 * implements every declared query plus the module-owned HTTP read whose return conforms to the ONE shared
 * {@link ActivitiesModuleResult}. The atomic activity↔inspection edges stay workflow contracts (the
 * inspections participant for completion, this module's participant for the sign-off), asserted here as
 * the manifest workflow-participant edge.
 */
describe('Task 10 — the activities module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(activitiesManifest.commands).toEqual([...ACTIVITIES_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(activitiesManifest.queries).toEqual([...ACTIVITIES_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted)', () => {
    expect(activitiesManifest.readEncapsulated).toEqual(activitiesManifest.ownsModels);
    // the activity spine owns EXACTLY its canonical models + the rebuildable projection table — no other
    // module reads any of them directly (the boundary check enforces it).
    expect(activitiesManifest.ownsModels).toEqual(['activity', 'gateOverride', 'phase', 'activitiesProjection', 'activityRequirement', 'activityRequirementRoot', 'materialRequirementSpec', 'approvedSubstitution']);
  });

  it('the manifest publishes the activity/phase lifecycle + the participant signal events', () => {
    expect([...activitiesManifest.producesEvents].sort()).toEqual(
      [
        'activity.created',
        'activity.updated',
        'activity.deleted',
        'activity.started',
        'activity.completion_requested',
        'activity.override_granted',
        'activity.override_revoked',
        // Task 10 (Module 4) — the two signal-only events a FOREIGN command appends through this module's
        // participant (daily-log material mismatch, nodes delete) so the ordered activities.schedule
        // projection refreshes on a foreign mutation to an activity-owned serialized fact. NOTE the
        // sign-off events (`activity.signed_off`/`signoff_rejected`) are produced by INSPECTIONS (the
        // cause is the inspection decision) — they live in ITS manifest, not here.
        'activity.material_blocked',
        // Phase 3 Task 5 (§E) — the inverse block signal, appended by the daily-log
        // resolve-mismatch command through the activities participant.
        'activity.material_unblocked',
        'activity.unfiled',
        'phase.created',
        'phase.removed',
        'requirement.cancelled',
        'requirement.created',
        'requirement.revised',
        // Phase 3 Task 6 — approved-substitution facts (§B); the readiness projection consumes them
        'substitution.approved',
        'substitution.revoked',
      ].sort(),
    );
    // the atomic activity↔inspection edges stay WORKFLOW contracts (participant), not cross-module
    // reads; the Module-4 correction adds `drawings` — `remove` routes the drawing unlink
    // (Drawing.activityId, previously ON DELETE SET NULL only) through the drawings participant.
    expect(activitiesManifest.workflowParticipants).toEqual(['inspections', 'drawings', 'procurement']);
    // the readiness BAKE reads decisions + drawings + inspections via their query contracts (dependsOn);
    // the reverse inspections→activities edge is the cycle-exempt participant, keeping this graph acyclic.
    expect(activitiesManifest.dependsOn).toEqual(['decisions', 'drawings', 'inspections', 'inventory']);
  });

  it('the query service implements every declared query + the structure/rollup boundary read surface', () => {
    for (const method of [
      'snapshotSlice',
      'projectionSlice',
      'moduleActivities',
      'allIds',
      'scheduleStructures',
      'statusCounts',
      'existsInProject',
      'resolveRefInProject',
    ] as const) {
      expect(typeof ActivitiesQueryService.prototype[method]).toBe('function');
    }
  });

  // ── Task 5 — every command carries the idempotency key as its trailing argument ──
  it('every command accepts the idempotency key as its trailing argument', () => {
    const _create: Parameters<ActivitiesService['create']>[3] = 'k' as string | undefined;
    const _update: Parameters<ActivitiesService['update']>[4] = 'k' as string | undefined;
    const _remove: Parameters<ActivitiesService['remove']>[3] = 'k' as string | undefined;
    const _start: Parameters<ActivitiesService['start']>[3] = 'k' as string | undefined;
    const _complete: Parameters<ActivitiesService['complete']>[3] = 'k' as string | undefined;
    const _override: Parameters<ActivitiesService['override']>[4] = 'k' as string | undefined;
    const _revoke: Parameters<ActivitiesService['revokeOverride']>[4] = 'k' as string | undefined;
    const _phaseCreate: Parameters<PhasesService['create']>[3] = 'k' as string | undefined;
    const _phaseRemove: Parameters<PhasesService['remove']>[3] = 'k' as string | undefined;
    void [_create, _update, _remove, _start, _complete, _override, _revoke, _phaseCreate, _phaseRemove];
    expect(true).toBe(true);
  });

  // ── Compile-time contract conformance (only type-checks if the shapes line up) ──
  it('the module HTTP result is the ONE shared type; the API moduleActivities return conforms to it', () => {
    // finding 5 (daily-log) parity — the API's moduleActivities return conforms to the shared type the
    // web gateway also imports, so the two cannot drift.
    const _mod: ActivitiesModuleResult = {} as Awaited<ReturnType<ActivitiesQueryService['moduleActivities']>>;
    void _mod;
    expect(true).toBe(true);
  });
});
