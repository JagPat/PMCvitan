import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #1179 R1, the database half of "remove a mistaken or misused visit file": `20280125000000_site_visit_file_removal`
 * adds "SiteVisitFileRemoval", the frozen line a visit keeps for a file taken off it, and makes the database require it
 * whenever a file's delete takes its link. No server or screen writes it yet; this proves what PostgreSQL holds on every
 * writer (R1-R8 in the migration's header), and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280125000000_site_visit_file_removal/migration.sql');

describe('#1179 R1 — a visit file\'s removal line (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let visitA: string;
  let visitB: string;
  let consultant: string;
  const run = randomUUID().slice(0, 8);

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
    consultant = `svrm-cons-${run}`;
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    visitB = randomUUID();
    const second = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/site-visits`)
      .set('Authorization', `Bearer ${t.issueProjectToken(consultant, f.projectA.id, 'consultant')}`)
      .send({ id: visitB, claimedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    expect(second.status).toBe(201);
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitFileRemoval', 'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: consultant } });
      await t.prisma.user.deleteMany({ where: { id: consultant } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const file = (mime = 'image/jpeg', projectId = f.projectA.id) => t.prisma.media.create({
    data: { projectId, kind: 'visit', mime, data: Buffer.from([0x00]), sizeBytes: 1, uploadedBy: f.memberUser.id },
  });
  /** a file on a visit, added by `by` acting as `role` */
  const onVisit = async (opts: { mime?: string; visitId?: string; by?: string; role?: string } = {}) => {
    const m = await file(opts.mime);
    await t.prisma.siteVisitMedia.create({
      data: { projectId: f.projectA.id, visitId: opts.visitId ?? visitA, mediaId: m.id, addedById: opts.by ?? f.memberUser.id, addedByRole: opts.role ?? 'pmc' },
    });
    return m;
  };
  /** the removal as the server will write it: the record, then the file's delete, in one transaction */
  const remove = (mediaId: string, by: string, role: string, reason: string | null) => t.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
      VALUES (${f.projectA.id}, ${visitA}, ${mediaId}, ${by}, ${role}, ${reason})`;
    await tx.media.delete({ where: { id: mediaId } });
  });
  /** backdate a link past the hour; the link is frozen, so its update seal is lifted inside this one transaction */
  const backdate = (mediaId: string) => t.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMedia" DISABLE TRIGGER "SiteVisitMedia_update"');
    await tx.$executeRaw`UPDATE "SiteVisitMedia" SET "addedAt" = "addedAt" - interval '61 minutes' WHERE "mediaId" = ${mediaId}`;
    await tx.$executeRawUnsafe('ALTER TABLE "SiteVisitMedia" ENABLE TRIGGER "SiteVisitMedia_update"');
  });
  const nameOf = async (userId: string) => (await t.prisma.$queryRaw<Array<{ n: string }>>`
    SELECT "displayName" AS n FROM "UserIdentity" WHERE "userId" = ${userId}`)[0]!.n;

  it('the adder removes their own file within the hour with no reason: the link goes and the line is kept, copied from the link', async () => {
    const m = await onVisit({ mime: 'audio/webm', visitId: visitB, by: consultant, role: 'consultant' });
    const link = await t.prisma.siteVisitMedia.findUniqueOrThrow({ where: { mediaId: m.id } });
    const before = Date.now();
    await t.prisma.$transaction(async (tx) => {
      // the writer sends the wrong visit, kind, adder and times: each is replaced by the database
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","fileKind","addedById","addedByRole","addedByName","addedAt",
          "removedById","removedByRole","removedByName","removedAt")
        VALUES (${f.projectA.id}, ${visitA}, ${m.id}, 'photo', ${f.memberUser.id}, 'pmc', 'Spoofed', '2020-01-01',
          ${consultant}, 'consultant', 'Spoofed', '2020-01-01')`;
      await tx.media.delete({ where: { id: m.id } });
    });
    expect(await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id } })).toBeNull();
    const row = await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: m.id } });
    expect(row).toMatchObject({
      projectId: f.projectA.id, visitId: visitB, fileKind: 'voice',
      addedById: consultant, addedByRole: 'consultant', addedByName: link.addedByName, addedAt: link.addedAt,
      removedById: consultant, removedByRole: 'consultant', removedByName: await nameOf(consultant), reason: null,
    });
    expect(row.removedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.removedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(await t.prisma.siteVisit.findUnique({ where: { id: visitB }, select: { id: true } })).toEqual({ id: visitB });
  });

  it('the kind is the file\'s type: photo, voice, video, or file', async () => {
    for (const [mime, kind] of [['image/png', 'photo'], ['audio/mp4', 'voice'], ['video/webm', 'video'], ['application/pdf', 'file']] as const) {
      const m = await onVisit({ mime });
      await remove(m.id, f.memberUser.id, 'pmc', null);
      expect((await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: m.id } })).fileKind, mime).toBe(kind);
    }
  });

  it('anyone else\'s removal, or the adder\'s after the hour, needs a reason; with one, the PMC removes another\'s file', async () => {
    const theirs = await onVisit({ visitId: visitB, by: consultant, role: 'consultant' });
    await expect(remove(theirs.id, f.memberUser.id, 'pmc', null)).rejects.toThrow(/SiteVisitFileRemoval_shape_check/);
    const late = await onVisit({ by: consultant, role: 'consultant' });
    await backdate(late.id);
    await expect(remove(late.id, consultant, 'consultant', null)).rejects.toThrow(/SiteVisitFileRemoval_shape_check/);
    // nothing of a refused removal is kept
    for (const id of [theirs.id, late.id]) {
      expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: id } })).toBe(1);
      expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: id } })).toBe(0);
    }
    await remove(theirs.id, f.memberUser.id, 'pmc', 'Recorded by mistake');
    expect(await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: theirs.id } }))
      .toMatchObject({ addedById: consultant, removedById: f.memberUser.id, removedByRole: 'pmc', reason: 'Recorded by mistake' });
  });

  it('a reason is never blank and holds 300 characters, not 301', async () => {
    for (const blank of ['', ' ', '\t\n\r', '\x0B\f']) {
      const m = await onVisit();
      await expect(remove(m.id, f.memberUser.id, 'pmc', blank), JSON.stringify(blank)).rejects.toThrow(/SiteVisitFileRemoval_shape_check/);
    }
    await expect(remove((await onVisit()).id, f.memberUser.id, 'pmc', 'x'.repeat(301))).rejects.toThrow(/too long/);
    const m = await onVisit();
    await remove(m.id, f.memberUser.id, 'pmc', 'x'.repeat(300));
    expect((await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: m.id } })).reason).toHaveLength(300);
  });

  it('the remover must hold the role they act in on the project, and is recorded under their name as they stood', async () => {
    const m = await onVisit();
    await expect(remove(m.id, f.clientUser.id, 'pmc', 'Not theirs')).rejects.toThrow(/does not hold role/);
    await expect(remove(m.id, f.memberUser.id, 'client', 'Not held')).rejects.toThrow(/does not hold role/);
    await expect(remove(m.id, f.otherUser.id, 'pmc', 'Other project')).rejects.toThrow(/does not hold role/);
    expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: m.id } })).toBe(1);
  });

  it('a file that is not on a visit of the project has no removal to record', async () => {
    const loose = await file();
    await expect(remove(loose.id, f.memberUser.id, 'pmc', 'Loose')).rejects.toThrow(/is not on a site visit/);
    const elsewhere = await file('image/jpeg', f.projectB.id);
    await expect(remove(elsewhere.id, f.memberUser.id, 'pmc', 'Elsewhere')).rejects.toThrow(/is not on a site visit/);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
      VALUES (${f.projectA.id}, ${visitA}, ${`missing-${run}`}, ${f.memberUser.id}, 'pmc', 'Gone')`).rejects.toThrow(/is not on a site visit/);
  });

  it('a file\'s delete that would take its link is refused without the line, on every writer; the file stays on the visit', async () => {
    const m = await onVisit();
    const recorded = /removed only with a record of who removed it/;
    await expect(t.prisma.media.delete({ where: { id: m.id } })).rejects.toThrow(recorded);
    await expect(t.prisma.$executeRaw`DELETE FROM "Media" WHERE "id" = ${m.id}`).rejects.toThrow(recorded);
    expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: m.id } })).toBe(1);
    // a direct DELETE of the link is still SV2's refusal, line or no line
    await expect(t.prisma.$executeRaw`DELETE FROM "SiteVisitMedia" WHERE "mediaId" = ${m.id}`).rejects.toThrow(/part of the visit record/);
  });

  it('a line commits only if its file really leaves the visit', async () => {
    const m = await onVisit();
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
        VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${f.memberUser.id}, 'pmc', 'Kept anyway')`;
    })).rejects.toThrow(/was recorded but the file is still on visit/);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: m.id } })).toBe(0);
  });

  it('a line is frozen: never changed, deleted on its own or truncated, and a file is removed once', async () => {
    const m = await onVisit();
    await remove(m.id, f.memberUser.id, 'pmc', 'Wrong place');
    const frozen = /part of the visit record and is not changed or removed/;
    for (const set of [`"reason" = 'Other'`, `"removedById" = '${f.clientUser.id}'`, `"removedAt" = now()`, `"visitId" = '${visitB}'`, `"fileKind" = 'video'`]) {
      await expect(t.prisma.$executeRawUnsafe(`UPDATE "SiteVisitFileRemoval" SET ${set} WHERE "mediaId" = $1`, m.id), set).rejects.toThrow(frozen);
    }
    await expect(t.prisma.$executeRaw`DELETE FROM "SiteVisitFileRemoval" WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.siteVisitFileRemoval.delete({ where: { mediaId: m.id } })).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE "SiteVisitFileRemoval"')).rejects.toThrow(/never truncated/);
    expect(await t.prisma.siteVisitFileRemoval.findUniqueOrThrow({ where: { mediaId: m.id } })).toMatchObject({ reason: 'Wrong place' });
  });

  // Two sessions on separate connections, as SV2's races: `held` removes inside an interactive transaction and waits on
  // a gate; the second removal is dispatched on another pooled connection and observed blocked before release.
  const gate = () => { let open!: () => void; const promise = new Promise<void>((r) => (open = r)); return { promise, open }; };
  const reflect = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }));
  const waitUntilBlocked = async () => {
    for (let i = 0; i < 200; i++) {
      const [row] = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%INSERT INTO%SiteVisitFileRemoval%'`);
      if (Number(row!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the second removal never blocked');
  };

  it('two removals of one file, both written before either deletes: the second waits on the visit, then is refused, and one line stands', async () => {
    const m = await onVisit();
    const recorded = gate();
    const release = gate();
    const held = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Media" WHERE "id" = ${m.id} FOR UPDATE`;
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
        VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${f.memberUser.id}, 'pmc', 'First')`;
      recorded.open();
      await release.promise;
      await tx.media.delete({ where: { id: m.id } });
    }, { timeout: 20_000 });
    await recorded.promise;
    const second = reflect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
        VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${f.memberUser.id}, 'pmc', 'Second')`;
      await tx.media.delete({ where: { id: m.id } });
    }, { timeout: 20_000 }));
    await waitUntilBlocked();
    release.open();
    await held;
    const out = await second;
    expect(out.ok).toBe(false);
    expect(String(out.ok ? '' : out.reason)).toMatch(/is not on a site visit/);
    expect(await t.prisma.siteVisitFileRemoval.findMany({ where: { mediaId: m.id }, select: { reason: true } })).toEqual([{ reason: 'First' }]);
  });

  it('a removal racing another write on the same visit waits for it in the visit\'s lock order, and both commit (no deadlock)', async () => {
    const x = await onVisit();
    const y = await file();
    const locked = gate();
    const release = gate();
    // a file's add on the same visit: the visit row first (the server judges under it), then the link insert, which
    // takes the project row and the adder's identity
    const adding = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "SiteVisit" WHERE "id" = ${visitA} FOR UPDATE`;
      locked.open();
      await release.promise;
      await tx.siteVisitMedia.create({ data: { projectId: f.projectA.id, visitId: visitA, mediaId: y.id, addedById: f.memberUser.id, addedByRole: 'pmc' } });
    }, { timeout: 20_000 });
    await locked.promise;
    // the removal as the server unit will write it: the file row first, then the line, then the delete
    const removing = reflect(t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Media" WHERE "id" = ${x.id} FOR UPDATE`;
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
        VALUES (${f.projectA.id}, ${visitA}, ${x.id}, ${f.memberUser.id}, 'pmc', 'Race')`;
      await tx.media.delete({ where: { id: x.id } });
    }, { timeout: 20_000 }));
    await waitUntilBlocked();
    release.open();
    await adding;
    const out = await removing;
    expect(out.ok ? 'committed' : String(out.reason)).toBe('committed');
    expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: y.id } })).toBe(1);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: x.id } })).toBe(1);
  });

  const waitUntilBlockedOn = async (pattern: string) => {
    for (let i = 0; i < 200; i++) {
      const [row] = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`, pattern);
      if (Number(row!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no statement like ${pattern} ever blocked`);
  };

  it('a removal written before an unrecorded delete of the same file starts: the delete waits on the file, the removal commits (no deadlock)', async () => {
    const m = await onVisit();
    const recorded = gate();
    const release = gate();
    // a raw writer's removal that takes no lock of its own before the line
    const removing = t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "SiteVisitFileRemoval" ("projectId","visitId","mediaId","removedById","removedByRole","reason")
        VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${f.memberUser.id}, 'pmc', 'Recorded')`;
      recorded.open();
      await release.promise;
      await tx.$executeRaw`DELETE FROM "Media" WHERE "id" = ${m.id}`;
    }, { timeout: 20_000 });
    await recorded.promise;
    // a delete with no record: it locks the file, then its cascade reaches the link
    const bare = reflect(t.prisma.$executeRaw`DELETE FROM "Media" WHERE "id" = ${m.id} AND 'svrm-bare' = 'svrm-bare'`);
    await waitUntilBlockedOn('%svrm-bare%');
    release.open();
    await removing;
    const out = await bare;
    expect(out.ok ? out.value : String(out.reason)).toBe(0);
    expect(await t.prisma.siteVisitFileRemoval.count({ where: { mediaId: m.id } })).toBe(1);
  });

  it('a removed file id recreated by a raw writer is never put on a visit again, so it cannot leave on the old line (R9)', async () => {
    const m = await onVisit({ mime: 'audio/webm' });
    await remove(m.id, f.memberUser.id, 'pmc', null);
    await t.prisma.media.create({
      data: { id: m.id, projectId: f.projectA.id, kind: 'visit', mime: 'audio/webm', data: Buffer.from([0x00]), sizeBytes: 1, uploadedBy: f.memberUser.id },
    });
    await expect(t.prisma.siteVisitMedia.create({
      data: { projectId: f.projectA.id, visitId: visitA, mediaId: m.id, addedById: f.memberUser.id, addedByRole: 'pmc' },
    })).rejects.toThrow(/was removed from a site visit and is not added to one again/);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","addedById","addedByRole")
      VALUES (${f.projectA.id}, ${visitB}, ${m.id}, ${f.memberUser.id}, 'pmc')`).rejects.toThrow(/is not added to one again/);
    await t.prisma.media.delete({ where: { id: m.id } });
  });

  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });

  it('the migration re-runs as a no-op, and repairs what a db push baseline leaves out', async () => {
    const before = await t.prisma.siteVisitFileRemoval.count();
    replay();
    replay();
    expect(await t.prisma.siteVisitFileRemoval.count()).toBe(before);
    // what Prisma's `db push` creates: the table and its keys, no triggers and no CHECK
    for (const [table, trigger] of [['SiteVisitFileRemoval', 'SiteVisitFileRemoval_insert'], ['SiteVisitFileRemoval', 'SiteVisitFileRemoval_done'],
      ['SiteVisitFileRemoval', 'SiteVisitFileRemoval_frozen'], ['SiteVisitFileRemoval', 'SiteVisitFileRemoval_no_truncate'],
      ['SiteVisitMedia', 'SiteVisitMedia_removal_recorded'], ['SiteVisitMedia', 'SiteVisitMedia_not_removed']]) {
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "${table}"`);
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitFileRemoval" DROP CONSTRAINT "SiteVisitFileRemoval_shape_check"`);
    // another table holding a constraint of the same name (a recovery copy) does not stand in for this one's
    await t.prisma.$executeRawUnsafe(`CREATE TABLE "SvrmDecoy_${run}" ("x" TEXT, CONSTRAINT "SiteVisitFileRemoval_shape_check" CHECK ("x" <> ''))`);
    try {
      replay();
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TABLE "SvrmDecoy_${run}"`);
    }
    const triggers = async (table: string) => (await t.prisma.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT tgname AS n FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgenabled = 'O' ORDER BY tgname`, `"${table}"`)).map((r) => r.n);
    expect(await triggers('SiteVisitFileRemoval')).toEqual(['SiteVisitFileRemoval_done', 'SiteVisitFileRemoval_frozen', 'SiteVisitFileRemoval_insert', 'SiteVisitFileRemoval_no_truncate']);
    expect(await triggers('SiteVisitMedia')).toEqual(expect.arrayContaining(['SiteVisitMedia_removal_recorded', 'SiteVisitMedia_not_removed']));
    const [{ d }] = await t.prisma.$queryRaw<Array<{ d: string }>>`
      SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
       WHERE conrelid = '"SiteVisitFileRemoval"'::regclass AND conname = 'SiteVisitFileRemoval_shape_check'`;
    expect(d).toMatch(/btrim/);
    // the visit key cascades, so the line goes with its visit's project and nothing else
    const [{ del }] = await t.prisma.$queryRaw<Array<{ del: string }>>`
      SELECT confdeltype::text AS del FROM pg_constraint WHERE conname = 'SiteVisitFileRemoval_projectId_visitId_fkey'`;
    expect(del).toBe('c');
  });
});
