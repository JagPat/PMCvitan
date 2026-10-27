import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';
import { base64, mp4File, webmCluster, webmInfo, webmTimed } from '../unit-support/voice-files';
import { clipMp4, clipWebm, clipWebmTimed, pictureBlock, pictureTrack } from '../unit-support/video-files';

/**
 * Stage 1 video on site visits (#995; Jagrut's media plan, 19 Oct 2026: markup, then voice, then video): a clip of up
 * to a minute is uploaded as a file on a visit, by the people who may add files to it, on a voice note's terms. WebM and
 * MP4 are accepted, each only when its bytes are a video in that container, and the length stored is the file's own.
 * Proven through the real routes against PostgreSQL.
 */
describe('Stage 1 video — a clip on a site visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let pmcToken: string;
  let engineerToken: string;
  let visitId: string;
  // every refusal is answered before file storage is written: a refused clip leaves no bytes in the bucket
  let put: MockInstance;
  // a structurally valid clip (test/unit-support/video-files.ts): 42 s of WebM, by its Info Duration
  const webm = base64(clipWebmTimed(42));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const recording = (name: string) => readFileSync(join(__dirname, '..', 'unit-support', 'recordings', name)).toString('base64');
  /** a clip's MP4 whose movie header says `seconds` */
  const mp4Timed = (seconds: number) => {
    const out = clipMp4();
    out.writeUInt32BE(1000 * seconds, out.indexOf(Buffer.from('mvhd')) + 4 + 16);
    return base64(out);
  };

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send(body);
  const clip = (token: string, body: Record<string, unknown> = {}) =>
    upload(token, { kind: 'visit', mime: 'video/webm', data: webm, durationSec: 42, siteVisit: { visitId, note: 'Slab pour' }, ...body });
  const stored = async (res: request.Response) => {
    expect(res.status, res.text).toBe(201);
    return (await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } })).durationSec;
  };

  beforeAll(async () => {
    t = await createTestApp();
    put = vi.spyOn(t.app.get(StorageService), 'put');
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    const engineer = `video-engineer-${run}`;
    extra.push(engineer);
    await t.prisma.user.create({ data: { id: engineer, projectId: f.projectA.id, role: 'engineer', name: 'Sam (engineer)', email: `${engineer}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engineer, role: 'engineer', status: 'active' } });
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engineerToken = t.issueProjectToken(engineer, f.projectA.id, 'engineer');
    visitId = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: visitId, claimedAt: new Date(Date.now() - 30 * 60_000).toISOString() })).status).toBe(201);
  });

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

  it('the visitor adds a clip with its length; it is a file on the visit, served as the video it is, its length read back', async () => {
    const key = `video-first-${run}`;
    put.mockClear();
    const res = await clip(pmcToken, { clientKey: key });
    expect(res.status, res.text).toBe(201);
    expect(put).toHaveBeenCalledTimes(1);
    // the same clientKey again, even with other bytes, is the same row and stores nothing more
    const again = await clip(pmcToken, { clientKey: key, data: base64(clipWebmTimed(10)), durationSec: 10 });
    expect(again.body.id).toBe(res.body.id);
    expect(put).toHaveBeenCalledTimes(1);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ kind: 'visit', mime: 'video/webm', durationSec: 42, posterStorageKey: null });
    expect(row.storageKey).toMatch(/\.webm$/);
    expect(await t.prisma.siteVisitMedia.findUniqueOrThrow({ where: { mediaId: res.body.id } })).toMatchObject({ visitId, note: 'Slab pour' });
    const url = new URL(res.body.url, 'http://x');
    const served = await http().get(url.pathname + url.search);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/^video\/webm/);
    const list = await http().get(visits()).set('Authorization', `Bearer ${pmcToken}`);
    expect(list.status).toBe(200);
    const files = (list.body as Array<{ id: string; files: Array<{ mediaId: string; mime: string; durationSec: number | null }> }>)
      .find((v) => v.id === visitId)!.files;
    expect(files.find((x) => x.mediaId === res.body.id)).toMatchObject({ mime: 'video/webm', durationSec: 42 });
    // an MP4 clip is stored as .mp4, and one with no sound is a clip too
    const mp4 = await clip(pmcToken, { mime: 'video/mp4', data: mp4Timed(30), durationSec: 30 });
    expect(await stored(mp4)).toBe(30);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: mp4.body.id } })).storageKey).toMatch(/\.mp4$/);
    const silent = clipWebm({ tracks: [pictureTrack()], clusters: [webmCluster([pictureBlock()])], info: webmInfo(5_000) });
    expect(await stored(await clip(pmcToken, { data: base64(silent), durationSec: 5 }))).toBe(5);
  });

  it('real camera recordings from Chromium 153\'s MediaRecorder, WebM and MP4, are stored at their own 2 s', async () => {
    for (const [mime, name] of [
      ['video/webm', 'chromium-153-vp8-opus.webm'], ['video/webm', 'chromium-153-vp9.webm'],
      ['video/mp4', 'chromium-153-avc1-opus.mp4'], ['video/mp4', 'chromium-153-vp9-opus.mp4'],
    ] as const) {
      expect(await stored(await clip(pmcToken, { mime, data: recording(name), durationSec: 2 })), name).toBe(2);
    }
  });

  it('a clip\'s length is read from the file: at most a minute, rounded, and a length the upload also gives must agree', async () => {
    expect(await stored(await clip(pmcToken, { durationSec: undefined }))).toBe(42);
    expect(await stored(await clip(pmcToken, { durationSec: 44 }))).toBe(42); // within two seconds: the file's
    expect(await stored(await clip(pmcToken, { data: base64(clipWebmTimed(60)), durationSec: undefined }))).toBe(60);
    expect(await stored(await clip(pmcToken, { data: base64(clipWebmTimed(60.4)), durationSec: 60 }))).toBe(60);
    expect(await stored(await clip(pmcToken, { data: base64(clipWebmTimed(0.5)), durationSec: undefined }))).toBe(1);
    const key = `video-length-${run}`;
    const refused = [
      { durationSec: 1 }, { durationSec: 45 }, // the upload says other than the file
      { data: base64(clipWebmTimed(60.5)), durationSec: undefined }, { data: base64(clipWebmTimed(61)), durationSec: 60 },
      { data: base64(clipWebmTimed(120)), durationSec: undefined }, { data: base64(clipWebmTimed(0.4)), durationSec: undefined },
      { data: base64(clipWebm()), durationSec: undefined }, // 0.02 s
      { durationSec: 61 }, // past a minute in the upload's own words (the schema)
      { mime: 'video/mp4', data: mp4Timed(61), durationSec: undefined },
    ];
    put.mockClear();
    for (const [i, body] of refused.entries()) expect((await clip(pmcToken, { ...body, clientKey: `${key}-${i}` })).status, JSON.stringify(Object.keys(body))).toBe(400);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: key } } })).toBe(0);
    expect(put).not.toHaveBeenCalled();
    // a photo has no length; a voice note may still be two minutes
    expect((await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: png, durationSec: 5, siteVisit: { visitId } })).status).toBe(400);
    expect(await stored(await upload(pmcToken, { kind: 'visit', mime: 'audio/webm', data: base64(webmTimed(90)), durationSec: 90, siteVisit: { visitId } }))).toBe(90);
  });

  it('a file that is not a video in the container its type names is refused before anything is stored', async () => {
    const key = `video-bad-${run}`;
    put.mockClear();
    for (const [mime, data] of [
      ['video/webm', base64(clipMp4())], ['video/mp4', webm], ['video/webm', png], ['video/webm', Buffer.from('<html>').toString('base64')],
      // a voice note's recording under a video type: a clip has a picture
      ['video/webm', base64(webmTimed(42))], ['video/mp4', base64(mp4File(['soun'], 'isom', [4, 4], 48_000 * 42))],
      ['video/webm', recording('chromium-141-opus.webm')], ['video/mp4', recording('chromium-141-opus.mp4')],
      // Chrome's H.264 recording, which it names Matroska
      ['video/webm', recording('chromium-153-h264-opus.mkv')],
      // and a clip under a voice note's type
      ['audio/webm', webm], ['audio/mp4', recording('chromium-153-avc1-opus.mp4')],
    ] as const) {
      expect((await clip(pmcToken, { mime, data, durationSec: undefined, clientKey: `${key}-${mime}-${data.length}` })).status, `${mime} ${data.length}`).toBe(400);
    }
    // a type no recorder names here
    expect((await clip(pmcToken, { mime: 'video/quicktime', clientKey: `${key}-mov` })).status).toBe(400);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: key } } })).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });

  it('a clip goes only on a visit, by someone who may add to it, and is never a marked-up copy', async () => {
    const key = `video-refused-${run}`;
    put.mockClear();
    expect((await upload(pmcToken, { kind: 'progress', mime: 'video/webm', data: webm, clientKey: `${key}-progress` })).status).toBe(400);
    expect((await upload(pmcToken, { kind: 'inspection', mime: 'video/mp4', data: mp4Timed(5), clientKey: `${key}-inspection` })).status).toBe(400);
    const photo = await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: png, siteVisit: { visitId } });
    expect(photo.status).toBe(201);
    expect((await clip(pmcToken, { sourceMediaId: photo.body.id, clientKey: `${key}-copy` })).status).toBe(400);
    expect(put).toHaveBeenCalledTimes(1); // the photo alone
    // a clip is never a marked-up copy's original either
    const video = await clip(pmcToken);
    expect(video.status).toBe(201);
    expect((await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: png, siteVisit: { visitId }, sourceMediaId: video.body.id, clientKey: `${key}-markup` })).status).toBe(400);
    expect((await clip(engineerToken, { clientKey: key })).status).toBe(403);
    // the adder is asked before the file is read: a stranger's unreadable file is refused for who they are
    expect((await clip(engineerToken, { data: png, clientKey: `${key}-unread` })).status).toBe(403);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: key } } })).toBe(0);
    expect(put).toHaveBeenCalledTimes(2); // the photo and the clip, never a refused upload
  });

  // last, since it closes the suite's visit
  it('a closed visit takes no clip, with the same refusal a photo gets', async () => {
    expect((await http().post(`${visits()}/${visitId}/close`).set('Authorization', `Bearer ${pmcToken}`).send({ reason: 'Left open' })).status).toBe(201);
    const key = `video-closed-${run}`;
    put.mockClear();
    const video = await clip(pmcToken, { clientKey: `${key}-video` });
    const photo = await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: png, siteVisit: { visitId }, clientKey: `${key}-photo` });
    expect(video.status).toBe(409);
    expect(photo.status).toBe(409);
    expect(video.body.message).toBe(photo.body.message);
    expect(put).not.toHaveBeenCalled();
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: key } } })).toBe(0);
  });
});
