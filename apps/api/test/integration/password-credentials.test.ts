import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

describe('password enrollment and reset (live PostgreSQL)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const codes = new Map<string, string>();

  beforeAll(async () => {
    t = await createTestApp({ capturePasswordCode: (email, code) => codes.set(email, code) });
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.orgMembership.createMany({
      data: [
        { orgId: f.orgA.id, userId: f.strangerUser.id, role: 'member' },
        { orgId: f.orgA.id, userId: f.memberUser.id, role: 'member' },
      ],
    });
  });

  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  async function setup(email: string) {
    const http = request(t.app.getHttpServer());
    const requested = await http.post('/auth/password/request').send({ email }).expect(201);
    const code = codes.get(email);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await http.post('/auth/password/verify').send({ requestId: requested.body.requestId, code }).expect(201);
    expect(verified.body).toEqual({ setupToken: expect.any(String), expiresInSeconds: 600 });
    expect(verified.body.token).toBeUndefined();
    return { requestId: requested.body.requestId as string, setupToken: verified.body.setupToken as string };
  }

  it('enrolls an invited active user, then permits routine password login', async () => {
    const email = f.memberUser.email!;
    const oldJwt = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const { setupToken } = await setup(email);
    const completed = await request(t.app.getHttpServer())
      .post('/auth/password/complete')
      .send({ setupToken, password: 'a long internal passphrase' })
      .expect(201);

    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id } });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.credentialVersion).toBe(1);
    expect(await bcrypt.compare('a long internal passphrase', user.passwordHash!)).toBe(true);
    expect(t.app.get(JwtService).verify(completed.body.token)).toMatchObject({ credentialVersion: 1 });

    await request(t.app.getHttpServer()).post('/auth/login').send({ email, password: 'a long internal passphrase' }).expect(201);
    await request(t.app.getHttpServer()).get('/me/memberships').set('Authorization', `Bearer ${oldJwt}`).expect(401);
  });

  it('allows exactly one concurrent reset completion and invalidates the prior password', async () => {
    const email = f.memberUser.email!;
    const { setupToken } = await setup(email);
    const complete = () => request(t.app.getHttpServer())
      .post('/auth/password/complete')
      .send({ setupToken, password: 'the replacement passphrase' });
    const results = await Promise.all([complete(), complete()]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 400]);
    await request(t.app.getHttpServer()).post('/auth/login').send({ email, password: 'a long internal passphrase' }).expect(401);
    await request(t.app.getHttpServer()).post('/auth/login').send({ email, password: 'the replacement passphrase' }).expect(201);
  });

  it('returns the generic public response but creates no challenge for an unknown or removed-only identity', async () => {
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
      data: { status: 'removed' },
    });
    try {
      for (const email of [f.memberUser.email!, 'unknown-password-user@test.local']) {
        const response = await request(t.app.getHttpServer()).post('/auth/password/request').send({ email }).expect(201);
        expect(response.body).toEqual({ accepted: true, requestId: expect.any(String) });
        expect(await t.prisma.passwordCredentialChallenge.findUnique({ where: { id: response.body.requestId } })).toBeNull();
      }
    } finally {
      await t.prisma.membership.update({
        where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
        data: { status: 'active' },
      });
    }
  });

  it('rechecks access inside completion and preserves an unused token after rollback', async () => {
    const email = f.memberUser.email!;
    const { setupToken } = await setup(email);
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
      data: { status: 'removed' },
    });
    try {
      await request(t.app.getHttpServer()).post('/auth/password/complete').send({ setupToken, password: 'another valid passphrase' }).expect(400);
      const unconsumed = await t.prisma.passwordCredentialChallenge.count({ where: { userId: f.memberUser.id, consumedAt: null } });
      expect(unconsumed).toBe(1);
    } finally {
      await t.prisma.membership.update({
        where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
        data: { status: 'active' },
      });
    }
  });

  it('shows credential state to team managers and org administrators', async () => {
    const ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const projectRoster = await request(t.app.getHttpServer())
      .get(`/projects/${f.projectA.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(projectRoster.body).toContainEqual(expect.objectContaining({
      userId: f.memberUser.id,
      credentialState: 'active',
    }));

    const orgRoster = await request(t.app.getHttpServer())
      .get(`/orgs/${f.orgA.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(orgRoster.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: f.ownerUser.id, credentialState: 'not_set' }),
      expect.objectContaining({ userId: f.strangerUser.id, credentialState: 'not_set' }),
    ]));
  });

  it('corrects an unverified org invitation, revokes old challenges and audits the actor', async () => {
    const ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    // The correction workflow only needs an outstanding challenge to revoke.
    // Insert it directly so this test does not consume the public endpoint's
    // deliberately tight five-requests-per-IP throttle budget.
    const requestId = randomUUID();
    await t.prisma.passwordCredentialChallenge.create({
      data: {
        id: requestId,
        userId: f.strangerUser.id,
        purpose: 'password_credential',
        otpHash: 'integration-only-placeholder',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const correctedEmail = `corrected-${f.strangerUser.id}@test.local`;
    await request(t.app.getHttpServer())
      .patch(`/orgs/${f.orgA.id}/members/${f.strangerUser.id}/invitation-email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: correctedEmail.toUpperCase() })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        userId: f.strangerUser.id,
        email: correctedEmail,
        credentialState: 'not_set',
      }));

    expect(await t.prisma.passwordCredentialChallenge.findUniqueOrThrow({ where: { id: requestId } }))
      .toMatchObject({ consumedAt: expect.any(Date) });
    expect(await t.prisma.securityAuditEvent.findFirstOrThrow({
      where: { action: 'auth.invitation_email_changed', targetUserId: f.strangerUser.id },
      orderBy: { createdAt: 'desc' },
    })).toMatchObject({ actorUserId: f.ownerUser.id, actorKind: 'administrator' });

    await request(t.app.getHttpServer())
      .patch(`/orgs/${f.orgA.id}/members/${f.otherUser.id}/invitation-email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'foreign@test.local' })
      .expect(404);
    await request(t.app.getHttpServer())
      .patch(`/orgs/${f.orgA.id}/members/${f.memberUser.id}/invitation-email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'cannot-change@test.local' })
      .expect(400);
  });

  it('serializes password completion against invitation-email correction', async () => {
    const ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const setupToken = `${randomUUID()}${randomUUID()}`;
    await t.prisma.passwordCredentialChallenge.create({
      data: {
        id: randomUUID(),
        userId: f.ownerUser.id,
        purpose: 'password_setup_or_reset',
        otpHash: 'integration-only-placeholder',
        expiresAt: new Date(Date.now() + 600_000),
        verifiedAt: new Date(),
        setupTokenHash: createHash('sha256').update(setupToken).digest('hex'),
        setupTokenExpiresAt: new Date(Date.now() + 600_000),
      },
    });

    expect(f.ownerUser.id).toMatch(/^[a-z0-9-]+$/);
    await t.prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_hold_password_update() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.75);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await t.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_hold_password_update
      BEFORE UPDATE OF "passwordHash" ON "User"
      FOR EACH ROW WHEN (NEW.id = '${f.ownerUser.id}')
      EXECUTE FUNCTION test_hold_password_update()
    `);

    try {
      const completionPromise = request(t.app.getHttpServer())
        .post('/auth/password/complete')
        .send({ setupToken, password: 'one serialized passphrase' })
        .then((response) => response);

      let passwordUpdateIsHeld = false;
      for (let attempt = 0; attempt < 200 && !passwordUpdateIsHeld; attempt += 1) {
        const [state] = await t.prisma.$queryRaw<Array<{ held: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event = 'PgSleep'
          ) AS held
        `;
        passwordUpdateIsHeld = state?.held ?? false;
        if (!passwordUpdateIsHeld) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(passwordUpdateIsHeld).toBe(true);

      const correctionPromise = request(t.app.getHttpServer())
        .patch(`/orgs/${f.orgA.id}/members/${f.ownerUser.id}/invitation-email`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `race-${f.ownerUser.id}@test.local` })
        .then((response) => response);

      const [completion, correction] = await Promise.all([completionPromise, correctionPromise]);
      expect(completion.status).toBe(201);
      expect(correction.status).toBe(400);
    } finally {
      await t.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_hold_password_update ON "User"');
      await t.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_hold_password_update()');
    }

    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    expect(owner.email).toBe(f.ownerUser.email);
    expect(owner.passwordHash).not.toBeNull();
    expect(owner.emailVerifiedAt).toBeInstanceOf(Date);
  });
});
