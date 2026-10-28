import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';
import { MediaQueryService } from '../../src/media/media.query';
import { base64, webmTimed } from '../unit-support/voice-files';
import { clipWebmTimed } from '../unit-support/video-files';
import { SITE_PHOTO_DELETED_MESSAGE } from '@vitan/shared';

/**
 * #1179 R2 — taking a voice note, video or photo off a site visit (Jagrut, 27 Oct 2026): the person who added it within
 * the hour while the visit is open, the PMC at any time with a reason. The visit keeps a line saying who removed what,
 * when and why; the file's row, its stored object and a clip's still frame go. Proven through the real routes against
 * PostgreSQL, with the bucket's calls stood in for.
 */
describe('#1179 R2 — removing a file from a site visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let pmcToken: string;
  let consultantToken: string;
  let engineerToken: string;
  let otherToken: string;
  let consultant: string;
  let visitId: string;
  let storage: StorageService;
  let remove: MockInstance;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const jpeg = readFileSync(join(__dirname, '..', 'unit-support', 'recordings', 'chromium-153-still-640x360.jpg')).toString('base64');

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send(body);
  const voice = async (token = pmcToken, visit = visitId, extraBody: Record<string, unknown> = {}) => {
    const res = await upload(token, { kind: 'visit', mime: 'audio/webm', data: base64(webmTimed(4)), durationSec: 4, siteVisit: { visitId: visit }, ...extraBody });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const clip = async (token = pmcToken) => {
    const res = await upload(token, { kind: 'visit', mime: 'video/webm', data: base64(clipWebmTimed(6)), durationSec: 6, siteVisit: { visitId } });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const removeIt = (mediaId: string, token = pmcToken, body: Record<string, unknown> = {}, projectId = f.projectA.id) =>
    http().post(`/projects/${projectId}/media/${mediaId}/visit-removal`).set('Authorization', `Bearer ${token}`).send(body);
  const visit = async (id = visitId, token = pmcToken) => {
    const res = await http().get(`${visits()}/${id}`).set('Authorization', `Bearer ${token}`);
    if (res.status === 200) return res.body;
    const list = await http().get(visits()).set('Authorization', `Bearer ${token}`);
    return (list.body as Array<{ id: string }>).find((v) => v.id === id)!;
  };
  const backdate = (mediaId: string) => t.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMedia" DISABLE TRIGGER "SiteVisitMedia_update"');
    await tx.$executeRaw`UPDATE "SiteVisitMedia" SET "addedAt" = "addedAt" - interval '61 minutes' WHERE "mediaId" = ${mediaId}`;
    await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMedia" ENABLE TRIGGER "SiteVisitMedia_update"');
  });
  const member = async (role: 'consultant' | 'engineer') => {
    const id = `svr-${role}-${run}`;
    extra.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `Sam (${role})`, email: `${id}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    storage = t.app.get(StorageService);
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    consultant = await member('consultant');
    const engineer = await member('engineer');
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    consultantToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    engineerToken = t.issueProjectToken(engineer, f.projectA.id, 'engineer');
    otherToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    // the PMC's visit, with the consultant and the engineer present
    visitId = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${pmcToken}`).send({ id: visitId, claimedAt: ago(30) })).status).toBe(201);
    for (const [userId, role] of [[consultant, 'consultant'], [engineer, 'engineer']] as const) {
      expect((await http().post(`${visits()}/${visitId}/attendees`).set('Authorization', `Bearer ${pmcToken}`)
        .send({ id: randomUUID(), userId, role })).status).toBe(201);
    }
  });

  beforeEach(() => {
    vi.spyOn(storage, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(storage, 'put').mockImplementation(async (key: string) => ({ url: `https://bucket.test/${key}` }));
    remove = vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
    vi.spyOn(storage, 'presignGet').mockImplementation(async (key: string) => `https://bucket.test/${key}?signed=1`);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitFileRemoval', 'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] }, sourceMediaId: { not: null } } });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extra } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  it('the person who added a voice note removes it within the hour: it leaves the visit and storage, and the visit keeps the line', async () => {
    const id = await voice(consultantToken);
    const key = (await t.prisma.media.findUniqueOrThrow({ where: { id }, select: { storageKey: true } })).storageKey;
    const offered = (await visit(visitId, consultantToken)).files.find((x: { mediaId: string }) => x.mediaId === id);
    expect(offered.removable).toEqual({ reasonRequired: false, until: expect.any(String) });
    const res = await removeIt(id, consultantToken);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await t.prisma.media.findUnique({ where: { id } })).toBeNull();
    expect(remove.mock.calls.map((c) => c[0])).toEqual([key]);
    const after = await visit(visitId, consultantToken);
    expect(after.files.map((x: { mediaId: string }) => x.mediaId)).not.toContain(id);
    expect(after.removals.find((r: { mediaId: string }) => r.mediaId === id)).toMatchObject({
      kind: 'voice', addedByName: 'Sam (consultant)', removedById: consultant, removedByName: 'Sam (consultant)', removedByRole: 'consultant', reason: null,
    });
    expect(await t.prisma.domainEvent.count({ where: { entityId: id, eventType: 'media.removed' } })).toBe(1);
  });

  it('a file removed between the visit\'s read and its files\' facts is left out, not served empty (Codex 4398005586)', async () => {
    const id = await voice();
    const kept = await voice();
    const media = t.app.get(MediaQueryService);
    const original = media.fileFacts.bind(media);
    // the removal commits after the visit and its links are read, before the media module is asked about them
    const spy = vi.spyOn(media, 'fileFacts').mockImplementationOnce(async (...args) => {
      expect((await removeIt(id, pmcToken, { reason: 'Recorded by mistake' })).status).toBe(200);
      return original(...args);
    });
    const files = (await visit()).files as Array<{ mediaId: string; mime: string }>;
    spy.mockRestore();
    expect(files.map((x) => x.mediaId)).not.toContain(id);
    expect(files.find((x) => x.mediaId === kept)?.mime).toBe('audio/webm');
    expect(files.every((x) => x.mime !== '')).toBe(true);
    // the next read has the removal line
    expect((await visit()).removals.map((r: { mediaId: string }) => r.mediaId)).toContain(id);
  });

  it('a reason sent by someone other than the PMC is not kept, so the database\'s CHECK still judges their hour at the line\'s own stamp (Codex 4397768832)', async () => {
    const id = await voice(consultantToken);
    expect((await removeIt(id, consultantToken, { reason: 'Recorded by mistake' })).status).toBe(200);
    expect((await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: id } })).reason).toBeNull();
    // and past the hour a reason does not stand in for the PMC's: the line is refused as before
    const late = await voice(consultantToken);
    await backdate(late);
    const refused = await removeIt(late, consultantToken, { reason: 'Recorded by mistake' });
    expect(refused.status).toBe(403);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: late } })).toBe(0);
  });

  it('nobody else but the PMC may remove a file, and the person who added it not after the hour', async () => {
    const id = await voice(consultantToken);
    expect((await visit(visitId, engineerToken)).files.find((x: { mediaId: string }) => x.mediaId === id).removable).toBeNull();
    const notTheirs = await removeIt(id, engineerToken, { reason: 'Mine now' });
    expect(notTheirs.status).toBe(403);
    expect(notTheirs.body.message).toMatch(/Only the person who added this file, or the PMC/);
    await backdate(id);
    expect((await visit(visitId, consultantToken)).files.find((x: { mediaId: string }) => x.mediaId === id).removable).toBeNull();
    const late = await removeIt(id, consultantToken, { reason: 'Too late' });
    expect(late.status).toBe(403);
    expect(late.body.message).toMatch(/within an hour/);
    expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: id } })).toBe(1);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: id } })).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it('the PMC removes anyone\'s file with a reason, after the hour too; without one, or with a blank one, it is refused', async () => {
    const id = await voice(consultantToken);
    await backdate(id);
    expect((await visit()).files.find((x: { mediaId: string }) => x.mediaId === id).removable).toEqual({ reasonRequired: true, until: null });
    const none = await removeIt(id);
    expect(none.status).toBe(400);
    expect(none.body.message).toMatch(/Say why/);
    // blank, invisible-only, a NUL (which PostgreSQL cannot store), or over 300 characters
    // ... or only controls, separators or private-use marks, which show nothing (Codex 4397768825)
    for (const reason of ['', '   ', '\u200b\u200b', 'why\u0000', 'x'.repeat(301), '🙂'.repeat(301), '\u0001', '\u0085\u009f', '\u2028\u3000', '\ue000']) {
      expect((await removeIt(id, pmcToken, { reason })).status, JSON.stringify(reason)).toBe(400);
    }
    expect((await removeIt(id, pmcToken, { reason: null })).status).toBe(400);
    expect((await removeIt(id, pmcToken, { reason: 'x', extra: 1 })).status).toBe(400);
    const ok = await removeIt(id, pmcToken, { reason: '  Recorded by mistake  ' });
    expect(ok.status, ok.text).toBe(200);
    expect(await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: id } }))
      .toMatchObject({ addedById: consultant, removedById: f.memberUser.id, removedByRole: 'pmc', reason: 'Recorded by mistake' });
    // 300 characters is 300 characters, emoji included, as the database counts them
    const wide = await voice(consultantToken);
    expect((await removeIt(wide, pmcToken, { reason: '🙂'.repeat(300) })).status).toBe(200);
  });

  it('the PMC removes their own file within the hour with no reason', async () => {
    const id = await voice();
    // the offer says until when no reason is needed
    const offer = (await visit()).files.find((x: { mediaId: string }) => x.mediaId === id).removable;
    expect(offer.reasonRequired).toBe(false);
    expect(Date.parse(offer.until)).toBeGreaterThan(Date.now());
    expect((await removeIt(id, pmcToken, { reason: null })).status).toBe(200);
    expect((await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: id } })).reason).toBeNull();
  });

  it('on a visit the PMC closed, the person who added a file can no longer remove it; the PMC still can', async () => {
    const own = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${consultantToken}`).send({ id: own, claimedAt: ago(10) })).status).toBe(201);
    const id = await voice(consultantToken, own);
    expect((await http().post(`${visits()}/${own}/close`).set('Authorization', `Bearer ${pmcToken}`).send({ reason: 'Left open' })).status).toBe(201);
    expect((await visit(own, consultantToken)).files[0].removable).toBeNull();
    const refused = await removeIt(id, consultantToken);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/closed by the PMC/);
    expect((await removeIt(id, pmcToken, { reason: 'Wrong visit' })).status).toBe(200);
    expect((await visit(own)).removals).toEqual([expect.objectContaining({ mediaId: id, reason: 'Wrong visit' })]);
  });

  it('once its visitor ends the visit, the person who added a file can no longer remove it; the PMC still can (Codex 4397416722)', async () => {
    const own = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${consultantToken}`).send({ id: own, claimedAt: ago(10) })).status).toBe(201);
    const id = await voice(consultantToken, own);
    const ended = await http().post(`${visits()}/${own}/end`).set('Authorization', `Bearer ${consultantToken}`).send({ claimedAt: new Date().toISOString() });
    expect(ended.status, ended.text).toBe(201);
    expect((await visit(own, consultantToken)).status).toBe('ended');
    expect((await visit(own, consultantToken)).files[0].removable).toBeNull();
    const refused = await removeIt(id, consultantToken);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/has ended/);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: id } })).toBe(0);
    expect((await removeIt(id, pmcToken, { reason: 'Wrong visit' })).status).toBe(200);
  });

  it('a clip goes with its still frame, read under the clip\'s row lock; a frame sent after the removal is refused as not found', async () => {
    const id = await clip();
    const framed = await http().post(`/projects/${f.projectA.id}/media/${id}/poster`).set('Authorization', `Bearer ${pmcToken}`).send({ mime: 'image/jpeg', data: jpeg });
    expect(framed.status, framed.text).toBe(200);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id }, select: { storageKey: true, posterStorageKey: true } });
    expect(row.posterStorageKey).not.toBeNull();
    remove.mockClear();
    expect((await removeIt(id)).status).toBe(200);
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual([row.storageKey, row.posterStorageKey].sort());
    expect((await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: id } })).fileKind).toBe('video');
    const late = await http().post(`/projects/${f.projectA.id}/media/${id}/poster`).set('Authorization', `Bearer ${pmcToken}`).send({ mime: 'image/jpeg', data: jpeg });
    expect(late.status).toBe(404);
  });

  it('a removed file never comes back: a late copy of its send stores nothing', async () => {
    const clientKey = `svr-${run}-${randomUUID()}`;
    const id = await voice(consultantToken, visitId, { clientKey });
    expect((await removeIt(id, consultantToken)).status).toBe(200);
    const replay = await upload(consultantToken, { kind: 'visit', mime: 'audio/webm', data: base64(webmTimed(4)), durationSec: 4, siteVisit: { visitId }, clientKey });
    expect(replay.status).toBe(410);
    expect(replay.body.message).toBe(SITE_PHOTO_DELETED_MESSAGE);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey } })).toBe(0);
  });

  it('a marked-up copy of a removed photo stays on the visit, its original link cleared', async () => {
    const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const original = await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: px, siteVisit: { visitId } });
    expect(original.status, original.text).toBe(201);
    const copy = await upload(pmcToken, { kind: 'visit', mime: 'image/png', data: px, sourceMediaId: original.body.id, siteVisit: { visitId } });
    expect(copy.status, copy.text).toBe(201);
    expect((await removeIt(original.body.id)).status).toBe(200);
    expect(await t.prisma.media.findUniqueOrThrow({ where: { id: copy.body.id }, select: { sourceMediaId: true } })).toEqual({ sourceMediaId: null });
    expect((await visit()).files.map((x: { mediaId: string }) => x.mediaId)).toContain(copy.body.id);
    expect((await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: original.body.id } })).fileKind).toBe('photo');
  });

  it('a file not on a visit, another project\'s, or one already removed is not found; the photo delete still refuses a visit file', async () => {
    const loose = await upload(pmcToken, { kind: 'progress', mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
    expect(loose.status, loose.text).toBe(201);
    expect((await removeIt(loose.body.id, pmcToken, { reason: 'x' })).status).toBe(404);
    const id = await voice();
    expect((await removeIt(id, otherToken, { reason: 'x' }, f.projectA.id)).status).toBeGreaterThanOrEqual(403);
    expect((await removeIt(id, otherToken, { reason: 'x' }, f.projectB.id)).status).toBe(404);
    const del = await http().delete(`/media/${id}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(del.status).toBe(409);
    expect((await removeIt(id)).status).toBe(200);
    expect((await removeIt(id)).status).toBe(404);
  });

  it('two removals of one file at once: one succeeds, the other is not found, and one line stands', async () => {
    const id = await voice();
    // a barrier: hold the visit's row, so both removals are in flight at once, queued on it or on each other, before
    // either reaches its line (Codex 4397416724)
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holder = 0;
    const held = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "SiteVisit" WHERE "projectId" = ${f.projectA.id} AND "id" = ${visitId} FOR UPDATE`;
      holder = Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`)[0]!.pid);
      await gate;
    }, { timeout: 60_000 });
    const waiting = async (): Promise<number> => Number((await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `WITH w AS (SELECT pid, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE datname = current_database())
       SELECT count(*)::bigint AS n FROM w
        WHERE $1::int = ANY(w.b) OR w.b && ARRAY(SELECT pid FROM w WHERE $1::int = ANY(w.b))`, holder))[0]!.n);
    const until = async (probe: () => Promise<boolean>, what: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`barrier not reached: ${what}`);
    };
    await until(async () => holder > 0, 'the visit row is held');
    const both = Promise.all([removeIt(id, pmcToken, { reason: 'First' }), removeIt(id, pmcToken, { reason: 'Second' })]);
    await until(async () => (await waiting()) >= 2, 'both removals wait behind the held visit');
    // neither has written its line while the visit is held
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: id } })).toBe(0);
    release();
    await held;
    const [a, b] = await both;
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: id } })).toBe(1);
  });

  it('a file another record cites as evidence is not offered for removal, and its removal is refused (Codex 4397416732)', async () => {
    const id = await voice();
    const activityId = `${f.projectA.id}-svr-act-${run}`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: f.projectA.id, name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
    const override = await t.prisma.gateOverride.create({
      data: { projectId: f.projectA.id, activityId, gate: 'material', state: 'ok', reason: 'the voice note confirms the delivery', actorId: f.memberUser.id, actorName: 'PMC', expiresAt: new Date(Date.now() + 7 * 864e5), evidenceMediaId: id },
    });
    try {
      expect((await visit()).files.find((x: { mediaId: string }) => x.mediaId === id).removable).toBeNull();
      expect((await removeIt(id, pmcToken, { reason: 'Recorded by mistake' })).status).toBe(409);
      expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: id } })).toBe(0);
    } finally {
      await t.prisma.gateOverride.deleteMany({ where: { id: override.id } });
      await t.prisma.activity.deleteMany({ where: { id: activityId } });
    }
    // once nothing cites it, it is offered again
    expect((await visit()).files.find((x: { mediaId: string }) => x.mediaId === id).removable).toEqual({ reasonRequired: false, until: expect.any(String) });
  });

  it('the offer judges the hour on the database\'s clock, as the removal does, not the API\'s (Codex 4397416735)', async () => {
    const id = await voice(consultantToken);
    await backdate(id);
    // the API's clock two hours behind the database's: by its own clock the hour has not run out
    const behind = Date.now() - 2 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(behind);
    let offer: unknown;
    try {
      offer = (await visit(visitId, consultantToken)).files.find((x: { mediaId: string }) => x.mediaId === id).removable;
    } finally {
      clock.mockRestore();
    }
    expect(offer).toBeNull();
    expect((await removeIt(id, consultantToken)).status).toBe(403);
  });
});
