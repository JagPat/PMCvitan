import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Live project access, proven against the REAL app + REAL PostgreSQL (Phase 0
 * Task 4): an unexpired token alone is not continuing authority — membership
 * removal, role change and project archive must revoke access immediately.
 */
describe('live project access (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  it('allows an active member to read their project snapshot', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await request(t.app.getHttpServer())
      .get(`/projects/${f.projectA.id}/snapshot`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a previously issued token after membership removal', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
      data: { status: 'removed' },
    });
    try {
      await request(t.app.getHttpServer())
        .get(`/projects/${f.projectA.id}/snapshot`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await t.prisma.membership.update({
        where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
        data: { status: 'active' },
      });
    }
  });

  it('rejects a previously issued token after a role change (must sign in again)', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
      data: { role: 'contractor' },
    });
    try {
      await request(t.app.getHttpServer())
        .get(`/projects/${f.projectA.id}/snapshot`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await t.prisma.membership.update({
        where: { projectId_userId: { projectId: f.projectA.id, userId: f.memberUser.id } },
        data: { role: 'pmc' },
      });
    }
  });

  it('rejects access to an archived project', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: new Date() } });
    try {
      await request(t.app.getHttpServer())
        .get(`/projects/${f.projectA.id}/snapshot`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  });

  it('allows an org owner to operate an active project in the same org as pmc (no membership row)', async () => {
    const token = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    await request(t.app.getHttpServer())
      .get(`/projects/${f.projectA.id}/snapshot`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a user with no membership anywhere, even with a well-formed token', async () => {
    const token = t.issueProjectToken(f.strangerUser.id, f.projectA.id);
    await request(t.app.getHttpServer())
      .get(`/projects/${f.projectA.id}/snapshot`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('tenant isolation: a project-B member’s token cannot read project A (and vice versa)', async () => {
    const tokenB = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    await request(t.app.getHttpServer())
      .get(`/projects/${f.projectA.id}/snapshot`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    const tokenA = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await request(t.app.getHttpServer())
      .get(`/projects/${f.projectB.id}/snapshot`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);
  });
});
