import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Role } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 (Board decision, 14 Oct 2026) — every project member adds a site photo: the PMC, the engineer, a
 * consultant, a contractor (and the foreman, who signs in as a contractor member) and the client. Proven per role through the real route, guard and service against PostgreSQL.
 *
 * Reproduce-first: every non-PMC/engineer "may add a site photo" probe is 403 at the base and 201 here.
 * Linking a photo to a record (a decision, a daily log, an inspection item) stays the PMC's and engineer's,
 * and an anonymous worker token stays out.
 */
describe('who may add a site photo (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: string[] = [];
  const tokens = {} as Record<Role, string>;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  // not the architect: its action set is pinned (P28) and no User may carry the role until 4d-iii opens it;
  // architects visit as consultant members until then
  const ROLES: Role[] = ['pmc', 'engineer', 'contractor', 'consultant', 'client'];

  const upload = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/media`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mime: 'image/png', data: px, ...body });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    tokens.pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    tokens.client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const id = `${f.projectA.id}-${role}`;
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `A ${role}`, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
      extra.push(id);
      tokens[role] = t.issueProjectToken(id, f.projectA.id, role);
    }
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    // this suite's own members go before the fixture's teardown, which deletes the project they point at
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it.each(ROLES)('a %s adds a site photo, placed or not, and it is recorded as theirs', async (role) => {
    const res = await upload(tokens[role], { kind: 'progress', clientKey: `roles-${role}` });
    expect(res.status).toBe(201);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    const who = role === 'pmc' ? f.memberUser.id : role === 'client' ? f.clientUser.id : `${f.projectA.id}-${role}`;
    expect(row).toMatchObject({ projectId: f.projectA.id, kind: 'progress', uploadedBy: who });
    // who added it, in which role and when: frozen on the upload's own event
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, eventType: 'media.uploaded', entityId: row.id } });
    expect(ev.actorRole).toBe(role);
  });

  it.each(['contractor', 'consultant', 'client'] as Role[])('a %s may not link a photo to a record', async (role) => {
    for (const body of [
      { kind: 'inspection', inspectionId: 'any', inspectionItemId: 'any' },
      { kind: 'progress', dailyLogId: 'any' },
      { kind: 'progress', decisionId: 'any' },
      { kind: 'material' },
    ]) {
      const res = await upload(tokens[role], { ...body, clientKey: `refused-${role}-${body.kind}-${Object.keys(body).length}` });
      expect(res.status, `${role} ${JSON.stringify(body)}`).toBe(403);
    }
    // nothing was stored by a refusal
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: `refused-${role}` } } })).toBe(0);
  });

  it('an anonymous worker token adds nothing', async () => {
    const worker = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'worker' as Role);
    expect((await upload(worker, { kind: 'progress', clientKey: 'roles-worker' })).status).toBe(403);
  });

  it('a member of another project adds nothing here', async () => {
    const other = t.issueProjectToken(f.otherUser.id, f.projectA.id, 'contractor');
    expect((await upload(other, { kind: 'progress', clientKey: 'roles-stranger' })).status).toBe(403);
    expect(await t.prisma.media.count({ where: { clientKey: 'roles-stranger' } })).toBe(0);
  });
});
