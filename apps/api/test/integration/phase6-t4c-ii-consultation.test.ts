import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { readServableGeneration } from '../../src/platform/projections/generation';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { plantLegacyApprovalRevision } from './fixtures';
import { PrismaClient } from '@prisma/client';

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
  /** the same people's memberships on the SIBLING project — needed since 4c-iii made it gate-ON */
  const offMembership: Record<string, string> = {};
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
        else offMembership[key] = m.id;
      }
      tokens[key] = t.issueProjectToken(uid, projectId, roleOf[key]);
      offTokens[key] = t.issueProjectToken(uid, offProjectId, roleOf[key]);
    }
    // NO capability planting, and NO capability row. Before 4c-iii this fixture had to plant the
    // pilot row through the reservation (disabled by name for one statement); through 4c-iii and
    // 4c-iv the `Project` trigger produced the row for each project as it was created and this
    // fixture asserted it; 4c-v retired that trigger, the seal and the rows, because nothing reads
    // them. Both projects therefore carry NO `consultation` row, and both routes are open anyway
    // — which is what 4c-iv's probe below asserts.
    for (const pid of [projectId, offProjectId]) {
      const row = await t.prisma.projectCapability.findUnique({
        where: { projectId_capability: { projectId: pid, capability: 'consultation' } },
      });
      expect(row, `after 4c-v nothing creates a consultation row for ${pid}`).toBeNull();
    }
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
    // the fence probes enable capabilities on the sibling project; all of them are cleared. Through
    // 4c-iv the `consultation` row was spared here because the preservation seal refused to delete
    // it; 4c-v retired that seal and the row alike, so there is nothing left to spare.
    await t.prisma.projectCapability.deleteMany({ where: { projectId: offProjectId } });
  });

  afterAll(async () => {
    // No capability delete here: 4c-iii made the FK ON DELETE CASCADE (kept by 4c-v), so the
    // project deletion below takes any capability rows with it.
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

  it('P23 (§D, post-4c-iii): the gate is OPEN for EVERY project — the former sibling now reaches both routes', async () => {
    // REWRITTEN BY 4c-iii, not deleted. Through 4c-ii this asserted the §D inertness arm: a
    // gate-OFF sibling answered 404 on both routes and its shell offered no capability. 4c-iii is
    // the ENABLEMENT TRANSITION, so there is no longer any gate-off project to assert that
    // against — the assertion is inverted rather than dropped, because the behaviour it pinned is
    // exactly what this unit changes, and a probe left asserting the old truth would be a test of
    // a state the product no longer has.
    //
    // What is still pinned, and is the point of the unit: the gate READS are unchanged and still
    // authoritative — they simply always find a row now. The sibling reaches the routes with NO
    // operator action, which is §D's own creation-enablement claim.
    const decisionId = await issue(offProjectId);
    const asked = await post(offTokens.pmc)(
      `/projects/${offProjectId}/decisions/${decisionId}/consultations`,
      { consulteeMembershipId: offMembership.eng, question: 'Which finish holds up here?' },
      randomUUID(),
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);

    // REWRITTEN AGAIN BY 4c-iv. Through 4c-iii the shell ADVERTISED `consultation` so the client
    // could read the same per-project gate the write surface did. 4c-iv retired every read of that
    // gate — the two commands, this shell entry, and the client — in one unit, so the shell no
    // longer names it. The routes above still answer 201: that is the whole point.
    const offShell = await get(offTokens.pmc)(`/projects/${offProjectId}/shell`);
    expect(offShell.status).toBe(200);
    expect(offShell.body.capabilities).not.toContain('consultation');
    const onShell = await get(tokens.pmc)(`/projects/${projectId}/shell`);
    expect(onShell.body.capabilities).not.toContain('consultation');
  });

  it('4c-iv — the gate READS are gone: a project with NO capability row still reaches BOTH routes, and the shell does not advertise the retired gate', async () => {
    // THE 4c-iv PROBE, reproduce-first. At the base (4c-iii) both commands begin with
    // `assertEnabled(projectId, 'consultation')`, so a project whose row is absent answers 404 on
    // both routes; after 4c-iv nothing reads the row, so the same project answers 201 on both.
    //
    // Through 4c-iv, reaching a row-less project took the alternate-writer path 4c-iii's
    // PRESERVATION seal existed to refuse — the seal was disabled BY NAME for one statement and
    // re-enabled in the same transaction. 4c-v retired the seal, the creation trigger and the
    // rows, so the row-less project is now simply every project: the fixture asserts the absence
    // and drives the routes. This is the permanent state, not a rolling-window tolerance.
    {
      const gone = await t.prisma.projectCapability.findUnique({
        where: { projectId_capability: { projectId: offProjectId, capability: 'consultation' } },
      });
      expect(gone, 'after 4c-v no project carries the row').toBeNull();

      const decisionId = await issue(offProjectId);
      const asked = await post(offTokens.pmc)(
        `/projects/${offProjectId}/decisions/${decisionId}/consultations`,
        { consulteeMembershipId: offMembership.eng, question: 'Does this substrate need a primer?' },
        randomUUID(),
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);

      const consultationId = await consultationOf(decisionId);
      const answered = await post(offTokens.eng)(
        `/projects/${offProjectId}/decisions/${decisionId}/consultations/respond`,
        { consultationId, response: 'Yes — two coats, the first thinned.' },
        randomUUID(),
      );
      expect(answered.status, JSON.stringify(answered.body)).toBe(201);

      const shell = await get(offTokens.pmc)(`/projects/${offProjectId}/shell`);
      expect(shell.status).toBe(200);
      expect(shell.body.capabilities).not.toContain('consultation');
    }
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

  it('F3: a stored PRE-4c DTO is served UNCHANGED — live and projection agree by BOTH omitting', async () => {
    // Widening the include and the serializer does not rewrite JSON already stored in an ACTIVE
    // generation, and a catalog bump triggers no rebuild — so a quiet project keeps serving pre-4c
    // DTOs. Under the corrected absent-when-empty serialization that is not a defect to repair but
    // the ALREADY-CORRECT answer: a decision with no thread carries neither key on either path, so
    // the stored row and a live serialization are identical without any hydration. Hydrating to
    // `consultations: []` here — as the head under review did — would invert the equality defect,
    // making the projection answer differ from live for exactly the quiet projects it protects.
    const decisionId = await issue();
    await applyProjection();
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { projectId, consumer: 'decisions.inbox' } });
    if (!gen) return; // no generation to corrupt — the live path serves, and it is fine
    const stored = await t.prisma.decisionProjection.findFirst({ where: { generationId: gen.id, decisionId } });
    if (!stored) return;
    const legacy = { ...(stored.dto as Record<string, unknown>) };
    delete legacy.consultations;
    delete legacy.approvalCycle;
    await t.prisma.decisionProjection.update({
      where: { generationId_decisionId: { generationId: gen.id, decisionId } },
      data: { dto: legacy },
    });

    const query = t.app.get(DecisionsQueryService);
    const served = await query.projectionSlice(projectId, 'pmc', users.pmc);
    const row = served.decisions.find((d) => d.id === decisionId);
    expect(row, 'the pre-4c row is still served').toBeTruthy();
    expect('consultations' in row!, 'no key is invented for a thread that does not exist').toBe(false);
    expect('approvalCycle' in row!, 'and none for the cycle that only accompanies one').toBe(false);
    // the equality that matters: the live path answers with the SAME shape, key for key
    const live = await query.snapshotSlice(projectId, 'pmc', users.pmc);
    const liveRow = live.decisions.find((d) => d.id === decisionId);
    expect(Object.keys(liveRow!).sort()).toEqual(Object.keys(row!).sort());
  });

  it('F3 (§D): a decision that HAS a thread carries both keys, and the cycle travels with it', async () => {
    // Absent-when-empty is only defensible if present-when-present is exact: the collection appears
    // the moment a question exists, and `approvalCycle` appears WITH it — never alone, because a
    // gate-OFF project's approved decisions would otherwise gain a key the previous release never
    // sent, which is the byte-identity §D claims.
    const decisionId = await issue();
    const query = t.app.get(DecisionsQueryService);
    const before = (await query.snapshotSlice(projectId, 'pmc', users.pmc)).decisions.find((d) => d.id === decisionId)!;
    expect('approvalCycle' in before, 'no thread, so no cycle key either').toBe(false);

    await ask(decisionId, 'eng');
    const after = (await query.snapshotSlice(projectId, 'pmc', users.pmc)).decisions.find((d) => d.id === decisionId)!;
    expect(after.consultations).toHaveLength(1);
    expect(after.approvalCycle, 'the comparand the frozen openCycle is judged against').toBe(0);
  });

  it('F3 (post-4c-iii): an APPROVED decision with NO thread still gains neither key', async () => {
    // RE-POINTED BY 4c-iii, not deleted. The rule this probe exists for is that the two
    // consultation keys travel TOGETHER and only when a thread exists — `approvalCycle` is derived
    // from the approval register, which every project has, so emitting it whenever it is non-zero
    // would add a key to decisions that have no consultation at all. Approving is exactly the
    // operation that makes it non-zero.
    //
    // Through 4c-ii the sharpest available subject was a GATE-OFF project. After the enablement
    // transition no project is gate-off, so the subject becomes a gate-ON decision with no thread
    // — which is the case the rule now has to hold for, and the one a stored pre-4c DTO must stay
    // byte-equal to.
    const decisionId = await issue();
    await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId } }), 'the register did advance').toBe(1);

    const query = t.app.get(DecisionsQueryService);
    const row = (await query.snapshotSlice(projectId, 'pmc', users.pmc)).decisions.find((d) => d.id === decisionId)!;
    expect('consultations' in row, 'no thread — so no consultations key').toBe(false);
    expect('approvalCycle' in row, 'a non-zero cycle is still not sent for a decision with no thread').toBe(false);
  });

  // ═══ THE ROLLOUT FENCE — this unit's own database additions ══════════════════════════════════

  it('the latch is fully RETIRED — reservation, preservation seal and creation trigger all gone', async () => {
    // REWRITTEN BY 4c-iii, and again by 4c-v. Through 4c-ii this asserted the reservation refusing
    // both doors (the dark window's latch); through 4c-iv it was the HANDOVER pin — reservation
    // gone AND preservation seal present, so no unit could retire one without the other passing
    // through here. 4c-v is that unit: with every read of the row gone (4c-iv) and its rollout
    // attested complete, the seal, its statement arm and the creation trigger retire together, and
    // this pin now holds that NOTHING of the latch remains — asserted in the suite that owned the
    // thing being retired. The arms' before/after behaviour is the mirror probe in
    // `phase6-t4c-v-seal-retirement.test.ts`.
    const trigger = async (name: string): Promise<number> => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_trigger WHERE tgname = $1`, name,
      );
      return Number(rows[0]?.n ?? -1);
    };
    expect(await trigger('ProjectCapability_t4c_reserved'), 'the reservation is dropped').toBe(0);
    expect(await trigger('ProjectCapability_t4c_preserved'), 'the preservation seal is retired').toBe(0);
    expect(await trigger('ProjectCapability_t4c_no_truncate'), 'including its statement-level arm').toBe(0);
    expect(await trigger('Project_t4c_consultation_enabled'), 'and the creation trigger with it').toBe(0);
    expect(await trigger('Project_t4c_deleting'), 'and the delete flag the seal consulted').toBe(0);

    // …and the column is still free text: the ordinary writer still succeeds for the value, as
    // inert data nothing reads — the Board pin (no CHECK, no whitelist) survives the retirement.
    await expect(
      t.prisma.projectCapability.upsert({
        where: { projectId_capability: { projectId: offProjectId, capability: 'consultation' } },
        create: { projectId: offProjectId, capability: 'consultation', enabledById: users.pmc },
        update: {},
      }),
    ).resolves.toBeTruthy();
  });

  it('the seal is PRECISE: every other capability still enables through the unchanged writer', async () => {
    // A seal that refused every capability would be an outage, and the Board's decision that the
    // column stays free text would have been quietly reversed. Exactly one value was ever sealed —
    // for absence through 4c-ii, for PRESENCE through 4c-iv, and for nothing since 4c-v — and at
    // every stage everything else was untouched.
    for (const capability of ['labour', 'commercial', 'anything-an-operator-types']) {
      await expect(
        t.prisma.projectCapability.create({ data: { projectId: offProjectId, capability, enabledById: users.pmc } }),
      ).resolves.toBeTruthy();
    }
  });

  it('round 30 (P1): an un-versioned generation INSERT — the old relay\u2019s bootstrap — still SUCCEEDS', async () => {
    // The first shape of this fence was NOT NULL with NO DEFAULT, which rejected this INSERT. That
    // is the previous release's own `lockActiveGeneration` lazy bootstrap, and `migrate.sh` applies
    // this migration BEFORE the old processes stop — so during the documented compatibility window
    // a project or consumer with no generation yet would have had its ordered projection STALLED
    // while the old release was still supposed to be serving. The backfill covers only generations
    // that already exist; this is the case it cannot reach.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt")
       VALUES ($1,'decisions.inbox',$2,999,'building','live',now(),now())`,
      `fence-${run}`, projectId,
    );
    const row = await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: `fence-${run}` } });
    // …and it is stamped 1, which is the TRUTH about it: written by something that does not know
    // this serializer exists, so version 1 is the only version its contents could have.
    expect(row.catalogVersion, 'stamped by the trigger, not left to a lie').toBe(1);

    const col = await t.prisma.$queryRawUnsafe<Array<{ is_nullable: string; column_default: string | null }>>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'ProjectionGeneration' AND column_name = 'catalogVersion'`,
    );
    expect(col[0]?.is_nullable, 'every generation still carries a version').toBe('NO');
    // NO DEFAULT: the stamp is a BEFORE INSERT trigger, so no row can acquire a version by
    // omission without the trigger having decided what that version truthfully is.
    expect(col[0]?.column_default).toBeNull();
    await t.prisma.projectionGeneration.delete({ where: { id: `fence-${run}` } });
  });

  it('round 31: an un-versioned INSERT ALWAYS stamps 1 — the retiring transaction inherits nothing', async () => {
    // Round 30 let an un-versioned INSERT inherit from a sibling retired in the SAME transaction,
    // reasoning that the 4a repair copies its rows from the generation it retires. That is true of
    // the repair's COPY branch and false of its missing-row branch, which SYNTHESIZES a row from
    // hard-coded SQL predating this unit's serializer fields — so inheritance made an incomplete
    // row servable through the very gate meant to refuse it. A BEFORE INSERT trigger cannot tell
    // the branches apart (their rows do not exist yet), so the rule is removed, not narrowed.
    const mk = (id: string, generation: number, status: string, version?: number) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt"${version === undefined ? '' : ',"catalogVersion"'})
         VALUES ($1,'decisions.inbox',$2,$3,$4,'live',now(),now()${version === undefined ? '' : ',$5'})`,
        ...[id, projectId, generation, status, ...(version === undefined ? [] : [version])],
      );
    const versionOf = async (id: string): Promise<number> =>
      (await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id } })).catalogVersion;

    await mk(`inh-old-${run}`, 901, 'retired', 2);

    // the REBUILD shape — a separate transaction beside an already-retired v2 sibling
    await mk(`inh-rebuild-${run}`, 902, 'building');
    expect(await versionOf(`inh-rebuild-${run}`), 'a rebuild never launders a sibling version').toBe(1);

    // the 4a-REPAIR shape — retire and insert in ONE transaction. This is the case round 30
    // inherited for, and it must now stamp 1 as well: the repair may synthesize rows this
    // serializer would not produce, and the trigger cannot know whether it did.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ProjectionGeneration" SET "status"='retired', "catalogVersion"=2 WHERE "id"=$1`, `inh-rebuild-${run}`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt")
         VALUES ($1,'decisions.inbox',$2,903,'active','live',now(),now())`,
        `inh-repair-${run}`, projectId,
      );
    });
    expect(
      await versionOf(`inh-repair-${run}`),
      'the repair may synthesize rows an older serializer wrote, so it does not inherit either',
    ).toBe(1);

    for (const id of [`inh-old-${run}`, `inh-rebuild-${run}`, `inh-repair-${run}`]) {
      await t.prisma.projectionGeneration.delete({ where: { id } });
    }
  });

  it('round 30 (P1): the fence is on the SERVE gate — an older-serializer generation is never served', async () => {
    // Where the harm actually is. The previous release's standalone rebuild CLI registers consumers
    // directly and never calls `syncConsumerCatalog`, so it can still BUILD and ACTIVATE a v1
    // `decisions.inbox` generation — a register with no consultation thread and no widened
    // audience, swapped in by a supported command. What it must not be able to do is get that
    // served, and that is a decision the NEW code makes on every read.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    await applyProjection();
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { projectId, consumer: 'decisions.inbox', status: 'active' } });
    if (!gen) return; // nothing materialized — the live path serves, which is the safe answer anyway

    // Put the generation in the one state where the version is the ONLY thing left to judge:
    // healthy and caught up to the committed stream head. Asserting through `projectionSlice`
    // alone would prove nothing here — this suite's fixture resets the event stream between
    // probes, so a generation is routinely unservable for reasons that have nothing to do with
    // the fence (which is why the P25c probe above guards on `generation !== null`).
    const stream = await t.prisma.projectEventStream.findUnique({ where: { projectId }, select: { nextPosition: true } });
    const head = stream ? stream.nextPosition - 1n : -1n;
    await t.prisma.projectionGeneration.update({
      where: { id: gen.id },
      data: { cursorStatus: 'live', appliedPosition: head < 0n ? 0n : head, catalogVersion: 2 },
    });
    expect(await readServableGeneration(t.prisma, DECISIONS_PROJECTION, projectId), 'at the CURRENT version it serves').not.toBeNull();

    // now exactly what the old CLI leaves behind: the same healthy, caught-up generation, stamped v1
    await t.prisma.projectionGeneration.update({ where: { id: gen.id }, data: { catalogVersion: 1 } });
    expect(
      await readServableGeneration(t.prisma, DECISIONS_PROJECTION, projectId),
      'an older-serializer generation is refused — the caller falls back to the canonical live read',
    ).toBeNull();

    // and the fallback is not a degradation: it carries the thread the v1 generation would omit
    const query = t.app.get(DecisionsQueryService);
    expect((await query.projectionSlice(projectId, 'pmc', users.pmc)).generation).toBeNull();
    const live = await query.snapshotSlice(projectId, 'pmc', users.pmc);
    expect(live.decisions.find((d) => d.id === decisionId)?.consultations).toHaveLength(1);
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

  it('F1: an approval receipt is SPENT — it cannot back a second revision', async () => {
    // The provenance trigger proves the cited receipt exists, belongs to this project, is a
    // SUCCEEDED `decisions.approve`, and names THIS decision — and every one of those stays true
    // however many times the same receipt is cited. So one genuine approval was enough to mint
    // arbitrarily many revisions and inflate the COUNT every open consultation is frozen against:
    // the same denial the forged-revision arm above refuses, reached with a real receipt.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const consultationId = await consultationOf(decisionId);
    await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    const genuine = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId } });
    expect(genuine.sourceCommandId).toBeTruthy();

    // RED before the one-use index: every predicate the trigger tests passes, because the receipt
    // really did approve this decision — it has simply already been spent on `genuine`.
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
         SELECT $1,$2,$3,99,$4,now(),$5,$6`,
        `replay-${run}`, projectId, decisionId, genuine.optionKey, users.pmc, genuine.sourceCommandId,
      ),
      // PostgreSQL reports the one-use index by its KEY COLUMNS (`23505`, "Key (projectId,
      // sourceCommandId)=… already exists"), so that is what is asserted — matching the index's
      // own name would pass on a driver that happened to echo it and say nothing about the
      // constraint that actually fired.
    ).rejects.toThrow(/23505[\s\S]*"projectId", "sourceCommandId"/);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId } }), 'the register records ONE approval').toBe(1);

    // the consequence the seal protects: the consultee's answer is still refused for the RIGHT
    // reason (its cycle genuinely closed when the decision was approved), not because a replayed
    // receipt moved the count out from under it
    const late = await answer(decisionId, consultationId, tokens.eng);
    expect(late.status).toBe(409);
  });

  // ═══ F5 — THE CLAIM PATHS TAKE THE CANONICAL 4c LOCK ORDER ═══════════════════════════════════

  it('F5: both claim paths lock MEMBERSHIP before DECISION — the concrete AB-BA cannot form', async () => {
    // The reviewed head read the `Decision` row `FOR SHARE` and only then locked the consultee's
    // `Membership`. Approval takes the opposite order (readiness key → `Membership` →
    // update `Decision`), so when the push target is also the named decider the two transactions
    // hold exactly what the other is waiting for and PostgreSQL must abort one side — a push
    // claim killing a live approval, or the reverse.
    //
    // This is a DETERMINISTIC reproduction, not a timing loop. A dedicated session takes the
    // membership lock an approval would hold and keeps it; the claim is then dispatched and
    // OBSERVED waiting on that lock (via `pg_stat_activity`, condition-based — never a sleep).
    // At that instant the claim must hold NO decision lock: the held session takes `Decision FOR
    // UPDATE` and it must SUCCEED WHILE the claim is still pending. On the reviewed head that
    // second lock is the deadlock — the claim already holds the row `FOR SHARE`.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const query = t.app.get(DecisionsQueryService);

    /** Wait until SOME session is blocked on a lock while running a query matching `like`. */
    const blocksWithin = async (like: string, ms = 8000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
            WHERE query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          like,
        );
        if (Number(rows[0]?.n ?? 0) > 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };

    const CASES = [
      {
        name: 'requested',
        // the consultee's own membership — the row `lockActiveMembershipById` takes
        membershipId: () => membership.eng,
        claim: () => query.consultationRequestedPushTarget(projectId, decisionId, users.eng),
      },
      {
        name: 'responded',
        // the requester's pmc membership — the row `hasProjectRoleStanding(forUpdate)` takes
        membershipId: () => membership.pmc,
        // this family reports that advice was GIVEN, so it needs the answer on the record
        setup: async () => { await answer(decisionId, await consultationOf(decisionId), tokens.eng); },
        claim: () => query.consultationRespondedPushTarget(projectId, decisionId, users.pmc),
      },
    ];

    for (const c of CASES) {
      await (c as { setup?: () => Promise<void> }).setup?.();
      const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
      try {
        let released: (() => void) | undefined;
        let acquired: (() => void) | undefined;
        const gate = new Promise<void>((r) => { released = r; });
        const holds = new Promise<void>((r) => { acquired = r; });
        let decisionLocked: 'pending' | 'ok' | 'error' = 'pending';

        // the HOLDER: takes the membership lock an in-flight approval would hold, then — once the
        // claim is observed waiting on it — reaches for the decision, which is the second half of
        // the AB-BA. It commits only after that. `holds` is resolved from INSIDE the transaction,
        // so the claim is never dispatched into a lock that is not yet taken (a Prisma interactive
        // transaction starts asynchronously — dispatching both and hoping is a race, not a probe).
        const held = holder.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT 1 FROM "Membership" WHERE "id" = $1 FOR UPDATE`, c.membershipId());
          acquired!();
          await gate;
          await tx.$executeRawUnsafe(
            `SELECT 1 FROM "Decision" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, decisionId,
          ).then(() => { decisionLocked = 'ok'; }, () => { decisionLocked = 'error'; });
        }, { timeout: 30000, maxWait: 30000 });
        await holds;

        let claimSettled = false;
        const claim = c.claim().finally(() => { claimSettled = true; });

        // the claim must be WAITING on the membership row — the `FOR UPDATE OF m` of
        // `lockActiveMembershipById`, or the role-standing lock of its sibling
        expect(await blocksWithin('%Membership%'), `${c.name}: the claim blocks on Membership`).toBe(true);
        expect(claimSettled, `${c.name}: and is still pending, so it holds whatever it has taken`).toBe(false);

        released!();
        await held;
        // THE ASSERTION: the decision lock was granted while the claim was still waiting. It could
        // only be granted if the claim held no `FOR SHARE` on that row — which is the ordering.
        expect(decisionLocked, `${c.name}: the decision lock succeeded, so no AB-BA formed`).toBe('ok');

        const verdict = await claim;
        expect(verdict.actionable, `${c.name}: and the claim then answers normally`).toBe(true);
      } finally {
        await holder.$disconnect();
      }
    }
  });

  it('round 31: a receipt that pre-dates the seal is already SPENT — the partial index cannot see it', async () => {
    // The hole the one-use index leaves open BY DESIGN. It is partial on `sourceCommandId IS NOT
    // NULL` so legacy revisions with NULL provenance coexist — which means a `decisions.approve`
    // receipt that completed BEFORE this seal has never consumed its uniqueness slot, even though
    // it demonstrably backed an approval: the revision it backed carries the NULL that legacy rows
    // are entitled to. Every predicate the trigger tests passes for such a receipt, so it was
    // spendable exactly once on a NEW revision — enough to advance the frozen cycle and deny an
    // open consultation permanently.
    const decisionId = await issue();
    await ask(decisionId, 'eng');
    const consultationId = await consultationOf(decisionId);

    // a receipt shaped exactly like a real pre-seal approval: succeeded, naming this decision, and
    // created BEFORE the watermark. Minted reserved-then-completed in ONE transaction because the
    // delivered receipt seal requires the completing UPDATE to come from the inserting transaction.
    const [{ sealedAt }] = await t.prisma.$queryRawUnsafe<Array<{ sealedAt: Date }>>(
      `SELECT "sealedAt" FROM "Phase6ApprovalSealWatermark" WHERE "id"`,
    );
    const before = new Date(sealedAt.getTime() - 60_000);
    const cid = `pre-seal-${run}`;
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status","createdAt")
         VALUES ($1,'project',$2,$3,$4,'decisions.approve',$5,$6,'reserved',$7)`,
        cid, orgId, projectId, users.client, `k-${cid}`, `h-${cid}`, before,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"=$2, "completedAt"=$3 WHERE "id"=$1`,
        cid, decisionId, before,
      );
    });

    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
         VALUES ($1,$2,$3,97,'a',now(),$4,$5)`,
        `pre-seal-rev-${run}`, projectId, decisionId, users.pmc, cid,
      ),
    ).rejects.toThrow(/already existed when this seal was installed/);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId } }), 'the cycle did not move').toBe(0);
    // …and the consultation the inflated cycle would have denied is still answerable, which is the point
    expect((await answer(decisionId, consultationId, tokens.eng)).status).toBe(201);
  });

  it('round 31: a receipt minted AFTER the seal is still accepted — the watermark is not a blanket refusal', async () => {
    // The precision arm. A watermark that refused every receipt would close the hole by breaking
    // approval itself, and every other probe in this file would still pass.
    const decisionId = await issue();
    const res = await post(tokens.client)(`/projects/${projectId}/decisions/${decisionId}/approve`, { optionIndex: 0 }, randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const revision = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId } });
    expect(revision.sourceCommandId).toBeTruthy();
  });

  it('F1 is PARTIAL: legacy revisions with no source command still coexist', async () => {
    // 4c-i staged `sourceCommandId` nullable precisely so approvals performed by a pre-4c release
    // keep their honest NULL, and PostgreSQL treats NULLs as distinct — a one-use index that
    // collapsed them would make the register unmigratable for every existing database. Planted
    // through the sanctioned trigger-disable path because the provenance trigger (correctly)
    // refuses a NULL on any row written from 4c-ii onward.
    const decisionId = await issue();
    for (const version of [1, 2]) {
      await plantLegacyApprovalRevision(t.prisma, {
        id: `legacy-${version}-${run}`, projectId, decisionId, version, optionKey: 'a', approvedById: users.pmc,
      });
    }
    const rows = await t.prisma.decisionApprovalRevision.findMany({ where: { decisionId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourceCommandId === null)).toBe(true);
  });
});
