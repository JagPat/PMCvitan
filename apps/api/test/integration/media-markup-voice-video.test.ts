import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Stage 1 media, the database half of photo markup, voice notes and video: `20280115000000_media_markup_voice_video`
 * adds three nullable "Media" columns (a marked-up copy's original, a recording's length, a video's still frame). No
 * server or screen writes them yet; this proves what PostgreSQL holds on every writer, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280115000000_media_markup_voice_video/migration.sql');

describe('Stage 1 media — markup links, lengths and still frames (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (t && f) {
      // copies first: an original's removal would only clear their link, and they would stay behind
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] }, sourceMediaId: { not: null } } });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const file = (projectId: string, mime = 'image/jpeg', extra: { sourceMediaId?: string; durationSec?: number; posterStorageKey?: string } = {}) =>
    t.prisma.media.create({
      data: { projectId, kind: 'progress', mime, data: Buffer.from([1, 2, 3]), sizeBytes: 3, uploadedBy: f.memberUser.id, ...extra },
    });
  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const def = async (name: string) => (await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, name))[0]?.d;
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });

  it('a marked-up copy points at its original in the same project, and the original lists it', async () => {
    const original = await file(f.projectA.id);
    const copy = await file(f.projectA.id, 'image/png', { sourceMediaId: original.id });
    expect(copy.sourceMediaId).toBe(original.id);
    const listed = await t.prisma.media.findUnique({ where: { id: original.id }, select: { markups: { select: { id: true } } } });
    expect(listed?.markups.map((m) => m.id)).toEqual([copy.id]);
    // existing rows and plain uploads carry none of the three
    expect(original).toMatchObject({ sourceMediaId: null, durationSec: null, posterStorageKey: null });
  });

  it('a copy cannot point at another project\'s photo, at a missing one, or at itself (K1, K3)', async () => {
    const other = await file(f.projectB.id);
    await expect(file(f.projectA.id, 'image/png', { sourceMediaId: other.id })).rejects.toThrow(/Media_projectId_sourceMediaId_fkey|Foreign key/i);
    await expect(file(f.projectA.id, 'image/png', { sourceMediaId: 'no-such-file' })).rejects.toThrow(/Media_projectId_sourceMediaId_fkey|Foreign key/i);
    const self = await file(f.projectA.id);
    await expect(raw(`UPDATE "Media" SET "sourceMediaId" = "id" WHERE "id" = $1`, self.id)).rejects.toThrow(/Media_av_shape_check/);
  });

  it('only an image is a marked-up copy (K3)', async () => {
    const original = await file(f.projectA.id);
    await expect(file(f.projectA.id, 'audio/webm', { sourceMediaId: original.id })).rejects.toThrow(/Media_av_shape_check/);
    await expect(file(f.projectA.id, 'video/mp4', { sourceMediaId: original.id })).rejects.toThrow(/Media_av_shape_check/);
  });

  it('removing an original keeps its copy and clears only the link (K2)', async () => {
    const original = await file(f.projectA.id);
    const copy = await file(f.projectA.id, 'image/png', { sourceMediaId: original.id });
    await t.prisma.media.delete({ where: { id: original.id } });
    expect(await t.prisma.media.findUnique({ where: { id: copy.id }, select: { projectId: true, sourceMediaId: true } }))
      .toEqual({ projectId: f.projectA.id, sourceMediaId: null });
  });

  it('a voice note is 1 to 120 seconds, a clip 1 to 60, and a photo has no length (K3)', async () => {
    expect((await file(f.projectA.id, 'audio/webm', { durationSec: 120 })).durationSec).toBe(120);
    expect((await file(f.projectA.id, 'audio/mp4', { durationSec: 1 })).durationSec).toBe(1);
    expect((await file(f.projectA.id, 'video/mp4', { durationSec: 60 })).durationSec).toBe(60);
    // a length the phone could not read stays empty
    expect((await file(f.projectA.id, 'video/quicktime')).durationSec).toBeNull();
    for (const [mime, sec] of [['audio/webm', 121], ['audio/webm', 0], ['video/mp4', 61], ['video/mp4', -1], ['image/jpeg', 5]] as const) {
      await expect(file(f.projectA.id, mime, { durationSec: sec })).rejects.toThrow(/Media_av_shape_check/);
    }
  });

  it('a still frame belongs only to a video and is never blank (K3)', async () => {
    expect((await file(f.projectA.id, 'video/mp4', { durationSec: 12, posterStorageKey: 'p/a/poster.jpg' })).posterStorageKey).toBe('p/a/poster.jpg');
    for (const [mime, key] of [['image/jpeg', 'p/a/poster.jpg'], ['audio/webm', 'p/a/poster.jpg'], ['video/mp4', ''], ['video/mp4', ' \t\n']] as const) {
      await expect(file(f.projectA.id, mime, { posterStorageKey: key })).rejects.toThrow(/Media_av_shape_check/);
    }
  });

  it('a replay over a `db push` baseline replaces the NO ACTION link with the column-list SET NULL, and re-runs', async () => {
    // what Prisma's `db push` creates for `onDelete: NoAction` under the same name, and no CHECK
    await raw(`ALTER TABLE "Media" DROP CONSTRAINT "Media_projectId_sourceMediaId_fkey",
      ADD CONSTRAINT "Media_projectId_sourceMediaId_fkey" FOREIGN KEY ("projectId","sourceMediaId") REFERENCES "Media"("projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await raw(`ALTER TABLE "Media" DROP CONSTRAINT "Media_av_shape_check"`);
    expect(await def('Media_projectId_sourceMediaId_fkey')).not.toMatch(/SET NULL/);
    replay();
    expect(await def('Media_projectId_sourceMediaId_fkey')).toMatch(/ON DELETE SET NULL \("sourceMediaId"\)$/);
    expect(await def('Media_av_shape_check')).toMatch(/durationSec/);
    replay(); // a second run over the migrated database changes nothing and does not fail
    const original = await file(f.projectA.id);
    const copy = await file(f.projectA.id, 'image/png', { sourceMediaId: original.id });
    await t.prisma.media.delete({ where: { id: original.id } });
    expect((await t.prisma.media.findUnique({ where: { id: copy.id } }))?.sourceMediaId).toBeNull();
    await expect(file(f.projectA.id, 'image/jpeg', { durationSec: 5 })).rejects.toThrow(/Media_av_shape_check/);
  });
});
