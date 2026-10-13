import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #811 (Board decision 2026-10-13) — a project-scoped user opens in the project they last switched into. The
 * stamp only CHOOSES among projects the access rule already grants: a removed membership, an archived project or
 * a project the user never held falls back to the existing landing, and the role always comes from the rule.
 */
describe('sign-in lands on the last project switched into (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let homeId: string;
  let secondId: string;
  let foreignId: string;
  const userId = `it-landing-${Date.now()}`;
  const email = `${userId}@test.local`;
  const password = 'landing-secret';

  const http = () => request(t.app.getHttpServer());
  const login = () => http().post('/auth/login').send({ email, password });
  const stamp = async () => (await t.prisma.user.findUniqueOrThrow({ where: { id: userId } })).lastProjectId;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    homeId = f.projectA.id;
    // a second site in the same org, where the contractor holds an engineer seat
    secondId = `${homeId}-second`;
    await t.prisma.project.create({
      data: {
        id: secondId, orgId: f.projectA.orgId, name: 'Second site', short: 'Second', descriptor: '', stage: 'Planning',
        siteCode: 'SECOND', projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
      },
    });
    foreignId = f.projectB.id;
    await t.prisma.user.create({
      data: { id: userId, projectId: homeId, role: 'contractor', name: 'Landing Contractor', email, passwordHash: bcrypt.hashSync(password, 4) },
    });
    await t.prisma.membership.create({ data: { projectId: homeId, userId, role: 'contractor', status: 'active' } });
    await t.prisma.membership.create({ data: { projectId: secondId, userId, role: 'engineer', status: 'active' } });
  });

  afterAll(async () => {
    await t?.prisma.membership.deleteMany({ where: { userId } });
    await t?.prisma.user.deleteMany({ where: { id: userId } });
    await t?.prisma.project.deleteMany({ where: { id: secondId } });
    await f?.cleanup();
    await t?.close();
  });

  it('lands on the home project before any switch, and a switch records the project it entered', async () => {
    const first = await login().expect(201);
    expect(first.body).toMatchObject({ projectId: homeId, role: 'contractor' });
    expect(await stamp()).toBeNull();

    await http().post('/auth/switch').set('Authorization', `Bearer ${first.body.token}`).send({ projectId: secondId }).expect(201);
    expect(await stamp()).toBe(secondId);

    // the next sign-in opens the second site, with the role the membership grants THERE
    const again = await login().expect(201);
    expect(again.body).toMatchObject({ projectId: secondId, role: 'engineer' });
  });

  it('a refused switch records nothing', async () => {
    const session = await login().expect(201);
    await http().post('/auth/switch').set('Authorization', `Bearer ${session.body.token}`).send({ projectId: foreignId }).expect(403);
    expect(await stamp()).toBe(secondId);
  });

  it('a removed membership on the last project falls back to the home project', async () => {
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: secondId, userId } }, data: { status: 'removed' } });
    try {
      expect((await login().expect(201)).body).toMatchObject({ projectId: homeId, role: 'contractor' });
    } finally {
      await t.prisma.membership.update({ where: { projectId_userId: { projectId: secondId, userId } }, data: { status: 'active' } });
    }
  });

  it('an archived last project falls back to the home project', async () => {
    await t.prisma.project.update({ where: { id: secondId }, data: { archivedAt: new Date() } });
    try {
      expect((await login().expect(201)).body).toMatchObject({ projectId: homeId, role: 'contractor' });
    } finally {
      await t.prisma.project.update({ where: { id: secondId }, data: { archivedAt: null } });
    }
  });

  it('a stamp naming a project the user never held grants nothing', async () => {
    await t.prisma.user.update({ where: { id: userId }, data: { lastProjectId: foreignId } });
    expect((await login().expect(201)).body).toMatchObject({ projectId: homeId, role: 'contractor' });
    await t.prisma.user.update({ where: { id: userId }, data: { lastProjectId: 'no-such-project' } });
    expect((await login().expect(201)).body).toMatchObject({ projectId: homeId, role: 'contractor' });
  });
});
