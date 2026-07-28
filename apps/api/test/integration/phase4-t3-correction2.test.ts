import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { WorkerDevicesService } from '../../src/orgs/worker-devices.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 3 correction ROUND 2 — the three narrow re-review findings, reproduce-first against
 * live PostgreSQL. Every probe here FAILS at `main` `e7e8744` (the merged correction head) and
 * passes after the fix.
 *
 *   1 (manual muster integrity) `manualReason` was added by `20270215000000`, but the append-only
 *     trigger installed by `20270210000000` freezes an explicit COLUMN LIST that predates it — so
 *     the one field carrying the entire justification for an unevidenced presence claim was freely
 *     rewritable after the fact, and nothing rejected a whitespace-only reason (which satisfies the
 *     NOT NULL arm of `LabourAttendance_trusted_evidence` while saying nothing).
 *
 *   3 (cancellation/allocation serialization) the head-live trigger read the current revision with a
 *     PLAIN SELECT. `revise`/`cancel` serialize on the `ActivityRequirementRoot` row, but an
 *     allocation took no such lock, so a cancel and an allocation could interleave with each side
 *     blind to the other and BOTH commit — leaving a cancelled head with an active allocation.
 *
 * Finding 2 (evidence deletion ordering) is a unit probe over `MediaService` — see
 * `src/media/media.service.test.ts`, where the storage double can be asserted call-for-call.
 */
describe('Phase 4 Task 3 correction 2 — the three re-review findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capacity: LabourCapacityService;
  let commercial: LabourProcurementService;
  let vendors: VendorsService;
  let devices: WorkerDevicesService;
  let capabilities: CapabilitiesService;
  let seq = 0;
  // A DEDICATED client for the racing sessions: the held transaction, the conflicting statement and
  // the pg_stat_activity poll each need their OWN backend connection at the same time. Sharing the
  // app's pool can starve the conflicting session so it never reaches the server and never blocks.
  let raceDb: PrismaClient;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability", "Media" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    capacity = t.app.get(LabourCapacityService);
    commercial = t.app.get(LabourProcurementService);
    vendors = t.app.get(VendorsService);
    devices = t.app.get(WorkerDevicesService);
    capabilities = t.app.get(CapabilitiesService);
    raceDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p4y-' } }],
      ['activity', { projectId: { startsWith: 'it-p4y-' } }],
      ['membership', { projectId: { startsWith: 'it-p4y-' } }],
      ['project', { id: { startsWith: 'it-p4y-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4y-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4Y-ACT-${Date.now() % 1e6}-${seq++}`;
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
  const workerWithDevice = async (projectId: string): Promise<{ workerId: string; deviceId: string }> => {
    const workerId = await onboardWorker(projectId);
    const device = await t.prisma.workerDevice.create({ data: { projectId, token: `tok-${Date.now()}-${seq++}` } });
    await devices.bind(projectId, device.id, { workerId }, pmc(projectId));
    return { workerId, deviceId: device.id };
  };
  /** a CommandExecution row so a RAW (service-bypassing) insert satisfies its provenance FK */
  const rawCommand = async (projectId: string, commandType: string): Promise<string> => {
    const project = await t.prisma.project.findFirstOrThrow({ where: { id: projectId }, select: { orgId: true } });
    const c = await t.prisma.commandExecution.create({
      data: { scopeKind: 'project', organizationId: project.orgId, projectId, actorId: f.memberUser.id, commandType, idempotencyKey: `c2-${Date.now()}-${seq++}`, requestHash: 'c2', status: 'succeeded' },
    });
    return c.id;
  };

  // ── barrier primitives (condition-based, never sleep-only) ────────────────────────────────────

  /** A one-shot gate the held transaction awaits, so the test controls exactly when it commits. */
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
  const waitUntilBlocked = async (queryLike: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
        queryLike,
      );
      if (Number(rows[0]!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected a backend blocked on a row lock while running ${queryLike}`);
  };
  /**
   * ROUND-3 CORRECTION (finding 3) MOVED THE SERIALIZATION POINT EARLIER — and this barrier follows
   * it. A raw `WorkerAllocation` insert now takes the per-project readiness ADVISORY lock as its very
   * first act (`WorkerAllocation_00_project_lock`), before any requirement-root or commitment row
   * lock. So when session A is a raw allocation held open, a second same-project writer — canonical
   * cancel or canonical allocate — blocks on `pg_advisory_xact_lock` and never reaches its
   * `ActivityRequirementRoot … FOR UPDATE`. Waiting on the root text would now time out even though
   * the two sessions ARE serialized, and serialized strictly earlier than before.
   *
   * The probes' assertions are unchanged; only where the wait is observed moved.
   *
   * The wait is scoped to THIS PROJECT's advisory key, not to "some ungranted advisory lock
   * anywhere". A global count is satisfied by any unrelated backend — a sibling suite, another
   * project — so it could open the gate before the racing session ever reached the readiness lock,
   * and the probe would then pass on a plain serial execution having proven nothing. Each probe uses
   * a fresh project, so the key identifies exactly the contention under test.
   *
   * `pg_advisory_xact_lock(bigint)` records the key split across `pg_locks`: `classid` is its high
   * 32 bits and `objid` its low 32 (both `oid`, i.e. unsigned), with `objsubid = 1`. The same
   * `hashtextextended('readiness:' || projectId, 0)` the lock protocol computes is split the same way
   * here, so the comparison is against the real key rather than a restatement of it.
   */
  const waitUntilBlockedOnProjectLock = async (projectId: string): Promise<void> => {
    const sql = `
      SELECT COUNT(*)::int AS c
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory'
         AND NOT l.granted
         AND l.objsubid = 1
         AND a.state = 'active'
         AND a.pid <> pg_backend_pid()
         AND l.classid::bigint = ((hashtextextended('readiness:' || $1, 0) >> 32) & 4294967295)
         AND l.objid::bigint   =  (hashtextextended('readiness:' || $1, 0)       & 4294967295)`;
    for (let i = 0; i < 200; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(sql, projectId);
      if (Number(rows[0]!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected a backend blocked on project ${projectId}'s readiness advisory lock`);
  };

  // ── FINDING 1 — the manual muster's justification is part of the observation ───────────────────

  it('1a: a direct UPDATE of `manualReason` is REJECTED — the exception text is frozen with the evidence', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);

    const muster = await capacity.recordAttendance(
      projectId,
      { workerId, civilDate: '2026-08-10', shift: 'day', manualReason: 'device battery dead at gate' },
      pmc(projectId),
    );

    // RED at e7e8744: `phase4_t3_attendance_append_only` freezes an explicit column list written
    // BEFORE `manualReason` existed, so this UPDATE succeeded and the recorded justification for an
    // unevidenced presence claim could be rewritten to anything, at any time, by anyone with DB access.
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "LabourAttendance" SET "manualReason" = 'supervisor confirmed verbally' WHERE "id" = $1`,
        muster.id,
      ),
    ).rejects.toThrow(/APPEND-ONLY/i);

    const after = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: muster.id } });
    expect(after.manualReason, 'the original reason survives verbatim').toBe('device battery dead at gate');
  });

  it('1b: a whitespace-only `manualReason` is REJECTED at the database — a blank reason is not a reason', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const commandId = await rawCommand(projectId, 'labour.attendance.record');

    // RED at e7e8744: `LabourAttendance_trusted_evidence` only tests IS NOT NULL, so a string of
    // spaces passed — an unevidenced presence claim wearing an empty justification, which is exactly
    // the state the finding says the Team gate must never read as execution truth.
    // The set is the COMPLETE ASCII whitespace class. `\v` and `\f` are here because the first draft
    // used `btrim(x, E' \t\r\n')` — which strips neither — so a vertical-tab-only reason passed the
    // CHECK. Unreachable from a keyboard, entirely reachable through an import or a raw write.
    for (const blank of ['', '   ', '\t', '\n  \t ', '\v', '\f', '\v\f\t \r\n']) {
      await expect(
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId")
           VALUES ($1,$2,$3,DATE '2026-08-10','day',$4,$5,$6)`,
          `blank-${seq++}`, projectId, workerId, blank, f.memberUser.id, commandId,
        ),
        `a manualReason of ${JSON.stringify(blank)} must be rejected`,
      ).rejects.toThrow(/manual_reason|manualReason|non_blank|check constraint/i);
    }
    expect(await t.prisma.labourAttendance.count({ where: { projectId } })).toBe(0);
  });

  it('1c: device musters, manual musters and the one-time revocation all still succeed (precision, not just strictness)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const { workerId: deviceWorker, deviceId } = await workerWithDevice(projectId);
    const manualWorker = await onboardWorker(projectId);

    // the device path — untouched by this correction
    const byDevice = await capacity.recordAttendance(
      projectId, { workerId: deviceWorker, civilDate: '2026-08-10', shift: 'day', deviceId }, pmc(projectId),
    );
    expect(byDevice.deviceId).toBe(deviceId);
    expect(byDevice.manualReason).toBeNull();

    // the modelled exception — still permitted, still attributable
    const byHand = await capacity.recordAttendance(
      projectId, { workerId: manualWorker, civilDate: '2026-08-10', shift: 'day', manualReason: 'phone left at home' }, pmc(projectId),
    );
    expect(byHand.manualReason).toBe('phone left at home');

    // the ONE permitted transition survives the tightened freeze: revocation stamps and nothing else
    const revoked = await capacity.revokeAttendance(projectId, byHand.id, { reason: 'recorded against the wrong worker' }, pmc(projectId));
    expect(revoked.revokedAt).toBeTruthy();
    const row = await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id: byHand.id } });
    expect(row.manualReason, 'revocation preserves the original exception text').toBe('phone left at home');
    expect(row.revokeReason).toBe('recorded against the wrong worker');

    // and a revoked muster stays terminal
    await expect(
      capacity.revokeAttendance(projectId, byHand.id, { reason: 'again' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ── FINDING 3 — cancel and allocate serialize on the SAME row ─────────────────────────────────

  /** The raw, service-bypassing allocation insert — the writer that took no serialization lock. */
  const rawAllocationSql = (
    a: { id: string; projectId: string; workerId: string; activityId: string; requirementId: string; revision: number; fingerprint: string; commandId: string; userId: string },
  ) =>
    `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","allocatedById","sourceCommandId")
     VALUES ('${a.id}','${a.projectId}','${a.workerId}',DATE '2026-08-10','day','${a.activityId}','${a.requirementId}',${a.revision},'${a.fingerprint}','${a.userId}','${a.commandId}')`;

  /** an ISSUED labour PO line + its CapacityCommitment for ONE (civilDate, qty) slice */
  const committedCapacity = async (
    projectId: string, req: { requirementId: string; revision: number }, civilDate: string, qty: number,
  ): Promise<string> => {
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: qty }] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: qty }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    await commercial.issuePo(projectId, po.id, pmc(projectId));
    return (await commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId))).id;
  };

  const allocationChain = async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-10', personShiftQty: 2 }]);
    const workerId = await onboardWorker(projectId);
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({
      where: { projectId, requirementId: req.requirementId }, orderBy: { revision: 'desc' },
    });
    const commandId = await rawCommand(projectId, 'labour.allocation.allocate');
    return {
      projectId, activityId, req, workerId,
      alloc: {
        id: `race-${seq++}`, projectId, workerId, activityId,
        requirementId: req.requirementId, revision: spec.revision,
        fingerprint: spec.labourSpecFingerprint, commandId, userId: f.memberUser.id,
      },
    };
  };

  /** The terminal invariant, asserted after BOTH orderings: the pair is never simultaneously true. */
  const assertCoherent = async (projectId: string, requirementId: string): Promise<{ cancelled: boolean; active: number }> => {
    const head = await t.prisma.activityRequirement.findFirstOrThrow({
      where: { projectId, requirementId }, orderBy: { revision: 'desc' }, select: { status: true },
    });
    const active = await t.prisma.workerAllocation.count({ where: { projectId, requirementId, status: 'active' } });
    const cancelled = head.status === 'cancelled';
    expect(cancelled && active > 0, 'a cancelled head must NEVER coexist with an active allocation').toBe(false);
    return { cancelled, active };
  };

  it('3a: RAW allocation first, canonical cancel second — the cancel blocks on the root, then refuses to strand it', async () => {
    const c = await allocationChain();
    const held = gate();    // A → test: my insert ran; I hold the root lock
    const release = gate(); // test → A: you may commit now

    // Session A: the raw allocation, held open. Its trigger must take the ActivityRequirementRoot
    // lock — that is the whole fix; at e7e8744 it took none, so B sailed past.
    const sessionA = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(rawAllocationSql(c.alloc));
      held.open();
      await release.promise;
    }, { timeout: 30_000, maxWait: 10_000 });

    // BARRIER 1 — "allocation FIRST" is a fact, not a hope: B is not dispatched until A's insert has
    // actually executed. (Without this the cancel can win outright, and the probe silently tests
    // nothing: `$transaction` must acquire a connection and BEGIN before its body runs.)
    await held.promise;

    // Session B: the CANONICAL cancel, which locks the same root in `lockRootHead`.
    const sessionB = reflect(
      requirements.cancel(c.projectId, c.req.requirementId, { expectedRevision: c.req.revision, reason: 'scope dropped' }, pmc(c.projectId)),
    );

    // BARRIER 2 — proceed only once B is genuinely waiting. Since the round-3 correction, session A's
    // raw insert holds the per-project readiness advisory lock, so B (which takes it as the first
    // statement of `cancel`) waits THERE, one step before the root it would otherwise contend for.
    await waitUntilBlockedOnProjectLock(c.projectId);
    release.open();
    await sessionA;
    const b = await sessionB;

    // Exactly one semantic outcome wins: the allocation committed, so the cancel must refuse rather
    // than strand it (409 — the disposition is "release it first", per the Task-3 correction rule).
    expect(b.status, 'the cancel must SEE the now-committed allocation and refuse').toBe('rejected');
    expect(b.status === 'rejected' && b.reason).toMatchObject({ status: 409 });
    const state = await assertCoherent(c.projectId, c.req.requirementId);
    expect(state).toEqual({ cancelled: false, active: 1 });
  });

  it('3b: cancel first, RAW allocation second — the allocation blocks on the root, then sees the cancelled head', async () => {
    const c = await allocationChain();
    const held = gate();    // A → test: the cancellation revision is written; I hold the root lock
    const release = gate(); // test → A: you may commit now
    const cancelRevision = c.req.revision + 1;

    // Session A replicates, in SQL, exactly what `RequirementsService.cancel` writes: it takes the
    // SAME `ActivityRequirementRoot` lock (`lockRootHead`), then APPENDS a cancellation revision
    // copying the head's neutral columns and its labour detail verbatim (the type↔detail
    // correspondence trigger and the deferred demand seal both hold, so this is a legal cancelled
    // head, not a forgery). Raw rather than the service call because the transaction must stay OPEN
    // across session B's attempt — a service call commits atomically and cannot be paused.
    const sessionA = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "ActivityRequirementRoot" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`,
        c.projectId, c.req.requirementId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ActivityRequirement"
           ("id","projectId","requirementId","revision","activityId","type","status","baseUom","requiredQty","requiredBy","responsibleId","criticality","tolerance","createdById")
         SELECT $1,"projectId","requirementId",${cancelRevision},"activityId","type",'cancelled',"baseUom","requiredQty","requiredBy","responsibleId","criticality","tolerance",$2
           FROM "ActivityRequirement"
          WHERE "projectId" = $3 AND "requirementId" = $4 AND "revision" = ${c.req.revision}`,
        `cancel-rev-${seq++}`, f.memberUser.id, c.projectId, c.req.requirementId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "LabourRequirementSpec"
           ("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint","decisionId","decisionVersion","optionKey")
         SELECT $1,"projectId","requirementId",${cancelRevision},"tradeCode","skillCode","shift","labourSpecFingerprint","decisionId","decisionVersion","optionKey"
           FROM "LabourRequirementSpec"
          WHERE "projectId" = $2 AND "requirementId" = $3 AND "revision" = ${c.req.revision}`,
        `cancel-spec-${seq++}`, c.projectId, c.req.requirementId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "LabourDemandSlice" ("id","projectId","requirementId","revision","civilDate","personShiftQty")
         SELECT "id" || '-x',"projectId","requirementId",${cancelRevision},"civilDate","personShiftQty"
           FROM "LabourDemandSlice"
          WHERE "projectId" = $1 AND "requirementId" = $2 AND "revision" = ${c.req.revision}`,
        c.projectId, c.req.requirementId,
      );
      held.open();
      await release.promise;
    }, { timeout: 30_000, maxWait: 10_000 });

    // BARRIER 1 — "cancel FIRST" is a fact: B is not dispatched until A holds the root lock and has
    // written the cancellation revision.
    await held.promise;

    // Session B: the raw allocation. Its trigger must block on A's root lock, then re-read the head.
    const sessionB = reflect(raceDb.$executeRawUnsafe(rawAllocationSql(c.alloc)));

    // BARRIER 2 — the allocation INSERT is the top-level statement pg_stat_activity reports while
    // the trigger inside it waits on the root row.
    await waitUntilBlocked('%INSERT INTO "WorkerAllocation"%');
    release.open();
    await sessionA;
    const b = await sessionB;

    // RED at e7e8744: the trigger's plain SELECT saw the OLD head (A uncommitted) and admitted the
    // row, so both committed — a cancelled requirement carrying an active allocation.
    expect(b.status, 'the allocation must observe the committed cancellation and be rejected').toBe('rejected');
    expect(b.status === 'rejected' && String(b.reason)).toMatch(/cancelled/i);
    const state = await assertCoherent(c.projectId, c.req.requirementId);
    expect(state).toEqual({ cancelled: true, active: 0 });
  });

  // ── LOCK ORDER — a raw allocation and the canonical one never form a cycle ────────────────────

  /**
   * Re-review finding: the two rows an allocation touches are the requirement ROOT and the
   * CAPACITY COMMITMENT. PostgreSQL fires BEFORE INSERT row triggers in NAME order, so the insert
   * itself takes `WorkerAllocation_head_live` (root) then `WorkerAllocation_within_commitment`
   * (commitment) — root → commitment. The service used to lock the commitment FIRST and only reach
   * the root inside its own insert, i.e. commitment → root. A raw insert holding the root and
   * waiting for the commitment, against a canonical allocate holding the commitment and waiting for
   * the root, is a lock CYCLE: PostgreSQL breaks it by aborting one otherwise-valid allocation.
   *
   * `requirementHead` now takes the root FIRST, so every path requests the pair in the same order
   * and one simply waits. Both orderings are driven here; neither may produce a deadlock (40P01),
   * and the §F bound-3 quantity of 1 still admits exactly one winner.
   */
  const lockOrderChain = async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const commitmentId = await committedCapacity(projectId, req, '2026-08-10', 1);
    const [wRaw, wSvc] = [await onboardWorker(projectId), await onboardWorker(projectId)];
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({
      where: { projectId, requirementId: req.requirementId }, orderBy: { revision: 'desc' },
    });
    const commandId = await rawCommand(projectId, 'labour.allocation.allocate');
    const rawInsert =
      `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","capacityCommitmentId","allocatedById","sourceCommandId")
       VALUES ('lo-${seq++}','${projectId}','${wRaw}',DATE '2026-08-10','day','${activityId}','${req.requirementId}',${spec.revision},'${spec.labourSpecFingerprint}','${commitmentId}','${f.memberUser.id}','${commandId}')`;
    return { projectId, activityId, req, commitmentId, wSvc, rawInsert };
  };

  const isDeadlock = (e: unknown) => /deadlock detected|40P01/i.test(String(e));

  it('lock order: a RAW allocation holding the root, then the canonical allocate — no deadlock, one winner', async () => {
    const c = await lockOrderChain();
    const held = gate();
    const release = gate();

    // Session A: raw insert — its triggers take root, then commitment. Held open.
    const sessionA = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(c.rawInsert);
      held.open();
      await release.promise;
    }, { timeout: 30_000, maxWait: 10_000 });
    await held.promise;

    // Session B: the CANONICAL path, which now takes the root before the commitment.
    const sessionB = reflect(
      capacity.allocate(c.projectId, { activityId: c.activityId, requirementId: c.req.requirementId, civilDate: '2026-08-10', workerId: c.wSvc, capacityCommitmentId: c.commitmentId }, pmc(c.projectId)),
    );
    // Since the round-3 correction the raw insert holds the per-project readiness advisory lock, so
    // the canonical allocate waits there — earlier than the root, and earlier than the commitment.
    await waitUntilBlockedOnProjectLock(c.projectId);
    release.open();
    await sessionA;
    const b = await sessionB;

    // The canonical side must LOSE on the bound (the single person-shift is taken) — never abort
    // with a deadlock, which would be the database destroying a valid request over lock ordering.
    expect(b.status).toBe('rejected');
    expect(b.status === 'rejected' && isDeadlock(b.reason), `must not be a deadlock: ${b.status === 'rejected' ? String(b.reason) : ''}`).toBe(false);
    expect(await t.prisma.workerAllocation.count({ where: { projectId: c.projectId, capacityCommitmentId: c.commitmentId, status: 'active' } })).toBe(1);
  });

  it('lock order: the canonical allocate holding both rows, then a RAW allocation — no deadlock, one winner', async () => {
    const c = await lockOrderChain();

    // The canonical allocation commits first, taking the single committed person-shift…
    const first = await capacity.allocate(
      c.projectId, { activityId: c.activityId, requirementId: c.req.requirementId, civilDate: '2026-08-10', workerId: c.wSvc, capacityCommitmentId: c.commitmentId }, pmc(c.projectId),
    );
    expect(first.allocations).toHaveLength(1);

    // …so the raw insert is refused by the §F bound-3 trigger — on the bound, not on a lock cycle.
    const raw = await reflect(raceDb.$executeRawUnsafe(c.rawInsert));
    expect(raw.status).toBe('rejected');
    expect(raw.status === 'rejected' && isDeadlock(raw.reason), 'a bound refusal, never a deadlock').toBe(false);
    expect(raw.status === 'rejected' && String(raw.reason)).toMatch(/commit|bound|person-shift/i);
    expect(await t.prisma.workerAllocation.count({ where: { projectId: c.projectId, capacityCommitmentId: c.commitmentId, status: 'active' } })).toBe(1);
  });
});
