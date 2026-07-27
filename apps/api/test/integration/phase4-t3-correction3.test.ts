import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivityParticipant } from '../../src/activities/activity.participant';
import { LabourService } from '../../src/labour/labour.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { T3CRepairService, RepairAbortedError } from '../../src/labour/t3c/t3c-repair.service';
import { T3C_INVALID_LEGACY_PREFIX } from '../../src/labour/t3c/t3c-diagnostics';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 3 correction ROUND 3 — the three post-merge review findings, reproduce-first against
 * live PostgreSQL. Every probe here FAILS at `main` `f6af800` (the reviewed merge lineage through PR
 * #226 / `2a6112b`) and passes after the fix.
 *
 *   1 (the runbook deletes attendance evidence) `docs/RUNBOOK.md §P4T3C2` told the operator to
 *     disable `LabourAttendance_append_only` and DELETE every blank-`manualReason` muster. That
 *     erases the original observation, its recorder, its timestamps and its correction chain while
 *     the disabled trigger's own message says attendance rows are never deleted — and there was no
 *     preflight, no evidence table and no executable path at all. RED at `f6af800`: `src/labour/t3c`
 *     does not exist, `migrate.sh` runs no attendance preflight, and the runbook's repair is a
 *     `DELETE FROM "LabourAttendance"`.
 *
 *   2 (Labour reads an Activities-owned table directly) `LabourCapacityService.requirementHead` ran
 *     `SELECT … FROM "ActivityRequirementRoot" … FOR UPDATE` itself before calling the participant —
 *     a synchronous Labour→Activities persistence read from a LEAF module, and a lock the caller
 *     could get wrong. RED at `f6af800`: the participant reads the head WITHOUT taking the root
 *     lock, so a session holding that row does not block it. (The source half of this finding is
 *     proven by the boundary analyzer — see `src/platform/module-registry/boundary.test.ts`.)
 *
 *   3 (raw multi-requirement inserts can deadlock) the `WorkerAllocation` row trigger locks
 *     requirement roots in INPUT-ROW order and nothing took a project-wide lock first, so two
 *     same-project raw batches ordered `(A,B)` and `(B,A)` each held one root and waited for the
 *     other until PostgreSQL aborted one with 40P01. RED at `f6af800`: the barrier below produces a
 *     real deadlock.
 */
describe('Phase 4 Task 3 correction 3 — the three post-merge review findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let participant: ActivityParticipant;
  let labour: LabourService;
  let capacity: LabourCapacityService;
  let capabilities: CapabilitiesService;
  let repairs: T3CRepairService;
  let seq = 0;
  /** A DEDICATED client for the racing sessions: the held transaction, the conflicting statement and
   *  the pg_stat_activity poll each need their OWN backend connection at the same time. Sharing the
   *  app's pool can starve the conflicting session so it never reaches the server and never blocks. */
  let raceA: PrismaClient;
  let raceB: PrismaClient;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability", "Media" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    participant = t.app.get(ActivityParticipant);
    labour = t.app.get(LabourService);
    capacity = t.app.get(LabourCapacityService);
    capabilities = t.app.get(CapabilitiesService);
    repairs = new T3CRepairService(t.prisma);
    raceA = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    raceB = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  });
  afterAll(async () => {
    await raceA?.$disconnect();
    await raceB?.$disconnect();
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "T3CRepairAction"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "T3CRepairAction"');
    // `legacyBlankMuster` leaves the deployed CHECK re-added NOT VALID (exactly the production
    // situation: the constraint cannot be validated while the legacy row is there). Now that the
    // table is empty, restore it to VALIDATED so the next probe starts from a fully-sealed database.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p4z-' } }],
      ['activity', { projectId: { startsWith: 'it-p4z-' } }],
      ['membership', { projectId: { startsWith: 'it-p4z-' } }],
      ['project', { id: { startsWith: 'it-p4z-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4z-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4Z-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const labourRequirement = async (
    projectId: string, activityId: string, slices: Array<{ civilDate: string; personShiftQty: number }>,
  ): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: slices, decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const onboardWorker = async (projectId: string, name = `W${seq++}`): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    return w.id;
  };
  /** a CommandExecution row so a RAW (service-bypassing) insert satisfies its provenance FK */
  const rawCommand = async (projectId: string, commandType: string): Promise<string> => {
    const project = await t.prisma.project.findFirstOrThrow({ where: { id: projectId }, select: { orgId: true } });
    const c = await t.prisma.commandExecution.create({
      data: { scopeKind: 'project', organizationId: project.orgId, projectId, actorId: f.memberUser.id, commandType, idempotencyKey: `c3-${Date.now()}-${seq++}`, requestHash: 'c3', status: 'succeeded' },
    });
    return c.id;
  };
  /**
   * A BLANK-`manualReason` muster — the exact pre-`20270220` state the repair exists for. The
   * `LabourAttendance_manual_reason_non_blank` CHECK (deployed) forbids writing one, so it is created
   * with the CHECK momentarily dropped, exactly reproducing a legacy row that predates it. The CHECK
   * is restored NOT VALID so the row survives for the repair to find — which is precisely the
   * production situation: the constraint the migration wants to add cannot be validated yet.
   */
  const legacyBlankMuster = async (projectId: string, workerId: string, civilDate = '2026-08-10'): Promise<string> => {
    const commandId = await rawCommand(projectId, 'labour.attendance.record');
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    const id = `att-legacy-${Date.now() % 1e6}-${seq++}`;
    try {
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId")
         VALUES ($1,$2,$3,$4::date,'day','   ', now(), $5, $6)`,
        id, projectId, workerId, civilDate, f.memberUser.id, commandId,
      );
    } finally {
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_manual_reason_non_blank" CHECK ("manualReason" IS NULL OR btrim("manualReason", E' \\t\\n\\x0B\\f\\r') <> '') NOT VALID`,
      );
    }
    return id;
  };
  // ── barrier primitives (condition-based, never sleep-only) ────────────────────────────────────

  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  /** Prisma promises are LAZY — attaching a continuation is what dispatches the statement. */
  const reflect = <T>(p: Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> =>
    p.then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }));
  /** Poll pg_stat_activity for a backend ACTIVELY WAITING on a lock while running `queryLike`. The
   *  CONDITION gates progress; the interval is only the observation cadence. Observed on the app's
   *  client — a different connection from either racing session. */
  const waitUntilBlocked = async (queryLike: string, expected = 1): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
        queryLike,
      );
      if (Number(rows[0]!.c) >= expected) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected ${expected} backend(s) blocked on a lock while running ${queryLike}`);
  };

  // ══ FINDING 1 — the repair preserves the evidence it corrects ════════════════════════════════

  it('1a: the operator preflight NAMES the blank muster before Prisma is ever started', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const id = await legacyBlankMuster(projectId, workerId);

    // RED at f6af800: `src/labour/t3c` does not exist at all — there is no preflight, so the first
    // thing that notices this row is `prisma migrate deploy` failing inside migration 20270220.
    const eligible = await repairs.schemaEligible();
    expect(eligible.applicable, 'a Task-3 database is eligible for the attendance diagnostics').toBe(true);

    const report = await repairs.preflight();
    expect(report.clean).toBe(false);
    const blank = report.findings.find((x) => x.code === 'F1.blank')!;
    expect(blank.count).toBe(1);
    expect(blank.samples[0]!['id']).toBe(id);
    // the sample is bounded and IDENTIFYING — the operator can find the row and the person who
    // recorded it without querying anything themselves
    expect(blank.samples[0]!['recordedById']).toBe(f.memberUser.id);

  });

  it('1b: the repair PRESERVES the original row — nothing is deleted, and every byte survives in evidence', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const id = await legacyBlankMuster(projectId, workerId);
    const before = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id } });
    const countBefore = await t.prisma.labourAttendance.count({ where: { projectId } });

    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'P4T3C3: retire pre-20270220 blank-reason musters so the CHECK can be installed',
      actions: [{
        finding: 'F1.blank',
        op: 'f1-mark-invalid-legacy',
        id,
        revokedById: f.ownerUser.id,
        revokeReason: 'the original justification was never recorded; a replacement muster must be raised if this presence is real',
      }],
    });
    expect(outcome.applied).toBe(1);
    expect(outcome.verified.clean).toBe(true);

    // (i) THE ROW IS STILL THERE — no delete, and no other row appeared or vanished.
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id } });
    expect(await t.prisma.labourAttendance.count({ where: { projectId } })).toBe(countBefore);

    // (ii) The whole observation is intact: worker, date, shift, recorder, recorded-at, provenance.
    expect(after.workerId).toBe(before.workerId);
    expect(after.civilDate.toISOString()).toBe(before.civilDate.toISOString());
    expect(after.shift).toBe(before.shift);
    expect(after.deviceId).toBe(before.deviceId);
    expect(after.recordedById).toBe(before.recordedById);
    expect(after.recordedAt.toISOString()).toBe(before.recordedAt.toISOString());
    expect(after.sourceCommandId).toBe(before.sourceCommandId);

    // (iii) `manualReason` carries the RESERVED marker and says only what is true: the original was
    //       blank and the real justification is not knowable. It never guesses why the worker was there.
    expect(after.manualReason!.startsWith(T3C_INVALID_LEGACY_PREFIX)).toBe(true);
    expect(after.manualReason).toContain('never recorded and is not knowable');
    expect(after.manualReason).toContain('ops@vitan.in');
    expect(after.manualReason).toContain(outcome.repairId);

    // (iv) It CANNOT contribute active presence — revoked, fully attributed, in the same statement.
    expect(after.revokedAt).not.toBeNull();
    expect(after.revokedById).toBe(f.ownerUser.id);
    expect(after.revokeReason).toContain('replacement muster');

    // (v) The complete before-image — including the original blank bytes — is durably recorded and
    //     queryable, with the operator, the reason and the timestamp.
    const evidence = await t.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "repairId","operator","reason","finding","op","table","rowId","beforeImage","detail" FROM "T3CRepairAction" WHERE "rowId" = $1`,
      id,
    );
    expect(evidence).toHaveLength(1);
    const ev = evidence[0]!;
    expect(ev['operator']).toBe('ops@vitan.in');
    expect(ev['finding']).toBe('F1.blank');
    expect(ev['table']).toBe('LabourAttendance');
    const image = ev['beforeImage'] as Record<string, unknown>;
    expect(image['manualReason']).toBe('   ');
    expect(image['recordedById']).toBe(f.memberUser.id);
    expect(image['revokedAt']).toBeNull();
    expect((ev['detail'] as Record<string, unknown>)['originalManualReason']).toBe('   ');

    // (vi) The append-only seal is back on: the repaired row is as immutable as any other.
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "LabourAttendance" SET "manualReason" = 'anything' WHERE "id" = $1`, id),
    ).rejects.toThrow(/APPEND-ONLY|terminal/i);

  });

  it('1c: the repair NEVER invents — a healthy row, an unknown reviser and a missing reason are all refused', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const real = await capacity.recordAttendance(
      projectId, { workerId, civilDate: '2026-08-11', shift: 'day', manualReason: 'device battery dead at gate' }, pmc(projectId),
    );
    const blankId = await legacyBlankMuster(projectId, await onboardWorker(projectId));

    const plan = (over: Record<string, unknown>) => ({
      operator: 'ops@vitan.in',
      reason: 'attempted repair',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: blankId, revokedById: f.ownerUser.id, revokeReason: 'r', ...over } as any],
    });

    // a row with a REAL recorded justification is never overwritten by the repair
    await expect(repairs.repair(plan({ id: real.id }))).rejects.toThrow(/does not carry a blank manualReason/);
    // the accountable human must be real — the repair resolves it explicitly rather than letting the
    // revocation FK fail opaquely, and never fabricates one
    await expect(repairs.repair(plan({ revokedById: 'no-such-user' }))).rejects.toThrow(/names no User/);
    // a revocation with no stated reason is not a correction
    await expect(repairs.repair(plan({ revokeReason: '   ' }))).rejects.toThrow(/revokeReason is required/);

    // every refusal rolled back completely: the blank row is untouched and the evidence table was
    // never left behind by a half-applied repair
    const still = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: blankId } });
    expect(still.manualReason).toBe('   ');
    expect(still.revokedAt).toBeNull();
    const tableExists = await t.prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('"T3CRepairAction"') IS NOT NULL AS present`,
    );
    expect(tableExists[0]!.present, 'a rolled-back repair leaves no evidence table behind').toBe(false);

  });

  it('1d: a repair that does not clear EVERY finding rolls the whole transaction back', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const a = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-08-12');
    const b = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-08-13');

    // repairing only ONE of two blank musters leaves the database dirty — the in-transaction
    // re-diagnose refuses to commit, so the operator can never "half fix" their way past the gate
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in',
        reason: 'partial',
        actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: a, revokedById: f.ownerUser.id, revokeReason: 'r' }],
      }),
    ).rejects.toThrow(RepairAbortedError);

    for (const id of [a, b]) {
      const row = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id } });
      expect(row.manualReason).toBe('   ');
      expect(row.revokedAt).toBeNull();
    }

    // repairing BOTH commits, and the database is then clean for `prisma migrate deploy`
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'complete',
      actions: [a, b].map((id) => ({ finding: 'F1.blank' as const, op: 'f1-mark-invalid-legacy' as const, id, revokedById: f.ownerUser.id, revokeReason: 'retired legacy blank' })),
    });
    expect(outcome.applied).toBe(2);
    expect((await repairs.preflight()).clean).toBe(true);

  });

  it('1e: the marker is RESERVED — no ordinary write can manufacture operator provenance', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const commandId = await rawCommand(projectId, 'labour.attendance.record');

    // through the API
    await expect(
      capacity.recordAttendance(
        projectId,
        { workerId, civilDate: '2026-08-14', shift: 'day', manualReason: `${T3C_INVALID_LEGACY_PREFIX} looks official` },
        pmc(projectId),
      ),
    ).rejects.toThrow(/RESERVED/i);

    // and through a raw insert that bypasses the service entirely
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId")
         VALUES ($1,$2,$3,'2026-08-15'::date,'day',$4, now(), $5, $6)`,
        `att-forge-${seq++}`, projectId, workerId, `${T3C_INVALID_LEGACY_PREFIX} forged`, f.memberUser.id, commandId,
      ),
    ).rejects.toThrow(/RESERVED/i);

    // …and a marked row can never be left live: the CHECK refuses a marker without a revocation
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId")
         VALUES ($1,$2,$3,'2026-08-16'::date,'day',$4, now(), $5, $6)`,
        `att-forge2-${seq++}`, projectId, workerId, `${T3C_INVALID_LEGACY_PREFIX} x`, f.memberUser.id, commandId,
      ),
    ).rejects.toThrow(/RESERVED|marker_is_revoked/i);
  });

  it('1f: the production runner ENFORCES the attendance preflight before Prisma, and the runbook no longer deletes', async () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const migrateSh = readFileSync(join(repoRoot, 'apps/api/scripts/migrate.sh'), 'utf8');
    // RED at f6af800: migrate.sh ran the T45 and T2C preflights only, so a dirty Task-3 attendance
    // state reached `prisma migrate deploy` and surfaced as a FAILED migration record.
    expect(migrateSh).toContain('dist/labour/t3c/t3c.cli.js');
    // the COMPILED artifact, never tsx, and fail-closed when it is missing
    expect(migrateSh).toMatch(/T3C preflight[\s\S]*node "\$T3C_PREFLIGHT" preflight/);
    expect(migrateSh).toMatch(/compiled T3C preflight[\s\S]*refusing to deploy/);
    // and it runs BEFORE prisma
    expect(migrateSh.indexOf('T3C_PREFLIGHT')).toBeLessThan(migrateSh.indexOf('npx prisma migrate deploy'));

    const runbook = readFileSync(join(repoRoot, 'docs/RUNBOOK.md'), 'utf8');
    const section = runbook.slice(runbook.indexOf('## §P4T3C2'), runbook.indexOf('## §P4T3C3'));
    expect(section.length).toBeGreaterThan(0);
    // RED at f6af800: this section contained `DELETE FROM "LabourAttendance"` under a disabled
    // append-only trigger. No repair path may delete an attendance row.
    expect(section).not.toMatch(/DELETE\s+FROM\s+"LabourAttendance"/i);
    expect(section).toContain('t3c:preflight');
    expect(section).toContain('t3c:repair');
  });

  // ══ FINDING 2 — Activities owns the lock AND the head, indivisibly ═══════════════════════════

  it('2a: `labourRequirementHead` ACQUIRES the requirement root lock — a holder blocks it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const { requirementId } = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-20', personShiftQty: 1 }]);

    const release = gate();
    // Session A holds the requirement ROOT row exactly as `RequirementsService.revise/cancel` do.
    const holder = raceA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "ActivityRequirementRoot" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`,
        projectId, requirementId,
      );
      await release.promise;
      return 'held';
    }, { timeout: 30_000 });

    // wait until A actually owns the row
    for (let i = 0; i < 300; i++) {
      const held = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'ActivityRequirementRoot' AND l.mode = 'RowExclusiveLock'`,
      );
      if (Number(held[0]!.c) >= 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Session B asks the PARTICIPANT for the head. RED at f6af800: the participant took no lock, so
    // this returned immediately while A still held the root — Labour's own raw SELECT was the only
    // thing serializing, which is exactly the boundary violation being removed. GREEN: it blocks.
    let resolved = false;
    const reader = raceB.$transaction(async (tx) => {
      const head = await participant.labourRequirementHead(tx, { projectId, requirementId });
      resolved = true;
      return head;
    }, { timeout: 30_000 });
    const settled = reflect(reader);

    await waitUntilBlocked('%ActivityRequirementRoot%FOR UPDATE%');
    expect(resolved, 'the participant must not read the head while another session holds the root').toBe(false);

    release.open();
    await holder;
    const out = await settled;
    expect(out.status).toBe('fulfilled');
    expect(resolved).toBe(true);
    // and it still returns Activities' truth once the lock is available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out as any).value).toMatchObject({ activityId, status: 'open', type: 'labour' });
  });

  it('2b: an absent requirement root yields null — the participant owns that answer too', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const head = await t.prisma.$transaction((tx) => participant.labourRequirementHead(tx, { projectId, requirementId: 'no-such-requirement' }));
    expect(head).toBeNull();
    // …and the canonical allocation path still reports it as a 404, unchanged
    await expect(
      capacity.allocate(projectId, { requirementId: 'no-such-requirement', activityId: 'x', workerId: 'y', civilDate: '2026-08-20' }, pmc(projectId)),
    ).rejects.toThrow(/No requirement with that id/);
  });

  // ══ FINDING 3 — opposite-order raw batches serialize at the project lock ═════════════════════

  it('3a: two same-project raw batches in OPPOSITE requirement order serialize — no 40P01, all rows commit', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: '2026-08-20', personShiftQty: 4 }]);
    const reqB = await labourRequirement(projectId, actB, [{ civilDate: '2026-08-20', personShiftQty: 4 }]);
    // four DISTINCT workers, so the two batches never contend on the live partial unique — the only
    // thing that could make them fight is the requirement-root lock order.
    const [w1, w2, w3, w4] = [await onboardWorker(projectId), await onboardWorker(projectId), await onboardWorker(projectId), await onboardWorker(projectId)];
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: reqA.requirementId } });
    const cmdA = await rawCommand(projectId, 'raw.allocate.a');
    const cmdB = await rawCommand(projectId, 'raw.allocate.b');

    const insert = (
      tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> },
      id: string, workerId: string, requirementId: string, revision: number, activityId: string, commandId: string,
    ) => tx.$executeRawUnsafe(
      `INSERT INTO "WorkerAllocation"
         ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","status","allocatedAt","allocatedById","sourceCommandId")
       VALUES ($1,$2,$3,'2026-08-20'::date,'day',$4,$5,$6,$7,'active', now(), $8, $9)`,
      id, projectId, workerId, activityId, requirementId, revision, spec.labourSpecFingerprint, f.memberUser.id, commandId,
    );

    const aReady = gate();
    const bReady = gate();
    const go = gate();

    // Session A: requirement A then requirement B. Session B: requirement B then requirement A.
    const sessionA = raceA.$transaction(async (tx) => {
      await insert(tx, `raw-a1-${seq++}`, w1, reqA.requirementId, reqA.revision, actA, cmdA);
      aReady.open();
      await go.promise;
      await insert(tx, `raw-a2-${seq++}`, w2, reqB.requirementId, reqB.revision, actB, cmdA);
      return 'A';
    }, { timeout: 30_000 });

    const sessionB = raceB.$transaction(async (tx) => {
      await insert(tx, `raw-b1-${seq++}`, w3, reqB.requirementId, reqB.revision, actB, cmdB);
      bReady.open();
      await go.promise;
      await insert(tx, `raw-b2-${seq++}`, w4, reqA.requirementId, reqA.revision, actA, cmdB);
      return 'B';
    }, { timeout: 30_000 });

    const settledA = reflect(sessionA);
    const settledB = reflect(sessionB);

    // RED at f6af800: BOTH first inserts succeed (each session holds one root), so both gates open,
    // the second inserts cross, and PostgreSQL aborts one with 40P01 `deadlock detected`.
    // GREEN: the project readiness advisory lock is taken by the FIRST trigger, so session B's very
    // first insert blocks behind session A's — `bReady` never opens until A commits. The race is
    // resolved before either session can hold a root the other wants.
    await Promise.race([
      Promise.all([aReady.promise, bReady.promise]),
      waitUntilBlocked('%INSERT INTO "WorkerAllocation"%'),
    ]);
    go.open();

    const [ra, rb] = await Promise.all([settledA, settledB]);
    for (const [name, r] of [['A', ra], ['B', rb]] as const) {
      if (r.status === 'rejected') {
        const msg = String((r.reason as Error)?.message ?? r.reason);
        expect(msg, `session ${name} must not deadlock`).not.toMatch(/40P01|deadlock detected/i);
        throw new Error(`session ${name} failed unexpectedly: ${msg}`);
      }
    }

    // every non-conflicting row committed — serialization, not loss
    const rows = await t.prisma.workerAllocation.findMany({ where: { projectId }, select: { workerId: true, requirementId: true } });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.workerId))).toEqual(new Set([w1, w2, w3, w4]));
  });

  it('3b: the project readiness lock is the FIRST BEFORE-INSERT trigger on WorkerAllocation', async () => {
    // The ordering is what makes finding 3 impossible rather than merely unlikely: PostgreSQL fires
    // BEFORE-row triggers alphabetically, so this must sort ahead of `WorkerAllocation_head_live`
    // (root lock) and `WorkerAllocation_within_commitment` (commitment lock) in THIS database's own
    // collation. Migration 20270225 asserts it at deploy; this pins it in the suite.
    const rows = await t.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT t.tgname FROM pg_trigger t
        WHERE t.tgrelid = '"WorkerAllocation"'::regclass AND NOT t.tgisinternal
          AND (t.tgtype & 4) <> 0 AND (t.tgtype & 2) <> 0
        ORDER BY t.tgname`,
    );
    expect(rows[0]!.tgname).toBe('WorkerAllocation_00_project_lock');
    expect(rows.map((r) => r.tgname)).toContain('WorkerAllocation_head_live');
  });

  it('3c: a raw allocation still serializes against a CANONICAL one — the two paths share the lock', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-21', personShiftQty: 2 }]);
    const workerId = await onboardWorker(projectId);
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: req.requirementId } });
    const commandId = await rawCommand(projectId, 'raw.allocate.dup');

    // one canonical allocation for the worker, then a RAW duplicate for the same slice: the DB seal
    // (the live partial unique) still wins, and the advisory lock does not mask it.
    await capacity.allocate(projectId, { requirementId: req.requirementId, activityId, workerId, civilDate: '2026-08-21' }, pmc(projectId));
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "WorkerAllocation"
           ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","status","allocatedAt","allocatedById","sourceCommandId")
         VALUES ($1,$2,$3,'2026-08-21'::date,'day',$4,$5,$6,$7,'active', now(), $8, $9)`,
        `raw-dup-${seq++}`, projectId, workerId, activityId, req.requirementId, req.revision, spec.labourSpecFingerprint, f.memberUser.id, commandId,
      ),
    ).rejects.toThrow();
    expect(await t.prisma.workerAllocation.count({ where: { projectId, status: 'active' } })).toBe(1);
  });

  it('3d: a raw allocation against a CANCELLED requirement is still refused — the seal is unchanged', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-22', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: req.requirementId } });
    const commandId = await rawCommand(projectId, 'raw.allocate.cancelled');
    await requirements.cancel(projectId, req.requirementId, { reason: 'scope dropped', expectedRevision: req.revision }, pmc(projectId));

    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "WorkerAllocation"
           ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","status","allocatedAt","allocatedById","sourceCommandId")
         VALUES ($1,$2,$3,'2026-08-22'::date,'day',$4,$5,$6,$7,'active', now(), $8, $9)`,
        `raw-cancel-${seq++}`, projectId, workerId, activityId, req.requirementId, req.revision, spec.labourSpecFingerprint, f.memberUser.id, commandId,
      ),
    ).rejects.toThrow(/cancelled/i);
  });

  // ══ ROUND-3 RE-REVIEW — the marker must POINT AT EVIDENCE, and the evidence must be permanent ══

  /** Write a marker directly, with the reserving trigger momentarily dropped — exactly what a direct
   *  writer could do on a database that has not yet applied `20270225000000`. Nothing else about the
   *  row is special: the forger fills in the revocation triple precisely because it looks legitimate. */
  const forgedMarkedMuster = async (
    projectId: string, workerId: string, marker: string, civilDate = '2026-09-01',
  ): Promise<string> => {
    const commandId = await rawCommand(projectId, 'labour.attendance.record');
    const id = `att-forged-marker-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "LabourAttendance_reserved_marker" ON "LabourAttendance"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT IF EXISTS "LabourAttendance_marker_is_revoked"`);
    try {
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance"
           ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId","revokedAt","revokedById","revokeReason")
         VALUES ($1,$2,$3,$4::date,'day',$5, now(), $6, $7, now(), $6, 'looks like a repair')`,
        id, projectId, workerId, civilDate, marker, f.memberUser.id, commandId,
      );
    } finally {
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER "LabourAttendance_reserved_marker" BEFORE INSERT ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_attendance_reserved_marker()`,
      );
      // Re-added VALIDATED, not NOT VALID: the forged row is marked AND revoked, so it satisfies
      // this CHECK and validation succeeds. Leaving it unvalidated would be a lie about the
      // database's state — and `correctionSeals` now checks `convalidated` precisely because an
      // unvalidated CHECK does not constrain the rows already present.
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
           CHECK ("manualReason" IS NULL
               OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
               OR "revokedAt" IS NOT NULL)`,
      );
    }
    return id;
  };

  it('R7: a REVOKED marker with no repair evidence is a FINDING — revocation alone never blesses it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    // RED at 0832c7d: the diagnostic tested `revokedAt IS NULL`, so this row — revoked, marked, and
    // backed by nothing — passed both the preflight and the migration, and from then on read
    // permanently as an audited operator repair.
    const forged = await forgedMarkedMuster(projectId, workerId, `${T3C_INVALID_LEGACY_PREFIX} repair=${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}; forged`);

    const report = await repairs.preflight();
    expect(report.clean).toBe(false);
    const marker = report.findings.find((x) => x.code === 'F1.marker')!;
    expect(marker.count).toBe(1);
    expect(marker.samples[0]!['id']).toBe(forged);

    // The migration refuses too — a forged marker can never ride in on a deploy.
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma/migrations/20270225000000_phase4_t3_correction3/migration.sql'),
      'utf8',
    );
    expect(sql).toContain('T3CRepairAction');
    expect(sql).toContain('repair=([0-9a-fA-F-]{36})');
  });

  it('R7: a marker whose embedded repair id does not match its evidence row is still a FINDING', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);

    // A REAL repair first, so the evidence table exists and holds one genuine before-image.
    const genuine = await legacyBlankMuster(projectId, workerId, '2026-09-02');
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'genuine repair',
      actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: genuine, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    expect((await repairs.preflight()).clean).toBe(true);

    // Now a forgery that CITES that real repair id. The evidence row exists — but it is for another
    // row, so "some repair once ran here" buys the forger nothing.
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId), `${T3C_INVALID_LEGACY_PREFIX} repair=${outcome.repairId}; borrowed someone else's evidence`, '2026-09-03',
    );
    const report = await repairs.preflight();
    expect(report.clean).toBe(false);
    const marker = report.findings.find((x) => x.code === 'F1.marker')!;
    expect(marker.count).toBe(1);
    expect(marker.samples[0]!['id']).toBe(forged);
  });

  it('R8: the repair EVIDENCE is append-only — its before-image can be neither rewritten nor deleted', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const id = await legacyBlankMuster(projectId, workerId, '2026-09-04');
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'retire legacy blank',
      actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    // The repair itself verified the seal was back on before committing.
    expect(outcome.triggersRestored).toContain('T3CRepairAction_append_only');

    // RED at 0832c7d: `T3CRepairAction` was an ordinary table, so both of these succeeded — the only
    // surviving copy of the original blank bytes could be rewritten or erased while the attendance
    // row went on claiming "Original row preserved in T3CRepairAction".
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "T3CRepairAction" SET "operator" = 'someone else' WHERE "rowId" = $1`, id),
    ).rejects.toThrow(/append-only/i);
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "T3CRepairAction" WHERE "rowId" = $1`, id),
    ).rejects.toThrow(/append-only/i);

    const still = await t.prisma.$queryRawUnsafe<Array<{ operator: string; beforeImage: Record<string, unknown> }>>(
      `SELECT "operator", "beforeImage" FROM "T3CRepairAction" WHERE "rowId" = $1`, id,
    );
    expect(still).toHaveLength(1);
    expect(still[0]!.operator).toBe('ops@vitan.in');
    expect(still[0]!.beforeImage['manualReason']).toBe('   ');
  });

  it('R6: the repair validates the accountable human through the FK, not by reading Orgs persistence', async () => {
    const repairSrc = readFileSync(join(__dirname, '..', '..', 'src/labour/t3c/t3c-repair.service.ts'), 'utf8');
    // RED at 0832c7d: `SELECT count(*) … FROM "User"` — a LEAF module synchronously reading an
    // Orgs-owned table. Being outside the runtime boundary scan did not make the crossing legitimate.
    expect(repairSrc).not.toMatch(/FROM\s+"User"/);
    expect(repairSrc).toContain('LabourAttendance_revokedBy_fkey');

    // …and the refusal is still the same named one, now produced by translating the FK violation.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const blankId = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-09-05');
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in',
        reason: 'attempted repair',
        actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: blankId, revokedById: 'no-such-user', revokeReason: 'r' }],
      }),
    ).rejects.toThrow(/names no User/);
    const untouched = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: blankId } });
    expect(untouched.manualReason).toBe('   ');
    expect(untouched.revokedAt).toBeNull();
  });

  it('R-plan: a mis-stated finding is REFUSED, and the evidence records the op-derived classification', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const id = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-09-06');

    // RED at 0832c7d: the CLI casts operator-authored JSON to `Partial<RepairPlan>`, so a plan
    // claiming `F1.marker` still ran the blank-row repair and wrote that false classification into
    // `T3CRepairAction` — now permanently, since the evidence is append-only. Refused BEFORE any
    // trigger is disabled: the operator is told what they are actually repairing.
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in',
        reason: 'mis-stated plan',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: [{ finding: 'F1.marker', op: 'f1-mark-invalid-legacy', id, revokedById: f.ownerUser.id, revokeReason: 'r' } as any],
      }),
    ).rejects.toThrow(/repairs F1\.blank, not "F1\.marker"/);
    const untouched = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id } });
    expect(untouched.manualReason).toBe('   ');

    // A plan that states nothing still records the truth — the OP decides the classification.
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'retire legacy blank',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions: [{ op: 'f1-mark-invalid-legacy', id, revokedById: f.ownerUser.id, revokeReason: 'retired' } as any],
    });
    const evidence = await t.prisma.$queryRawUnsafe<Array<{ finding: string }>>(
      `SELECT "finding" FROM "T3CRepairAction" WHERE "rowId" = $1`, id,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.finding).toBe('F1.blank');
  });

  it('R4: the correction seals are verifiable, and the baseline path refuses to bless them unseen', async () => {
    // On a fully-migrated database every physical object is present.
    const seals = await repairs.correctionSeals();
    expect(seals.installed).toBe(true);
    expect(seals.present.sort()).toEqual([
      'LabourAttendance_marker_is_revoked', 'LabourAttendance_reserved_marker', 'WorkerAllocation_00_project_lock',
    ]);

    // Drop one — the shape a `prisma db push` database is permanently in — and the check names it.
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "WorkerAllocation_00_project_lock" ON "WorkerAllocation"`);
    try {
      const missing = await repairs.correctionSeals();
      expect(missing.installed).toBe(false);
      expect(missing.missing).toEqual(['WorkerAllocation_00_project_lock']);
    } finally {
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER "WorkerAllocation_00_project_lock" BEFORE INSERT ON "WorkerAllocation"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_allocation_project_lock()`,
      );
    }

    // RED at 0832c7d: the P3005 branch resolved EVERY migration as applied, so a db-push database
    // recorded 20270225 as installed while carrying none of its objects, forever.
    const migrateSh = readFileSync(join(__dirname, '..', '..', 'scripts/migrate.sh'), 'utf8');
    expect(migrateSh).toContain('20270225000000_phase4_t3_correction3');
    expect(migrateSh).toContain('seals');
    expect(migrateSh).toMatch(/skipping resolve --applied/);
  });
});
