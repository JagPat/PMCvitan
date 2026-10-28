import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';
import { base64 } from '../unit-support/voice-files';
import { clipWebmTimed } from '../unit-support/video-files';

/**
 * #995 V1b — a video clip's still frame. The phone that recorded a clip on a site visit adds one JPEG for it, by its own
 * request after the clip; the first one stays, and the visit's file list carries a signed link to it of its own kind.
 * Proven through the real routes against PostgreSQL, with the bucket's calls stood in for (the dev stub has no room
 * for a second file on a row).
 */
describe('#995 V1b — a video clip\'s still frame (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let pmcToken: string;
  let engineerToken: string;
  let otherToken: string;
  let visitId: string;
  let storage: StorageService;
  let put: MockInstance;
  let remove: MockInstance;
  const still = (name: string) => readFileSync(join(__dirname, '..', 'unit-support', 'recordings', name));
  const big = still('chromium-153-still-640x360.jpg');
  const jpeg = big.toString('base64');
  const tiny = still('chromium-153-still-1x1.jpg').toString('base64');

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const clip = async (token = pmcToken) => {
    const res = await http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`)
      .send({ kind: 'visit', mime: 'video/webm', data: base64(clipWebmTimed(12)), durationSec: 12, siteVisit: { visitId } });
    expect(res.status, res.text).toBe(201);
    return res.body as { id: string; url: string };
  };
  const poster = (mediaId: string, token = pmcToken, body: Record<string, unknown> = {}, projectId = f.projectA.id) =>
    http().post(`/projects/${projectId}/media/${mediaId}/poster`).set('Authorization', `Bearer ${token}`).send({ mime: 'image/jpeg', data: jpeg, ...body });
  const files = async (token = pmcToken) => {
    const list = await http().get(visits()).set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    return (list.body as Array<{ id: string; files: Array<{ mediaId: string; posterUrl: string | null }> }>).find((v) => v.id === visitId)!.files;
  };
  const row = (id: string) => t.prisma.media.findUniqueOrThrow({ where: { id }, select: { posterStorageKey: true } });
  const events = (id: string) => t.prisma.domainEvent.count({ where: { entityId: id } });
  const putKeys = () => put.mock.calls.filter((c) => c[2] === 'image/jpeg').map((c) => c[0] as string);
  const direct = async (data: { projectId?: string; kind: string; mime: string; durationSec?: number | null }) =>
    (await t.prisma.media.create({
      data: { projectId: f.projectA.id, sizeBytes: 3, uploadedBy: f.memberUser.id, storageKey: `site/${run}-${randomUUID()}`, ...data },
    })).id;

  beforeAll(async () => {
    t = await createTestApp();
    storage = t.app.get(StorageService);
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    const engineer = `poster-engineer-${run}`;
    extra.push(engineer);
    await t.prisma.user.create({ data: { id: engineer, projectId: f.projectA.id, role: 'engineer', name: 'Sam (engineer)', email: `${engineer}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engineer, role: 'engineer', status: 'active' } });
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engineerToken = t.issueProjectToken(engineer, f.projectA.id, 'engineer');
    otherToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    visitId = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: visitId, claimedAt: new Date(Date.now() - 30 * 60_000).toISOString() })).status).toBe(201);
  });

  beforeEach(() => {
    vi.spyOn(storage, 'configured', 'get').mockReturnValue(true);
    put = vi.spyOn(storage, 'put').mockImplementation(async (key: string) => ({ url: `https://bucket.test/${key}` }));
    remove = vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
    vi.spyOn(storage, 'presignGet').mockImplementation(async (key: string) => `https://bucket.test/${key}?signed=1`);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extra } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  it('the recorder adds a still frame: stored once as a JPEG, recording no event, listed with its own link, served by it', async () => {
    const { id } = await clip();
    const bare = await clip();
    expect((await files()).find((x) => x.mediaId === id)!.posterUrl).toBeNull();
    const res = await poster(id);
    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.posterUrl).toMatch(new RegExp(`^/media/${id}/poster\\?t=`));
    expect(putKeys()).toHaveLength(1);
    const [key] = putKeys();
    expect(key).toMatch(new RegExp(`^${f.projectA.id}/visit/.+\\.jpg$`));
    expect(put.mock.calls.find((c) => c[0] === key)![1]).toEqual(big);
    expect(await row(id)).toEqual({ posterStorageKey: key });
    expect(await events(id)).toBe(1); // the clip's own upload only
    const listed = await files();
    expect(listed.find((x) => x.mediaId === id)!.posterUrl).toMatch(new RegExp(`^/media/${id}/poster\\?t=`));
    expect(listed.find((x) => x.mediaId === bare.id)!.posterUrl).toBeNull();
    const served = await http().get(res.body.posterUrl);
    expect(served.status).toBe(302);
    expect(served.headers.location).toBe(`https://bucket.test/${key}?signed=1`);
    expect(remove).not.toHaveBeenCalled();
  });

  it('a replay, or a later frame, gets the stored frame\'s link, and stores nothing', async () => {
    const { id } = await clip();
    expect((await poster(id)).status).toBe(200);
    const [key] = putKeys();
    for (const data of [jpeg, tiny]) {
      const again = await poster(id, pmcToken, { data });
      expect(again.status, again.text).toBe(200);
      expect(again.body.posterUrl).toMatch(new RegExp(`^/media/${id}/poster\\?t=`));
    }
    expect(putKeys()).toEqual([key]);
    expect(await row(id)).toEqual({ posterStorageKey: key });
    expect(await events(id)).toBe(1);
  });

  it("the frame's link is minted after the bytes are stored, so a slow PUT does not hand back a link already expired (Codex P2 on #1166)", async () => {
    const signed = t.app.get((await import('../../src/media/signed-url.service')).SignedUrlService);
    const ttl = signed.cacheMaxAge();
    let now = 1_000_000_000;
    // the signer's clock moves only when the PUT runs: a stand-in for a PUT or a lock wait longer than the link lives
    vi.spyOn(signed as unknown as { nowSec: () => number }, 'nowSec').mockImplementation(() => now);
    put.mockImplementation(async (key: string) => {
      now += ttl + 60;
      return { url: `https://bucket.test/${key}` };
    });
    const { id } = await clip();
    const res = await poster(id);
    expect(res.status, res.text).toBe(200);
    expect((await http().get(res.body.posterUrl)).status).toBe(302);
    // a replay mints at its own return too
    now += ttl + 60;
    const again = await poster(id);
    expect(again.status, again.text).toBe(200);
    expect((await http().get(again.body.posterUrl)).status).toBe(302);
  });

  it('two frames sent at once: one is kept, the other\'s object is removed once no clip names it', async () => {
    const { id } = await clip();
    // both pass the early read before either takes the row: the row is held until both have stored their bytes
    let stored = 0;
    let release!: () => void;
    const bothStored = new Promise<void>((resolve) => (release = resolve));
    put.mockImplementation(async (key: string) => {
      if (++stored === 2) release();
      return { url: `https://bucket.test/${key}` };
    });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const lock = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Media" WHERE id = ${id} FOR UPDATE`;
      holding();
      await bothStored;
    }, { timeout: 30_000 });
    await held;
    const [a, b] = await Promise.all([poster(id), poster(id, pmcToken, { data: tiny })]);
    await lock;
    expect([a.status, b.status]).toEqual([200, 200]);
    const keys = putKeys();
    expect(keys).toHaveLength(2);
    const { posterStorageKey } = await row(id);
    expect(keys).toContain(posterStorageKey);
    expect(remove.mock.calls.map((c) => c[0])).toEqual(keys.filter((k) => k !== posterStorageKey));
    expect(await events(id)).toBe(1);
  });

  it('judged again under the clip\'s row lock: what changed while the bytes were stored decides, and the unused object goes', async () => {
    // the uploader is never changed by any route; a direct write while the bytes are stored stands in for an answer
    // that moved between the early read and the lock
    const moved = await clip();
    put.mockImplementation(async (key: string, _bytes: Buffer, mime: string) => {
      if (mime === 'image/jpeg') await t.prisma.$executeRaw`UPDATE "Media" SET "uploadedBy" = ${f.otherUser.id} WHERE id = ${moved.id}`;
      return { url: `https://bucket.test/${key}` };
    });
    expect((await poster(moved.id)).status).toBe(403);
    expect(await row(moved.id)).toEqual({ posterStorageKey: null });
    expect(remove.mock.calls.map((c) => c[0])).toEqual(putKeys());
  });

  it('a clip gone while the bytes were stored is not found (404), and the object is removed', async () => {
    // a visit's clip is never deleted (its visit keeps it), so an unlinked visit-kind video stands in
    const id = await direct({ kind: 'visit', mime: 'video/webm', durationSec: 12 });
    put.mockImplementation(async (key: string, _bytes: Buffer, mime: string) => {
      if (mime === 'image/jpeg') await t.prisma.$executeRaw`DELETE FROM "Media" WHERE id = ${id}`;
      return { url: `https://bucket.test/${key}` };
    });
    expect((await poster(id)).status).toBe(404);
    expect(putKeys()).toHaveLength(1);
    expect(remove.mock.calls.map((c) => c[0])).toEqual(putKeys());
  });

  it('a project archived, or a membership ended, while the bytes were stored refuses the frame (403) and removes the object', async () => {
    for (const [change, undo] of [
      [(id: string) => t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = now() WHERE id = ${id}`,
        (id: string) => t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = NULL WHERE id = ${id}`],
      [(id: string) => t.prisma.$executeRaw`UPDATE "Membership" SET status = 'removed' WHERE "projectId" = ${id} AND "userId" = ${f.memberUser.id}`,
        (id: string) => t.prisma.$executeRaw`UPDATE "Membership" SET status = 'active' WHERE "projectId" = ${id} AND "userId" = ${f.memberUser.id}`],
    ] as const) {
      const { id } = await clip();
      put.mockClear();
      remove.mockClear();
      put.mockImplementation(async (key: string, _bytes: Buffer, mime: string) => {
        if (mime === 'image/jpeg') await change(f.projectA.id);
        return { url: `https://bucket.test/${key}` };
      });
      try {
        const res = await poster(id);
        expect(res.status, res.text).toBe(403);
      } finally {
        await undo(f.projectA.id);
      }
      expect(await row(id)).toEqual({ posterStorageKey: null });
      expect(putKeys()).toHaveLength(1);
      expect(remove.mock.calls.map((c) => c[0])).toEqual(putKeys());
    }
  });

  it('a PUT that fails may still have stored the object: it is removed, and nothing is set', async () => {
    const { id } = await clip();
    put.mockImplementation(async (key: string, _bytes: Buffer, mime: string) => {
      if (mime === 'image/jpeg') throw new Error('the bucket\'s reply was lost');
      return { url: `https://bucket.test/${key}` };
    });
    expect((await poster(id)).status).toBe(500);
    const keys = put.mock.calls.filter((c) => c[2] === 'image/jpeg').map((c) => c[0]);
    expect(keys).toHaveLength(1);
    expect(remove.mock.calls.map((c) => c[0])).toEqual(keys);
    expect(await row(id)).toEqual({ posterStorageKey: null });
  });

  it('only the member who recorded the clip may add its frame: another member is refused before anything is stored', async () => {
    const { id } = await clip();
    const res = await poster(id, engineerToken);
    expect(res.status, res.text).toBe(403);
    expect(putKeys()).toEqual([]);
    expect(await row(id)).toEqual({ posterStorageKey: null });
  });

  it('a frame goes only on a video on a site visit: a photo, a voice note or a video elsewhere is refused (400)', async () => {
    const targets = [
      await direct({ kind: 'visit', mime: 'image/jpeg' }),
      await direct({ kind: 'visit', mime: 'audio/webm', durationSec: 10 }),
      await direct({ kind: 'progress', mime: 'video/mp4', durationSec: 10 }),
    ];
    for (const id of targets) {
      const res = await poster(id);
      expect(res.status, res.text).toBe(400);
    }
    expect(putKeys()).toEqual([]);
  });

  it('a clip in another project, or none, is not found (404), and nothing is stored', async () => {
    const { id } = await clip();
    expect((await poster(id, otherToken, {}, f.projectB.id)).status).toBe(404);
    expect((await poster(randomUUID())).status).toBe(404);
    expect(putKeys()).toEqual([]);
    expect(await row(id)).toEqual({ posterStorageKey: null });
  });

  it('only a still JPEG the reader admits is stored: Exif, another type or other bytes are refused (400)', async () => {
    const { id } = await clip();
    const exif = Buffer.concat([big.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 8]), Buffer.from('Exif\0\0', 'latin1'), big.subarray(2)]);
    for (const body of [
      { data: exif.toString('base64') },
      { mime: 'image/png' },
      { data: Buffer.from('not a jpeg').toString('base64') },
      { data: 'A'.repeat(300_004) }, // past the cap
      { data: jpeg, extra: 1 }, // a field the contract does not name
    ]) {
      const res = await poster(id, pmcToken, body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
    }
    expect(putKeys()).toEqual([]);
    expect(await row(id)).toEqual({ posterStorageKey: null });
  });

  it('a server with no bucket keeps no frame (409), and stores nothing', async () => {
    const { id } = await clip();
    vi.spyOn(storage, 'configured', 'get').mockReturnValue(false);
    expect((await poster(id)).status).toBe(409);
    expect(putKeys()).toEqual([]);
    expect(await row(id)).toEqual({ posterStorageKey: null });
  });

  it('a clip\'s link does not open its frame, nor the frame\'s link the clip', async () => {
    const { id, url } = await clip();
    const res = await poster(id);
    expect(res.status).toBe(200);
    const clipToken = new URL(url, 'http://x').searchParams.get('t');
    const frameToken = new URL(res.body.posterUrl, 'http://x').searchParams.get('t');
    expect((await http().get(`/media/${id}/poster?t=${clipToken}`)).status).toBe(403);
    expect((await http().get(`/media/${id}?t=${frameToken}`)).status).toBe(403);
    expect((await http().get(`/media/${id}/poster`)).status).toBe(403);
  });

  it('a clip with no frame answers its frame link with not found', async () => {
    const { id } = await clip();
    const token = t.app.get((await import('../../src/media/signed-url.service')).SignedUrlService).sign('poster', id);
    expect((await http().get(`/media/${id}/poster?t=${token}`)).status).toBe(404);
  });
});
