import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos (Board, 14 Oct 2026) — every member deletes a site photo they added, within an hour of adding it;
 * nobody else's, and not after the hour. The PMC and the engineer keep deleting any photo. Proven through the real
 * routes against PostgreSQL. Reproduce-first: on main a contractor's DELETE is refused by role, and `mine` is absent.
 */
describe('a member deletes their own site photo within the hour (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let contractor: string;
  let client: string;
  let pmc: string;
  const contractorId = () => `${f.projectA.id}-del-contractor`;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const http = () => request(t.app.getHttpServer());
  const photo = async (uploadedBy: string, createdAt: Date, kind = 'progress') =>
    (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind, mime: 'image/png', uploadedBy, data: px, createdAt } })).id;
  const del = (id: string, token: string) => http().delete(`/media/${id}`).set('Authorization', `Bearer ${token}`);
  const exists = async (id: string) => (await t.prisma.media.findUnique({ where: { id } })) !== null;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.user.create({ data: { id: contractorId(), projectId: f.projectA.id, role: 'contractor', name: 'Ravi Patel', email: `${contractorId()}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractorId(), role: 'contractor', status: 'active' } });
    contractor = t.issueProjectToken(contractorId(), f.projectA.id, 'contractor');
    client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id);
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: contractorId() } });
    await t?.prisma.user.deleteMany({ where: { id: contractorId() } });
    await f?.cleanup();
    await t?.close();
  });

  it('deletes a site photo the member added ten minutes ago, and records the removal', async () => {
    const id = await photo(contractorId(), minutesAgo(10));
    await del(id, contractor).expect(200);
    expect(await exists(id)).toBe(false);
    expect(await t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, eventType: 'media.removed', entityId: id } })).toBe(1);
  });

  it('keeps a photo the member added more than an hour ago', async () => {
    const id = await photo(contractorId(), minutesAgo(61));
    const res = await del(id, contractor).expect(403);
    expect(res.body.message).toMatch(/within an hour/);
    expect(await exists(id)).toBe(true);
  });

  it('never deletes a photo another member added, however recent', async () => {
    const id = await photo(f.clientUser.id, minutesAgo(1));
    await del(id, contractor).expect(403);
    expect(await exists(id)).toBe(true);
  });

  it('never deletes a photo of theirs that is not a plain site photo', async () => {
    const id = await photo(contractorId(), minutesAgo(1), 'inspection');
    await del(id, contractor).expect(403);
    expect(await exists(id)).toBe(true);
  });

  it('keeps a photo of theirs filed on a daily log that was since sent, and deletes one on a log still open', async () => {
    const sent = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'sent', submitted: true } });
    const open = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'open' } });
    const filed = async (dailyLogId: string) =>
      (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: contractorId(), data: px, createdAt: minutesAgo(3), dailyLogId } })).id;
    const onSent = await filed(sent.id);
    const onOpen = await filed(open.id);
    const res = await del(onSent, contractor).expect(403);
    expect(res.body.message).toMatch(/already sent/);
    expect(await exists(onSent)).toBe(true);
    await del(onOpen, contractor).expect(200);
    expect(await exists(onOpen)).toBe(false);
    await t.prisma.media.deleteMany({ where: { dailyLogId: { in: [sent.id, open.id] } } });
    await t.prisma.dailyLog.deleteMany({ where: { id: { in: [sent.id, open.id] } } });
  });

  it('the client deletes their own new photo too', async () => {
    const id = await photo(f.clientUser.id, minutesAgo(5));
    await del(id, client).expect(200);
    expect(await exists(id)).toBe(false);
  });

  it('the PMC still deletes any photo, at any age', async () => {
    const id = await photo(contractorId(), minutesAgo(600));
    await del(id, pmc).expect(200);
    expect(await exists(id)).toBe(false);
  });

  it('the snapshot marks the viewer’s own photos, and only theirs', async () => {
    const own = await photo(contractorId(), minutesAgo(2));
    const other = await photo(f.clientUser.id, minutesAgo(2));
    const res = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${contractor}`).expect(200);
    const byId = new Map((res.body.photos as Array<{ id: string; mine?: boolean }>).map((p) => [p.id, p]));
    expect(byId.get(own)?.mine).toBe(true);
    expect(byId.get(other)).toBeDefined();
    expect(byId.get(other)).not.toHaveProperty('mine');
  });
});
