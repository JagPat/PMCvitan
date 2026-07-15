import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
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
});
