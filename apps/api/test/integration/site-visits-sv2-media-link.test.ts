import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Site Visits (#792) SV2, the database half of "media on a visit": `20280114000000_site_visits_sv2_visit_media` adds
 * "SiteVisitMedia", one row per file added on a visit (with an optional never-blank note of at most 500 characters, an
 * optional Fine / Concern / Action needed rating, the place it showed when added, who added it and when).
 * No server or screen writes it yet; this proves what PostgreSQL holds on every writer, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280114000000_site_visits_sv2_visit_media/migration.sql');

describe('Site Visits SV2 — files on a visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let visitA: string;
  let visitB: string;
  let consultant: string;
  let place: { id: string; name: string };
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
    // a second open visit in the same project, by another visitor (one open visit per visitor)
    consultant = `sv2m-cons-${run}`;
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    visitB = randomUUID();
    const second = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/site-visits`)
      .set('Authorization', `Bearer ${t.issueProjectToken(consultant, f.projectA.id, 'consultant')}`)
      .send({ id: visitB, claimedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    expect(second.status).toBe(201);
    const n = await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Tower A ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
    });
    place = { id: n.id, name: n.name };
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id, name: { endsWith: run } } });
      await t.prisma.membership.deleteMany({ where: { userId: consultant } });
      await t.prisma.user.deleteMany({ where: { id: consultant } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const photo = (projectId: string, nodeId?: string) => t.prisma.media.create({
    data: { projectId, nodeId, kind: 'progress', mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]), sizeBytes: 3, uploadedBy: f.memberUser.id },
  });
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  const link = (projectId: string, visitId: string, mediaId: string, note?: string) => t.prisma.siteVisitMedia.create({
    data: { projectId, visitId, mediaId, note, addedById: f.memberUser.id },
  });

  it('a file in the visit\'s own project goes on the visit with a note, and the visit lists it', async () => {
    const m = await photo(f.projectA.id);
    const row = await link(f.projectA.id, visitA, m.id, 'Crack above the lintel, east wall');
    expect(row).toMatchObject({ visitId: visitA, mediaId: m.id, note: 'Crack above the lintel, east wall', addedById: f.memberUser.id });
    expect(row.addedAt).toBeInstanceOf(Date);
    const listed = await t.prisma.siteVisit.findUnique({ where: { id: visitA }, select: { media: { select: { mediaId: true } } } });
    expect(listed?.media.map((r) => r.mediaId)).toEqual([m.id]);
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id)).note).toBeNull();
  });

  it('a file belongs to at most one visit: another visit cannot take it, nor can the same one twice', async () => {
    const m = await photo(f.projectA.id);
    await link(f.projectA.id, visitA, m.id);
    await expect(link(f.projectA.id, visitB, m.id)).rejects.toThrow(/Unique constraint|SiteVisitMedia_pkey/i);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","addedById")
      VALUES (${f.projectA.id}, ${visitB}, ${m.id}, ${f.memberUser.id})`).rejects.toThrow(/SiteVisitMedia_pkey|23505|duplicate key/i);
    await expect(link(f.projectA.id, visitA, m.id)).rejects.toThrow(/Unique constraint|SiteVisitMedia_pkey/i);
    expect((await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id } }))?.visitId).toBe(visitA);
  });

  it('no writer can put another project\'s file on a visit, or a file on another project\'s visit', async () => {
    const other = await photo(f.projectB.id);
    await expect(link(f.projectA.id, visitA, other.id)).rejects.toThrow(/SiteVisitMedia_projectId_mediaId_fkey|Foreign key/i);
    await expect(link(f.projectB.id, visitA, other.id)).rejects.toThrow(/SiteVisitMedia_projectId_visitId_fkey|Foreign key/i);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","addedById")
      VALUES (${f.projectA.id}, ${visitA}, ${other.id}, ${f.memberUser.id})`)
      .rejects.toThrow(/SiteVisitMedia_projectId_mediaId_fkey|foreign key/i);
    await expect(link(f.projectA.id, randomUUID(), (await photo(f.projectA.id)).id)).rejects.toThrow(/SiteVisitMedia_projectId_visitId_fkey|Foreign key/i);
  });

  it('a note holds 500 characters and refuses a 501st', async () => {
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id, 'x'.repeat(500))).note).toHaveLength(500);
    await expect(link(f.projectA.id, visitA, (await photo(f.projectA.id)).id, 'x'.repeat(501))).rejects.toThrow();
  });

  it('a note is never blank: empty or whitespace-only is refused on every writer, raw SQL included', async () => {
    for (const blank of ['', ' ', '\t\n', ' \r\f\v ']) {
      await expect(link(f.projectA.id, visitA, (await photo(f.projectA.id)).id, blank)).rejects.toThrow(/SiteVisitMedia_shape_check/);
      const m = await photo(f.projectA.id);
      await expect(t.prisma.$executeRaw`
        INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","note","addedById")
        VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${blank}, ${f.memberUser.id})`).rejects.toThrow(/SiteVisitMedia_shape_check/);
    }
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id, '  Damp patch  ')).note).toBe('  Damp patch  ');
  });

  it('the database stamps when a file was added, whatever the writer sent', async () => {
    const m = await photo(f.projectA.id);
    const claimed = new Date('2020-01-01T00:00:00Z');
    const before = Date.now();
    await t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","addedById","addedAt")
      VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${f.memberUser.id}, ${claimed})`;
    const row = await t.prisma.siteVisitMedia.findUniqueOrThrow({ where: { mediaId: m.id } });
    expect(row.addedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.addedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('a row is frozen after it is written: who, when, which visit, note, rating and place cannot be rewritten', async () => {
    const m = await photo(f.projectA.id, place.id);
    await link(f.projectA.id, visitA, m.id, 'Crack');
    const frozen = /is a record and is not changed/;
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMedia" SET "addedById" = ${f.clientUser.id} WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMedia" SET "addedAt" = '2020-01-01' WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMedia" SET "visitId" = ${visitB} WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMedia" SET "note" = 'Other' WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMedia" SET "placeName" = 'Elsewhere' WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitMedia" SET "nodeId" = NULL WHERE "mediaId" = ${m.id}`).rejects.toThrow(frozen);
    await expect(t.prisma.siteVisitMedia.update({ where: { mediaId: m.id }, data: { rating: 'concern' } })).rejects.toThrow(frozen);
  });

  it('the place is the one the file showed when added: a later refile or unfile does not move it, and removing the place keeps its name', async () => {
    const m = await photo(f.projectA.id, place.id);
    await t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","addedById","nodeId","placeName")
      VALUES (${f.projectA.id}, ${visitA}, ${m.id}, ${f.memberUser.id}, NULL, 'Spoofed')`;
    expect(await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id }, select: { nodeId: true, placeName: true } }))
      .toEqual({ nodeId: place.id, placeName: place.name });
    const other = await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Tower B ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
    });
    await t.prisma.media.update({ where: { id: m.id }, data: { nodeId: other.id } });
    expect((await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id } }))?.nodeId).toBe(place.id);
    await t.prisma.media.update({ where: { id: m.id }, data: { nodeId: null } });
    expect((await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id } }))?.nodeId).toBe(place.id);
    // removing the place clears only the reference, through its key's own SET NULL action
    const gone = await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Hoarding ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
    });
    const g = await photo(f.projectA.id, gone.id);
    await link(f.projectA.id, visitA, g.id);
    await t.prisma.media.update({ where: { id: g.id }, data: { nodeId: null } });
    await t.prisma.projectNode.delete({ where: { id: gone.id } });
    expect(await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: g.id }, select: { nodeId: true, placeName: true } }))
      .toEqual({ nodeId: null, placeName: gone.name });
    // a file with no place, or on an unpublished draft, records no place
    const draft = await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Draft ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: null },
    });
    for (const nodeId of [undefined, draft.id]) {
      const d = await photo(f.projectA.id, nodeId);
      expect(await link(f.projectA.id, visitA, d.id)).toMatchObject({ nodeId: null, placeName: '' });
    }
    // and a direct write cannot name another project's place
    await expect(t.prisma.$executeRaw`
      UPDATE "SiteVisitMedia" SET "nodeId" = ${randomUUID()} WHERE "mediaId" = ${g.id}`).rejects.toThrow();
  });

  it('a file carries a Fine / Concern / Action needed rating or none, and nothing else', async () => {
    for (const rating of ['fine', 'concern', 'action_needed'] as const) {
      const row = await t.prisma.siteVisitMedia.create({
        data: { projectId: f.projectA.id, visitId: visitA, mediaId: (await photo(f.projectA.id)).id, rating, addedById: f.memberUser.id },
      });
      expect(row.rating).toBe(rating);
    }
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id)).rating).toBeNull();
    // an untyped literal, so the column's own type does the refusing
    const m = await photo(f.projectA.id);
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","rating","addedById") VALUES ($1, $2, $3, 'urgent', $4)`,
      f.projectA.id, visitA, m.id, f.memberUser.id)).rejects.toThrow(/invalid input value for enum "?SiteVisitRating"?/i);
    const col = await t.prisma.$queryRaw<Array<{ udt: string }>>`
      SELECT udt_name AS udt FROM information_schema.columns WHERE table_name = 'SiteVisitMedia' AND column_name = 'rating'`;
    expect(col).toEqual([{ udt: 'SiteVisitRating' }]);
  });

  it('removing the file removes it from the visit, and the visit stays', async () => {
    const m = await photo(f.projectA.id);
    await link(f.projectA.id, visitA, m.id);
    await t.prisma.media.delete({ where: { id: m.id } });
    expect(await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id } })).toBeNull();
    expect(await t.prisma.siteVisit.findUnique({ where: { id: visitA }, select: { id: true } })).toEqual({ id: visitA });
  });

  it('a row goes only with its file: a direct DELETE or TRUNCATE is refused, so a file cannot move to another visit', async () => {
    const m = await photo(f.projectA.id);
    await link(f.projectA.id, visitA, m.id, 'Seepage');
    const record = /part of the visit record/;
    await expect(t.prisma.$executeRaw`DELETE FROM "SiteVisitMedia" WHERE "mediaId" = ${m.id}`).rejects.toThrow(record);
    await expect(t.prisma.siteVisitMedia.delete({ where: { mediaId: m.id } })).rejects.toThrow(record);
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE "SiteVisitMedia"')).rejects.toThrow(/never truncated/);
    expect(await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id }, select: { visitId: true } })).toEqual({ visitId: visitA });
  });

  // Two sessions on separate connections: `held` takes its locks inside an interactive transaction and waits on a gate;
  // the link insert is dispatched on another pooled connection and observed blocked in pg_stat_activity before release.
  const gate = () => { let open!: () => void; const promise = new Promise<void>((r) => (open = r)); return { promise, open }; };
  const reflect = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }));
  const waitUntilBlocked = async () => {
    for (let i = 0; i < 200; i++) {
      const [row] = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%INSERT INTO%SiteVisitMedia%'`);
      if (Number(row!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the link insert never blocked');
  };
  const published = (name: string) => t.prisma.projectNode.create({
    data: { projectId: f.projectA.id, name: `${name} ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
  });

  it('a link racing the removal of its file\'s place waits for it and records no place, in the removal\'s lock order (no deadlock)', async () => {
    const node = await published('Scaffold');
    const m = await photo(f.projectA.id, node.id);
    const locked = gate();
    const release = gate();
    // the removal's order: the node row first, then (its ON DELETE SET NULL) the file row
    const held = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "ProjectNode" WHERE "id" = ${node.id} FOR UPDATE`;
      locked.open();
      await release.promise;
      await tx.$executeRaw`DELETE FROM "ProjectNode" WHERE "id" = ${node.id}`;
    }, { timeout: 20_000 });
    await locked.promise;
    const adding = reflect(link(f.projectA.id, visitA, m.id));
    await waitUntilBlocked();
    release.open();
    await held;
    const added = await adding;
    expect(added.ok ? { nodeId: added.value.nodeId, placeName: added.value.placeName } : String(added.reason))
      .toEqual({ nodeId: null, placeName: '' });
  });

  it('a link racing a refile of its file is refused as a serialization failure, and a retry takes the new place', async () => {
    const was = await published('Lift core');
    const now = await published('Stair core');
    const m = await photo(f.projectA.id, was.id);
    const locked = gate();
    const release = gate();
    const held = t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "Media" SET "nodeId" = ${now.id} WHERE "id" = ${m.id}`;
      locked.open();
      await release.promise;
    }, { timeout: 20_000 });
    await locked.promise;
    const adding = reflect(link(f.projectA.id, visitA, m.id));
    await waitUntilBlocked();
    release.open();
    await held;
    const added = await adding;
    expect(added.ok).toBe(false);
    // SQLSTATE 40001, which Prisma reports as P2034, the code its callers already retry on
    expect((added.ok ? {} : added.reason as { code?: string }).code).toBe('P2034');
    expect(await link(f.projectA.id, visitA, m.id)).toMatchObject({ nodeId: now.id, placeName: now.name });
  });

  it('the migration re-runs as a no-op, and repairs what a db push baseline leaves out', async () => {
    const before = await t.prisma.siteVisitMedia.count({ where: { visitId: visitA } });
    replay();
    replay();
    expect(await t.prisma.siteVisitMedia.count({ where: { visitId: visitA } })).toBe(before);
    const def = async (name: string) => (await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, name))[0]?.d;
    // what Prisma's `db push` creates for `onDelete: NoAction` under the same name, and no triggers
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMedia" DROP CONSTRAINT "SiteVisitMedia_projectId_nodeId_fkey",
      ADD CONSTRAINT "SiteVisitMedia_projectId_nodeId_fkey" FOREIGN KEY ("projectId","nodeId") REFERENCES "ProjectNode"("projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "SiteVisitMedia_insert" ON "SiteVisitMedia"`);
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "SiteVisitMedia_update" ON "SiteVisitMedia"`);
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "SiteVisitMedia_no_delete" ON "SiteVisitMedia"`);
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "SiteVisitMedia_no_truncate" ON "SiteVisitMedia"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitMedia" DROP CONSTRAINT "SiteVisitMedia_shape_check"`);
    expect(await def('SiteVisitMedia_projectId_nodeId_fkey')).not.toMatch(/SET NULL/);
    replay();
    expect(await def('SiteVisitMedia_projectId_nodeId_fkey')).toMatch(/ON DELETE SET NULL \("nodeId"\)$/);
    expect(await def('SiteVisitMedia_shape_check')).toMatch(/btrim/);
    const triggers = await t.prisma.$queryRaw<Array<{ n: string }>>`
      SELECT tgname AS n FROM pg_trigger WHERE tgrelid = '"SiteVisitMedia"'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(triggers.map((r) => r.n)).toEqual(['SiteVisitMedia_insert', 'SiteVisitMedia_no_delete', 'SiteVisitMedia_no_truncate', 'SiteVisitMedia_update']);
    const fks = await t.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint WHERE conrelid = '"SiteVisitMedia"'::regclass AND contype = 'f'`;
    expect(Number(fks[0].n)).toBe(4);
    const labels = await t.prisma.$queryRaw<Array<{ l: string }>>`
      SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = 'public."SiteVisitRating"'::regtype ORDER BY enumsortorder`;
    expect(labels.map((r) => r.l)).toEqual(['fine', 'concern', 'action_needed']);
  });
});
