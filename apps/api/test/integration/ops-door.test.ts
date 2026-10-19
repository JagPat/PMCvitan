import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { HOME_NAV_CAPABILITY } from '../../src/platform/capabilities.service';
import { OPS_TOKEN_MIN_LENGTH } from '../../src/platform/ops/ops-token.guard';

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
});
