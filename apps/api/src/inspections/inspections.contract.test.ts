import { describe, it, expect } from 'vitest';
import { INSPECTIONS_COMMANDS, INSPECTIONS_QUERIES, type InspectionsModuleResult } from '@vitan/shared';
import { inspectionsManifest } from './inspections.manifest';
import { InspectionsQueryService } from './inspections.query';
import { InspectionsService } from './inspections.service';

/**
 * Phase 2 Task 10 (Module 3) — the inspections module is reachable ONLY through its shared contract
 * (commands + queries) + its `inspection.*` events. This test pins that contract against the
 * implementation: the manifest's command/query lists equal the shared contract's, the module
 * read-encapsulates every model it owns (incl. its rebuildable projection), and the query service
 * implements every declared query plus the module-owned HTTP read whose return conforms to the ONE shared
 * {@link InspectionsModuleResult}. The atomic activity↔inspection sign-off stays a workflow contract
 * (the activities participant), asserted here as the manifest workflow-participant edge.
 */
describe('Task 10 — the inspections module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(inspectionsManifest.commands).toEqual([...INSPECTIONS_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(inspectionsManifest.queries).toEqual([...INSPECTIONS_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted)', () => {
    expect(inspectionsManifest.readEncapsulated).toEqual(inspectionsManifest.ownsModels);
    // the rebuildable projection table is owned + encapsulated alongside the canonical models
    expect(inspectionsManifest.ownsModels).toContain('inspectionsProjection');
    expect(inspectionsManifest.ownsModels).toContain('inspection');
    expect(inspectionsManifest.ownsModels).toContain('inspectionItem');
    // Task 10 (Module 3) correction — the inspection-owned evidence link is owned + read-encapsulated too,
    // so item evidence is an inspection fact (not a live Media read) and no foreign module reads it directly.
    expect(inspectionsManifest.ownsModels).toContain('inspectionEvidence');
  });

  it('the manifest publishes the inspection lifecycle + correction signals + the caused activity sign-off events', () => {
    expect([...inspectionsManifest.producesEvents].sort()).toEqual(
      [
        'inspection.created',
        'inspection.submitted',
        'inspection.approved',
        'inspection.rejected',
        'inspection.reinspection_created',
        // Task 10 (Module 3) correction — the five signal-only events a FOREIGN command appends through
        // this module's participant so the ordered inspections.inbox projection refreshes on a foreign
        // mutation to an inspection-owned serialized field.
        'inspection.closing_created',
        'inspection.evidence_added',
        'inspection.evidence_removed',
        'inspection.relabeled',
        'inspection.unfiled',
        // the sign-off events are CAUSED by a closing inspection's decision (emitted here, same tx)
        'activity.signed_off',
        'activity.signoff_rejected',
      ].sort(),
    );
    // the atomic activity↔inspection edges stay WORKFLOW contracts (participant), not cross-module reads.
    expect(inspectionsManifest.workflowParticipants).toEqual(['activities']);
    // no cross-module read dependency: every consumer reads inspection through THIS module's query.
    expect(inspectionsManifest.dependsOn).toEqual([]);
  });

  it('the query service implements every declared query + the readiness/boundary read surface', () => {
    for (const method of [
      'snapshotSlice',
      'projectionSlice',
      'moduleInspections',
      'readinessSlice',
      'nextInspectionId',
      'allIds',
      'checklistStructures',
      'openInspectionCount',
      'assertEvidenceTarget',
      'existsInProject',
      'resolveRefInProject',
    ] as const) {
      expect(typeof InspectionsQueryService.prototype[method]).toBe('function');
    }
  });

  // ── Task 5 — every command carries the idempotency key as its trailing argument ──
  it('every command accepts the idempotency key as its trailing argument', () => {
    const _create: Parameters<InspectionsService['create']>[3] = 'k' as string | undefined;
    const _submit: Parameters<InspectionsService['submit']>[4] = 'k' as string | undefined;
    const _decide: Parameters<InspectionsService['decide']>[4] = 'k' as string | undefined;
    void [_create, _submit, _decide];
    expect(true).toBe(true);
  });

  // ── Compile-time contract conformance (only type-checks if the shapes line up) ──
  it('the module HTTP result is the ONE shared type; the API moduleInspections return conforms to it', () => {
    // finding 5 (daily-log) parity — the API's moduleInspections return conforms to the shared type the
    // web gateway also imports, so the two cannot drift.
    const _mod: InspectionsModuleResult = {} as Awaited<ReturnType<InspectionsQueryService['moduleInspections']>>;
    void _mod;
    expect(true).toBe(true);
  });
});
