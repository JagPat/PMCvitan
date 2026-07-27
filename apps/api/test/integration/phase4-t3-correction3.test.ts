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
  /** `revoked` writes the revocation triple in the SAME insert — a legacy muster whose blank reason
   *  was already revoked before correction 2 shipped. It must be part of the insert: the deployed
   *  CHECK is re-added NOT VALID below, and a NOT VALID check still applies to any row that is
   *  UPDATED, so revoking this row afterwards would be rejected while its reason is still blank. */
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
        revokedById: f.ownerUser.id,
        revokeReason: 'no repair evidence exists for the id this marker embeds',
      }],
    });
    expect(outcome.applied).toBe(1);
    expect((await repairs.preflight()).clean, 'the finding is cleared, so the migration can deploy').toBe(true);

    // The row now points at evidence that GENUINELY exists — the one thing its old marker faked.
    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: forged } });
    expect(after.manualReason).toContain('QUARANTINED FORGERY');
    expect(after.manualReason).toContain(`repair=${outcome.repairId}`);
    expect(after.revokedById).toBe(f.ownerUser.id);
    // An already-present revocation timestamp is KEPT, never restamped: whatever the forger recorded
    // about when this row was revoked stays exactly as found.
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
        t.prisma.$executeRawUnsafe(
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
    await t.prisma.$executeRawUnsafe(
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
      actions: [{ finding: 'F1.marker', op: 'f1-quarantine-forged-marker', id: forged, revokedById: f.ownerUser.id, revokeReason: 'cited evidence carries no before-image' }],
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

  /** Insert one raw `T3CRepairAction` row. The table is append-only, not append-refusing: INSERT is
   *  exactly what a direct writer can still do, which is what these probes exercise. */
  const rawEvidence = async (
    repairId: string, rowId: string, beforeImage: string,
    operator = 'someone', reason = 'something', op = 'f1-mark-invalid-legacy',
  ): Promise<void> => {
    await t.prisma.$executeRawUnsafe(
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
    const hRow = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: honest } });
    await rawEvidence(good, honest, JSON.stringify({
      id: honest, projectId, workerId: hRow.workerId, civilDate: '2026-10-05', shift: 'day',
      deviceId: null, evidenceMediaId: null, manualReason: '   ',
      recordedAt: hRow.recordedAt.toISOString(), recordedById: hRow.recordedById, sourceCommandId: hRow.sourceCommandId,
    }));
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
    for (const fn of [
      'phase4_t3c3_attendance_reserved_marker',
      'phase4_t3c3_allocation_project_lock',
      'phase4_t3c_repair_action_append_only',
      'phase4_t3c_repair_action_no_truncate',
    ]) {
      expect(sql, fn).toMatch(new RegExp(`tgenabled <> 'O' OR tg\\.tgfoid::regproc::text <> '${fn}'`));
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
