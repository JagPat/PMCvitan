import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 site photos, the database half of "a deleted photo stays deleted": `20280117000000_media_tombstone` adds
 * "MediaTombstone", one row per (project, clientKey) whose photo was deleted. No server code writes it yet; this proves
 * what PostgreSQL holds on every writer (T1-T4 in the migration), and that the file re-runs.
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
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'MediaTombstone_projectId_fkey'`);
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
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'MediaTombstone_projectId_fkey'`);
    expect(fk?.d).toMatch(/ON DELETE CASCADE/);
  });
});
