import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';
import { readinessLockKey } from '../../src/common/readiness-lock';
import { base64, webmTimed } from '../unit-support/voice-files';
import { clipWebmTimed } from '../unit-support/video-files';
import { VIDEO_LINK_GONE_MESSAGE, VIDEO_LINK_REFUSED_MESSAGE, VISIT_FILE_GONE_MESSAGE, isAllowedVideoLink } from '@vitan/shared';

/**
 * Video V2g-1 (#995; Jagrut, 6 Nov 2026: "small clip + paste a Drive link") — a visit's video clip gets a link to its
 * full-quality video in Google Drive or Zoho WorkDrive, through `PUT` and `DELETE .../files/:mediaId/link`, and the
 * visit read serves it on the clip. Who: adding where there is none, the clip's adder or anyone on the visit while it is
 * not closed, and the PMC; replacing or taking off, the link's adder within the hour (not closed), or the PMC with a
 * reason unless it is their own within the hour (V2g-0 K7). Proven through the real routes against PostgreSQL.
 */
describe('video V2g-1: a clip\'s full-video link through the routes (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let pmcToken: string;
  let consultantToken: string;
  let engineerToken: string;
  let strangerToken: string;
  let otherToken: string;
  let consultant: string;
  let engineer: string;
  let visitId: string;
  const DRIVE = 'https://drive.google.com/file/d/1AbCdEf/view?usp=sharing';
  const ZOHO = 'https://workdrive.zohopublic.in/file/abc123';
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const linkPath = (mediaId: string, visit = visitId, projectId = f.projectA.id) =>
    `/projects/${projectId}/site-visits/${visit}/files/${mediaId}/link`;
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send(body);
  const clip = async (token = pmcToken, visit = visitId) => {
    const res = await upload(token, { kind: 'visit', mime: 'video/webm', data: base64(clipWebmTimed(6)), durationSec: 6, siteVisit: { visitId: visit } });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const voice = async (token = pmcToken) => {
    const res = await upload(token, { kind: 'visit', mime: 'audio/webm', data: base64(webmTimed(4)), durationSec: 4, siteVisit: { visitId } });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  const put = (mediaId: string, body: Record<string, unknown>, token = pmcToken, key?: string, visit = visitId, projectId = f.projectA.id) => {
    const r = http().put(linkPath(mediaId, visit, projectId)).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const del = (mediaId: string, body: Record<string, unknown>, token = pmcToken, key?: string) => {
    const r = http().delete(linkPath(mediaId)).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const set = async (mediaId: string, url: string, replaces: string | null, token = pmcToken, extraBody: Record<string, unknown> = {}, visit = visitId) => {
    const id = randomUUID();
    const res = await put(mediaId, { id, url, replaces, ...extraBody }, token, undefined, visit);
    expect(res.status, res.text).toBe(200);
    return id;
  };
  type FileDto = { mediaId: string; fullVideoLink: Record<string, unknown> | null; fullVideoLinkOffer: Record<string, unknown> | null };
  const fileOf = async (mediaId: string, token = pmcToken, visit = visitId): Promise<FileDto> => {
    const list = await http().get(visits()).set('Authorization', `Bearer ${token}`);
    expect(list.status, list.text).toBe(200);
    const v = (list.body as Array<{ id: string; files: FileDto[] }>).find((x) => x.id === visit)!;
    return v.files.find((x) => x.mediaId === mediaId)!;
  };
  const links = (mediaId: string) => t.prisma.siteVisitMediaLink.findMany({ where: { mediaId }, orderBy: { addedAt: 'asc' } });
  /** backdate a link past its adder's hour; the link is frozen, so its update seal is lifted inside this one transaction */
  const backdate = (linkId: string) => t.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMediaLink" DISABLE TRIGGER "SiteVisitMediaLink_end"');
    await tx.$executeRaw`UPDATE "SiteVisitMediaLink" SET "addedAt" = "addedAt" - interval '61 minutes' WHERE "id" = ${linkId}`;
    await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMediaLink" ENABLE TRIGGER "SiteVisitMediaLink_end"');
  });
  const member = async (role: 'consultant' | 'engineer') => {
    const id = `svfl-${role}-${run}`;
    extra.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `Sam (${role})`, email: `${id}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    return id;
  };
  const startVisit = async (token = pmcToken) => {
    const id = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${token}`).send({ id, claimedAt: ago(30) })).status).toBe(201);
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    consultant = await member('consultant');
    engineer = await member('engineer');
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    consultantToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    engineerToken = t.issueProjectToken(engineer, f.projectA.id, 'engineer');
    strangerToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    otherToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    // the PMC's visit, with the consultant present (the engineer is not on it)
    visitId = await startVisit();
    expect((await http().post(`${visits()}/${visitId}/attendees`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: randomUUID(), userId: consultant, role: 'consultant' })).status).toBe(201);
  });

  beforeEach(() => {
    const storage = t.app.get(StorageService);
    vi.spyOn(storage, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(storage, 'put').mockImplementation(async (key: string) => ({ url: `https://bucket.test/${key}` }));
    vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
    vi.spyOn(storage, 'presignGet').mockImplementation(async (key: string) => `https://bucket.test/${key}?signed=1`);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMediaLink', 'SiteVisitFileRemoval', 'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extra } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  it('one url list: the shared allow-list and the database\'s CHECK accept exactly the same links', async () => {
    const mediaId = await clip();
    const urls = [
      'https://drive.google.com/drive/folders/1xyz', 'https://drive.google.com/file/d/1/view', 'https://workdrive.zoho.com/file/a',
      'https://workdrive.zoho.in/folder/b', 'https://workdrive.zoho.eu/file/c', 'https://workdrive.zohopublic.com/file/d',
      'https://workdrive.zohopublic.in/file/e', 'https://workdrive.zohopublic.eu/file/f', `https://drive.google.com/${'a'.repeat(1975)}`,
      'http://drive.google.com/file/d/1', 'https://drive.google.com.evil.io/file', 'https://evil.io/drive.google.com/',
      'https://user@drive.google.com/file', 'https://drive.google.com:8443/file', 'https://DRIVE.google.com/file',
      'https://drive.google.com', 'https://drive.google.com/file d', 'https://drive.google.com/file\n', 'https://drive.google.com/file\t',
      'javascript:alert(1)//https://drive.google.com/', 'https://x.zohopublic.in/file', 'https://workdrive.zoho.jp/file',
      'https://workdrive.zohoexternal.com/file/g', `https://drive.google.com/${'a'.repeat(1976)}`,
      'https://docs.google.com/file/d/1/edit', 'https://docs.google.com/url?q=https://evil.io',
      'https://drive.google.com/file d', 'https://drive.google.com/file​d', 'https://drive.google.com/filé',
      ' https://drive.google.com/file/d/1', 'https://drive.google.com/file\u0000',
    ];
    const verdicts: Array<[string, boolean, boolean]> = [];
    for (const url of urls) {
      const id = randomUUID();
      const kept = await t.prisma.$executeRaw`
        INSERT INTO "SiteVisitMediaLink" ("id","projectId","mediaId","url","host","addedById","addedByRole")
        VALUES (${id}, ${f.projectA.id}, ${mediaId}, ${url}, 'drive', ${f.memberUser.id}, 'pmc')`.then(() => true, () => false);
      if (kept) await t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "endedById" = ${f.memberUser.id}, "endedByRole" = 'pmc' WHERE "id" = ${id}`;
      verdicts.push([url, isAllowedVideoLink(url), kept]);
    }
    expect(verdicts.filter(([, shared, db]) => shared !== db)).toEqual([]);
    // the list holds both answers, so a check that refused (or kept) everything would not pass
    expect(verdicts.filter(([, , db]) => db).length).toBe(9);
  });

  it('the visitor puts a link on a clip; the read serves it with its host, adder and time, for every viewer', async () => {
    const mediaId = await clip();
    expect(await fileOf(mediaId)).toMatchObject({ fullVideoLink: null, fullVideoLinkOffer: { reasonRequired: false, until: null } });
    const id = randomUUID();
    const res = await put(mediaId, { id, url: `  ${ZOHO}  `, label: '  Slab pour, full  ', replaces: null });
    expect(res.status, res.text).toBe(200);
    const served = (res.body.files as FileDto[]).find((x) => x.mediaId === mediaId)!;
    expect(served.fullVideoLink).toMatchObject({ id, url: ZOHO, host: 'zoho', label: 'Slab pour, full', addedById: f.memberUser.id, addedByRole: 'pmc' });
    expect(served.fullVideoLink!.addedByName).not.toBe('');
    // the engineer is not on the visit: they see the link and get no offer to change it
    expect(await fileOf(mediaId, engineerToken)).toMatchObject({ fullVideoLink: { id, url: ZOHO }, fullVideoLinkOffer: null });
    expect(await links(mediaId)).toHaveLength(1);
  });

  it('a link off the allow-list, a voice note, or a file not on this visit takes nothing', async () => {
    const mediaId = await clip();
    for (const url of ['https://docs.google.com/file/d/1/edit', 'https://drive.google.com:8443/f', 'http://drive.google.com/f']) {
      const res = await put(mediaId, { id: randomUUID(), url, replaces: null });
      expect(res.status).toBe(400);
      expect(res.text).toContain(VIDEO_LINK_REFUSED_MESSAGE);
    }
    const note = await voice();
    expect((await put(note, { id: randomUUID(), url: DRIVE, replaces: null })).status).toBe(400);
    expect(await fileOf(note)).toMatchObject({ fullVideoLink: null, fullVideoLinkOffer: null });
    // "a video" is the exact, case-sensitive prefix the database uses (V2g-0 K2), never a lowercased one: a stored
    // "VIDEO/webm" (its length and still frame cleared, which Media_av_shape_check keeps for video/ only) gets the
    // server's own 400, not the database's refusal, and the read offers no link on it
    const shouty = await clip();
    await t.prisma.$executeRaw`UPDATE "Media" SET "mime" = 'VIDEO/webm', "durationSec" = NULL, "posterStorageKey" = NULL WHERE "id" = ${shouty}`;
    const loud = await put(shouty, { id: randomUUID(), url: DRIVE, replaces: null });
    expect(loud.status, loud.text).toBe(400);
    expect(loud.body.message).toBe('Only a video takes a full video link');
    expect(await fileOf(shouty)).toMatchObject({ fullVideoLink: null, fullVideoLinkOffer: null });
    // a clip on another visit, named under this one
    const otherVisit = await startVisit(consultantToken);
    const elsewhere = await clip(consultantToken, otherVisit);
    const res = await put(elsewhere, { id: randomUUID(), url: DRIVE, replaces: null });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(VISIT_FILE_GONE_MESSAGE);
    // another project's member reaches nothing here
    expect([403, 404]).toContain((await put(mediaId, { id: randomUUID(), url: DRIVE, replaces: null }, otherToken)).status);
    expect(await t.prisma.siteVisitMediaLink.count({ where: { mediaId: { in: [mediaId, note, shouty, elsewhere] } } })).toBe(0);
    // one open visit per visitor: the consultant's ends here, so a later test can start another
    expect((await http().post(`${visits()}/${otherVisit}/end`).set('Authorization', `Bearer ${consultantToken}`).send({ claimedAt: ago(1) })).status).toBe(201);
  });

  it('a replace ends the link the person saw and keeps it as history; a link changed by someone else since is refused', async () => {
    const mediaId = await clip();
    const first = await set(mediaId, DRIVE, null);
    // a stale "no link" or a stale link id is refused, writing nothing
    expect((await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: null })).status).toBe(409);
    expect((await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: randomUUID() })).status).toBe(409);
    const second = await set(mediaId, ZOHO, first);
    const rows = await links(mediaId);
    expect(rows.map((r) => [r.id, r.endedAt === null])).toEqual([[first, false], [second, true]]);
    expect(rows[0]).toMatchObject({ endedById: f.memberUser.id, endedByRole: 'pmc', reason: null });
    expect((await fileOf(mediaId)).fullVideoLink).toMatchObject({ id: second, url: ZOHO, host: 'zoho' });
  });

  it('who: the clip\'s adder or anyone on the visit adds; only the link\'s adder in the hour, or the PMC with a reason, changes it', async () => {
    const mediaId = await clip();
    // the engineer is not on the visit and did not add the clip
    expect((await put(mediaId, { id: randomUUID(), url: DRIVE, replaces: null }, engineerToken)).status).toBe(403);
    expect((await fileOf(mediaId, engineerToken)).fullVideoLinkOffer).toBeNull();
    // the consultant is on the visit
    expect((await fileOf(mediaId, consultantToken)).fullVideoLinkOffer).toMatchObject({ reasonRequired: false });
    const theirs = await set(mediaId, DRIVE, null, consultantToken);
    expect((await fileOf(mediaId, consultantToken)).fullVideoLinkOffer).toMatchObject({ reasonRequired: false, until: expect.any(String) });
    // the PMC needs a reason to end someone else's link; it is kept on the ended link
    expect((await fileOf(mediaId)).fullVideoLinkOffer).toMatchObject({ reasonRequired: true });
    const noReason = await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: theirs });
    expect(noReason.status).toBe(400);
    const pmcs = await set(mediaId, ZOHO, theirs, pmcToken, { reason: 'Wrong video linked' });
    expect((await links(mediaId)).find((r) => r.id === theirs)).toMatchObject({ endedById: f.memberUser.id, reason: 'Wrong video linked' });
    // the consultant cannot change the PMC's link
    expect((await put(mediaId, { id: randomUUID(), url: DRIVE, replaces: pmcs }, consultantToken)).status).toBe(403);
    expect((await del(mediaId, { linkId: pmcs }, consultantToken)).status).toBe(403);
    expect((await fileOf(mediaId, consultantToken)).fullVideoLinkOffer).toBeNull();
  });

  it('after the hour the adder asks the PMC, who then gives a reason even for their own link', async () => {
    const mediaId = await clip();
    const theirs = await set(mediaId, DRIVE, null, consultantToken);
    await backdate(theirs);
    expect((await fileOf(mediaId, consultantToken)).fullVideoLinkOffer).toBeNull();
    const late = await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: theirs }, consultantToken, undefined);
    expect(late.status).toBe(403);
    expect((await del(mediaId, { linkId: theirs }, consultantToken)).status).toBe(403);
    const own = await set(mediaId, ZOHO, theirs, pmcToken, { reason: 'Edited cut' });
    await backdate(own);
    expect((await fileOf(mediaId)).fullVideoLinkOffer).toMatchObject({ reasonRequired: true, until: null });
    expect((await del(mediaId, { linkId: own })).status).toBe(400);
    expect((await del(mediaId, { linkId: own, reason: 'Video moved' })).status).toBe(200);
    expect((await links(mediaId)).filter((r) => r.endedAt === null)).toHaveLength(0);
  });

  it('a removal ends the link with no successor; the same link again is refused, and an unknown one is gone', async () => {
    const mediaId = await clip();
    const id = await set(mediaId, DRIVE, null);
    const res = await del(mediaId, { linkId: id });
    expect(res.status, res.text).toBe(200);
    expect((res.body.files as FileDto[]).find((x) => x.mediaId === mediaId)!.fullVideoLink).toBeNull();
    expect((await links(mediaId))[0]).toMatchObject({ id, endedById: f.memberUser.id, reason: null });
    expect((await del(mediaId, { linkId: id })).status).toBe(409);
    const unknown = await del(mediaId, { linkId: randomUUID() });
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe(VIDEO_LINK_GONE_MESSAGE);
    // a new link goes on after the removal
    await set(mediaId, ZOHO, null);
  });

  it('a closed visit: only the PMC changes a link', async () => {
    const closing = await startVisit(consultantToken);
    const mediaId = await clip(consultantToken, closing);
    const theirs = await set(mediaId, DRIVE, null, consultantToken, {}, closing);
    expect((await http().post(`${visits()}/${closing}/close`).set('Authorization', `Bearer ${pmcToken}`).send({ reason: 'Left open' })).status).toBe(201);
    const res = await http().put(linkPath(mediaId, closing)).set('Authorization', `Bearer ${consultantToken}`).send({ id: randomUUID(), url: ZOHO, replaces: theirs });
    expect(res.status).toBe(409);
    expect((await fileOf(mediaId, consultantToken, closing)).fullVideoLinkOffer).toBeNull();
    const pmc = await http().put(linkPath(mediaId, closing)).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: randomUUID(), url: ZOHO, replaces: theirs, reason: 'Right video' });
    expect(pmc.status, pmc.text).toBe(200);
  });

  it('a clip taken off the visit takes its links with it and takes no new one', async () => {
    const mediaId = await clip();
    const id = await set(mediaId, DRIVE, null);
    const removed = await http().post(`/projects/${f.projectA.id}/media/${mediaId}/visit-removal`).set('Authorization', `Bearer ${pmcToken}`).send({});
    expect(removed.status, removed.text).toBe(200);
    expect(await t.prisma.siteVisitMediaLink.count({ where: { id } })).toBe(0);
    const res = await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: null });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(VISIT_FILE_GONE_MESSAGE);
    expect((await del(mediaId, { linkId: id })).status).toBe(404);
  });

  it('a retried request lands once; the same key with another request is refused', async () => {
    const mediaId = await clip();
    const key = randomUUID();
    const body = { id: randomUUID(), url: DRIVE, replaces: null };
    expect((await put(mediaId, body, pmcToken, key)).status).toBe(200);
    const again = await put(mediaId, body, pmcToken, key);
    expect(again.status).toBe(200);
    expect((again.body.files as FileDto[]).find((x) => x.mediaId === mediaId)!.fullVideoLink).toMatchObject({ id: body.id });
    expect((await put(mediaId, { ...body, url: ZOHO }, pmcToken, key)).status).toBe(409);
    expect(await links(mediaId)).toHaveLength(1);
    const endKey = randomUUID();
    expect((await del(mediaId, { linkId: body.id }, pmcToken, endKey)).status).toBe(200);
    expect((await del(mediaId, { linkId: body.id }, pmcToken, endKey)).status).toBe(200);
    expect((await links(mediaId)).filter((r) => r.endedAt !== null)).toHaveLength(1);
  });

  it('two replaces of the same link at once: one lands, the other is refused, never two current', async () => {
    const mediaId = await clip();
    const seen = await set(mediaId, DRIVE, null);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    // hold the project's readiness key, the writer's first lock, so both replaces are in flight before either runs
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${readinessLockKey(f.projectA.id)}, 0))`;
      locked();
      await held;
    }, { timeout: 60_000 });
    void holder.catch(() => undefined).finally(() => locked());
    await holding;
    let settled = 0;
    const send = (url: string) => put(mediaId, { id: randomUUID(), url, replaces: seen }).then((r) => r.status).finally(() => { settled += 1; });
    const a = send(ZOHO);
    const b = send('https://workdrive.zoho.com/file/z');
    // wait until both are waiting on the key (or one finished without waiting, which the assertions below then report)
    for (;;) {
      if (settled > 0) break;
      const waiting = await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`;
      if (waiting[0]!.n >= 2) break;
      await new Promise((r) => setImmediate(r));
    }
    expect(settled).toBe(0);
    release();
    await holder;
    expect([await a, await b].sort()).toEqual([200, 409]);
    const rows = await links(mediaId);
    expect(rows.filter((r) => r.endedAt === null)).toHaveLength(1);
    expect(rows.find((r) => r.id === seen)).toMatchObject({ endedById: f.memberUser.id });
    expect(rows).toHaveLength(2);
  });

  const attend = async (userId: string, role: string, visit = visitId) => {
    const id = randomUUID();
    const res = await http().post(`${visits()}/${visit}/attendees`).set('Authorization', `Bearer ${pmcToken}`).send({ id, userId, role });
    expect(res.status, res.text).toBe(201);
    return id;
  };

  it('an ended visit: the link\'s adder, even within the hour, asks the PMC, as for a file (gap-check G1)', async () => {
    const ending = await startVisit(consultantToken);
    const mediaId = await clip(consultantToken, ending);
    const theirs = await set(mediaId, DRIVE, null, consultantToken, {}, ending);
    expect((await http().post(`${visits()}/${ending}/end`).set('Authorization', `Bearer ${consultantToken}`).send({ claimedAt: ago(0) })).status).toBe(201);
    // the file rule this follows: their own file, within the hour, on the ended visit is the PMC's to remove
    expect((await fileOf(mediaId, consultantToken, ending)).fullVideoLinkOffer).toBeNull();
    const replace = await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: theirs }, consultantToken, undefined, ending);
    expect(replace.status, replace.text).toBe(409);
    expect(replace.body.message).toBe('This site visit has ended; ask the PMC to change the link');
    const off = await http().delete(linkPath(mediaId, ending)).set('Authorization', `Bearer ${consultantToken}`).send({ linkId: theirs });
    expect(off.status, off.text).toBe(409);
    const fileOff = await http().post(`/projects/${f.projectA.id}/media/${mediaId}/visit-removal`).set('Authorization', `Bearer ${consultantToken}`).send({});
    expect(fileOff.status).toBe(409);
    expect((await links(mediaId)).filter((r) => r.endedAt === null).map((r) => r.id)).toEqual([theirs]);
    // the PMC changes it, with a reason
    expect((await fileOf(mediaId, pmcToken, ending)).fullVideoLinkOffer).toMatchObject({ reasonRequired: true });
    const pmc = await http().put(linkPath(mediaId, ending)).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: randomUUID(), url: ZOHO, replaces: theirs, reason: 'Right video' });
    expect(pmc.status, pmc.text).toBe(200);
  });

  it('who may not act at all gets 403 before any stale-link check (G4)', async () => {
    const mediaId = await clip();
    const pmcs = await set(mediaId, DRIVE, null);
    // the engineer is not on the visit and did not add the clip: a stale `replaces` or an unknown link is still a 403
    const stale = await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: null }, engineerToken);
    expect(stale.status, stale.text).toBe(403);
    expect((await del(mediaId, { linkId: randomUUID() }, engineerToken)).status).toBe(403);
    expect((await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: pmcs }, engineerToken)).status).toBe(403);
    // a role the routes never let in (an architect) is offered nothing: no member can hold that role yet (the database
    // reserves it), so `site-visit-link-offer.test.ts` proves it on the read's own function
  });

  it('a retired attendee links the clip they added, not anyone else\'s (G2)', async () => {
    const attendeeId = await attend(engineer, 'engineer');
    const own = await clip(engineerToken);
    const pmcClip = await clip();
    expect((await http().post(`${visits()}/${visitId}/attendees/${attendeeId}/retire`).set('Authorization', `Bearer ${pmcToken}`).send({})).status).toBe(201);
    // their own clip: the adder rule
    expect((await fileOf(own, engineerToken)).fullVideoLinkOffer).toMatchObject({ reasonRequired: false });
    await set(own, DRIVE, null, engineerToken);
    // someone else's clip: no longer on the visit
    expect((await fileOf(pmcClip, engineerToken)).fullVideoLinkOffer).toBeNull();
    const res = await put(pmcClip, { id: randomUUID(), url: DRIVE, replaces: null }, engineerToken);
    expect(res.status, res.text).toBe(403);
  });

  it('a client mistake is a 400, never a 500: a lone surrogate in a label or reason, a NUL or a bad id in the path (G3)', async () => {
    const mediaId = await clip();
    const label = await put(mediaId, { id: randomUUID(), url: DRIVE, replaces: null, label: 'Pour \ud800' });
    expect(label.status, label.text).toBe(400);
    const id = await set(mediaId, DRIVE, null, consultantToken);
    const reason = await put(mediaId, { id: randomUUID(), url: ZOHO, replaces: id, reason: 'Wrong \udc00 one' });
    expect(reason.status, reason.text).toBe(400);
    const endReason = await del(mediaId, { linkId: id, reason: '\ud83d' });
    expect(endReason.status, endReason.text).toBe(400);
    for (const path of [linkPath('ab%00cd'), linkPath(mediaId, 'ab%00cd'), linkPath(mediaId, 'not-a-visit')]) {
      const res = await http().put(path).set('Authorization', `Bearer ${pmcToken}`).send({ id: randomUUID(), url: DRIVE, replaces: id });
      expect(res.status, `${path}: ${res.text}`).toBe(400);
      expect((await http().delete(path).set('Authorization', `Bearer ${pmcToken}`).send({ linkId: id })).status).toBe(400);
    }
    expect((await links(mediaId)).filter((r) => r.endedAt === null).map((r) => r.id)).toEqual([id]);
  });
});
