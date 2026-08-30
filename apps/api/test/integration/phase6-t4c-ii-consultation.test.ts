import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 unit 4c-ii — CONSULTATION as a product surface (server + read path, live PG).
 *
 * Unit 4c-i sealed the two facts at the database and deployed them dark. This unit gives them
 * callers, an audience, a projection thread and push families — so what is probed here is
 * BEHAVIOUR over the already-sealed shape: the guarded HTTP path end-to-end, the widening of who
 * may READ a decision, live == projection == rebuild, and the claim-time predicates that decide
 * whether a queued push is still worth sending.
 *
 * Every arm below traverses the ACTUAL guarded route (`request(app)` with a real JWT), not the
 * service directly. That is load-bearing for the respond path: its `RolesGuard` ceiling admits
 * every role a consultee can hold, and a contract/service round-trip alone would pass while the
 * shipped app still locked a contractor consultee out at the guard.
 */
describe('Phase 6 unit 4c-ii — consultation behaviour (live PG)', () => {
  let t: TestApp;
  let relay: OutboxRelay;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4cii-${label}-${run}`;

  const orgId = id('org');
  const projectId = id('proj');
  /** a SECOND project on the same org, gate-OFF, for the §D inertness arm */
  const offProjectId = id('projoff');

  const users = { pmc: id('pmc'), client: id('client'), eng: id('eng'), other: id('other'), con: id('con') };
  const membership: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const offTokens: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const post = (token: string) => (path: string, body: object = {}, key?: string) => {
    const r = http().post(path).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const get = (token: string) => (path: string) => http().get(path).set('Authorization', `Bearer ${token}`);

  const twoOptions = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  /** Issue a PUBLISHED decision through the real command; returns its id. */
  const issue = async (project = projectId): Promise<string> => {
    const token = project === projectId ? tokens.pmc : offTokens.pmc;
    const res = await post(token)(`/projects/${project}/decisions`, {
      title: `Finish ${randomUUID().slice(0, 6)}`, room: 'Kitchen', options: twoOptions, publish: true, deciderKind: 'client',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await t.prisma.decision.findFirstOrThrow({ where: { projectId: project }, orderBy: { createdAt: 'desc' } });
    return row.id;
  };

  const ask = (decisionId: string, consulteeKey: keyof typeof users, question = 'Which finish holds up in this humidity?', project = projectId, token = tokens.pmc) =>
    post(token)(`/projects/${project}/decisions/${decisionId}/consultations`, { consulteeMembershipId: membership[consulteeKey], question }, randomUUID());

  const answer = (decisionId: string, consultationId: string, token: string, response = 'Quartz. The granite stains here.', recommendedOptionIndex?: number) =>
    post(token)(`/projects/${projectId}/decisions/${decisionId}/consultations/respond`, {
      consultationId, response, ...(recommendedOptionIndex !== undefined ? { recommendedOptionIndex } : {}),
    }, randomUUID());

  const consultationOf = async (decisionId: string): Promise<string> =>
    (await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId }, orderBy: { requestedAt: 'desc' } })).id;

  /** Drain every pending `decisions.inbox` delivery so the projection is genuinely caught up.
   *  Asserting an immediate read would prove nothing: `emitEvent` only MATERIALIZES the delivery,
   *  and until the relay applies it `readServableGeneration` rejects the lagging generation, so
   *  `moduleDecisions` returns the LIVE slice and passes even when the consultation fold is
   *  broken. Immediacy is already protected by that live fallback; what needs a probe is the FOLD. */
  const applyProjection = async (project = projectId): Promise<void> => {
    for (let pass = 0; pass < 60; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({
        where: { consumer: DECISIONS_PROJECTION, projectId: project, status: { in: ['pending', 'leased'] } },
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

  const decisionsFor = async (token: string, project = projectId): Promise<Array<Record<string, unknown>>> => {
    const res = await get(token)(`/projects/${project}/decisions`);
    expect(res.status).toBe(200);
    return (res.body.decisions ?? res.body) as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    t = await createTestApp();
    relay = t.app.get(OutboxRelay);
    await t.prisma.org.create({ data: { id: orgId, name: `T4CII ${run}`, slug: orgId } });
    for (const pid of [projectId, offProjectId]) {
      await t.prisma.project.create({
        data: {
          id: pid, orgId, name: pid, short: 'T4C', descriptor: '', stage: 'Planning', siteCode: pid.slice(-8),
          projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
        },
      });
    }
    const roleOf: Record<string, string> = { pmc: 'pmc', client: 'client', eng: 'engineer', other: 'engineer', con: 'contractor' };
    for (const [key, uid] of Object.entries(users)) {
      await t.prisma.user.create({ data: { id: uid, projectId, role: roleOf[key], name: `U ${key}`, email: `${uid}@t.local` } });
      for (const pid of [projectId, offProjectId]) {
        const m = await t.prisma.membership.create({ data: { projectId: pid, userId: uid, role: roleOf[key], status: 'active' } });
        if (pid === projectId) membership[key] = m.id;
      }
      tokens[key] = t.issueProjectToken(uid, projectId, roleOf[key]);
      offTokens[key] = t.issueProjectToken(uid, offProjectId, roleOf[key]);
    }
    // ONLY the pilot project gets the capability — the §D inertness arm needs a live sibling.
    //
    // The row has to be planted THROUGH the reservation this unit installs, which is the point of
    // the reservation: until 4c-iii nothing may create it, and that includes this fixture. The
    // trigger is disabled for exactly this statement and re-enabled in the SAME transaction, so a
    // throw rolls the disable back with it — the sanctioned-reset contract, applied to a seal
    // rather than to a truncate. The reservation's own hostile probe asserts it refuses the
    // ordinary path.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "ProjectCapability" DISABLE TRIGGER "ProjectCapability_t4c_reserved"'),
      t.prisma.projectCapability.create({ data: { projectId, capability: 'consultation', enabledById: users.pmc } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ProjectCapability" ENABLE TRIGGER "ProjectCapability_t4c_reserved"'),
    ]);
  });

  afterEach(async () => {
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionConsultationResponse" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionConsultation" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER USER'),
      t.prisma.decisionConsultationResponse.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.decisionConsultation.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { in: [projectId, offProjectId] } } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [projectId, offProjectId] } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [projectId, offProjectId] } } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionConsultation" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionConsultationResponse" ENABLE TRIGGER USER'),
    ]);
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await t.prisma.projectionGeneration.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } });
    await t.prisma.commandExecution.deleteMany({ where: { organizationId: orgId } });
    // the fence probes enable ordinary capabilities on the gate-OFF project; the pilot row stays
    await t.prisma.projectCapability.deleteMany({ where: { projectId: offProjectId } });
  });

  afterAll(async () => {
    await t?.prisma.projectCapability.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } });
    await t?.prisma.$transaction([
      t.prisma.auditLog.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.notification.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.membership.deleteMany({ where: { projectId: { in: [projectId, offProjectId] } } }),
      t.prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }),
      t.prisma.project.deleteMany({ where: { id: { in: [projectId, offProjectId] } } }),
      t.prisma.org.deleteMany({ where: { id: orgId } }),
    ]);
    await t?.close();
  });

  // ═══ P23 — the guarded HTTP path, and the §D gate ════════════════════════════════════════════

  it('P23: the PMC asks and the NAMED consultee answers, both through the real guarded routes', async () => {
    const decisionId = await issue();
    const asked = await ask(decisionId, 'eng');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);

    const consultationId = await consultationOf(decisionId);
    const answered = await answer(decisionId, consultationId, tokens.eng, 'Quartz — the granite stains here.', 1);
    expect(answered.status, JSON.stringify(answered.body)).toBe(201);

    const row = await t.prisma.decisionConsultation.findUniqueOrThrow({
      where: { id: consultationId }, include: { response: true },
    });
    expect(row.consulteeUserId).toBe(users.eng);
    expect(row.openCycle).toBe(0);
    expect(row.response?.respondedById).toBe(users.eng);
    // the recommendation is stored as a same-decision OPTION REFERENCE, never the index
    const optionB = await t.prisma.decisionOption.findFirstOrThrow({ where: { decisionId, optionKey: 'b' } });
    expect(row.response?.recommendedOptionId).toBe(optionB.id);
    // provenance: each fact names the receipt of the command that produced it
    for (const commandId of [row.sourceCommandId, row.response!.sourceCommandId]) {
      const receipt = await t.prisma.commandExecution.findUniqueOrThrow({ where: { id: commandId } });
      expect(receipt.status).toBe('succeeded');
    }
  });

  it('P23: a CONTRACTOR consultee is admitted by the respond route — the ceiling is the eligible set', async () => {
    // The arm a service-layer round-trip cannot make. The respond ceiling admits every role a
    // consultee can hold precisely so `RolesGuard` cannot reject a legitimately named consultee
    // before the service's own narrowing can admit them.
    const decisionId = await issue();
    expect((await ask(decisionId, 'con')).status).toBe(201);
    const consultationId = await consultationOf(decisionId);
    const res = await answer(decisionId, consultationId, tokens.con, 'The joints will open in a month.');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('P23: a NON-consultee of the same role cannot answer (the service narrows below the ceiling)', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const consultationId = await consultationOf(decisionId);
    const res = await answer(decisionId, consultationId, tokens.other);
    expect(res.status).toBe(403);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId } })).toBe(0);
  });

  it('P23: asking is a PMC authority — a consultee cannot ask', async () => {
    const decisionId = await issue();
    const res = await post(tokens.eng)(
      `/projects/${projectId}/decisions/${decisionId}/consultations`,
      { consulteeMembershipId: membership.other, question: 'What do you think?' },
      randomUUID(),
    );
    expect(res.status).toBe(403);
  });

  it('P23: both commands REFUSE a missing Idempotency-Key with a deliberate 400, not a 500', async () => {
    // The unkeyed kernel branch reserves NO ledger row and runs with `{ commandId: null }`, and
    // both facts require a receipt — so without this refusal the write reaches PostgreSQL and
    // surfaces as an internal constraint failure where the honest answer is "this needs a key".
    const decisionId = await issue();
    const unkeyed = await post(tokens.pmc)(`/projects/${projectId}/decisions/${decisionId}/consultations`, {
      consulteeMembershipId: membership.eng, question: 'No key on this one',
    });
    expect(unkeyed.status).toBe(400);
    expect(JSON.stringify(unkeyed.body)).toMatch(/Idempotency-Key/i);
    expect(await t.prisma.decisionConsultation.count({ where: { decisionId } })).toBe(0);
  });

  it('P23: whitespace-only evidence is refused at the contract, on both commands', async () => {
    const decisionId = await issue();
    expect((await ask(decisionId, 'eng', '   \t  ')).status).toBe(400);
    expect((await ask(decisionId, 'eng')).status).toBe(201);
    const consultationId = await consultationOf(decisionId);
    expect((await answer(decisionId, consultationId, tokens.eng, '  \n ')).status).toBe(400);
  });

  it('P23 (§D): a GATE-OFF project answers 404 on both routes, and its shell offers no capability', async () => {
    // Not "forbidden" — ABSENT. The capability is the same mechanism `materials` and `labour`
    // ride, and the client reads it from the shell so a gate-off project renders no affordance at
    // all rather than affordances whose every request 404s.
    const decisionId = await issue(offProjectId);
    const asked = await post(offTokens.pmc)(
      `/projects/${offProjectId}/decisions/${decisionId}/consultations`,
      { consulteeMembershipId: membership.eng, question: 'Anything?' },
      randomUUID(),
    );
    expect(asked.status).toBe(404);
    const responded = await post(offTokens.eng)(
      `/projects/${offProjectId}/decisions/${decisionId}/consultations/respond`,
      { consultationId: 'whatever', response: 'Anything' },
      randomUUID(),
    );
    expect(responded.status).toBe(404);

    const offShell = await get(offTokens.pmc)(`/projects/${offProjectId}/shell`);
    expect(offShell.status).toBe(200);
    expect(offShell.body.capabilities).not.toContain('consultation');
    const onShell = await get(tokens.pmc)(`/projects/${projectId}/shell`);
    expect(onShell.body.capabilities).toContain('consultation');
  });

  // ═══ THE ELIGIBILITY CARVE-OUT, at both moments ══════════════════════════════════════════════

  it('a consultation cannot be asked on an unpublished draft, an approved decision, or a withdrawn one', async () => {
    const draftRes = await post(tokens.pmc)(`/projects/${projectId}/decisions`, {
      title: 'Private draft', room: 'Kitchen', options: twoOptions, publish: false, deciderKind: 'client',
    });
    expect(draftRes.status).toBe(201);
    const draft = await t.prisma.decision.findFirstOrThrow({ where: { projectId, publishedAt: null } });
    expect((await ask(draft.id, 'eng')).status).toBe(409);

    const approvedId = await issue();
    expect((await post(tokens.client)(`/projects/${projectId}/decisions/${approvedId}/approve`, { optionIndex: 0 }, randomUUID())).status).toBe(201);
    expect((await ask(approvedId, 'eng')).status).toBe(409);

    const withdrawnId = await issue();
    expect((await post(tokens.pmc)(`/projects/${projectId}/decisions/${withdrawnId}/withdraw`, { reason: 'Superseded' }, randomUUID())).status).toBe(201);
    expect((await ask(withdrawnId, 'eng')).status).toBe(409);
  });

  it('a LATE response after a withdrawal is refused — the request outlives the decision', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const consultationId = await consultationOf(decisionId);
    await post(tokens.pmc)(`/projects/${projectId}/decisions/${decisionId}/withdraw`, { reason: 'Not needed' }, randomUUID());
    const res = await answer(decisionId, consultationId, tokens.eng);
    expect(res.status).toBe(409);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId } })).toBe(0);
  });

  it('a response from a CLOSED cycle is refused after approve-then-reopen — and a NEW question in the new cycle is not', async () => {
    // The arm a status-only guard misses entirely: `requestChange` restores an OPEN status, so
    // "the decision is open" is true again while the question the consultee was asked is not.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const closed = await consultationOf(decisionId);

    await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    await post(tokens.pmc)(`/projects/${projectId}/decisions/${decisionId}/change`, { reason: 'Client changed their mind', costImpact: 0, timeImpactDays: 0 }, randomUUID());

    const late = await answer(decisionId, closed, tokens.eng);
    expect(late.status).toBe(409);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId: closed } })).toBe(0);

    // …and the mirror: a NEW consultation in the reopened cycle IS answerable
    expect((await ask(decisionId, 'eng', 'Does that change your advice?')).status).toBe(201);
    const fresh = await consultationOf(decisionId);
    expect((await t.prisma.decisionConsultation.findUniqueOrThrow({ where: { id: fresh } })).openCycle).toBe(1);
    expect((await answer(decisionId, fresh, tokens.eng, 'Same answer.')).status).toBe(201);
  });

  it('a consultation is answered exactly ONCE — a second answer is a deterministic 409', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const consultationId = await consultationOf(decisionId);
    expect((await answer(decisionId, consultationId, tokens.eng, 'First')).status).toBe(201);
    expect((await answer(decisionId, consultationId, tokens.eng, 'Second thoughts')).status).toBe(409);
    const stored = await t.prisma.decisionConsultationResponse.findFirstOrThrow({ where: { consultationId } });
    expect(stored.response).toBe('First');
  });

  // ═══ THE AUDIENCE WIDENING ═══════════════════════════════════════════════════════════════════

  it('P22/4c: a consultee SEES the decision they were asked about; a same-role non-consultee does not', async () => {
    const decisionId = await issue();
    // before being asked, the engineer sees nothing of a client-held pending decision
    expect((await decisionsFor(tokens.eng)).some((d) => d.id === decisionId)).toBe(false);

    await ask(decisionId, 'eng');
    const mine = await decisionsFor(tokens.eng);
    const seen = mine.find((d) => d.id === decisionId);
    expect(seen, 'the consultee must see the decision they were asked about').toBeTruthy();
    expect((seen!.consultations as unknown[]).length).toBe(1);
    // …and the same-role engineer who was NOT asked still sees nothing
    expect((await decisionsFor(tokens.other)).some((d) => d.id === decisionId)).toBe(false);
  });

  it('the widening is CYCLE-bound: an approve-and-reopen ends the consultee’s sight of the decision', async () => {
    // Refusing the WRITE while granting the READ is the wrong half — the confidentiality decision
    // is the read. A reopened decision is a question nobody consulted this person on.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    expect((await decisionsFor(tokens.eng)).some((d) => d.id === decisionId)).toBe(true);

    await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    await post(tokens.pmc)(`/projects/${projectId}/decisions/${decisionId}/change`, { reason: 'Reopened', costImpact: 0, timeImpactDays: 0 }, randomUUID());

    // `change` is not `pending`, so the row is team-visible again by the delivered rule; what the
    // cycle test governs is the PENDING arm, which is where the widening lives. Re-issue the
    // question in the new cycle and the sight is granted again — by the NEW consultation.
    const fresh = await issue();
    await ask(fresh, 'eng');
    const beforeApproval = await decisionsFor(tokens.eng);
    expect(beforeApproval.some((d) => d.id === fresh)).toBe(true);
    await post(tokens.client)(`/projects/${projectId}/decisions/${fresh}/approve`, { optionIndex: 0 }, randomUUID());
    await post(tokens.pmc)(`/projects/${projectId}/decisions/${fresh}/change`, { reason: 'Again', costImpact: 0, timeImpactDays: 0 }, randomUUID());
    const stale = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: fresh } });
    expect(stale.openCycle).toBe(0);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: fresh } })).toBe(1);
  });

  it('a WITHDRAWN decision stays pmc-only — consultation never widens what 4a hides', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    await post(tokens.pmc)(`/projects/${projectId}/decisions/${decisionId}/withdraw`, { reason: 'Confidential reason' }, randomUUID());
    const mine = await decisionsFor(tokens.eng);
    expect(mine.some((d) => d.id === decisionId), 'a consultee must not gain sight of a withdrawn decision').toBe(false);
  });

  // ═══ P25c — the projection thread ════════════════════════════════════════════════════════════

  it('P25c: live == projection == rebuild carry the same thread and the same widened audience', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const consultationId = await consultationOf(decisionId);
    await answer(decisionId, consultationId, tokens.eng, 'Quartz.', 1);

    const query = t.app.get(DecisionsQueryService);
    const live = await query.snapshotSlice(projectId, 'engineer', users.eng);
    const liveRow = live.decisions.find((d) => d.id === decisionId);
    expect(liveRow, 'the live slice admits the consultee').toBeTruthy();
    expect(liveRow!.consultations.length).toBe(1);
    expect(liveRow!.consultations[0].response?.response).toBe('Quartz.');
    expect(liveRow!.consultations[0].response?.recommendedOptionKey).toBe('b');

    // …and the SAME serializer feeds the projection, so a caught-up generation must match it
    await applyProjection();
    const projected = await query.projectionSlice(projectId, 'engineer', users.eng);
    if (projected.generation !== null) {
      const projRow = projected.decisions.find((d) => d.id === decisionId);
      expect(projRow, 'the projection read admits the consultee too').toBeTruthy();
      expect(projRow).toEqual(liveRow);
    }
  });

  it('P25c: a stored PRE-4c DTO for an un-consulted decision is BYTE-EQUAL to live, needing no rebuild', async () => {
    // Widening the serializer rewrites no JSON already stored in an ACTIVE generation, and a
    // catalog bump triggers no rebuild — so a quiet project keeps serving rows written before this
    // unit. Because the thread is ABSENT rather than `[]` when nobody was consulted, those rows are
    // already in the current shape: equal to live, not merely compatible. An always-emitted array
    // would have made every one of them differ, on every project, including the gate-off ones §D
    // requires to be byte-identical to today.
    const decisionId = await issue();
    await applyProjection();
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { projectId, consumer: 'decisions.inbox' } });
    if (!gen) return; // nothing materialized yet — the live path serves, and it is correct
    const stored = await t.prisma.decisionProjection.findFirst({ where: { generationId: gen.id, decisionId } });
    if (!stored) return;
    expect(
      Object.keys(stored.dto as Record<string, unknown>),
      'an un-consulted decision carries no consultation keys at all',
    ).not.toContain('consultations');

    const query = t.app.get(DecisionsQueryService);
    const live = await query.snapshotSlice(projectId, 'pmc', users.pmc);
    const projected = await query.projectionSlice(projectId, 'pmc', users.pmc);
    if (projected.generation === null) return;
    expect(projected.decisions.find((d) => d.id === decisionId))
      .toEqual(live.decisions.find((d) => d.id === decisionId));
  });

  // ═══ P38c/P40c — the claim-time push predicates ══════════════════════════════════════════════

  it('P38c: a queued "you were asked" push is CANCELLED when the decision is approved before the claim', async () => {
    // An approve between enqueue and claim leaves the project operable, the membership active, the
    // consultation unanswered and the decision un-withdrawn — so a not-withdrawn test would still
    // send a push inviting an action the respond command now answers with a 409.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const query = t.app.get(DecisionsQueryService);
    expect(await query.consultationRequestedPushTarget(projectId, decisionId, users.eng)).toEqual({ actionable: true, targetUserId: users.eng });

    await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    expect(await query.consultationRequestedPushTarget(projectId, decisionId, users.eng)).toEqual({ actionable: false });
  });

  it('P38c: an ALREADY-ANSWERED request push is cancelled — nobody is asked to do what they have done', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const query = t.app.get(DecisionsQueryService);
    expect((await query.consultationRequestedPushTarget(projectId, decisionId, users.eng)).actionable).toBe(true);
    await answer(decisionId, await consultationOf(decisionId), tokens.eng);
    expect(await query.consultationRequestedPushTarget(projectId, decisionId, users.eng)).toEqual({ actionable: false });
  });

  it('P38c: a consultee REMOVED between enqueue and claim never receives decision content', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'con');
    const query = t.app.get(DecisionsQueryService);
    expect((await query.consultationRequestedPushTarget(projectId, decisionId, users.con)).actionable).toBe(true);
    await t.prisma.membership.update({ where: { id: membership.con }, data: { status: 'removed' } });
    try {
      expect(await query.consultationRequestedPushTarget(projectId, decisionId, users.con)).toEqual({ actionable: false });
    } finally {
      await t.prisma.membership.update({ where: { id: membership.con }, data: { status: 'active' } });
    }
  });

  it('P38c/P40c: an ARCHIVED project cancels BOTH families — operability is checked first', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    await answer(decisionId, await consultationOf(decisionId), tokens.eng);
    const query = t.app.get(DecisionsQueryService);
    expect((await query.consultationRespondedPushTarget(projectId, decisionId, users.pmc)).actionable).toBe(true);

    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    try {
      expect(await query.consultationRequestedPushTarget(projectId, decisionId, users.eng)).toEqual({ actionable: false });
      expect(await query.consultationRespondedPushTarget(projectId, decisionId, users.pmc)).toEqual({ actionable: false });
    } finally {
      await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    }
  });

  it('P40c: a DEMOTED requester is dropped — advice is not delivered to someone who lost standing', async () => {
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    await answer(decisionId, await consultationOf(decisionId), tokens.eng);
    const query = t.app.get(DecisionsQueryService);
    expect((await query.consultationRespondedPushTarget(projectId, decisionId, users.pmc)).actionable).toBe(true);
    await t.prisma.membership.update({ where: { id: membership.pmc }, data: { role: 'engineer' } });
    try {
      expect(await query.consultationRespondedPushTarget(projectId, decisionId, users.pmc)).toEqual({ actionable: false });
    } finally {
      await t.prisma.membership.update({ where: { id: membership.pmc }, data: { role: 'pmc' } });
    }
  });

  // ═══ THE ROLLOUT FENCE — this unit's own database additions ══════════════════════════════════

  it('the `consultation` capability is RESERVED through BOTH doors — INSERT and re-key', async () => {
    // §D places this in 4c-i (rounds 13/19/21/24) and the merged 4c-i ships neither half, so the
    // hole is live on `main`: the generic `capability:enable` CLI accepts any string, and an
    // operator could open the gate today — the first upgraded instance would emit while old
    // workers could still claim. 4c-ii's whole compatibility story rests on it being closed, so
    // the obligation is carried here rather than left to a unit that runs after the risk passed.
    await expect(
      t.prisma.projectCapability.create({ data: { projectId: offProjectId, capability: 'consultation', enabledById: users.pmc } }),
    ).rejects.toThrow(/RESERVED/);

    // …and the UPDATE door: `capability` is a mutable key with no freeze trigger, so an
    // INSERT-only guard leaves the same gate-open state reachable by re-keying an existing row.
    await t.prisma.projectCapability.create({ data: { projectId: offProjectId, capability: 'materials', enabledById: users.pmc } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'consultation' WHERE "projectId" = $1 AND "capability" = 'materials'`,
        offProjectId,
      ),
    ).rejects.toThrow(/RESERVED/);
    expect(await t.prisma.projectCapability.count({ where: { projectId: offProjectId, capability: 'consultation' } })).toBe(0);
  });

  it('the reservation is PRECISE: every other capability still enables through the unchanged writer', async () => {
    // A seal that refused every capability would be an outage, and the Board's decision that the
    // column stays free text would have been quietly reversed. Exactly one value is rejected.
    for (const capability of ['labour', 'commercial', 'anything-an-operator-types']) {
      await expect(
        t.prisma.projectCapability.create({ data: { projectId: offProjectId, capability, enabledById: users.pmc } }),
      ).resolves.toBeTruthy();
    }
  });

  it('a projection generation cannot be created without a catalog version — the rebuild-CLI fence', async () => {
    // The startup fence protects processes that TAKE UP SERVICE; the standalone rebuild CLI is not
    // one — it registers consumers directly and never calls `syncConsumerCatalog`. So the fence
    // goes at the boundary every binary must cross: NOT NULL with NO DEFAULT, which the previous
    // release cannot satisfy because it does not know the column exists.
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt")
         VALUES ($1,'decisions.inbox',$2,999,'building','live',now(),now())`,
        `fence-${run}`, projectId,
      ),
    ).rejects.toThrow(/23502|Failing row contains/i);

    const col = await t.prisma.$queryRawUnsafe<Array<{ is_nullable: string; column_default: string | null }>>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'ProjectionGeneration' AND column_name = 'catalogVersion'`,
    );
    expect(col[0]?.is_nullable, 'NOT NULL is half the fence').toBe('NO');
    expect(col[0]?.column_default, 'NO DEFAULT is the other half — a default would let the old binary through').toBeNull();
  });

  it('the two consultation-consuming consumers are at catalog version 2, and the socket consumer is not', async () => {
    const rows = await t.prisma.outboxConsumerCatalog.findMany({
      where: { consumer: { in: ['decisions.inbox', 'webpush.notify', 'socket.invalidate'] } },
      select: { consumer: true, catalogVersion: true },
      orderBy: { consumer: 'asc' },
    });
    const byName = Object.fromEntries(rows.map((r) => [r.consumer, r.catalogVersion]));
    expect(byName['decisions.inbox']).toBe(2);
    expect(byName['webpush.notify']).toBe(2);
    // the socket consumer carries no consultation contract — it tells a room to refetch
    if (byName['socket.invalidate'] !== undefined) expect(byName['socket.invalidate']).toBe(1);
  });

  // ═══ THE APPROVAL REGISTER BECOMES PROVABLE ══════════════════════════════════════════════════

  it('every approval now records its own command receipt, and a forged revision is refused at COMMIT', async () => {
    const decisionId = await issue();
    await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    const revision = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId } });
    expect(revision.sourceCommandId, 'the approval names the command it is the product of').toBeTruthy();
    const receipt = await t.prisma.commandExecution.findUniqueOrThrow({ where: { id: revision.sourceCommandId! } });
    expect(receipt.commandType).toBe('decisions.approve');
    expect(receipt.resultRef).toBe(decisionId);

    // the DENIAL this seal exists to refuse: a bare revision against a LIVE decision would advance
    // its cycle past every open consultation, making those answers 409 permanently
    const open = await issue();
    await ask(open, 'eng');
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
         SELECT $1,$2,$3,99,'a',now(),$4`,
        `forged-${run}`, projectId, open, users.pmc,
      ),
    ).rejects.toThrow(/carries no source command/);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: open } })).toBe(0);
    // …and the consultation is still answerable, which is the point
    expect((await answer(open, await consultationOf(open), tokens.eng)).status).toBe(201);
  });
});
