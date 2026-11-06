import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PROJECT_ACCESS_CODES } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { NotificationsSeenService } from '../../src/snapshot/notifications-seen.service';

/**
 * #1373: the live project check's three "you no longer have this project" 403s carry a machine `code`, on a read and on
 * a command alike, with the status and the English message exactly as before (live PostgreSQL, the real guard). The
 * in-transaction re-checks of the same state (here the bell's seen mark, which re-reads both) throw the same coded
 * body. Every other 403 (a role the route does not allow, a token for another project) carries none, so the web can
 * tell a lost project from a refusal of one action by the code alone.
 */
describe('#1373: lost-project 403s carry a code (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const archivedId = `it-archived-${randomUUID().slice(0, 8)}`;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.project.create({
      data: {
        id: archivedId, orgId: f.orgB.id, name: 'Archived', short: 'Archived', descriptor: '', stage: 'Planning',
        siteCode: archivedId.toUpperCase().slice(0, 8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
        elapsedPct: 0, todayDay: 0, milestonePct: 0, archivedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await t?.prisma.project.deleteMany({ where: { id: archivedId } });
    await f?.cleanup();
    await t?.close();
  });

  /** `memberUser` removed from projectA for the length of `run` (a real removal, as project-access.test.ts does), then restored */
  const whileRemoved = async <T>(run: () => Promise<T>): Promise<T> => {
    const where = { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } };
    await t.prisma.membership.update({ where, data: { status: 'removed' } });
    try {
      return await run();
    } finally {
      await t.prisma.membership.update({ where, data: { status: 'active' } });
    }
  };

  /** a read and a command on `projectId` with `token`; the guard answers before the body is read */
  const both = (projectId: string, token: string) => Promise.all([
    http().get(`/projects/${projectId}/snapshot`).set('Authorization', `Bearer ${token}`),
    http().post(`/projects/${projectId}/decisions`).set('Authorization', `Bearer ${token}`).send({}),
  ]);

  const lost = [
    {
      name: 'archived', code: PROJECT_ACCESS_CODES.unavailable, message: 'Project is unavailable',
      ask: () => both(archivedId, t.issueProjectToken(f.otherUser.id, archivedId)),
    },
    {
      // the member's row is pmc; a token still naming another role is what a re-role leaves behind
      name: 're-roled', code: PROJECT_ACCESS_CODES.roleChanged, message: 'Project role changed; sign in again',
      ask: () => both(f.projectA.id, t.issueProjectToken(f.memberUser.id, f.projectA.id, 'engineer')),
    },
    {
      name: 'removed', code: PROJECT_ACCESS_CODES.accessRemoved, message: 'Project access has been removed',
      ask: () => whileRemoved(() => both(f.projectA.id, t.issueProjectToken(f.memberUser.id, f.projectA.id))),
    },
  ];

  it.each(lost)('$name: a read and a command answer 403 with the code, and the same message and shape as before', async ({ code, message, ask }) => {
    for (const res of await ask()) {
      expect(res.status).toBe(403);
      // exactly Nest's default 403 body, in its key order, plus the code
      expect(res.text).toBe(JSON.stringify({ message, error: 'Forbidden', statusCode: 403, code }));
    }
  });

  /** the body an in-transaction re-check threw, read as Nest would send it */
  const thrownBody = async (run: () => Promise<unknown>) => {
    const err = await run().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    return JSON.stringify((err as ForbiddenException).getResponse());
  };

  it('an in-transaction re-check codes an archived project: the seen mark past the guard', async () => {
    const seen = t.app.get(NotificationsSeenService);
    const user = { sub: f.otherUser.id, role: 'pmc' as const, projectId: archivedId };
    expect(await thrownBody(() => seen.markSeen(archivedId, user, []))).toBe(
      JSON.stringify({ message: 'Project is unavailable', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.unavailable }));
  });

  it('an in-transaction re-check codes a removal: the seen mark past the guard', async () => {
    const seen = t.app.get(NotificationsSeenService);
    const user = { sub: f.memberUser.id, role: 'pmc' as const, projectId: f.projectA.id };
    expect(await whileRemoved(() => thrownBody(() => seen.markSeen(f.projectA.id, user, [])))).toBe(
      JSON.stringify({ message: 'Project access has been removed', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.accessRemoved }));
  });

  it('the three codes are distinct', () => {
    expect(new Set(Object.values(PROJECT_ACCESS_CODES)).size).toBe(3);
  });

  it('a refusal of one action carries no code: a role the route does not allow', async () => {
    const res = await http().post(`/projects/${f.projectA.id}/decisions`)
      .set('Authorization', `Bearer ${t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client')}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toBe('Your role is not permitted to perform this action');
  });

  it('a token for another project carries no code (a routing fault, not a lost project)', async () => {
    const res = await http().get(`/projects/${f.projectB.id}/snapshot`)
      .set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
  });

  it('a member who still has the project reads it', async () => {
    const res = await http().get(`/projects/${f.projectA.id}/snapshot`)
      .set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id)}`);
    expect(res.status).toBe(200);
  });
});
