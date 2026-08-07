import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivityParticipant } from '../../src/activities/activity.participant';
import { LabourService } from '../../src/labour/labour.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { T3CRepairService, RepairAbortedError } from '../../src/labour/t3c/t3c-repair.service';
import { t3cRenderTs, T3C_INVALID_LEGACY_PREFIX, T3C_PREREQUISITE_TRIGGER_SEALS } from '../../src/labour/t3c/t3c-diagnostics';
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
    'TRUNCATE TABLE "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability", "Media" CASCADE';

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
    await t?.prisma.$executeRawUnsafe('DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_drop_guard');
    await t?.prisma.$executeRawUnsafe('DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_alter_guard');
    await t?.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "T3CRepairAction"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    // The round-7 DROP guard would (correctly) refuse this drop — removing it first is the
    // deliberate, loud act the guard is designed to force. That is the honest teardown shape:
    // a test harness resetting a scratch table is exactly the actor the guard cannot and does
    // not claim to stop, only to make explicit.
    await t.prisma.$executeRawUnsafe('DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_drop_guard');
    await t.prisma.$executeRawUnsafe('DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_alter_guard');
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
    // reserved-then-completed: the receipt protocol is DB-sealed (20270425000000), and a
    // directly minted `succeeded` row is exactly the forgery it refuses.
    const c = await t.prisma.$transaction(async (tx) => {
      const created = await tx.commandExecution.create({
        data: { scopeKind: 'project', organizationId: project.orgId, projectId, actorId: f.memberUser.id, commandType, idempotencyKey: `c3-${Date.now()}-${seq++}`, requestHash: 'c3', status: 'reserved' },
      });
      await tx.commandExecution.update({
        // a non-blank `resultRef` is required on `succeeded` — a real command records the entity
        // it produced, and this fixture stands in for one
        where: { id: created.id }, data: { status: 'succeeded', resultRef: `fixture-${created.id}`, completedAt: new Date() },
      });
      return created;
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
  /** `revoked` writes the revocation triple in the SAME insert — a legacy muster whose blank reason
   *  was already revoked before correction 2 shipped. It must be part of the insert: the deployed
   *  CHECK is re-added NOT VALID below, and a NOT VALID check still applies to any row that is
   *  UPDATED, so revoking this row afterwards would be rejected while its reason is still blank. */
  /**
   * Write to `T3CRepairAction` the way a DIRECT WRITER can — bypassing the repair engine.
   *
   * Since round 3g the table carries `T3CRepairAction_repair_path_only`, so a plain INSERT is
   * refused outright (R7-E proves that). A forger must now impersonate the repair protocol by
   * setting the transaction-local GUC, and that is exactly what this does — deliberately, and
   * honestly: the seal's claim is that every ORDINARY path is closed, not that someone with database
   * access is stopped. Everything these probes go on to demonstrate is what remains possible after
   * the seal, which is precisely why the diagnostics exist.
   */
  const forgedInsert = async (repairId: string, sql: string, ...params: unknown[]): Promise<void> => {
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('phase4.t3c_repair_id', $1, true)`, repairId);
      await tx.$executeRawUnsafe(sql, ...params);
    });
  };

  const legacyBlankMuster = async (
    projectId: string, workerId: string, civilDate = '2026-08-10',
    revoked?: { at: string; byId: string; reason: string },
  ): Promise<string> => {
    const commandId = await rawCommand(projectId, 'labour.attendance.record');
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    const id = `att-legacy-${Date.now() % 1e6}-${seq++}`;
    try {
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId","revokedAt","revokedById","revokeReason")
         VALUES ($1,$2,$3,$4::date,'day','   ', now(), $5, $6, $7::timestamptz, $8, $9)`,
        id, projectId, workerId, civilDate, f.memberUser.id, commandId,
        revoked?.at ?? null, revoked?.byId ?? null, revoked?.reason ?? null,
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
  /** This session's own backend pid, read INSIDE its transaction so the barrier can name it. */
  const backendPid = async (tx: { $queryRawUnsafe: (q: string) => Promise<unknown> }): Promise<number> => {
    const rows = (await tx.$queryRawUnsafe(`SELECT pg_backend_pid()::int AS pid`)) as Array<{ pid: number }>;
    return Number(rows[0]!.pid);
  };

  /**
   * Block until ONE of the two named backends is waiting on a lock the OTHER holds.
   *
   * Earlier revisions polled `pg_stat_activity` for any backend blocked while running a query whose
   * TEXT matched a pattern. That is not scoped to the test: this file's suites share a database with
   * every other integration file, and `%INSERT INTO "WorkerAllocation"%` matches a sibling suite's
   * insert on a different project just as well as the two sessions under test — so the barrier could
   * open on someone else's contention, before these sessions had reached the state being probed.
   *
   * `pg_blocking_pids` answers the exact question instead: is THIS pid waiting for a lock held by
   * THAT pid. No text, no other project, no other suite. The check is symmetric because which of two
   * concurrently-started sessions wins the project lock is not determined — only that one of them
   * blocks the other, which is the serialization being proven. The CONDITION gates progress; the
   * interval is only the observation cadence, and the poll runs on the app's own client, a third
   * connection that is never one of the racing pair.
   */
  const waitUntilOneBlocksTheOther = async (pidA: number, pidB: number): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ blocked: boolean }>>(
        `SELECT ($1::int = ANY(pg_blocking_pids($2::int)))
             OR ($2::int = ANY(pg_blocking_pids($1::int))) AS blocked`,
        pidA, pidB,
      );
      if (rows[0]?.blocked === true) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: neither backend ${pidA} nor ${pidB} ever blocked on a lock held by the other`);
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
    // the accountable human must have STANDING — round 7 scoped this to the row's project explicitly rather than letting the
    // revocation FK fail opaquely, and never fabricates one
    await expect(repairs.repair(plan({ revokedById: 'no-such-user' }))).rejects.toThrow(/has no attendance-revoke standing on project/);
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

    // §P4T3C3 is the operator-facing half of the quarantine exit. RED at 6d17949: it told the
    // operator to "revoke it, record the incident" for a forged marker — a row that is ALREADY
    // revoked, so the instruction is unperformable and the finding stays forever. The section must
    // name the op that actually clears it, and must still forbid hand-writing evidence.
    const c3 = runbook.slice(runbook.indexOf('## §P4T3C3'), runbook.indexOf('## 1. Drain all OLD'));
    expect(c3.length).toBeGreaterThan(0);
    expect(c3).toContain('f1-quarantine-forged-marker');
    expect(c3).toMatch(/Do not.*hand-write a `T3CRepairAction` row/i);
    expect(c3).not.toMatch(/DELETE\s+FROM\s+"LabourAttendance"/i);
  });

  // ══ FINDING 2 — Activities owns the lock AND the head, indivisibly ═══════════════════════════

  it('2a: `labourRequirementHead` ACQUIRES the requirement root lock — a holder blocks it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const { requirementId } = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-20', personShiftQty: 1 }]);

    const release = gate();
    const held = gate();     // A → test: I own the root row now
    const readerPid = gate(); // B → test: my backend pid is recorded
    let pidA = 0;
    let pidB = 0;
    // Session A holds the requirement ROOT row exactly as `RequirementsService.revise/cancel` do.
    const holder = raceA.$transaction(async (tx) => {
      pidA = await backendPid(tx);
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "ActivityRequirementRoot" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`,
        projectId, requirementId,
      );
      // The lock is HELD once that statement returns — signalled directly rather than inferred by
      // polling `pg_locks` for any `RowExclusiveLock` on the table, which a sibling suite writing a
      // different project's requirement would satisfy just as well.
      held.open();
      await release.promise;
      return 'held';
    }, { timeout: 30_000 });
    await held.promise;

    // Session B asks the PARTICIPANT for the head. RED at f6af800: the participant took no lock, so
    // this returned immediately while A still held the root — Labour's own raw SELECT was the only
    // thing serializing, which is exactly the boundary violation being removed. GREEN: it blocks.
    let resolved = false;
    const reader = raceB.$transaction(async (tx) => {
      pidB = await backendPid(tx);
      readerPid.open();
      const head = await participant.labourRequirementHead(tx, { projectId, requirementId });
      resolved = true;
      return head;
    }, { timeout: 30_000 });
    const settled = reflect(reader);

    await readerPid.promise;
    await waitUntilOneBlocksTheOther(pidA, pidB);
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
    const pidsKnown = gate();
    const go = gate();
    let pidA = 0;
    let pidB = 0;
    let pidCount = 0;
    const announce = () => { if (++pidCount === 2) pidsKnown.open(); };

    // Session A: requirement A then requirement B. Session B: requirement B then requirement A.
    const sessionA = raceA.$transaction(async (tx) => {
      pidA = await backendPid(tx);
      announce();
      await insert(tx, `raw-a1-${seq++}`, w1, reqA.requirementId, reqA.revision, actA, cmdA);
      aReady.open();
      await go.promise;
      await insert(tx, `raw-a2-${seq++}`, w2, reqB.requirementId, reqB.revision, actB, cmdA);
      return 'A';
    }, { timeout: 30_000 });

    const sessionB = raceB.$transaction(async (tx) => {
      pidB = await backendPid(tx);
      announce();
      await insert(tx, `raw-b1-${seq++}`, w3, reqB.requirementId, reqB.revision, actB, cmdB);
      bReady.open();
      await go.promise;
      await insert(tx, `raw-b2-${seq++}`, w4, reqA.requirementId, reqA.revision, actA, cmdB);
      return 'B';
    }, { timeout: 30_000 });

    const settledA = reflect(sessionA);
    const settledB = reflect(sessionB);
    await pidsKnown.promise;

    // RED at f6af800: BOTH first inserts succeed (each session holds one root), so both gates open,
    // the second inserts cross, and PostgreSQL aborts one with 40P01 `deadlock detected`.
    // GREEN: the project readiness advisory lock is taken by the FIRST trigger, so the loser's very
    // first insert blocks behind the winner's — its ready gate never opens until the winner commits.
    // The race is resolved before either session can hold a root the other wants.
    //
    // The barrier names the two backends rather than matching insert TEXT: this database is shared
    // with every other integration suite, so `%INSERT INTO "WorkerAllocation"%` would also match a
    // sibling suite's insert on a different project and could open `go` before these two sessions had
    // contended at all — turning the GREEN branch into an accident rather than a proof.
    // The loser of this race keeps polling; its eventual timeout must not surface as an unhandled
    // rejection when the RED branch (both gates open) settles first.
    const barrier = waitUntilOneBlocksTheOther(pidA, pidB);
    barrier.catch(() => undefined);
    await Promise.race([Promise.all([aReady.promise, bReady.promise]), barrier]);
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
  /** `live: true` writes the marker WITHOUT a revocation — the state a forger can only reach on a
   *  database where `20270225000000` has not applied, and the one `f1-quarantine-forged-marker` must
   *  be able to finish. The CHECK is then re-added NOT VALID (it cannot be validated over a live
   *  marked row); the caller validates it once the quarantine has revoked the row, which is the
   *  deploy actually becoming possible. */
  const forgedMarkedMuster = async (
    projectId: string, workerId: string, marker: string, civilDate = '2026-09-01',
    opts: { live?: boolean } = {},
  ): Promise<string> => {
    const commandId = await rawCommand(projectId, 'labour.attendance.record');
    const id = `att-forged-marker-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "LabourAttendance_reserved_marker" ON "LabourAttendance"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT IF EXISTS "LabourAttendance_marker_is_revoked"`);
    try {
      await t.prisma.$executeRawUnsafe(
        opts.live
          ? `INSERT INTO "LabourAttendance"
               ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId")
             VALUES ($1,$2,$3,$4::date,'day',$5, now(), $6, $7)`
          : `INSERT INTO "LabourAttendance"
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
               OR "revokedAt" IS NOT NULL)${opts.live ? ' NOT VALID' : ''}`,
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

  it('R1: a forged marker HAS an exit — quarantine files it, clears the finding, and invents nothing', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const forgedText = `${T3C_INVALID_LEGACY_PREFIX} repair=${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}; supervisor said he was here`;
    const forged = await forgedMarkedMuster(projectId, workerId, forgedText, '2026-09-10');
    const before = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(before.revokedAt, 'the forger already filled in the revocation triple').not.toBeNull();

    // RED at 6d17949: this state had NO exit. `f1-mark-invalid-legacy` accepts only blank LIVE rows,
    // the row is already revoked so the application revoke is a no-op on a terminal record, and no
    // attendance row may be deleted — so `F1.marker` could never clear and 20270225 could never
    // deploy. The repair rejected the plan outright with `unknown repair op`.
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'incident 2026-09: marker claimed a repair that never ran',
      actions: [{
        finding: 'F1.marker',
        op: 'f1-quarantine-forged-marker',
        id: forged,
        // the round-7 coherence rule: on a pre-revoked row the plan must NAME the revoker actually
        // on the row — that attribution is preserved verbatim, never restamped
        revokedById: f.memberUser.id,
        revokeReason: 'no repair evidence exists for the id this marker embeds',
      }],
    });
    expect(outcome.applied).toBe(1);
    expect((await repairs.preflight()).clean, 'the finding is cleared, so the migration can deploy').toBe(true);

    // The row now points at evidence that GENUINELY exists — the one thing its old marker faked.
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(after.manualReason).toContain('QUARANTINED FORGERY');
    expect(after.manualReason).toContain(`repair=${outcome.repairId}`);
    // The WHOLE pre-existing revocation triple is KEPT, never restamped (round-7 finding G):
    // whatever the forger recorded about this row's revocation stays exactly as found — the
    // operator's own words live in the append-only evidence detail instead.
    expect(after.revokedById).toBe(before.revokedById);
    expect(after.revokeReason).toBe(before.revokeReason);
    expect(after.revokedAt?.toISOString()).toBe(before.revokedAt?.toISOString());

    // …and the forgery itself is preserved verbatim, in two places, so the incident stays readable.
    const evidence = await t.prisma.$queryRawUnsafe<Array<{ finding: string; op: string; beforeImage: Record<string, unknown>; detail: Record<string, unknown> }>>(
      `SELECT "finding", "op", "beforeImage", "detail" FROM "T3CRepairAction" WHERE "rowId" = $1`, forged,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.finding).toBe('F1.marker');
    expect(evidence[0]!.op).toBe('f1-quarantine-forged-marker');
    expect(evidence[0]!.beforeImage['manualReason'], 'the before-image is the forgery, not a pretence that it was blank').toBe(forgedText);
    expect(evidence[0]!.detail['forgedManualReason']).toBe(forgedText);
    // the presence claim, its recorder and its timestamps are all still queryable
    expect(evidence[0]!.beforeImage['recordedById']).toBe(f.memberUser.id);
    expect(evidence[0]!.beforeImage['workerId']).toBe(workerId);
  });

  it('R1: quarantine REFUSES a genuine repair and an unmarked row — the accusation is never fabricated', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);

    // A REAL audited repair. Its marker is truthful; quarantining it would replace an accurate
    // record with a false accusation of forgery, which is the mirror image of the fault being fixed.
    const genuine = await legacyBlankMuster(projectId, workerId, '2026-09-11');
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'genuine repair',
      actions: [{ op: 'f1-mark-invalid-legacy', id: genuine, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in',
        reason: 'mistaken quarantine',
        actions: [{ op: 'f1-quarantine-forged-marker', id: genuine, revokedById: f.ownerUser.id, revokeReason: 'assumed forged' }],
      }),
    ).rejects.toThrow(/already has repair evidence[\s\S]*not a forgery/i);

    // An ordinary muster carries no marker at all, so it is not this op's business either.
    const healthy = await capacity.recordAttendance(
      projectId,
      { workerId: await onboardWorker(projectId), civilDate: '2026-09-12', shift: 'day', manualReason: 'device battery dead at gate' },
      pmc(projectId),
    );
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in',
        reason: 'mistaken quarantine',
        actions: [{ op: 'f1-quarantine-forged-marker', id: healthy.id, revokedById: f.ownerUser.id, revokeReason: 'assumed forged' }],
      }),
    ).rejects.toThrow(/does not carry the reserved marker/i);

    // Both refusals rolled back completely: the genuine repair's marker and the healthy row survive.
    const still = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: genuine } });
    expect(still.manualReason).not.toContain('QUARANTINED');
    const untouched = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(untouched.manualReason).toBe('device battery dead at gate');
    expect(untouched.revokedAt).toBeNull();
    expect((await repairs.preflight()).clean).toBe(true);
  });

  // ══ ROUND-4 RE-REVIEW — no diagnosed state may be left without an exit, and no gap may be left ══

  it('R4-A: the diagnostic and BOTH LabourAttendance seals are ONE locked statement', async () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma/migrations/20270225000000_phase4_t3_correction3/migration.sql'),
      'utf8',
    );
    // RED at 02bbeff: the diagnostic was its own `DO $$ … END $$;` and each seal was another. This
    // migration has no transaction wrapper, so every one of those boundaries is a COMMIT — leaving a
    // real interval after the check passed and before the marker prefix was reserved. A concurrent
    // direct writer could insert a PRE-REVOKED marked row in it; the CHECK added next accepts it (it
    // is revoked), nothing re-diagnoses, and the migration succeeds over forged repair provenance.
    const blocks = sql.split(/^DO \$\$/m).slice(1).map((b) => b.split(/^END \$\$;/m)[0]!);
    const sealed = blocks.filter((b) => b.includes('phase4 t3 correction3 finding 1'));
    expect(sealed, 'exactly one block raises the finding-1 diagnostic').toHaveLength(1);
    const block = sealed[0]!;
    // it takes the table out of every other writer's hands BEFORE it reads…
    expect(block.indexOf('LOCK TABLE "LabourAttendance" IN ACCESS EXCLUSIVE MODE')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('LOCK TABLE "LabourAttendance"')).toBeLessThan(block.indexOf('phase4 t3 correction3 finding 1'));
    // …and installs both seals while still holding it, in the same statement, so there is no gap.
    expect(block).toContain('CREATE TRIGGER "LabourAttendance_reserved_marker"');
    expect(block).toContain('ADD CONSTRAINT "LabourAttendance_marker_is_revoked"');
    // and NO other statement in the file creates either — a second copy would reopen the window.
    expect(sql.match(/CREATE TRIGGER "LabourAttendance_reserved_marker"/g)).toHaveLength(1);
    expect(sql.match(/ADD CONSTRAINT "LabourAttendance_marker_is_revoked"/g)).toHaveLength(1);
  });

  it('R4-B: an ALREADY-REVOKED blank muster is repairable, and its original revocation survives', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    // A legacy muster whose blank reason was revoked BEFORE correction 2 shipped. `F1.blank` counts
    // it — correctly, since `20270220`'s CHECK does too — so the constraint cannot be installed over
    // it and the deploy is blocked until it is repaired.
    const id = await legacyBlankMuster(projectId, workerId, '2026-09-20', {
      at: '2026-06-01T09:00:00Z', byId: f.memberUser.id, reason: 'raised on the wrong worker',
    });
    const before = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id } });
    expect(before.revokedAt).not.toBeNull();
    expect((await repairs.preflight()).findings.find((x) => x.code === 'F1.blank')!.count).toBe(1);

    // RED at 02bbeff: `f1-mark-invalid-legacy` refused this row as "already revoked — a revoked
    // muster is terminal", and `f1-quarantine-forged-marker` only accepts rows that already carry the
    // marker. Neither op could clear F1.blank, so nothing but an undocumented trigger bypass could
    // ever unblock the deploy.
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'retire a pre-correction-2 blank muster that was already revoked',
      // The plan must NAME the revoker already on the row: this path preserves that attribution, so
      // supplying a different id would record something the database does not hold (see R5-D).
      actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id, revokedById: f.memberUser.id, revokeReason: 'retired; original revocation left intact' }],
    });
    expect((await repairs.preflight()).clean).toBe(true);

    // The marker is written, and the ORIGINAL revocation is untouched — who revoked it, when, and
    // why they said so is real history and the repair does not get to restamp it.
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id } });
    expect(after.manualReason).toContain(`repair=${outcome.repairId}`);
    expect(after.revokedAt?.toISOString()).toBe(before.revokedAt?.toISOString());
    expect(after.revokedById).toBe(f.memberUser.id);
    expect(after.revokeReason).toBe('raised on the wrong worker');

    const evidence = await t.prisma.$queryRawUnsafe<Array<{ beforeImage: Record<string, unknown>; detail: Record<string, unknown> }>>(
      `SELECT "beforeImage", "detail" FROM "T3CRepairAction" WHERE "rowId" = $1`, id,
    );
    expect(evidence[0]!.beforeImage['manualReason']).toBe('   ');
    expect(evidence[0]!.beforeImage['revokedAt']).not.toBeNull();
    // `revokedById`/`revokeReason` in the evidence describe what the ROW actually holds — the
    // preserved original — and the operator's own words are recorded separately as the repair note.
    // Anything else would have the evidence assert an attribution the database never took.
    expect(evidence[0]!.detail['revocationPreserved']).toBe(true);
    expect(evidence[0]!.detail['revokedById']).toBe(f.memberUser.id);
    expect(evidence[0]!.detail['revokeReason']).toBe('raised on the wrong worker');
    expect(evidence[0]!.detail['repairNote']).toBe('retired; original revocation left intact');
  });

  it('R4-C: repair evidence cannot carry blank attribution — a seal that names nobody is not evidence', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const id = await legacyBlankMuster(projectId, workerId, '2026-09-21');
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // RED at 02bbeff: `operator`/`reason` were NOT NULL and nothing more, and NOT NULL is satisfied
    // by a space. A raw insert could store attribution naming nobody — and because the table is
    // append-only, that emptiness is permanent.
    for (const [operator, reason] of [['   ', 'real reason'], ['ops@vitan.in', '\t\n'], [' ', ' ']] as const) {
      await expect(
        forgedInsert(
          '11111111-1111-1111-1111-111111111111',
          `INSERT INTO "T3CRepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage")
           VALUES ('11111111-1111-1111-1111-111111111111',$1,$2,'F1.blank','f1-mark-invalid-legacy','LabourAttendance',$3,'{}'::jsonb)`,
          operator, reason, id,
        ),
        `operator=${JSON.stringify(operator)} reason=${JSON.stringify(reason)}`,
      ).rejects.toThrow(/T3CRepairAction_attribution_non_blank/);
    }
    // and the CHECK really constrains the rows present, not merely future ones
    const validated = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname = 'T3CRepairAction_attribution_non_blank' AND convalidated`,
    );
    expect(Number(validated[0]!.n)).toBe(1);
  });

  it('R4-D: a marker backed by MALFORMED evidence is diagnosed AND quarantinable — report and repair agree', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    // one real repair, so the evidence table exists
    const seedRow = await legacyBlankMuster(projectId, workerId, '2026-09-22');
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seedRow, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // A marker citing an evidence row that EXISTS by metadata but whose before-image is empty. The
    // diagnostic rejects it — an appended action carrying `{}` proves nothing about the original —
    // so the row is a finding.
    const fakeRepairId = '22222222-2222-2222-2222-222222222222';
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId), `${T3C_INVALID_LEGACY_PREFIX} repair=${fakeRepairId}; minted`, '2026-09-23',
    );
    await forgedInsert(
      fakeRepairId,
      `INSERT INTO "T3CRepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage")
       VALUES ($1,'someone','something','F1.blank','f1-mark-invalid-legacy','LabourAttendance',$2,'{}'::jsonb)`,
      fakeRepairId, forged,
    );
    const report = await repairs.preflight();
    expect(report.findings.find((x) => x.code === 'F1.marker')!.samples.map((s) => s['id'])).toContain(forged);

    // RED at 02bbeff: the quarantine's refusal was a metadata-only `count(*)` on (rowId, repairId),
    // so it saw that row and declined — "it is a real audited repair, not a forgery". The evidence is
    // append-only and the attendance row is already revoked, so nothing could clear the finding and
    // the deploy stayed blocked. Report and repair must ask the identical question.
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'incident: marker cites evidence with no before-image',
      actions: [{ finding: 'F1.marker', op: 'f1-quarantine-forged-marker', id: forged, revokedById: f.memberUser.id, revokeReason: 'cited evidence carries no before-image' }],
    });
    expect((await repairs.preflight()).clean).toBe(true);
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(after.manualReason).toContain('QUARANTINED FORGERY');
    expect(after.manualReason).toContain(`repair=${outcome.repairId}`);
    // the malformed row is still there — nothing is deleted, the incident stays readable
    const kept = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "T3CRepairAction" WHERE "repairId" = $1`, fakeRepairId,
    );
    expect(Number(kept[0]!.n)).toBe(1);
  });

  // ══ ROUND-5 RE-REVIEW — the evidence must be REAL evidence, and no seal may be trusted by name ══

  /**
   * A COMPLETE, CORRESPONDING before-image for one attendance row, built SERVER-side with the same
   * canonical UTC timestamp rendering `captureBefore` uses. `manualReason` is overridden to the
   * pre-repair shape the evidence claims (blank for a retirement, the marker for a quarantine) —
   * client-side `Date.toISOString()` cannot be used because PostgreSQL keeps microseconds and JS
   * keeps milliseconds, so only the database can render its own value canonically.
   */
  const completeBeforeImage = async (id: string, manualReason: string): Promise<Record<string, unknown>> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ img: Record<string, unknown> }>>(
      // The SAME canonical rendering the predicate uses (t3cRenderTs): the NAIVE stored value,
      // no zone arithmetic — round 3h corrected the AT TIME ZONE 'UTC' form, which rendered in the
      // session TimeZone and made honest evidence session-dependent.
      `SELECT to_jsonb(t) || jsonb_build_object(
          'recordedAt', ${t3cRenderTs('t."recordedAt"')},
          'revokedAt',  ${t3cRenderTs('t."revokedAt"')},
          'manualReason', $2::text
        ) AS img FROM "LabourAttendance" t WHERE t."id" = $1`,
      id, manualReason,
    );
    return rows[0]!.img;
  };

  /** Insert one `T3CRepairAction` row from OUTSIDE the repair engine — see {@link forgedInsert} for
   *  why that now requires impersonating the repair protocol, and what the seal does and does not
   *  claim. These probes exist to show that a correctly-shaped row is still not provenance. */
  const rawEvidence = async (
    repairId: string, rowId: string, beforeImage: string,
    operator = 'someone', reason = 'something', op = 'f1-mark-invalid-legacy',
  ): Promise<void> => {
    await forgedInsert(
      repairId,
      `INSERT INTO "T3CRepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage")
       VALUES ($1,$2,$3,'F1.blank',$4,'LabourAttendance',$5,$6::jsonb)`,
      repairId, operator, reason, op, rowId, beforeImage,
    );
  };

  it('R5-A: the diagnostic LOCKS the evidence table it reads, and seals it in the same statement', async () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma/migrations/20270225000000_phase4_t3_correction3/migration.sql'),
      'utf8',
    );
    const block = sql.split(/^DO \$\$/m).slice(1).map((b) => b.split(/^END \$\$;/m)[0]!)
      .find((b) => b.includes('phase4 t3 correction3 finding 1'))!;
    // RED at 03d0e0f: only LabourAttendance was locked while the diagnostic READ T3CRepairAction,
    // and the evidence seal lived in a later statement — so a DELETE committing in between left the
    // migration sealing an emptied table and succeeding over a marker whose before-image was gone.
    expect(block).toContain('LOCK TABLE "T3CRepairAction" IN ACCESS EXCLUSIVE MODE');
    expect(block.indexOf('LOCK TABLE "T3CRepairAction"')).toBeLessThan(block.indexOf('phase4 t3 correction3 finding 1'));
    expect(block).toContain('CREATE TRIGGER "T3CRepairAction_append_only"');
    expect(block).toContain('CREATE TRIGGER "T3CRepairAction_no_truncate"');
    expect(block).toContain('ADD CONSTRAINT "T3CRepairAction_attribution_non_blank"');
    for (const object of ['T3CRepairAction_append_only', 'T3CRepairAction_no_truncate']) {
      expect(sql.match(new RegExp(`CREATE TRIGGER "${object}"`, 'g')), object).toHaveLength(1);
    }
  });

  it('R5-B: a before-image that is not the row it claims to preserve is NOT evidence', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-10-01');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // RED at 03d0e0f: the shape check demanded only `id` + a blank `manualReason`, so this
    // TWO-FIELD action passed. A direct writer could mint it, cite its repair id from a pre-revoked
    // marker, and have the preflight AND the migration bless provenance for an original row that was
    // never recorded at all.
    const fake = '33333333-3333-3333-3333-333333333333';
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId), `${T3C_INVALID_LEGACY_PREFIX} repair=${fake}; minted`, '2026-10-02',
    );
    await rawEvidence(fake, forged, JSON.stringify({ id: forged, manualReason: '   ' }));

    const report = await repairs.preflight();
    const marker = report.findings.find((x) => x.code === 'F1.marker')!;
    expect(marker.samples.map((s) => s['id'])).toContain(forged);
    // …and the sample says what to DO about it, from the same predicate (see R5-E)
    expect(marker.samples.find((s) => s['id'] === forged)!['exit']).toBe('quarantine');
  });

  it('R5-C: a COMPLETE before-image that contradicts the row is NOT evidence either', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-10-03');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    const otherWorker = await onboardWorker(projectId);
    const fake = '44444444-4444-4444-4444-444444444444';
    const forged = await forgedMarkedMuster(
      projectId, otherWorker, `${T3C_INVALID_LEGACY_PREFIX} repair=${fake}; complete but wrong`, '2026-10-04',
    );
    const row = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    // Every key present, and all but ONE correct: the recorded worker is someone else. Correspondence
    // is checkable precisely because `LabourAttendance_append_only` freezes these columns.
    await rawEvidence(fake, forged, JSON.stringify({
      id: forged, projectId, workerId: 'some-other-worker', civilDate: '2026-10-04', shift: 'day',
      deviceId: null, evidenceMediaId: null, manualReason: '   ',
      recordedAt: row.recordedAt.toISOString(), recordedById: row.recordedById, sourceCommandId: row.sourceCommandId,
    }));
    expect((await repairs.preflight()).findings.find((x) => x.code === 'F1.marker')!.samples.map((s) => s['id'])).toContain(forged);

    // and a COMPLETE, CORRESPONDING before-image is accepted — the rule is precise, not merely strict
    const good = '55555555-5555-5555-5555-555555555555';
    const honest = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId), `${T3C_INVALID_LEGACY_PREFIX} repair=${good}; honest`, '2026-10-05',
    );
    // Round 7 widened completeness: canonical-UTC recordedAt by VALUE plus the full revocation
    // triple. Only the database can render its own microsecond timestamps canonically.
    await rawEvidence(good, honest, JSON.stringify(await completeBeforeImage(honest, '   ')));
    const after = await repairs.preflight();
    expect(after.findings.find((x) => x.code === 'F1.marker')!.samples.map((s) => s['id'])).not.toContain(honest);
  });

  it('R5-D: the preserved-revocation path cannot record an attribution nothing validated', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const id = await legacyBlankMuster(projectId, workerId, '2026-10-06', {
      at: '2026-06-01T09:00:00Z', byId: f.memberUser.id, reason: 'raised on the wrong worker',
    });

    // RED at 03d0e0f: `revokedById` is NOT written on this path (the COALESCE keeps the original), so
    // the FK never sees it — yet it was recorded in append-only evidence under a contract saying it
    // is validated. A nonexistent user sailed through, covered for by the row's own valid key.
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in', reason: 'retire',
        actions: [{ op: 'f1-mark-invalid-legacy', id, revokedById: 'no-such-user', revokeReason: 'retired' }],
      }),
    ).rejects.toThrow(/already revoked by[\s\S]*must name the same revokedById/i);

    // Naming the actual revoker succeeds, and the evidence records the REAL preserved attribution.
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'retire',
      actions: [{ op: 'f1-mark-invalid-legacy', id, revokedById: f.memberUser.id, revokeReason: 'retired; original revocation intact' }],
    });
    const evidence = await t.prisma.$queryRawUnsafe<Array<{ detail: Record<string, unknown> }>>(
      `SELECT "detail" FROM "T3CRepairAction" WHERE "rowId" = $1`, id,
    );
    expect(evidence[0]!.detail['revocationPreserved']).toBe(true);
    expect(evidence[0]!.detail['revokedById']).toBe(f.memberUser.id);
    expect(evidence[0]!.detail['revokeReason']).toBe('raised on the wrong worker');   // the ORIGINAL
    expect(evidence[0]!.detail['repairNote']).toBe('retired; original revocation intact'); // the operator's
  });

  it('R5-E: a DISABLED or decoy seal is refused — a matching name is not enforcement', async () => {
    // The migration's own guards. RED at 03d0e0f: they tested `NOT EXISTS (… tgname = …)` only, so a
    // disabled trigger or one bound to another function made the migration skip creation and record
    // itself applied over an unprotected table.
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma/migrations/20270225000000_phase4_t3_correction3/migration.sql'),
      'utf8',
    );
    // Round 7 strengthened this: a guard that checks the ENABLED flag and the bound FUNCTION still
    // accepts a trigger declared for the wrong EVENTS, so each guard must also test `tgtype`.
    // Round 3h strengthened it AGAIN: EXACT tgtype inequality (`tg.tgtype <>`), not a bitmask — a
    // require-bits test accepted extra event bits, and on an unconditionally-raising function an
    // extra bit blocks legitimate operations while the guard reads as sealed.
    for (const fn of [
      'phase4_t3c3_attendance_reserved_marker',
      'phase4_t3c3_allocation_project_lock',
      'phase4_t3c_repair_action_append_only',
      'phase4_t3c_repair_action_no_truncate',
      'phase4_t3c_repair_action_path',
    ]) {
      const at = sql.indexOf(`tgfoid::regproc::text <> '${fn}'`);
      expect(at, `${fn}: no ELSIF guard on the bound function`).toBeGreaterThan(-1);
      expect(sql.slice(at - 80, at + 700), `${fn}: the guard must test the trigger's EXACT events`).toMatch(
        /tg\.tgenabled <> 'O'[\s\S]*tg\.tgtype <>/,
      );
    }
    expect(sql, 'the CHECK must be validated, not merely present').toContain('NOT con.convalidated');
    // and the post-conditions restate it independently, so losing a guard fails the deploy
    for (const seal of ['LabourAttendance_reserved_marker', 'WorkerAllocation_00_project_lock', 'LabourAttendance_marker_is_revoked']) {
      expect(sql.slice(sql.indexOf('══ POST-CONDITIONS')), seal).toContain(seal);
    }

    // The live database really is in the enforcing state the post-conditions demand.
    const seals = await repairs.correctionSeals();
    expect(seals.installed, `missing: ${seals.missing.join(', ')}`).toBe(true);
  });

  it('R5-F: legacy blank attribution does NOT block repairs or deploys — it is recorded, not fatal', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-10-07');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // A legacy malformed action that NO marker cites — the orphan case. It cannot be edited away
    // (append-only) and the quarantine would not remove it.
    // dropping the evidence constraint is a destructive ALTER — the round-3h guard refuses it, so
    // simulating the legacy state first requires the separate loud act of removing the guard (the
    // next repair re-creates both).
    await t.prisma.$executeRawUnsafe(`DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_alter_guard`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "T3CRepairAction" DROP CONSTRAINT "T3CRepairAction_attribution_non_blank"`);
    await rawEvidence('66666666-6666-6666-6666-666666666666', 'att-orphan', '{}', '   ', '  ');

    // RED at 03d0e0f: the seal block RAISED here, so every subsequent repair aborted before any
    // action ran and the deploy was blocked forever with no F1.marker to explain why.
    const next = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-10-08');
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in', reason: 'a repair still works with a legacy malformed action present',
      actions: [{ op: 'f1-mark-invalid-legacy', id: next, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    expect(outcome.applied).toBe(1);

    // The rule is installed NOT VALID: the legacy row survives, and a NEW blank insert is refused.
    const con = await t.prisma.$queryRawUnsafe<Array<{ convalidated: boolean }>>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'T3CRepairAction_attribution_non_blank'`,
    );
    expect(con[0]!.convalidated).toBe(false);
    await expect(
      rawEvidence('77777777-7777-7777-7777-777777777777', 'att-x', '{}', '  ', 'real'),
    ).rejects.toThrow(/T3CRepairAction_attribution_non_blank/);
    const orphan = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "T3CRepairAction" WHERE "rowId" = 'att-orphan'`,
    );
    expect(Number(orphan[0]!.n), 'the legacy row is preserved, not erased').toBe(1);
  });

  // ══ ROUND-6 RE-REVIEW — no predicate may THROW, and no seal may be trusted by name ═══════════

  it('R6-A: a malformed before-image value is REJECTED, not an error — the row stays quarantinable', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-11-01');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    const fake = '88888888-8888-8888-8888-888888888888';
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId), `${T3C_INVALID_LEGACY_PREFIX} repair=${fake}; junk dates`, '2026-11-02',
    );
    const row = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    // Complete, but with garbage where a date belongs. RED at 12190c0: the predicate cast this with
    // `::date`, so PostgreSQL raised a conversion error — the PREFLIGHT exited opaquely AND the
    // quarantine, which asks the same question, failed identically. The row could never be filed and
    // the deploy was blocked with no exit at all.
    await rawEvidence(fake, forged, JSON.stringify({
      id: forged, projectId, workerId: row.workerId, civilDate: 'not-a-date', shift: 'day',
      deviceId: null, evidenceMediaId: null, manualReason: '   ',
      recordedAt: 'also-not-a-date', recordedById: row.recordedById, sourceCommandId: row.sourceCommandId,
    }));

    const report = await repairs.preflight();   // must not throw
    const marker = report.findings.find((x) => x.code === 'F1.marker')!;
    expect(marker.samples.map((s) => s['id'])).toContain(forged);
    expect(marker.samples.find((s) => s['id'] === forged)!['exit']).toBe('quarantine');

    // …and the exit actually works, which is the whole point
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'incident: cited evidence carries junk in place of a civil date',
      actions: [{ op: 'f1-quarantine-forged-marker', id: forged, revokedById: f.memberUser.id, revokeReason: 'before-image is not this row' }],
    });
    expect((await repairs.preflight()).clean).toBe(true);
  });

  it('R6-B: a same-named CHECK that enforces nothing is NOT a seal', async () => {
    // RED at 12190c0: `correctionSeals` accepted any validated constraint with the right name, so a
    // `CHECK (TRUE)` decoy reported the database as fully sealed — and on the P3005 baseline path
    // `migrate.sh` would then resolve correction 3 as applied without ever running its real guard.
    expect((await repairs.correctionSeals()).installed).toBe(true);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked" CHECK (TRUE)`,
    );
    try {
      const seals = await repairs.correctionSeals();
      expect(seals.installed).toBe(false);
      expect(seals.missing).toContain('LabourAttendance_marker_is_revoked');
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`);
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
           CHECK ("manualReason" IS NULL
               OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
               OR "revokedAt" IS NOT NULL)`,
      );
    }
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R6-C: a DECOY evidence trigger aborts the repair — it never commits over an unsealed table', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-11-03');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // A legacy table carrying an ENABLED same-named NO-OP trigger. RED at 12190c0: the create-guard
    // skipped on the name and `assertTriggersEnabled` checked only name + enabled, so the repair
    // committed while the before-image it had just written stayed freely updateable.
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "T3CRepairAction_append_only" ON "T3CRepairAction"`);
    await t.prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION phase4_t3c_decoy() RETURNS trigger AS $fn$ BEGIN RETURN NEW; END; $fn$ LANGUAGE plpgsql`,
    );
    await t.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "T3CRepairAction_append_only" BEFORE UPDATE OR DELETE ON "T3CRepairAction"
         FOR EACH ROW EXECUTE FUNCTION phase4_t3c_decoy()`,
    );

    const next = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-11-04');
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in', reason: 'repair over a decoy-sealed evidence table',
        actions: [{ op: 'f1-mark-invalid-legacy', id: next, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
      }),
    ).rejects.toThrow(/does not seal the evidence|not enforcing/i);

    // the refusal rolled everything back — the muster is untouched, still blank, still a finding
    const untouched = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: next } });
    expect(untouched.manualReason).toBe('   ');
    expect(untouched.revokedAt).toBeNull();
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
    // TRUNCATE is the hole a row-level trigger cannot cover: PostgreSQL fires BEFORE UPDATE OR DELETE
    // per row and never for TRUNCATE, which is a separate statement-level event. Without its own
    // trigger, one statement erases every before-image the attendance markers point at.
    expect(outcome.triggersRestored).toContain('T3CRepairAction_no_truncate');
    await expect(
      t.prisma.$executeRawUnsafe(`TRUNCATE TABLE "T3CRepairAction"`),
    ).rejects.toThrow(/append-only/i);

    const still = await t.prisma.$queryRawUnsafe<Array<{ operator: string; beforeImage: Record<string, unknown> }>>(
      `SELECT "operator", "beforeImage" FROM "T3CRepairAction" WHERE "rowId" = $1`, id,
    );
    expect(still).toHaveLength(1);
    expect(still[0]!.operator).toBe('ops@vitan.in');
    expect(still[0]!.beforeImage['manualReason']).toBe('   ');
  });

  it('R6: the repair never reads the Users table — identity is the FK, standing is the membership rule', async () => {
    const repairSrc = readFileSync(join(__dirname, '..', '..', 'src/labour/t3c/t3c-repair.service.ts'), 'utf8');
    // RED at 0832c7d: `SELECT count(*) … FROM "User"` — a LEAF module synchronously reading an
    // Orgs-owned table. Being outside the runtime boundary scan did not make the crossing legitimate.
    //
    // Round 7 (finding L) added the STANDING check, and it deliberately does not reopen this: it
    // reads `Membership`/`Project`/`OrgMembership`, which are orgs-OWNED but not READ-ENCAPSULATED —
    // the same in-tx membership validation every module performs (`activities.service.ts` for
    // `responsibleId`, `drawings.service.ts` for recipients) and the same rule the boundary analyzer
    // enforces. `User` itself is still never read; existence remains the FK's question.
    expect(repairSrc).not.toMatch(/FROM\s+"User"/);
    expect(repairSrc).toContain('LabourAttendance_revokedBy_fkey');

    // A nonexistent user is refused by the standing check — BEFORE any write, with a scoped message
    // (an id that names nobody necessarily has no membership either).
    const projectId = await freshProject();
    await enableLabour(projectId);
    const blankId = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2026-09-05');
    await expect(
      repairs.repair({
        operator: 'ops@vitan.in',
        reason: 'attempted repair',
        actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: blankId, revokedById: 'no-such-user', revokeReason: 'r' }],
      }),
    ).rejects.toThrow(/has no attendance-revoke standing on project/);
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
    // Round 3h re-pin (identity seals) + round 3i re-pin: the correction-3 layer now also names the
    // head-live FUNCTION BODY it CREATE OR REPLACEs (its trigger is a prerequisite seal, but the
    // 20270225 body is this correction's own object).
    expect(seals.present.sort()).toEqual([
      'LabourAttendance_marker_is_revoked', 'LabourAttendance_reserved_marker', 'WorkerAllocation_00_project_lock',
      'phase4_t3c_allocation_head_live@20270225000000_phase4_t3_correction3',
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
  // ══ ROUND-7 RE-REVIEW — a seal is what it ENFORCES, not what it is called ═════════════════════
  //
  // Eight findings on `170bcd6`, and one shape behind most of them: an object was being accepted on
  // the strength of its NAME (plus, at best, its bound function), while what it actually decides —
  // which EVENTS it fires on, which rows its expression rejects — went unasked. Each probe below
  // plants the specific decoy the reviewer described and requires the checker to refuse it.

  /** Swap one live object for a decoy, run the assertion, and put the original back whatever
   *  happens. The DDL is executed on the app's own connection so `correctionSeals()` (which uses the
   *  app client, not a test transaction) sees it. */
  const withDecoy = async (install: string[], restore: string[], body: () => Promise<void>): Promise<void> => {
    for (const sql of install) await t.prisma.$executeRawUnsafe(sql);
    try {
      await body();
    } finally {
      for (const sql of restore) await t.prisma.$executeRawUnsafe(sql);
    }
  };

  /** Run the correction migration EXACTLY as `prisma migrate deploy` would — its own bytes, one
   *  statement at a time, stopping on the first error. Returns the process outcome. */
  /** `psql` rejects Prisma's `?schema=` query parameter, so the connection string is handed over
   *  without it; the password travels in PGPASSWORD rather than the URI. */
  const psqlUrl = (database?: string): string => {
    const u = new URL(process.env.DATABASE_URL!);
    u.search = '';
    if (database) u.pathname = `/${database}`;
    return u.toString();
  };
  const psqlEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    PGPASSWORD: decodeURIComponent(new URL(process.env.DATABASE_URL!).password),
  });

  const runMigration = (): { code: number; output: string } => {
    const file = join(__dirname, '..', '..', 'prisma/migrations/20270225000000_phase4_t3_correction3/migration.sql');
    const res = spawnSync('psql', [psqlUrl(), '-v', 'ON_ERROR_STOP=1', '-f', file], {
      encoding: 'utf8',
      env: psqlEnv(),
    });
    return { code: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };

  it('R7-A: a same-named, enabled, correctly-bound trigger declared for the WRONG EVENT is not a seal', async () => {
    // RED at 170bcd6: `correctionSeals()` asked for name + `tgenabled='O'` + bound function and
    // nothing else. This decoy satisfies all three and fires on UPDATE, so no INSERT ever reaches
    // it — and on the P3005 path `migrate.sh` would resolve correction 3 as applied over a database
    // whose reserved marker is completely unprotected.
    await withDecoy(
      [
        `DROP TRIGGER "LabourAttendance_reserved_marker" ON "LabourAttendance"`,
        `CREATE TRIGGER "LabourAttendance_reserved_marker" BEFORE UPDATE ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_attendance_reserved_marker()`,
      ],
      [
        `DROP TRIGGER "LabourAttendance_reserved_marker" ON "LabourAttendance"`,
        `CREATE TRIGGER "LabourAttendance_reserved_marker" BEFORE INSERT ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_attendance_reserved_marker()`,
      ],
      async () => {
        const seals = await repairs.correctionSeals();
        expect(seals.missing).toContain('LabourAttendance_reserved_marker');
        expect(seals.installed).toBe(false);
        // and the migration's own guard refuses to record itself applied over it
        const run = runMigration();
        expect(run.code).not.toBe(0);
        expect(run.output).toContain('does not enforce the reserved marker on INSERT');
      },
    );
    // restored: the seal reads as installed again and the migration re-applies cleanly
    expect((await repairs.correctionSeals()).installed).toBe(true);
    expect(runMigration().code).toBe(0);
  });

  it('R7-A2: the allocation project-lock trigger is held to the same event test', async () => {
    await withDecoy(
      [
        `DROP TRIGGER "WorkerAllocation_00_project_lock" ON "WorkerAllocation"`,
        `CREATE TRIGGER "WorkerAllocation_00_project_lock" BEFORE UPDATE ON "WorkerAllocation"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_allocation_project_lock()`,
      ],
      [
        `DROP TRIGGER "WorkerAllocation_00_project_lock" ON "WorkerAllocation"`,
        `CREATE TRIGGER "WorkerAllocation_00_project_lock" BEFORE INSERT ON "WorkerAllocation"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_allocation_project_lock()`,
      ],
      async () => {
        expect((await repairs.correctionSeals()).missing).toContain('WorkerAllocation_00_project_lock');
        expect(runMigration().output).toContain('does not take the project readiness lock');
      },
    );
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R7-D: the marker CHECK is verified by what it DECIDES, not by the words in it', async () => {
    // The reviewer's decoy: it contains BOTH tokens a substring test looks for — the reserved prefix
    // and `revokedAt` — is a validated check constraint, and permits every live marked row.
    // RED at 170bcd6: accepted by `correctionSeals()` AND by the migration's guard.
    const decoy = `CHECK ("manualReason" LIKE '${T3C_INVALID_LEGACY_PREFIX}%' OR "revokedAt" IS NULL)`;
    await withDecoy(
      [
        `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`,
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked" ${decoy}`,
      ],
      [
        `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`,
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
           CHECK ("manualReason" IS NULL
               OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
               OR "revokedAt" IS NOT NULL)`,
      ],
      async () => {
        expect((await repairs.correctionSeals()).missing).toContain('LabourAttendance_marker_is_revoked');
        expect(runMigration().output).toContain('is not the canonical marker rule');
      },
    );
    expect((await repairs.correctionSeals()).installed).toBe(true);

    // ROUND 3h: the WIDENED decoy — the canonical expression plus an OR arm no finite truth table
    // exercises. RED at cd7b30c: it passed all four behaviour probes while admitting a live marked
    // row ending in "permit"; only canonical-expression IDENTITY refuses it.
    await withDecoy(
      [
        `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`,
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
           CHECK ("manualReason" IS NULL
               OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
               OR "revokedAt" IS NOT NULL
               OR "manualReason" LIKE '%permit')`,
      ],
      [
        `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`,
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
           CHECK ("manualReason" IS NULL
               OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
               OR "revokedAt" IS NOT NULL)`,
      ],
      async () => {
        expect((await repairs.correctionSeals()).missing).toContain('LabourAttendance_marker_is_revoked');
        expect(runMigration().output).toContain('is not the canonical marker rule');
      },
    );
    expect((await repairs.correctionSeals()).installed).toBe(true);

    // `CHECK (TRUE)` — the degenerate decoy — fails the same way.
    await withDecoy(
      [
        `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`,
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked" CHECK (TRUE)`,
      ],
      [
        `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_marker_is_revoked"`,
        `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
           CHECK ("manualReason" IS NULL
               OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
               OR "revokedAt" IS NOT NULL)`,
      ],
      async () => {
        expect((await repairs.correctionSeals()).missing).toContain('LabourAttendance_marker_is_revoked');
      },
    );
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R7-E: repair evidence can only be written by the repair path', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-12-01');
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    const insert = (repairId: string) =>
      `INSERT INTO "T3CRepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage")
       VALUES ('${repairId}','ops@vitan.in','shaped exactly like a repair','F1.blank','f1-mark-invalid-legacy','LabourAttendance','${seed}','{}'::jsonb)`;

    // RED at 170bcd6: this succeeded. A direct writer could compose a complete, correctly-shaped
    // action naming a repair id of their choosing, then mint a pre-revoked marker citing it, and
    // both the preflight and the migration accepted the pair — correspondence was all they could ask.
    await expect(
      t.prisma.$executeRawUnsafe(insert('44444444-4444-4444-4444-444444444444')),
    ).rejects.toThrow(/written only by the audited repair path/);

    // a repair transaction that claims a DIFFERENT repair id is refused too — evidence is never
    // written on behalf of another repair
    await expect(
      forgedInsert('55555555-5555-5555-5555-555555555555', insert('44444444-4444-4444-4444-444444444444')),
    ).rejects.toThrow(/claims repair .* but this repair transaction is/);

    // a blank repair id names nothing
    await expect(forgedInsert('   ', insert('   '))).rejects.toThrow(/must name a repair/);

    // and the genuine path still writes: the repair above left its own evidence
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "T3CRepairAction" WHERE "repairId" = $1`, outcome.repairId,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('R7-F: the baseline answer covers the evidence seals whenever the evidence table exists', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-12-05');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    expect((await repairs.correctionSeals()).present).toEqual(
      expect.arrayContaining(['T3CRepairAction_append_only', 'T3CRepairAction_no_truncate', 'T3CRepairAction_repair_path_only', 'T3CRepairAction_attribution_non_blank']),
    );

    // RED at 170bcd6: the expected-object list stopped after the two triggers and the marker CHECK,
    // so a restored database whose append-only trigger was DISABLED still answered "sealed" — and
    // `migrate.sh` resolved correction 3 as applied instead of executing the block that seals the
    // evidence, leaving every trusted before-image updateable.
    await withDecoy(
      [
        // disabling an evidence trigger is a destructive ALTER — the round-3h guard refuses it
        // unless the operator first performs the separate, loud act of removing the guard
        `DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_alter_guard`,
        `ALTER TABLE "T3CRepairAction" DISABLE TRIGGER "T3CRepairAction_append_only"`,
      ],
      [`ALTER TABLE "T3CRepairAction" ENABLE TRIGGER "T3CRepairAction_append_only"`],
      async () => {
        const seals = await repairs.correctionSeals();
        expect(seals.missing).toContain('T3CRepairAction_append_only');
        expect(seals.installed).toBe(false);
      },
    );

    // an UPDATE-only append-only trigger is the subtler version of the same hole: enabled, bound to
    // the right function, and silent on DELETE.
    await withDecoy(
      [
        `DROP TRIGGER "T3CRepairAction_append_only" ON "T3CRepairAction"`,
        `CREATE TRIGGER "T3CRepairAction_append_only" BEFORE UPDATE ON "T3CRepairAction"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c_repair_action_append_only()`,
      ],
      [
        `DROP TRIGGER "T3CRepairAction_append_only" ON "T3CRepairAction"`,
        `CREATE TRIGGER "T3CRepairAction_append_only" BEFORE UPDATE OR DELETE ON "T3CRepairAction"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c_repair_action_append_only()`,
      ],
      async () => {
        expect((await repairs.correctionSeals()).missing).toContain('T3CRepairAction_append_only');
        // RED at 170bcd6 (finding B): the MIGRATION's guard checked function + enabled and not the
        // events, so it skipped creation and recorded itself applied while DELETE stayed open.
        const run = runMigration();
        expect(run.code).not.toBe(0);
        expect(run.output).toContain('does not enforce append-only on both UPDATE and DELETE');
      },
    );
    // the fixture planted the non-blank rule NOT VALID and removed the ALTER guard; the repair
    // retired the blank, so validating is legal, and the migration re-creates the guard.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    expect(runMigration().code).toBe(0);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R7-H: the evidence attribution CHECK is verified by what it decides too', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-12-08');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    const real = `CHECK (btrim("operator", E' \\t\\n\\x0B\\f\\r') <> '' AND btrim("reason", E' \\t\\n\\x0B\\f\\r') <> '')`;

    // RED at 170bcd6: name-only. A same-named `CHECK (TRUE)` — or one covering only `operator` —
    // made both the migration guard and the seal report skip straight past, and because the table is
    // append-only the whitespace attribution admitted through that hole is permanent.
    for (const decoy of [
      `CHECK (TRUE)`,
      `CHECK (btrim("operator", E' \\t\\n\\x0B\\f\\r') <> '')`,
    ]) {
      await withDecoy(
        [
          // swapping the evidence constraint is a destructive ALTER — the round-3h guard refuses it
          // unless the operator first performs the separate, loud act of removing the guard
          `DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_alter_guard`,
          `ALTER TABLE "T3CRepairAction" DROP CONSTRAINT "T3CRepairAction_attribution_non_blank"`,
          `ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "T3CRepairAction_attribution_non_blank" ${decoy}`,
        ],
        [
          `ALTER TABLE "T3CRepairAction" DROP CONSTRAINT "T3CRepairAction_attribution_non_blank"`,
          `ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "T3CRepairAction_attribution_non_blank" ${real}`,
        ],
        async () => {
          expect((await repairs.correctionSeals()).missing, decoy).toContain('T3CRepairAction_attribution_non_blank');
          expect(runMigration().output, decoy).toContain('is not the canonical attribution rule');
        },
      );
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    // the migration re-creates the ALTER guard the fixture removed; only then is the DB sealed again
    expect(runMigration().code).toBe(0);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R7-G: quarantining an already-revoked marker preserves the WHOLE revocation triple', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-12-11');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // A forged marker that the forger ALSO revoked — the typical case, since the marker CHECK
    // requires it. Its revocation is real history: someone, at some time, for some stated reason.
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId),
      `${T3C_INVALID_LEGACY_PREFIX} repair=66666666-6666-6666-6666-666666666666; minted`, '2026-12-12',
    );
    const before = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(before.revokedAt).not.toBeNull();

    // A plan naming a DIFFERENT revoker on a pre-revoked row is refused rather than silently ignored
    // — the same rule `f1-mark-invalid-legacy` already applies.
    await expect(repairs.repair({
      operator: 'ops@vitan.in', reason: 'incident',
      actions: [{ op: 'f1-quarantine-forged-marker', id: forged, revokedById: f.ownerUser.id, revokeReason: 'forged' }],
    })).rejects.toThrow(/that attribution is preserved, so the plan must name the same revokedById/);

    const outcome = await repairs.repair({
      operator: 'ops@vitan.in', reason: 'incident: marker with no repair behind it',
      actions: [{ op: 'f1-quarantine-forged-marker', id: forged, revokedById: f.memberUser.id, revokeReason: 'no repair evidence exists for the id it cites' }],
    });

    // RED at 170bcd6: `COALESCE` preserved `revokedAt` while `revokedById` and `revokeReason` were
    // overwritten with the quarantine's, committing a triple that never happened — "B revoked this
    // at T1, for reason Q" — over the attribution consumers read straight off LabourAttendance.
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(after.revokedAt?.toISOString()).toBe(before.revokedAt?.toISOString());
    expect(after.revokedById).toBe(before.revokedById);
    expect(after.revokeReason).toBe(before.revokeReason);
    expect(after.manualReason).toContain('QUARANTINED FORGERY');
    expect(after.manualReason).toContain(`repair=${outcome.repairId}`);

    // the operator's own words are recorded — in the append-only evidence, where an operator action
    // belongs, without overwriting what the original revoker said
    const ev = await t.prisma.$queryRawUnsafe<Array<{ detail: Record<string, unknown> }>>(
      `SELECT "detail" FROM "T3CRepairAction" WHERE "repairId" = $1 AND "rowId" = $2`, outcome.repairId, forged,
    );
    expect(ev[0]!.detail['revocationPreserved']).toBe(true);
    expect(ev[0]!.detail['quarantineNote']).toBe('no repair evidence exists for the id it cites');
    expect(ev[0]!.detail['revokeReason']).toBe('looks like a repair');
    expect((await repairs.preflight()).clean).toBe(true);
  });

  it('R7-G2: quarantining a LIVE forged marker writes a complete, self-consistent triple', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-12-15');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId),
      `${T3C_INVALID_LEGACY_PREFIX} repair=77777777-7777-7777-7777-777777777777; minted`, '2026-12-16',
      { live: true },
    );
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'incident',
      actions: [{ op: 'f1-quarantine-forged-marker', id: forged, revokedById: f.ownerUser.id, revokeReason: 'no repair evidence' }],
    });
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(after.revokedAt).not.toBeNull();
    expect(after.revokedById).toBe(f.ownerUser.id);
    expect(after.revokeReason).toBe('no repair evidence');
    expect((await repairs.preflight()).clean).toBe(true);
    // the deploy is now actually possible: the CHECK the live marker made unvalidatable validates.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_marker_is_revoked"`);
    // …and so does the fixture-planted NOT VALID non-blank rule — round 3h's seals answer covers
    // 20270220's CHECK too, and VALIDATED is what that migration really produces.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R7-C: `t3c seals` on a database with no §C schema is its own answer, never a success', async () => {
    // RED at 170bcd6: `seals` returned exit 0 with `{ok: true}` when the attendance schema was
    // absent. `migrate.sh` read that as "seals present" on the P3005 path, resolved EVERY migration
    // as applied, re-checked, got the same false success, and exited 0 — leaving Prisma's ledger
    // claiming a schema the application does not have and the Task-3 tables never created.
    const probeDb = `t3c_seals_probe_${Date.now() % 1e7}`;
    const created = spawnSync('psql', [psqlUrl(), '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${probeDb}"`], { encoding: 'utf8', env: psqlEnv() });
    expect(created.status, `${created.stdout ?? ''}${created.stderr ?? ''}`).toBe(0);
    const prismaProbeUrl = new URL(process.env.DATABASE_URL!);
    prismaProbeUrl.pathname = `/${probeDb}`;
    try {
      // NON-EMPTY, so this really is the P3005 shape: a schema exists, it just predates Task 3.
      const seeded = spawnSync('psql', [psqlUrl(probeDb), '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE "Project" (id text primary key)'], { encoding: 'utf8', env: psqlEnv() });
      expect(seeded.status, `${seeded.stdout ?? ''}${seeded.stderr ?? ''}`).toBe(0);
      const res = spawnSync('npx', ['tsx', 'src/labour/t3c/t3c.cli.ts', 'seals'], {
        cwd: join(__dirname, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: prismaProbeUrl.toString() },
      });
      expect(res.status, `${res.stdout ?? ''}${res.stderr ?? ''}`).toBe(4);
      expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, applicable: false, status: 'prerequisite-schema-absent' });
    } finally {
      spawnSync('psql', [psqlUrl(), '-c', `DROP DATABASE IF EXISTS "${probeDb}" WITH (FORCE)`], { encoding: 'utf8', env: psqlEnv() });
    }

    // and the runner FAILS CLOSED on that answer instead of baselining a schema it cannot identify
    const migrateSh = readFileSync(join(__dirname, '..', '..', 'scripts/migrate.sh'), 'utf8');
    expect(migrateSh).toContain('prerequisite-schema-absent');
    expect(migrateSh).toMatch(/4\)[\s\S]*Refusing to baseline/);
  });
  it('R7-I: a repair verifies EVERY §C seal in full before it commits, not only the ones it created', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2026-12-20');

    // An enabled, same-named NO-OP in place of the trigger that actually freezes attendance — the
    // legacy/partially-managed database shape. RED at 170bcd6: the verifier checked name + enabled
    // for this one (the bound function was only asserted for the evidence triggers), so the repair
    // disabled it, put the decoy back, and COMMITTED — leaving a row that could afterwards be edited
    // or deleted while its marker claimed the original was preserved.
    await withDecoy(
      [
        `CREATE OR REPLACE FUNCTION t3c_test_noop() RETURNS trigger AS $fn$ BEGIN RETURN NEW; END; $fn$ LANGUAGE plpgsql`,
        `DROP TRIGGER "LabourAttendance_append_only" ON "LabourAttendance"`,
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION t3c_test_noop()`,
      ],
      [
        `DROP TRIGGER "LabourAttendance_append_only" ON "LabourAttendance"`,
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only()`,
        `DROP FUNCTION IF EXISTS t3c_test_noop()`,
      ],
      async () => {
        await expect(repairs.repair({
          operator: 'ops@vitan.in', reason: 'retire a legacy blank muster',
          actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
        })).rejects.toThrow(/bound to t3c_test_noop, expected phase4_t3_attendance_append_only/);
        // rolled back completely — the muster is untouched and still diagnosed
        const row = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: seed } });
        expect(row.manualReason?.trim()).toBe('');
      },
    );

    // an UPDATE-only variant of the real trigger is refused for the same reason: DELETE is open
    await withDecoy(
      [
        `DROP TRIGGER "LabourAttendance_append_only" ON "LabourAttendance"`,
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only()`,
      ],
      [
        `DROP TRIGGER "LabourAttendance_append_only" ON "LabourAttendance"`,
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only()`,
      ],
      async () => {
        await expect(repairs.repair({
          operator: 'ops@vitan.in', reason: 'retire a legacy blank muster',
          actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
        })).rejects.toThrow(/expected exactly/);
      },
    );

    // with the real seals in place the same repair commits
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in', reason: 'retire a legacy blank muster',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    expect(outcome.applied).toBe(1);
    expect((await repairs.preflight()).clean).toBe(true);
  });

  it('R7-K: §C TABLES without §C GUARDS is its own answer — the db-push shape is never baselined', async () => {
    // `prisma db push` creates every table and NONE of the raw-SQL triggers. RED at 170bcd6: the
    // baseline answer covered only correction 3's own objects, so such a database resolved
    // 20270210000000 / 20270215000000 as applied and recorded `WorkerAllocation_head_live` — the
    // guard that refuses an allocation against a CANCELLED requirement under the root lock — as
    // installed, forever. Correction 3 `CREATE OR REPLACE`s that trigger's FUNCTION but never
    // creates the TRIGGER, so nothing downstream would ever notice.
    await withDecoy(
      [`DROP TRIGGER "WorkerAllocation_head_live" ON "WorkerAllocation"`],
      [
        `CREATE TRIGGER "WorkerAllocation_head_live" BEFORE INSERT ON "WorkerAllocation"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3c_allocation_head_live()`,
      ],
      async () => {
        const seals = await repairs.correctionSeals();
        expect(seals.prerequisitesMissing).toContain('WorkerAllocation_head_live');
        expect(seals.installed).toBe(false);
        // correction 3's OWN objects are all still there — the two answers stay distinct, because
        // they call for different actions: correction 3 can be re-run, these migrations cannot.
        expect(seals.missing).toEqual([]);

        const res = spawnSync('npx', ['tsx', 'src/labour/t3c/t3c.cli.ts', 'seals'], {
          cwd: join(__dirname, '..', '..'), encoding: 'utf8', env: { ...process.env },
        });
        expect(res.status).toBe(5);
        expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, status: 'prerequisite-seals-missing' });
      },
    );
    expect((await repairs.correctionSeals()).installed).toBe(true);

    // and the runner refuses to baseline on that answer rather than recording guards that are absent
    const migrateSh = readFileSync(join(__dirname, '..', '..', 'scripts/migrate.sh'), 'utf8');
    expect(migrateSh).toContain('prerequisite-seals-missing');
    expect(migrateSh).toMatch(/5\)[\s\S]*Refusing to baseline/);
  });
  it('R7-L: a repair revoker must have standing on the ATTENDANCE ROW\'S project', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-05');

    // RED at 170bcd6: `LabourAttendance_revokedBy_fkey` proves the id names SOME user and nothing
    // more, so a plan could name ANY existing user — here the other tenant's pmc — and the repair
    // committed, permanently attributing this project's revocation to someone with no standing on
    // it. Append-only means that misattribution can never be corrected.
    await expect(repairs.repair({
      operator: 'ops@vitan.in', reason: 'retire a legacy blank muster',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.otherUser.id, revokeReason: 'retired' }],
    })).rejects.toThrow(/has no attendance-revoke standing on project/);

    // a user that does not exist at all is refused by the same check, before any FK is reached
    await expect(repairs.repair({
      operator: 'ops@vitan.in', reason: 'retire a legacy blank muster',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: 'no-such-user', revokeReason: 'retired' }],
    })).rejects.toThrow(/has no attendance-revoke standing on project/);

    // the org OWNER has standing without an explicit membership — the documented super-admin path,
    // exactly as `ProjectAccessService.authorize` allows — and the repair commits
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in', reason: 'retire a legacy blank muster',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    expect(outcome.applied).toBe(1);
    expect((await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: seed } })).revokedById).toBe(f.ownerUser.id);

    // …and so does an ACTIVE project member
    const second = await legacyBlankMuster(projectId, await onboardWorker(projectId), '2027-01-06');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'retire another legacy blank muster',
      actions: [{ op: 'f1-mark-invalid-legacy', id: second, revokedById: f.memberUser.id, revokeReason: 'retired' }],
    });
    expect((await repairs.preflight()).clean).toBe(true);
  });

  it('R7-M: the before-image must preserve the TIMESTAMP and the REVOCATION, by value', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-10');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // A pre-revoked forged marker, and evidence carrying every IMMUTABLE field correctly — but a
    // fabricated `recordedAt` and no revocation history at all. RED at 170bcd6: `recordedAt` was
    // accepted by PRESENCE and the revocation triple was not required, so this authenticated the
    // marker and both the preflight and the migration blessed it permanently.
    const fake = '88888888-8888-8888-8888-888888888888';
    const forged = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId),
      `${T3C_INVALID_LEGACY_PREFIX} repair=${fake}; minted`, '2027-01-11',
    );
    await rawEvidence(fake, forged, JSON.stringify({
      ...(await completeBeforeImage(forged, '   ')),
      recordedAt: '1999-01-01T00:00:00.000000Z',
      revokedAt: null, revokedById: null, revokeReason: null,
    }));
    expect((await repairs.preflight()).findings.find((x) => x.code === 'F1.marker')!.samples.map((s) => s['id']))
      .toContain(forged);

    // Evidence with the RIGHT timestamp but a REWRITTEN revocation is refused too: the marker's
    // claim is that the original row survives, and the revocation is the part under dispute.
    const fake2 = '99999999-9999-9999-9999-999999999999';
    const forged2 = await forgedMarkedMuster(
      projectId, await onboardWorker(projectId),
      `${T3C_INVALID_LEGACY_PREFIX} repair=${fake2}; minted`, '2027-01-12',
    );
    await rawEvidence(fake2, forged2, JSON.stringify({
      ...(await completeBeforeImage(forged2, '   ')),
      revokeReason: 'something the original revoker never said',
    }));
    expect((await repairs.preflight()).findings.find((x) => x.code === 'F1.marker')!.samples.map((s) => s['id']))
      .toContain(forged2);

    // Both are quarantinable — a diagnosed state always has an exit. ONE repair carries both
    // actions, because the engine commits only when its in-transaction re-diagnose reads clean.
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'incident: evidence does not preserve what it claims',
      actions: [forged, forged2].map((id) => ({
        op: 'f1-quarantine-forged-marker' as const, id, revokedById: f.memberUser.id, revokeReason: 'before-image does not preserve the original row',
      })),
    });
    expect((await repairs.preflight()).clean).toBe(true);
    expect(runMigration().code).toBe(0);
  });
  it('R7-N: the evidence register cannot be DROPPED — the one erasure no table trigger can see', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-20');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // RED at 170bcd6: this succeeded — DROP TABLE fires neither the row-level append-only pair nor
    // the statement-level TRUNCATE seal, so one DDL statement erased every before-image while the
    // marked attendance rows went on claiming their originals were preserved.
    await expect(t.prisma.$executeRawUnsafe('DROP TABLE "T3CRepairAction"')).rejects.toThrow(
      /durable repair-evidence register and is never dropped/,
    );
    // …including via a CASCADE that would sweep it up with something else
    await expect(t.prisma.$executeRawUnsafe('DROP TABLE "T3CRepairAction" CASCADE')).rejects.toThrow(
      /never dropped/,
    );
    const still = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "T3CRepairAction"`,
    );
    expect(Number(still[0]!.n)).toBeGreaterThan(0);

    // The guard is part of the baseline answer: remove it (the loud, separate DDL act it forces)
    // and the database no longer reads as sealed.
    await withDecoy(
      ['DROP EVENT TRIGGER phase4_t3c_evidence_drop_guard'],
      [
        `CREATE EVENT TRIGGER phase4_t3c_evidence_drop_guard ON sql_drop
           EXECUTE FUNCTION phase4_t3c_evidence_drop_guard()`,
      ],
      async () => {
        expect((await repairs.correctionSeals()).missing).toContain('phase4_t3c_evidence_drop_guard');
      },
    );
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    expect((await repairs.correctionSeals()).installed).toBe(true);
    // and the migration re-asserts it: with the guard present the file still applies cleanly
    expect(runMigration().code).toBe(0);
  });

  it('R7-O: every finding beyond the bounded report sample is still repairable — t3c plan', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);

    // 25 legacy blanks — five more than the report's SAMPLE_LIMIT. RED at 170bcd6: the preflight
    // exposed only 20 ids, the repair is all-or-nothing (it commits only when the in-transaction
    // re-diagnose reads clean), so a plan naming the visible rows rolled back over the undisclosed
    // five and the next preflight showed the same twenty forever. The supported recovery could not
    // unblock the deploy.
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const workerId = await onboardWorker(projectId);
      ids.push(await legacyBlankMuster(projectId, workerId, `2027-02-${String((i % 27) + 1).padStart(2, '0')}`));
    }
    const report = await repairs.preflight();
    const blank = report.findings.find((x) => x.code === 'F1.blank')!;
    expect(blank.count).toBe(25);
    expect(blank.samples.length).toBe(20); // the report stays bounded — that is not the defect

    // The plan skeleton names EVERY row.
    const skeleton = await repairs.planSkeleton();
    expect(skeleton.actions.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(skeleton.manual).toEqual([]);

    // Filling it in and submitting it whole clears the finding in ONE committed repair.
    const outcome = await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'retire all 25 legacy blank musters',
      actions: skeleton.actions.map((a) => ({ ...a, revokedById: f.ownerUser.id, revokeReason: 'retired' })),
    });
    expect(outcome.applied).toBe(25);
    expect((await repairs.preflight()).clean).toBe(true);
  });

  // ══ ROUND 3h — the cd7b30c re-review: the prerequisite INVENTORY, the NAIVE render, the ALTER guard ══

  it('R3h-C: the prerequisite answer covers CHECKs, unique keys and composite FKs — not only triggers', async () => {
    // RED at cd7b30c: only the nine triggers were prerequisites, so a database carrying them while
    // missing the raw-SQL revoke-attribution CHECK (a raw update could then set revokedAt alone — a
    // permanently unattributed correction), the worker-conservation partial unique, or the
    // slice-bound commitment FK still baselined cleanly.
    const drops: Array<{ name: string; drop: string; restore: string }> = [
      {
        name: 'LabourAttendance_revoke_attribution_check',
        drop: `ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_revoke_attribution_check"`,
        restore: `ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_revoke_attribution_check" CHECK (
            ("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
         OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL))`,
      },
      {
        name: 'WorkerAllocation_live_slice_key',
        drop: `DROP INDEX "WorkerAllocation_live_slice_key"`,
        restore: `CREATE UNIQUE INDEX "WorkerAllocation_live_slice_key"
            ON "WorkerAllocation"("projectId", "workerId", "civilDate", "shift") WHERE "status" = 'active'`,
      },
      {
        name: 'WorkerAllocation_commitment_fkey',
        drop: `ALTER TABLE "WorkerAllocation" DROP CONSTRAINT "WorkerAllocation_commitment_fkey"`,
        restore: `ALTER TABLE "WorkerAllocation" ADD CONSTRAINT "WorkerAllocation_commitment_fkey"
            FOREIGN KEY ("projectId", "capacityCommitmentId", "labourSpecFingerprint", "civilDate", "shift")
            REFERENCES "CapacityCommitment"("projectId", "id", "labourSpecFingerprint", "civilDate", "shift")
            ON DELETE NO ACTION ON UPDATE NO ACTION`,
      },
    ];
    for (const d of drops) {
      await t.prisma.$executeRawUnsafe(d.drop);
      try {
        const seals = await repairs.correctionSeals();
        expect(seals.prerequisitesMissing, d.name).toContain(d.name);
        expect(seals.installed, d.name).toBe(false);
      } finally {
        await t.prisma.$executeRawUnsafe(d.restore);
      }
    }
    // a WEAKENED same-named prerequisite is caught by IDENTITY, not presence: re-adding the
    // attribution CHECK with a widened OR arm still reports it missing
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_revoke_attribution_check"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_revoke_attribution_check" CHECK (
        ("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
     OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL)
     OR ("revokeReason" LIKE '%permit'))`);
    try {
      expect((await repairs.correctionSeals()).prerequisitesMissing).toContain('LabourAttendance_revoke_attribution_check');
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_revoke_attribution_check"`);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_revoke_attribution_check" CHECK (
          ("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
       OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL))`);
    }
    // …and 20270220's CHECK is its own PENDING layer, never a refusal: absent, the seals answer
    // names the migration to leave unresolved so `migrate deploy` really executes it.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    try {
      const seals = await repairs.correctionSeals();
      expect(seals.correction2Installed).toBe(false);
      expect(seals.installed).toBe(false);
      expect(seals.prerequisitesMissing).toEqual([]);
      expect(seals.pendingMigrations).toContain('20270220000000_phase4_t3_correction2');
      // Round-3j re-pin: whenever 20270220 is pending, 20270225 is pending WITH it — the older
      // replay rewrites the head-live body back to its 20270220 version, and only the newer
      // migration's re-run restores the 20270225 body the correction-3 layer requires.
      expect(seals.pendingMigrations).toContain('20270225000000_phase4_t3_correction3');
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_manual_reason_non_blank"
          CHECK ("manualReason" IS NULL OR btrim("manualReason", E' \t\n\x0B\f\r') <> '')`);
    }
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R3h-D: the canonical timestamp render consults NO session setting — Kolkata and UTC agree', async () => {
    // RED at cd7b30c: the render appended AT TIME ZONE 'UTC' to a TIMESTAMP WITHOUT TIME ZONE
    // column, converting it to timestamptz — which to_char then renders in the session TimeZone.
    // Evidence captured by an Asia/Kolkata session and checked by a UTC deploy session produced two
    // different strings for the SAME stored value, and genuine evidence was diagnosed as forged.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-05');
    const renderUnder = async (tz: string): Promise<string> => {
      const rows = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${tz}'`);
        return tx.$queryRawUnsafe<Array<{ r: string }>>(
          `SELECT ${t3cRenderTs('a."recordedAt"')} AS r FROM "LabourAttendance" a WHERE a."id" = $1`,
          seed,
        );
      });
      return rows[0]!.r;
    };
    const kolkata = await renderUnder('Asia/Kolkata');
    const utc = await renderUnder('UTC');
    expect(kolkata).toBe(utc);
  });

  it('R3h-F: the evidence table cannot be COLUMN-dropped or renamed — DDL erasure needs the loud act', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-06');
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });

    // RED at cd7b30c: the sql_drop guard matched object_type 'table' only — DROP COLUMN reports
    // 'table column' and sailed through, erasing every preserved before-image in one statement
    // while the markers went on claiming their originals existed. A RENAME drops nothing at all,
    // so only the ddl_command_end guard sees it.
    await expect(
      t.prisma.$executeRawUnsafe(`ALTER TABLE "T3CRepairAction" DROP COLUMN "beforeImage"`),
    ).rejects.toThrow(/never (dropped|altered)/);
    await expect(
      t.prisma.$executeRawUnsafe(`ALTER TABLE "T3CRepairAction" RENAME COLUMN "beforeImage" TO "x"`),
    ).rejects.toThrow(/never altered/);
    const col = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'T3CRepairAction' AND column_name = 'beforeImage'`,
    );
    expect(Number(col[0]!.n)).toBe(1);

    // removing the guard is a SEPARATE, loud DDL act — after it the database is reported NOT sealed
    await t.prisma.$executeRawUnsafe(`DROP EVENT TRIGGER phase4_t3c_evidence_alter_guard`);
    try {
      const seals = await repairs.correctionSeals();
      expect(seals.missing).toContain('phase4_t3c_evidence_alter_guard');
      expect(seals.installed).toBe(false);
    } finally {
      // the migration re-asserts the guard
      expect(runMigration().code).toBe(0);
    }
    // the fixture planted 20270220's non-blank rule NOT VALID; the repair retired the blank row,
    // so validating is legal — and VALIDATED is what the seals answer (correctly) demands.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  // ── ROUND 3i — the three Codex findings on `8585d44` ────────────────────────────────────────────

  /** The dollar-quoted body a specific migration wrote for one function — read from the FILE, so a
   *  probe installs a REAL earlier-layer body (or a decoy derived from one), never a hand-written
   *  approximation that might accidentally differ from what a genuine older database carries. */
  const migrationFnBody = (layerDir: string, fn: string): string => {
    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', layerDir, 'migration.sql'), 'utf8');
    const m = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(\\) RETURNS (?:event_)?trigger AS (\\$\\w*\\$)`).exec(sql);
    if (!m) throw new Error(`${layerDir} does not define ${fn}`);
    const start = m.index + m[0].length;
    const end = sql.indexOf(m[1]!, start);
    if (end < 0) throw new Error(`${layerDir}: unterminated body for ${fn}`);
    return sql.slice(start, end);
  };
  const installFnBody = async (fn: string, body: string): Promise<void> => {
    await t.prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $r3iprobe$${body}$r3iprobe$ LANGUAGE plpgsql`,
    );
  };

  it('R3i-A: a trigger bound to a PRE-correction function body is that correction PENDING; a decoy body is a refusal', async () => {
    // RED at 8585d44: `CREATE OR REPLACE FUNCTION` preserves a function's identity, so the seals
    // accepted name + enabled + fn name + exact tgtype while the BODY was the pre-correction-2 one
    // that does not freeze `manualReason` — and on the P3005 path `migrate.sh` then resolved
    // correction 2 as applied over a database where a live justification stayed rewritable.
    const L210 = '20270210000000_phase4_t3_time_capacity';
    const L215 = '20270215000000_phase4_t3_correction';
    const L220 = '20270220000000_phase4_t3_correction2';
    const L225 = '20270225000000_phase4_t3_correction3';
    const appendOnly = 'phase4_t3_attendance_append_only';
    const headLive = 'phase4_t3c_allocation_head_live';
    try {
      // (1) the REAL 20270210 body under an EXISTING correction-2 CHECK. Round 3j: the pending set
      // must NOT name 20270220 here — that deployed migration's ADD CONSTRAINT is unconditional,
      // so replaying it over the existing constraint fails the whole deploy (asserted directly
      // below). The healing layer is 20270225, which re-asserts the canonical body.
      await installFnBody(appendOnly, migrationFnBody(L210, appendOnly));
      let seals = await repairs.correctionSeals();
      expect(seals.prerequisitesMissing).toEqual([]);
      expect(seals.correction2Installed).toBe(false);
      expect(seals.correction2Missing).toContain(`${appendOnly}@${L220}`);
      expect(seals.pendingMigrations).toContain(L225);
      expect(seals.pendingMigrations).not.toContain(L220);
      expect(seals.installed).toBe(false);
      // The trap the old attribution set: replaying 20270220 over its own existing CHECK FAILS.
      const replay220 = spawnSync(
        'psql',
        [psqlUrl(), '-v', 'ON_ERROR_STOP=1', '-f', join(__dirname, '..', '..', 'prisma', 'migrations', L220, 'migration.sql')],
        { encoding: 'utf8', env: psqlEnv() },
      );
      expect(replay220.status).not.toBe(0);
      expect(`${replay220.stdout}${replay220.stderr}`).toContain('already exists');
      // …and the ATTRIBUTED pending migration really heals: 20270225's replay re-asserts the body.
      expect(runMigration().code).toBe(0);
      expect((await repairs.correctionSeals()).correction2Installed).toBe(true);
      // (2) a DECOY body matching NO deployed layer: not a layer state, a refusal — the
      // prerequisite seal reports the trigger missing and the runner refuses to baseline.
      await installFnBody(appendOnly, `${migrationFnBody(L220, appendOnly)}\n-- decoy\n`);
      seals = await repairs.correctionSeals();
      expect(seals.prerequisitesMissing).toContain('LabourAttendance_append_only');
      expect(seals.installed).toBe(false);
    } finally {
      await installFnBody(appendOnly, migrationFnBody(L220, appendOnly));
    }
    // (3) head_live at its 20270215 body: both correction layers report the body stale, but with
    // the CHECK present only 20270225 may be left pending — and its replay heals.
    try {
      await installFnBody(headLive, migrationFnBody(L215, headLive));
      const seals = await repairs.correctionSeals();
      expect(seals.correction2Missing).toContain(`${headLive}@${L220}`);
      expect(seals.missing).toContain(`${headLive}@${L225}`);
      expect(seals.pendingMigrations).toContain(L225);
      expect(seals.pendingMigrations).not.toContain(L220);
      expect(seals.installed).toBe(false);
    } finally {
      expect(runMigration().code).toBe(0);
    }
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R3i-B: a live repair records the SAME revocation timestamp it writes — the durable evidence can no longer contradict the row', async () => {
    // RED at 8585d44: for a still-live blank muster the evidence recorded `detail.revokedAt: null`
    // while the update in the same transaction wrote `now()` — an append-only record permanently
    // contradicting the attendance row it describes, under a contract that says the detail is the
    // triple actually written. One timestamp is now captured before the evidence and used verbatim
    // in BOTH writes (the quarantine op's live branch shares the same captured value).
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-07');
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'retire a live blank muster',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    const row = await t.prisma.$queryRawUnsafe<Array<{ r: string }>>(
      `SELECT ${t3cRenderTs('a."revokedAt"')} AS r FROM "LabourAttendance" a WHERE a."id" = $1`,
      seed,
    );
    const detail = await t.prisma.$queryRawUnsafe<Array<{ d: string | null }>>(
      `SELECT "detail"->>'revokedAt' AS d FROM "T3CRepairAction" WHERE "rowId" = $1`,
      seed,
    );
    expect(detail[0]!.d).toBe(row[0]!.r);
  });

  it('R3i-C: an INVALID or not-READY unique index is not a seal — a failed CONCURRENTLY shell enforces nothing', async () => {
    // RED at 8585d44: `indisunique` alone accepted an `indisvalid = false` index — the exact state
    // a failed `CREATE UNIQUE INDEX CONCURRENTLY` leaves behind, which enforces nothing for
    // existing rows and may already coexist with the duplicates the conservation key forbids. The
    // P3005 path then baselined the migrations over it, and the migration's own prerequisite block
    // deployed over it too.
    const idx = 'WorkerAllocation_live_slice_key';
    try {
      await t.prisma.$executeRawUnsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${idx}"'::regclass`);
      const seals = await repairs.correctionSeals();
      expect(seals.prerequisitesMissing).toContain(idx);
      expect(seals.installed).toBe(false);
      const mig = runMigration();
      expect(mig.code).not.toBe(0);
      expect(mig.output).toContain(idx);
    } finally {
      await t.prisma.$executeRawUnsafe(`UPDATE pg_index SET indisvalid = true WHERE indexrelid = '"${idx}"'::regclass`);
    }
    try {
      await t.prisma.$executeRawUnsafe(`UPDATE pg_index SET indisready = false WHERE indexrelid = '"${idx}"'::regclass`);
      expect((await repairs.correctionSeals()).prerequisitesMissing).toContain(idx);
    } finally {
      await t.prisma.$executeRawUnsafe(`UPDATE pg_index SET indisready = true WHERE indexrelid = '"${idx}"'::regclass`);
    }
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  // ── ROUND 3j — the three Codex findings on `a113cce` (R3j-A is folded into R3i-A's re-pin) ──────

  it('R3j-B: a repair never writes history over an unenforced revocation rule', async () => {
    // RED at a113cce: with `LabourAttendance_revoke_attribution_check` dropped (the restored-
    // database state the finding names), a blank muster carrying `revokedAt` + `revokedById` but NO
    // `revokeReason` sailed down the preserved-revocation path — the repair COMMITTED, backfilling
    // the operator's reason onto someone else's revocation timestamp: a triple that never happened,
    // written into a table whose attribution rule was unenforced. The repair now verifies the
    // canonical revocation CHECK (same probe-deparse identity as every seal) before writing any
    // history, and `applyAction` independently refuses an incoherent pre-existing triple.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-08');
    // The non-blank CHECK must come off for the plant too: an UPDATE writes a new row VERSION, and
    // even a NOT VALID constraint checks new versions — only the blank row's untouched original
    // escapes it. The hostile database this models never had either rule enforced.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_revoke_attribution_check"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DISABLE TRIGGER "LabourAttendance_append_only"`);
    try {
      await t.prisma.$executeRawUnsafe(
        `UPDATE "LabourAttendance" SET "revokedAt" = now(), "revokedById" = $1 WHERE "id" = $2`,
        f.ownerUser.id,
        seed,
      );
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ENABLE TRIGGER "LabourAttendance_append_only"`);
      await expect(
        repairs.repair({
          operator: 'ops@vitan.in',
          reason: 'attempt over an unenforced revocation rule',
          actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
        }),
      ).rejects.toThrow(/not the canonical validated revocation rule/);
      // Nothing committed: no marker, the malformed triple untouched, no reason invented.
      const row = await t.prisma.$queryRawUnsafe<Array<{ m: string | null; rr: string | null }>>(
        `SELECT "manualReason" AS m, "revokeReason" AS rr FROM "LabourAttendance" WHERE "id" = $1`,
        seed,
      );
      expect(row[0]!.m ?? '').not.toContain(T3C_INVALID_LEGACY_PREFIX);
      expect(row[0]!.rr).toBeNull();
    } finally {
      // Test-harness teardown of the hostile fixture — the incoherent row must go before the
      // canonical CHECKs can return (the exact restore DDL other probes use; afterEach VALIDATEs).
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DISABLE TRIGGER "LabourAttendance_append_only"`);
      await t.prisma.$executeRawUnsafe(`DELETE FROM "LabourAttendance" WHERE "id" = $1`, seed);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ENABLE TRIGGER "LabourAttendance_append_only"`);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_revoke_attribution_check" CHECK (
          ("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
       OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL))`);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_manual_reason_non_blank"
          CHECK ("manualReason" IS NULL OR btrim("manualReason", E' \t\n\x0B\f\r') <> '')`);
    }
  });

  it('R3j-C: RENAME cannot smuggle the evidence register out from under its markers', async () => {
    // RED at a113cce: `ALTER TABLE … RENAME TO` commits its new name BEFORE ddl_command_end fires,
    // so `to_regclass` of the OLD name was already NULL inside the guard and the rename sailed
    // through — orphaning every marker from the register its diagnostics and runbook query, while a
    // later repair would create a fresh empty table under the original name. The guard now also
    // identifies the register by the attribution CHECK riding its OID, which a rename cannot touch
    // and whose removal is itself ALTER TABLE — refused while the guard stands.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-09');
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'create the evidence table',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    let renamed = false;
    try {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "T3CRepairAction" RENAME TO "t3c_smuggled"`);
      renamed = true;
    } catch (e) {
      expect(String(e)).toMatch(/never altered/);
    }
    if (renamed) {
      // RED-run hygiene only: put the register back before failing, so later tests find it. The
      // guard must come off FIRST (the deliberate loud act) — a rename-BACK re-resolves the
      // guarded name at ddl_command_end and is refused exactly like any other rename.
      await t.prisma.$executeRawUnsafe('DROP EVENT TRIGGER IF EXISTS phase4_t3c_evidence_alter_guard');
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "t3c_smuggled" RENAME TO "T3CRepairAction"`);
    }
    expect(renamed).toBe(false);
    // The register is still sealed and queryable under its own name, evidence intact.
    const evidence = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "T3CRepairAction" WHERE "rowId" = $1`,
      seed,
    );
    expect(Number(evidence[0]!.n)).toBe(1);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  // ── ROUND 3k — the two Codex findings on `a43b875` ─────────────────────────────────────────────

  it('R3k-A: the 20270225 prerequisite refuses a prerequisite trigger whose FUNCTION BODY is not a deployed layer', async () => {
    // RED at a43b875: the migration's prerequisite loop asserted name + table + function + exact
    // tgtype but never `prosrc`, so a direct `prisma migrate deploy` accepted a hollowed
    // `phase4_t3_skill_substitution_append_only` — and the ordinary `migrate.sh` success path never
    // ran the body-aware `seals` verifier either, so a ledger-backed upgrade reported success while
    // an approved skill substitution (the evidence behind a qualification claim) stayed rewritable.
    // The DETECTOR existed since round 3i (`correctionSeals` refuses the body); what was missing
    // were the two GATES that ask it.
    const fn = 'phase4_t3_skill_substitution_append_only';
    const L210 = '20270210000000_phase4_t3_time_capacity';
    try {
      await installFnBody(fn, '\nBEGIN\n  RETURN NEW;\nEND;\n'); // right name, right tgtype, enforces NOTHING
      // the round-3i detector already refuses it…
      const seals = await repairs.correctionSeals();
      expect(seals.prerequisitesMissing).toContain('ApprovedSkillSubstitution_append_only');
      // …and now the MIGRATION refuses it too (RED: this replay exited 0 over the hollow body).
      const run = runMigration();
      expect(run.code).not.toBe(0);
      expect(run.output).toMatch(/prerequisite trigger .* function body|P4T3C3 ABORT/);
    } finally {
      await installFnBody(fn, migrationFnBody(L210, fn));
    }
    // Precision: the canonical body replays clean, and the seals answer recovers.
    expect(runMigration().code).toBe(0);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  it('R3k-A2: the md5s the migration pins ARE the prerequisite seals\' canonical bodies (no drift)', () => {
    // The migration cannot import the generated module, so it pins md5(prosrc) literals. This pin
    // holds the two enforcement sites to ONE truth: for each of the nine prerequisite triggers, the
    // migration's accepted-md5 set must equal the md5s of exactly the bodies the service's
    // prerequisite seal accepts (`T3C_PREREQUISITE_TRIGGER_SEALS[..].fnBodies` — themselves the
    // machine-extracted canonical layer bodies). A body the service refuses must not deploy, and a
    // body the service accepts (a stale-but-healable layer, or head_live's own 20270225 retry
    // state) must not be refused by the migration.
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '20270225000000_phase4_t3_correction3', 'migration.sql'),
      'utf8',
    );
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const rows = [...sql.matchAll(
      /\('([A-Za-z_]+)',\s*'([A-Za-z]+)',\s*'([a-z0-9_]+)',\s*(\d+),\s*ARRAY\[([^\]]+)\]\)/g,
    )];
    const pinned = new Map(rows.map((m) => [m[3]!, { table: m[2]!, tgtype: Number(m[4]!), md5s: m[5]!.split(',').map((h) => h.trim().replace(/'/g, '')) }]));
    expect(T3C_PREREQUISITE_TRIGGER_SEALS.length).toBe(9);
    for (const seal of T3C_PREREQUISITE_TRIGGER_SEALS) {
      const row = pinned.get(seal.fn);
      expect(row, `migration pins md5s for ${seal.fn}`).toBeDefined();
      expect(row!.table, `table for ${seal.fn}`).toBe(seal.table);
      expect(row!.tgtype, `tgtype for ${seal.fn}`).toBe(seal.tgtype);
      expect([...row!.md5s].sort(), `md5 set for ${seal.fn}`).toEqual(
        seal.fnBodies.map((b) => md5(b)).sort(),
      );
    }
  });

  it('R3k-B: repair trigger verification is bound to the sealed TABLE — a same-named canonical decoy on another table proves nothing', async () => {
    // RED at a43b875: `assertTriggersEnabled` queried `pg_trigger` by NAME alone and keyed its
    // answer by name, so globally duplicated trigger names collapsed to one arbitrary row. The
    // deterministic shape of the hole: the REAL attendance trigger is DROPPED and a fully canonical
    // decoy — same name, same function, same exact tgtype 27, enabled — rides an unrelated table.
    // The name-keyed verification found the decoy and reported the seal enforced while
    // "LabourAttendance" had NO trigger at all.
    //
    // A REAL repair runs first so the evidence register and its own three seals exist — otherwise
    // the old code would reject too, but for the unrelated reason that the evidence triggers are
    // missing, and the probe would prove nothing about the name-collapse hole.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const seed = await legacyBlankMuster(projectId, workerId, '2027-01-10');
    await repairs.repair({
      operator: 'ops@vitan.in',
      reason: 'provision the evidence register for the table-binding probe',
      actions: [{ op: 'f1-mark-invalid-legacy', id: seed, revokedById: f.ownerUser.id, revokeReason: 'retired' }],
    });
    const probe = repairs as unknown as { assertTriggersEnabled(tx: unknown): Promise<string[]> };
    try {
      await t.prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "t3k_decoy" ("id" TEXT PRIMARY KEY)`);
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "t3k_decoy"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only()`,
      );
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER "LabourAttendance_append_only" ON "LabourAttendance"`);
      await expect(probe.assertTriggersEnabled(t.prisma)).rejects.toThrow(
        /LabourAttendance_append_only on "LabourAttendance"=MISSING/,
      );
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "t3k_decoy" CASCADE`);
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "LabourAttendance"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only()`,
      );
    }
    // Precision: with the REAL trigger canonical, a coincidental same-named trigger on an
    // unrelated table neither masks the sealed table nor breaks its verification.
    try {
      await t.prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "t3k_decoy" ("id" TEXT PRIMARY KEY)`);
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "t3k_decoy"
           FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only()`,
      );
      await expect(probe.assertTriggersEnabled(t.prisma)).resolves.toBeTruthy();
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "t3k_decoy" CASCADE`);
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" VALIDATE CONSTRAINT "LabourAttendance_manual_reason_non_blank"`);
    expect((await repairs.correctionSeals()).installed).toBe(true);
  });

  // ── ROUND 3l — the two Codex findings on `4ed5eab` ──────────────────────────────────────────────

  it('R3l-A: the append-only BODY heals INSIDE the locked seal transaction — the marker CHECK is never exposed over the stale 20270210 body', async () => {
    // RED at 4ed5eab: the migration healed `phase4_t3_attendance_append_only` in a LATER statement
    // than the locked DIAGNOSE-AND-SEAL block. Prisma commits per statement, so on a database being
    // healed (the 20270210 body, which never froze `manualReason`) there was a real window after
    // the marker trigger + CHECK committed and the ACCESS EXCLUSIVE lock released in which a direct
    // writer could UPDATE a live row into the reserved marker with the revocation triple pre-set:
    // the reserved-marker trigger fires only on INSERT, the marker CHECK passes because `revokedAt`
    // is set, the stale body permits the `manualReason` rewrite, and no diagnostic ever runs again
    // — a forged marker with NO repair evidence, on a deploy that then reports success.
    //
    // The probe replays that window deterministically: regress the body to the 20270210 layer,
    // apply EXACTLY the statement prefix Prisma would have committed through the locked block, and
    // attempt the forge. The fix asserts the canonical body INSIDE the locked block, so the prefix
    // that exposes the marker CHECK has ALREADY healed the freeze and the UPDATE is refused; at
    // 4ed5eab the same prefix leaves the stale body live and the forge lands.
    const L210 = '20270210000000_phase4_t3_time_capacity';
    const L225 = '20270225000000_phase4_t3_correction3';
    const appendOnly = 'phase4_t3_attendance_append_only';
    const CANONICAL_MD5 = '6119798541f2e2f6c5237778d43f0261'; // md5(prosrc) of 20270220's body
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    // a LIVE muster with a real reason — the row the forger retro-marks as "repaired legacy"
    const commandId = await rawCommand(projectId, 'labour.attendance.record');
    const live = `att-r3l-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,'2027-02-01'::date,'day','genuine manual reason', now(), $4, $5)`,
      live, projectId, workerId, f.memberUser.id, commandId,
    );
    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', L225, 'migration.sql'), 'utf8');
    // the statement prefix through the locked block: everything before the FINDING-3 banner
    const cut = sql.indexOf('-- ══ FINDING 3');
    expect(cut).toBeGreaterThan(0);
    const prefixFile = join(tmpdir(), `t3l-prefix-${Date.now()}-${seq++}.sql`);
    writeFileSync(prefixFile, sql.slice(0, cut));
    try {
      await installFnBody(appendOnly, migrationFnBody(L210, appendOnly));
      const prefix = spawnSync('psql', [psqlUrl(), '-v', 'ON_ERROR_STOP=1', '-f', prefixFile], { encoding: 'utf8', env: psqlEnv() });
      expect(prefix.status).toBe(0);
      // the forge — retro-marking a live row via UPDATE with the triple pre-set — is REFUSED,
      // because the very prefix that exposed the marker CHECK already healed the freeze. RED at
      // 4ed5eab: this UPDATE succeeds and a marked, revoked row with NO evidence survives.
      await expect(
        t.prisma.$executeRawUnsafe(
          `UPDATE "LabourAttendance"
              SET "manualReason" = $1, "revokedAt" = now(), "revokedById" = $2, "revokeReason" = 'forged in the heal gap'
            WHERE "id" = $3`,
          `${T3C_INVALID_LEGACY_PREFIX} repair=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa forged`, f.memberUser.id, live,
        ),
      ).rejects.toThrow(/APPEND-ONLY observation/);
      // …because the body the prefix leaves bound IS the canonical correction-2 freeze. RED at
      // 4ed5eab: still the stale 20270210 md5 (e40c8d80…).
      const bound = await t.prisma.$queryRawUnsafe<Array<{ h: string }>>(
        `SELECT md5(p.prosrc) AS h FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'LabourAttendance_append_only' AND t.tgrelid = '"LabourAttendance"'::regclass AND NOT t.tgisinternal`,
      );
      expect(bound[0]!.h).toBe(CANONICAL_MD5);
      // precision: the remainder replays clean and the seals answer recovers
      expect(runMigration().code).toBe(0);
      expect((await repairs.correctionSeals()).installed).toBe(true);
    } finally {
      rmSync(prefixFile, { force: true });
      runMigration(); // whatever happened above, leave the database healed for the next probe
    }
  });

  it('R3l-A2: the healed-body md5 the migration pins IS the canonical correction-2 body (no drift)', () => {
    // The POST-CONDITIONS block refuses to record the migration applied unless the body bound to
    // `LabourAttendance_append_only` is byte-canonical. That md5 literal must be the SAME truth the
    // service seals pin (the machine-extracted 20270220 layer body) — otherwise one site heals to a
    // body the other refuses.
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '20270225000000_phase4_t3_correction3', 'migration.sql'),
      'utf8',
    );
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const canonical = md5(migrationFnBody('20270220000000_phase4_t3_correction2', 'phase4_t3_attendance_append_only'));
    // the post-condition pins exactly this md5 (the prerequisite VALUES row also lists it as one of
    // the two accepted pre-heal layers, so it appears at least twice)
    const occurrences = sql.split(canonical).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    // and the healed body the locked block asserts is byte-for-byte 20270220's text
    expect(md5(migrationFnBody('20270225000000_phase4_t3_correction3', 'phase4_t3_attendance_append_only'))).toBe(canonical);
  });

  it("R3l-B: a repair revocation is attributed only to someone with the app's OWN attendance-revoke authority — project standing is not enough", async () => {
    // RED at 4ed5eab: `assertRevokerEntitled` accepted ANY active project membership, so a plan
    // could name an active contractor as `revokedById` — writing an immutable revocation + evidence
    // record attributing a correction to someone the application itself would refuse
    // (`ROLE_POLICY['attendance.revoke']` is pmc-only, and the org owner/admin super-admin path
    // operates AS pmc). The participant now answers the ROLE-qualified question.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    // an active CONTRACTOR on this very project — real standing, no revoke authority. The probe
    // users reference the fresh project via `User.projectId`, so they are removed HERE (before
    // afterEach deletes the project) rather than leaked.
    const contractor = await t.prisma.user.create({
      data: { id: `u-r3l-${Date.now() % 1e6}-${seq++}`, projectId, role: 'contractor', name: 'Site Contractor', email: `r3l-${Date.now() % 1e6}-${seq++}@probe.test` },
    });
    const admin = await t.prisma.user.create({
      data: { id: `u-r3l-adm-${Date.now() % 1e6}-${seq++}`, projectId, role: 'pmc', name: 'Org Admin', email: `r3l-adm-${Date.now() % 1e6}-${seq++}@probe.test` },
    });
    try {
      await t.prisma.membership.create({ data: { projectId, userId: contractor.id, role: 'contractor', status: 'active' } });
      const blank = await legacyBlankMuster(projectId, workerId, '2027-02-02');
      await expect(
        repairs.repair({
          operator: 'ops@vitan.in', reason: 'attribution probe',
          actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: blank, revokedById: contractor.id, revokeReason: 'r' }],
        }),
      ).rejects.toThrow(/has no attendance-revoke standing on project/);
      // …and NOTHING was written: the row is untouched and no evidence exists
      const row = await t.prisma.$queryRawUnsafe<Array<{ reason: string; revokedAt: Date | null }>>(
        `SELECT "manualReason" AS reason, "revokedAt" FROM "LabourAttendance" WHERE "id" = $1`, blank,
      );
      expect(row[0]!.reason).toBe('   ');
      expect(row[0]!.revokedAt).toBeNull();
      // the refusal fired BEFORE the evidence register was even provisioned (the repair creates it
      // inside its transaction), so either the table does not exist or it holds nothing for this row
      const evTable = await t.prisma.$queryRawUnsafe<Array<{ t: string | null }>>(
        `SELECT to_regclass('"T3CRepairAction"')::text AS t`,
      );
      if (evTable[0]!.t !== null) {
        expect(Number((await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "T3CRepairAction" WHERE "rowId" = $1`, blank,
        ))[0]!.n)).toBe(0);
      }
      // an org ADMIN with NO explicit membership IS the documented super-admin path (operates as
      // pmc) and is accepted — the rule tightened to the app's authority, not past it
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: admin.id, role: 'admin' } });
      await repairs.repair({
        operator: 'ops@vitan.in', reason: 'attribution probe — org admin',
        actions: [{ finding: 'F1.blank', op: 'f1-mark-invalid-legacy', id: blank, revokedById: admin.id, revokeReason: 'retired legacy blank' }],
      });
      const after = await t.prisma.$queryRawUnsafe<Array<{ revokedById: string | null }>>(
        `SELECT "revokedById" FROM "LabourAttendance" WHERE "id" = $1`, blank,
      );
      expect(after[0]!.revokedById).toBe(admin.id);
    } finally {
      // the (legitimate) repair leaves an attendance row referencing a probe user via
      // `LabourAttendance_revokedBy_fkey`, and attendance is append-only — TRUNCATE (the suite's
      // own teardown shape) before the probe users can be removed
      await t.prisma.$executeRawUnsafe(TRUNCATE);
      await t.prisma.orgMembership.deleteMany({ where: { userId: { in: [contractor.id, admin.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: [contractor.id, admin.id] } } });
      await t.prisma.user.deleteMany({ where: { id: { in: [contractor.id, admin.id] } } });
    }
  });

  // ── ROUND 3m — the three Codex findings on `0f4d334` ────────────────────────────────────────────

  it('R3m-A: a preserved revocation is trusted only under the revoked-by FK seal — a ghost revoker is refused, never sealed', async () => {
    // RED at 0f4d334: the preserved-revocation path trusted the triple already ON the row —
    // including its `revokedById` — precisely because `LabourAttendance_revokedBy_fkey` makes a
    // nonexistent revoker unrepresentable. But nothing VERIFIED that FK still stands: on a
    // restored or partially managed database where it was missing, a blank muster "revoked" by a
    // ghost id was repaired, the in-transaction diagnostics cleared (they see a coherent non-null
    // triple plus evidence), and an immutable revocation attributed to NO REAL USER was sealed.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const fkDef = (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'LabourAttendance_revokedBy_fkey' AND conrelid = '"LabourAttendance"'::regclass`,
    ))[0]!.def;
    try {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" DROP CONSTRAINT "LabourAttendance_revokedBy_fkey"`);
      const ghost = `ghost-${Date.now() % 1e6}-${seq++}`;
      const row = await legacyBlankMuster(projectId, workerId, '2027-02-03', {
        at: '2026-06-01T09:00:00Z', byId: ghost, reason: 'raised on the wrong worker',
      });
      await expect(
        repairs.repair({
          operator: 'ops@vitan.in', reason: 'ghost-revoker probe',
          actions: [{ op: 'f1-mark-invalid-legacy', id: row, revokedById: ghost, revokeReason: 'retired; original revocation intact' }],
        }),
      ).rejects.toThrow(/LabourAttendance_revokedBy_fkey is not the canonical validated revoked-by reference/);
      // …and NOTHING was written: no marker, no evidence
      const after = await t.prisma.$queryRawUnsafe<Array<{ reason: string }>>(
        `SELECT "manualReason" AS reason FROM "LabourAttendance" WHERE "id" = $1`, row,
      );
      expect(after[0]!.reason).toBe('   ');
    } finally {
      // the ghost row would block re-validating the FK — the suite's own TRUNCATE teardown first
      await t.prisma.$executeRawUnsafe(TRUNCATE);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "LabourAttendance" ADD CONSTRAINT "LabourAttendance_revokedBy_fkey" ${fkDef}`);
    }
    // precision: with the FK canonical again, a genuinely-revoked row still repairs on the
    // preserved path (the R3i probe covers the full shape; this pins that 0d did not over-tighten)
    const p2 = await freshProject();
    await enableLabour(p2);
    const w2 = await onboardWorker(p2);
    const genuine = await legacyBlankMuster(p2, w2, '2027-02-05', {
      at: '2026-06-01T09:00:00Z', byId: f.memberUser.id, reason: 'raised on the wrong worker',
    });
    await repairs.repair({
      operator: 'ops@vitan.in', reason: 'ghost probe precision arm',
      actions: [{ op: 'f1-mark-invalid-legacy', id: genuine, revokedById: f.memberUser.id, revokeReason: 'retired; original revocation intact' }],
    });
    expect((await t.prisma.$queryRawUnsafe<Array<{ r: string | null }>>(
      `SELECT "revokedById" AS r FROM "LabourAttendance" WHERE "id" = $1`, genuine,
    ))[0]!.r).toBe(f.memberUser.id);
  });

  it("R3m-B: an ACTIVE non-pmc membership decides — the org-admin arm never overrides the project role the app itself enforces", async () => {
    // RED at 0f4d334: the participant's org-admin OR-arm granted pmc authority even when the SAME
    // user held an ACTIVE contractor membership on the project. `ProjectAccessService.authorize`
    // stops at the active membership — such a user operates AS contractor, and the app's
    // `attendance.revoke` role guard denies them — so the repair could attribute an immutable
    // revocation to someone the application itself would refuse.
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const dual = await t.prisma.user.create({
      data: { id: `u-r3m-${Date.now() % 1e6}-${seq++}`, projectId, role: 'contractor', name: 'Org Admin On Site As Contractor', email: `r3m-${Date.now() % 1e6}-${seq++}@probe.test` },
    });
    try {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: dual.id, role: 'admin' } });
      await t.prisma.membership.create({ data: { projectId, userId: dual.id, role: 'contractor', status: 'active' } });
      const blank = await legacyBlankMuster(projectId, workerId, '2027-02-04');
      await expect(
        repairs.repair({
          operator: 'ops@vitan.in', reason: 'precedence probe',
          actions: [{ op: 'f1-mark-invalid-legacy', id: blank, revokedById: dual.id, revokeReason: 'r' }],
        }),
      ).rejects.toThrow(/has no attendance-revoke standing on project/);
      // …with the conflicting membership GONE, the documented super-admin path applies again —
      // exactly `authorize`'s precedence, tightened to the app's authority, not past it
      await t.prisma.membership.deleteMany({ where: { projectId, userId: dual.id } });
      await repairs.repair({
        operator: 'ops@vitan.in', reason: 'precedence probe — no explicit membership',
        actions: [{ op: 'f1-mark-invalid-legacy', id: blank, revokedById: dual.id, revokeReason: 'retired legacy blank' }],
      });
      expect((await t.prisma.$queryRawUnsafe<Array<{ r: string | null }>>(
        `SELECT "revokedById" AS r FROM "LabourAttendance" WHERE "id" = $1`, blank,
      ))[0]!.r).toBe(dual.id);
    } finally {
      await t.prisma.$executeRawUnsafe(TRUNCATE);
      await t.prisma.orgMembership.deleteMany({ where: { userId: dual.id } });
      await t.prisma.membership.deleteMany({ where: { userId: dual.id } });
      await t.prisma.user.deleteMany({ where: { id: dual.id } });
    }
  });
});
