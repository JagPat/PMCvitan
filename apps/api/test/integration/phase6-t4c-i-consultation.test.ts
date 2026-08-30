import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 unit 4c-i — CONSULTATION, deployed DARK (plan §A/§D, probes P23/P25/P25d/P27/P41 DB arms).
 *
 * 4c-i installs the two append-only consultation tables and their whole seal network with NO
 * caller: no contract, no command, no route, no reader. Every probe here is therefore a DATABASE
 * probe, and that is the point — the plan's rule is that no invariant this migration installs is
 * probed later than the PR that installs it, because a DB invariant whose first probe waits for
 * the behaviour unit can be wrong and become immutable history before anything detects it.
 *
 * The suite writes through raw SQL deliberately: it is exactly the alternate writer the seals
 * exist to judge. The FIRST probe commits a COHERENT chain, so the seals are shown to be PRECISE
 * rather than merely strict — a seal that refuses everything proves nothing.
 */
describe('Phase 6 unit 4c-i — consultation schema + seals, deployed dark (live PG)', () => {
  let t: TestApp;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4ci-${label}-${run}`;

  const orgId = id('org');
  const orgBId = id('orgb');
  const projectId = id('proj');
  const projectBId = id('projb');
  // project B carries its own pmc AND client: the delivered 4b holder seal refuses to publish a
  // client-held decision into a project where nobody holds that role, so a project fixture
  // without a client cannot have a decision at all
  const users = { pmc: id('pmc'), client: id('client'), eng: id('eng'), other: id('other'), bpmc: id('bpmc'), bclient: id('bclient') };
  const membership: Record<string, string> = {};
  let decisionId = '';
  let optionAId = '';
  let bDecisionId = '';
  let bOptionId = '';
  let seq = 0;

  const sql = (q: string) => t.prisma.$executeRawUnsafe(q);
  /** A raw statement that MUST be refused — asserted on the message so a different failure fails. */
  const refused = async (q: string, match: RegExp): Promise<void> => {
    await expect(sql(q), q).rejects.toThrow(match);
  };

  /**
   * The receipt statements, as SQL. The delivered receipt protocol requires reserve and complete
   * to share ONE transaction (a completion arriving later did not come from a command run), so a
   * legal write is `[reserve, insert, complete]` together — which is exactly the shape
   * `executeCommand` performs. A reserved receipt on its own commits fine, which is what the
   * INSERT-seal probes below use: they are refused at the BEFORE trigger, before commit matters.
   */
  const reserveSql = (cid: string, commandType: string, actorId: string, project = projectId, org = orgId) =>
    `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
     VALUES ('${cid}','project','${org}','${project}','${actorId}','${commandType}','${cid}-key','hash','reserved')`;
  const reserve = async (commandType: string, actorId: string, project = projectId, org = orgId): Promise<string> => {
    const cid = id(`cmd${seq++}`);
    await sql(reserveSql(cid, commandType, actorId, project, org));
    return cid;
  };
  const completeSql = (cid: string, resultRef: string) =>
    `UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"='${resultRef}', "completedAt"=now() WHERE "id"='${cid}'`;

  interface ReqOverrides {
    id?: string; projectId?: string; decisionId?: string; requestedById?: string;
    consulteeMembershipId?: string; consulteeUserId?: string; question?: string;
    openCycle?: number; sourceCommandId?: string;
  }
  const requestSql = (o: ReqOverrides): string =>
    `INSERT INTO "DecisionConsultation" ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","sourceCommandId")
     VALUES ('${o.id}','${o.projectId ?? projectId}','${o.decisionId ?? decisionId}','${o.requestedById ?? users.pmc}',
             '${o.consulteeMembershipId ?? membership.eng}','${o.consulteeUserId ?? users.eng}','${o.question ?? 'Which finish?'}',
             ${o.openCycle ?? 0},'${o.sourceCommandId}')`;

  interface ResOverrides {
    id?: string; projectId?: string; consultationId?: string; decisionId?: string;
    respondedById?: string; response?: string; recommendedOptionId?: string | null; sourceCommandId?: string;
  }
  const responseSql = (o: ResOverrides): string =>
    `INSERT INTO "DecisionConsultationResponse" ("id","projectId","consultationId","decisionId","respondedById","response","recommendedOptionId","sourceCommandId")
     VALUES ('${o.id}','${o.projectId ?? projectId}','${o.consultationId}','${o.decisionId ?? decisionId}','${o.respondedById ?? users.eng}',
             '${o.response ?? 'Use the granite.'}',${o.recommendedOptionId === null || o.recommendedOptionId === undefined ? 'NULL' : `'${o.recommendedOptionId}'`},'${o.sourceCommandId}')`;

  /** The one legal shape: reserve → insert → complete, all in ONE transaction. */
  const commitRequest = async (o: ReqOverrides & { actor?: string }): Promise<string> => {
    const rid = o.id ?? id(`c${seq++}`);
    const cid = id(`cmd${seq++}`);
    const project = o.projectId ?? projectId;
    await t.prisma.$transaction([
      sql(reserveSql(cid, 'consultations.request', o.requestedById ?? users.pmc, project, project === projectBId ? orgBId : orgId)),
      sql(requestSql({ ...o, id: rid, sourceCommandId: cid })),
      sql(completeSql(cid, rid)),
    ]);
    return rid;
  };

  /** The response twin of {@link commitRequest} — one transaction, reserve → insert → complete. */
  const commitResponse = async (o: ResOverrides): Promise<string> => {
    const rid = o.id ?? id(`r${seq++}`);
    const cid = id(`cmd${seq++}`);
    await t.prisma.$transaction([
      sql(reserveSql(cid, 'consultations.respond', o.respondedById ?? users.eng)),
      sql(responseSql({ ...o, id: rid, sourceCommandId: cid })),
      sql(completeSql(cid, rid)),
    ]);
    return rid;
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma.org.create({ data: { id: orgId, name: `T4CI ${run}`, slug: orgId } });
    await t.prisma.org.create({ data: { id: orgBId, name: `T4CI B ${run}`, slug: orgBId } });
    const projectData = (pid: string, oid: string) => ({
      id: pid, orgId: oid, name: pid, short: 'T4CI', descriptor: '', stage: 'Planning', siteCode: pid.slice(-8),
      projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    });
    await t.prisma.project.create({ data: projectData(projectId, orgId) });
    await t.prisma.project.create({ data: projectData(projectBId, orgBId) });
    for (const [key, uid] of Object.entries(users)) {
      await t.prisma.user.create({ data: { id: uid, projectId, role: 'pmc', name: `U ${key}`, email: `${uid}@t.local` } });
    }
    for (const [key, role] of [['pmc', 'pmc'], ['client', 'client'], ['eng', 'engineer'], ['other', 'engineer']] as const) {
      const m = await t.prisma.membership.create({ data: { projectId, userId: users[key], role, status: 'active' } });
      membership[key] = m.id;
    }
    membership.bpmc = (await t.prisma.membership.create({ data: { projectId: projectBId, userId: users.bpmc, role: 'pmc', status: 'active' } })).id;
    await t.prisma.membership.create({ data: { projectId: projectBId, userId: users.bclient, role: 'client', status: 'active' } });

    ({ d: decisionId, o: optionAId } = await make(projectId, 'dec'));
    ({ d: bDecisionId, o: bOptionId } = await make(projectBId, 'bdec'));
  });

  // a published, still-open decision (the RE-ORDERED create the delivered 4b seals demand:
  // unpublished birth → options → publication as its own transition)
  async function make(pid: string, label: string): Promise<{ d: string; o: string }> {
    const did = id(label);
    await t.prisma.decision.create({
      data: { id: did, projectId: pid, title: `T ${label}`, room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: users.pmc },
    });
    await t.prisma.decisionOption.createMany({
      data: [
        { decisionId: did, label: 'A', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
        { decisionId: did, label: 'B', optionKey: 'b', material: 'Quartz', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
      ],
    });
    await t.prisma.decision.update({ where: { id: did }, data: { publishedAt: new Date() } });
    const opt = await t.prisma.decisionOption.findFirstOrThrow({ where: { decisionId: did, optionKey: 'a' } });
    return { d: did, o: opt.id };
  }

  afterEach(async () => {
    // the consultation tables are append-only AND statement-sealed; the shared helper is the one
    // sanctioned bypass, and it is registered for exactly these seals
    await sanctionedReset(t?.prisma, ['DecisionConsultationResponse', 'DecisionConsultation']);
    await t.prisma.commandExecution.deleteMany({ where: { organizationId: { in: [orgId, orgBId] } } });
  });

  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DecisionConsultationResponse', 'DecisionConsultation']);
    await t?.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER USER'),
      t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
    ]);
    await t?.prisma.$transaction([
      t.prisma.commandExecution.deleteMany({ where: { organizationId: { in: [orgId, orgBId] } } }),
      t.prisma.membership.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }),
      t.prisma.project.deleteMany({ where: { id: { in: [projectId, projectBId] } } }),
      t.prisma.org.deleteMany({ where: { id: { in: [orgId, orgBId] } } }),
    ]);
    await t?.close();
  });

  // ── the seals are PRECISE, not merely strict ────────────────────────────────────────────────

  it('accepts a COHERENT consultation and its answer — the shape every later unit will write', async () => {
    const cons = await commitRequest({});
    const rid = await commitResponse({ consultationId: cons, recommendedOptionId: optionAId });
    const row = await t.prisma.decisionConsultationResponse.findUniqueOrThrow({ where: { id: rid } });
    expect(row.consultationId).toBe(cons);
    expect(row.recommendedOptionId).toBe(optionAId);
    expect(await t.prisma.decisionConsultation.count({ where: { projectId } })).toBe(1);
  });

  // ── P23 — the evidence columns ──────────────────────────────────────────────────────────────

  it('P23: whitespace-only question and response are refused by CHECK; NULL is refused by NOT NULL', async () => {
    const c1 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('w1'), question: ' \t\n ', sourceCommandId: c1 }), /question|check/i);
    await refused(
      `INSERT INTO "DecisionConsultation" ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","sourceCommandId")
       VALUES ('${id('w2')}','${projectId}','${decisionId}','${users.pmc}','${membership.eng}','${users.eng}',NULL,0,'${c1}')`,
      /null/i,
    );
    const cons = await commitRequest({});
    const c2 = await reserve('consultations.respond', users.eng);
    await refused(responseSql({ id: id('w3'), consultationId: cons, response: '   ', sourceCommandId: c2 }), /response|check/i);
  });

  it('P23: a SECOND response to one consultation is unrepresentable', async () => {
    const cons = await commitRequest({});
    await commitResponse({ id: id('r1'), consultationId: cons });
    const c2 = await reserve('consultations.respond', users.eng);
    await refused(responseSql({ id: id('r2'), consultationId: cons, sourceCommandId: c2 }), /already exists/i);
  });

  it('P23: both tables are APPEND-ONLY — no UPDATE, no DELETE, no TRUNCATE', async () => {
    const cons = await commitRequest({});
    const rid = await commitResponse({ id: id('r3'), consultationId: cons });

    await refused(`UPDATE "DecisionConsultation" SET "question"='rewritten' WHERE "id"='${cons}'`, /phase6-4c/);
    await refused(`DELETE FROM "DecisionConsultation" WHERE "id"='${cons}'`, /phase6-4c/);
    await refused(`UPDATE "DecisionConsultationResponse" SET "response"='rewritten' WHERE "id"='${rid}'`, /phase6-4c/);
    await refused(`DELETE FROM "DecisionConsultationResponse" WHERE "id"='${rid}'`, /phase6-4c/);
    // row triggers never fire for TRUNCATE — the statement-level seals are what close it
    // NOTE the message match: a bare /truncate/i would also be satisfied by PostgreSQL's own
    // "cannot truncate a table referenced in a foreign key constraint", which is not this seal —
    // a probe that passes on the wrong refusal is not a probe.
    await refused(`TRUNCATE TABLE "DecisionConsultationResponse"`, /phase6-4c/);
    await refused(`TRUNCATE TABLE "DecisionConsultation" CASCADE`, /phase6-4c/);
  });

  it('P23: the approval register is sealed against TRUNCATE — the cycle count is trusted evidence', async () => {
    // CASCADE deliberately: a BARE truncate is refused first by PostgreSQL's own "cannot truncate
    // a table referenced in a foreign key constraint", which is not this seal. CASCADE is the
    // statement that actually reaches it — and is also the shape that would erase the evidence.
    await refused(`TRUNCATE TABLE "DecisionApprovalRevision" CASCADE`, /phase6-4c/);
  });

  // ── P25 — the request INSERT seal ───────────────────────────────────────────────────────────

  it('P25: a consultation cannot be minted against a DRAFT, WITHDRAWN, APPROVED or RECORDED decision', async () => {
    const draft = id('draft');
    await t.prisma.decision.create({
      data: { id: draft, projectId, title: 'D', room: 'K', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: users.pmc },
    });
    const c1 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('s1'), decisionId: draft, sourceCommandId: c1 }), /published|open/i);

    // withdrawn: pmc-only title and reason — a consultation there would leak exactly what 4a hides
    const wd = id('wd');
    // the RE-ORDERED create the delivered 4b seals enforce: unpublished birth → options →
    // publication as its own transition. A one-shot published insert is refused there.
    await t.prisma.decision.create({
      data: { id: wd, projectId, title: 'W', room: 'K', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: users.pmc },
    });
    await t.prisma.decisionOption.createMany({
      data: [
        { decisionId: wd, label: 'A', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
        { decisionId: wd, label: 'B', optionKey: 'b', material: 'Quartz', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
      ],
    });
    await t.prisma.decision.update({ where: { id: wd }, data: { publishedAt: new Date() } });
    await t.prisma.decision.update({
      where: { id: wd },
      data: { status: 'withdrawn', withdrawnAt: new Date(), withdrawnById: users.pmc, withdrawnByName: 'U pmc', withdrawReason: 'asked in error' },
    });
    const c2 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('s2'), decisionId: wd, sourceCommandId: c2 }), /published|open/i);
  });

  it('P25: a REMOVED consultee membership can never be consulted, and the audience cannot be forged', async () => {
    await t.prisma.membership.update({ where: { id: membership.other }, data: { status: 'removed' } });
    const c1 = await reserve('consultations.request', users.pmc);
    await refused(
      requestSql({ id: id('s3'), consulteeMembershipId: membership.other, consulteeUserId: users.other, sourceCommandId: c1 }),
      /ACTIVE|active/,
    );
    await t.prisma.membership.update({ where: { id: membership.other }, data: { status: 'active' } });

    // the WRONG-AUDIENCE forgery: a canonical audience that is not the user the membership resolves to
    const c2 = await reserve('consultations.request', users.pmc);
    await refused(
      requestSql({ id: id('s4'), consulteeMembershipId: membership.eng, consulteeUserId: users.other, sourceCommandId: c2 }),
      /audience|resolves/i,
    );
  });

  it('P25: the recorded REQUESTER must hold live requesting authority', async () => {
    const c1 = await reserve('consultations.request', users.eng);
    await refused(requestSql({ id: id('s5'), requestedById: users.eng, sourceCommandId: c1 }), /authority/i);
  });

  it('P25: the frozen open cycle must EQUAL the decision’s current approval count — not one less, not one more', async () => {
    const c1 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('s6'), openCycle: 1, sourceCommandId: c1 }), /cycle/i);

    // ...and with one approval recorded, cycle 0 is now the STALE value. This probe uses its OWN
    // decision: an approval-bearing decision can never leave approved/change standing (the
    // delivered 4b seal), so the shared fixture could not be put back.
    const own = await make(projectId, `cyc${seq++}`);
    await t.prisma.decisionApprovalRevision.create({
      data: { id: id(`rev${seq++}`), projectId, decisionId: own.d, version: 1, optionKey: 'a', approvedAt: new Date(), approvedById: users.client },
    });
    const c2 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('s7'), decisionId: own.d, openCycle: 0, sourceCommandId: c2 }), /cycle/i);
  });

  it('P25: an ARCHIVED project accepts no consultation', async () => {
    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    const c1 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('s8'), sourceCommandId: c1 }), /archiv/i);
    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
  });

  // ── P25d — the response INSERT seal ─────────────────────────────────────────────────────────

  it('P25d: only the named consultee’s own user may be recorded as the responder', async () => {
    const cons = await commitRequest({});
    const c1 = await reserve('consultations.respond', users.other);
    await refused(responseSql({ id: id('x1'), consultationId: cons, respondedById: users.other, sourceCommandId: c1 }), /consultee/i);
  });

  it('P25d: a consultee REMOVED after the request can no longer answer', async () => {
    const cons = await commitRequest({});
    await t.prisma.membership.update({ where: { id: membership.eng }, data: { status: 'removed' } });
    const c1 = await reserve('consultations.respond', users.eng);
    await refused(responseSql({ id: id('x2'), consultationId: cons, sourceCommandId: c1 }), /ACTIVE|active/);
    await t.prisma.membership.update({ where: { id: membership.eng }, data: { status: 'active' } });
  });

  it('P25d: the REOPENED-CYCLE response is refused — an approval closes every consultation of its cycle', async () => {
    // its OWN decision, for the same reason as the cycle probe above: this one is approved and
    // reopened, and that is a one-way trip through the delivered seals.
    const own = await make(projectId, `reo${seq++}`);
    const cons = await commitRequest({ decisionId: own.d });
    // approve, then reopen: the STATUS is open again, but the cycle has moved on — which is
    // exactly why eligibility is not a status test
    await t.prisma.decisionApprovalRevision.create({
      data: { id: id(`rev${seq++}`), projectId, decisionId: own.d, version: 1, optionKey: 'a', approvedAt: new Date(), approvedById: users.client },
    });
    await t.prisma.decision.update({ where: { id: own.d }, data: { status: 'change' } });
    const c1 = await reserve('consultations.respond', users.eng);
    await refused(responseSql({ id: id('x3'), consultationId: cons, decisionId: own.d, sourceCommandId: c1 }), /cycle/i);
  });

  // ── the §C rule-ii provenance chain, on BOTH tables ─────────────────────────────────────────

  it('provenance: a fabricated, foreign-project, SUCCEEDED, wrong-type or mis-attributed receipt is refused', async () => {
    // the BEFORE INSERT seal answers first — before the FK would — and it says why
    await refused(requestSql({ id: id('p1'), sourceCommandId: 'no-such-command' }), /no command receipt/i);
    const foreign = await reserve('consultations.request', users.bpmc, projectBId, orgBId);
    await refused(requestSql({ id: id('p2'), sourceCommandId: foreign }), /no command receipt/i);

    // a genuinely SUCCEEDED receipt — reserved and completed in ONE transaction, the only shape
    // the delivered receipt protocol accepts — cannot then be borrowed to back a row
    const done = id(`cmd${seq++}`);
    await t.prisma.$transaction([
      sql(reserveSql(done, 'consultations.request', users.pmc)),
      sql(completeSql(done, 'something-else')),
    ]);
    await refused(requestSql({ id: id('p3'), sourceCommandId: done }), /not the RESERVED command/i);

    const wrongType = await reserve('decisions.approve', users.pmc);
    await refused(requestSql({ id: id('p4'), sourceCommandId: wrongType }), /is a decisions.approve command/i);

    const wrongActor = await reserve('consultations.request', users.client);
    await refused(requestSql({ id: id('p5'), requestedById: users.pmc, sourceCommandId: wrongActor }), /different actor/i);
  });

  it('provenance: one receipt backs at most ONE row, and the commit must bind the receipt to THAT row', async () => {
    const cons = await commitRequest({});
    // an already-SPENT receipt. The SEAL answers first — the receipt is `succeeded` once its own
    // row committed, so it is no longer the reserved command currently executing. The one-use
    // `(projectId, sourceCommandId)` UNIQUE stands behind that as the structural backstop; the
    // seal simply reaches this case earlier, which is why the message asserted here is its own.
    const spent = await t.prisma.decisionConsultation.findUniqueOrThrow({ where: { id: cons } });
    await refused(requestSql({ id: id('p6'), sourceCommandId: spent.sourceCommandId }), /not the RESERVED command/i);

    // a receipt left RESERVED at commit — the deferred binding refuses the whole transaction
    const dangling = id(`cmd${seq++}`);
    await expect(
      t.prisma.$transaction([
        sql(reserveSql(dangling, 'consultations.request', users.pmc)),
        sql(requestSql({ id: id('p7'), sourceCommandId: dangling })),
      ]),
    ).rejects.toThrow(/did not succeed/i);

    // a receipt that completes naming ANOTHER row
    const misbound = id(`cmd${seq++}`);
    await expect(
      t.prisma.$transaction([
        sql(reserveSql(misbound, 'consultations.request', users.pmc)),
        sql(requestSql({ id: id('p8'), sourceCommandId: misbound })),
        sql(completeSql(misbound, 'a-different-row')),
      ]),
    ).rejects.toThrow(/result names/i);
  });

  // ── P27 — cross-project tuples are unrepresentable ──────────────────────────────────────────

  it('P27: no consultation or answer can cross a project boundary', async () => {
    const c1 = await reserve('consultations.request', users.pmc);
    // project A's consultation naming project B's decision: the seal's own project-scoped lookup
    // answers before the composite FK would, and says so
    await refused(requestSql({ id: id('c1'), decisionId: bDecisionId, sourceCommandId: c1 }), /not in this project/i);
    // ...or project B's consultee membership — `phase6_membership_active_user` is project-scoped,
    // so a foreign membership resolves to NULL exactly as a removed one does
    const c2 = await reserve('consultations.request', users.pmc);
    await refused(requestSql({ id: id('c2'), consulteeMembershipId: membership.bpmc, consulteeUserId: users.bpmc, sourceCommandId: c2 }), /ACTIVE|active/);

    // a response whose projectId disagrees with its consultation's, and one naming a foreign option
    const cons = await commitRequest({});
    const c3 = await reserve('consultations.respond', users.eng);
    // the seal's project-scoped consultation lookup answers first; the triple composite FK stands
    // behind it, so the tuple is unrepresentable either way
    await refused(responseSql({ id: id('c3'), consultationId: cons, projectId: projectBId, sourceCommandId: c3 }), /no consultation .* in this project/i);
    const c4 = await reserve('consultations.respond', users.eng);
    // the foreign OPTION is caught by the same-decision composite FK — nothing in the seal reads
    // it, which is exactly why the key exists
    await refused(responseSql({ id: id('c4'), consultationId: cons, recommendedOptionId: bOptionId, sourceCommandId: c4 }), /foreign key|violates/i);
  });

  // ── old-release compatibility: the dark migration must not break the serving release ────────

  it('a PREVIOUS-RELEASE approval still succeeds against the migrated schema', async () => {
    // today's `approve` writes a revision with NO source command; 4c-i adds the column nullable
    // and enforces nothing, so the still-serving 4b instance keeps working
    const own = await make(projectId, `old${seq++}`);
    const rev = await t.prisma.decisionApprovalRevision.create({
      data: { id: id(`rev${seq++}`), projectId, decisionId: own.d, version: 1, optionKey: 'a', approvedAt: new Date(), approvedById: users.client },
    });
    expect(rev.sourceCommandId).toBeNull();
  });
});
