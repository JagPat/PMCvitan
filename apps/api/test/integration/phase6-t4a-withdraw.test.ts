import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { ActivitiesService } from '../../src/activities/activities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { PushService } from '../../src/push/push.service';
import { PUSH_CONSUMER } from '../../src/platform/outbox/consumers';
import { cancelQueuedPushBySubject } from '../../src/platform/outbox/cancellation';
import { emitEvent } from '../../src/platform/events';
import { pendingDecisionNotice, withdrawnDecisionNotice, isWithdrawnDecisionNotice } from '../../src/domain/notifications';
import { deriveDecisionReading } from '@vitan/shared';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4a — `decisions.withdraw` (plan §A), proven live against PostgreSQL through the
 * REAL application. The owner's live defect: a wrongly-published decision had no honest exit.
 *
 * Probes P1–P13 from the plan's §E table (P14's web half lives in apps/web/tests/decisions.test.ts):
 *   P1  withdraw lands `withdrawn` + evidence + register event + appended notice; keyed replay
 *       appends nothing
 *   P2  a draft is refused 409
 *   P3  approved/change are refused 409 naming the change request; the REVERSE ordering — a stale
 *       approve replayed against a now-withdrawn decision — is a deliberate 409 with no side effects
 *   P4  a blank/whitespace-only/absent reason is a 400 at the contract
 *   P5  client/contractor/engineer/consultant get 403; pmc succeeds
 *   P6  two concurrent withdraws admit exactly one (the readiness lock serializes; the loser's CAS
 *       count is 0 → 409)
 *   P7  double publish admits exactly one — publish's new CAS
 *   P8  the three DB seals against hostile SQL, incl. the legacy approved-with-empty-register row
 *       and the reverse-arm two-session barrier race in BOTH orderings
 *   P9  countPending and the client pending surfaces drop the decision
 *   P10 a withdrawn decision is invisible to every non-pmc role; the withdrawal notice is stripped;
 *       the pending notice is retired (stamp + legacy text shape with the multiplicity guard); a
 *       QUEUED decision.published push never reaches the client in either PROVABLE ordering
 *       (claim-after-withdraw; cancelled-during-lease); the check→send residual is DOCUMENTED (§A.4)
 *   P11 deriveDecisionReading('withdrawn') is `wait` with the honest reason, and a gated activity
 *       refuses to start with that reason
 *   P12 decision.withdrawn is cataloged end-to-end (asserted here on the emitted event's intent;
 *       the catalog/manifest equality pins live in the unit suites)
 *   P13 projection: live == projection == rebuild across a withdraw; a rebuild emits zero events
 */
describe('Phase 6 unit 4a — decisions.withdraw (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let query: DecisionsQueryService;
  let activities: ActivitiesService;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let raceDb: PrismaClient;
  let seq = 0;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;
  const client = (): AuthUser => ({ sub: f.memberUser.id, role: 'client', projectId: f.projectA.id }) as AuthUser;
  const human = { actorId: '', actorKind: 'human', actorName: 'Test PMC', actorRole: 'pmc' } as never as Parameters<typeof emitEvent>[1]['actor'];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    query = t.app.get(DecisionsQueryService);
    activities = t.app.get(ActivitiesService);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    (human as { actorId: string }).actorId = f.memberUser.id;
    raceDb = new PrismaClient();
  });
  afterAll(async () => {
    await cleanup();
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DecisionApprovalRevision", "CommandExecution" CASCADE',
    );
    await t.prisma.notification.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.activity.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } });
    await t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } });
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } });
    // withdrawn rows are permanent in a LIVE register (`Decision_t4a_d_no_delete`); this
    // destructive test reset disables the named seal for exactly this wipe — the same
    // sanctioned-bypass contract as the TRUNCATE above (which fires no row-level trigger).
    await t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"');
    await t.prisma.decision.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"');
    await t.prisma.membership.deleteMany({ where: { userId: { startsWith: 'it-t4a-u-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-t4a-u-' } } });
    roleUsers.clear();
  }

  /** Seed one canonical published-pending decision with two options. */
  const seed = async (over: { status?: 'pending' | 'approved' | 'change'; draft?: boolean; title?: string } = {}): Promise<string> => {
    const id = `DL-t4a-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id,
        projectId: f.projectA.id,
        title: over.title ?? `Counter ${id}`,
        room: 'Kitchen',
        status: over.status ?? 'pending',
        ageDays: 0,
        photoSwatch: 'sw1',
        authorId: f.memberUser.id,
        publishedAt: over.draft ? null : new Date(),
      },
    });
    await t.prisma.decisionOption.createMany({
      data: [
        { decisionId: id, label: 'Granite', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
        { decisionId: id, label: 'Quartz', optionKey: 'b', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false, order: 1 },
      ],
    });
    return id;
  };

  /** A user + ACTIVE membership on project A in the given role — live authz validates the
   *  token against the MEMBERSHIP, so per-role probes need a member whose role matches. */
  const roleUsers = new Map<string, string>();
  const roleUser = async (role: string): Promise<string> => {
    const cached = roleUsers.get(role);
    if (cached) return cached;
    const uid = `it-t4a-u-${role}`;
    await t.prisma.user.upsert({
      where: { id: uid },
      create: { id: uid, projectId: f.projectA.id, role, name: `T4A ${role}`, email: `${uid}@t.local` },
      update: {},
    });
    const existing = await t.prisma.membership.findFirst({ where: { projectId: f.projectA.id, userId: uid } });
    if (!existing) await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: uid, role, status: 'active' } });
    roleUsers.set(role, uid);
    return uid;
  };

  const http = () => request(t.app.getHttpServer());
  const withdrawHttp = (id: string, token: string, body: unknown, key?: string) => {
    const req = http().post(`/projects/${f.projectA.id}/decisions/${id}/withdraw`).set('Authorization', `Bearer ${token}`);
    return key ? req.set('Idempotency-Key', key).send(body as object) : req.send(body as object);
  };

  // ── P1 — the command lands the terminal state with its evidence; keyed replay appends nothing ──
  it('P1: withdraw lands withdrawn + reason + actor; register event + appended notice; keyed replay appends nothing', async () => {
    const id = await seed();
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');

    const res = await withdrawHttp(id, token, { reason: 'Issued against the wrong room' }, 'w-key-1');
    expect(res.status).toBe(201);

    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('withdrawn');
    expect(d.withdrawReason).toBe('Issued against the wrong room');
    expect(d.withdrawnById).toBe(f.memberUser.id);
    expect(d.withdrawnByName).toBeTruthy();
    expect(d.withdrawnAt).not.toBeNull();
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'withdrawn' } })).toBe(1);
    const notices = await t.prisma.notification.findMany({ where: { projectId: f.projectA.id, decisionId: id } });
    expect(notices).toHaveLength(1);
    expect(isWithdrawnDecisionNotice(notices[0].text)).toBe(true);
    expect(notices[0].text).toContain('Issued against the wrong room');

    // keyed replay: same key + same payload → the same result, NOTHING appended
    const replay = await withdrawHttp(id, token, { reason: 'Issued against the wrong room' }, 'w-key-1');
    expect(replay.status).toBe(201);
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'withdrawn' } })).toBe(1);
    expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id, decisionId: id } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'decisions.withdraw' } })).toBe(1);
    // the emitted event is the cataloged decision.withdrawn with an invalidate-only intent (P12)
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { eventType: 'decision.withdrawn', entityId: id } });
    expect(ev.dispatchIntent).toMatchObject({ effectKey: 'decision.withdrawn', invalidate: true });
    expect((ev.dispatchIntent as { push?: unknown }).push).toBeUndefined();
  });

  // ── P2 — a draft needs no withdrawal ──
  it('P2: a DRAFT is refused 409', async () => {
    const id = await seed({ draft: true });
    await expect(svc.withdraw(f.projectA.id, id, { reason: 'x' }, pmc())).rejects.toMatchObject({ status: 409 });
  });

  // ── P3 — approvals are kept authoritative, in BOTH directions ──
  it('P3: approved/change refuse 409 naming the change request; a stale approve against a withdrawn decision is a deliberate 409 with no side effects', async () => {
    const approved = await seed({ status: 'approved' });
    await expect(svc.withdraw(f.projectA.id, approved, { reason: 'x' }, pmc())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('change request'),
    });
    const reopened = await seed({ status: 'change' });
    await expect(svc.withdraw(f.projectA.id, reopened, { reason: 'x' }, pmc())).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.decisionApprovalRevision.count()).toBe(0); // the register is untouched

    // REVERSE ordering: withdraw first, then a stale client replays an approval with a fresh key —
    // a deliberate 409 from the service guard (`prior ∈ {pending, change}` BEFORE the CAS), never a
    // raw trigger error, and NO side effects (no revision, no register event, no notice).
    const id = await seed();
    await svc.withdraw(f.projectA.id, id, { reason: 'taken back' }, pmc());
    const before = {
      revisions: await t.prisma.decisionApprovalRevision.count({ where: { decisionId: id } }),
      events: await t.prisma.decisionEvent.count({ where: { decisionId: id } }),
      notices: await t.prisma.notification.count({ where: { projectId: f.projectA.id } }),
    };
    await expect(svc.approve(f.projectA.id, id, { optionIndex: 0 }, client(), 'stale-approve-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('withdrawn'),
    });
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: id } })).toBe(before.revisions);
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id } })).toBe(before.events);
    expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id } })).toBe(before.notices);
  });

  // ── P4 — the reason is required at the CONTRACT ──
  it('P4: a blank, whitespace-only, or absent reason is a 400 at the contract', async () => {
    const id = await seed();
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    expect((await withdrawHttp(id, token, { reason: '' })).status).toBe(400);
    expect((await withdrawHttp(id, token, { reason: ' \t\n ' })).status).toBe(400);
    expect((await withdrawHttp(id, token, {})).status).toBe(400);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
  });

  // ── P5 — pmc-only authority ──
  it('P5: client/contractor/engineer/consultant get 403; pmc succeeds', async () => {
    const id = await seed();
    for (const role of ['client', 'contractor', 'engineer', 'consultant'] as const) {
      // a REAL active member of that role — so the 403 is the route policy, not a
      // token-vs-membership mismatch
      const uid = await roleUser(role);
      const token = t.issueProjectToken(uid, f.projectA.id, role);
      expect((await withdrawHttp(id, token, { reason: 'x' })).status, role).toBe(403);
    }
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    expect((await withdrawHttp(id, token, { reason: 'legitimate' })).status).toBe(201);
  });

  // ── P6 — two concurrent withdraws admit exactly one ──
  it('P6: two concurrent withdraws admit exactly one (CAS 409 for the loser)', async () => {
    const id = await seed();
    const [a, b] = await Promise.allSettled([
      svc.withdraw(f.projectA.id, id, { reason: 'first' }, pmc(), 'race-a'),
      svc.withdraw(f.projectA.id, id, { reason: 'second' }, pmc(), 'race-b'),
    ]);
    const outcomes = [a, b].map((r) => r.status);
    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((s) => s === 'rejected')).toHaveLength(1);
    const loser = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((loser.reason as { status?: number }).status).toBe(409);
    // exactly one register event, one notice, one command — the loser left nothing
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'withdrawn' } })).toBe(1);
    expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id, decisionId: id } })).toBe(1);
  });

  // ── P7 — publish's new CAS (the neighbour repair) ──
  it('P7: double publish admits exactly one — publishedAt stamped once, one issued event, one notice', async () => {
    const id = await seed({ draft: true });
    const [a, b] = await Promise.allSettled([
      svc.publish(f.projectA.id, id, pmc(), 'pub-a'),
      svc.publish(f.projectA.id, id, pmc(), 'pub-b'),
    ]);
    expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([a, b].filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'issued' } })).toBe(1);
    expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id, decisionId: id } })).toBe(1);
  });

  // ── P8 — the three seals against hostile SQL ──
  describe('P8: the DB seals', () => {
    const raw = (sql: string, ...params: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...params);
    /** a decision withdrawn through the real command (so its evidence is coherent) */
    const withdrawn = async (): Promise<string> => {
      const id = await seed();
      await svc.withdraw(f.projectA.id, id, { reason: 'sealed' }, pmc());
      return id;
    };

    it('terminal: withdrawn → pending/approved/change is refused', async () => {
      const id = await withdrawn();
      for (const target of ['pending', 'approved', 'change']) {
        await expect(raw(`UPDATE "Decision" SET "status"='${target}' WHERE "id"=$1`, id)).rejects.toThrow(/terminal/);
      }
    });

    it('evidence freeze: rewriting withdrawnAt/withdrawnById/withdrawnByName/withdrawReason on a withdrawn row is refused', async () => {
      const id = await withdrawn();
      await expect(raw(`UPDATE "Decision" SET "withdrawReason"='rewritten' WHERE "id"=$1`, id)).rejects.toThrow(/write-once/);
      await expect(raw(`UPDATE "Decision" SET "withdrawnByName"='Somebody Else' WHERE "id"=$1`, id)).rejects.toThrow(/write-once/);
      await expect(raw(`UPDATE "Decision" SET "withdrawnAt"=now() - interval '1 year' WHERE "id"=$1`, id)).rejects.toThrow(/write-once/);
    });

    it('coherence: unattributed withdrawal, whitespace-only reason, forged actor, and orphaned evidence are all unrepresentable', async () => {
      const id = await seed();
      // no evidence at all
      await expect(raw(`UPDATE "Decision" SET "status"='withdrawn' WHERE "id"=$1`, id)).rejects.toThrow(/must carry/);
      // whitespace-only reason (tabs/newlines — the btrim full-whitespace class)
      await expect(
        raw(`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=$2, "withdrawnByName"='X', "withdrawReason"=E'\t\n \x0B' WHERE "id"=$1`, id, f.memberUser.id),
      ).rejects.toThrow(/non-blank/);
      // a forged withdrawer naming no real member of THIS project (the FK)
      await expect(
        raw(`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"='ghost-user', "withdrawnByName"='Ghost', "withdrawReason"='forged' WHERE "id"=$1`, id),
      ).rejects.toThrow(/foreign key|violates/i);
      // withdrawal evidence on a NON-withdrawn row (the inverse arm)
      await expect(raw(`UPDATE "Decision" SET "withdrawReason"='orphan' WHERE "id"=$1`, id)).rejects.toThrow(/only on a withdrawn/);
      // and a decision cannot be BORN withdrawn
      await expect(
        raw(
          `INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","withdrawnAt","withdrawnById","withdrawnByName","withdrawReason") VALUES ('DL-born-w',$1,'T','R','withdrawn','sw',now(),$2,'X','r')`,
          f.projectA.id,
          f.memberUser.id,
        ),
      ).rejects.toThrow(/created withdrawn/);
    });

    it('never-approved (forward): a decision beside an approval revision refuses; a LEGACY approved row with an EMPTY register refuses by SOURCE STATE', async () => {
      // a pending decision that hostile SQL gave a register row — the belt arm refuses
      const id = await seed();
      await t.prisma.decisionApprovalRevision.create({
        data: { id: `dar-${id}-v1`, projectId: f.projectA.id, decisionId: id, version: 1, optionKey: 'a', approvedAt: new Date(), approvedById: f.memberUser.id },
      });
      await expect(
        raw(`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=$2, "withdrawnByName"='X', "withdrawReason"='r' WHERE "id"=$1`, id, f.memberUser.id),
      ).rejects.toThrow(/approval revision/);

      // the PR-#192 legacy class: an APPROVED decision whose register is EMPTY (an unprovable
      // legacy approval was deliberately not backfilled) — register emptiness is NOT proof, so
      // the SOURCE-STATE arm refuses the direct approved → withdrawn rewrite.
      const legacy = await seed({ status: 'approved' });
      expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: legacy } })).toBe(0);
      await expect(
        raw(`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=$2, "withdrawnByName"='X', "withdrawReason"='hide it' WHERE "id"=$1`, legacy, f.memberUser.id),
      ).rejects.toThrow(/only a published pending/);
    });

    it('round 2 (Codex): the PUBLICATION fact is part of the frozen record — clearing publishedAt on a withdrawn row is refused, so the pmc register can never lose the withdrawal to the draft filter', async () => {
      const id = await withdrawn();
      await expect(raw(`UPDATE "Decision" SET "publishedAt"=NULL WHERE "id"=$1`, id)).rejects.toThrow(/publishedAt|write-once|published/);
      // the row still serializes to the pmc with its evidence (the visibility rule's draft arm never fires)
      const slice = await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id);
      expect(slice.decisions.find((d) => d.id === id)?.status).toBe('withdrawn');
    });

    it('never-approved (reverse): an approval-revision INSERT against a withdrawn decision is refused', async () => {
      const id = await withdrawn();
      await expect(
        t.prisma.decisionApprovalRevision.create({
          data: { id: `dar-${id}-v1`, projectId: f.projectA.id, decisionId: id, version: 1, optionKey: 'a', approvedAt: new Date(), approvedById: f.memberUser.id },
        }),
      ).rejects.toThrow(/withdrawn/);
    });

    // ── the reverse arm RACED: two sessions, both orderings, exactly one side commits ──
    const reflect = <T,>(p: Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> =>
      p.then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }));
    const blockedWaiters = async (queryLike: string): Promise<number> => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
        queryLike,
      );
      return Number(rows[0]!.c);
    };
    const waitUntilBlocked = async (queryLike: string): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if ((await blockedWaiters(queryLike)) >= 1) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`barrier timeout: expected a backend blocked on the decision row lock while running ${queryLike}`);
    };

    it('ORDERING A (withdraw holds, insert waits): the uncommitted withdrawal holds the row lock; the hostile revision INSERT blocks on FOR UPDATE, then is refused', async () => {
      const id = await seed();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let updated!: () => void;
      const updatedP = new Promise<void>((r) => (updated = r));
      // Session A: the withdrawal UPDATE, held open (uncommitted) — `updated` resolves once the
      // statement has executed at the server, so A provably holds the row lock before B starts.
      const a = raceDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=$2, "withdrawnByName"='X', "withdrawReason"='held' WHERE "id"=$1`,
            id,
            f.memberUser.id,
          );
          updated();
          await gate;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      await updatedP;
      const b = reflect(
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById") VALUES ($1,$2,$3,1,'a',now(),$4)`,
          `dar-${id}-race-a`,
          f.projectA.id,
          id,
          f.memberUser.id,
        ),
      );
      await waitUntilBlocked('%INSERT INTO "DecisionApprovalRevision"%');
      release();
      await a; // the withdrawal commits
      const rb = await b; // the blocked insert resumes, sees 'withdrawn' under the lock, and is refused
      expect(rb.status).toBe('rejected');
      expect(String((rb as { reason: unknown }).reason)).toMatch(/withdrawn/);
      expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: id } })).toBe(0);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
    });

    it('ORDERING B (insert holds, withdraw waits): the uncommitted revision INSERT holds the row lock; the withdrawal blocks, then the forward arm sees the committed register row and refuses', async () => {
      const id = await seed();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const insertedP = new Promise<void>((r) => (inserted = r));
      // Session A: the hostile revision INSERT (its trigger takes FOR UPDATE on the decision
      // row), held open — `inserted` resolves once the statement holds the lock.
      const a = raceDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById") VALUES ($1,$2,$3,1,'a',now(),$4)`,
            `dar-${id}-race-b`,
            f.projectA.id,
            id,
            f.memberUser.id,
          );
          inserted();
          await gate;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      await insertedP;
      const b = reflect(
        t.prisma.$executeRawUnsafe(
          `UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=$2, "withdrawnByName"='X', "withdrawReason"='racing' WHERE "id"=$1`,
          id,
          f.memberUser.id,
        ),
      );
      await waitUntilBlocked(`%UPDATE "Decision" SET "status"='withdrawn'%`);
      release();
      await a; // the revision commits
      const rb = await b; // the withdrawal resumes and the forward arm counts the committed row
      expect(rb.status).toBe('rejected');
      expect(String((rb as { reason: unknown }).reason)).toMatch(/approval revision/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
      expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: id } })).toBe(1);
    });
  });

  // ── P9 — the pending surfaces drop the decision ──
  it('P9: countPending and the pending snapshot list drop a withdrawn decision', async () => {
    const id = await seed();
    expect(await query.countPending(f.projectA.id)).toBe(1);
    await svc.withdraw(f.projectA.id, id, { reason: 'no longer asked' }, pmc());
    expect(await query.countPending(f.projectA.id)).toBe(0);
  });

  // ── P10 — audience: the decision, its notice, and the queued push ──
  describe('P10: a withdrawn decision reaches NO ONE but the pmc', () => {
    it('the row is invisible to client/contractor/engineer/consultant; the pmc sees it WITH its evidence; the withdrawal notice is pmc-only; the pending notice is retired', async () => {
      // the full product path: publish (stamped pending notice + client push intent) → withdraw
      const created = await svc.create(
        f.projectA.id,
        {
          title: 'Bedroom veneer',
          room: 'Bedroom',
          options: [
            { material: 'Teak', delta: 0, swatch: 'sw1', recommended: true },
            { material: 'Oak', delta: 500, swatch: 'sw2', recommended: false },
          ],
          publish: true,
        } as never,
        pmc(),
      );
      const id = created.decisions.find((d) => d.title === 'Bedroom veneer')!.id;
      expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id, decisionId: id, text: pendingDecisionNotice('Bedroom veneer') } })).toBe(1);

      await svc.withdraw(f.projectA.id, id, { reason: 'wrong room entirely' }, pmc());

      // the pending notice is RETIRED (stamp-based); the withdrawal notice replaces it
      const remaining = await t.prisma.notification.findMany({ where: { projectId: f.projectA.id, decisionId: id } });
      expect(remaining).toHaveLength(1);
      expect(isWithdrawnDecisionNotice(remaining[0].text)).toBe(true);

      // the serialized snapshot: pmc sees the row with its evidence; every other role sees NO row
      // and NO withdrawal notice; the client bell carries NO stale awaiting item
      const pmcSlice = await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id);
      const pmcRow = pmcSlice.decisions.find((d) => d.id === id);
      expect(pmcRow?.status).toBe('withdrawn');
      expect(pmcRow?.withdrawReason).toBe('wrong room entirely');
      expect(pmcRow?.withdrawnBy).toBeTruthy();
      expect(pmcRow?.withdrawnAt).toBeTruthy();
      for (const role of ['client', 'contractor', 'engineer', 'consultant'] as const) {
        const slice = await query.snapshotSlice(f.projectA.id, role, 'someone-else');
        expect(slice.decisions.find((d) => d.id === id), `role=${role} must not see the withdrawn row`).toBeUndefined();
      }
      // the notice-stripping half at the snapshot: the withdrawal notice reaches ONLY the pmc feed
      const pmcSnap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc')}`);
      expect(pmcSnap.status).toBe(200);
      expect((pmcSnap.body.notifications as Array<{ text: string }>).some((n) => isWithdrawnDecisionNotice(n.text))).toBe(true);
      for (const role of ['client', 'contractor', 'engineer', 'consultant'] as const) {
        const uid = await roleUser(role);
        const snap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(uid, f.projectA.id, role)}`);
        expect(snap.status).toBe(200);
        const texts = (snap.body.notifications as Array<{ text: string }>).map((n) => n.text);
        expect(texts.some((x) => isWithdrawnDecisionNotice(x)), `role=${role} must not receive the withdrawal notice`).toBe(false);
        expect(texts).not.toContain(pendingDecisionNotice('Bedroom veneer'));
        expect(snap.body.decisions.find((d: { id: string }) => d.id === id), `role=${role} snapshot row`).toBeUndefined();
      }
    });

    it('a LEGACY unstamped pending notice retires by text shape; an ambiguous title leaves the rows and reports it in the register', async () => {
      // unambiguous: one pending decision, one legacy (unstamped) notice with its exact text
      const id = await seed({ title: 'Legacy title' });
      await t.prisma.notification.create({ data: { projectId: f.projectA.id, text: pendingDecisionNotice('Legacy title'), color: '#C08A2D', time: '2d ago' } });
      await svc.withdraw(f.projectA.id, id, { reason: 'legacy retirement' }, pmc());
      expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id, decisionId: null, text: pendingDecisionNotice('Legacy title') } })).toBe(0);

      // ambiguous: TWO pending published decisions share the title — the legacy text cannot be
      // attributed, so the rows are LEFT and the register event reports it
      const one = await seed({ title: 'Shared title' });
      await seed({ title: 'Shared title' });
      await t.prisma.notification.create({ data: { projectId: f.projectA.id, text: pendingDecisionNotice('Shared title'), color: '#C08A2D', time: '3d ago' } });
      await svc.withdraw(f.projectA.id, one, { reason: 'ambiguous case' }, pmc());
      expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id, decisionId: null, text: pendingDecisionNotice('Shared title') } })).toBe(1);
      const ev = await t.prisma.decisionEvent.findFirstOrThrow({ where: { decisionId: one, type: 'withdrawn' } });
      expect(ev.payload).toMatchObject({ legacyNoticeLeftAmbiguous: true });
    });

    it('ORDERING claim-after-withdraw: a QUEUED decision.published push is cancelled by subject inside the withdraw tx — the relay finds nothing claimable', async () => {
      const id = await seed({ title: 'Queued push' });
      // the relay-lagging world, honestly: a committed decision.published event whose durable
      // push delivery is still pending (emitted directly; no immediate dispatcher ran)
      await t.prisma.$transaction((tx) =>
        emitEvent(tx, {
          projectId: f.projectA.id,
          actor: human,
          eventType: 'decision.published',
          entityType: 'Decision',
          entityId: id,
          effectKey: 'decision.published',
          dispatch: { push: { body: `New decision awaiting your approval: Queued push` } },
        }),
      );
      const queued = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, status: 'pending' } });
      expect(queued.subject).toBe(id); // the subject was stamped at materialization

      await svc.withdraw(f.projectA.id, id, { reason: 'outran the queue' }, pmc());

      // cancelled and RECORDED, never deleted: neutralized in place with the payload preserved
      const after = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: queued.id } });
      expect(after.status).toBe('succeeded');
      expect(after.deliveryAction).toBe('noop');
      expect(after.cancelledAt).not.toBeNull();
      expect(after.payload).toMatchObject({ body: expect.stringContaining('Queued push') });
      // a relay claiming after the commit finds nothing
      expect(await relay.claim(PUSH_CONSUMER)).toHaveLength(0);
    });

    it('ORDERING cancelled-during-lease: a row LEASED before the withdraw commits is dropped by the pre-send re-check — the push never reaches the client', async () => {
      const id = await seed({ title: 'Leased push' });
      await t.prisma.$transaction((tx) =>
        emitEvent(tx, {
          projectId: f.projectA.id,
          actor: human,
          eventType: 'decision.published',
          entityType: 'Decision',
          entityId: id,
          effectKey: 'decision.published',
          dispatch: { push: { body: `New decision awaiting your approval: Leased push` } },
        }),
      );
      const queued = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, status: 'pending' } });
      // the relay leases the row (the sender now owns it)…
      const claimed = await relay.claim(PUSH_CONSUMER);
      expect(claimed).toContain(queued.id);
      // …and the withdrawal commits DURING the lease window: only the mark lands (status kept)
      await svc.withdraw(f.projectA.id, id, { reason: 'cancelled mid-lease' }, pmc());
      const marked = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: queued.id } });
      expect(marked.status).toBe('leased');
      expect(marked.cancelledAt).not.toBeNull();
      // the sender's final pre-send re-check drops the send, recorded — and the push service is
      // NEVER invoked for it
      const push = t.app.get(PushService);
      const original = push.notifyProject.bind(push);
      let sends = 0;
      push.notifyProject = (async (...args: Parameters<PushService['notifyProject']>) => {
        sends += 1;
        return original(...args);
      }) as PushService['notifyProject'];
      try {
        expect(await relay.dispatchOne(queued.id)).toBe('succeeded');
      } finally {
        push.notifyProject = original;
      }
      expect(sends).toBe(0);
      const dropped = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: queued.id } });
      expect(dropped.status).toBe('succeeded');
      expect(dropped.deliveryAction).toBe('noop');
      expect(dropped.cancelledAt).not.toBeNull();
      // (the check→send in-flight residual is the DOCUMENTED §A.4 boundary, not a probe)
    });
  });

  // ── P11 — the honest gate reading ──
  it('P11: deriveDecisionReading(withdrawn) is wait with the honest reason, and a gated activity refuses to start with it', async () => {
    // the honest reason is pmc-only (round 1, Codex F5); the bare call is FAIL-CLOSED redacted
    const pmcReading = deriveDecisionReading('withdrawn', true);
    expect(pmcReading.v).toBe('wait');
    expect(pmcReading.reason).toBe('The linked decision was withdrawn — re-issue or relink');
    const redacted = deriveDecisionReading('withdrawn');
    expect(redacted.v).toBe('wait');
    expect(redacted.reason).toBe('Awaiting the PMC on the linked decision');

    const id = await seed();
    await t.prisma.activity.create({
      data: { id: `it-t4a-act-${seq}`, projectId: f.projectA.id, name: 'Veneer work', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na', decisionId: id },
    });
    await svc.withdraw(f.projectA.id, id, { reason: 'question unasked' }, pmc());
    await expect(activities.start(f.projectA.id, `it-t4a-act-${seq}`, pmc())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('withdrawn — re-issue or relink'),
    });
  });

  /** A committed `decision.published` event with its queued push delivery — returns the
   *  delivery row id. Shared by the round-1 and round-3 probes. */
  const emitQueuedPush = async (id: string, title: string): Promise<string> => {
    await t.prisma.$transaction((tx) =>
      emitEvent(tx, {
        projectId: f.projectA.id,
        actor: human,
        eventType: 'decision.published',
        entityType: 'Decision',
        entityId: id,
        payload: { title },
        effectKey: 'decision.published',
        dispatch: { push: { body: `New decision awaiting your approval: ${title}` } },
      }),
    );
    const row = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, status: 'pending' } });
    return row.id;
  };

  // ── Round 1 — the five Codex findings on head ea3391d, each reproduced RED before its fix ──
  describe('round 1 (Codex): recovery subject, dead-row cancellation, org-admin attribution, redacted readiness', () => {
    it('F1: a delivery re-created by the RECOVERY scanner carries the subject — a crash-gap row is not born uncancellable', async () => {
      const id = await seed({ title: 'Recovered push' });
      const deliveryId = await emitQueuedPush(id, 'Recovered push');
      // the documented crash/rolling-deploy gap: the event committed but its delivery row is missing
      await t.prisma.outboxDelivery.delete({ where: { id: deliveryId } });
      await relay.expandMissingDeliveries();
      const recovered = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, status: 'pending' } });
      expect(recovered.subject).toBe(id);
      // and the withdraw therefore cancels it exactly like an emit-time row
      await svc.withdraw(f.projectA.id, id, { reason: 'recovered then withdrawn' }, pmc());
      const after = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: recovered.id } });
      expect(after.cancelledAt).not.toBeNull();
      expect(after.status).toBe('succeeded');
      expect(after.deliveryAction).toBe('noop');
    });

    it('F3: a DEAD decision.published push is marked cancelled by the withdraw, so an operator redrive is a recorded noop — never a resurrected stale announcement', async () => {
      const id = await seed({ title: 'Dead push' });
      const deliveryId = await emitQueuedPush(id, 'Dead push');
      // the row exhausted its retries before the withdrawal
      await t.prisma.outboxDelivery.update({ where: { id: deliveryId }, data: { status: 'dead', lastError: 'endpoint gone' } });
      await svc.withdraw(f.projectA.id, id, { reason: 'dead then withdrawn' }, pmc());
      const dead = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(dead.status).toBe('dead'); // the dead history is kept…
      expect(dead.cancelledAt).not.toBeNull(); // …but the cancellation mark lands
      // an operator redrive resets it to pending; the sender's pre-send re-check drops it
      await t.prisma.outboxDelivery.update({ where: { id: deliveryId }, data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
      const push = t.app.get(PushService);
      const original = push.notifyProject.bind(push);
      let sends = 0;
      push.notifyProject = (async (...args: Parameters<PushService['notifyProject']>) => {
        sends += 1;
        return original(...args);
      }) as PushService['notifyProject'];
      try {
        expect(await relay.dispatchOne(deliveryId)).toBe('succeeded');
      } finally {
        push.notifyProject = original;
      }
      expect(sends).toBe(0);
      const dropped = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(dropped.status).toBe('succeeded');
      expect(dropped.deliveryAction).toBe('noop');
    });

    it('F4: an org owner/admin operating as pmc WITHOUT a project membership gets a clean refusal, never a rolled-back FK error', async () => {
      const id = await seed();
      // an org-A owner with NO Membership row on project A — authorized as pmc by the
      // org-super-admin path (project-access.service.ts), but not attributable via the FK
      expect(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId: f.ownerUser.id } })).toBe(0);
      const orgAdmin = { sub: f.ownerUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
      await expect(svc.withdraw(f.projectA.id, id, { reason: 'org admin attempt' }, orgAdmin)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('ACTIVE member'),
      });
      // no side effects: the decision is untouched and nothing was appended
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
      expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'withdrawn' } })).toBe(0);
    });

    it('F5: the baked readiness reason is REDACTED for viewers who cannot see withdrawn decisions; the pmc keeps the honest reason; the start refusal follows the starter', async () => {
      const id = await seed();
      const actId = `it-t4a-f5-${seq}`;
      await t.prisma.activity.create({
        data: { id: actId, projectId: f.projectA.id, name: 'Veneer work', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na', decisionId: id },
      });
      await svc.withdraw(f.projectA.id, id, { reason: 'secret operational reason' }, pmc());

      // an engineer (never saw the decision) can still see the ACTIVITY — the gate stays `wait`
      // but its reason must not disclose the withdrawal
      const engUid = await roleUser('engineer');
      const engSnap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(engUid, f.projectA.id, 'engineer')}`);
      expect(engSnap.status).toBe(200);
      const engAct = (engSnap.body.activities as Array<{ id: string; readiness: { decision: { v: string; reason: string } } }>).find((a) => a.id === actId);
      expect(engAct?.readiness.decision.v).toBe('wait');
      expect(engAct?.readiness.decision.reason).not.toContain('withdrawn');
      // the pmc keeps the honest reason
      const pmcSnap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc')}`);
      const pmcAct = (pmcSnap.body.activities as Array<{ id: string; readiness: { decision: { v: string; reason: string } } }>).find((a) => a.id === actId);
      expect(pmcAct?.readiness.decision.reason).toContain('withdrawn — re-issue or relink');

      // the start refusal follows the STARTER: an engineer's refusal is redacted, the pmc's is honest
      const engineer = { sub: engUid, role: 'engineer', projectId: f.projectA.id } as AuthUser;
      await expect(activities.start(f.projectA.id, actId, engineer)).rejects.toMatchObject({
        status: 409,
        message: expect.not.stringContaining('withdrawn'),
      });
      await expect(activities.start(f.projectA.id, actId, pmc())).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('withdrawn — re-issue or relink'),
      });
    });
  });

  // ── Round 3 — the three Codex findings on head 74af426, each reproduced RED before its fix ──
  describe('round 3 (Codex): delete seal, recovery tombstone', () => {
    it('R3-F1: a withdrawn decision cannot be DELETED — the register entry is permanent; a non-withdrawn decision (children cleared) still can be', async () => {
      const id = await seed({ title: 'Delete attempt' });
      await svc.withdraw(f.projectA.id, id, { reason: 'then attacked' }, pmc());
      // hostile SQL clears the children first (a FK refusal would otherwise mask the seal —
      // though BEFORE DELETE fires before FK evaluation, the probe proves the seal alone)
      await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
      await t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } });
      await t.prisma.decisionOption.deleteMany({ where: { decisionId: id } });
      await expect(t.prisma.$executeRaw`DELETE FROM "Decision" WHERE "id" = ${id}`).rejects.toThrow(/permanent register entry/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
      // precision, not mere strictness: a NON-withdrawn decision is still deletable
      const draft = await seed({ draft: true, title: 'Deletable draft' });
      await t.prisma.decisionOption.deleteMany({ where: { decisionId: draft } });
      expect(await t.prisma.$executeRaw`DELETE FROM "Decision" WHERE "id" = ${draft}`).toBe(1);
    });

    it('R3-F3: withdrawing INSIDE the recovery gap entombs the missing delivery — a later recovery pass cannot resurrect the stale push', async () => {
      const id = await seed({ title: 'Gap push' });
      const deliveryId = await emitQueuedPush(id, 'Gap push');
      // the rolling-deploy/crash gap the recovery scanner exists to repair: the
      // `decision.published` event committed but NO push delivery row exists yet
      await t.prisma.outboxDelivery.delete({ where: { id: deliveryId } });
      await svc.withdraw(f.projectA.id, id, { reason: 'withdrawn inside the gap' }, pmc());
      // the cancellation materialized the missing row ITSELF — already cancelled (no payload
      // was ever built), so the gap is closed at the only moment the domain knows it went stale
      const tomb = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, subject: id } });
      expect(tomb.status).toBe('succeeded');
      expect(tomb.deliveryAction).toBe('noop');
      expect(tomb.cancelledAt).not.toBeNull();
      // …and the withdrawn event's payload counts it as a cancelled intent
      const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, eventType: 'decision.withdrawn', entityId: id } });
      expect((ev.payload as { pushIntentsCancelled: number }).pushIntentsCancelled).toBe(1);
      // recovery finds the row present and creates nothing; nothing is pending; nothing sends
      await relay.expandMissingDeliveries();
      const resurrected = await t.prisma.outboxDelivery.findMany({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, status: 'pending' } });
      const push = t.app.get(PushService);
      const original = push.notifyProject.bind(push);
      let sends = 0;
      push.notifyProject = (async (...args: Parameters<PushService['notifyProject']>) => {
        sends += 1;
        return original(...args);
      }) as PushService['notifyProject'];
      try {
        for (const d of resurrected) await relay.dispatchOne(d.id);
      } finally {
        push.notifyProject = original;
      }
      expect(resurrected).toHaveLength(0);
      expect(sends).toBe(0);
    });
  });

  // ── Round 4 — the four Codex findings on head 31f3fba, each reproduced RED before its fix ──
  // (R4-F4, the migration cancelling pushes of an ALREADY-withdrawn decision, is a migration-level
  //  fact proven in upgrade-proof.sh — its plant/assert stage is the reproduce-first evidence.)
  describe('round 4 (Codex): subjectless rolling-deploy rows, frozen project identity, the scanner interleave', () => {
    it('R4-F1: a delivery materialized SUBJECTLESS by an old instance is stamped from its own event and cancelled — the rolling-deploy writer cannot orphan the announcement', async () => {
      const id = await seed({ title: 'Subjectless push' });
      const deliveryId = await emitQueuedPush(id, 'Subjectless push');
      // a migration-first rolling deploy: an OLD API instance (pre-4a code) materialized this
      // row AFTER the one-time backfill ran — the new nullable column is written NULL
      await t.prisma.outboxDelivery.update({ where: { id: deliveryId }, data: { subject: null } });
      await svc.withdraw(f.projectA.id, id, { reason: 'withdrawn during the rolling deploy' }, pmc());
      const row = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(row.subject).toBe(id); // identity restored from the row's OWN event, never invented
      expect(row.status).toBe('succeeded');
      expect(row.deliveryAction).toBe('noop');
      expect(row.cancelledAt).not.toBeNull();
      const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, eventType: 'decision.withdrawn', entityId: id } });
      expect((ev.payload as { pushIntentsCancelled: number }).pushIntentsCancelled).toBe(1);
    });

    it('R4-F2: the withdrawn register entry cannot be MOVED to another project — projectId joins the write-once set', async () => {
      const id = await seed({ title: 'Register move' });
      await svc.withdraw(f.projectA.id, id, { reason: 'then relocated' }, pmc());
      // the attack needs the FK to pass in the destination: the withdrawer holds an ACTIVE
      // membership on project B too (created here, removed in the finally)
      await t.prisma.membership.create({ data: { projectId: f.projectB.id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
      try {
        // children cleared so the RED capture demonstrates the real hole (the seal, once
        // installed, fires BEFORE any FK evaluation and needs no surviving children)
        await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
        await t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } });
        await t.prisma.decisionOption.deleteMany({ where: { decisionId: id } });
        await expect(
          t.prisma.$executeRaw`UPDATE "Decision" SET "projectId" = ${f.projectB.id} WHERE "id" = ${id}`,
        ).rejects.toThrow(/projectId is frozen/);
        expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).projectId).toBe(f.projectA.id);
      } finally {
        await t.prisma.membership.deleteMany({ where: { projectId: f.projectB.id, userId: f.memberUser.id } });
      }
    });

    it('R4-F3: a scanner row committing BETWEEN the cancellation passes and the tombstone insert is still neutralized — the interleave is closed by the repeat pass', async () => {
      const id = await seed({ title: 'Interleaved scanner' });
      const deliveryId = await emitQueuedPush(id, 'Interleaved scanner');
      // the recovery gap: the event exists, its delivery row does not
      await t.prisma.outboxDelivery.delete({ where: { id: deliveryId } });
      const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, eventType: 'decision.published', entityId: id } });

      const blockedWaiters = async (queryLike: string): Promise<number> => {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
          queryLike,
        );
        return Number(rows[0]!.c);
      };
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const insertedP = new Promise<void>((r) => (inserted = r));
      // Session B: the recovery scanner's create, held OPEN (uncommitted) — exactly the
      // interleaving Codex named: it commits after the cancellation's first passes scanned
      // (they cannot see it) and while the tombstone insert is in flight (which BLOCKS on the
      // in-flight unique conflict, then resolves to its handled no-op).
      const scanner = raceDb.$transaction(
        async (btx) => {
          await btx.$executeRawUnsafe(
            `INSERT INTO "OutboxDelivery"("id","eventId","projectId","consumer","consumerKind","streamPosition","deliveryAction","status","payload","subject","updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, 'webpush.notify', 'unordered', $3, 'dispatch', 'pending', '{"body":"stale"}', $4, now())`,
            ev.eventId, f.projectA.id, ev.streamPosition, id,
          );
          inserted();
          await gate;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      await insertedP;
      // The cancellation sequence — the exact function `decisions.withdraw` invokes in-tx
      // (P1/P10 prove that wiring); driven directly here so the barrier is deterministic.
      const cancel = t.prisma.$transaction(
        (tx) => cancelQueuedPushBySubject(tx, { projectId: f.projectA.id, subject: id, eventType: 'decision.published' }),
        { timeout: 20_000, maxWait: 10_000 },
      );
      // the cancellation is provably BLOCKED on the scanner's in-flight row before we let the
      // scanner commit — condition-based, never a sleep
      for (let i = 0; i < 200; i++) {
        if ((await blockedWaiters('%INSERT INTO "OutboxDelivery"%')) >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
        if (i === 199) throw new Error('barrier timeout: the cancellation never blocked on the scanner insert');
      }
      release();
      await scanner; // the scanner's pending row COMMITS mid-cancellation
      const counts = await cancel; // …and the repeat pass neutralizes it before the withdrawal commits
      expect(counts.neutralized).toBe(1);
      const row = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: ev.eventId, consumer: PUSH_CONSUMER } });
      expect(row.status).toBe('succeeded');
      expect(row.deliveryAction).toBe('noop');
      expect(row.cancelledAt).not.toBeNull();
      expect(await relay.claim(PUSH_CONSUMER)).toHaveLength(0);
    });
  });

  // ── Round 5 — the two Codex findings on head b24d36e ──
  // (R5-F1, the migration's recovery-gap tombstone for pre-withdrawn decisions, is a
  //  migration-level fact proven in upgrade-proof.sh — its plant/assert stage is the
  //  reproduce-first evidence. R5-F2's behavioural capture ran the REAL seed against a database
  //  holding a withdrawn decision: RED at b24d36e — membership.deleteMany refused by the
  //  withdrawnById FK before the guarded wipe ever ran — then GREEN after the reorder. This pin
  //  makes the ordering durable.)
  describe('round 5 (Codex): the seed wipe order', () => {
    it('R5-F2: the guarded decision wipe PRECEDES the membership wipe in seed.ts — the withdrawnById FK makes a withdrawn decision block membership deletion', () => {
      const seedSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prisma/seed.ts'), 'utf8');
      const decisionWipe = seedSrc.indexOf('prisma.decision.deleteMany()');
      const membershipWipe = seedSrc.indexOf('prisma.membership.deleteMany()');
      expect(decisionWipe).toBeGreaterThan(-1);
      expect(membershipWipe).toBeGreaterThan(-1);
      expect(decisionWipe, 'the guarded decision wipe must run before membership.deleteMany — Decision.withdrawnById FKs Membership(projectId,userId) ON DELETE NO ACTION').toBeLessThan(membershipWipe);
    });

    it('R6-F4: the disable → wipe → enable trio is ONE transaction — a failed wipe rolls the DISABLE back, so no failure path leaves the delete seal off', () => {
      const seedSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prisma/seed.ts'), 'utf8');
      const disableIdx = seedSrc.indexOf('DISABLE TRIGGER "Decision_t4a_d_no_delete"');
      const wipeIdx = seedSrc.indexOf('prisma.decision.deleteMany()');
      const enableIdx = seedSrc.indexOf('ENABLE TRIGGER "Decision_t4a_d_no_delete"');
      expect(disableIdx).toBeGreaterThan(-1);
      const txIdx = seedSrc.lastIndexOf('prisma.$transaction([', disableIdx);
      expect(txIdx, 'the trigger disable must open inside a prisma.$transaction array').toBeGreaterThan(-1);
      expect(wipeIdx).toBeGreaterThan(disableIdx);
      expect(enableIdx).toBeGreaterThan(wipeIdx);
      // no awaited statement may sit between the transaction open and the re-enable — the trio
      // is one atomic expression, not three independent round-trips
      expect(seedSrc.slice(txIdx + 'prisma.$transaction(['.length, enableIdx)).not.toContain('await ');
    });
  });

  // ── Round 7 — the two Codex findings on head fbe760d: ENTRY-transition twins of sealed arms ──
  describe('round 7 (Codex): the entry transition carries the freezes too', () => {
    it('R7-F1: one statement cannot withdraw AND move the decision — projectId is frozen on the entry transition, not only on already-withdrawn rows', async () => {
      const id = await seed({ title: 'Withdraw-and-move' });
      // the destination membership makes the FK pass — the coherence/FK arms alone would
      // accept the moved row (the round-4 freeze fires only when OLD.status is withdrawn)
      await t.prisma.membership.create({ data: { projectId: f.projectB.id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
      try {
        await expect(
          t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='moved on entry', "projectId"=${f.projectB.id} WHERE "id"=${id}`,
        ).rejects.toThrow(/projectId is frozen on entry/);
        const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
        expect(after.status).toBe('pending');
        expect(after.projectId).toBe(f.projectA.id);
      } finally {
        await t.prisma.membership.deleteMany({ where: { projectId: f.projectB.id, userId: f.memberUser.id } });
      }
    });

    it('R7-F2: one statement cannot withdraw AND add approval evidence — the coherence seal refuses approval signals on any withdrawn row', async () => {
      const id = await seed({ title: 'Withdraw-with-approval' });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='forged approval alongside', "approvedById"=${f.memberUser.id}, "approver"='Forged Client', "approvedOption"='A' WHERE "id"=${id}`,
      ).rejects.toThrow(/cannot carry approval evidence/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
      // …and the arm also guards an ALREADY-withdrawn row (the terminal freeze covers only the
      // withdrawal columns; approval columns are refused by coherence on every withdrawn write)
      await svc.withdraw(f.projectA.id, id, { reason: 'legitimately withdrawn' }, pmc());
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "approvedById"=${f.memberUser.id} WHERE "id"=${id}`,
      ).rejects.toThrow(/cannot carry approval evidence/);
    });
  });

  // ── P13 — the projection across a withdraw ──
  it('P13: decisions.inbox — live == projection == rebuild across a withdraw; the rebuild emits zero events', async () => {
    // a FRESH project: the ordered projection cursor consumes contiguously from stream position
    // 1, so the probe's withdraw event must be this project's first (the shared fixture project's
    // counter has advanced past truncated history)
    const proj13 = `it-t4a-proj-${Date.now() % 1e6}`;
    await t.prisma.project.create({
      data: { id: proj13, orgId: f.orgA.id, name: proj13, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: proj13, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const id = 'DL-t4a-p13';
    await t.prisma.decision.create({
      data: { id, projectId: proj13, title: 'Projected', room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: new Date() },
    });
    await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
    try {
      const asPmc = { sub: f.memberUser.id, role: 'pmc', projectId: proj13 } as AuthUser;
      await svc.withdraw(proj13, id, { reason: 'projected truth' }, asPmc);
      // drain the projection consumer (live apply)
      for (let pass = 0; pass < 50; pass++) {
        const ds = await t.prisma.outboxDelivery.findMany({
          where: { consumer: 'decisions.inbox', projectId: proj13, status: { in: ['pending', 'leased'] } },
          orderBy: { streamPosition: 'asc' },
        });
        if (!ds.length) break;
        for (const d of ds) await relay.dispatchOne(d.id);
      }
      for (const role of ['pmc', 'client', 'engineer'] as const) {
        const live = await query.snapshotSlice(proj13, role, f.memberUser.id);
        const proj = await query.projectionSlice(proj13, role, f.memberUser.id);
        expect(proj.decisions, `role=${role}`).toEqual(live.decisions);
      }
      // the rebuild reproduces the same truth and emits ZERO events
      const eventsBefore = await t.prisma.domainEvent.count();
      await rebuilder.rebuild('decisions.inbox', proj13);
      expect(await t.prisma.domainEvent.count()).toBe(eventsBefore);
      const live = await query.snapshotSlice(proj13, 'pmc', f.memberUser.id);
      const proj = await query.projectionSlice(proj13, 'pmc', f.memberUser.id);
      expect(proj.decisions).toEqual(live.decisions);
      expect(proj.decisions.find((d) => d.id === id)?.status).toBe('withdrawn');
    } finally {
      await t.prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "CommandExecution" CASCADE',
      );
      await t.prisma.notification.deleteMany({ where: { projectId: proj13 } });
      await t.prisma.auditLog.deleteMany({ where: { projectId: proj13 } });
      await t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } });
      await t.prisma.decisionOption.deleteMany({ where: { decisionId: id } });
      // this probe's row IS withdrawn — the same sanctioned destructive-reset bypass as cleanup()
      await t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"');
      await t.prisma.decision.deleteMany({ where: { id } });
      await t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"');
      await t.prisma.membership.deleteMany({ where: { projectId: proj13 } });
      await t.prisma.project.deleteMany({ where: { id: proj13 } });
    }
  });
});
