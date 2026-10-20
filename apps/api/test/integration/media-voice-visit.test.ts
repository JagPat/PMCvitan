import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { base64, mp4File, mp4VideoOnly, oggFile, oggVideoOnly, webmFile, webmVideoOnly } from '../unit-support/voice-files';

/**
 * Stage 1 voice notes, site visits first (Jagrut, 19 Oct 2026: "yes to all" on the media plan): a spoken note of up to
 * two minutes is uploaded as a file on a visit, by the people who may add files to it. Android's WebM, the iPhone's MP4
 * and Firefox's Ogg are accepted, each only when its bytes are that container. Proven through the real routes against
 * PostgreSQL.
 */
describe('Stage 1 voice — a voice note on a site visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let pmcToken: string;
  let engineerToken: string;
  let visitId: string;
  // structurally valid recordings, one per container (test/unit-support/voice-files.ts)
  const webm = base64(webmFile());
  const mp4 = base64(mp4File());
  const ogg = base64(oggFile());

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send(body);
  const voice = (token: string, body: Record<string, unknown> = {}) =>
    upload(token, { kind: 'visit', mime: 'audio/webm', data: webm, durationSec: 42, siteVisit: { visitId, note: 'Pipe route' }, ...body });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    const engineer = `voice-engineer-${run}`;
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

  it('the visitor adds a voice note with its length; it is a file on the visit and is served as the audio it is', async () => {
    const res = await voice(pmcToken);
    expect(res.status).toBe(201);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ kind: 'visit', mime: 'audio/webm', durationSec: 42 });
    expect(row.storageKey).toMatch(/\.webm$/);
    expect(await t.prisma.siteVisitMedia.findUniqueOrThrow({ where: { mediaId: res.body.id } })).toMatchObject({ visitId, note: 'Pipe route' });
    const served = await http().get(new URL(res.body.url, 'http://x').pathname + new URL(res.body.url, 'http://x').search);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/^audio\/webm/);
  });

  it('an iPhone MP4 and a Firefox Ogg note are accepted', async () => {
    expect((await voice(pmcToken, { mime: 'audio/mp4', data: mp4, durationSec: 120 })).status).toBe(201);
    expect((await voice(pmcToken, { mime: 'audio/ogg', data: ogg, durationSec: 1 })).status).toBe(201);
  });

  it('a voice note says how long it is, at most two minutes; a photo says no length', async () => {
    expect((await voice(pmcToken, { durationSec: undefined })).status).toBe(400);
    expect((await voice(pmcToken, { durationSec: 121 })).status).toBe(400);
    expect((await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: webm, durationSec: 5, siteVisit: { visitId } })).status).toBe(400);
  });

  it('a file that is not an audio-only recording in the container its type names is refused before anything is stored', async () => {
    const key = `voice-bad-${run}`;
    const signatureOnly = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 1)]).toString('base64');
    for (const [mime, data] of [
      ['audio/webm', ogg], ['audio/ogg', webm], ['audio/mp4', webm], ['audio/webm', Buffer.from('<html>').toString('base64')],
      // a video in each container (Codex P2 on #1010), and the container's first bytes alone
      ['audio/webm', base64(webmVideoOnly())], ['audio/ogg', base64(oggVideoOnly())], ['audio/mp4', base64(mp4VideoOnly())],
      ['audio/webm', signatureOnly],
    ] as const) {
      expect((await voice(pmcToken, { mime, data, clientKey: `${key}-${mime}-${data.length}` })).status).toBe(400);
    }
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: key } } })).toBe(0);
  });

  it('a voice note goes only on a visit, by someone who may add to it, and is never a marked-up copy', async () => {
    expect((await upload(pmcToken, { kind: 'progress', mime: 'audio/webm', data: webm, durationSec: 5 })).status).toBe(400);
    const photo = await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), siteVisit: { visitId } });
    expect(photo.status).toBe(201);
    expect((await voice(pmcToken, { sourceMediaId: photo.body.id })).status).toBe(400);
    const key = `voice-refused-${run}`;
    expect((await voice(engineerToken, { clientKey: key })).status).toBe(403);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: key } })).toBe(0);
  });

  // last, since it closes the suite's visit
  it('a closed visit takes no voice note, with the same refusal a photo gets', async () => {
    expect((await http().post(`${visits()}/${visitId}/close`).set('Authorization', `Bearer ${pmcToken}`).send({ reason: 'Left open' })).status).toBe(201);
    const key = `voice-closed-${run}`;
    const note = await voice(pmcToken, { clientKey: `${key}-voice` });
    const photo = await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), siteVisit: { visitId }, clientKey: `${key}-photo` });
    expect(note.status).toBe(409);
    expect(photo.status).toBe(409);
    expect(note.body.message).toBe(photo.body.message);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: key } } })).toBe(0);
  });
});
