import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSPECTIONS_COMMANDS, INSPECTIONS_QUERIES, rolesFor, type InspectionsModuleResult } from '@vitan/shared';
import { inspectionsManifest } from './inspections.manifest';
import { InspectionsQueryService } from './inspections.query';
import { CORRECTIVE_ROLES, InspectionsService } from './inspections.service';
import { readinessLockKey } from '../common/readiness-lock';

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

  /**
   * A rejection names the assignee of the corrective re-inspection, and `decide` admits any
   * CORRECTIVE_ROLES holder. The assignee is then the ONLY caller `submit` accepts — so a role that
   * may be named an assignee but cannot reach the route is corrective work NOBODY can hand back:
   * its assignee is refused at the door and everybody else is refused by the assignee check. The
   * ceiling is asserted against the assignee set rather than a literal list, so widening either one
   * without the other fails here.
   */
  it('every role a rejection may ASSIGN can reach the submit route', () => {
    const ceiling = rolesFor('inspection.submit');
    for (const role of CORRECTIVE_ROLES) expect(ceiling).toContain(role);
  });

  /**
   * ROUND 7, FINDING 3 — the same rule, stated at two boundaries, has to stay ONE rule.
   *
   * `Inspection_submit_authority` restates the binding-assignment rule in SQL, because a rolling
   * deployment's previous-release replica is a writer this deployment does not control and the
   * database is the only boundary it shares. That copy exists to be a floor UNDER the service rule,
   * never a different rule: if the TypeScript set gained a role the SQL list did not, the trigger
   * would reject submits this release deliberately accepts, and every such submit would fail with a
   * database error nobody could act on. Pinned by reading the migration, so the two lists cannot
   * drift without this failing.
   */
  it('the writer fences name EXACTLY the CORRECTIVE_ROLES the service enforces, in ONE place', () => {
    const migrations = join(__dirname, '../../prisma/migrations');
    const submit = readFileSync(join(migrations, '20271216000000_inspection_submit_authority_fence/migration.sql'), 'utf8');
    const evidence = readFileSync(join(migrations, '20271217000000_inspection_evidence_authority_fence/migration.sql'), 'utf8');

    // #571 round 10 — the SUBMIT and EVIDENCE fences ask the same question, so the predicate is
    // extracted into `inspection_assignment_binds` and stated ONCE. A second fence carrying its own
    // copy of the role list is exactly how the two would come to disagree, so the pin asserts both
    // that the list is right AND that there is only one of it.
    const roleLists = [...(submit + evidence).matchAll(/m\."role" IN \(([^)]*)\)/gu)];
    expect(roleLists, 'the corrective-role list must appear EXACTLY once across the fences').toHaveLength(1);
    const sqlRoles = roleLists[0]![1].split(',').map((r) => r.trim().replace(/^'|'$/gu, ''));
    expect(sqlRoles.sort()).toEqual([...CORRECTIVE_ROLES].sort());

    // and both fences must actually reach it
    expect(submit, 'the submit fence must ask the shared predicate').toContain('inspection_assignment_binds(');
    expect(evidence, 'the evidence fence must ask the shared predicate').toContain('inspection_assignment_binds(');
  });

  /**
   * ROUND 8, FINDING 1 — the fence's lock must be THE readiness lock, not one that looks like it.
   *
   * The trigger takes the project's readiness key before it reads `Membership`, and it must spell
   * that key exactly as `readinessLockKey` does. `readiness-lock.ts` exported that helper precisely
   * because a second spelling fails silently: the day the prefix changes, one caller stops
   * serializing against the other and every test still passes. SQL cannot import the helper, so the
   * pin is here — derived from the helper rather than from a literal.
   *
   * ROUND 11 splits the two fences apart on this point, and the test name says so. Taking the key
   * is right for SUBMIT and wrong for EVIDENCE, for a reason neither fence's own text shows: the
   * price of the line depends on whether the CALLER already holds that lock.
   */
  it('the SUBMIT fence takes the readiness key; the EVIDENCE fence deliberately does not', () => {
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20271216000000_inspection_submit_authority_fence/migration.sql'),
      'utf8',
    );
    const evidence = readFileSync(
      join(__dirname, '../../prisma/migrations/20271217000000_inspection_evidence_authority_fence/migration.sql'),
      'utf8',
    );
    const prefix = readinessLockKey('');
    expect(sql, 'the submit fence must try-acquire the readiness advisory lock before judging')
      .toContain(`pg_try_advisory_xact_lock(hashtextextended('${prefix}' || NEW."projectId", 0))`);

    // #571 round 11 — and the EVIDENCE fence must NOT take it, which is the opposite of what round
    // 10 wrote. The two paths pay different prices for the same line: `submit` enters its trigger
    // from a service already holding this key, so the acquisition is re-entrant and free, while
    // `MediaService` holds no readiness lock — so acquiring it there takes a PROJECT-WIDE lock
    // inside every photo upload and holds it to commit, queueing every readiness writer behind
    // uploads. It bought nothing either: what serializes the fence against a concurrent standing
    // change is the `FOR UPDATE` on the membership row inside `inspection_assignment_binds`, added
    // because round 9's finding 2 established the advisory lock alone was insufficient. This pin
    // is the asymmetry itself, so restoring the lock by symmetry a second time fails here.
    expect(evidence, 'the evidence fence must NOT acquire the readiness key — the membership row lock orders it')
      .not.toMatch(/advisory_xact_lock/u);

    // and the submit fence must TRY rather than wait — a blocking acquisition can invert a lock order
    expect(sql + evidence).not.toMatch(/[^_]pg_advisory_xact_lock\(/u);
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
    expect(inspectionsManifest.workflowParticipants).toEqual(['activities', 'orgs']);
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
