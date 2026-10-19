import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 operator door QA sign-in (Jagrut, 19 Oct 2026) — `POST /auth/ops/qa-sign-in` signs the operator in as a
 * QA account, behind `OPS_TOKEN`, only when the account and every company it reaches are QA-only. A real
 * account, or a QA account inside a company with a real person in it, is refused.
 */
describe('#482 operator door QA sign-in (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const TOKEN = 'ops-door-test-token-0123456789abcdef';
  const before = process.env.OPS_TOKEN;
  const letters = randomUUID().replace(/[^a-f]/g, '').padEnd(6, 'q').slice(0, 6);
  const run = `qa-${letters}`;
  const qaEmail = `qa.pmc${letters}@vitan.in`;
  const qaClientEmail = `qa.client${letters}@vitan.in`;
  const ids = { org: `it-org-${run}`, project: `it-proj-${run}`, pmc: `it-pmc-${run}`, client: `it-client-${run}` };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.org.create({ data: { id: ids.org, name: `QA org ${run}`, slug: ids.org } });
    await t.prisma.project.create({
      data: {
        id: ids.project, orgId: ids.org, name: `QA project ${run}`, short: 'QA', descriptor: '', stage: 'Planning',
        siteCode: 'QA', projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
      },
    });
    await t.prisma.user.create({ data: { id: ids.pmc, projectId: ids.project, role: 'pmc', name: 'QA Pmc', email: qaEmail } });
    await t.prisma.user.create({ data: { id: ids.client, projectId: ids.project, role: 'client', name: 'QA Client', email: qaClientEmail } });
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: ids.pmc, role: 'pmc', status: 'active' } });
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: ids.client, role: 'client', status: 'active' } });
    await t.prisma.orgMembership.create({ data: { orgId: ids.org, userId: ids.pmc, role: 'owner' } });
  });
  afterEach(() => {
    if (before === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = before;
  });
  afterAll(async () => {
    await t?.prisma.$transaction([
      t.prisma.auditLog.deleteMany({ where: { projectId: ids.project } }),
      t.prisma.membership.deleteMany({ where: { projectId: ids.project } }),
      t.prisma.orgMembership.deleteMany({ where: { orgId: ids.org } }),
      t.prisma.user.deleteMany({ where: { id: { in: [ids.pmc, ids.client] } } }),
      t.prisma.project.deleteMany({ where: { id: ids.project } }),
      t.prisma.org.deleteMany({ where: { id: ids.org } }),
    ]);
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const body = (email: string) => ({ email, operator: 'claude', reason: 'live QA run' });

  it('is closed (404) with no OPS_TOKEN, and refuses (401) a missing or wrong token', async () => {
    delete process.env.OPS_TOKEN;
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}`).send(body(qaEmail))).status).toBe(404);
    process.env.OPS_TOKEN = TOKEN;
    expect((await http().post('/auth/ops/qa-sign-in').send(body(qaEmail))).status).toBe(401);
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}x`).send(body(qaEmail))).status).toBe(401);
    const jwt = t.issueProjectToken(ids.pmc, ids.project);
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${jwt}`).send(body(qaEmail))).status).toBe(401);
  });

  it('signs in a QA account of a QA-only company, with a working token and an audit row', async () => {
    process.env.OPS_TOKEN = TOKEN;
    const r = await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}`).send(body(qaClientEmail.toUpperCase()));
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ role: 'client', projectId: ids.project, name: 'QA Client' });
    const me = await http().get('/me/memberships').set('Authorization', `Bearer ${r.body.token}`);
    expect(me.status, me.text).toBe(200);
    const audit = await t.prisma.auditLog.findMany({ where: { projectId: ids.project, action: 'auth.qaSignIn' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'claude', entity: 'User', entityId: ids.client, payload: { reason: 'live QA run', via: 'ops-api' } });
  });

  it('refuses a real account, and an unknown QA address', async () => {
    process.env.OPS_TOKEN = TOKEN;
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}`).send(body(owner.email!))).status).toBe(403);
    expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}`).send(body(`qa.nobody${letters}@vitan.in`))).status).toBe(404);
  });

  it('refuses a QA account once a real person is in its company or on its project', async () => {
    process.env.OPS_TOKEN = TOKEN;
    await t.prisma.membership.create({ data: { projectId: ids.project, userId: f.strangerUser.id, role: 'engineer', status: 'active' } });
    try {
      const r = await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}`).send(body(qaEmail));
      expect(r.status, r.text).toBe(403);
    } finally {
      await t.prisma.membership.deleteMany({ where: { projectId: ids.project, userId: f.strangerUser.id } });
    }
    await t.prisma.orgMembership.create({ data: { orgId: ids.org, userId: f.strangerUser.id, role: 'member' } });
    try {
      expect((await http().post('/auth/ops/qa-sign-in').set('Authorization', `Bearer ${TOKEN}`).send(body(qaEmail))).status).toBe(403);
    } finally {
      await t.prisma.orgMembership.deleteMany({ where: { orgId: ids.org, userId: f.strangerUser.id } });
    }
    expect(await t.prisma.auditLog.count({ where: { projectId: ids.project, action: 'auth.qaSignIn', entityId: ids.pmc } })).toBe(0);
  });
});
