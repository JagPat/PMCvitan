import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #1283 step 1: `20280204000000_media_upload_source` adds "Media"."uploadSourceMediaId", the file a row was uploaded as
 * a copy of, which step 2 writes with each new upload and compares on an upload key's replay. This proves that the
 * value is taken only at the insert and kept on every writer, that it has no foreign key (so it outlives the
 * original's removal, unlike "sourceMediaId"), that a row written as the previous release writes it still goes in, and
 * that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280204000000_media_upload_source/migration.sql');

describe('#1283: the upload source column (live PG)', () => {
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
  /** a file row as the previous release writes it: it never names the column */
  const plainRow = () => t.prisma.media.create({
    data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id },
    select: { id: true, uploadSourceMediaId: true },
  });
  const copyOf = (sourceId: string) => t.prisma.media.create({
    data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id, sourceMediaId: sourceId, uploadSourceMediaId: sourceId },
    select: { id: true, uploadSourceMediaId: true },
  });
  const setSource = (id: string, value: string | null) =>
    t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "uploadSourceMediaId" = $1 WHERE "id" = $2`, value, id);
  const fixed = /keeps the source it was uploaded with/;

  it('a row written without a source goes in and reads NULL', async () => {
    const row = await plainRow();
    expect(row.uploadSourceMediaId).toBeNull();
  });

  it('takes a source at the insert, through the model', async () => {
    const original = await plainRow();
    const copy = await copyOf(original.id);
    expect(copy.uploadSourceMediaId).toBe(original.id);
  });

  it('is taken at the insert only as a copy of that very file (Stage 1 gap-check)', async () => {
    const original = await plainRow();
    const other = await plainRow();
    const named = /names an upload source only as a copy of that file/;
    // a plain row (no sourceMediaId) naming a source: refused, through the model and raw SQL
    await expect(t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id, uploadSourceMediaId: original.id },
    })).rejects.toThrow(named);
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Media" ("id", "projectId", "kind", "mime", "data", "sizeBytes", "uploadedBy", "uploadSourceMediaId") VALUES ('raw-plain-src', $1, 'progress', 'image/png', $2, $3, $4, $5)`,
      f.projectA.id, bytes, bytes.length, f.memberUser.id, original.id)).rejects.toThrow(named);
    // a copy naming another file than its own source: refused
    await expect(t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id, sourceMediaId: original.id, uploadSourceMediaId: other.id },
    })).rejects.toThrow(named);
    // a copy without one (as the previous release writes it) and a copy naming its own source are taken
    const oldCopy = await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id, sourceMediaId: original.id },
      select: { uploadSourceMediaId: true },
    });
    expect(oldCopy.uploadSourceMediaId).toBeNull();
    expect((await copyOf(original.id)).uploadSourceMediaId).toBe(original.id);
  });

  it('is fixed at the insert on every writer: no change, NULL to a value included', async () => {
    const original = await plainRow();
    const other = await plainRow();
    // a plain row never takes a source later
    const plain = await plainRow();
    await expect(setSource(plain.id, original.id)).rejects.toThrow(fixed);
    await expect(t.prisma.media.update({ where: { id: plain.id }, data: { uploadSourceMediaId: original.id } })).rejects.toThrow(fixed);
    // a copy keeps its source: not another, not NULL
    const copy = await copyOf(original.id);
    await expect(setSource(copy.id, other.id)).rejects.toThrow(fixed);
    await expect(setSource(copy.id, null)).rejects.toThrow(fixed);
    await expect(t.prisma.media.update({ where: { id: copy.id }, data: { uploadSourceMediaId: other.id } })).rejects.toThrow(fixed);
    // the same value again is no change, and other fields still move
    expect(await setSource(copy.id, original.id)).toBe(1);
    expect(await setSource(plain.id, null)).toBe(1);
    await t.prisma.media.update({ where: { id: copy.id }, data: { mime: 'image/jpeg' } });
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id: copy.id }, select: { uploadSourceMediaId: true } });
    expect(kept.uploadSourceMediaId).toBe(original.id);
  });

  it('outlives the original: removing it clears sourceMediaId but keeps uploadSourceMediaId', async () => {
    const original = await plainRow();
    const copy = await copyOf(original.id);
    await t.prisma.media.delete({ where: { id: original.id } });
    const after = await t.prisma.media.findUniqueOrThrow({ where: { id: copy.id }, select: { sourceMediaId: true, uploadSourceMediaId: true } });
    expect(after).toEqual({ sourceMediaId: null, uploadSourceMediaId: original.id });
  });

  it('is one nullable text column with no default and no foreign key', async () => {
    const columns = await t.prisma.$queryRawUnsafe<Array<{ data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Media' AND column_name = 'uploadSourceMediaId'`);
    expect(columns).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    const fks = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = '"Media"'::regclass AND c.contype = 'f' AND a.attname = 'uploadSourceMediaId'`);
    expect(fks[0]!.n).toBe(0);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    const original = await plainRow();
    const copy = await copyOf(original.id);
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    const triggers = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = '"Media"'::regclass AND tgname = 'Media_upload_source_fixed' AND NOT tgisinternal`);
    expect(triggers[0]!.n).toBe(1);
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id: copy.id }, select: { uploadSourceMediaId: true } });
    expect(kept.uploadSourceMediaId).toBe(original.id);
    await expect(setSource(copy.id, null)).rejects.toThrow(fixed);
  });
});
