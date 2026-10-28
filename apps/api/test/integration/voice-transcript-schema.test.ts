import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #1177 VT1, the database half of "voice note to text": `20280126000000_voice_transcript` adds "VoiceTranscript", at most
 * one row per voice note, holding the provider job's progress, its words and a person's correction. This proves what
 * PostgreSQL holds on every writer (V1-V5 in the migration), and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280126000000_voice_transcript/migration.sql');

describe('#1177 voice-note transcripts (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      if (f) await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await f?.cleanup();
    } finally {
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = () => (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url(), '-f', MIGRATION], { stdio: 'pipe' });
  const voice = async (projectId: string) =>
    (await t.prisma.media.create({ data: { projectId, kind: 'visit', mime: 'audio/webm', uploadedBy: f.memberUser.id, durationSec: 30 } })).id;
  const insert = (projectId: string, mediaId: string, extra = '', values = '') =>
    raw(`INSERT INTO "VoiceTranscript" ("projectId", "mediaId", "updatedAt"${extra}) VALUES ($1, $2, now()${values})`, projectId, mediaId);

  it('holds one row per voice note, named by the note\'s own project (V1)', async () => {
    const m = await voice(f.projectA.id);
    const row = await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m } });
    expect(row).toMatchObject({ status: 'pending', attempts: 0, retried: false, text: null });
    await expect(t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m } })).rejects.toThrow(/Unique constraint/);
    // another project's note, or a note that does not exist, is refused by the composite key
    const other = await voice(f.projectB.id);
    await expect(insert(f.projectA.id, other)).rejects.toThrow(/VoiceTranscript_projectId_mediaId_fkey/);
    await expect(insert(f.projectA.id, 'no-such-media')).rejects.toThrow(/VoiceTranscript_projectId_mediaId_fkey/);
  });

  it('is written only for a voice note (V2)', async () => {
    const photo = (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: f.memberUser.id } })).id;
    await expect(insert(f.projectA.id, photo)).rejects.toThrow(/only for a voice note/);
    const video = (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'visit', mime: 'video/webm', uploadedBy: f.memberUser.id, durationSec: 10 } })).id;
    await expect(insert(f.projectA.id, video)).rejects.toThrow(/only for a voice note/);
  });

  it('never moves to another note, and keeps its creation time (V2)', async () => {
    const m = await voice(f.projectA.id);
    const n = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m } });
    await expect(raw(`UPDATE "VoiceTranscript" SET "mediaId" = $1 WHERE "mediaId" = $2`, n, m)).rejects.toThrow(/stays with that note/);
    await expect(raw(`UPDATE "VoiceTranscript" SET "createdAt" = now() - interval '1 day' WHERE "mediaId" = $1`, m)).rejects.toThrow(/stays with that note/);
    // the job moving on is an ordinary update
    await raw(`UPDATE "VoiceTranscript" SET "status" = 'running', "providerJobId" = 'job-1' WHERE "mediaId" = $1`, m);
    expect((await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).status).toBe('running');
  });

  it('goes with its note, so a late write-back after a delete matches nothing (V1)', async () => {
    const m = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m, status: 'running', providerJobId: 'job-2' } });
    await raw(`DELETE FROM "Media" WHERE "id" = $1`, m);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: m } })).toBe(0);
    expect(await raw(`UPDATE "VoiceTranscript" SET "status" = 'done', "text" = 'late' WHERE "mediaId" = $1`, m)).toBe(0);
  });

  it('keeps its note a voice note while it exists (V2)', async () => {
    const m = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m } });
    // a photo carries no length, so the length goes with the type (the file's own shape check would refuse it otherwise)
    const mime = (value: string | null) => raw(`UPDATE "Media" SET "mime" = $1, "durationSec" = NULL WHERE "id" = $2`, value, m);
    await expect(mime('image/png')).rejects.toThrow(/stays a voice note/);
    await expect(mime(null)).rejects.toThrow(/stays a voice note/);
    await raw(`UPDATE "Media" SET "mime" = 'audio/mp4' WHERE "id" = $1`, m); // still a voice note
    // a fixed-snapshot writer could miss a transcript committed while it waited, so it may not take a file out of audio
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.$executeRawUnsafe(`UPDATE "Media" SET "mime" = 'image/png', "durationSec" = NULL WHERE "id" = $1`, m);
    })).rejects.toThrow(/only at READ COMMITTED, not repeatable read/);
    // a file with no transcript is not this trigger's concern
    const n = await voice(f.projectA.id);
    await raw(`UPDATE "Media" SET "mime" = 'image/png', "durationSec" = NULL WHERE "id" = $1`, n);
  });

  it('is never deleted on its own, so heard words cannot be erased and written again (V5)', async () => {
    const m = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m, status: 'done', text: 'પાઇપ લાઇન' } });
    const alone = /goes only with that note/;
    await expect(raw(`DELETE FROM "VoiceTranscript" WHERE "mediaId" = $1`, m)).rejects.toThrow(alone);
    await expect(t.prisma.voiceTranscript.deleteMany({ where: { mediaId: m } })).rejects.toThrow(alone);
    // an unfinished row is held the same way: only its note takes it
    const n = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: n } });
    await expect(raw(`DELETE FROM "VoiceTranscript" WHERE "mediaId" = $1`, n)).rejects.toThrow(alone);
    await expect(raw(`TRUNCATE "VoiceTranscript"`)).rejects.toThrow(/never truncated/);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({ status: 'done', text: 'પાઇપ લાઇન' });
    // the note's own delete still takes it (a cascade, below trigger depth 1)
    await raw(`DELETE FROM "Media" WHERE "id" IN ($1, $2)`, m, n);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: { in: [m, n] } } })).toBe(0);
  });

  it('is well formed (V3)', async () => {
    const m = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m } });
    const set = (assignments: string) => raw(`UPDATE "VoiceTranscript" SET ${assignments} WHERE "mediaId" = $1`, m);
    const refused = /VoiceTranscript_shape_check/;
    await expect(set(`"status" = 'finished'`)).rejects.toThrow(refused);
    await expect(set(`"status" = 'done'`)).rejects.toThrow(refused); // done without words
    await expect(set(`"text" = 'words'`)).rejects.toThrow(refused); // words before done
    await expect(set(`"editedText" = 'fixed', "editedById" = '${f.memberUser.id}', "editedAt" = now()`)).rejects.toThrow(refused); // correction before done
    await expect(set(`"leaseToken" = 'tok'`)).rejects.toThrow(refused); // a token without its expiry
    await expect(set(`"leaseToken" = E' \\t\\n', "leaseUntil" = now()`)).rejects.toThrow(refused);
    await expect(set(`"providerJobId" = E'\\t\\n'`)).rejects.toThrow(refused);
    await expect(set(`"status" = 'running'`)).rejects.toThrow(refused); // running without its job
    await expect(set(`"languageCode" = 'Gujarati'`)).rejects.toThrow(refused);
    await expect(set(`"attempts" = 11`)).rejects.toThrow(refused);
    await expect(set(`"attempts" = -1`)).rejects.toThrow(refused);
    await expect(set(`"lastError" = repeat('x', 501)`)).rejects.toThrow(refused);
    await expect(set(`"status" = 'done', "text" = repeat('x', 20001)`)).rejects.toThrow(refused);

    // done, with the words the provider heard and their language (no words is allowed too: a note can hold no speech)
    await set(`"status" = 'done', "text" = 'પાઇપ લાઇન અહીંથી જશે', "languageCode" = 'gu-IN', "leaseToken" = 'tok', "leaseUntil" = now()`);
    // a correction comes with its corrector and time, and is never blank or overlong
    await expect(set(`"editedText" = 'fixed'`)).rejects.toThrow(refused);
    await expect(set(`"editedText" = E' \\n', "editedById" = '${f.memberUser.id}', "editedAt" = now()`)).rejects.toThrow(refused);
    await expect(set(`"editedText" = repeat('x', 5001), "editedById" = '${f.memberUser.id}', "editedAt" = now()`)).rejects.toThrow(refused);
    await expect(set(`"editedText" = 'fixed', "editedById" = 'no-such-user', "editedAt" = now()`)).rejects.toThrow(/VoiceTranscript_editedById_fkey/);
    await set(`"editedText" = 'Pipe line goes from here', "editedById" = '${f.memberUser.id}', "editedAt" = now()`);
    // V4: a done row stays done, what the provider heard stays as heard, and the corrector moves only with the correction
    const kept = /kept as heard/;
    await expect(set(`"status" = 'running', "text" = NULL`)).rejects.toThrow(kept);
    await expect(set(`"text" = 'a late answer'`)).rejects.toThrow(kept);
    await expect(set(`"languageCode" = 'hi-IN'`)).rejects.toThrow(kept);
    await expect(set(`"status" = 'failed', "text" = NULL, "editedText" = NULL, "editedById" = NULL, "editedAt" = NULL`)).rejects.toThrow(kept);
    await expect(set(`"editedById" = '${f.otherUser.id}'`)).rejects.toThrow(/keeps its author and time/);
    await expect(set(`"editedAt" = now() + interval '1 hour'`)).rejects.toThrow(/keeps its author and time/);
    // a changed correction is a new one: it cannot keep the previous corrector's time, or go back in time
    const fresh = /carries its own author and a later time/;
    await expect(set(`"editedText" = 'Pipe line starts here'`)).rejects.toThrow(fresh);
    await expect(set(`"editedText" = 'Pipe line starts here', "editedById" = '${f.otherUser.id}'`)).rejects.toThrow(fresh);
    await expect(set(`"editedText" = 'Pipe line starts here', "editedById" = '${f.otherUser.id}', "editedAt" = "editedAt" - interval '1 second'`)).rejects.toThrow(fresh);
    // ...and nothing else on a done row moves: not its job, its tries or its lease
    await expect(set(`"providerJobId" = 'job-other'`)).rejects.toThrow(kept);
    await expect(set(`"attempts" = 1`)).rejects.toThrow(kept);
    await expect(set(`"lastError" = 'late'`)).rejects.toThrow(kept);
    await expect(set(`"retried" = true`)).rejects.toThrow(kept);
    await expect(set(`"leaseToken" = NULL, "leaseUntil" = NULL`)).rejects.toThrow(kept);
    // a new correction by another person names them
    await set(`"editedText" = 'Pipe line starts here', "editedById" = '${f.otherUser.id}', "editedAt" = "editedAt" + interval '1 second'`);
    const row = await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } });
    expect(row).toMatchObject({ status: 'done', text: 'પાઇપ લાઇન અહીંથી જશે', languageCode: 'gu-IN', editedText: 'Pipe line starts here', editedById: f.otherUser.id });
  });

  it('a done row with no speech is allowed, and stays done (V3, V4)', async () => {
    const m = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: m, status: 'done', text: '' } });
    await expect(raw(`UPDATE "VoiceTranscript" SET "text" = 'x' WHERE "mediaId" = $1`, m)).rejects.toThrow(/kept as heard/);
  });

  it('has exactly its keys, check, indexes and triggers, and re-runs over itself unchanged', async () => {
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ k: string; d: string }>>(
      `SELECT 'c:' || conname AS k, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = '"VoiceTranscript"'::regclass
       UNION ALL SELECT 't:' || tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = '"VoiceTranscript"'::regclass AND NOT tgisinternal
       UNION ALL SELECT 'i:' || indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = '"VoiceTranscript"'::regclass
       ORDER BY 1`);
    const before = await shape();
    expect(before.map((r) => r.k)).toEqual([
      'c:VoiceTranscript_editedById_fkey', 'c:VoiceTranscript_pkey', 'c:VoiceTranscript_projectId_mediaId_fkey', 'c:VoiceTranscript_shape_check',
      'i:"VoiceTranscript_pkey"', 'i:"VoiceTranscript_projectId_mediaId_key"',
      't:VoiceTranscript_insert', 't:VoiceTranscript_keys_fixed', 't:VoiceTranscript_no_delete', 't:VoiceTranscript_no_truncate',
    ]);
    expect(before.find((r) => r.k === 'c:VoiceTranscript_projectId_mediaId_fkey')?.d).toMatch(/ON DELETE CASCADE/);
    const onMedia = () => t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgrelid = '"Media"'::regclass AND tgname = 'Media_voice_transcript_note_kept'`);
    const media = await onMedia();
    expect(media[0]?.d).toMatch(/BEFORE UPDATE OF mime ON public."Media" FOR EACH ROW/);
    replay();
    expect(await shape()).toEqual(before);
    expect(await onMedia()).toEqual(media);
  });
});
