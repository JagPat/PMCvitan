import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #904 / #1262: `20280202000000_media_content_sha256` adds "Media"."contentSha256", the SHA-256 of a file's decoded
 * bytes as 64 lowercase hex characters, which #1262 writes with each new upload and compares on an upload key's replay.
 * This proves the shape PostgreSQL holds on every writer, that a row written as the previous release writes it (no
 * digest) still goes in, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280202000000_media_content_sha256/migration.sql');

describe('#904: the file digest column (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  const bytes = Buffer.from('a photo');
  const digest = createHash('sha256').update(bytes).digest('hex');
  /** a file row as the previous release writes it: it never names the column */
  const plainRow = () => t.prisma.media.create({
    data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id },
    select: { id: true, contentSha256: true },
  });
  const setDigest = (id: string, value: string | null) =>
    t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "contentSha256" = $1 WHERE "id" = $2`, value, id);

  it('a row written without a digest goes in and reads NULL', async () => {
    const row = await plainRow();
    expect(row.contentSha256).toBeNull();
  });

  it('takes a SHA-256 as 64 lowercase hex, written through the model', async () => {
    const row = await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id, contentSha256: digest },
      select: { contentSha256: true },
    });
    expect(row.contentSha256).toBe(digest);
  });

  it('refuses any other shape: upper case, too short, too long, not hex, empty', async () => {
    const { id } = await plainRow();
    for (const bad of [digest.toUpperCase(), digest.slice(1), `${digest}0`, `${digest.slice(1)}g`, '']) {
      await expect(setDigest(id, bad)).rejects.toThrow(/Media_contentSha256_shape_check/);
    }
    expect(await setDigest(id, digest)).toBe(1);
    expect(await setDigest(id, null)).toBe(1);
  });

  it('is one nullable text column with no default', async () => {
    const columns = await t.prisma.$queryRawUnsafe<Array<{ data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Media' AND column_name = 'contentSha256'`);
    expect(columns).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    const { id } = await plainRow();
    await setDigest(id, digest);
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    const checks = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"Media"'::regclass AND conname = 'Media_contentSha256_shape_check'`);
    expect(checks[0]!.n).toBe(1);
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id }, select: { contentSha256: true } });
    expect(kept.contentSha256).toBe(digest);
  });
});
