import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, insertRawEventVia, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { DECISIONS_EFFECTS, MEMBERSHIP_STANDING_ACTOR, classifyCrossing } from '../../src/decisions/decisions.effects';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { PUSH_CONSUMER, SOCKET_CONSUMER } from '../../src/platform/outbox/consumers';
import { listConsumers } from '../../src/platform/outbox/registry';
import { EXTERNAL_EFFECTS, effectCoverageVersion } from '../../src/platform/external-effects';
import { EventStreamQuery } from '../../src/platform/event-stream.query';
import { RoleStandingQuery } from '../../src/platform/role-standing.query';
import { PHASE6_4D_RESERVATION_DOORS } from '../../src/platform/phase6-4d-rollout';
import { compiledCatalogVersion } from '../../src/platform/release-lease.service';

/**
 * Phase 6 task 4d unit 4d-ii-a / A7d — THE CATALOG CHANGE, driven live (plan §A.2 "the push families",
 * "the re-notification and the last-architect cancellation"; §D 4d-ii; the staging document's A7d note).
 *
 * The doors 4d-i installs and 4d-iii drops are DROPPED for this suite (captured from the catalog and
 * re-created after), because every shape it proves is the one they reserve: an architect membership,
 * a decision designated to the role or awaiting its countersign, a `countersign_renotified` audit
 * row. That is 4d-iii's act, rehearsed and undone — the suite's last arm asserts every door stands
 * again. `decisions.effects` is registered INACTIVE by the migration and ACTIVATED here through the
 * operator protocol (the register's own INSERT), then deactivated the same way.
 *
 * What is proven:
 *   - the contract: `webpush.notify` at 3 persisted and compiled, `decisions.effects` inactive with its
 *     head, `decisions.inbox`'s rule carrying the two decision types, the widened generation seeded;
 *   - the emitter: `members.add` / `members.remove` / `members.updateRole` announce an architect-
 *     standing FLIP (and only a flip) as `membership.standing_changed` about the membership, claimed
 *     by the transition, invalidating, pushing nothing;
 *   - the seals: the frozen `targetUserIds` set refused on a non-frozen family; a standalone
 *     standing event refused unclaimed; a system re-notification refused when bound to no crossing;
 *   - the consumer: a deactivation cancels the unsent countersign demands; an activation re-emits ONE
 *     demand per awaiting decision to the CURRENT architects (frozen, claimed by its audit row), skips a
 *     decision whose demand is later than the crossing, and records a stale activation as a no-op;
 *   - the predicates: `countersignPushTarget`, `forwardPushTarget`, `deciderPushTarget`'s architect arm.
 */
describe('4d-ii-a / A7d — the catalog change: the widened generation, the frozen families, the standing flip and decisions.effects (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let relay: OutboxRelay;
  let pmcToken: string;
  const run = randomUUID().slice(0, 8);
  const OP_TOKENS: string[] = [];
  let doorDefs: Array<{ tgname: string; def: string }> = [];
  const architect = { id: '', membershipId: '' };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    relay = t.app.get(OutboxRelay);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    // 4d-iii's act, rehearsed: capture and drop the six reservation doors for the suite
    doorDefs = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS],
    );
    expect(doorDefs.map((d) => d.tgname)).toEqual([...PHASE6_4D_RESERVATION_DOORS].sort());
    for (const d of doorDefs) {
      const table = /ON public\."?(\w+)"?/.exec(d.def)![1];
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER "${d.tgname}" ON "${table}"`);
    }
  });

  afterAll(async () => {
    const projectId = f?.projectA.id;
    try {
      if (t?.prisma && projectId) {
        await appendActivation(false, 'A7d suite teardown: decisions.effects back to the inactive registration');
        await wipeDecisionEvents(t.prisma, { decision: { projectId } });
        await wipeDecisionsVia(t.prisma, async (tx) => {
          await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
          await tx.decision.deleteMany({ where: { projectId } });
        });
        // an ACTIVE architect membership is a standing the seals let only an attributable act end:
        // the delivered command removes them (the decisions that held the role are gone), so the
        // row deletes below flip nothing
        if (architect.id && (await t.prisma.membership.count({ where: { userId: architect.id, status: 'active' } })) > 0) {
          await removeMember(architect.id);
        }
        await sanctionedReset(t.prisma, [
          'Notification', 'DecisionApprovalRevision', 'ChangeRequest',
          'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'CommandExecution',
          'DecisionProjection', 'ProjectionGeneration', 'DomainEventPairingClaim',
        ], { cascade: true });
        // every identity this suite provisioned (`add` mints the user), by the email it gave them
        const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 'a7d-', endsWith: `-${run}@test.local` } }, select: { id: true } });
        const ids = [...new Set([...createdUserIds, ...provisioned.map((u) => u.id)])];
        await wipeMembershipTransitionsVia(t.prisma, [...ids, f.memberUser.id]);
        await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
        await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    } catch (e) {
      // named, so a teardown failure is read as its own and not as the fixture's
      console.error('A7d teardown failed before the fixture cleanup:', e);
      throw e;
    } finally {
      // the doors go back, from the definitions the catalog held
      for (const d of doorDefs) await t.prisma.$executeRawUnsafe(d.def);
      await f?.cleanup();
      await t?.close();
    }
  });

  const http = () => request(t.app.getHttpServer());
  const members = () => `/projects/${f.projectA.id}/members`;
  const addMember = (body: object) => http().post(members()).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const removeMember = (userId: string) => http().delete(`${members()}/${userId}`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send();
  const patchMember = (userId: string, body: object) => http().patch(`${members()}/${userId}`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const OPTIONS = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];
  const issue = async (over: object = {}): Promise<string> => {
    const title = `A7d ${randomUUID().slice(0, 8)}`;
    // the `countersign-v1` client contract (A5e): an architect designation is refused to a lesser client
    const r = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .set('x-vitan-decisions-contract', 'countersign-v1')
      .send({ title, room: 'Kitchen', publish: true, options: OPTIONS, ...over });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };
  /** A decision parked awaiting its countersign: the status planted past the seals (A8a's approve is the writer). */
  const park = (decisionId: string) => t.prisma.$transaction([
    t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
    t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = '${decisionId}'`),
    t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
  ]);

  const standingEvents = () => t.prisma.domainEvent.findMany({
    where: { projectId: f.projectA.id, eventType: 'membership.standing_changed' }, orderBy: { streamPosition: 'asc' },
  });
  const demandsOf = (decisionId: string) => t.prisma.domainEvent.findMany({
    where: { projectId: f.projectA.id, eventType: 'decision.awaiting_countersign', entityId: decisionId }, orderBy: { streamPosition: 'asc' },
  });
  const pushRowsOf = (eventId: string) => t.prisma.outboxDelivery.findMany({ where: { eventId, consumer: PUSH_CONSUMER } });
  const claimOf = (eventId: string) => t.prisma.domainEventPairingClaim.findUnique({ where: { eventId } });

  /** The operator protocol: append an activation fact for `decisions.effects` (A6a's register). */
  const appendActivation = async (active: boolean, reason: string): Promise<void> => {
    const token = `a7d-${run}-${OP_TOKENS.length}`;
    OP_TOKENS.push(token);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxConsumerActivation" ("consumer","seq","active","reason","actorKind","actorId","requestToken")
       VALUES ($1, (SELECT "activationSeq" + 1 FROM "OutboxConsumerCatalog" WHERE "consumer" = $1), $2, $3, 'operator', 'a7d-suite', $4)`,
      DECISIONS_EFFECTS, active, reason, token,
    );
  };
  /** Drive every pending `decisions.effects` delivery of project A through the relay, in order. */
  const applyEffects = async (): Promise<void> => {
    for (let pass = 0; pass < 40; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({
        where: { consumer: DECISIONS_EFFECTS, projectId: f.projectA.id, status: { in: ['pending', 'leased'] } },
        orderBy: { streamPosition: 'asc' },
      });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };
  const effectsRowOf = (eventId: string) => t.prisma.outboxDelivery.findFirst({ where: { eventId, consumer: DECISIONS_EFFECTS } });

  /**
   * A countersign DEMAND planted as the RE-NOTIFICATION shape (the one writer that exists before A8a):
   * the frozen event at the compiled generation naming `crossingEventId`, its delivery rows, and the
   * `countersign_renotified` audit row 4d-i's claimant claims it through.
   */
  const plantDemand = async (decisionId: string, crossingEventId: string, transitionId: string, targetUserIds: string[]): Promise<string> => {
    const eventId = randomUUID();
    const body = EXTERNAL_EFFECTS['decision.awaiting_countersign'].pushBody;
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
    await t.prisma.$transaction(async (tx) => {
      // through the allocator (`insertRawEventVia`): the plant's own intent, the system actor the
      // re-notification is attributed to, and the delivery rows a direct writer owes
      await insertRawEventVia(tx, {
        projectId: f.projectA.id, organizationId: f.orgA.id, eventId,
        eventType: 'decision.awaiting_countersign', entityType: 'Decision', entityId: decisionId,
        actor: { actorKind: 'system', systemActor: MEMBERSHIP_STANDING_ACTOR },
        columns: ['"payload"', '"dispatchIntent"'],
        values: [
          `${q(JSON.stringify({ renotified: true, crossingEventId, transitionId }))}::jsonb`,
          `${q(JSON.stringify({ effectKey: 'decision.awaiting_countersign', coverageVersion: effectCoverageVersion(), invalidate: true, push: { body, roles: ['architect'], targetUserIds: [...targetUserIds].sort() } }))}::jsonb`,
        ],
      });
      await tx.decisionEvent.create({ data: { decisionId, type: 'countersign_renotified', actor: 'Membership standing', actorName: 'Membership standing', actorRole: 'system', payload: { eventId, crossingEventId, transitionId } } });
    });
    return eventId;
  };

  // ── the contract ─────────────────────────────────────────────────────────────────────────────

  it('webpush.notify reads 3 persisted and compiled; decisions.effects is registered INACTIVE with its head; decisions.inbox\'s rule carries the two decision types; the widened generation is seeded beside three', async () => {
    const rows = await t.prisma.outboxConsumerCatalog.findMany({ where: { consumer: { in: [PUSH_CONSUMER, DECISIONS_EFFECTS, 'decisions.inbox'] } } });
    const by = Object.fromEntries(rows.map((r) => [r.consumer, r]));
    expect(by[PUSH_CONSUMER]).toMatchObject({ catalogVersion: 3, consumerKind: 'unordered', consumerEffect: 'external', dispatchRule: 'push' });
    // (`active`/`activationSeq` are the register's live mirror — this suite activates it below and
    // deactivates it after, so the REGISTRATION head at seq 1 is what pins the migration's act)
    expect(by[DECISIONS_EFFECTS]).toMatchObject({ catalogVersion: 1, consumerKind: 'ordered', consumerEffect: 'db', dispatchRule: 'types', subscribedEventTypes: ['membership.standing_changed'] });
    expect(by['decisions.inbox']!.subscribedEventTypes).toEqual(expect.arrayContaining(['decision.awaiting_countersign', 'decision.forwarded']));
    const head = await t.prisma.$queryRawUnsafe<Array<{ active: boolean; actorKind: string }>>(`SELECT "active", "actorKind" FROM "OutboxConsumerActivation" WHERE "consumer" = $1 AND "seq" = 1`, DECISIONS_EFFECTS);
    expect(head).toEqual([{ active: false, actorKind: 'registration' }]);
    // the app booted, so `syncConsumerCatalog` accepted every row: compiled == persisted
    expect(listConsumers().find((c) => c.name === PUSH_CONSUMER)?.catalogVersion).toBe(3);
    expect(listConsumers().find((c) => c.name === DECISIONS_EFFECTS)?.kind).toBe('ordered');
    expect(compiledCatalogVersion()).toBe(3);
    const gens = await t.prisma.$queryRawUnsafe<Array<{ v: string; n: number }>>(`SELECT "coverageVersion" AS v, count(*)::int AS n FROM "ExternalEffectCatalog" GROUP BY 1 ORDER BY 1`);
    expect(gens).toHaveLength(4);
    expect(gens.find((g) => g.v === effectCoverageVersion())?.n).toBe(Object.keys(EXTERNAL_EFFECTS).length);
  });

  // ── the seals ────────────────────────────────────────────────────────────────────────────────

  /** A hostile raw plant through the allocator (`insertRawEventVia`), attributed to the actor the arm names. */
  const rawEvent = (spec: { type: string; key: string; actor: 'human' | 'system'; payload?: object; push?: object }) =>
    t.prisma.$transaction(async (tx) => {
      const eventId = randomUUID();
      const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
      await insertRawEventVia(tx, {
        projectId: f.projectA.id, organizationId: f.orgA.id, eventId,
        eventType: spec.type, entityType: 'Decision', entityId: 'a7d-raw-dec',
        actor: spec.actor === 'human' ? { actorKind: 'human', actorId: f.memberUser.id } : { actorKind: 'system', systemActor: MEMBERSHIP_STANDING_ACTOR },
        columns: ['"payload"', '"dispatchIntent"'],
        values: [
          `${q(JSON.stringify(spec.payload ?? {}))}::jsonb`,
          `${q(JSON.stringify({ effectKey: spec.key, coverageVersion: effectCoverageVersion(), invalidate: true, ...(spec.push ? { push: spec.push } : {}) }))}::jsonb`,
        ],
      });
    });

  it('the frozen recipient SET is refused on a non-frozen family; a standing event no transition claims is refused; a system re-notification bound to no crossing is refused', async () => {
    await expect(rawEvent({ type: 'decision.published', key: 'decision.published', actor: 'human', push: { body: 'x', roles: ['client'], targetUserIds: [f.clientUser.id] } }))
      .rejects.toThrow(/only a frozen-audience family resolves its recipients as a set/);
    await expect(rawEvent({ type: 'membership.standing_changed', key: 'membership.standing_changed', actor: 'human', payload: { role: 'architect' } }))
      .rejects.toThrow(/requires a pairing claim and none was made/);
    await expect(rawEvent({ type: 'decision.awaiting_countersign', key: 'decision.awaiting_countersign', actor: 'system', payload: { renotified: true }, push: { body: EXTERNAL_EFFECTS['decision.awaiting_countersign'].pushBody, roles: ['architect'], targetUserIds: ['u'] } }))
      .rejects.toThrow(/does not name the crossing it answers/);
  });

  // ── the emitter ──────────────────────────────────────────────────────────────────────────────

  it('members.add of the FIRST architect announces the flip: one membership.standing_changed about the membership, claimed by the transition, invalidating, no push, no decisions.effects row while inactive', async () => {
    expect(await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect')).toBe(0);
    const r = await addMember({ name: `A7d Architect ${run}`, role: 'architect', email: `a7d-arch-${run}@test.local` });
    expect(r.status, r.text).toBe(201);
    architect.id = r.body.userId;
    architect.membershipId = r.body.membershipId;
    createdUserIds.push(architect.id);
    const [ev, ...more] = await standingEvents();
    expect(more).toHaveLength(0);
    const fact = await t.prisma.membershipTransition.findFirstOrThrow({ where: { membershipId: architect.membershipId } });
    expect(ev).toMatchObject({
      entityType: 'Membership', entityId: architect.membershipId, actorKind: 'human', actorId: f.memberUser.id,
      actorRole: fact.actorRole, actorName: fact.actorName,
      payload: { role: 'architect', membershipId: architect.membershipId, transitionId: fact.id, from: { role: null, status: null }, to: { role: 'architect', status: 'active' }, activeCount: 1 },
    });
    expect((ev!.dispatchIntent as { invalidate: boolean; push?: unknown })).toMatchObject({ invalidate: true, effectKey: 'membership.standing_changed', coverageVersion: effectCoverageVersion() });
    expect((ev!.dispatchIntent as { push?: unknown }).push).toBeUndefined();
    expect(await claimOf(ev!.eventId)).toMatchObject({ claimedBy: 'MembershipTransition', claimedById: fact.id });
    expect(classifyCrossing(ev!.payload as never)).toBe('activation');
    const rows = await t.prisma.outboxDelivery.findMany({ where: { eventId: ev!.eventId } });
    expect(rows.find((x) => x.consumer === SOCKET_CONSUMER)?.deliveryAction).toBe('dispatch');
    expect(rows.find((x) => x.consumer === PUSH_CONSUMER)?.deliveryAction).toBe('noop');
    expect(rows.find((x) => x.consumer === DECISIONS_EFFECTS), 'inactive: no row is owed').toBeUndefined();
  });

  it('a write that flips nothing announces nothing: an engineer\'s add and a role change away from and back to engineer; a SECOND architect is a per-membership flip the consumer classifies as no crossing', async () => {
    const before = (await standingEvents()).length;
    const eng = await addMember({ name: `A7d Engineer ${run}`, role: 'engineer', email: `a7d-eng-${run}@test.local` });
    expect(eng.status, eng.text).toBe(201);
    createdUserIds.push(eng.body.userId);
    expect((await patchMember(eng.body.userId, { role: 'contractor' })).status).toBe(200);
    expect((await standingEvents()).length).toBe(before);
    // the engineer re-roled INTO the architect role: a flip on their membership, but the chain was
    // already active — activeCount 2 is not a crossing
    expect((await patchMember(eng.body.userId, { role: 'architect' })).status).toBe(200);
    const events = await standingEvents();
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)!.payload).toMatchObject({ role: 'architect', from: { role: 'contractor', status: 'active' }, to: { role: 'architect', status: 'active' }, activeCount: 2 });
    expect(classifyCrossing(events.at(-1)!.payload as never)).toBeNull();
    // …and back out: activeCount 1 with `to` not an active architect — not a crossing either
    expect((await patchMember(eng.body.userId, { role: 'engineer' })).status).toBe(200);
    const after = await standingEvents();
    expect(after.length).toBe(before + 2);
    expect(after.at(-1)!.payload).toMatchObject({ from: { role: 'architect', status: 'active' }, to: { role: 'engineer', status: 'active' }, activeCount: 1 });
    expect(classifyCrossing(after.at(-1)!.payload as never)).toBeNull();
    expect(await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect')).toBe(1);
  });

  // ── decisions.effects ────────────────────────────────────────────────────────────────────────

  it('ACTIVATED through the register, decisions.effects gets a dispatch row per standing event and a noop row per other event; the history it never saw is expanded as no-ops', async () => {
    await appendActivation(true, 'A7d suite: 4d-iii\'s activation, rehearsed');
    expect((await t.prisma.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer: DECISIONS_EFFECTS } })).active).toBe(true);
    await relay.expandMissingDeliveries();
    const rows = await t.prisma.outboxDelivery.findMany({ where: { consumer: DECISIONS_EFFECTS, projectId: f.projectA.id }, include: { event: { select: { eventType: true } } } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.deliveryAction, r.event.eventType).toBe(r.event.eventType === 'membership.standing_changed' ? 'dispatch' : 'noop');
    // the history: every crossing so far is handled — no decision was awaiting at any of them
    // (the predicates arm below parks its decisions AFTER this activation)
    await applyEffects();
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: DECISIONS_EFFECTS, projectId: f.projectA.id, status: { not: 'succeeded' } } })).toBe(0);
    expect(await t.prisma.decisionEvent.count({ where: { type: 'countersign_renotified', decision: { projectId: f.projectA.id } } })).toBe(0);
  });

  // ── the predicates ───────────────────────────────────────────────────────────────────────────

  it('countersignPushTarget names the current architects of an awaiting decision; forwardPushTarget the current holder of an OPEN one; deciderPushTarget pushes an architect-designated decision at the role', async () => {
    const awaiting = await issue();
    await park(awaiting);
    expect(await query.countersignPushTarget(f.projectA.id, awaiting)).toEqual({ actionable: true, targetUserIds: [architect.id] });
    expect(await query.forwardPushTarget(f.projectA.id, awaiting), 'a parked decision is the architect\'s, not a forward\'s').toEqual({ actionable: false });
    const clientHeld = await issue();
    expect(await query.countersignPushTarget(f.projectA.id, clientHeld)).toEqual({ actionable: false });
    const holders = await query.forwardPushTarget(f.projectA.id, clientHeld);
    expect(holders).toMatchObject({ actionable: true });
    expect((holders as { targetUserIds: string[] }).targetUserIds).toContain(f.clientUser.id);
  });

  it('a DEACTIVATION cancels the unsent countersign demands of every awaiting decision; an ACTIVATION re-emits ONE frozen demand to the CURRENT architect, claimed by its audit row; a demand later than the crossing is SKIPPED', async () => {
    const d1 = await issue();
    await park(d1);
    const crossing = (await standingEvents())[0]!;
    const demand0 = await plantDemand(d1, crossing.eventId, (crossing.payload as { transitionId: string }).transitionId, [architect.id]);
    expect(await claimOf(demand0)).toMatchObject({ claimedBy: 'DecisionEvent' });
    expect((await pushRowsOf(demand0))[0]).toMatchObject({ status: 'pending', deliveryAction: 'dispatch', payload: { targetUserIds: [architect.id] } });

    // the LAST architect leaves: the crossing is a deactivation
    const gone = await removeMember(architect.id);
    expect(gone.status, gone.text).toBe(200);
    const deactivation = (await standingEvents()).at(-1)!;
    expect(deactivation.payload).toMatchObject({ to: { role: 'architect', status: 'removed' }, activeCount: 0 });
    expect(classifyCrossing(deactivation.payload as never)).toBe('deactivation');
    await applyEffects();
    expect((await pushRowsOf(demand0))[0], 'the unsent demand is cancelled by subject').toMatchObject({ status: 'succeeded', deliveryAction: 'noop', cancelledAt: expect.any(Date) });
    expect(await demandsOf(d1)).toHaveLength(1);
    expect(await query.countersignPushTarget(f.projectA.id, d1), 'no architect: the demand is not actionable').toEqual({ actionable: false });

    // the architect returns: the crossing is an activation, and the parked decision is re-demanded of them
    const back = await addMember({ name: `A7d Architect ${run}`, role: 'architect', email: `a7d-arch-${run}@test.local` });
    expect(back.status, back.text).toBe(201);
    expect(back.body.userId).toBe(architect.id);
    const activation = (await standingEvents()).at(-1)!;
    expect(classifyCrossing(activation.payload as never)).toBe('activation');
    await applyEffects();
    const demands = await demandsOf(d1);
    expect(demands).toHaveLength(2);
    const fresh = demands[1]!;
    expect(fresh).toMatchObject({
      actorKind: 'system', systemActor: MEMBERSHIP_STANDING_ACTOR, causedByEventId: activation.eventId,
      // 4d-iii / R0c — the re-notification names its automation: the system pair, beside the constant
      actorId: null, actorRole: 'system', actorName: 'decisions-effects',
      payload: { renotified: true, crossingEventId: activation.eventId, transitionId: (activation.payload as { transitionId: string }).transitionId },
    });
    expect((fresh.dispatchIntent as { push: unknown }).push).toEqual({ body: EXTERNAL_EFFECTS['decision.awaiting_countersign'].pushBody, roles: ['architect'], targetUserIds: [architect.id] });
    expect(await claimOf(fresh.eventId)).toMatchObject({ claimedBy: 'DecisionEvent' });
    expect((await pushRowsOf(fresh.eventId))[0]).toMatchObject({ status: 'pending', deliveryAction: 'dispatch', subject: d1, payload: { targetUserIds: [architect.id] } });
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: d1, type: 'countersign_renotified' } })).toBe(2);
    expect(await EventStreamQuery.latestPosition(t.prisma, f.projectA.id, 'decision.awaiting_countersign', 'Decision', d1)).toBe(fresh.streamPosition);
    expect(await query.countersignPushTarget(f.projectA.id, d1)).toEqual({ actionable: true, targetUserIds: [architect.id] });

    // a demand raised AFTER a crossing is left alone by that crossing's handler: remove, re-add, and
    // plant a demand naming the re-add BEFORE the relay reaches it
    expect((await removeMember(architect.id)).status).toBe(200);
    await applyEffects();
    expect((await pushRowsOf(fresh.eventId))[0]).toMatchObject({ deliveryAction: 'noop', cancelledAt: expect.any(Date) });
    expect((await addMember({ name: `A7d Architect ${run}`, role: 'architect', email: `a7d-arch-${run}@test.local` })).status).toBe(201);
    const later = (await standingEvents()).at(-1)!;
    const planted = await plantDemand(d1, later.eventId, (later.payload as { transitionId: string }).transitionId, [architect.id]);
    await applyEffects();
    expect((await pushRowsOf(planted))[0], 'the later demand stands').toMatchObject({ status: 'pending', deliveryAction: 'dispatch' });
    expect(await demandsOf(d1), 'no fourth demand: the handler skipped a decision whose demand is later than its crossing').toHaveLength(3);
  });

  it('a STALE activation — reversed before the consumer reached it — is a recorded no-op: the delivery marked, nothing emitted, nothing cancelled; the deactivation that follows cancels', async () => {
    const d2 = await issue();
    await park(d2);
    const holder = (await standingEvents()).at(-1)!;
    const demand = await plantDemand(d2, holder.eventId, (holder.payload as { transitionId: string }).transitionId, [architect.id]);
    // remove (deactivation), re-add (activation Q), remove (deactivation R) — all before the relay runs
    expect((await removeMember(architect.id)).status).toBe(200);
    const p = (await standingEvents()).at(-1)!;
    expect((await addMember({ name: `A7d Architect ${run}`, role: 'architect', email: `a7d-arch-${run}@test.local` })).status).toBe(201);
    const q = (await standingEvents()).at(-1)!;
    expect((await removeMember(architect.id)).status).toBe(200);
    const r = (await standingEvents()).at(-1)!;
    expect([classifyCrossing(p.payload as never), classifyCrossing(q.payload as never), classifyCrossing(r.payload as never)]).toEqual(['deactivation', 'activation', 'deactivation']);
    const demandsBefore = (await demandsOf(d2)).length;
    await applyEffects();
    expect(await effectsRowOf(q.eventId)).toMatchObject({ status: 'succeeded', deliveryAction: 'noop', cancelledAt: expect.any(Date) });
    expect(await effectsRowOf(p.eventId)).toMatchObject({ status: 'succeeded', deliveryAction: 'dispatch' });
    expect(await effectsRowOf(r.eventId)).toMatchObject({ status: 'succeeded', deliveryAction: 'dispatch' });
    expect((await demandsOf(d2)).length, 'the stale activation re-emitted nothing').toBe(demandsBefore);
    expect((await pushRowsOf(demand))[0], 'P cancelled the pre-P demand; R found nothing left').toMatchObject({ deliveryAction: 'noop', cancelledAt: expect.any(Date) });
    expect(await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect')).toBe(0);
  });

  it('deciderPushTarget pushes an architect-designated decision at the ROLE (the widened ceiling), and its forward push at the role\'s current holders', async () => {
    // seated last: an open decision held by the architect role blocks the removal of its last holder
    // (A5d's guard), which the crossing arms above rely on
    expect((await addMember({ name: `A7d Architect ${run}`, role: 'architect', email: `a7d-arch-${run}@test.local` })).status).toBe(201);
    await applyEffects();
    const architectHeld = await issue({ deciderKind: 'architect' });
    expect(await query.deciderPushTarget(f.projectA.id, architectHeld)).toEqual({ actionable: true, roles: ['architect'] });
    expect(await query.forwardPushTarget(f.projectA.id, architectHeld)).toEqual({ actionable: true, targetUserIds: [architect.id] });
    expect(await query.countersignPushTarget(f.projectA.id, architectHeld)).toEqual({ actionable: false });
  });

  it('4d-iii / R0a-2 (Codex 4198541073): an actor flipping THEIR OWN architect standing announces it as they stood — a PMC re-roling themselves, an owner adding themselves', async () => {
    // The flip is emitted with the transition fact's pre-state pair, BEFORE the membership write, as the
    // fact is: the envelope seal judges the pair at INSERT, and after the write the actor no longer holds
    // the role they acted in. Its `activeCount` is the register's head at commit, which the deferred
    // claimant still checks.
    const before = await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect');
    const self = await addMember({ name: `A7d Self PMC ${run}`, role: 'pmc', email: `a7d-selfpmc-${run}@test.local` });
    expect(self.status, self.text).toBe(201);
    createdUserIds.push(self.body.userId);
    const selfToken = t.issueProjectToken(self.body.userId, f.projectA.id);
    const reRole = await http().patch(`${members()}/${self.body.userId}`).set('Authorization', `Bearer ${selfToken}`)
      .set('Idempotency-Key', randomUUID()).send({ role: 'architect' });
    expect(reRole.status, reRole.text).toBe(200);
    const flip = (await standingEvents()).at(-1)!;
    expect(flip).toMatchObject({
      actorId: self.body.userId, actorRole: 'pmc',
      payload: { from: { role: 'pmc', status: 'active' }, to: { role: 'architect', status: 'active' }, activeCount: before + 1 },
    });
    expect((await removeMember(self.body.userId)).status).toBe(200);

    // the membership-less org owner adds THEMSELVES as the architect: they act as `pmc`, which the
    // windowed arm stops admitting the moment their architect membership exists
    const ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const { email } = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id }, select: { email: true } });
    const ownerAdd = await http().post(members()).set('Authorization', `Bearer ${ownerToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: 'owner', role: 'architect', email });
    expect(ownerAdd.status, ownerAdd.text).toBe(201);
    expect((await standingEvents()).at(-1)!).toMatchObject({
      actorId: f.ownerUser.id, actorRole: 'pmc',
      payload: { from: { role: null, status: null }, to: { role: 'architect', status: 'active' }, activeCount: before + 1 },
    });
    expect((await removeMember(f.ownerUser.id)).status).toBe(200);
    expect(await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect')).toBe(before);
  });

  it('the doors are re-created after the suite (asserted here on the definitions captured; the rollback of 4d-iii\'s rehearsal)', () => {
    expect(doorDefs).toHaveLength(PHASE6_4D_RESERVATION_DOORS.length);
    for (const d of doorDefs) expect(d.def).toMatch(/^CREATE TRIGGER /);
  });
});
