import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ConflictException } from '@nestjs/common';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { createTestApp, type TestApp } from './test-app';

/**
 * #482 QA company lock — the operator's mark (`POST /ops/orgs/:orgId/qa-only`) of a company that both holds a real
 * person and holds a QA account still in another unmarked company. The database trigger refuses either reason, in the
 * order its loop meets the company's people, so the 409's wording followed the rows. The mark now asks first, in a
 * fixed order: a real person (the company can never be marked while it holds one, so the operator fixes that first),
 * then a QA account still elsewhere. Each single reason keeps its wording.
 */
const REAL_PERSON = { statusCode: 409, error: 'Conflict', message: 'This company still has people who are not QA accounts, so it cannot be marked QA-only' };
const QA_ELSEWHERE = { statusCode: 409, error: 'Conflict', message: 'A QA account in this company still belongs to a company that is not QA-only, so it cannot be marked QA-only yet' };

describe('#482 QA mark: which refusal a company with both reasons gets (live PG)', () => {
  let t: TestApp;
  const TOKEN = 'qa-mark-order-token-0123456789abcdef';
  const before = process.env.OPS_TOKEN;
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const run = `qmo-${letters}`;
  const orgs: string[] = [];
  const projects: string[] = [];
  const users: string[] = [];
  const why = { operator: 'claude', reason: 'the QA company' };
  const mark = (orgId: string) => request(t.app.getHttpServer()).post(`/ops/orgs/${orgId}/qa-only`).set('Authorization', `Bearer ${TOKEN}`).send(why);

  beforeAll(async () => {
    t = await createTestApp();
    process.env.OPS_TOKEN = TOKEN;
  });
  afterAll(async () => {
    if (t) {
      await t.prisma.$transaction([
        t.prisma.auditLog.deleteMany({ where: { projectId: { in: projects } } }),
        t.prisma.membership.deleteMany({ where: { projectId: { in: projects } } }),
        t.prisma.orgMembership.deleteMany({ where: { orgId: { in: orgs } } }),
        t.prisma.user.deleteMany({ where: { id: { in: users } } }),
        t.prisma.project.deleteMany({ where: { id: { in: projects } } }),
        t.prisma.org.deleteMany({ where: { id: { in: orgs } } }),
      ]);
    }
    if (before === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = before;
    await t?.close();
  });

  const company = async (id: string) => {
    orgs.push(id);
    projects.push(`${id}-p`);
    await t.prisma.org.create({ data: { id, name: `Org ${id}`, slug: id } });
    await t.prisma.project.create({ data: {
      id: `${id}-p`, orgId: id, name: `Project ${id}`, short: 'QA', descriptor: '', stage: 'Planning',
      siteCode: 'QA', projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    return id;
  };
  const person = async (id: string, email: string, landing: string) => {
    users.push(id);
    await t.prisma.user.create({ data: { id, projectId: `${landing}-p`, role: 'engineer', name: `Person ${id}`, email } });
    return id;
  };
  /** Rows from before the lock: written with the membership triggers off, as the existing twin case is. */
  const unlocked = async (write: () => Promise<unknown>) => {
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "OrgMembership" DISABLE TRIGGER "OrgMembership_qa_lock"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Membership" DISABLE TRIGGER "Membership_qa_lock"`);
    try {
      await write();
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "Membership" ENABLE TRIGGER "Membership_qa_lock"`);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "OrgMembership" ENABLE TRIGGER "OrgMembership_qa_lock"`);
    }
  };
  const member = (via: 'org' | 'project', orgId: string, userId: string) => (via === 'org'
    ? t.prisma.orgMembership.create({ data: { orgId, userId, role: 'member' } })
    : t.prisma.membership.create({ data: { projectId: `${orgId}-p`, userId, role: 'engineer', status: 'active' } }));

  // every arrangement the trigger's loop could meet first: the real person's id before or after the QA account's,
  // either one written first, and the real person in the company itself or on its project
  const ARRANGEMENTS = (['real-first', 'qa-first'] as const).flatMap((ids) =>
    (['real-written-first', 'qa-written-first'] as const).flatMap((written) =>
      (['org', 'project'] as const).map((via) => ({ ids, written, via }))));

  it.each(ARRANGEMENTS)('a company with a real person and a QA account still elsewhere names the real person first ($ids, $written, via $via)', async ({ ids, written, via }) => {
    const tag = `${ids === 'real-first' ? 'a' : 'b'}${written === 'real-written-first' ? 'a' : 'b'}${via === 'org' ? 'a' : 'b'}`;
    const mixed = await company(`it-${run}-${tag}-mixed`);
    const other = await company(`it-${run}-${tag}-other`);
    // ids sort as written: `a…` before `b…`
    const realId = `it-${run}-${tag}-${ids === 'real-first' ? 'a' : 'b'}-real`;
    const qaId = `it-${run}-${tag}-${ids === 'real-first' ? 'b' : 'a'}-qa`;
    const qaEmail = `qa.mix${letters}${tag.replace(/[^a-z]/g, '')}@vitan.in`;
    const addReal = async () => { await person(realId, `${realId}@t.local`, mixed); await member(via, mixed, realId); };
    const addQa = async () => {
      await person(qaId, qaEmail, mixed);
      await member('org', mixed, qaId);
      await member('org', other, qaId);
    };
    await unlocked(async () => {
      if (written === 'real-written-first') { await addReal(); await addQa(); } else { await addQa(); await addReal(); }
    });
    for (let i = 0; i < 3; i++) {
      const r = await mark(mixed);
      expect({ attempt: i, status: r.status, body: r.body }).toEqual({ attempt: i, status: 409, body: REAL_PERSON });
    }
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: mixed } })).qaOnly).toBe(false);
    expect(await t.prisma.auditLog.count({ where: { projectId: `${mixed}-p`, action: 'org.qaOnly' } })).toBe(0);
  });

  it('a company whose only reason is a real person, or only a QA account still elsewhere, keeps that wording', async () => {
    const realOnly = await company(`it-${run}-real-only`);
    const real = await person(`it-${run}-real-only-person`, `it-${run}-real-only-person@t.local`, realOnly);
    await t.prisma.orgMembership.create({ data: { orgId: realOnly, userId: real, role: 'member' } });
    expect(await mark(realOnly).then((r) => ({ status: r.status, body: r.body }))).toEqual({ status: 409, body: REAL_PERSON });

    const qaOnly = await company(`it-${run}-qa-only`);
    const elsewhere = await company(`it-${run}-qa-only-elsewhere`);
    const qa = await person(`it-${run}-qa-only-person`, `qa.solo${letters}@vitan.in`, qaOnly);
    await unlocked(async () => {
      await member('org', qaOnly, qa);
      await member('org', elsewhere, qa);
    });
    expect(await mark(qaOnly).then((r) => ({ status: r.status, body: r.body }))).toEqual({ status: 409, body: QA_ELSEWHERE });

    for (const id of [realOnly, qaOnly]) expect((await t.prisma.org.findUniqueOrThrow({ where: { id } })).qaOnly, id).toBe(false);
    // once the QA account leaves the other company, the mark lands
    await t.prisma.orgMembership.deleteMany({ where: { orgId: elsewhere, userId: qa } });
    expect((await mark(qaOnly)).body).toEqual({ ok: true, orgId: qaOnly, changed: true });
  });
  // The mark's own transaction body, as the door runs it, for the cases below: the door allows 30 marks a minute and
  // the cases above already spend 27.
  const markTx = (orgId: string) => t.prisma.$transaction((tx) => t.app.get(OrgsParticipant, { strict: false }).markQaOnly(tx, orgId)).then(
    (r) => ({ ok: true, changed: r.changed }),
    (e: unknown) => ({ ok: false, message: e instanceof ConflictException ? e.message : String(e) }),
  );

  it('the check refuses only what the lock refuses: removed memberships, QA-only companies, project memberships', async () => {
    // a real person whose only place here is a removed project membership is not one of the company's people
    const removedReal = await company(`it-${run}-pr-removed-real`);
    const gone = await person(`it-${run}-pr-gone`, `it-${run}-pr-gone@t.local`, removedReal);
    await t.prisma.membership.create({ data: { projectId: `${removedReal}-p`, userId: gone, role: 'engineer', status: 'removed' } });
    expect(await markTx(removedReal)).toEqual({ ok: true, changed: true });

    // a QA account here that also belongs to another company that is QA-only
    const twinA = await company(`it-${run}-pr-twin-a`);
    const twinB = await company(`it-${run}-pr-twin-b`);
    expect(await markTx(twinB)).toEqual({ ok: true, changed: true });
    const twin = await person(`it-${run}-pr-twin`, `qa.twin${letters}@vitan.in`, twinA);
    await unlocked(() => member('org', twinA, twin));
    await member('org', twinB, twin);
    expect(await markTx(twinA)).toEqual({ ok: true, changed: true });

    // a QA account here whose place in an unmarked company is a removed project membership
    const leftA = await company(`it-${run}-pr-left-a`);
    const leftB = await company(`it-${run}-pr-left-b`);
    const left = await person(`it-${run}-pr-left`, `qa.left${letters}@vitan.in`, leftA);
    await unlocked(async () => {
      await member('org', leftA, left);
      await t.prisma.membership.create({ data: { projectId: `${leftB}-p`, userId: left, role: 'engineer', status: 'removed' } });
    });
    expect(await markTx(leftA)).toEqual({ ok: true, changed: true });

    // a QA account here still invited onto an unmarked company's project: the QA-elsewhere 409
    const onA = await company(`it-${run}-pr-on-a`);
    const onB = await company(`it-${run}-pr-on-b`);
    const on = await person(`it-${run}-pr-on`, `qa.on${letters}@vitan.in`, onA);
    await unlocked(async () => {
      await member('org', onA, on);
      await t.prisma.membership.create({ data: { projectId: `${onB}-p`, userId: on, role: 'engineer', status: 'invited' } });
    });
    expect(await markTx(onA)).toEqual({ ok: false, message: QA_ELSEWHERE.message });
  });

  it('a real person joining while the mark runs: the mark waits for the join, then refuses for the real person', async () => {
    const x = await company(`it-${run}-race`);
    const other = await company(`it-${run}-race-other`);
    const qa = await person(`it-${run}-race-qa`, `qa.race${letters}@vitan.in`, x);
    await unlocked(async () => { await member('org', x, qa); await member('org', other, qa); });
    const real = await person(`it-${run}-race-real`, `it-${run}-race-real@t.local`, x);
    let joined!: () => void;
    let release!: () => void;
    const didJoin = new Promise<void>((r) => (joined = r));
    const released = new Promise<void>((r) => (release = r));
    // the join holds the company row FOR SHARE (the QA company lock's trigger) until it commits
    const joining = t.prisma.$transaction(async (tx) => {
      await tx.membership.create({ data: { projectId: `${x}-p`, userId: real, role: 'engineer', status: 'active' } });
      joined();
      await released;
    }, { timeout: 30_000 });
    try {
      await didJoin;
      const marking = markTx(x);
      let waited = false;
      for (let i = 0; i < 200 && !waited; i++) {
        const [{ c }] = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Org"%'`);
        waited = c > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await joining;
      expect(waited, 'the mark waited on the company row').toBe(true);
      expect(await marking).toEqual({ ok: false, message: REAL_PERSON.message });
    } finally {
      release();
    }
  });
});
