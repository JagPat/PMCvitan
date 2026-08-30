import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 unit 4c-ii — the consultation BEHAVIOUR unit (live PG).
 *
 * 4c-i deployed the two tables and their whole seal network dark and probed every DATABASE
 * invariant it installed. This suite probes what 4c-ii adds on top: the two commands, the audience
 * widening, the projection fold, the push families' claim predicates, the client contract, and the
 * two halves of the consumer-version fence.
 *
 * TWO PROJECTS, deliberately. Project A has the `consultation` capability; project B does not, and
 * every gate-OFF arm is asserted against it — §D's inertness claim is that a project the operator
 * has not enabled is byte-identical to today, and the only way to show that is to run the same
 * calls against both.
 */
describe('Phase 6 unit 4c-ii — consultation behaviour, audience, push and fence (live PG)', () => {
  let t: TestApp;
  let relay: OutboxRelay;
  /** The ordered delivery is what MATERIALIZES the fold; until the relay applies it the module
   *  read falls back to live, so a probe that asserted an immediate read would pass even with the
   *  fold broken. Draining is what makes the projection arm mean anything. */
  const drainRelay = async (): Promise<void> => { for (let i = 0; i < 8; i++) await relay.runOnce(); };
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4cii-${label}-${run}`;

  const orgId = id('org');
  const projectId = id('proj'); // gate ON
  const projectBId = id('projb'); // gate OFF — the §D inertness control
  const users = {
    pmc: id('pmc'),
    client: id('client'),
    engA: id('enga'), // the consultee
    engB: id('engb'), // a SAME-ROLE non-consultee: the arm that proves the widening is per-person
    bpmc: id('bpmc'),
    bclient: id('bclient'),
  };
  const membership: Record<string, string> = {};
  let pmcToken = '';
  let engAToken = '';
  let engBToken = '';
  let bpmcToken = '';

  const http = () => request(t.app.getHttpServer());
  /** A consultation-aware caller: the header the 4c bundle advertises. */
  const post = (token: string, contract: string | null = 'consultation-v1') => (path: string, body: object = {}) => {
    const r = http().post(path).set('Authorization', `Bearer ${token}`);
    return (contract === null ? r : r.set('x-vitan-decisions-contract', contract)).send(body);
  };
  const get = (token: string) => (path: string) =>
    http().get(path).set('Authorization', `Bearer ${token}`).set('x-vitan-decisions-contract', 'consultation-v1');

  const twoOptions = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  /** Issue a PUBLISHED, client-held decision through the real command. */
  const issue = async (pid: string, token: string): Promise<string> => {
    const res = await post(token)(`/projects/${pid}/decisions`, {
      title: `T ${randomUUID().slice(0, 6)}`, room: 'Kitchen', options: twoOptions, publish: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await t.prisma.decision.findFirstOrThrow({ where: { projectId: pid }, orderBy: { createdAt: 'desc' } });
    return row.id;
  };

  const ask = (did: string, membershipId: string, question = 'Which finish holds up better?', contract: string | null = 'consultation-v1') =>
    post(pmcToken, contract)(`/projects/${projectId}/decisions/${did}/consultations`, { consulteeMembershipId: membershipId, question });

  const reply = (token: string, did: string, cid: string, body: object = { response: 'Granite.' }) =>
    post(token)(`/projects/${projectId}/decisions/${did}/consultations/${cid}/respond`, body);

  const consultationOf = async (did: string) =>
    t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: did }, orderBy: { requestedAt: 'desc' } });

  beforeAll(async () => {
    t = await createTestApp();
    relay = t.app.get(OutboxRelay);
    await t.prisma.org.create({ data: { id: orgId, name: `T4CII ${run}`, slug: orgId } });
    const projectData = (pid: string) => ({
      id: pid, orgId, name: pid, short: 'T4CII', descriptor: '', stage: 'Planning', siteCode: pid.slice(-8),
      projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    });
    await t.prisma.project.create({ data: projectData(projectId) });
    await t.prisma.project.create({ data: projectData(projectBId) });
    for (const [key, uid] of Object.entries(users)) {
      await t.prisma.user.create({ data: { id: uid, projectId, role: 'pmc', name: `U ${key}`, email: `${uid}@t.local` } });
    }
    for (const [key, role] of [['pmc', 'pmc'], ['client', 'client'], ['engA', 'engineer'], ['engB', 'engineer']] as const) {
      const m = await t.prisma.membership.create({ data: { projectId, userId: users[key], role, status: 'active' } });
      membership[key] = m.id;
    }
    // project B carries its own pmc AND client: the delivered 4b holder seal refuses to publish a
    // client-held decision into a project where nobody holds that role
    membership.bpmc = (await t.prisma.membership.create({ data: { projectId: projectBId, userId: users.bpmc, role: 'pmc', status: 'active' } })).id;
    await t.prisma.membership.create({ data: { projectId: projectBId, userId: users.bclient, role: 'client', status: 'active' } });

    pmcToken = t.issueProjectToken(users.pmc, projectId, 'pmc');
    engAToken = t.issueProjectToken(users.engA, projectId, 'engineer');
    engBToken = t.issueProjectToken(users.engB, projectId, 'engineer');
    bpmcToken = t.issueProjectToken(users.bpmc, projectBId, 'pmc');

    // Project A is the GATE-ON arm. The `consultation` capability is RESERVED at the database
    // until 4c-iii (this unit installs that reservation), so the row cannot be created through the
    // ordinary writer — which is exactly the property the reservation exists to give. The fixture
    // therefore disables the named trigger for the one insert, the same sanctioned-bypass shape
    // `sanctionedReset` uses for the TRUNCATE seals, and re-arms it immediately: a probe that left
    // it disabled would silently weaken every later arm in this file.
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ProjectCapability" DISABLE TRIGGER "ProjectCapability_t4c_reserved"');
    await t.prisma.projectCapability.create({ data: { projectId, capability: 'consultation', enabledById: users.pmc } });
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ProjectCapability" ENABLE TRIGGER "ProjectCapability_t4c_reserved"');
  });

  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DecisionConsultationResponse', 'DecisionConsultation']);
    await t?.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER USER'),
      t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
    ]);
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await t?.prisma.$transaction([
      t.prisma.decisionProjection.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.projectionGeneration.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.commandExecution.deleteMany({ where: { organizationId: orgId } }),
      t.prisma.auditLog.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.notification.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
    ]);
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ProjectCapability" DISABLE TRIGGER "ProjectCapability_t4c_reserved"');
    await t.prisma.projectCapability.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } });
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ProjectCapability" ENABLE TRIGGER "ProjectCapability_t4c_reserved"');
    await t?.prisma.$transaction([
      t.prisma.membership.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }),
      t.prisma.project.deleteMany({ where: { id: { in: [projectId, projectBId] } } }),
      t.prisma.org.deleteMany({ where: { id: orgId } }),
    ]);
    await t?.close();
  });

  // ── §D — the gate is a real gate, on BOTH ends ──────────────────────────────────────────────

  it('§D gate OFF: both commands 404, nothing is emitted, and the decision DTO is byte-identical to today', async () => {
    const did = await issue(projectBId, bpmcToken);
    const before = await t.prisma.domainEvent.count({ where: { projectId: projectBId } });

    const asked = await post(bpmcToken)(`/projects/${projectBId}/decisions/${did}/consultations`, {
      consulteeMembershipId: membership.bpmc, question: 'anything?',
    });
    // 404, not 403: to a project the operator has not enabled, the feature does not exist
    expect(asked.status).toBe(404);
    const answered = await post(bpmcToken)(`/projects/${projectBId}/decisions/${did}/consultations/nope/respond`, { response: 'x' });
    expect(answered.status).toBe(404);

    // NO consultation event exists — which is the whole protection: an old projection or push
    // worker cannot claim what was never emitted
    expect(await t.prisma.domainEvent.count({ where: { projectId: projectBId } })).toBe(before);
    expect(await t.prisma.domainEvent.count({ where: { projectId: projectBId, eventType: { startsWith: 'decision.consultation' } } })).toBe(0);

    // and the served decision carries NO new key at all: `consultations` is absent, not empty
    const snap = await get(bpmcToken)(`/projects/${projectBId}/snapshot`);
    expect(snap.status).toBe(200);
    const d = (snap.body.decisions as Array<Record<string, unknown>>).find((x) => x.id === did);
    expect(d).toBeDefined();
    expect('consultations' in d!).toBe(false);
  });

  it('§D the capability is RESERVED at the database until the enablement unit — the ordinary writer cannot open the gate', async () => {
    // the hole this closes: the previous release's generic `capability:enable` accepts any string,
    // so without the reservation an operator could enable the gate mid-window and an upgraded
    // instance would emit while old workers could still claim
    await expect(
      t.prisma.projectCapability.create({ data: { projectId: projectBId, capability: 'consultation', enabledById: users.bpmc } }),
    ).rejects.toThrow(/RESERVED until the enablement unit/);
    // and the UPDATE door too — `capability` is a mutable key with no freeze trigger
    await t.prisma.projectCapability.create({ data: { projectId: projectBId, capability: 'materials', enabledById: users.bpmc } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'consultation' WHERE "projectId" = $1 AND "capability" = 'materials'`,
        projectBId,
      ),
    ).rejects.toThrow(/RESERVED until the enablement unit/);
  });

  it('§D the CLIENT contract gates the originator: a stale bundle is told to reload, an advertising one succeeds', async () => {
    const did = await issue(projectId, pmcToken);
    // the 4b bundle sends `recorded-v1`; it understands records but not consultations, and its
    // own selectVisibleDecisions would hide the very thread it just created
    const stale = await ask(did, membership.engA, 'q', 'recorded-v1');
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toMatch(/older version of the app/i);
    // no header at all (a pre-4b bundle) is refused for the same reason
    expect((await ask(did, membership.engA, 'q', null)).status).toBe(409);
    // nothing was written by either refusal
    expect(await t.prisma.decisionConsultation.count({ where: { decisionId: did } })).toBe(0);

    expect((await ask(did, membership.engA)).status).toBe(201);
    expect(await t.prisma.decisionConsultation.count({ where: { decisionId: did } })).toBe(1);
  });

  // ── §A — the audience widening, per PERSON ──────────────────────────────────────────────────

  it('§A the named consultee sees the pending decision; a SAME-ROLE non-consultee does not', async () => {
    const did = await issue(projectId, pmcToken);
    // before being asked, neither engineer sees a client-held pending decision (the 4b audience)
    const idsFor = async (token: string): Promise<string[]> =>
      ((await get(token)(`/projects/${projectId}/snapshot`)).body.decisions as Array<{ id: string }>).map((d) => d.id);
    expect(await idsFor(engAToken)).not.toContain(did);
    expect(await idsFor(engBToken)).not.toContain(did);

    expect((await ask(did, membership.engA)).status).toBe(201);

    // engA was asked, so the decision is now theirs to see — and engB, the SAME role, still is not
    expect(await idsFor(engAToken)).toContain(did);
    expect(await idsFor(engBToken)).not.toContain(did);
    // the pmc's own view is unchanged
    expect(await idsFor(pmcToken)).toContain(did);
  });

  it('§A the thread is on the DTO with its question, and its answer once given', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA, 'Granite or quartz for the sills?');
    const c = await consultationOf(did);

    const beforeReply = ((await get(pmcToken)(`/projects/${projectId}/snapshot`)).body.decisions as Array<Record<string, unknown>>)
      .find((d) => d.id === did)!;
    const thread = beforeReply.consultations as Array<Record<string, unknown>>;
    expect(thread).toHaveLength(1);
    expect(thread[0]!.question).toBe('Granite or quartz for the sills?');
    expect(thread[0]!.consulteeUserId).toBe(users.engA);
    expect(thread[0]!.response).toBeUndefined(); // outstanding — what the requester's view surfaces

    expect((await reply(engAToken, did, c.id, { response: 'Granite — quartz stains.', recommendedOptionKey: 'a' })).status).toBe(201);
    const afterReply = ((await get(pmcToken)(`/projects/${projectId}/snapshot`)).body.decisions as Array<Record<string, unknown>>)
      .find((d) => d.id === did)!;
    const answered = (afterReply.consultations as Array<Record<string, unknown>>)[0]!;
    expect((answered.response as Record<string, unknown>).response).toBe('Granite — quartz stains.');
    // the recommendation travels as the option KEY, so it survives a reorder
    expect((answered.response as Record<string, unknown>).recommendedOptionKey).toBe('a');
  });

  it('§A only the named consultee may answer, exactly once, and only while the cycle stands', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA);
    const c = await consultationOf(did);

    // a same-role member who was NOT asked
    expect((await reply(engBToken, did, c.id)).status).toBe(403);
    // the pmc who asked cannot answer their own question either
    expect((await reply(pmcToken, did, c.id)).status).toBe(403);

    expect((await reply(engAToken, did, c.id)).status).toBe(201);
    // once. The one-response UNIQUE makes this structural, not a service convention.
    expect((await reply(engAToken, did, c.id, { response: 'Actually, quartz.' })).status).toBe(409);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId: c.id } })).toBe(1);
  });

  it('§A an APPROVAL closes the cycle: a consultation asked before it can no longer be answered', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA);
    const c = await consultationOf(did);

    const clientToken = t.issueProjectToken(users.client, projectId, 'client');
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    // the status arm alone would readmit a later reopen — this is the CYCLE arm
    const late = await reply(engAToken, did, c.id);
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toMatch(/no longer open|no longer stands/i);
  });

  it('§A a REMOVED consultee can no longer answer, and asking one is refused outright', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA);
    const c = await consultationOf(did);
    await t.prisma.membership.update({ where: { id: membership.engA }, data: { status: 'removed' } });
    try {
      // 403 from project access (a removed member's token no longer reaches the project) or 409
      // from the service's own re-resolution — either is the refusal this arm is about, and which
      // one fires is a layering detail, not a behaviour claim
      expect([403, 409]).toContain((await reply(engAToken, did, c.id)).status);
      // and a NEW request naming them is a 400 with an answer, never a trigger crash
      const asked = await ask(await issue(projectId, pmcToken), membership.engA);
      expect(asked.status).toBe(400);
    } finally {
      await t.prisma.membership.update({ where: { id: membership.engA }, data: { status: 'active' } });
    }
  });

  // ── P25c — the projection fold ──────────────────────────────────────────────────────────────

  it('P25c: live == projection for the consultee slice, and the DELIVERED fold is what serves it', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA, 'Does this clash with the services run?');
    const q = t.app.get(DecisionsQueryService);

    // the ordered delivery is what materializes the fold; until the relay applies it the module
    // read falls back to LIVE, so asserting an immediate read would prove nothing about the fold
    await drainRelay();

    const live = await q.snapshotSlice(projectId, 'engineer', users.engA);
    const projected = await q.projectionSlice(projectId, 'engineer', users.engA);
    expect(projected.decisions.map((d) => d.id)).toContain(did);
    // the SAME VALUE: one serializer produces both, so a drift is impossible by construction.
    // Deep equality, not a stringify comparison — the projection round-trips its DTO through
    // PostgreSQL `jsonb`, which does not preserve object key order, so comparing serialized text
    // would fail on an ordering difference that is not a difference in what is served.
    expect(projected.decisions).toEqual(live.decisions);

    // the same-role non-consultee's projected slice does NOT admit it — a projection is never an
    // RBAC bypass, and the widening is per person on the read path too
    const other = await q.projectionSlice(projectId, 'engineer', users.engB);
    expect(other.decisions.map((d) => d.id)).not.toContain(did);
  });

  it('P25c: a decision with NO consultation serializes with the field ABSENT — so a pre-4c-ii generation still equals live', async () => {
    const did = await issue(projectId, pmcToken);
    const q = t.app.get(DecisionsQueryService);
    const live = await q.snapshotSlice(projectId, 'pmc', users.pmc);
    const row = live.decisions.find((d) => d.id === did)!;
    // absent, never `[]`. A stored row written BEFORE this unit has no such key either, so the two
    // are byte-equal — which is what removes the need for a hydration step and keeps every
    // gate-OFF project's DTO identical to today.
    expect('consultations' in row).toBe(false);
  });

  // ── P38c/P40c — the push families' claim-time predicates ────────────────────────────────────

  it('P38c: the consultee invitation is claimable while it stands, and NOT after it is answered', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA);
    const c = await consultationOf(did);
    const q = t.app.get(DecisionsQueryService);

    const standing = await q.consultationPushTarget(projectId, c.id, 'consultee');
    expect(standing).toEqual({ actionable: true, targetUserId: users.engA });

    await reply(engAToken, did, c.id);
    // an answered invitation is spent: sending it would invite a reply the respond command 409s
    expect(await q.consultationPushTarget(projectId, c.id, 'consultee')).toEqual({ actionable: false });
  });

  it('P38c: an APPROVAL between enqueue and claim cancels the invitation; a REMOVED consultee cancels it too', async () => {
    const q = t.app.get(DecisionsQueryService);
    const clientToken = t.issueProjectToken(users.client, projectId, 'client');

    const approved = await issue(projectId, pmcToken);
    await ask(approved, membership.engA);
    const cA = await consultationOf(approved);
    expect((await q.consultationPushTarget(projectId, cA.id, 'consultee')).actionable).toBe(true);
    await post(clientToken)(`/projects/${projectId}/decisions/${approved}/approve`, { optionIndex: 0 });
    expect(await q.consultationPushTarget(projectId, cA.id, 'consultee')).toEqual({ actionable: false });

    const removed = await issue(projectId, pmcToken);
    await ask(removed, membership.engA);
    const cR = await consultationOf(removed);
    await t.prisma.membership.update({ where: { id: membership.engA }, data: { status: 'removed' } });
    try {
      expect(await q.consultationPushTarget(projectId, cR.id, 'consultee')).toEqual({ actionable: false });
    } finally {
      await t.prisma.membership.update({ where: { id: membership.engA }, data: { status: 'active' } });
    }
  });

  it('P40c: the answer reaches the requester while they still hold the authority that let them ask', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA);
    const c = await consultationOf(did);
    await reply(engAToken, did, c.id);
    const q = t.app.get(DecisionsQueryService);

    expect(await q.consultationPushTarget(projectId, c.id, 'requester')).toEqual({ actionable: true, targetUserId: users.pmc });

    // demoted between enqueue and claim: a decision's content never reaches someone who no longer
    // holds the authority to have asked about it
    await t.prisma.membership.update({ where: { id: membership.pmc }, data: { role: 'engineer' } });
    try {
      expect(await q.consultationPushTarget(projectId, c.id, 'requester')).toEqual({ actionable: false });
    } finally {
      await t.prisma.membership.update({ where: { id: membership.pmc }, data: { role: 'pmc' } });
    }
  });

  it('P38c/P40c: an ARCHIVED project receives no decision content, whichever side is being delivered to', async () => {
    const did = await issue(projectId, pmcToken);
    await ask(did, membership.engA);
    const c = await consultationOf(did);
    const q = t.app.get(DecisionsQueryService);
    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    try {
      // operability is judged FIRST, before anything about the thread itself
      expect(await q.consultationPushTarget(projectId, c.id, 'consultee')).toEqual({ actionable: false });
      expect(await q.consultationPushTarget(projectId, c.id, 'requester')).toEqual({ actionable: false });
    } finally {
      await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    }
  });

  // ── §D — the consumer-version fence, both halves ────────────────────────────────────────────

  it('§D the fence: the persisted catalog names v2 for exactly the two consultation-consuming consumers', async () => {
    const rows = await t.prisma.outboxConsumerCatalog.findMany({ select: { consumer: true, catalogVersion: true } });
    const byName = new Map(rows.map((r) => [r.consumer, r.catalogVersion]));
    // the two that fold or claim consultation content
    expect(byName.get('decisions.inbox')).toBe(2);
    expect(byName.get('webpush.notify')).toBe(2);
    // and NOT the socket consumer: it tells a room to refetch and understands nothing new, so
    // bumping it would fence out processes for a contract that did not change
    expect(byName.get('socket.invalidation')).toBe(1);
  });

  it('§D the fence: a PREVIOUS-release generation insert — one that names no catalog version — is rejected by PostgreSQL', async () => {
    // this is the standalone rebuild CLI's exact shape: the old binary does not know the column
    // exists, so its INSERT omits it. NOT NULL with NO DEFAULT is what makes that fail here,
    // before any generation is built or any swap happens.
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt")
         VALUES ($1,'decisions.inbox',$2,999,'building','live',now(),now())`,
        `${run}-oldgen`, projectId,
      ),
      // SQLSTATE 23502 is not_null_violation specifically. Prisma's message reports the failing
      // ROW rather than the column, so matching the column name would be matching nothing; a
      // CHECK (23514) or a trigger RAISE (P0001) cannot satisfy this.
    ).rejects.toThrow(/23502/);
    expect(await t.prisma.projectionGeneration.count({ where: { projectId, generation: 999 } })).toBe(0);
  });

  it('§D the fence: a generation THIS release builds carries the version it was built at', async () => {
    // the same boundary from the other side — the new code supplies the value by construction, so
    // the fence costs the supported path nothing
    const gens = await t.prisma.projectionGeneration.findMany({
      where: { projectId, consumer: 'decisions.inbox' },
      select: { catalogVersion: true },
    });
    expect(gens.length).toBeGreaterThan(0);
    for (const g of gens) expect(g.catalogVersion).toBe(2);
  });
});
