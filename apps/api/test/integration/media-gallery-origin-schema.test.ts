import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Guided site inspections, decision 3: `20280211000000_media_gallery_origin` adds "Media"."fromGallery" and
 * "Media"."galleryOriginalAt", the "from gallery" label and the picked file's own date, which a later unit writes with
 * each upload. This proves that a row written as the previous release writes it goes in as taken in the app, that an
 * original date belongs to a gallery file only, that both are fixed at the insert on every writer, and that the file
 * re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280211000000_media_gallery_origin/migration.sql');

describe('guided inspections: the gallery label columns (live PG)', () => {
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
  const base = () => ({ projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: bytes, sizeBytes: bytes.length, uploadedBy: f.memberUser.id });
  const select = { id: true, fromGallery: true, galleryOriginalAt: true } as const;
  const original = new Date('2026-10-30T07:15:00.000Z');
  const fixed = /keeps where it was taken from/;
  const pairCheck = /Media_gallery_original_needs_gallery/;
  const setOrigin = (id: string, fromGallery: boolean, at: Date | null) =>
    t.prisma.$executeRawUnsafe(`UPDATE "Media" SET "fromGallery" = $1, "galleryOriginalAt" = $2 WHERE "id" = $3`, fromGallery, at, id);

  it('a row written as the previous release writes it (naming neither column) reads as taken in the app', async () => {
    const row = await t.prisma.media.create({ data: base(), select });
    expect(row).toMatchObject({ fromGallery: false, galleryOriginalAt: null });
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Media" ("id", "projectId", "kind", "mime", "data", "sizeBytes", "uploadedBy") VALUES ('raw-gallery-old', $1, 'progress', 'image/png', $2, $3, $4)`,
      f.projectA.id, bytes, bytes.length, f.memberUser.id);
    const raw = await t.prisma.media.findUniqueOrThrow({ where: { id: 'raw-gallery-old' }, select });
    expect(raw).toMatchObject({ fromGallery: false, galleryOriginalAt: null });
  });

  it('takes a gallery file at the insert, with or without its original date', async () => {
    const dated = await t.prisma.media.create({ data: { ...base(), fromGallery: true, galleryOriginalAt: original }, select });
    expect(dated).toMatchObject({ fromGallery: true, galleryOriginalAt: original });
    const undated = await t.prisma.media.create({ data: { ...base(), fromGallery: true }, select });
    expect(undated).toMatchObject({ fromGallery: true, galleryOriginalAt: null });
  });

  it('an original date belongs to a gallery file only, on every writer', async () => {
    await expect(t.prisma.media.create({ data: { ...base(), galleryOriginalAt: original } })).rejects.toThrow(pairCheck);
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Media" ("id", "projectId", "kind", "mime", "data", "sizeBytes", "uploadedBy", "galleryOriginalAt") VALUES ('raw-gallery-camera-dated', $1, 'progress', 'image/png', $2, $3, $4, $5)`,
      f.projectA.id, bytes, bytes.length, f.memberUser.id, original)).rejects.toThrow(pairCheck);
  });

  it('is fixed at the insert on every writer: a camera file never becomes a gallery file, nor the reverse', async () => {
    const camera = await t.prisma.media.create({ data: base(), select });
    const gallery = await t.prisma.media.create({ data: { ...base(), fromGallery: true, galleryOriginalAt: original }, select });
    // raw SQL and the model are both refused
    await expect(setOrigin(camera.id, true, null)).rejects.toThrow(fixed);
    await expect(setOrigin(gallery.id, false, null)).rejects.toThrow(fixed);
    await expect(setOrigin(gallery.id, true, null)).rejects.toThrow(fixed);
    await expect(setOrigin(gallery.id, true, new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow(fixed);
    await expect(t.prisma.media.update({ where: { id: camera.id }, data: { fromGallery: true } })).rejects.toThrow(fixed);
    await expect(t.prisma.media.update({ where: { id: gallery.id }, data: { galleryOriginalAt: null } })).rejects.toThrow(fixed);
    // the same values again are no change, and other fields still move
    expect(await setOrigin(gallery.id, true, original)).toBe(1);
    expect(await setOrigin(camera.id, false, null)).toBe(1);
    await t.prisma.media.update({ where: { id: gallery.id }, data: { mime: 'image/jpeg' } });
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id: gallery.id }, select });
    expect(kept).toMatchObject({ fromGallery: true, galleryOriginalAt: original });
  });

  it('is a non-null boolean defaulting to false and a nullable timestamp with no default', async () => {
    const columns = await t.prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Media' AND column_name IN ('fromGallery', 'galleryOriginalAt') ORDER BY column_name`);
    expect(columns).toEqual([
      { column_name: 'fromGallery', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { column_name: 'galleryOriginalAt', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
    ]);
    const checks = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"Media"'::regclass AND conname = 'Media_gallery_original_needs_gallery' AND contype = 'c' AND convalidated`);
    expect(checks[0]!.n).toBe(1);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    const gallery = await t.prisma.media.create({ data: { ...base(), fromGallery: true, galleryOriginalAt: original }, select });
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    const objects = await t.prisma.$queryRawUnsafe<Array<{ triggers: number; checks: number }>>(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = '"Media"'::regclass AND tgname = 'Media_gallery_origin_fixed' AND NOT tgisinternal) AS triggers,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = '"Media"'::regclass AND conname = 'Media_gallery_original_needs_gallery') AS checks`);
    expect(objects[0]).toEqual({ triggers: 1, checks: 1 });
    const kept = await t.prisma.media.findUniqueOrThrow({ where: { id: gallery.id }, select });
    expect(kept).toMatchObject({ fromGallery: true, galleryOriginalAt: original });
    await expect(setOrigin(gallery.id, false, null)).rejects.toThrow(fixed);
  });

  it('a column standing with another shape is refused, and a same-named CHECK with another definition is replaced (gap-check)', async () => {
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    const run = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Media" ALTER COLUMN "fromGallery" SET DEFAULT true`);
    try {
      expect(run).toThrow(/Media.fromGallery already stands as boolean/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "Media" ALTER COLUMN "fromGallery" SET DEFAULT false`);
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Media" DROP CONSTRAINT "Media_gallery_original_needs_gallery",
      ADD CONSTRAINT "Media_gallery_original_needs_gallery" CHECK (true)`);
    run();
    const def = await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"Media"'::regclass AND conname = 'Media_gallery_original_needs_gallery'`);
    expect(def).toEqual([{ def: 'CHECK ((("galleryOriginalAt" IS NULL) OR "fromGallery"))' }]);
  });
});
