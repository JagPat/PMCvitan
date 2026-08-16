import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { applyMigrationThroughHead, createTwoProjectFixture, wipeDecisionEvents, type TwoProjectFixture } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { ActivitiesService } from '../../src/activities/activities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { PushService } from '../../src/push/push.service';
import { PUSH_CONSUMER } from '../../src/platform/outbox/consumers';
import { cancelQueuedPushBySubject } from '../../src/platform/outbox/cancellation';
import { emitEvent } from '../../src/platform/events';
import { computeDecisionRows, storedDecisionRows } from '../../src/decisions/decisions.projection';
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
  let t4bClientId = '';
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
    // Phase 6 task 4b: the default decider is `client`, and 4b refuses to publish a decision into
    // a project with no effective holder. The client now lives in the SHARED fixture — a project
    // without one is an impossible world, not a smaller one — so this suite reads it rather than
    // minting a second one, which would put two clients in every audience assertion below.
    t4bClientId = f.clientUser.id;
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
    // withdrawn rows are permanent in a LIVE register (`Decision_t4a_d_no_delete`), their
    // OPTIONS are part of the frozen question (`DecisionOption_t4a_frozen`, rounds 11-12), and
    // approval EVENTS are undeletable evidence (`DecisionEvent_no_withdrawn_approval`, round
    // 12); this destructive test reset disables the named seals for exactly this wipe — the
    // same sanctioned-bypass contract as the TRUNCATE above (which fires no row-level trigger).
    // R14-F2: ONE transaction — a failed wipe rolls the DISABLE back (the R6-F4 seed shape),
    // so no failure path leaves the shared database's evidence seals off for later probes.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_publication_seal"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_recorded_seal"'),
      // The 4b Membership seal guards DELETE (it refuses removing a holder of a published open
      // decision), so a reset that WIPES memberships extends the same named-bypass contract.
      t.prisma.$executeRawUnsafe('ALTER TABLE "Membership" DISABLE TRIGGER "Membership_t4b_holder_seal"'),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Membership" ENABLE TRIGGER "Membership_t4b_holder_seal"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_recorded_seal"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_publication_seal"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
    ]);
    await t.prisma.membership.deleteMany({ where: { userId: { startsWith: 'it-t4a-u-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-t4a-u-' } } });
    roleUsers.clear();
  }

  /**
   * Phase 6 task 4b: publishing a client-held decision into a project with NO active client is
   * refused (`Decision_t4b_publication_seal` — it would birth the holderless state the removal
   * guard exists to prevent). The migration/repair probes below build their own throwaway project,
   * so each one gets the standard cast — one active client — torn down with the project.
   */
  const seedAdHocClient = async (projectId: string): Promise<string> => {
    const id = `t4a-adhoc-client-${projectId}`;
    await t.prisma.user.create({
      data: { id, projectId, role: 'client', name: 'Ad-hoc Client', email: `${id}@test.local` },
    });
    await t.prisma.membership.create({ data: { projectId, userId: id, role: 'client', status: 'active' } });
    return id;
  };

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
        publishedAt: null, // set after the options exist (see below)
      },
    });
    await t.prisma.decisionOption.createMany({
      data: [
        { decisionId: id, label: 'Granite', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
        { decisionId: id, label: 'Quartz', optionKey: 'b', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false, order: 1 },
      ],
    });
    // Phase 6 task 4b: publication happens AFTER the options exist. The 4b publication seal
    // counts a decision's options at both doors, so a fixture that inserts an already-published
    // head with no children is refused — the same ordering the production create path now uses.
    if (!over.draft) await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
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
        // round 9: the entry seal's ACTIVE-standing check now answers BEFORE the FK (a ghost
        // has no membership row at all, active or otherwise); the FK stays the structural backstop
      ).rejects.toThrow(/ACTIVE pmc member|foreign key|violates/i);
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
      // hostile SQL tries to clear the children first — the OPTION children now refuse on
      // their own (round 11: the frozen question includes its choices), so the child-clearing
      // step uses the sanctioned bypass; the Decision DELETE arm is then proven alone
      // (BEFORE DELETE fires before FK evaluation, so it never depended on children anyway)
      await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
      await t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } });
      await expect(t.prisma.decisionOption.deleteMany({ where: { decisionId: id } })).rejects.toThrow(/frozen question/);
      // unit 4b adds a SECOND, stricter option seal on the same table (`_t4b_published_frozen`:
      // frozen from publication onward, whatever the status), so the sanctioned bypass names both
      await t.prisma.$transaction([
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        t.prisma.decisionOption.deleteMany({ where: { decisionId: id } }),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
      ]); // R14-F2: atomic — a failed wipe rolls the disable back
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
        // installed, fires BEFORE any FK evaluation and needs no surviving children); the
        // OPTION children need the sanctioned bypass since round 11 froze them
        await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
        await t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } });
        await t.prisma.$transaction([
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.decisionOption.deleteMany({ where: { decisionId: id } }),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
        ]); // R14-F2: atomic — a failed wipe rolls the disable back
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

  // ── Round 8 — the four Codex findings on head f1700af ──
  // (R8-F1 is a web-store fix proven in apps/web/tests/decision-withdraw.test.tsx; R8-F2/R8-F3
  //  are migration-level facts proven in upgrade-proof.sh. R8-F4 is REFUTED WITH EVIDENCE here.)
  describe('round 8 (Codex): the reverse register is already sealed against re-pointing', () => {
    it('R8-F4 (refuted with evidence): an approval revision cannot be UPDATEd onto a withdrawn decision — the Phase-3 append-only seal refuses EVERY update before the reverse arm is consulted', async () => {
      // the described attack: mint a revision against a non-withdrawn dummy decision, then
      // re-point its identity at a withdrawn one so the INSERT-time reverse arm never runs.
      // It fails one seal earlier: DecisionApprovalRevision_append_only (Phase 3,
      // 20261212000000) refuses ALL UPDATE/DELETE on the register unconditionally.
      const withdrawn = await seed({ title: 'Repoint target' });
      await svc.withdraw(f.projectA.id, withdrawn, { reason: 'sealed register' }, pmc());
      const dummy = await seed({ title: 'Dummy approved' });
      await t.prisma.$executeRaw`INSERT INTO "DecisionApprovalRevision"("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
        VALUES ('r8-rev', ${f.projectA.id}, ${dummy}, 1, 'a', now(), ${f.memberUser.id})`;
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionApprovalRevision" SET "decisionId" = ${withdrawn} WHERE "id" = 'r8-rev'`,
      ).rejects.toThrow(/append-only/);
      expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: withdrawn } })).toBe(0);
    });
  });

  // ── Round 9 — the four Codex findings on head b99f792 ──
  describe('round 9 (Codex): identity freeze, active attribution, server-side linkability, legacy approval events', () => {
    it('R9-F1: the withdrawn QUESTION identity is frozen — title/room/nodeId cannot change on a withdrawn row nor in the withdrawing statement', async () => {
      const id = await seed({ title: 'Kitchen counter' });
      await svc.withdraw(f.projectA.id, id, { reason: 'frozen identity' }, pmc());
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "title" = 'Rewritten question' WHERE "id" = ${id}`,
      ).rejects.toThrow(/identity is frozen/);
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "room" = 'Elsewhere' WHERE "id" = ${id}`,
      ).rejects.toThrow(/identity is frozen/);
      // …and the withdrawing statement itself cannot rewrite the question either
      const id2 = await seed({ title: 'Original question' });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='retitled on entry', "title"='Different question' WHERE "id"=${id2}`,
      ).rejects.toThrow(/identity is frozen/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: id2 } })).status).toBe('pending');
    });

    it('R9-F2: a withdrawal cannot be attributed to a REMOVED membership — existence is not standing', async () => {
      const id = await seed({ title: 'Removed attribution' });
      await t.prisma.user.upsert({
        where: { id: 'it-t4a-u-removed' },
        update: {},
        create: { id: 'it-t4a-u-removed', projectId: f.projectA.id, name: 'Removed member', email: 'it-t4a-removed@example.com', role: 'pmc' },
      });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: 'it-t4a-u-removed', role: 'pmc', status: 'removed' } });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"='it-t4a-u-removed', "withdrawnByName"='Removed member', "withdrawReason"='ghost authority' WHERE "id"=${id}`,
      ).rejects.toThrow(/ACTIVE pmc member/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    });

    it('R9-F3: the SERVER refuses linking an activity to a withdrawn decision — the picker rule enforced at the write path; a live decision still links', async () => {
      const withdrawn = await seed({ title: 'Terminal link target' });
      await svc.withdraw(f.projectA.id, withdrawn, { reason: 'no new work links here' }, pmc());
      const actId = `it-t4a-r9-${seq}`;
      await t.prisma.activity.create({
        data: { id: actId, projectId: f.projectA.id, name: 'Link probe', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na' },
      });
      await expect(activities.update(f.projectA.id, actId, { decisionId: withdrawn }, pmc())).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('withdrawn'),
      });
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).decisionId).toBeNull();
      const live = await seed({ title: 'Live link target' });
      await activities.update(f.projectA.id, actId, { decisionId: live }, pmc());
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).decisionId).toBe(live);
    });

    it('R9-F4a: a published pending decision carrying a LEGACY approval EVENT (empty register) cannot be withdrawn — the service belt AND the entry seal', async () => {
      const id = await seed({ title: 'Legacy approved' });
      await t.prisma.decisionEvent.create({ data: { decisionId: id, type: 'approved', actor: 'Legacy Client' } });
      await expect(svc.withdraw(f.projectA.id, id, { reason: 'over legacy approval' }, pmc())).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('approval evidence'),
      });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='hostile over legacy approval' WHERE "id"=${id}`,
      ).rejects.toThrow(/legacy approval event/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    });

    it('R9-F4b: a legacy approval EVENT cannot be recorded against a withdrawn decision — the reverse seal covers DecisionEvent like the register', async () => {
      const id = await seed({ title: 'Withdrawn then legacy-approved' });
      await svc.withdraw(f.projectA.id, id, { reason: 'sealed against legacy events' }, pmc());
      await expect(
        t.prisma.$executeRaw`INSERT INTO "DecisionEvent"("id","decisionId","type","actor") VALUES ('r9-ev', ${id}, 'approved', 'Hostile')`,
      ).rejects.toThrow(/withdrawn/);
      // precision: the register's own non-approval events (the 'withdrawn' entry the command
      // wrote) exist and future non-approval inserts stay legal
      expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'withdrawn' } })).toBe(1);
    });
  });

  describe('round 10 (Codex): in-tx linkability, membership row lock, event re-point, tombstone id cast (refuted)', () => {
    // R10-F1 — the pre-tx linkability read is UX; the AUTHORITY must hold inside the command
    // transaction. The probe drives the reviewer's exact interleave deterministically: the
    // pre-tx check answers 'linkable', the withdrawal then COMMITS before the activity
    // command's transaction runs. At f841907 the stale pre-check was the only guard and the
    // link committed; the in-tx FOR SHARE re-check now refuses.
    const linkRace = async (drive: (decisionId: string) => Promise<void>): Promise<string> => {
      const id = await seed({ title: 'TOCTOU target' });
      const original = query.linkableInProject.bind(query);
      let fired = false;
      const spy = vi.spyOn(query, 'linkableInProject').mockImplementation(async (projectId, decisionId, tx?) => {
        const verdict = await original(projectId, decisionId, tx);
        if (!tx && !fired && decisionId === id) {
          fired = true;
          // the concurrent withdrawal wins the window between the check and the transaction
          await svc.withdraw(f.projectA.id, id, { reason: 'raced the link' }, pmc());
        }
        return verdict;
      });
      try {
        await drive(id);
      } finally {
        spy.mockRestore();
      }
      return id;
    };

    it('R10-F1 (update): a withdraw committing between the pre-check and the transaction cannot produce a fresh link — the in-tx re-check refuses', async () => {
      const actId = `it-t4a-r10-u-${seq}`;
      await t.prisma.activity.create({
        data: { id: actId, projectId: f.projectA.id, name: 'TOCTOU update probe', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na' },
      });
      await linkRace(async (id) => {
        await expect(activities.update(f.projectA.id, actId, { decisionId: id }, pmc())).rejects.toMatchObject({
          status: 400,
          message: expect.stringContaining('withdrawn'),
        });
      });
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).decisionId).toBeNull();
    });

    it('R10-F1 (create): the same interleave against activities.create — no activity is planned against the terminal decision', async () => {
      await linkRace(async (id) => {
        await expect(
          activities.create(
            f.projectA.id,
            { name: 'TOCTOU create probe', zone: 'GF', plannedStart: 0, plannedEnd: 1, decisionId: id, gateMaterial: 'na', gateTeam: 'na' } as Parameters<ActivitiesService['create']>[1],
            pmc(),
          ),
        ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('withdrawn') });
      });
      expect(await t.prisma.activity.count({ where: { projectId: f.projectA.id, name: 'TOCTOU create probe' } })).toBe(0);
    });

    // R10-F4 — the entry seal's ACTIVE-membership read must LOCK the membership row. Ordering
    // A (removal commits first → the withdrawal is refused) is round 9's R9-F2. This is
    // ordering B: the withdrawal is held open UNCOMMITTED after its UPDATE ran the trigger;
    // a concurrent membership removal must BLOCK on the row lock until the withdrawal
    // commits — at f841907 it committed straight through, attributing the permanent record
    // to a member already removed at commit time.
    it('R10-F4 (ordering B): an in-flight withdrawal holds the membership row — the concurrent removal BLOCKS until the withdrawal commits', async () => {
      const id = await seed({ title: 'Membership lock race' });
      const uid = 'it-t4a-u-lockrace';
      await t.prisma.user.upsert({
        where: { id: uid },
        update: {},
        create: { id: uid, projectId: f.projectA.id, name: 'Lock race member', email: `${uid}@t.local`, role: 'pmc' },
      });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: uid, role: 'pmc', status: 'active' } });

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let updated!: () => void;
      const updatedP = new Promise<void>((r) => (updated = r));
      const a = raceDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=$2, "withdrawnByName"='Lock race member', "withdrawReason"='held for the lock probe' WHERE "id"=$1`,
            id,
            uid,
          );
          updated();
          await gate;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      // a RED failure below never awaits `a` — mark it handled so the aborting held
      // transaction cannot surface as an unhandled rejection
      a.catch(() => undefined);
      await updatedP;
      const reflect = <T,>(p: Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> =>
        p.then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }));
      const b = reflect(
        t.prisma.$executeRawUnsafe(
          `UPDATE "Membership" SET "status"='removed' WHERE "projectId"=$1 AND "userId"=$2`,
          f.projectA.id,
          uid,
        ),
      );
      // condition-based, not a sleep: the removal backend must appear BLOCKED on the lock
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const rows = await raceDb.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
          `%UPDATE "Membership" SET "status"='removed'%`,
        );
        if (Number(rows[0]!.c) >= 1) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, 'the membership removal must block on the entry seal\'s row lock while the withdrawal is uncommitted').toBe(true);
      release();
      await a;
      const rb = await b;
      expect(rb.status).toBe('fulfilled');
      // serialized truth: the attribution was ACTIVE at the moment the withdrawal committed;
      // the removal landed strictly after
      const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(d.status).toBe('withdrawn');
      expect(d.withdrawnById).toBe(uid);
      expect((await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: uid } })).status).toBe('removed');
    });

    // R10-F5 — DecisionEvent carries no append-only seal, so the reverse arm must cover
    // UPDATE: at f841907 an existing benign event could be RE-POINTED (decisionId and/or
    // type) into approval evidence against a withdrawn decision.
    it('R10-F5: an existing event cannot be re-pointed into approval evidence on a withdrawn decision — the reverse seal covers UPDATE', async () => {
      const withdrawn = await seed({ title: 'Re-point target' });
      await svc.withdraw(f.projectA.id, withdrawn, { reason: 'sealed against re-points' }, pmc());
      const live = await seed({ title: 'Benign event host' });
      await t.prisma.decisionEvent.create({ data: { id: 'r10-ev', decisionId: live, type: 'published', actor: 'Benign' } });
      // re-point the event at the withdrawn decision while flipping it to approval evidence
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionEvent" SET "decisionId"=${withdrawn}, "type"='approved' WHERE "id"='r10-ev'`,
      ).rejects.toThrow(/withdrawn/);
      // flip the register's own 'withdrawn' entry in place
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionEvent" SET "type"='approved' WHERE "decisionId"=${withdrawn} AND "type"='withdrawn'`,
      ).rejects.toThrow(/withdrawn/);
      // precision: benign updates on live decisions stay legal
      expect(await t.prisma.$executeRaw`UPDATE "DecisionEvent" SET "actor"='Still benign' WHERE "id"='r10-ev'`).toBe(1);
      expect(await t.prisma.decisionEvent.count({ where: { decisionId: withdrawn, type: { in: ['approved', 'reapproved'] } } })).toBe(0);
    });

    // R10-F2 — REFUTED with evidence: the reviewer read `gen_random_uuid()` into the TEXT
    // `OutboxDelivery.id` as a type error, but PostgreSQL applies its automatic I/O-conversion
    // cast in assignment context for string-type targets (pg_cast holds NO uuid→text row; the
    // conversion is the documented always-available string-type assignment path). R3-F3
    // exercises this exact INSERT on every run; this probe pins the landed id's canonical
    // 36-char uuid TEXT form so the claim stays refuted by execution, not by argument.
    it('R10-F2 (refuted): the recovery-gap tombstone id lands as canonical uuid text', async () => {
      const id = await seed({ title: 'Tombstone cast' });
      const deliveryId = await emitQueuedPush(id, 'Tombstone cast');
      await t.prisma.outboxDelivery.delete({ where: { id: deliveryId } });
      await svc.withdraw(f.projectA.id, id, { reason: 'cast probe' }, pmc());
      const tomb = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, subject: id } });
      expect(tomb.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(tomb.status).toBe('succeeded');
      expect(tomb.cancelledAt).not.toBeNull();
    });
  });

  describe('round 11 (Codex): frozen options, preserved links on edits', () => {
    // R11-F1 — the frozen question includes its CHOICES: the option rows define what was asked
    // (count, materials, cost range, swatches). At 3a972ae a direct UPDATE/DELETE/INSERT on
    // `DecisionOption` never touched the sealed `Decision` row, so the frozen withdrawer/reason
    // could later display against a different set of options.
    it('R11-F1: a withdrawn decision\'s options are frozen — UPDATE, DELETE and INSERT all refuse; a live decision\'s options stay mutable', async () => {
      const id = await seed({ title: 'Frozen options' });
      await svc.withdraw(f.projectA.id, id, { reason: 'options sealed' }, pmc());
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Swapped material' WHERE "decisionId"=${id} AND "optionKey"='a'`,
      ).rejects.toThrow(/frozen question/);
      await expect(
        t.prisma.$executeRaw`DELETE FROM "DecisionOption" WHERE "decisionId"=${id} AND "optionKey"='b'`,
      ).rejects.toThrow(/frozen question/);
      await expect(
        t.prisma.$executeRaw`INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","recommended","order") VALUES ('r11-opt',${id},'C','c','Marble',5,'sw3',false,2)`,
      ).rejects.toThrow(/frozen question/);
      expect(await t.prisma.decisionOption.count({ where: { decisionId: id } })).toBe(2);
      // precision (revised in round 12): the freeze now starts at PUBLICATION, so the mutable
      // counter-example is a DRAFT decision's option set
      const draft = await seed({ draft: true, title: 'Editable draft options' });
      expect(await t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Refined granite' WHERE "decisionId"=${draft} AND "optionKey"='a'`).toBe(1);
    });

    // R11-F2 — link-then-withdraw is the ALLOWED state, so editing an unrelated field on an
    // activity that already carries the withdrawn link must not 400: the Plan Activity modal
    // always sends the current decisionId. Only a NEWLY introduced link is validated.
    it('R11-F2: editing an activity that already links the withdrawn decision succeeds (same link re-sent); a NEW withdrawn link is still refused; explicit null clears', async () => {
      const linked = await seed({ title: 'Linked then withdrawn' });
      const actId = `it-t4a-r11-${seq}`;
      await t.prisma.activity.create({
        data: { id: actId, projectId: f.projectA.id, name: 'Edit probe', zone: 'GF', plannedStart: 0, plannedEnd: 1, decisionId: linked, gateMaterial: 'na', gateTeam: 'na' },
      });
      await svc.withdraw(f.projectA.id, linked, { reason: 'link-then-withdraw' }, pmc());
      // the unrelated edit re-sends the CURRENT link (the modal's shape) — allowed
      await activities.update(f.projectA.id, actId, { name: 'Edit probe renamed', decisionId: linked }, pmc());
      const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } });
      expect(after.name).toBe('Edit probe renamed');
      expect(after.decisionId).toBe(linked);
      // a NEW withdrawn link is still refused
      const otherWithdrawn = await seed({ title: 'Other terminal' });
      await svc.withdraw(f.projectA.id, otherWithdrawn, { reason: 'never a new link' }, pmc());
      await expect(activities.update(f.projectA.id, actId, { decisionId: otherWithdrawn }, pmc())).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('withdrawn'),
      });
      // explicit null clears the stale link
      await activities.update(f.projectA.id, actId, { decisionId: null }, pmc());
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).decisionId).toBeNull();
    });
  });

  describe('round 12 (Codex): the replacement generation, the published-option freeze, the under-lock link, id/evidence durability, pmc standing', () => {
    // R12-F1 — retiring WITHOUT a replacement wedged the projection consumer: the next
    // delivery bootstrapped appliedPosition=null (expecting position 0) while the stream is at
    // head+1 → 'wait' forever. The migration now retires AND replaces in one step, copying the
    // rows + checkpoint verbatim and correcting only the withdrawn rows — pinned here by the
    // projection==live slice equality AND a post-migration delivery that APPLIES.
    it('R12-F1: the migration replaces the stale generation — checkpoint preserved, slices equal, and the NEXT delivery applies instead of waiting forever', async () => {
      const { execFileSync } = await import('node:child_process');
      const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20270810000000_phase6_t4a_withdraw/migration.sql');
      const dbUrl = (process.env.DATABASE_URL ?? '').split('?')[0]!;
      // a FRESH project: the ordered cursor consumes contiguously from the stream's start (the
      // shared fixture project's counter has advanced past truncated history — the P13 pattern)
      const projW = `it-t4a-r12w-${Date.now() % 1e6}`;
      await t.prisma.project.create({
        data: { id: projW, orgId: f.orgA.id, name: projW, short: 'W', descriptor: '', stage: 'x', siteCode: 'W', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      });
      await t.prisma.membership.create({ data: { projectId: projW, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
      await seedAdHocClient(projW);
      const id = 'DL-t4a-r12w';
      await t.prisma.decision.create({
        data: { id, projectId: projW, title: 'Wedge probe', room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
      });
      await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
      // Phase 6 task 4b: a PUBLISHED ordinary decision must be approvable, so it needs two
      // options and they must exist BEFORE publication. This fixture modelled a state the
      // product now forbids (published with fewer than two options, approvable by nobody).
      await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt B', optionKey: 'b', material: 'Oak', delta: 1000, swatch: 'sw2', recommended: false, order: 1 } });
      await t.prisma.decision.update({ where: { id: id }, data: { publishedAt: new Date() } });
      const drain = async (): Promise<void> => {
        for (let pass = 0; pass < 50; pass++) {
          const ds = await t.prisma.outboxDelivery.findMany({
            where: { consumer: 'decisions.inbox', projectId: projW, status: { in: ['pending', 'leased'] } },
            orderBy: { streamPosition: 'asc' },
          });
          if (!ds.length) break;
          for (const d of ds) await relay.dispatchOne(d.id);
        }
      };
      try {
        // drain the publication into a SERVABLE decisions.inbox generation (the live apply path)
        await t.prisma.$transaction(async (tx) => {
          await emitEvent(tx, { projectId: projW, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId: id, payload: {}, effectKey: 'decision.published', dispatch: {} });
        });
        await drain();
        const before = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: 'decisions.inbox', projectId: projW, status: 'active' } });
        expect(before.appliedPosition).not.toBeNull();
        // the pre-withdrawn shape: a COHERENT raw withdrawal (full evidence, active pmc member)
        // that emits NO event — exactly the partial/manual-apply state the migration accepts
        await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='Manual PMC', "withdrawReason"='partial apply' WHERE "id"=${id}`;
        // the migration file is rerunnable BY DESIGN — run it as the operator would
        applyMigrationThroughHead(dbUrl, '20270810000000_phase6_t4a_withdraw');
        const retired = await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: before.id } });
        expect(retired.status).toBe('retired');
        const replacement = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: 'decisions.inbox', projectId: projW, status: 'active' } });
        expect(replacement.id).not.toBe(before.id);
        expect(replacement.appliedPosition).toBe(before.appliedPosition);
        // the drift pin: the replacement generation SERVES truth equal to the live slice
        for (const role of ['pmc', 'engineer'] as const) {
          const live = await query.snapshotSlice(projW, role, f.memberUser.id);
          const proj = await query.projectionSlice(projW, role, f.memberUser.id);
          expect(proj.decisions, `role=${role}`).toEqual(live.decisions);
        }
        expect((await query.projectionSlice(projW, 'pmc', f.memberUser.id)).decisions.find((d) => d.id === id)?.status).toBe('withdrawn');
        // the WEDGE pin: the next delivery is CONTIGUOUS and APPLIES (at c2d3a1a it waited forever)
        const id2 = 'DL-t4a-r12w-2';
        // 4b: the option floor is judged at BOTH publication doors, so the post-repair row is
        // born as a draft, given its two options, and only then published (the `seed` order)
        await t.prisma.decision.create({
          data: { id: id2, projectId: projW, title: 'Post-repair decision', room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
        });
        await t.prisma.decisionOption.create({ data: { decisionId: id2, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
        await t.prisma.decisionOption.create({ data: { decisionId: id2, label: 'Opt B', optionKey: 'b', material: 'Oak', delta: 1000, swatch: 'sw2', recommended: false, order: 1 } });
        await t.prisma.decision.update({ where: { id: id2 }, data: { publishedAt: new Date() } });
        await t.prisma.$transaction(async (tx) => {
          await emitEvent(tx, { projectId: projW, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId: id2, payload: {}, effectKey: 'decision.published', dispatch: {} });
        });
        await drain();
        const stuck = await t.prisma.outboxDelivery.count({ where: { consumer: 'decisions.inbox', projectId: projW, status: { in: ['pending', 'leased'] } } });
        expect(stuck, 'the post-migration delivery must APPLY, not wait forever').toBe(0);
        const after = await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: replacement.id } });
        expect(after.appliedPosition! > replacement.appliedPosition!).toBe(true);
      } finally {
        await t.prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "CommandExecution" CASCADE',
        );
        await t.prisma.notification.deleteMany({ where: { projectId: projW } });
        await t.prisma.auditLog.deleteMany({ where: { projectId: projW } });
        await t.prisma.$transaction([
          t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
          t.prisma.decisionEvent.deleteMany({ where: { decisionId: { in: [id, 'DL-t4a-r12w-2'] } } }),
          t.prisma.decisionOption.deleteMany({ where: { decisionId: { in: [id, 'DL-t4a-r12w-2'] } } }),
          t.prisma.decision.deleteMany({ where: { projectId: projW } }),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
        ]); // R14-F2: atomic — a failed wipe rolls the disables back
        await t.prisma.membership.deleteMany({ where: { projectId: projW } });
        await t.prisma.user.deleteMany({ where: { projectId: projW } });
        await t.prisma.project.deleteMany({ where: { id: projW } });
      }
    });

    // R12-F2 — the WITHDRAWING transaction must not rewrite the question first: option writes
    // are judged at write time, so one transaction could edit the options and then withdraw.
    // The touch note catches UPDATE, INSERT and DELETE alike; ordinary transactions never
    // withdraw, so nothing else trips it.
    // Unit 4b SUBSUMES this attack: `DecisionOption_t4b_published_frozen` refuses ANY option
    // write from publication onward, so the rewriting statement no longer even lands — a
    // strictly stronger seal firing strictly earlier. Both facts are pinned below: the 4b
    // refusal first, then 4a's own guard with the 4b seal bypassed BY NAME (the sanctioned
    // ownership bypass this suite already uses for `DecisionOption_t4a_frozen`), so the
    // withdrawal-entry touch note stays under test rather than being masked.
    it('R12-F2: options modified in the WITHDRAWING transaction refuse the withdrawal — UPDATE, INSERT and DELETE alike; separate transactions are unaffected', async () => {
      const id = await seed({ title: 'Same-tx option attack' });
      const withdrawal = (): ReturnType<typeof t.prisma.$executeRaw> =>
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='swapped question' WHERE "id"=${id}`;
      for (const [label, statement] of [
        ['update', () => t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Swapped in-flight' WHERE "decisionId"=${id} AND "optionKey"='a'`],
        ['insert', () => t.prisma.$executeRaw`INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","recommended","order") VALUES ('r12-opt',${id},'C','c','Marble',5,'sw3',false,2)`],
        ['delete', () => t.prisma.$executeRaw`DELETE FROM "DecisionOption" WHERE "decisionId"=${id} AND "optionKey"='b'`],
      ] as const) {
        // 4b: the rewrite is refused outright — the withdrawal never gets its swapped question
        await expect(t.prisma.$transaction([statement(), withdrawal()]), `verb=${label} (4b)`).rejects.toThrow(
          /options of a published decision are frozen/,
        );
        expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status, `verb=${label} (4b)`).toBe('pending');
        // 4a: with 4b's seal off by name, the touch note is the refusing seal — unchanged
        await expect(
          t.prisma.$transaction([
            t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
            statement(),
            withdrawal(),
            t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          ]),
          `verb=${label} (4a)`,
        ).rejects.toThrow(/withdrawing transaction/);
        expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status, `verb=${label} (4a)`).toBe('pending');
      }
      // precision, still: 4a's guard is NOT a blanket option freeze — with 4b's seal off, the
      // edit in its OWN transaction is legal, and a clean later withdrawal succeeds
      const separate = await t.prisma.$transaction([
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Edited separately' WHERE "decisionId"=${id} AND "optionKey"='a'`,
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
      ]); // R14-F2: atomic — a failed edit rolls the disable back
      expect(separate[1]).toBe(1);
      await svc.withdraw(f.projectA.id, id, { reason: 'clean withdrawal after' }, pmc());
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
    });

    // R12-F3 — the round-11 "unchanged link" decision must be made from the row UNDER the
    // readiness lock, not the stale pre-transaction read.
    it('R12-F3: a stale re-sent link is a REINTRODUCTION when a concurrent update cleared it — the under-lock recompute refuses', async () => {
      const d1 = await seed({ title: 'Stale link target' });
      const actId = `it-t4a-r12-${seq}`;
      await t.prisma.activity.create({
        data: { id: actId, projectId: f.projectA.id, name: 'Stale link probe', zone: 'GF', plannedStart: 0, plannedEnd: 1, decisionId: d1, gateMaterial: 'na', gateTeam: 'na' },
      });
      // interleave driver: while THIS update is between its pre-tx read and its transaction,
      // a concurrent update CLEARS the link and the decision is withdrawn
      let fired = false;
      const original = (activities as unknown as { assertRefs: (...a: unknown[]) => Promise<void> }).assertRefs.bind(activities);
      const spy = vi.spyOn(activities as unknown as { assertRefs: (...a: unknown[]) => Promise<void> }, 'assertRefs').mockImplementation(async (...args: unknown[]) => {
        await original(...args);
        if (!fired) {
          fired = true; // the reentrant clear below calls assertRefs again — run it plainly
          await activities.update(f.projectA.id, actId, { decisionId: null }, pmc());
          await svc.withdraw(f.projectA.id, d1, { reason: 'raced the stale re-send' }, pmc());
        }
      });
      try {
        await expect(activities.update(f.projectA.id, actId, { name: 'renamed', decisionId: d1 }, pmc())).rejects.toMatchObject({
          status: 400,
          message: expect.stringContaining('withdrawn'),
        });
      } finally {
        spy.mockRestore();
      }
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).decisionId).toBeNull();
    });

    // R12-F4 — every child FK is ON UPDATE CASCADE, so re-keying the withdrawn row would drag
    // the children to a new key and the register loses the entry under its issued id.
    it('R12-F4: the withdrawn decision\'s primary id is frozen — re-keying refuses on the terminal row AND in the withdrawing statement', async () => {
      const id = await seed({ title: 'Re-key target' });
      await svc.withdraw(f.projectA.id, id, { reason: 'keyed forever' }, pmc());
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "id"='DL-REKEYED' WHERE "id"=${id}`,
      ).rejects.toThrow(/identity is frozen/);
      const id2 = await seed({ title: 'Re-key on entry' });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "id"='DL-REKEYED-2', "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='re-keyed on entry' WHERE "id"=${id2}`,
      ).rejects.toThrow(/identity is frozen on entry/);
      expect(await t.prisma.decision.count({ where: { id: { in: ['DL-REKEYED', 'DL-REKEYED-2'] } } })).toBe(0);
    });

    // R12-F5 — approval events are evidence the entry seal COUNTS, so they must be as durable
    // as the register: erasing or downgrading one would launder a legacy approval away.
    it('R12-F5: an approval event cannot be deleted or type-downgraded — the laundered withdrawal stays refused; non-approval events remain deletable', async () => {
      const id = await seed({ title: 'Laundering target' });
      await t.prisma.decisionEvent.create({ data: { id: 'r12-appr', decisionId: id, type: 'approved', actor: 'Legacy Client' } });
      await expect(
        t.prisma.$executeRaw`DELETE FROM "DecisionEvent" WHERE "id"='r12-appr'`,
      ).rejects.toThrow(/approval evidence/);
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionEvent" SET "type"='note' WHERE "id"='r12-appr'`,
      ).rejects.toThrow(/downgraded/);
      // the evidence stands, so the withdrawal stays refused
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='laundered' WHERE "id"=${id}`,
      ).rejects.toThrow(/legacy approval event/);
      // precision: a non-approval event is still deletable
      await t.prisma.decisionEvent.create({ data: { id: 'r12-benign', decisionId: id, type: 'published', actor: 'System' } });
      expect(await t.prisma.$executeRaw`DELETE FROM "DecisionEvent" WHERE "id"='r12-benign'`).toBe(1);
    });

    // R12-F6 — active membership is not AUTHORITY: `decisions.withdraw` is a pmc command and
    // live authz derives the token role FROM the membership row.
    it('R12-F6: a withdrawal cannot be attributed to an active NON-pmc membership', async () => {
      const id = await seed({ title: 'Contractor attribution' });
      const uid = 'it-t4a-u-activecontractor';
      await t.prisma.user.upsert({
        where: { id: uid },
        update: {},
        create: { id: uid, projectId: f.projectA.id, name: 'Active contractor', email: `${uid}@t.local`, role: 'contractor' },
      });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: uid, role: 'contractor', status: 'active' } });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${uid}, "withdrawnByName"='Active contractor', "withdrawReason"='no authority' WHERE "id"=${id}`,
      ).rejects.toThrow(/ACTIVE pmc member/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    });
  });

  describe('round 13 (Codex): unerasable touch evidence, frozen event identity, complete projection repair, the daily-log write path', () => {
    // R13-F1 (REFUTED with evidence) — the claim: the touch trigger's unconditional
    // `COALESCE(OLD."decisionId", NEW."decisionId")` "will raise on every DecisionOption
    // insert" and "touch an unavailable NEW record on deletes". Since PostgreSQL 11 the
    // plpgsql OLD/NEW variables are NULL RECORDS when not applicable ("This variable is null
    // in statement-level triggers and for INSERT operations" — current docs, plpgsql-trigger),
    // and a field of a null record reads as NULL, so the COALESCE lands on the populated
    // side. Verified by EXECUTION on PostgreSQL 16: both verbs run through the trigger AND
    // record their note (the note table makes the firing itself assertable).
    // (The claim is about plpgsql row-image semantics, which are independent of publication —
    // so the probe now writes options where writing them is ORDINARY: an unpublished draft.
    // Unit 4b froze a PUBLISHED decision's options, and bypassing that seal to keep the old
    // seeding would have tested the trigger through a hole rather than through the front door.)
    it('R13-F1 (refuted): plain option INSERT and DELETE run through the touch trigger — OLD/NEW are null records, and both verbs record their note', async () => {
      const id = await seed({ draft: true, title: 'Null-record row images' });
      expect(
        await t.prisma.$executeRaw`INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","recommended","order") VALUES ('r13-f1-opt',${id},'C','c','Marble',5,'sw3',false,2)`,
      ).toBe(1);
      expect(await t.prisma.$executeRaw`DELETE FROM "DecisionOption" WHERE "id"='r13-f1-opt'`).toBe(1);
      // two single-statement transactions → two per-tx notes for this decision
      const notes = await t.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "DecisionOptionTouch" WHERE "decisionId"=${id}`;
      expect(Number(notes[0]!.n)).toBeGreaterThanOrEqual(2);
    });

    // R13-F2 — the round-12 note lived in pg_temp, which the SAME session can DROP with no
    // privilege on the app schema at all: [edit option, DROP the temp note, withdraw] committed
    // a withdrawal whose frozen question was edited in the withdrawing transaction. The note
    // now lives in a REAL table whose guard refuses same-transaction erasure — the only way
    // around it is ALTER TABLE ... DISABLE TRIGGER, the same ownership privilege every
    // sanctioned bypass in this seal network already requires.
    // (Unit 4b's published-option freeze would refuse every option write here before the note
    // mechanism ever runs, so each arm disables THAT seal by name — the touch note, not 4b,
    // is what these three arms are pinning.)
    it('R13-F2: the touch note cannot be erased by its own transaction — the temp-drop bypass is gone and the direct erase refuses', async () => {
      const id = await seed({ title: 'Note erase attack' });
      // the a58e949 bypass, verbatim: DROP the (now nonexistent) temp note between edit and withdraw
      await expect(
        t.prisma.$transaction([
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Swapped then hidden' WHERE "decisionId"=${id} AND "optionKey"='a'`,
          t.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS pg_temp."_t4a_options_touched"'),
          t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='hidden swap' WHERE "id"=${id}`,
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        ]),
      ).rejects.toThrow(/withdrawing transaction/);
      // erasing the REAL note directly is itself refused inside the writing transaction
      await expect(
        t.prisma.$transaction([
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Swapped again' WHERE "decisionId"=${id} AND "optionKey"='a'`,
          t.prisma.$executeRaw`DELETE FROM "DecisionOptionTouch" WHERE "decisionId"=${id}`,
          t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='erased note' WHERE "id"=${id}`,
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        ]),
      ).rejects.toThrow(/cannot be erased/);
      // and re-writing a note (re-pointing it at another decision) is refused too
      await t.prisma.$transaction([
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Committed edit' WHERE "decisionId"=${id} AND "optionKey"='a'`,
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
      ]); // R14-F2: atomic — a failed edit rolls the disable back
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionOptionTouch" SET "txid"=0 WHERE "decisionId"=${id}`,
      ).rejects.toThrow(/cannot be updated/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
      // notes from COMMITTED transactions are inert history: a clean later withdrawal succeeds
      await svc.withdraw(f.projectA.id, id, { reason: 'clean withdrawal after' }, pmc());
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
    });

    // R13-F3 — the event seal froze the TYPE (round 12) but not the event's DECISION: an
    // UPDATE keeping `type='approved'` while changing `decisionId` re-points a legacy
    // decision's only approval evidence at some other live decision, and the pending row
    // withdraws afterwards. Approval evidence now stays with its decision.
    it('R13-F3: an approval event cannot be re-pointed AWAY from its decision — the laundered withdrawal stays refused', async () => {
      const id = await seed({ title: 'Re-point-away target' });
      const other = await seed({ title: 'Innocent recipient' });
      await t.prisma.decisionEvent.create({ data: { id: 'r13-appr', decisionId: id, type: 'approved', actor: 'Legacy Client' } });
      await expect(
        t.prisma.$executeRaw`UPDATE "DecisionEvent" SET "decisionId"=${other} WHERE "id"='r13-appr'`,
      ).rejects.toThrow(/re-pointed/);
      // the evidence stands, so the withdrawal stays refused
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='laundered by re-point' WHERE "id"=${id}`,
      ).rejects.toThrow(/legacy approval event/);
      // precision: a NON-approval event can still be re-pointed onto a live decision
      await t.prisma.decisionEvent.create({ data: { id: 'r13-benign', decisionId: id, type: 'published', actor: 'System' } });
      expect(await t.prisma.$executeRaw`UPDATE "DecisionEvent" SET "decisionId"=${other} WHERE "id"='r13-benign'`).toBe(1);
      await t.prisma.decisionEvent.delete({ where: { id: 'r13-benign' } });
    });

    // R13-F4 — the replacement generation copied only rows that EXIST in the retired one, so
    // the never-applied shape (a withdrawn decision with NO projection row — a case the stale
    // predicate itself names) produced a caught-up replacement that still omits the
    // withdrawal. The missing rows are now seeded from CANONICAL truth with the dto composed
    // exactly as serializeDecision writes it.
    it('R13-F4: the migration seeds the MISSING withdrawn row — the replacement equals canonical row-for-row and the next delivery applies', async () => {
      const { execFileSync } = await import('node:child_process');
      const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20270810000000_phase6_t4a_withdraw/migration.sql');
      const dbUrl = (process.env.DATABASE_URL ?? '').split('?')[0]!;
      const projW = `it-t4a-r13w-${Date.now() % 1e6}`;
      await t.prisma.project.create({
        data: { id: projW, orgId: f.orgA.id, name: projW, short: 'W', descriptor: '', stage: 'x', siteCode: 'W', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      });
      await t.prisma.membership.create({ data: { projectId: projW, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
      await seedAdHocClient(projW);
      const idW = 'DL-t4a-r13w';
      const idK = 'DL-t4a-r13k';
      for (const [id, title] of [[idW, 'Never applied'], [idK, 'Healthy sibling']] as const) {
        await t.prisma.decision.create({
          data: { id, projectId: projW, title, room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
        });
        await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
        // Phase 6 task 4b: a PUBLISHED ordinary decision must be approvable, so it needs two
        // options and they must exist BEFORE publication. This fixture modelled a state the
        // product now forbids (published with fewer than two options, approvable by nobody).
        await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt B', optionKey: 'b', material: 'Oak', delta: 1000, swatch: 'sw2', recommended: false, order: 1 } });
        await t.prisma.decision.update({ where: { id: id }, data: { publishedAt: new Date() } });
      }
      const drain = async (): Promise<void> => {
        for (let pass = 0; pass < 50; pass++) {
          const ds = await t.prisma.outboxDelivery.findMany({
            where: { consumer: 'decisions.inbox', projectId: projW, status: { in: ['pending', 'leased'] } },
            orderBy: { streamPosition: 'asc' },
          });
          if (!ds.length) break;
          for (const d of ds) await relay.dispatchOne(d.id);
        }
      };
      try {
        for (const id of [idW, idK]) {
          await t.prisma.$transaction(async (tx) => {
            await emitEvent(tx, { projectId: projW, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId: id, payload: {}, effectKey: 'decision.published', dispatch: {} });
          });
        }
        await drain();
        const before = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: 'decisions.inbox', projectId: projW, status: 'active' } });
        expect(before.appliedPosition).not.toBeNull();
        // the pre-withdrawn shape + the NEVER-APPLIED shape: coherent raw withdrawal, then the
        // generation's row for it removed entirely (the partial apply that never reached idW)
        await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='Manual PMC', "withdrawReason"='partial apply, no row' WHERE "id"=${idW}`;
        await t.prisma.decisionProjection.deleteMany({ where: { generationId: before.id, decisionId: idW } });
        applyMigrationThroughHead(dbUrl, '20270810000000_phase6_t4a_withdraw');
        const replacement = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: 'decisions.inbox', projectId: projW, status: 'active' } });
        expect(replacement.id).not.toBe(before.id);
        expect(replacement.appliedPosition).toBe(before.appliedPosition);
        // the COMPLETENESS pin: the replacement equals canonical ROW-FOR-ROW — the seeded
        // missing row's dto byte-equals serializeDecision through the operator diagnostic's
        // own comparators, and the healthy sibling is untouched
        const stored = await storedDecisionRows(t.prisma, replacement.id);
        const canonical = await computeDecisionRows(t.prisma, projW);
        expect(stored).toEqual(canonical);
        expect(stored.map((r) => r.decisionId).sort()).toEqual([idK, idW].sort());
        // the pmc register SERVES the withdrawal from the replacement generation
        expect((await query.projectionSlice(projW, 'pmc', f.memberUser.id)).decisions.find((d) => d.id === idW)?.status).toBe('withdrawn');
        for (const role of ['pmc', 'engineer'] as const) {
          const live = await query.snapshotSlice(projW, role, f.memberUser.id);
          const proj = await query.projectionSlice(projW, role, f.memberUser.id);
          expect(proj.decisions, `role=${role}`).toEqual(live.decisions);
        }
        // and the consumer continues: the next delivery APPLIES against the copied checkpoint
        const id2 = 'DL-t4a-r13w-2';
        // 4b: the option floor is judged at BOTH publication doors, so the post-repair row is
        // born as a draft, given its two options, and only then published (the `seed` order)
        await t.prisma.decision.create({
          data: { id: id2, projectId: projW, title: 'Post-repair decision', room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
        });
        await t.prisma.decisionOption.create({ data: { decisionId: id2, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
        await t.prisma.decisionOption.create({ data: { decisionId: id2, label: 'Opt B', optionKey: 'b', material: 'Oak', delta: 1000, swatch: 'sw2', recommended: false, order: 1 } });
        await t.prisma.decision.update({ where: { id: id2 }, data: { publishedAt: new Date() } });
        await t.prisma.$transaction(async (tx) => {
          await emitEvent(tx, { projectId: projW, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId: id2, payload: {}, effectKey: 'decision.published', dispatch: {} });
        });
        await drain();
        expect(await t.prisma.outboxDelivery.count({ where: { consumer: 'decisions.inbox', projectId: projW, status: { in: ['pending', 'leased'] } } })).toBe(0);
      } finally {
        await t.prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "CommandExecution" CASCADE',
        );
        await t.prisma.notification.deleteMany({ where: { projectId: projW } });
        await t.prisma.auditLog.deleteMany({ where: { projectId: projW } });
        await t.prisma.$transaction([
          t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
          t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: projW } } }),
          t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: projW } } }),
          t.prisma.decision.deleteMany({ where: { projectId: projW } }),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
        ]); // R14-F2: atomic — a failed wipe rolls the disables back
        await t.prisma.membership.deleteMany({ where: { projectId: projW } });
        await t.prisma.user.deleteMany({ where: { projectId: projW } });
        await t.prisma.project.deleteMany({ where: { id: projW } });
      }
    });

    // R13-F5 — the daily-log material link validated only EXISTENCE, so a stale/offline
    // client or a direct POST could record a new matched delivery against a withdrawn
    // decision. The write path now uses the same linkability authority as activities
    // (pre-check fast-fail + the in-tx recheck under the decisions-owned row share lock),
    // with the refusal audience-shaped: pmc gets the honest reason, every other role gets
    // the same 'Unknown decision' the visibility rule implies.
    it('R13-F5: the daily-log material write refuses a withdrawn decision link — audience-shaped for engineer vs pmc; a live decision still links', async () => {
      const withdrawn = await seed({ title: 'Withdrawn material link' });
      await svc.withdraw(f.projectA.id, withdrawn, { reason: 'not this material' }, pmc());
      const live = await seed({ title: 'Live material link' });
      const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: '14 Aug 2026' } });
      const engUid = await roleUser('engineer');
      const post = (token: string, body: Record<string, unknown>) =>
        http().post(`/projects/${f.projectA.id}/daily-log/materials`).set('Authorization', `Bearer ${token}`).send(body);
      try {
        const eng = await post(t.issueProjectToken(engUid, f.projectA.id, 'engineer'), { name: 'Cement', qty: '10 bags', decisionId: withdrawn });
        expect(eng.status).toBe(400);
        expect(eng.body.message).toBe('Unknown decision for this project');
        const asPmc = await post(t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc'), { name: 'Cement', qty: '10 bags', decisionId: withdrawn });
        expect(asPmc.status).toBe(400);
        expect(asPmc.body.message).toContain('withdrawn');
        expect(await t.prisma.siteMaterial.count({ where: { decisionId: withdrawn } })).toBe(0);
        // precision: a LIVE decision still links
        const ok = await post(t.issueProjectToken(engUid, f.projectA.id, 'engineer'), { name: 'Cement', qty: '10 bags', decisionId: live });
        expect(ok.status).toBe(201);
        expect(await t.prisma.siteMaterial.count({ where: { decisionId: live } })).toBe(1);
      } finally {
        await t.prisma.siteMaterial.deleteMany({ where: { dailyLogId: log.id } });
        await t.prisma.dailyLog.delete({ where: { id: log.id } });
      }
    });
  });

  describe('round 14 (Codex): re-run-safe notice retirement, failure-safe resets', () => {
    // R14-F1 — the migration's identity-keyed notice retirement deleted EVERY notification
    // stamped with a withdrawn decision — but the withdraw command itself writes a
    // decisionId-STAMPED withdrawal notice, so an operator re-run of the rerunnable file
    // erased the withdrawal record's own notice. The retire arm is now identity + the PENDING
    // text shape: stale bells retire, the withdrawal notice survives every re-run.
    it('R14-F1: a migration re-run retires the stale stamped pending bell but NEVER the withdrawal notice the command wrote', async () => {
      const { execFileSync } = await import('node:child_process');
      const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20270810000000_phase6_t4a_withdraw/migration.sql');
      const dbUrl = (process.env.DATABASE_URL ?? '').split('?')[0]!;
      const id = await seed({ title: 'Rerun survivor' });
      await svc.withdraw(f.projectA.id, id, { reason: 'the notice must survive re-runs' }, pmc());
      const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: id } });
      expect(notice.text.startsWith('Decision withdrawn')).toBe(true);
      // the stale shape the retire arm EXISTS for: a stamped pending bell a partial/manual
      // apply left behind (no command ever retired it)
      await t.prisma.notification.create({
        data: { projectId: f.projectA.id, decisionId: id, text: 'Decision awaiting approval: Rerun survivor', color: '#C08A2D', time: '2d ago' },
      });
      applyMigrationThroughHead(dbUrl, '20270810000000_phase6_t4a_withdraw');
      const after = await t.prisma.notification.findMany({ where: { decisionId: id } });
      expect(after.map((n) => n.text.split(':')[0])).toEqual(['Decision withdrawn']);
    });

    // R14-F2 — the destructive resets in THIS suite toggled the seals with sequential awaits:
    // a wipe failing mid-sequence (a future child FK, a lock timeout) would skip the ENABLE
    // statements and leave the shared database's evidence seals off for every later probe.
    // Every disable → wipe → enable trio is now ONE `$transaction([...])` array — the same
    // R6-F4 discipline the seed's wipe already pins — so a failed wipe rolls the DISABLE back.
    it('R14-F2: every seal toggle in this suite is atomic — no standalone awaited DISABLE/ENABLE remains', () => {
      const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      // the sequential shape is unrepresentable: an awaited raw ALTER is spelled as
      // an await-prefixed executeRawUnsafe ALTER — while the atomic arrays carry the same
      // calls WITHOUT the await prefix as `$transaction` items. (The regex below is escaped,
      // so neither it nor this comment can match it.)
      expect(self).not.toMatch(/await t\.prisma\.\$executeRawUnsafe\('ALTER TABLE/);
      // and the trios exist: every DISABLE has its ENABLE in the same file
      const disables = (self.match(/DISABLE TRIGGER/g) ?? []).length;
      const enables = (self.match(/ENABLE TRIGGER/g) ?? []).length;
      expect(disables).toBeGreaterThan(0);
      expect(enables).toBeGreaterThanOrEqual(disables - 2); // the two seed-source index probes count once each
    });
  });

  describe('round 15 (Codex): the publication fact on entry, session-timezone-proof repair, TRUNCATE-proof evidence', () => {
    // R15-F1 — the entry arm proved the old row WAS published but never froze the timestamp on
    // the transition, so the withdrawing statement itself could forge the issue time the
    // permanent register records (the terminal arm freezes it only once already withdrawn).
    it('R15-F1: the withdrawing statement cannot rewrite publishedAt — the publication fact is frozen on entry', async () => {
      const id = await seed({ title: 'Forged issue time' });
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "publishedAt"=now() - interval '400 days', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='forged issue time' WHERE "id"=${id}`,
      ).rejects.toThrow(/publishedAt is frozen on entry/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    });

    // R15-F2 — `ts AT TIME ZONE 'UTC'` on a WITHOUT-time-zone column re-renders the timestamp
    // in the SESSION timezone, so an operator running the migration through a non-UTC psql
    // (psqlrc, PGTZ) wrote shifted withdrawnAt strings into the repaired dtos. The formatter
    // now renders the stored UTC digits directly — session-independent — in BOTH repair arms
    // (the stale-row correction and the missing-row seed), pinned by running the REAL file
    // under an Asia/Kolkata session and comparing through the operator diagnostic.
    it('R15-F2: the projection repair serializes withdrawnAt identically under a non-UTC session — both repair arms', async () => {
      const { execFileSync } = await import('node:child_process');
      const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20270810000000_phase6_t4a_withdraw/migration.sql');
      const dbUrl = (process.env.DATABASE_URL ?? '').split('?')[0]!;
      const projW = `it-t4a-r15w-${Date.now() % 1e6}`;
      await t.prisma.project.create({
        data: { id: projW, orgId: f.orgA.id, name: projW, short: 'W', descriptor: '', stage: 'x', siteCode: 'W', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      });
      await t.prisma.membership.create({ data: { projectId: projW, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
      await seedAdHocClient(projW);
      const idMissing = 'DL-t4a-r15m';
      const idStale = 'DL-t4a-r15s';
      for (const [id, title] of [[idMissing, 'Missing-row arm'], [idStale, 'Stale-row arm']] as const) {
        await t.prisma.decision.create({
          data: { id, projectId: projW, title, room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
        });
        await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
        // Phase 6 task 4b: a PUBLISHED ordinary decision must be approvable, so it needs two
        // options and they must exist BEFORE publication. This fixture modelled a state the
        // product now forbids (published with fewer than two options, approvable by nobody).
        await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt B', optionKey: 'b', material: 'Oak', delta: 1000, swatch: 'sw2', recommended: false, order: 1 } });
        await t.prisma.decision.update({ where: { id: id }, data: { publishedAt: new Date() } });
      }
      const drain = async (): Promise<void> => {
        for (let pass = 0; pass < 50; pass++) {
          const ds = await t.prisma.outboxDelivery.findMany({
            where: { consumer: 'decisions.inbox', projectId: projW, status: { in: ['pending', 'leased'] } },
            orderBy: { streamPosition: 'asc' },
          });
          if (!ds.length) break;
          for (const d of ds) await relay.dispatchOne(d.id);
        }
      };
      try {
        for (const id of [idMissing, idStale]) {
          await t.prisma.$transaction(async (tx) => {
            await emitEvent(tx, { projectId: projW, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId: id, payload: {}, effectKey: 'decision.published', dispatch: {} });
          });
        }
        await drain();
        const gen = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: 'decisions.inbox', projectId: projW, status: 'active' } });
        await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='Manual PMC', "withdrawReason"='tz probe' WHERE "id" IN (${idMissing}, ${idStale})`;
        // the two stale shapes: idMissing has NO row (seed arm); idStale keeps its pending row (correction arm)
        await t.prisma.decisionProjection.deleteMany({ where: { generationId: gen.id, decisionId: idMissing } });
        // the operator's psql session is NOT UTC — the repair must not care
        // this arm's POINT is the session timezone, so the re-run stays explicit — and is then
        // followed by the replay-to-head that every re-run of an earlier migration owes
        execFileSync('psql', [dbUrl, '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], { stdio: 'pipe', env: { ...process.env, PGTZ: 'Asia/Kolkata' } });
        applyMigrationThroughHead(dbUrl, '20270810000000_phase6_t4a_withdraw');
        const replacement = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: 'decisions.inbox', projectId: projW, status: 'active' } });
        const stored = await storedDecisionRows(t.prisma, replacement.id);
        const canonical = await computeDecisionRows(t.prisma, projW);
        expect(stored).toEqual(canonical);
      } finally {
        await t.prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "CommandExecution" CASCADE',
        );
        await t.prisma.notification.deleteMany({ where: { projectId: projW } });
        await t.prisma.auditLog.deleteMany({ where: { projectId: projW } });
        await t.prisma.$transaction([
          t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
          t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: projW } } }),
          t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: projW } } }),
          t.prisma.decision.deleteMany({ where: { projectId: projW } }),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
          t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
        ]); // R14-F2: atomic — a failed wipe rolls the disables back
        await t.prisma.membership.deleteMany({ where: { projectId: projW } });
        await t.prisma.user.deleteMany({ where: { projectId: projW } });
        await t.prisma.project.deleteMany({ where: { id: projW } });
      }
    });

    // R15-F3 — TRUNCATE fires no row trigger, so the approval events the entry seal counts
    // could be erased WHOLESALE where a row-wise DELETE is refused (and TRUNCATE is grantable
    // separately from ownership — WEAKER than the DISABLE TRIGGER boundary). The statement
    // guard is conditional (precision, not mere strictness): an approval-free table still
    // truncates.
    it('R15-F3: TRUNCATE of DecisionEvent refuses while approval evidence exists — and passes once none does', async () => {
      const id = await seed({ title: 'Truncate laundering' });
      await t.prisma.decisionEvent.create({ data: { id: 'r15-lev', decisionId: id, type: 'approved', actor: 'Legacy Client' } });
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE "DecisionEvent"')).rejects.toThrow(/approval evidence/);
      // the evidence stands, so the laundered withdrawal stays refused
      await expect(
        t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='laundered by truncate' WHERE "id"=${id}`,
      ).rejects.toThrow(/legacy approval event/);
      // precision: with the approval evidence gone through the SANCTIONED reset, truncate passes
      await wipeDecisionEvents(t.prisma, { id: 'r15-lev' });
      expect(await t.prisma.$executeRawUnsafe('TRUNCATE "DecisionEvent"')).toBeDefined();
    });

    // R15-F4 — the touch-note guard was row-level only: one transaction could edit a published
    // pending decision's options, TRUNCATE the note table (no row trigger fires), then
    // withdraw. The statement guard refuses a truncate from any transaction that wrote notes
    // ITSELF; committed notes from other transactions are inert history, so housekeeping
    // truncates pass.
    it('R15-F4: the withdrawing transaction cannot TRUNCATE its own touch notes — and a separate-transaction truncate still passes', async () => {
      const id = await seed({ title: 'Truncate the note' });
      await expect(
        t.prisma.$transaction([
          // 4b's published-option freeze is off by name: this arm pins the TRUNCATE guard
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
          t.prisma.$executeRaw`UPDATE "DecisionOption" SET "material"='Swapped under truncate' WHERE "decisionId"=${id} AND "optionKey"='a'`,
          t.prisma.$executeRawUnsafe('TRUNCATE "DecisionOptionTouch"'),
          t.prisma.$executeRaw`UPDATE "Decision" SET "status"='withdrawn', "withdrawnAt"=now(), "withdrawnById"=${f.memberUser.id}, "withdrawnByName"='X', "withdrawReason"='hidden by truncate' WHERE "id"=${id}`,
          t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        ]),
      ).rejects.toThrow(/cannot be truncated/);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
      // precision: a SEPARATE transaction (no own notes) may truncate the inert history
      expect(await t.prisma.$executeRawUnsafe('TRUNCATE "DecisionOptionTouch"')).toBeDefined();
      // and a clean later withdrawal still succeeds
      await svc.withdraw(f.projectA.id, id, { reason: 'clean withdrawal after' }, pmc());
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
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
      await seedAdHocClient(proj13);
    const id = 'DL-t4a-p13';
    await t.prisma.decision.create({
      data: { id, projectId: proj13, title: 'Projected', room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
    });
    await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 } });
    // Phase 6 task 4b: a PUBLISHED ordinary decision must be approvable, so it needs two
    // options and they must exist BEFORE publication. This fixture modelled a state the
    // product now forbids (published with fewer than two options, approvable by nobody).
    await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt B', optionKey: 'b', material: 'Oak', delta: 1000, swatch: 'sw2', recommended: false, order: 1 } });
    await t.prisma.decision.update({ where: { id: id }, data: { publishedAt: new Date() } });
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
      // this probe's row IS withdrawn — the same sanctioned destructive-reset bypass as
      // cleanup(), covering the option/event seals (rounds 11-12) and the delete arm alike
      await t.prisma.$transaction([
        t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
        t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } }),
        t.prisma.decisionOption.deleteMany({ where: { decisionId: id } }),
        t.prisma.decision.deleteMany({ where: { id } }),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
        t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
      ]); // R14-F2: atomic — a failed wipe rolls the disables back
      await t.prisma.membership.deleteMany({ where: { projectId: proj13 } });
        await t.prisma.user.deleteMany({ where: { projectId: proj13 } });
      await t.prisma.project.deleteMany({ where: { id: proj13 } });
    }
  });
});
