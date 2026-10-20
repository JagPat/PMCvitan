import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { MediaService } from '../../src/media/media.service';
import { StorageService } from '../../src/media/storage.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * #482 site photos — a deleted photo's key is never stored again (`20280118000000_media_tombstone_guard`). The record of
 * a deleted key (`MediaTombstone`, 20280117) is written by the database on every delete; this guard on "Media" refuses
 * a row under a recorded key, for every writer and every release, so a copy of a send still queued on another phone can
 * no longer bring the photo back. Reproduce-first: on the base each refused write below is stored.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280118000000_media_tombstone_guard/migration.sql');

describe('#482 a deleted photo\'s key is refused on every write (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const key = () => `guard-${Date.now()}-${++seq}`;
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const photo = (clientKey: string | null, projectId = f.projectA.id) => t.prisma.media.create({ data: {
    projectId, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc', clientKey,
  } });
  const rowsFor = (clientKey: string, projectId = f.projectA.id) => t.prisma.media.count({ where: { projectId, clientKey } });
  /** A key whose photo was stored and then deleted: the database recorded it (20280117). */
  const deletedKey = async (projectId = f.projectA.id) => {
    const k = key();
    const p = await photo(k, projectId);
    await t.prisma.media.delete({ where: { id: p.id } });
    expect(await t.prisma.mediaTombstone.count({ where: { projectId, clientKey: k } })).toBe(1);
    return k;
  };
  const REFUSED = /this photo was deleted/;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    // the fixture's project delete takes the records with it
    await f?.cleanup();
    await t?.close();
  });

  it('refuses a row under a recorded key, through the ORM and raw SQL, and keeps nothing', async () => {
    const k = await deletedKey();
    await expect(photo(k)).rejects.toThrow(REFUSED);
    await expect(raw(
      `INSERT INTO "Media" ("id", "projectId", "kind", "mime", "data", "sizeBytes", "uploadedBy", "clientKey")
       VALUES ($1, $2, 'progress', 'image/png', '\\x616263'::bytea, 3, 'pmc', $3)`, `guard-raw-${seq}`, f.projectA.id, k,
    )).rejects.toThrow(REFUSED);
    expect(await rowsFor(k)).toBe(0);
    // the SQLSTATE the server maps to "This photo was deleted"
    const err = await raw(
      `INSERT INTO "Media" ("id", "projectId", "kind", "mime", "data", "sizeBytes", "uploadedBy", "clientKey")
       VALUES ($1, $2, 'progress', 'image/png', '\\x61'::bytea, 1, 'pmc', $3)`, `guard-code-${seq}`, f.projectA.id, k,
    ).then(() => null, (e: unknown) => e as { meta?: { code?: string } });
    expect(err?.meta?.code).toBe('MT410');
  });

  it('refuses an update that gives a row a recorded key', async () => {
    const k = await deletedKey();
    const other = await photo(key());
    await expect(t.prisma.media.update({ where: { id: other.id }, data: { clientKey: k } })).rejects.toThrow(REFUSED);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: other.id } })).clientKey).not.toBe(k);
  });

  it('refuses a row moved into the project that recorded its key', async () => {
    const k = await deletedKey();
    const elsewhere = await photo(k, f.projectB.id);
    await expect(raw(`UPDATE "Media" SET "projectId" = $1 WHERE "id" = $2`, f.projectA.id, elsewhere.id)).rejects.toThrow(REFUSED);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: elsewhere.id } })).projectId).toBe(f.projectB.id);
    expect(await rowsFor(k)).toBe(0);
  });

  it('stores a row with no key, a key with no record, and a recorded key in another project', async () => {
    const k = await deletedKey();
    expect((await photo(null)).id).toBeTruthy();
    expect((await photo(key())).id).toBeTruthy();
    expect((await photo(k, f.projectB.id)).id).toBeTruthy();
    expect(await rowsFor(k, f.projectB.id)).toBe(1);
  });

  it('the serving release\'s own send of a deleted key is refused: no row, no event, and its stored object removed', async () => {
    // this branch's `create()` is the serving release's: it reads no record, so only the guard stands in its way
    const media = t.app.get(MediaService);
    const storage = t.app.get(StorageService);
    const pmc = { sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
    const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const k = key();
    const sent = await media.create(f.projectA.id, pmc, { kind: 'progress', mime: 'image/png', data: px, clientKey: k } as never);
    expect(await media.removeFiled(sent.id, pmc)).not.toBeNull();
    const events = () => t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, eventType: 'media.uploaded' } });
    const before = await events();
    const put = vi.spyOn(storage, 'put');
    const remove = vi.spyOn(storage, 'remove');
    await expect(media.create(f.projectA.id, pmc, { kind: 'progress', mime: 'image/png', data: px, clientKey: k } as never)).rejects.toThrow(REFUSED);
    expect(await rowsFor(k)).toBe(0);
    expect(await events()).toBe(before);
    expect(put).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(put.mock.calls[0]![0]);
  });

  it('a send waiting behind a delete of the same key\'s row is refused once that delete commits (AFTER, not BEFORE)', async () => {
    const k = key();
    const first = await photo(k);
    // a delete with no key lock (the serving release's), held open on its own connection
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const deleting = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM "Media" WHERE "id" = $1`, first.id);
      held();
      await gate;
    }, { timeout: 30_000 });
    await holding;
    const waiters = async () => (await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'transactionid' AND NOT l.granted AND a.datname = current_database()`))[0]!.n;
    const before = await waiters();
    // the late copy, on a third connection: it waits on the unique index for the delete
    const late = photo(k);
    late.catch(() => undefined);
    for (let i = 0; (await waiters()) <= before; i++) {
      if (i > 400) throw new Error('the send never waited on the delete');
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await deleting;
    await expect(late).rejects.toThrow(REFUSED);
    expect(await rowsFor(k)).toBe(0);
  });

  it('the file re-runs unchanged', async () => {
    const def = async () => t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgrelid = '"Media"'::regclass AND tgname = 'Media_tombstone_guard'`);
    const before = await def();
    expect(before[0]?.d).toMatch(/AFTER INSERT OR UPDATE OF "projectId", "clientKey" ON public."Media" FOR EACH ROW/);
    replay();
    expect(await def()).toEqual(before);
  });

  it('the lookup is one probe of the record\'s primary key', async () => {
    // a test table is small enough that the planner may scan it whole; with that ruled out, the plan shows the index
    // that serves the exact key the guard checks
    const plan = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT 1 FROM "MediaTombstone" t WHERE t."projectId" = $1 AND t."clientKey" = $2`, f.projectA.id, 'k');
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    // the index is the record's primary key, on exactly ("projectId", "clientKey")
    const [pk] = await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_indexdef('"MediaTombstone_pkey"'::regclass) AS d`);
    expect(pk?.d).toMatch(/\("projectId", "clientKey"\)$/);
    expect(plan).toMatch(/Index Only Scan using "MediaTombstone_pkey"|Index Scan using "MediaTombstone_pkey"/);
  });
});
