import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Video on site visits, V2g-0: `20280213000000_site_visit_media_link` adds "SiteVisitMediaLink", a share link on a
 * visit's video clip to its full-quality video in Google Drive or Zoho WorkDrive. No server or screen writes it yet;
 * this proves what PostgreSQL holds on every writer (K1-K8 in the migration's header), and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280213000000_site_visit_media_link/migration.sql');

describe('video V2g-0: a clip\'s full-video link (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let visitA: string;
  let consultant: string;
  const run = randomUUID().slice(0, 8);
  const DRIVE = 'https://drive.google.com/file/d/1AbCdEf/view?usp=sharing';
  const ZOHO = 'https://workdrive.zohopublic.in/file/abc123';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    visitA = randomUUID();
    const started = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/site-visits`)
      .set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id)}`)
      .send({ id: visitA, claimedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    expect(started.status).toBe(201);
    consultant = `svml-cons-${run}`;
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMediaLink', 'SiteVisitFileRemoval', 'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: consultant } });
      await t.prisma.user.deleteMany({ where: { id: consultant } });
    }
    await f?.cleanup();
    await t?.close();
  });

  /** a file on visit A, added by the PMC */
  const onVisit = async (mime = 'video/webm') => {
    const m = await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'visit', mime, data: Buffer.from([0x00]), sizeBytes: 1, uploadedBy: f.memberUser.id },
    });
    await t.prisma.siteVisitMedia.create({
      data: { projectId: f.projectA.id, visitId: visitA, mediaId: m.id, addedById: f.memberUser.id, addedByRole: 'pmc' },
    });
    return m.id;
  };
  const add = (mediaId: string, url = DRIVE, by = f.memberUser.id, role = 'pmc', id = randomUUID(), projectId = f.projectA.id) =>
    t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMediaLink" ("id","projectId","mediaId","url","host","addedById","addedByRole")
      VALUES (${id}, ${projectId}, ${mediaId}, ${url}, 'drive', ${by}, ${role})`.then(() => id);
  const end = (id: string, by: string, role: string, reason: string | null) => t.prisma.$executeRaw`
    UPDATE "SiteVisitMediaLink" SET "endedById" = ${by}, "endedByRole" = ${role}, "reason" = ${reason} WHERE "id" = ${id}`;
  const row = (id: string) => t.prisma.siteVisitMediaLink.findUniqueOrThrow({ where: { id } });
  const current = (mediaId: string) => t.prisma.siteVisitMediaLink.count({ where: { mediaId, endedAt: null } });
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  const nameOf = async (userId: string) => (await t.prisma.$queryRaw<Array<{ n: string }>>`
    SELECT "displayName" AS n FROM "UserIdentity" WHERE "userId" = ${userId}`)[0]!.n;
  const record = /is a record; a current link is only ended/;

  it('a Drive or Zoho link goes on a video clip, its host, adder\'s name and time set by the database', async () => {
    const clip = await onVisit();
    const before = Date.now();
    const id = randomUUID();
    await t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMediaLink" ("id","projectId","mediaId","url","host","label","addedById","addedByRole","addedByName","addedAt")
      VALUES (${id}, ${f.projectA.id}, ${clip}, ${ZOHO}, 'drive', 'Slab pour, full', ${consultant}, 'consultant', 'Spoofed', '2020-01-01')`;
    const r = await row(id);
    expect(r).toMatchObject({ mediaId: clip, url: ZOHO, host: 'zoho', label: 'Slab pour, full', addedById: consultant,
      addedByName: await nameOf(consultant), endedAt: null, reason: null });
    expect(r.addedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    const other = await onVisit();
    expect((await row(await add(other, DRIVE))).host).toBe('drive');
    const listed = await t.prisma.siteVisitMedia.findUniqueOrThrow({ where: { mediaId: clip }, select: { links: { select: { id: true } } } });
    expect(listed.links).toEqual([{ id }]);
  });

  it('only https links on the allowed hosts are kept: no other host, userinfo, port, lookalike, space or scheme', async () => {
    const clip = await onVisit();
    const allowed = ['https://drive.google.com/drive/folders/1xyz', 'https://drive.google.com/file/d/1/view',
      'https://workdrive.zoho.com/file/a', 'https://workdrive.zoho.in/folder/b', 'https://workdrive.zoho.eu/file/c',
      'https://workdrive.zohopublic.com/file/d', 'https://workdrive.zohopublic.eu/file/e'];
    for (const ok of allowed) {
      const id = await add(clip, ok);
      await end(id, f.memberUser.id, 'pmc', null);
    }
    const refused = ['http://drive.google.com/file/d/1', 'https://drive.google.com.evil.io/file', 'https://evil.io/drive.google.com/',
      'https://user@drive.google.com/file', 'https://drive.google.com:8443/file', 'https://DRIVE.google.com/file',
      'https://drive.google.com', 'https://drive.google.com/file d', 'https://drive.google.com/file\n',
      'javascript:alert(1)//https://drive.google.com/', 'https://x.zohopublic.in/file', 'https://workdrive.zoho.jp/file',
      `https://drive.google.com/${'a'.repeat(1990)}`,
      // docs.google.com also serves Forms and /url redirects: a Drive share is always on drive.google.com
      'https://docs.google.com/file/d/1/edit', 'https://docs.google.com/url?q=https://evil.io',
      // Unicode spaces, which a POSIX class may not count as space under every database locale
      'https://drive.google.com/file\u00A0d', 'https://drive.google.com/file\u200Bd',
      'https://drive.google.com/fil\u00E9'];
    for (const bad of refused) {
      await expect(add(clip, bad), bad).rejects.toThrow(/SiteVisitMediaLink_shape_check|value too long/);
    }
    expect(await current(clip)).toBe(0);
  });

  it('a file that is not a video, not on a visit, or of another project takes no link', async () => {
    await expect(add(await onVisit('audio/webm'))).rejects.toThrow(/is not a video/);
    await expect(add(await onVisit('image/jpeg'))).rejects.toThrow(/is not a video/);
    const loose = await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'visit', mime: 'video/webm', data: Buffer.from([0x00]), sizeBytes: 1, uploadedBy: f.memberUser.id },
    });
    await expect(add(loose.id)).rejects.toThrow(/is not on a site visit/);
    const clip = await onVisit();
    await expect(add(clip, DRIVE, f.otherUser.id, 'pmc', randomUUID(), f.projectB.id)).rejects.toThrow(/is not on a site visit/);
  });

  it('checks the adder\'s role on the project and refuses an archived project', async () => {
    const clip = await onVisit();
    await expect(add(clip, DRIVE, consultant, 'pmc')).rejects.toThrow(/does not hold role pmc/);
    await expect(add(clip, DRIVE, f.otherUser.id, 'pmc')).rejects.toThrow(/does not hold role pmc/);
    await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = now() WHERE "id" = ${f.projectA.id}`;
    try {
      await expect(add(clip)).rejects.toThrow(/is not operable/);
    } finally {
      await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = ${f.projectA.id}`;
    }
    expect(await current(clip)).toBe(0);
  });

  it('a link is added current: one sent already ended is refused', async () => {
    const clip = await onVisit();
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMediaLink" ("id","projectId","mediaId","url","host","addedById","addedByRole","endedById","endedByRole","reason")
      VALUES (${randomUUID()}, ${f.projectA.id}, ${clip}, ${DRIVE}, 'drive', ${f.memberUser.id}, 'pmc', ${f.memberUser.id}, 'pmc', 'x')`)
      .rejects.toThrow(/is added current/);
  });

  it('one current link per clip; a replace ends the current one first and keeps it as history', async () => {
    const clip = await onVisit();
    const first = await add(clip);
    await expect(add(clip, ZOHO)).rejects.toThrow(/SiteVisitMediaLink_one_current_per_file|Unique constraint|23505/);
    let second = '';
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "SiteVisitMediaLink" SET "endedById" = ${f.memberUser.id}, "endedByRole" = 'pmc' WHERE "id" = ${first}`;
      second = randomUUID();
      await tx.$executeRaw`
        INSERT INTO "SiteVisitMediaLink" ("id","projectId","mediaId","url","host","addedById","addedByRole")
        VALUES (${second}, ${f.projectA.id}, ${clip}, ${ZOHO}, 'zoho', ${f.memberUser.id}, 'pmc')`;
    });
    expect(await current(clip)).toBe(1);
    expect((await row(first)).endedAt).not.toBeNull();
    expect((await row(second)).endedAt).toBeNull();
  });

  it('two writers adding a current link at once: one is kept, the other is refused, never two', async () => {
    const clip = await onVisit();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const firstIn = new Promise<void>((r) => { inserted = r; });
    const firstTx = t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "SiteVisitMediaLink" ("id","projectId","mediaId","url","host","addedById","addedByRole")
        VALUES (${randomUUID()}, ${f.projectA.id}, ${clip}, ${DRIVE}, 'drive', ${f.memberUser.id}, 'pmc')`;
      inserted();
      await held;
    }, { timeout: 60_000 });
    // a first insert that fails never reaches `inserted()`: let the test go on and report it rather than hang
    void firstTx.catch(() => undefined).finally(() => inserted());
    await firstIn;
    let settled = false;
    // a different adder, so the second insert can only wait on the first's index entry, never on the adder's identity
    const secondTx = add(clip, ZOHO, consultant, 'consultant').then(() => 'kept', (e: Error) => e.message).finally(() => { settled = true; });
    // the second insert waits on the first's uncommitted index entry: wait for that lock wait (or for the second to end
    // without one, which the assertions below then report), then let the first commit
    for (;;) {
      if (settled) break;
      const waiting = await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO "SiteVisitMediaLink"%'`;
      if (waiting[0]!.n > 0) break;
      await new Promise((r) => setImmediate(r));
    }
    release();
    await firstTx;
    expect(await secondTx).toMatch(/SiteVisitMediaLink_one_current_per_file|Unique constraint|23505/);
    expect(await current(clip)).toBe(1);
  });

  it('the adder ends their own link within the hour with no reason; anyone else, or after the hour, needs one', async () => {
    const clip = await onVisit();
    const own = await add(clip, DRIVE, consultant, 'consultant');
    await expect(end(own, f.memberUser.id, 'pmc', null)).rejects.toThrow(/SiteVisitMediaLink_shape_check/);
    await expect(end(own, f.memberUser.id, 'pmc', '  ')).rejects.toThrow(/SiteVisitMediaLink_shape_check/);
    await end(own, consultant, 'consultant', null);
    const ended = await row(own);
    expect(ended).toMatchObject({ endedById: consultant, endedByRole: 'consultant', endedByName: await nameOf(consultant), reason: null });
    expect(ended.endedAt!.getTime()).toBeGreaterThanOrEqual(ended.addedAt.getTime());

    const theirs = await add(clip, ZOHO, consultant, 'consultant');
    await end(theirs, f.memberUser.id, 'pmc', 'Wrong video linked');
    expect(await row(theirs)).toMatchObject({ endedById: f.memberUser.id, reason: 'Wrong video linked', endedByName: await nameOf(f.memberUser.id) });

    const late = await add(clip);
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMediaLink" DISABLE TRIGGER "SiteVisitMediaLink_end"');
      await tx.$executeRaw`UPDATE "SiteVisitMediaLink" SET "addedAt" = "addedAt" - interval '61 minutes' WHERE "id" = ${late}`;
      await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMediaLink" ENABLE TRIGGER "SiteVisitMediaLink_end"');
    });
    await expect(end(late, f.memberUser.id, 'pmc', null)).rejects.toThrow(/SiteVisitMediaLink_shape_check/);
    await end(late, f.memberUser.id, 'pmc', 'Replaced with the edited cut');
    // the ender's role is checked as the adder's is
    const another = await add(clip);
    await expect(end(another, consultant, 'pmc', 'x')).rejects.toThrow(/does not hold role pmc/);
  });

  it('nothing else changes: not the url, the adder, the times, nor an ended link', async () => {
    const clip = await onVisit();
    const id = await add(clip);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "url" = ${ZOHO} WHERE "id" = ${id}`).rejects.toThrow(record);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "addedById" = ${consultant} WHERE "id" = ${id}`).rejects.toThrow(record);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "addedAt" = '2020-01-01' WHERE "id" = ${id}`).rejects.toThrow(record);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "label" = 'x' WHERE "id" = ${id}`).rejects.toThrow(record);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "endedByRole" = 'pmc' WHERE "id" = ${id}`).rejects.toThrow(record);
    await end(id, f.memberUser.id, 'pmc', null);
    await expect(end(id, f.memberUser.id, 'pmc', 'again')).rejects.toThrow(record);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "endedAt" = NULL WHERE "id" = ${id}`).rejects.toThrow(record);
  });

  it('a link is never deleted or truncated on its own', async () => {
    const clip = await onVisit();
    const id = await add(clip);
    await expect(t.prisma.$executeRaw`DELETE FROM "SiteVisitMediaLink" WHERE "id" = ${id}`).rejects.toThrow(/part of the visit record/);
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE "SiteVisitMediaLink"`)).rejects.toThrow(/never truncated/);
  });

  it('a removed clip takes its links with it, and its id never takes a new one', async () => {
    const clip = await onVisit();
    const old = await add(clip);
    await end(old, f.memberUser.id, 'pmc', null);
    await add(clip, ZOHO);
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
        VALUES (${f.projectA.id}, ${visitA}, ${clip}, ${f.memberUser.id}, 'pmc', NULL)`;
      await tx.media.delete({ where: { id: clip } });
    });
    expect(await t.prisma.siteVisitMediaLink.count({ where: { mediaId: clip } })).toBe(0);
    await expect(add(clip)).rejects.toThrow(/is not on a site visit/);
  });

  it('the file re-runs on a database that has it, re-making a lost trigger, check and index and changing no row', async () => {
    const clip = await onVisit();
    const id = await add(clip);
    const before = await row(id);
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "SiteVisitMediaLink_end" ON "SiteVisitMediaLink"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMediaLink" DROP CONSTRAINT "SiteVisitMediaLink_shape_check"`);
    await t.prisma.$executeRawUnsafe(`DROP INDEX "SiteVisitMediaLink_one_current_per_file"`);
    await t.prisma.$executeRawUnsafe(`CREATE INDEX "SiteVisitMediaLink_one_current_per_file" ON "SiteVisitMediaLink"("mediaId")`);
    replay();
    const objects = await t.prisma.$queryRawUnsafe<Array<{ triggers: number; keys: number; checks: number; index: number }>>(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = '"SiteVisitMediaLink"'::regclass AND NOT tgisinternal) AS triggers,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = '"SiteVisitMediaLink"'::regclass AND contype = 'f') AS keys,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = '"SiteVisitMediaLink"'::regclass AND conname = 'SiteVisitMediaLink_shape_check') AS checks,
              (SELECT count(*)::int FROM pg_indexes WHERE indexname = 'SiteVisitMediaLink_one_current_per_file'
                 AND indexdef LIKE 'CREATE UNIQUE INDEX%WHERE ("endedAt" IS NULL)') AS index`);
    expect(objects[0]).toEqual({ triggers: 4, keys: 3, checks: 1, index: 1 });
    expect(await row(id)).toEqual(before);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMediaLink" SET "url" = ${ZOHO} WHERE "id" = ${id}`).rejects.toThrow(record);
    await expect(add(clip, ZOHO)).rejects.toThrow(/SiteVisitMediaLink_one_current_per_file|Unique constraint|23505/);
  });

  it('a table standing with another shape is refused, and a key with another delete action is replaced', async () => {
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMediaLink" ALTER COLUMN "addedById" DROP NOT NULL`);
    try {
      expect(replay).toThrow(/SiteVisitMediaLink.addedById already stands as text \(not null: f\)/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMediaLink" ALTER COLUMN "addedById" SET NOT NULL`);
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMediaLink" ADD COLUMN "extra" TEXT`);
    try {
      expect(replay).toThrow(/already stands with 16 columns, not 15/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMediaLink" DROP COLUMN "extra"`);
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMediaLink" DROP CONSTRAINT "SiteVisitMediaLink_projectId_mediaId_fkey",
      ADD CONSTRAINT "SiteVisitMediaLink_projectId_mediaId_fkey" FOREIGN KEY ("projectId", "mediaId") REFERENCES "SiteVisitMedia"("projectId", "mediaId")`);
    replay();
    const actions = await t.prisma.$queryRawUnsafe<Array<{ conname: string; confdeltype: string }>>(
      `SELECT conname, confdeltype::text FROM pg_constraint WHERE conrelid = '"SiteVisitMediaLink"'::regclass AND contype = 'f' ORDER BY conname`);
    expect(actions).toEqual([
      { conname: 'SiteVisitMediaLink_addedById_fkey', confdeltype: 'r' },
      { conname: 'SiteVisitMediaLink_endedById_fkey', confdeltype: 'r' },
      { conname: 'SiteVisitMediaLink_projectId_mediaId_fkey', confdeltype: 'c' },
    ]);
  });
});
