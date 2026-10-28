import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { StorageService } from '../../src/media/storage.service';
import { SignedUrlService } from '../../src/media/signed-url.service';

/**
 * #995 nosniff residual — every answer of the three stored-file routes (a photo, voice note or clip; a clip's still
 * frame; a drawing revision) says `X-Content-Type-Options: nosniff`, errors and redirects included, so a browser
 * takes a served file as its checked type and never as a page. Proven through the real routes on PostgreSQL, in
 * dev-stub mode (bytes from the row) and with the bucket's presign stood in for (a 302).
 */
describe('#995 — stored files are served with nosniff (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let signed: SignedUrlService;
  let storage: StorageService;
  const run = randomUUID().slice(0, 8);
  const media: string[] = [];
  const drawings: string[] = [];

  const http = () => request(t.app.getHttpServer());
  const nosniff = (res: request.Response) => expect(res.headers['x-content-type-options']).toBe('nosniff');
  const row = async (data: { kind: string; mime: string; data?: Buffer; storageKey?: string; posterStorageKey?: string }) => {
    const { id } = await t.prisma.media.create({ data: { projectId: f.projectA.id, sizeBytes: 3, uploadedBy: f.memberUser.id, ...data } });
    media.push(id);
    return id;
  };
  const bucket = () => {
    vi.spyOn(storage, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(storage, 'presignGet').mockImplementation(async (key: string) => `https://bucket.test/${key}?signed=1`);
  };

  beforeAll(async () => {
    t = await createTestApp();
    signed = t.app.get(SignedUrlService);
    storage = t.app.get(StorageService);
    f = await createTwoProjectFixture(t.prisma);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (t) {
      await t.prisma.media.deleteMany({ where: { id: { in: media } } });
      await t.prisma.drawingRevision.deleteMany({ where: { drawingId: { in: drawings } } });
      await t.prisma.drawing.deleteMany({ where: { id: { in: drawings } } });
      await f?.cleanup();
      await t.close();
    }
  });

  it('a file served from the row: its checked type, and nosniff', async () => {
    const id = await row({ kind: 'progress', mime: 'image/png', data: Buffer.from('png') });
    const res = await http().get(`/media/${id}?t=${signed.sign('media', id)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    nosniff(res);
  });

  it('a file in the bucket: the 302 says nosniff too', async () => {
    bucket();
    const id = await row({ kind: 'visit', mime: 'video/webm', storageKey: `${f.projectA.id}/visit/${run}.webm` });
    const res = await http().get(`/media/${id}?t=${signed.sign('media', id)}`);
    expect(res.status).toBe(302);
    nosniff(res);
  });

  it('a refused or missing file still says nosniff', async () => {
    const id = await row({ kind: 'progress', mime: 'image/png', data: Buffer.from('png') });
    const refused = await http().get(`/media/${id}?t=${signed.sign('poster', id)}`);
    expect(refused.status).toBe(403);
    nosniff(refused);
    const missing = await http().get(`/media/${run}-gone?t=${signed.sign('media', `${run}-gone`)}`);
    expect(missing.status).toBe(404);
    nosniff(missing);
  });

  it('a clip\'s still frame: its 302, a refusal and a clip with none all say nosniff', async () => {
    bucket();
    const id = await row({ kind: 'visit', mime: 'video/webm', storageKey: `${f.projectA.id}/visit/${run}-c.webm`, posterStorageKey: `${f.projectA.id}/visit/${run}-p.jpg` });
    const served = await http().get(`/media/${id}/poster?t=${signed.sign('poster', id)}`);
    expect(served.status).toBe(302);
    nosniff(served);
    const refused = await http().get(`/media/${id}/poster?t=${signed.sign('media', id)}`);
    expect(refused.status).toBe(403);
    nosniff(refused);
    const bare = await row({ kind: 'visit', mime: 'video/webm', storageKey: `${f.projectA.id}/visit/${run}-b.webm` });
    const none = await http().get(`/media/${bare}/poster?t=${signed.sign('poster', bare)}`);
    expect(none.status).toBe(404);
    nosniff(none);
  });

  it('a drawing revision: served from the row, from the bucket, or refused, says nosniff', async () => {
    const d = await t.prisma.drawing.create({ data: { projectId: f.projectA.id, number: `N-${run}`, title: 'nosniff', discipline: 'architectural', publishedAt: new Date(), authorId: f.memberUser.id } });
    drawings.push(d.id);
    const rev = (r: string, data: { data?: Buffer; storageKey?: string }) => t.prisma.drawingRevision.create({
      data: { projectId: f.projectA.id, drawingId: d.id, rev: r, status: 'for_review', mime: 'application/pdf', sizeBytes: 1, issuedBy: 'PMC', issuedAt: '01 Jun 2026', ...data },
    });
    const inline = await rev('A', { data: Buffer.from('%PDF') });
    const res = await http().get(`/drawings/rev/${inline.id}?t=${signed.sign('drawing', inline.id)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    nosniff(res);
    const refused = await http().get(`/drawings/rev/${inline.id}?t=${signed.sign('media', inline.id)}`);
    expect(refused.status).toBe(403);
    nosniff(refused);
    bucket();
    const stored = await rev('B', { storageKey: `${f.projectA.id}/drawings/${run}.pdf` });
    const redirect = await http().get(`/drawings/rev/${stored.id}?t=${signed.sign('drawing', stored.id)}`);
    expect(redirect.status).toBe(302);
    nosniff(redirect);
  });
});
