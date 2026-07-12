import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Codex gate finding 2: routes WITHOUT a `:projectId` param (the global-scoped
 * deletes) must still be LIVE-authorized against the token's project — a
 * removed member's unexpired token must not retain destructive access.
 */
describe('live authorization on global-scoped routes (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await t.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.drawing.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  it('a removed member loses DELETE /media/:id and DELETE /drawings/:id on the next request', async () => {
    const mkMedia = (id: string) =>
      t.prisma.media.create({ data: { id, projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('x'), sizeBytes: 1, uploadedBy: 'pmc' } });
    const mkDrawing = (id: string, number: string) =>
      t.prisma.drawing.create({ data: { id, projectId: f.projectA.id, number, title: 'T', discipline: 'architectural', publishedAt: new Date() } });

    await mkMedia('it-authz-media-1');
    await mkMedia('it-authz-media-2');
    await mkDrawing('it-authz-drawing-1', 'GA-901');
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const http = () => request(t.app.getHttpServer());

    // control: an ACTIVE member's token deletes fine
    await http().delete('/media/it-authz-media-1').set('Authorization', `Bearer ${token}`).expect(200);

    // the membership is removed — the SAME unexpired token must lose access LIVE
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: f.memberUser.id } });

    await http().delete('/media/it-authz-media-2').set('Authorization', `Bearer ${token}`).expect(403);
    await http().delete('/drawings/it-authz-drawing-1').set('Authorization', `Bearer ${token}`).expect(403);

    // and nothing was deleted by the refused calls
    expect(await t.prisma.media.findUnique({ where: { id: 'it-authz-media-2' } })).not.toBeNull();
    expect(await t.prisma.drawing.findUnique({ where: { id: 'it-authz-drawing-1' } })).not.toBeNull();

    // identity-level discovery stays available (live-membership-derived, leaks nothing):
    // the revoked user can still see where they DO belong, to recover by re-signing-in
    await http().get('/me/memberships').set('Authorization', `Bearer ${token}`).expect(200);
  });
});
