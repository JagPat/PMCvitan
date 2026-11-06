import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #1373: `POST /auth/switch` is identity-scoped. A person whose token's own project was lost (removed, re-roled,
 * archived) can still move to a project they hold; the target alone is checked, live (live PostgreSQL, the real guard).
 * The credential version is still checked, a project the person does not hold or an archived one is still refused,
 * and a worker device token is still refused.
 */
describe('#1373: /auth/switch from a lost project (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const archivedId = `it-sw-archived-${randomUUID().slice(0, 8)}`;
  const http = () => request(t.app.getHttpServer());
  const switchTo = (token: string, projectId: string) => http().post('/auth/switch').set('Authorization', `Bearer ${token}`).send({ projectId });
  const memberOn = (projectId: string) => ({ projectId_userId: { projectId, userId: f.memberUser.id } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // memberUser holds A (the fixture) and B (here) as PMC
    await t.prisma.membership.create({ data: { projectId: f.projectB.id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await t.prisma.project.create({
      data: {
        id: archivedId, orgId: f.orgB.id, name: 'Archived', short: 'Archived', descriptor: '', stage: 'Planning',
        siteCode: archivedId.toUpperCase().slice(0, 8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
        elapsedPct: 0, todayDay: 0, milestonePct: 0, archivedAt: new Date(),
      },
    });
    await t.prisma.membership.create({ data: { projectId: archivedId, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
  });

  afterAll(async () => {
    await t?.prisma.membership.deleteMany({ where: { projectId: archivedId } });
    await t?.prisma.project.deleteMany({ where: { id: archivedId } });
    await f?.cleanup();
    await t?.close();
  });

  /** memberUser removed from A for the length of `run` (a real removal), then restored */
  const whileRemovedFromA = async <T>(run: () => Promise<T>): Promise<T> => {
    await t.prisma.membership.update({ where: memberOn(f.projectA.id), data: { status: 'removed' } });
    try {
      return await run();
    } finally {
      await t.prisma.membership.update({ where: memberOn(f.projectA.id), data: { status: 'active' } });
    }
  };

  it('removed from the token\'s project: the token still switches to a project the person holds', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const res = await whileRemovedFromA(async () => {
      // the token's own project is lost: a project route refuses it
      expect((await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
      return switchTo(token, f.projectB.id);
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ projectId: f.projectB.id, role: 'pmc' });
    // the minted token works on B
    expect((await http().get(`/projects/${f.projectB.id}/snapshot`).set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
  });

  it('re-roled on the token\'s project: the token switches back into it in the new role', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'engineer'); // the row says pmc
    expect((await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    const res = await switchTo(token, f.projectA.id);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ projectId: f.projectA.id, role: 'pmc' });
  });

  it('removed: the token cannot switch back into the project it lost, nor into one the person never held', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const back = await whileRemovedFromA(() => switchTo(token, f.projectA.id));
    expect(back.status).toBe(403);
    expect(back.body.message).toBe('You are not a member of this project');
    const stranger = await switchTo(t.issueProjectToken(f.strangerUser.id, f.projectA.id), f.projectB.id);
    expect(stranger.status).toBe(403);
    expect(stranger.body.message).toBe('You are not a member of this project');
  });

  it('an archived target is refused, whatever the token\'s project', async () => {
    const res = await whileRemovedFromA(() => switchTo(t.issueProjectToken(f.memberUser.id, f.projectA.id), archivedId));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This project has been archived');
  });

  it('a credential version moved (a password reset) is still refused 401 before the switch', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const { credentialVersion } = await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id }, select: { credentialVersion: true } });
    await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { credentialVersion: credentialVersion + 1 } });
    try {
      const res = await switchTo(token, f.projectB.id);
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Session expired');
    } finally {
      await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { credentialVersion } });
    }
  });

  it('a worker device token is refused 403, as before', async () => {
    const token = t.app.get(JwtService).sign({ sub: `worker-${randomUUID()}`, role: 'worker', projectId: f.projectA.id, worker: true });
    const res = await switchTo(token, f.projectB.id);
    expect(res.status).toBe(403);
  });

  it('a person who still holds the token\'s project switches as before', async () => {
    const res = await switchTo(t.issueProjectToken(f.memberUser.id, f.projectA.id), f.projectB.id);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ projectId: f.projectB.id, role: 'pmc' });
  });
});
