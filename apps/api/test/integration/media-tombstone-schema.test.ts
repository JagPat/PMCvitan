import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset, TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';
import { MediaService } from '../../src/media/media.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * #482 site photos, the database half of "a deleted photo stays deleted": `20280117000000_media_tombstone` adds
 * "MediaTombstone", one row per (project, clientKey) whose photo was deleted, written by a trigger on "Media" so it holds
 * for the release already serving. This proves what PostgreSQL holds on every writer (T1-T5 in the migration), and
 * that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280117000000_media_tombstone/migration.sql');

describe('#482 the deleted-photo record (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    // the fixture's project delete takes every tombstone with it (T3)
    await f?.cleanup();
    await t?.close();
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const count = async (projectId: string) => t.prisma.mediaTombstone.count({ where: { projectId } });
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });

  it('holds one row per key in a project, only for a project that exists (T1)', async () => {
    const row = await t.prisma.mediaTombstone.create({ data: { projectId: f.projectA.id, clientKey: 'k-one' } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    await expect(t.prisma.mediaTombstone.create({ data: { projectId: f.projectA.id, clientKey: 'k-one' } })).rejects.toThrow(/Unique constraint/);
    // the same key in another project is that project's own
    await t.prisma.mediaTombstone.create({ data: { projectId: f.projectB.id, clientKey: 'k-one' } });
    await expect(raw(`INSERT INTO "MediaTombstone" ("projectId", "clientKey") VALUES ('no-such-project', 'k')`)).rejects.toThrow(/MediaTombstone_projectId_fkey/);
  });

  it('is never changed, never deleted on its own and never truncated (T2-T4)', async () => {
    await t.prisma.mediaTombstone.create({ data: { projectId: f.projectA.id, clientKey: 'k-two' } });
    await expect(raw(`UPDATE "MediaTombstone" SET "deletedAt" = now() WHERE "projectId" = $1 AND "clientKey" = 'k-two'`, f.projectA.id)).rejects.toThrow(/is never changed/);
    await expect(raw(`UPDATE "MediaTombstone" SET "clientKey" = 'k-moved' WHERE "projectId" = $1 AND "clientKey" = 'k-two'`, f.projectA.id)).rejects.toThrow(/is never changed/);
    await expect(raw(`DELETE FROM "MediaTombstone" WHERE "projectId" = $1 AND "clientKey" = 'k-two'`, f.projectA.id)).rejects.toThrow(/goes only with its project/);
    await expect(t.prisma.mediaTombstone.deleteMany({ where: { projectId: f.projectA.id } })).rejects.toThrow(/goes only with its project/);
    await expect(raw(`TRUNCATE TABLE "MediaTombstone"`)).rejects.toThrow(/never truncated/);
    expect(await count(f.projectA.id)).toBe(2);
  });

  it('goes with its project, through the key\'s cascade (T3)', async () => {
    // a project of its own, so the fixture's projects stay for the other tests
    const id = `it-tomb-${Date.now()}`;
    const p = await t.prisma.project.create({ data: {
      id, orgId: f.orgA.id, name: 'Tombstone cascade', short: 'Tombstone', descriptor: '', stage: 'Planning', siteCode: 'TOMB',
      projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    await t.prisma.mediaTombstone.create({ data: { projectId: p.id, clientKey: 'k-cascade' } });
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, p.id);
    expect(await count(p.id)).toBe(0);
  });

  it('adds the index for a member\'s own recent photos, and the file re-runs unchanged', async () => {
    const indexes = async () => t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'Media_projectId_uploadedBy_createdAt_idx'`);
    expect((await indexes())[0]?.d).toMatch(/\("projectId", "uploadedBy", "createdAt"\)/);
    const triggers = async () => t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = '"MediaTombstone"'::regclass AND NOT tgisinternal ORDER BY 1`);
    const fk = async () => t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = '"MediaTombstone"'::regclass AND conname = 'MediaTombstone_projectId_fkey'`);
    const before = { triggers: await triggers(), fk: await fk(), rows: await count(f.projectA.id) };
    expect(before.triggers.map((r) => r.name)).toEqual(['MediaTombstone_immutable', 'MediaTombstone_no_truncate']);
    expect(before.fk[0]?.d).toMatch(/ON DELETE CASCADE/);
    replay();
    expect({ triggers: await triggers(), fk: await fk(), rows: await count(f.projectA.id) }).toEqual(before);
  });

  it('a db-push key with another delete action is replaced by the CASCADE one on a re-run', async () => {
    await raw(`ALTER TABLE "MediaTombstone" DROP CONSTRAINT "MediaTombstone_projectId_fkey"`);
    await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT`);
    replay();
    const [fk] = await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = '"MediaTombstone"'::regclass AND conname = 'MediaTombstone_projectId_fkey'`);
    expect(fk?.d).toMatch(/ON DELETE CASCADE/);
  });

  describe('the key repair reads this table\'s own keys only (#1018 r4324508652)', () => {
    const RIGHT = 'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE CASCADE';
    /** Every foreign key on "MediaTombstone" itself, by name and definition. */
    const keys = async () => t.prisma.$queryRawUnsafe<Array<{ name: string; d: string }>>(
      `SELECT conname::text AS name, pg_get_constraintdef(oid) AS d FROM pg_constraint
       WHERE conrelid = '"MediaTombstone"'::regclass AND contype = 'f' ORDER BY 1`);
    const exactlyTheRightKey = async () => expect(await keys()).toEqual([{ name: 'MediaTombstone_projectId_fkey', d: RIGHT }]);
    /** A second schema holding a table with a key of the same name, with the given delete action. */
    const otherSchema = async (action: 'CASCADE' | 'RESTRICT') => {
      await raw(`CREATE SCHEMA tomb_other`);
      await raw(`CREATE TABLE tomb_other."Project" (id TEXT PRIMARY KEY)`);
      await raw(`CREATE TABLE tomb_other."MediaTombstone" ("projectId" TEXT NOT NULL,
        CONSTRAINT "MediaTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES tomb_other."Project"(id) ON DELETE ${action})`);
    };
    const otherKey = async () => (await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'tomb_other."MediaTombstone"'::regclass`))[0]?.d;
    const restrictKey = async () => {
      await raw(`ALTER TABLE "MediaTombstone" DROP CONSTRAINT "MediaTombstone_projectId_fkey"`);
      await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT`);
    };

    afterEach(async () => {
      await raw(`DROP SCHEMA IF EXISTS tomb_other CASCADE`);
      // leave the table with its one right key, whatever a failed assertion (or the file under test) left behind
      for (const { name } of await keys()) await raw(`ALTER TABLE "MediaTombstone" DROP CONSTRAINT "${name}"`);
      await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
    });

    it('a same-named CASCADE key in another schema does not stop the RESTRICT key here being replaced', async () => {
      await otherSchema('CASCADE');
      await restrictKey();
      replay();
      await exactlyTheRightKey();
      expect(await otherKey()).toMatch(/ON DELETE CASCADE/);
    });

    it('a same-named RESTRICT key in another schema leaves the right key here in place', async () => {
      await otherSchema('RESTRICT');
      replay();
      await exactlyTheRightKey();
      expect(await otherKey()).toMatch(/ON DELETE RESTRICT/);
    });

    it('a constraint of the project key\'s name that is not a foreign key fails the file, never passes for the key', async () => {
      await raw(`ALTER TABLE "MediaTombstone" DROP CONSTRAINT "MediaTombstone_projectId_fkey"`);
      await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey" CHECK ("projectId" <> '')`);
      try {
        expect(() => replay()).toThrow(/already exists/);
      } finally {
        await raw(`ALTER TABLE "MediaTombstone" DROP CONSTRAINT "MediaTombstone_projectId_fkey"`);
      }
    });

    it('another foreign key on the table is never touched (#1018 r4325096692)', async () => {
      await otherSchema('CASCADE');
      await raw(`CREATE TABLE tomb_other.keys (k TEXT PRIMARY KEY)`);
      await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "tomb_unrelated_fkey" FOREIGN KEY ("clientKey") REFERENCES tomb_other.keys(k) NOT VALID`);
      replay();
      expect(await keys()).toEqual([
        { name: 'MediaTombstone_projectId_fkey', d: RIGHT },
        { name: 'tomb_unrelated_fkey', d: 'FOREIGN KEY ("clientKey") REFERENCES tomb_other.keys(k) NOT VALID' },
      ]);
    });

    it('a key here of another name, or with another update action, is replaced, and a second run changes nothing', async () => {
      await raw(`ALTER TABLE "MediaTombstone" DROP CONSTRAINT "MediaTombstone_projectId_fkey"`);
      await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE RESTRICT`);
      await raw(`ALTER TABLE "MediaTombstone" ADD CONSTRAINT "tomb_extra_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT`);
      replay();
      await exactlyTheRightKey();
      const oid = async () => (await t.prisma.$queryRawUnsafe<Array<{ oid: number }>>(
        `SELECT oid::int AS oid FROM pg_constraint WHERE conrelid = '"MediaTombstone"'::regclass AND contype = 'f'`))[0]?.oid;
      const first = await oid();
      replay();
      expect(await oid()).toBe(first);
      await exactlyTheRightKey();
    });
  });

  describe('the database writes the record on every delete of a keyed photo (T5, #1018 r4325096698)', () => {
    const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;
    const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    let seq = 0;
    const key = () => `t5-${Date.now()}-${++seq}`;
    const recorded = async (clientKey: string, projectId = f.projectA.id) =>
      t.prisma.mediaTombstone.count({ where: { projectId, clientKey } });
    const photo = (clientKey: string | null, projectId = f.projectA.id) => t.prisma.media.create({ data: {
      projectId, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc', clientKey,
    } });

    it('the serving release\'s own delete leaves the record, with no change to its code', async () => {
      // `removeFiled` here is the base's: it deletes the row and writes nothing else
      const media = t.app.get(MediaService);
      const k = key();
      const sent = await media.create(f.projectA.id, pmc(), { kind: 'progress', mime: 'image/png', data: px, clientKey: k } as never);
      expect(await media.removeFiled(sent.id, pmc())).not.toBeNull();
      expect(await recorded(k)).toBe(1);
    });

    it('any delete of a keyed row leaves one record; a row with no key leaves none; a repeat is a no-op', async () => {
      const k = key();
      const a = await photo(k);
      await raw(`DELETE FROM "Media" WHERE "id" = $1`, a.id);
      expect(await recorded(k)).toBe(1);
      // the same key again: the guard (20280118) refuses it now, so this is a row stored before the guard existed;
      // deleting it is no error, and the record stays one
      const b = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "Media" DISABLE TRIGGER "Media_tombstone_guard"`);
        const row = await tx.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc', clientKey: k } });
        await tx.$executeRawUnsafe(`ALTER TABLE "Media" ENABLE TRIGGER "Media_tombstone_guard"`);
        return row;
      });
      await t.prisma.media.delete({ where: { id: b.id } });
      expect(await recorded(k)).toBe(1);
      const before = await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id } });
      const plain = await photo(null);
      await t.prisma.media.deleteMany({ where: { id: plain.id } });
      expect(await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id } })).toBe(before);
    });

    it('a delete rolled back leaves no record', async () => {
      const k = key();
      const a = await photo(k);
      await expect(t.prisma.$transaction(async (tx) => {
        await tx.media.delete({ where: { id: a.id } });
        throw new Error('rolled back');
      })).rejects.toThrow('rolled back');
      expect(await recorded(k)).toBe(0);
      expect(await t.prisma.media.count({ where: { id: a.id } })).toBe(1);
    });

    /** A project of its own, so the fixture's projects stay for the other tests. */
    const ownProject = async (tag: string) => t.prisma.project.create({ data: {
      id: `it-tomb-${tag}-${Date.now()}`, orgId: f.orgA.id, name: 'Tombstone T5', short: 'T5', descriptor: '', stage: 'Planning',
      siteCode: 'TMB5', projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });

    it('a project\'s photos wiped before the project goes (the seed\'s order) leave records that go with it', async () => {
      const p = await ownProject('seed');
      const k = key();
      await photo(k, p.id);
      await t.prisma.$transaction(async (tx) => {
        await tx.media.deleteMany({ where: { projectId: p.id } });
        expect(await tx.mediaTombstone.count({ where: { projectId: p.id } })).toBe(1);
        await tx.project.delete({ where: { id: p.id } });
      });
      expect(await recorded(k, p.id)).toBe(0);
    });

    it('a photo whose project goes in the same statement writes nothing, so the project still goes', async () => {
      const p = await ownProject('same');
      await photo(key(), p.id);
      await raw(`WITH gone AS (DELETE FROM "Media" WHERE "projectId" = $1) DELETE FROM "Project" WHERE "id" = $1`, p.id);
      expect(await t.prisma.project.count({ where: { id: p.id } })).toBe(0);
      expect(await t.prisma.mediaTombstone.count({ where: { projectId: p.id } })).toBe(0);
    });
  });

  describe('the sanctioned reset lifts the truncate seal by name (#1018 r4325096705)', () => {
    it('every statement seal on the table is registered, and the reset empties it and puts the seal back', async () => {
      const seals = await t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = '"MediaTombstone"'::regclass AND NOT tgisinternal AND (tgtype & 32) <> 0`);
      expect(seals.map((s) => s.name)).toEqual(['MediaTombstone_no_truncate']);
      for (const { name } of seals) expect(TRUNCATE_SEALS).toContainEqual({ table: 'MediaTombstone', trigger: name });
      await sanctionedReset(t.prisma, ['MediaTombstone']);
      expect(await t.prisma.mediaTombstone.count()).toBe(0);
      const [state] = await t.prisma.$queryRawUnsafe<Array<{ enabled: string }>>(
        `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = '"MediaTombstone"'::regclass AND tgname = 'MediaTombstone_no_truncate'`);
      expect(state?.enabled).toBe('O');
    });
  });
});
