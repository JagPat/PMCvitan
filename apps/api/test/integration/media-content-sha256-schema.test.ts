import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #904 / #1262: `20280202000000_media_content_sha256` adds "Media"."contentSha256", the SHA-256 of a file's decoded
 * bytes as 64 lowercase hex characters, which #1262 writes with each new upload and compares on an upload key's replay.
 * This proves the shape PostgreSQL holds on every writer, that a stored digest is never changed, that a row written as the previous release writes it (no
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
    // Codex 4437981832: non-ASCII digits and letters too (full-width, Arabic-Indic, accented)
    for (const bad of [digest.toUpperCase(), digest.slice(1), `${digest}0`, `${digest.slice(1)}g`, '', `${digest.slice(1)}\uFF10`, `${digest.slice(1)}\u0660`, `${digest.slice(1)}\u00E9`]) {
      await expect(setDigest(id, bad)).rejects.toThrow(/Media_contentSha256_shape_check/);
    }
    expect(await setDigest(id, digest)).toBe(1);
    const { id: other } = await plainRow();
    expect(await setDigest(other, null)).toBe(1);
    // and the CHECK names its characters, so no collation can widen it: no bracket range is left to read
    const defs = await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"Media"'::regclass AND conname = 'Media_contentSha256_shape_check'`);
    expect(defs[0]!.def).toContain('[0123456789abcdef]{64}');
    expect(defs[0]!.def).not.toMatch(/[0-9a-z]-[0-9a-z]/);
  });

  it('keeps the bytes a digest was taken from: data, storageKey and url are fixed once a digest is stored (Codex 4437981825)', async () => {
    const other = Buffer.from('another photo');
    const { id } = await plainRow();
    // no digest: the row is not held
    expect(await t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "data" = $1 WHERE "id" = $2`, other, id)).toBe(1);
    expect(await t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "data" = $1 WHERE "id" = $2`, bytes, id)).toBe(1);
    expect(await setDigest(id, digest)).toBe(1);
    const held = /keeps the bytes its digest was taken from/;
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "data" = $1 WHERE "id" = $2`, other, id)).rejects.toThrow(held);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "data" = NULL WHERE "id" = $1`, id)).rejects.toThrow(held);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "storageKey" = 'projects/x/other.jpg' WHERE "id" = $1`, id)).rejects.toThrow(held);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "url" = 'https://example.invalid/other.jpg' WHERE "id" = $1`, id)).rejects.toThrow(held);
    await expect(t.prisma.media.update({ where: { id }, data: { data: other } })).rejects.toThrow(held);
    // the same bytes again are no change, and other fields still move
    expect(await t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "data" = $1 WHERE "id" = $2`, bytes, id)).toBe(1);
    await t.prisma.media.update({ where: { id }, data: { mime: 'image/jpeg' } });
    // a bucket row created with its digest keeps its key
    const bucket = await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', storageKey: 'projects/x/a.jpg', sizeBytes: bytes.length, uploadedBy: f.memberUser.id, contentSha256: digest },
      select: { id: true },
    });
    await expect(t.prisma.media.update({ where: { id: bucket.id }, data: { storageKey: 'projects/x/b.jpg' } })).rejects.toThrow(held);
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id: bucket.id }, select: { storageKey: true } });
    expect(kept.storageKey).toBe('projects/x/a.jpg');
  });

  it('keeps a stored digest on every writer: only NULL to a digest is taken (Codex 4437816190)', async () => {
    const { id } = await plainRow();
    expect(await setDigest(id, digest)).toBe(1);
    // the same value again is no change
    expect(await setDigest(id, digest)).toBe(1);
    const another = createHash('sha256').update('another photo').digest('hex');
    await expect(setDigest(id, another)).rejects.toThrow(/keeps the digest it was stored with/);
    await expect(setDigest(id, null)).rejects.toThrow(/keeps the digest it was stored with/);
    await expect(t.prisma.media.update({ where: { id }, data: { contentSha256: another } })).rejects.toThrow(/keeps the digest it was stored with/);
    // a row created with its digest keeps it too, and an update of other fields leaves it alone
    const made = await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id, contentSha256: digest },
      select: { id: true },
    });
    await expect(setDigest(made.id, another)).rejects.toThrow(/keeps the digest it was stored with/);
    await t.prisma.media.update({ where: { id: made.id }, data: { mime: 'image/jpeg' } });
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id: made.id }, select: { contentSha256: true } });
    expect(kept.contentSha256).toBe(digest);
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
    const triggers = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = '"Media"'::regclass AND tgname = 'Media_content_sha256_fixed' AND NOT tgisinternal`);
    expect(triggers[0]!.n).toBe(1);
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id }, select: { contentSha256: true } });
    expect(kept.contentSha256).toBe(digest);
  });
});
