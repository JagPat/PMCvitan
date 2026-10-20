import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { HOME_NAV_CAPABILITY } from '../../src/platform/capabilities.service';
import { OPS_DOOR_FAILURES_GLOBAL, OPS_DOOR_FAILURES_PER_ADDRESS, OPS_DOOR_WINDOW_MS, OPS_TOKEN_MIN_LENGTH } from '../../src/platform/ops/ops-token.guard';

/**
 * #482 operator door — the operator commands (the project list and the home-nav switch) as
 * `/ops` routes behind `OPS_TOKEN`. Closed (404) without a strong token, refused (401) for a wrong one, and
 * the switch is the same audited, idempotent, presentation-only switch the CLIs run.
 */
describe('#482 operator door (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const TOKEN = 'ops-door-test-token-0123456789abcdef';
  const before = process.env.OPS_TOKEN;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterEach(() => {
    if (before === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = before;
  });
  afterAll(async () => {
    await t?.prisma.projectCapability.deleteMany({ where: { projectId: f?.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const body = { operator: 'ops@test.local', reason: 'door test' };

  it('is closed (404) with no OPS_TOKEN, or one shorter than the minimum', async () => {
    delete process.env.OPS_TOKEN;
    expect((await http().get('/ops/projects').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(404);
    process.env.OPS_TOKEN = 'x'.repeat(OPS_TOKEN_MIN_LENGTH - 1);
    expect((await http().get('/ops/projects').set('Authorization', `Bearer ${'x'.repeat(OPS_TOKEN_MIN_LENGTH - 1)}`)).status).toBe(404);
    expect((await http().post(`/ops/projects/${f.projectA.id}/capabilities/home-nav/enable`).send(body)).status).toBe(404);
  });

  it('refuses (401) a missing or wrong token, and a signed-in user\'s JWT', async () => {
    process.env.OPS_TOKEN = TOKEN;
    expect((await http().get('/ops/projects')).status).toBe(401);
    expect((await http().get('/ops/projects').set('Authorization', `Bearer ${TOKEN}x`)).status).toBe(401);
    const jwt = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    expect((await http().get('/ops/projects').set('Authorization', `Bearer ${jwt}`)).status).toBe(401);
    const sw = await http().post(`/ops/projects/${f.projectA.id}/capabilities/home-nav/enable`).set('Authorization', `Bearer ${jwt}`).send(body);
    expect(sw.status).toBe(401);
    expect(await t.prisma.projectCapability.count({ where: { projectId: f.projectA.id, capability: HOME_NAV_CAPABILITY } })).toBe(0);
  });

  it('lists live projects with their switched-on capabilities', async () => {
    process.env.OPS_TOKEN = TOKEN;
    const r = await http().get('/ops/projects').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status, r.text).toBe(200);
    const row = (r.body.projects as Array<{ id: string; name: string; capabilities: string[] }>).find((p) => p.id === f.projectA.id);
    expect(row).toBeDefined();
    expect(row!.capabilities).not.toContain(HOME_NAV_CAPABILITY);
  });

  it('lists each company\'s owners and admins, and each live project\'s active members, read only', async () => {
    process.env.OPS_TOKEN = TOKEN;
    expect((await http().get('/ops/people')).status).toBe(401);
    const r = await http().get('/ops/people').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status, r.text).toBe(200);
    type Company = { id: string; managers: Array<{ name: string; contact: string | null; role: string }> };
    type Proj = { id: string; companyId: string; company: string; members: Array<{ name: string; contact: string | null; role: string; discipline: string | null }> };
    const { orgId } = await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id }, select: { orgId: true } });
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    const orgA = (r.body.companies as Company[]).find((c) => c.id === orgId);
    expect(orgA?.managers).toEqual([{ name: owner.name, contact: owner.email, role: 'owner' }]);
    const a = (r.body.projects as Proj[]).find((p) => p.id === f.projectA.id);
    expect(a?.companyId).toBe(orgId);
    expect(a?.members.map((m) => [m.name, m.role]).sort()).toEqual([['client4b', 'client'], ['member', 'pmc']]);
    // nothing in the reply carries a password hash or a token
    expect(r.text).not.toMatch(/passwordHash|"password"/);
  });

  it('switches home-nav on and off, audited with via ops-api, and a repeat changes nothing', async () => {
    process.env.OPS_TOKEN = TOKEN;
    const url = (act: string) => `/ops/projects/${f.projectA.id}/capabilities/home-nav/${act}`;
    const on = await http().post(url('enable')).set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(on.status, on.text).toBe(200);
    expect(on.body).toMatchObject({ ok: true, changed: true });
    expect((await http().post(url('enable')).set('Authorization', `Bearer ${TOKEN}`).send(body)).body.changed).toBe(false);
    const listed = await http().get('/ops/projects').set('Authorization', `Bearer ${TOKEN}`);
    expect((listed.body.projects as Array<{ id: string; capabilities: string[] }>).find((p) => p.id === f.projectA.id)!.capabilities).toContain(HOME_NAV_CAPABILITY);

    const off = await http().post(url('disable')).set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(off.body).toMatchObject({ ok: true, changed: true });
    expect((await http().post(url('disable')).set('Authorization', `Bearer ${TOKEN}`).send(body)).body.changed).toBe(false);

    const audits = await t.prisma.auditLog.findMany({
      where: { projectId: f.projectA.id, action: { in: ['capability.enable', 'capability.disable'] } },
      orderBy: { at: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['capability.enable', 'capability.disable']);
    for (const a of audits) {
      expect(a.actorId).toBe('ops@test.local');
      expect(a.payload).toEqual({ reason: 'door test', via: 'ops-api' });
    }
    // the other project is never touched
    expect(await t.prisma.projectCapability.count({ where: { projectId: f.projectB.id } })).toBe(0);
  });

  it('refuses a capability that is not presentation only, an unknown project, and a missing reason', async () => {
    process.env.OPS_TOKEN = TOKEN;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await http().post(`/ops/projects/${f.projectA.id}/capabilities/materials/enable`).set(auth).send(body)).status).toBe(400);
    expect((await http().post(`/ops/projects/${f.projectA.id}/capabilities/commercial/disable`).set(auth).send(body)).status).toBe(400);
    expect((await http().post('/ops/projects/no-such-project/capabilities/home-nav/enable').set(auth).send(body)).status).toBe(400);
    expect((await http().post(`/ops/projects/${f.projectA.id}/capabilities/home-nav/enable`).set(auth).send({ operator: 'ops@test.local' })).status).toBe(400);
    expect(await t.prisma.projectCapability.count({ where: { projectId: f.projectA.id, capability: { not: 'consultation' } } })).toBe(0);
  });

  it('refuses to switch an archived project, and leaves it off the list', async () => {
    process.env.OPS_TOKEN = TOKEN;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
    try {
      for (const act of ['enable', 'disable']) {
        const r = await http().post(`/ops/projects/${f.projectB.id}/capabilities/home-nav/${act}`).set(auth).send(body);
        expect(r.status, r.text).toBe(400);
      }
      expect(await t.prisma.projectCapability.count({ where: { projectId: f.projectB.id } })).toBe(0);
      expect(await t.prisma.auditLog.count({ where: { projectId: f.projectB.id, action: { startsWith: 'capability.' } } })).toBe(0);
      const listed = await http().get('/ops/projects').set(auth);
      expect((listed.body.projects as Array<{ id: string }>).map((p) => p.id)).not.toContain(f.projectB.id);
      const people = await http().get('/ops/people').set(auth);
      expect((people.body.projects as Array<{ id: string }>).map((p) => p.id)).not.toContain(f.projectB.id);
    } finally {
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
    }
  });

  // the four OpsController routes, and the QA routes the same guard keeps, for the loops below
  const ROUTES = (projectId: string) => [
    { method: 'get', path: '/ops/projects' },
    { method: 'get', path: '/ops/people' },
    { method: 'post', path: `/ops/projects/${projectId}/capabilities/home-nav/enable` },
    { method: 'post', path: `/ops/projects/${projectId}/capabilities/home-nav/disable` },
  ] as const;
  const call = (r: { method: 'get' | 'post'; path: string }, from?: string, token?: string) => {
    let q = r.method === 'get' ? http().get(r.path) : http().post(r.path).send(body);
    if (from) q = q.set('X-Forwarded-For', from);
    if (token) q = q.set('Authorization', `Bearer ${token}`);
    return q;
  };

  it('stays 404 while closed however often it is called, on all four routes: the door is checked before any count', async () => {
    delete process.env.OPS_TOKEN;
    for (let i = 0; i < 35; i++) {
      for (const r of ROUTES(f.projectA.id)) expect((await call(r, '192.0.2.1')).status, `${r.method} ${r.path}`).toBe(404);
    }
  });

  it('answers a closed route exactly as a path the server does not have, HEAD included', async () => {
    delete process.env.OPS_TOKEN;
    const pairs = [
      ['get', '/ops/people?x=1', '/ops/nobody?x=1'],
      ['post', `/ops/projects/${f.projectA.id}/capabilities/home-nav/enable`, `/ops/nowhere/${f.projectA.id}/capabilities/home-nav/enable`],
      ['post', '/auth/ops/qa-sign-in', '/auth/ops/qa-sign-up'],
    ] as const;
    for (const [method, closedPath, unroutedPath] of pairs) {
      const closed = await http()[method](closedPath);
      const unrouted = await http()[method](unroutedPath);
      expect(closed.status).toBe(404);
      expect(unrouted.status).toBe(404);
      expect(closed.body).toEqual({ ...unrouted.body, message: (unrouted.body.message as string).replace(unroutedPath, closedPath) });
    }
    // the same length of path, so the same Content-Length: HEAD cannot tell them apart either
    const head = await http().head('/ops/projects');
    const none = await http().head('/ops/projectz');
    expect(head.status).toBe(404);
    expect(none.status).toBe(404);
    expect(head.headers['content-length']).toBe(none.headers['content-length']);
    expect(head.headers['content-type']).toBe(none.headers['content-type']);
  });

  describe('wrong tokens are counted in the guard\'s own window', () => {
    // each test starts in a window no earlier call reached: only the clock is faked, the HTTP stack runs as usual
    let ahead = Date.now();
    beforeEach(() => {
      ahead += 2 * OPS_DOOR_WINDOW_MS;
      vi.useFakeTimers({ toFake: ['Date'], now: ahead });
    });
    afterEach(() => vi.useRealTimers());

    it('per address, across every route the guard keeps (QA ones included): 401 up to the limit, then 429; the token still opens it', async () => {
      process.env.OPS_TOKEN = TOKEN;
      const routes = [...ROUTES(f.projectA.id), { method: 'post', path: '/auth/ops/qa-sign-in' }, { method: 'post', path: `/ops/orgs/${f.orgA.id}/qa-only` }] as const;
      const from = '203.0.113.10';
      for (let i = 0; i < OPS_DOOR_FAILURES_PER_ADDRESS; i++) {
        const r = routes[i % routes.length];
        expect((await call(r, from, i % 2 ? `${TOKEN}x` : undefined)).status, `${r.method} ${r.path}`).toBe(401);
      }
      for (const r of routes) expect((await call(r, from)).status, `${r.method} ${r.path}`).toBe(429);
      // the operator, from that same address, is never locked out: a correct token does not read the counter
      const ok = await call(ROUTES(f.projectA.id)[1], from, TOKEN);
      expect(ok.status, ok.text).toBe(200);
      // another address has its own window
      expect((await call(ROUTES(f.projectA.id)[0], '203.0.113.11')).status).toBe(401);
    });

    it('across all addresses: rotating addresses meets the shared cap; the token still opens it, and a closed door is never 429', async () => {
      process.env.OPS_TOKEN = TOKEN;
      const [projects, people] = ROUTES(f.projectA.id);
      const perAddress = OPS_DOOR_FAILURES_PER_ADDRESS / 2;
      for (let i = 0; i < OPS_DOOR_FAILURES_GLOBAL; i++) {
        expect((await call(projects, `198.51.100.${Math.floor(i / perAddress)}`)).status).toBe(401);
      }
      expect((await call(projects, '198.51.100.250')).status).toBe(429);
      const ok = await call(people, '198.51.100.250', TOKEN);
      expect(ok.status, ok.text).toBe(200);
      delete process.env.OPS_TOKEN;
      for (const r of ROUTES(f.projectA.id)) expect((await call(r, '198.51.100.251')).status).toBe(404);
    });
  });
});
