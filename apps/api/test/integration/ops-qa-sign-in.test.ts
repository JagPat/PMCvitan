import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { recordAudit } from '../../src/platform/audit';
import { systemActor } from '../../src/common/actor';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 operator door QA sign-in, rebuilt on the QA company lock (Jagrut, 20 Oct 2026: "Rebuild it").
 * `POST /ops/orgs/:orgId/qa-only` marks a company QA-only (the database refuses while it holds a real person), and
 * `POST /auth/ops/qa-sign-in` signs the operator in as a QA account only while every company it belongs to is marked.
 * The lock keeps that true, so the session is an ordinary one; a real person cannot be added to the QA company or
 * project by any command, which answers 409 instead of failing.
 */
describe('#482 operator door QA sign-in on the QA company lock (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const TOKEN = 'ops-door-test-token-0123456789abcdef';
  const before = process.env.OPS_TOKEN;
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const run = `qa-${letters}`;
  const qaEmail = `qa.pmc${letters}@vitan.in`;
  const qaClientEmail = `qa.client${letters}@vitan.in`;
  const ids = { org: `it-org-${run}`, project: `it-proj-${run}`, pmc: `it-pmc-${run}`, client: `it-client-${run}`, early: `it-early-${run}`, loner: `it-loner-${run}`, twinOrg: `it-org-twin-${run}`, twinProject: `it-proj-twin-${run}`, twin: `it-twin-${run}`, earlyOrg: `it-org-early-${run}`, earlyProject: `it-proj-early-${run}`, raceOrg: `it-org-race-${run}`, raceProject: `it-proj-race-${run}`, racer: `it-racer-${run}`, leaver: `it-leaver-${run}`, addOrg: `it-org-add-${run}`, addProject: `it-proj-add-${run}`, adder: `it-adder-${run}` };
  const projectData = (id: string, orgId: string) => ({
    id, orgId, name: `QA project ${id}`, short: 'QA', descriptor: '', stage: 'Planning',
    siteCode: 'QA', projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
  });

  const http = () => request(t.app.getHttpServer());
  const door = (path: string) => http().post(path).set('Authorization', `Bearer ${TOKEN}`);
  const body = (email: string) => ({ email, operator: 'claude', reason: 'live QA run' });
  const why = { operator: 'claude', reason: 'the QA company' };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    process.env.OPS_TOKEN = TOKEN;
    await t.prisma.org.create({ data: { id: ids.org, name: `QA org ${run}`, slug: ids.org } });
    await t.prisma.project.create({ data: projectData(ids.project, ids.org) });
    // the company is marked before its QA accounts join: the lock refuses a QA account in an unmarked company
    expect((await door(`/ops/orgs/${ids.org}/qa-only`).send(why)).status).toBe(200);
    await t.prisma.user.create({ data: { id: ids.pmc, projectId: ids.project, role: 'pmc', name: 'QA Pmc', email: qaEmail } });
    await t.prisma.user.create({ data: { id: ids.client, projectId: ids.project, role: 'client', name: 'QA Client', email: qaClientEmail } });
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: ids.pmc, role: 'pmc', status: 'active' } });
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: ids.client, role: 'client', status: 'active' } });
    await t.prisma.orgMembership.create({ data: { orgId: ids.org, userId: ids.pmc, role: 'owner' } });
  });
  afterEach(() => {
    process.env.OPS_TOKEN = TOKEN;
  });
  afterAll(async () => {
    const projects = [ids.project, ids.earlyProject, ids.twinProject, ids.raceProject, ids.addProject];
    const orgs = [ids.org, ids.earlyOrg, ids.twinOrg, ids.raceOrg, ids.addOrg];
    await t?.prisma.$transaction([
      t.prisma.auditLog.deleteMany({ where: { projectId: { in: projects } } }),
      t.prisma.membership.deleteMany({ where: { projectId: { in: projects } } }),
      t.prisma.orgMembership.deleteMany({ where: { OR: [{ orgId: { in: orgs } }, { userId: ids.twin }] } }),
      t.prisma.user.deleteMany({ where: { id: { in: [ids.pmc, ids.client, ids.early, ids.loner, ids.twin, ids.racer, ids.leaver, ids.adder] } } }),
      t.prisma.project.deleteMany({ where: { id: { in: projects } } }),
      t.prisma.org.deleteMany({ where: { id: { in: orgs } } }),
    ]);
    if (before === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = before;
    await f?.cleanup();
    await t?.close();
  });

  it('is closed (404) with no OPS_TOKEN, and refuses (401) a missing or wrong token, for both routes', async () => {
    delete process.env.OPS_TOKEN;
    expect((await door('/auth/ops/qa-sign-in').send(body(qaEmail))).status).toBe(404);
    expect((await door(`/ops/orgs/${ids.org}/qa-only`).send(why)).status).toBe(404);
    process.env.OPS_TOKEN = TOKEN;
    expect((await http().post('/auth/ops/qa-sign-in').send(body(qaEmail))).status).toBe(401);
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}x`).send(body(qaEmail))).status).toBe(401);
    const jwt = t.issueProjectToken(ids.pmc, ids.project);
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${jwt}`).send(body(qaEmail))).status).toBe(401);
    expect((await http().post(`/ops/orgs/${ids.org}/qa-only`).set('Authorization', `Bearer ${jwt}`).send(why)).status).toBe(401);
  });

  it('stays 404 while closed however often it is called: the door is checked before the rate limit (Codex P2)', async () => {
    delete process.env.OPS_TOKEN;
    for (let i = 0; i < 12; i++) expect((await door('/auth/ops/qa-sign-in').send(body(qaEmail))).status).toBe(404);
  });

  it('marks a company once, with an audit row on its project; refuses one holding a real person, and an unknown one', async () => {
    const marks = await t.prisma.auditLog.findMany({ where: { projectId: ids.project, action: 'org.qaOnly' } });
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ actor: 'claude', entity: 'Org', entityId: ids.org, payload: { reason: 'the QA company', via: 'ops-api' } });
    const again = await door(`/ops/orgs/${ids.org}/qa-only`).send(why);
    expect(again.body).toEqual({ ok: true, orgId: ids.org, changed: false });
    expect(await t.prisma.auditLog.count({ where: { projectId: ids.project, action: 'org.qaOnly' } })).toBe(1);
    // the fixture's company holds real people
    const real = await door(`/ops/orgs/${f.projectA.orgId}/qa-only`).send(why);
    expect(real.status, real.text).toBe(409);
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: f.projectA.orgId } })).qaOnly).toBe(false);
    expect(await t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'org.qaOnly' } })).toBe(0);
    expect((await door('/ops/orgs/no-such-company/qa-only').send(why)).status).toBe(404);
    // a company of QA accounts one of whom is still, from before the lock, in an ordinary company: 409, nothing written
    await t.prisma.org.create({ data: { id: ids.twinOrg, name: `Twin QA org ${run}`, slug: ids.twinOrg } });
    await t.prisma.project.create({ data: projectData(ids.twinProject, ids.twinOrg) });
    await t.prisma.user.create({ data: { id: ids.twin, projectId: ids.twinProject, role: 'pmc', name: 'QA Twin', email: `qa.twin${letters}@vitan.in` } });
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "OrgMembership" DISABLE TRIGGER "OrgMembership_qa_lock"`);
    try {
      await t.prisma.orgMembership.createMany({ data: [{ orgId: ids.twinOrg, userId: ids.twin, role: 'member' }, { orgId: f.projectA.orgId, userId: ids.twin, role: 'member' }] });
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "OrgMembership" ENABLE TRIGGER "OrgMembership_qa_lock"`);
    }
    const twin = await door(`/ops/orgs/${ids.twinOrg}/qa-only`).send(why);
    expect(twin.status, twin.text).toBe(409);
    expect(twin.body.message).toMatch(/still belongs to a company that is not QA-only/);
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: ids.twinOrg } })).qaOnly).toBe(false);
    expect(await t.prisma.auditLog.count({ where: { projectId: ids.twinProject, action: 'org.qaOnly' } })).toBe(0);
    // the operator's roster says which companies are marked
    const people = await http().get('/ops/people').set('Authorization', `Bearer ${TOKEN}`);
    expect(people.body.companies.find((c: { id: string }) => c.id === ids.org)).toMatchObject({ qaOnly: true });
    expect(people.body.companies.find((c: { id: string }) => c.id === f.projectA.orgId)).toMatchObject({ qaOnly: false });
  });

  it('signs in a QA account of a marked company, with a working token, a project switch and an audit row', async () => {
    const r = await door('/auth/ops/qa-sign-in').send(body(qaClientEmail.toUpperCase()));
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ role: 'client', projectId: ids.project, name: 'QA Client' });
    expect((await http().get('/me/memberships').set('Authorization', `Bearer ${r.body.token}`)).status).toBe(200);
    const audit = await t.prisma.auditLog.findMany({ where: { projectId: ids.project, action: 'auth.qaSignIn', entityId: ids.client } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'claude', entity: 'User', entityId: ids.client, payload: { reason: 'live QA run', via: 'ops-api' } });
    const pmc = await door('/auth/ops/qa-sign-in').send(body(qaEmail));
    const switched = await http().post('/auth/switch').set('Authorization', `Bearer ${pmc.body.token}`).send({ projectId: ids.project });
    expect(switched.status, switched.text).toBe(201);
    expect((await http().get(`/projects/${ids.project}/snapshot`).set('Authorization', `Bearer ${switched.body.token}`)).status).toBe(200);
  });

  it('refuses a real account, an unknown QA address, a QA account in no company, and one still in an unmarked company', async () => {
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    expect((await door('/auth/ops/qa-sign-in').send(body(owner.email!))).status).toBe(403);
    expect((await door('/auth/ops/qa-sign-in').send(body(`qa.nobody${letters}@vitan.in`))).status).toBe(404);
    // a QA account whose membership predates the lock, in a company nobody has marked yet (the live QA company today)
    const earlyEmail = `qa.early${letters}@vitan.in`;
    await t.prisma.org.create({ data: { id: ids.earlyOrg, name: `Early QA org ${run}`, slug: ids.earlyOrg } });
    await t.prisma.project.create({ data: projectData(ids.earlyProject, ids.earlyOrg) });
    await t.prisma.user.create({ data: { id: ids.early, projectId: ids.earlyProject, role: 'pmc', name: 'QA Early', email: earlyEmail } });
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Membership" DISABLE TRIGGER "Membership_qa_lock"`);
    try {
      await t.prisma.membership.create({ data: { projectId: ids.earlyProject, userId: ids.early, role: 'pmc', status: 'active' } });
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "Membership" ENABLE TRIGGER "Membership_qa_lock"`);
    }
    expect((await door('/auth/ops/qa-sign-in').send(body(earlyEmail))).status).toBe(403);
    // once its company is marked (it holds only QA accounts), it signs in
    expect((await door(`/ops/orgs/${ids.earlyOrg}/qa-only`).send(why)).status).toBe(200);
    expect((await door('/auth/ops/qa-sign-in').send(body(earlyEmail))).status).toBe(201);
    // a QA account in no company at all is refused, not passed as "every company is QA-only" over none:
    // one with only a home project, then one whose only membership (in that marked company) is removed
    const lonerEmail = `qa.loner${letters}@vitan.in`;
    await t.prisma.user.create({ data: { id: ids.loner, projectId: ids.earlyProject, role: 'pmc', name: 'QA Loner', email: lonerEmail } });
    expect((await door('/auth/ops/qa-sign-in').send(body(lonerEmail))).status).toBe(403);
    await t.prisma.membership.create({ data: { projectId: ids.earlyProject, userId: ids.loner, role: 'engineer', status: 'removed' } });
    expect((await door('/auth/ops/qa-sign-in').send(body(lonerEmail))).status).toBe(403);
  });

  it('a real person cannot be added to the QA company or project through any command: 409, and nothing is written', async () => {
    const pmcToken = t.issueProjectToken(ids.pmc, ids.project);
    const realEmail = `real-${run}@test.local`;
    const member = await http().post(`/projects/${ids.project}/members`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: 'Real Person', role: 'engineer', email: realEmail });
    expect(member.status, member.text).toBe(409);
    expect(member.body.message).toMatch(/kept in separate companies/);
    const orgMember = await http().post(`/orgs/${ids.org}/members`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: 'Real Person', role: 'member', email: realEmail });
    expect(orgMember.status, orgMember.text).toBe(409);
    expect(await t.prisma.user.count({ where: { email: realEmail } })).toBe(0);
    // and a QA account cannot start a company of its own, which would not be QA-only
    const created = await http().post('/orgs').set('Authorization', `Bearer ${pmcToken}`).send({ name: `Stray ${run}` });
    expect(created.status, created.text).toBe(409);
    expect(await t.prisma.org.count({ where: { name: `Stray ${run}` } })).toBe(0);
    // so the session signed in above stays a QA-only one: nothing about it needs re-checking
    const r = await door('/auth/ops/qa-sign-in').send(body(qaEmail));
    expect((await http().get('/me/memberships').set('Authorization', `Bearer ${r.body.token}`)).status).toBe(200);
  });

  it('a QA address cannot be added to an ordinary project either: 409, and nothing is written', async () => {
    const ownerToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id);
    const stray = `qa.stray${letters}@vitan.in`;
    const r = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${ownerToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: 'Stray QA', role: 'engineer', email: stray });
    expect(r.status, r.text).toBe(409);
    expect(await t.prisma.user.count({ where: { email: stray } })).toBe(0);
  });

  /**
   * A deterministic race (as in `qa-company-lock.test.ts`): `first` runs inside a transaction that it then holds open;
   * `second` starts only after that, and the holder lets go only once `second` is seen waiting on a lock in
   * pg_stat_activity. With no `waitingOn`, `second` must finish while `first` still holds (it must not wait at all).
   * Returns what `first` returned and what `second` resolved to.
   */
  const race = async <A, B>(first: (tx: Prisma.TransactionClient) => Promise<A>, second: () => Promise<B>, waitingOn: string | null) => {
    let written!: () => void;
    let release!: () => void;
    const wrote = new Promise<void>((r) => (written = r));
    const released = new Promise<void>((r) => (release = r));
    const holding = t.prisma.$transaction(async (tx) => {
      const out = await first(tx);
      written();
      await released;
      return out;
    }, { timeout: 30_000 });
    try {
      await Promise.race([wrote, holding]);
      // started now: a supertest request and a Prisma query each run only once something awaits them
      const competing = (async () => await second())();
      if (waitingOn === null) {
        const done = await competing;
        release();
        return { first: await holding, second: done };
      }
      for (let i = 0; ; i++) {
        const [{ c }] = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, `%${waitingOn}%`);
        if (c > 0) break;
        if (i >= 400) throw new Error(`the second step never waited on a lock (${waitingOn})`);
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      return { first: await holding, second: await competing };
    } finally {
      release();
    }
  };

  it('two marks of one company race: the second waits, then finds it marked, so exactly one audit row is written', async () => {
    await t.prisma.org.create({ data: { id: ids.raceOrg, name: `Race QA org ${run}`, slug: ids.raceOrg } });
    await t.prisma.project.create({ data: projectData(ids.raceProject, ids.raceOrg) });
    const orgs = t.app.get(OrgsParticipant, { strict: false });
    // the first mark is the door's own transaction body, held open after its write
    const r = await race(async (tx) => {
      const marked = await orgs.markQaOnly(tx, ids.raceOrg);
      if (marked.changed) {
        for (const projectId of marked.projectIds) {
          await recordAudit(tx, { projectId, actor: systemActor('claude', 'claude', 'operator'), action: 'org.qaOnly', entity: 'Org', entityId: ids.raceOrg, payload: { reason: 'first', via: 'ops-api' } });
        }
      }
      return marked.changed;
    }, () => door(`/ops/orgs/${ids.raceOrg}/qa-only`).send(why), '"Org"');
    expect(r.first).toBe(true);
    expect(r.second.status, r.second.text).toBe(200);
    expect(r.second.body).toEqual({ ok: true, orgId: ids.raceOrg, changed: false });
    expect(await t.prisma.auditLog.count({ where: { projectId: ids.raceProject, action: 'org.qaOnly' } })).toBe(1);
  });

  it('a sign-in that meets a removal or an email change in flight never waits on it: 409 (try again), nothing recorded', async () => {
    const email = `qa.leaver${letters}@vitan.in`;
    await t.prisma.user.create({ data: { id: ids.leaver, projectId: ids.project, role: 'engineer', name: 'QA Leaver', email } });
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: ids.leaver, role: 'engineer', status: 'active' } });
    const orgs = t.app.get(OrgsParticipant, { strict: false });
    // an email change (to another QA address) still uncommitted: the check refuses at once instead of queueing behind it
    const renamed = `qa.leaver${letters}x@vitan.in`;
    const renaming = await race(
      (tx) => tx.$executeRawUnsafe(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, renamed, ids.leaver),
      () => t.prisma.$transaction((tx) => orgs.qaSignInAllowed(tx, ids.leaver)).then(() => null, (e: unknown) => e),
      null,
    );
    expect(renaming.second).toBeInstanceOf(ConflictException);
    // the removal of its only membership, still uncommitted: the door answers 409 at once and records nothing
    const removing = await race(
      (tx) => tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "userId" = $1`, ids.leaver),
      () => door('/auth/ops/qa-sign-in').send(body(renamed)),
      null,
    );
    expect(removing.second.status, removing.second.text).toBe(409);
    expect(removing.second.body.message).toMatch(/being changed right now/);
    expect(await t.prisma.auditLog.count({ where: { action: 'auth.qaSignIn', entityId: ids.leaver } })).toBe(0);
    // once the removal has committed, the account reaches no company and is refused (asked directly: rate limit)
    expect(await t.prisma.$transaction((tx) => orgs.qaSignInAllowed(tx, ids.leaver))).toBe(false);
  });

  it('a mark of a company with no live project still leaves one audit record, at company level', async () => {
    const bare = `it-org-bare-${run}`;
    await t.prisma.org.create({ data: { id: bare, name: `Bare QA org ${run}`, slug: bare } });
    try {
      const r = await door(`/ops/orgs/${bare}/qa-only`).send(why);
      expect(r.body).toEqual({ ok: true, orgId: bare, changed: true });
      const rows = await t.prisma.auditLog.findMany({ where: { action: 'org.qaOnly', entityId: bare } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ projectId: null, actor: 'claude', entity: 'Org', payload: { reason: 'the QA company', via: 'ops-api' } });
    } finally {
      await t.prisma.auditLog.deleteMany({ where: { entityId: bare } });
      await t.prisma.org.deleteMany({ where: { id: bare } });
    }
  });

  it('a sign-in that checks first holds its answer until it commits: an email change, a company-row removal and a membership removal each wait for it', async () => {
    // (an email change to a non-QA address, or unmarking the company, is refused outright by the QA company lock)
    await t.prisma.user.create({ data: { id: ids.racer, projectId: ids.project, role: 'engineer', name: 'QA Racer', email: `qa.racer${letters}@vitan.in` } });
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: ids.racer, role: 'engineer', status: 'active' } });
    await t.prisma.orgMembership.create({ data: { orgId: ids.org, userId: ids.racer, role: 'member' } });
    const orgs = t.app.get(OrgsParticipant, { strict: false });
    const check = (tx: Prisma.TransactionClient) => orgs.qaSignInAllowed(tx, ids.racer);
    const flips = [
      { sql: `UPDATE "User" SET "email" = $1 WHERE "id" = $2`, args: [`qa.racer${letters}b@vitan.in`, ids.racer], waitingOn: 'UPDATE "User" SET "email"' },
      { sql: `DELETE FROM "OrgMembership" WHERE "userId" = $1`, args: [ids.racer], waitingOn: 'DELETE FROM "OrgMembership"' },
      { sql: `UPDATE "Membership" SET "status" = 'removed' WHERE "userId" = $1`, args: [ids.racer], waitingOn: `UPDATE "Membership" SET "status"` },
    ];
    for (const flip of flips) {
      const r = await race(check, () => t.prisma.$executeRawUnsafe(flip.sql, ...flip.args), flip.waitingOn);
      expect(r.first, flip.waitingOn).toBe(true);
      expect(r.second, flip.waitingOn).toBe(1);
    }
    // with both of its rows gone, it is refused (asked directly: the door's sign-in rate limit is spent by now)
    expect(await t.prisma.$transaction((tx) => check(tx))).toBe(false);
  });

  it('a company marked while a real person is being added to its roster: the add waits, is refused, and leaves no User row', async () => {
    // the company's one owner is a QA account whose row predates the lock, so the company can be marked mid-add
    await t.prisma.org.create({ data: { id: ids.addOrg, name: `Add QA org ${run}`, slug: ids.addOrg } });
    await t.prisma.project.create({ data: projectData(ids.addProject, ids.addOrg) });
    await t.prisma.user.create({ data: { id: ids.adder, projectId: ids.addProject, role: 'pmc', name: 'QA Adder', email: `qa.adder${letters}@vitan.in` } });
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "OrgMembership" DISABLE TRIGGER "OrgMembership_qa_lock"`);
    try {
      await t.prisma.orgMembership.create({ data: { orgId: ids.addOrg, userId: ids.adder, role: 'owner' } });
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "OrgMembership" ENABLE TRIGGER "OrgMembership_qa_lock"`);
    }
    const realEmail = `real-add-${run}@test.local`;
    const token = t.issueProjectToken(ids.adder, ids.addProject);
    const r = await race(
      (tx) => tx.$executeRawUnsafe(`UPDATE "Org" SET "qaOnly" = true WHERE "id" = $1`, ids.addOrg),
      () => http().post(`/orgs/${ids.addOrg}/members`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID())
        .send({ name: 'Real Person', role: 'member', email: realEmail }),
      'OrgMembership',
    );
    expect(r.second.status, r.second.text).toBe(409);
    expect(await t.prisma.user.count({ where: { email: realEmail } })).toBe(0);
  });
});
