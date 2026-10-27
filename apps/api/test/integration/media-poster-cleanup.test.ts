import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';

/**
 * #995 — a video's still frame (`Media.posterStorageKey`, #990) is a second stored file on the video's row. A video that
 * is deleted takes its still frame with it, on the same terms as its own file: after the delete commits, and only on the
 * success path. Proven through the real route against PostgreSQL. Reproduce-first: on main only the clip is removed.
 */
describe("a deleted video's still frame is removed with it (live PG)", () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  let contractor: string;
  const contractorId = () => `${f.projectA.id}-poster-contractor`;
  const run = Math.random().toString(36).slice(2, 8);

  const http = () => request(t.app.getHttpServer());
  const del = (id: string, token: string) => http().delete(`/media/${id}`).set('Authorization', `Bearer ${token}`);
  const video = async (name: string, poster: string | null) =>
    (await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'video/mp4', sizeBytes: 3, uploadedBy: f.memberUser.id, durationSec: 12,
        storageKey: `site/${run}-${name}.mp4`, posterStorageKey: poster },
    })).id;
  const removed = () => vi.spyOn(t.app.get(StorageService), 'remove').mockResolvedValue(undefined);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.user.create({ data: { id: contractorId(), projectId: f.projectA.id, role: 'contractor', name: 'Ravi Patel', email: `${contractorId()}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractorId(), role: 'contractor', status: 'active' } });
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    contractor = t.issueProjectToken(contractorId(), f.projectA.id, 'contractor');
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: contractorId() } });
    await t?.prisma.user.deleteMany({ where: { id: contractorId() } });
    await f?.cleanup();
    await t?.close();
  });

  it('removes the clip, then its still frame, each only once the delete has committed', async () => {
    const id = await video('clip', `site/${run}-clip-poster.jpg`);
    const seen: Array<{ key: string; rowVisible: boolean }> = [];
    vi.spyOn(t.app.get(StorageService), 'remove').mockImplementation(async (key: string) => {
      // a read on the pool: inside the delete's interactive transaction this is another connection, so the row is
      // still visible to it until the delete commits
      const rows = await t.prisma.$queryRawUnsafe<unknown[]>('SELECT 1 FROM "Media" WHERE id = $1', id);
      seen.push({ key, rowVisible: rows.length > 0 });
    });
    await del(id, pmc).expect(200);
    expect(seen).toEqual([
      { key: `site/${run}-clip.mp4`, rowVisible: false },
      { key: `site/${run}-clip-poster.jpg`, rowVisible: false },
    ]);
  });

  it('a video with no still frame removes only its clip', async () => {
    const id = await video('bare', null);
    const remove = removed();
    await del(id, pmc).expect(200);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([`site/${run}-bare.mp4`]);
  });

  it('a refused delete keeps the row, the clip and the still frame', async () => {
    const id = await video('kept', `site/${run}-kept-poster.jpg`);
    const remove = removed();
    await del(id, contractor).expect(403);
    expect(await t.prisma.media.findUnique({ where: { id }, select: { posterStorageKey: true } })).toEqual({ posterStorageKey: `site/${run}-kept-poster.jpg` });
    expect(remove).not.toHaveBeenCalled();
  });

  it('a still frame that fails to delete never fails the committed delete', async () => {
    const id = await video('flaky', `site/${run}-flaky-poster.jpg`);
    const remove = vi.spyOn(t.app.get(StorageService), 'remove').mockRejectedValue(new Error('bucket unreachable'));
    await del(id, pmc).expect(200);
    expect(await t.prisma.media.findUnique({ where: { id } })).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
