import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos — each photo in the snapshot says who added it, their role on this project and when.
 * Proven through the real snapshot route against PostgreSQL. Reproduce-first: `by`, `byRole` and `at` are
 * absent on main.
 */
describe('site photos say who added them, in what role, and when (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let client: string;
  const contractorId = () => `${f.projectA.id}-who-contractor`;
  const removedId = () => `${f.projectA.id}-who-removed`;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const ids: Record<string, string> = {};
  const at = new Date('2026-10-19T09:30:00.000Z');

  const snapshot = (token: string) =>
    request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    for (const [id, name, status] of [[contractorId(), 'Ravi Patel', 'active'], [removedId(), 'Old Hand', 'removed']] as const) {
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'contractor', name, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role: 'contractor', status } });
    }
    const photo = async (key: string, uploadedBy: string) => {
      ids[key] = (await t.prisma.media.create({
        data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy, data: px, createdAt: at },
      })).id;
    };
    await photo('contractor', contractorId());
    await photo('removed', removedId());
    await photo('gone', 'no-such-user');
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: [contractorId(), removedId()] } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: [contractorId(), removedId()] } } });
    await f?.cleanup();
    await t?.close();
  });

  it('names the member, their role on the project and the time it was added', async () => {
    const res = await snapshot(client).expect(200);
    const byId = new Map((res.body.photos as Array<{ id: string; by?: string; byRole?: string; at: string }>).map((p) => [p.id, p]));
    expect(byId.get(ids.contractor!)).toMatchObject({ by: 'Ravi Patel', byRole: 'contractor', at: at.toISOString() });
  });

  it('keeps the name and role of a member since removed from the project', async () => {
    const res = await snapshot(client).expect(200);
    const p = (res.body.photos as Array<{ id: string; by?: string; byRole?: string }>).find((x) => x.id === ids.removed);
    expect(p).toMatchObject({ by: 'Old Hand', byRole: 'contractor' });
  });

  it('leaves out who when the account is gone, and still says when', async () => {
    const res = await snapshot(client).expect(200);
    const p = (res.body.photos as Array<{ id: string; by?: string; byRole?: string; at: string }>).find((x) => x.id === ids.gone);
    expect(p?.by).toBeUndefined();
    expect(p?.byRole).toBeUndefined();
    expect(p?.at).toBe(at.toISOString());
  });
});
