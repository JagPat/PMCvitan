import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #1177 VT1a, the transcripts table of "voice note to text": `20280126000000_voice_transcript` adds "VoiceTranscript",
 * at most one row per voice note, holding the provider job's progress and the words it heard. This proves what
 * PostgreSQL holds on every writer (V1-V5 in the migration), and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280126000000_voice_transcript/migration.sql');
const STAMP = join(__dirname, '../../prisma/migrations/20280129000000_voice_transcript_stamp/migration.sql');
const RUNNING_SINCE = join(__dirname, '../../prisma/migrations/20280130000000_voice_transcript_running_since/migration.sql');
const BUSY_INDEX = join(__dirname, '../../prisma/migrations/20280131000000_voice_transcript_busy_index/migration.sql');
const CORRECTIONS = join(__dirname, '../../prisma/migrations/20280128000000_voice_transcript_correction/migration.sql');

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
  const replayCorrections = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url(), '-f', CORRECTIONS], { stdio: 'pipe' });
  const replayRunningSince = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url(), '-f', RUNNING_SINCE], { stdio: 'pipe' });
  const replayBusyIndex = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url(), '-f', BUSY_INDEX], { stdio: 'pipe' });
  const replayStamp = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url(), '-f', STAMP], { stdio: 'pipe' });
  const voice = async (projectId: string) =>
    (await t.prisma.media.create({ data: { projectId, kind: 'visit', mime: 'audio/webm', uploadedBy: f.memberUser.id, durationSec: 30 } })).id;
  const insert = (projectId: string, mediaId: string, extra = '', values = '') =>
    raw(`INSERT INTO "VoiceTranscript" ("projectId", "mediaId", "updatedAt"${extra}) VALUES ($1, $2, now()${values})`, projectId, mediaId);
  const claim = (mediaId: string) => t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId } });
  const set = (mediaId: string, assignments: string) => raw(`UPDATE "VoiceTranscript" SET ${assignments} WHERE "mediaId" = $1`, mediaId);

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

  it('starts as a bare claim, whatever the writer (V2)', async () => {
    const bare = /starts as a bare claim/;
    for (const [column, value] of [
      ['"status"', `'done'`], ['"status"', `'running'`], ['"providerJobId"', `'job-0'`], ['"text"', `'words'`],
      ['"languageCode"', `'gu-IN'`], ['"attempts"', '1'], ['"retried"', 'true'], ['"lastError"', `'x'`], ['"leaseToken"', `'tok'`],
    ] as const) {
      await expect(insert(f.projectA.id, await voice(f.projectA.id), `, ${column}`, `, ${value}`)).rejects.toThrow(bare);
    }
    await expect(t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: await voice(f.projectA.id), status: 'done', text: '' } })).rejects.toThrow(bare);
    // its creation time is the database clock's UTC time, whatever the writer sends (#1177 VT1c)
    const utcNow = `date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')`;
    const fresh = async (mediaId: string) => (await t.prisma.$queryRawUnsafe<Array<{ fresh: boolean }>>(
      `SELECT "createdAt" > ${utcNow} - interval '1 hour' AND "createdAt" <= ${utcNow} AS fresh FROM "VoiceTranscript" WHERE "mediaId" = $1`, mediaId))[0]!.fresh;
    const m = await voice(f.projectA.id);
    await insert(f.projectA.id, m, ', "createdAt"', `, '2001-01-01'`);
    expect(await fresh(m)).toBe(true);
    // nor is it moved by the session's time zone (fourteen hours ahead of UTC here), and it is never before its
    // transaction began (that the stamp is the clock read, not the transaction start, the replay test checks by source)
    const n = await voice(f.projectA.id);
    const before = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      const [{ began }] = await tx.$queryRawUnsafe<Array<{ began: Date }>>(`SELECT date_trunc('milliseconds', now() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS began`);
      await tx.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: n } });
      return began;
    });
    expect(await fresh(n)).toBe(true);
    const row = await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: n } });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
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
    await claim(m);
    await set(m, `"status" = 'running', "providerJobId" = 'job-2'`);
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
    // at READ COMMITTED a file with no transcript is not this trigger's concern (a fixed-snapshot writer is refused
    // for any voice note leaving audio, since it could not see a transcript committed while it waited)
    const n = await voice(f.projectA.id);
    await raw(`UPDATE "Media" SET "mime" = 'image/png', "durationSec" = NULL WHERE "id" = $1`, n);
  });

  it('is never deleted on its own, so heard words cannot be erased and written again (V5)', async () => {
    const m = await voice(f.projectA.id);
    await claim(m);
    await set(m, `"status" = 'done', "text" = 'પાઇપ લાઇન'`);
    const alone = /goes only with that note/;
    await expect(raw(`DELETE FROM "VoiceTranscript" WHERE "mediaId" = $1`, m)).rejects.toThrow(alone);
    await expect(t.prisma.voiceTranscript.deleteMany({ where: { mediaId: m } })).rejects.toThrow(alone);
    // an unfinished row is held the same way: only its note takes it
    const n = await voice(f.projectA.id);
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId: n } });
    await expect(raw(`DELETE FROM "VoiceTranscript" WHERE "mediaId" = $1`, n)).rejects.toThrow(alone);
    // with CASCADE, since its corrections (#1177 VT1b) reference it; their own seal refuses the same statement
    await expect(raw(`TRUNCATE "VoiceTranscript" CASCADE`)).rejects.toThrow(/never truncated/);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({ status: 'done', text: 'પાઇપ લાઇન' });
    // the note's own delete still takes it (a cascade, below trigger depth 1)
    await raw(`DELETE FROM "Media" WHERE "id" IN ($1, $2)`, m, n);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: { in: [m, n] } } })).toBe(0);
  });

  it('is well formed (V3)', async () => {
    const m = await voice(f.projectA.id);
    await claim(m);
    const refused = /VoiceTranscript_shape_check/;
    await expect(set(m, `"status" = 'finished'`)).rejects.toThrow(refused);
    await expect(set(m, `"status" = 'done'`)).rejects.toThrow(refused); // done without words
    await expect(set(m, `"text" = 'words'`)).rejects.toThrow(refused); // words before done
    await expect(set(m, `"leaseToken" = 'tok'`)).rejects.toThrow(refused); // a token without its expiry
    await expect(set(m, `"leaseToken" = E' \\t\\n', "leaseUntil" = now()`)).rejects.toThrow(refused);
    await expect(set(m, `"leaseToken" = 'tok', "leaseUntil" = 'infinity'`)).rejects.toThrow(refused);
    await expect(set(m, `"updatedAt" = 'infinity'`)).rejects.toThrow(refused);
    await expect(set(m, `"status" = 'running', "providerJobId" = E'\\t\\n'`)).rejects.toThrow(refused);
    await expect(set(m, `"status" = 'running'`)).rejects.toThrow(refused); // running without its job
    await expect(set(m, `"languageCode" = 'Gujarati'`)).rejects.toThrow(refused);
    await expect(set(m, `"status" = 'done', "text" = 'x', "languageCode" = 'Gujarati'`)).rejects.toThrow(refused);
    await expect(set(m, `"attempts" = 11`)).rejects.toThrow(refused);
    await expect(set(m, `"attempts" = -1`)).rejects.toThrow(/only rise/); // tries never fall within a try (the check bounds them too)
    await expect(set(m, `"lastError" = repeat('x', 501)`)).rejects.toThrow(refused);
    await expect(set(m, `"status" = 'done', "text" = repeat('x', 20001)`)).rejects.toThrow(refused);
  });

  it('becomes done with the job it was heard by, then keeps every word as heard (V4)', async () => {
    const m = await voice(f.projectA.id);
    await claim(m);
    await set(m, `"status" = 'running', "providerJobId" = 'job-3', "attempts" = 1, "leaseToken" = 'tok', "leaseUntil" = now()`);
    // a running row does not go back to a claim (with or without its job)
    await expect(set(m, `"status" = 'pending'`)).rejects.toThrow(/only forward/);
    // the update that makes it done may not drop or swap the job (Codex #1182, 4398744242)
    const once = /is set once per try/;
    await expect(set(m, `"status" = 'done', "text" = 'x', "providerJobId" = NULL`)).rejects.toThrow(once);
    await expect(set(m, `"status" = 'done', "text" = 'x', "providerJobId" = 'job-other'`)).rejects.toThrow(once);
    // ...nor one statement earlier (the gap-check's bypasses): no swap while running, no drop on the way to failed
    await expect(set(m, `"providerJobId" = 'job-9'`)).rejects.toThrow(once);
    await expect(set(m, `"status" = 'failed', "providerJobId" = NULL`)).rejects.toThrow(once);
    await expect(set(m, `"status" = 'pending', "providerJobId" = NULL`)).rejects.toThrow(once);
    await set(m, `"status" = 'done', "text" = 'પાઇપ લાઇન અહીંથી જશે', "languageCode" = 'gu-IN', "leaseToken" = NULL, "leaseUntil" = NULL`);
    // once done, nothing in the row moves but its update time
    const kept = /kept as heard/;
    await expect(set(m, `"status" = 'running', "text" = NULL`)).rejects.toThrow(kept);
    await expect(set(m, `"status" = 'failed', "text" = NULL`)).rejects.toThrow(kept);
    await expect(set(m, `"text" = 'a late answer'`)).rejects.toThrow(kept);
    await expect(set(m, `"languageCode" = 'hi-IN'`)).rejects.toThrow(kept);
    await expect(set(m, `"providerJobId" = 'job-other'`)).rejects.toThrow(kept);
    await expect(set(m, `"providerJobId" = NULL`)).rejects.toThrow(kept);
    await expect(set(m, `"attempts" = 2`)).rejects.toThrow(kept);
    await expect(set(m, `"lastError" = 'late'`)).rejects.toThrow(kept);
    await expect(set(m, `"retried" = true`)).rejects.toThrow(kept);
    await expect(set(m, `"leaseToken" = 'tok2', "leaseUntil" = now()`)).rejects.toThrow(kept);
    await set(m, `"updatedAt" = now()`);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } }))
      .toMatchObject({ status: 'done', text: 'પાઇપ લાઇન અહીંથી જશે', languageCode: 'gu-IN', providerJobId: 'job-3', attempts: 1 });
  });

  it('a short note sent whole is done with no job, and a note with no speech is done with no words (V3, V4)', async () => {
    const m = await voice(f.projectA.id);
    await claim(m);
    await set(m, `"status" = 'done', "text" = ''`);
    await expect(set(m, `"text" = 'x'`)).rejects.toThrow(/kept as heard/);
    // a failed try is retried as a fresh claim, and its next job is its own
    const n = await voice(f.projectA.id);
    await claim(n);
    await set(n, `"status" = 'running', "providerJobId" = 'job-4', "attempts" = 1, "leaseToken" = 'tok', "leaseUntil" = now()`);
    // within a try the tries only rise, the retry mark is the fresh claim's alone, and a language comes only with words
    await expect(set(n, `"attempts" = 0`)).rejects.toThrow(/only rise, until a fresh claim/);
    await expect(set(n, `"retried" = true`)).rejects.toThrow(/marked retried only by its fresh claim/);
    await expect(set(n, `"languageCode" = 'gu-IN'`)).rejects.toThrow(/VoiceTranscript_shape_check/);
    await set(n, `"status" = 'failed', "attempts" = 2, "lastError" = 'provider refused'`); // the lease stays with the try
    // a failed row is never taken back up: not to done, not to running (then done, Codex #1208, 4399524540)
    const forward = /only forward, or from failed to a fresh retried claim/;
    await expect(set(n, `"status" = 'done', "text" = 'x'`)).rejects.toThrow(forward);
    await expect(set(n, `"status" = 'running'`)).rejects.toThrow(forward);
    // ...and it starts over only as a bare claim marked retried, keeping nothing of the failed try: not its job, its
    // tries, its error or its lease (Codex #1208, 4399950031)
    await expect(set(n, `"status" = 'pending', "providerJobId" = NULL, "attempts" = 0, "lastError" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL`)).rejects.toThrow(/is set once per try/);
    const fresh = /starts over only as a fresh retried claim/;
    const clean = `"providerJobId" = NULL, "attempts" = 0, "retried" = true, "lastError" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL`;
    await expect(set(n, `"status" = 'pending'`)).rejects.toThrow(fresh);
    await expect(set(n, `"status" = 'pending', ${clean.replace('"attempts" = 0', '"attempts" = 2')}`)).rejects.toThrow(fresh);
    await expect(set(n, `"status" = 'pending', ${clean.replace('"lastError" = NULL', '"lastError" = \'provider refused\'')}`)).rejects.toThrow(fresh);
    await expect(set(n, `"status" = 'pending', ${clean.replace('"leaseToken" = NULL, "leaseUntil" = NULL', '"leaseToken" = \'tok\'')}`)).rejects.toThrow(fresh);
    await set(n, `"status" = 'pending', ${clean}`);
    await set(n, `"status" = 'running', "providerJobId" = 'job-5', "attempts" = 1`);
    // the retry mark is never cleared, so the done row keeps its history (Codex #1208, 4399950036)
    await expect(set(n, `"retried" = false`)).rejects.toThrow(/marked retried only by its fresh claim/);
    await set(n, `"status" = 'done', "text" = 'words', "languageCode" = 'en'`);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: n } })).toMatchObject({ providerJobId: 'job-5', retried: true, attempts: 1 });
  });

  it('stamps when each try\'s job was stored, whatever the writer sends, and clears it with the job (VT1d)', async () => {
    const since = async (mediaId: string) => (await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId } })).runningSince;
    const m = await voice(f.projectA.id);
    // a claim has no job and no start, whatever the writer sends
    await insert(f.projectA.id, m, ', "runningSince"', ", now() - interval '1 day'");
    expect(await since(m)).toBeNull();
    await set(m, `"runningSince" = now()`);
    expect(await since(m)).toBeNull();
    // the job's start is the database clock's UTC time when the job is stored, not the writer's
    const [{ before }] = await t.prisma.$queryRawUnsafe<Array<{ before: Date }>>(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS before`);
    await set(m, `"status" = 'running', "providerJobId" = 'job-1', "runningSince" = now() - interval '1 day'`);
    const started = await since(m);
    expect(started).not.toBeNull();
    expect(started!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(started!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    // it never moves while that job stands: not by a writer, not by the next check, not into done
    await set(m, `"runningSince" = now() - interval '1 hour'`);
    await set(m, `"attempts" = 1, "lastError" = 'busy'`);
    expect(await since(m)).toEqual(started);
    // in a session ahead of UTC it is still UTC (as VT1c's "createdAt")
    const n = await voice(f.projectA.id);
    await claim(n);
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      await tx.$executeRawUnsafe(`UPDATE "VoiceTranscript" SET "status" = 'running', "providerJobId" = 'job-k' WHERE "mediaId" = $1`, n);
    });
    expect((await since(n))!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    // a failed try's fresh claim clears it with the job, and the next job gets its own
    await set(m, `"status" = 'failed'`);
    expect(await since(m)).toEqual(started);
    await set(m, `"status" = 'pending', "providerJobId" = NULL, "attempts" = 0, "retried" = true, "lastError" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL, "runningSince" = now()`);
    expect(await since(m)).toBeNull();
    await set(m, `"status" = 'running', "providerJobId" = 'job-2'`);
    const again = await since(m);
    expect(again!.getTime()).toBeGreaterThanOrEqual(started!.getTime());
    // once done it is kept as it was, like every other column
    await set(m, `"status" = 'done', "text" = 'words'`);
    expect(await since(m)).toEqual(again);
    await expect(set(m, `"runningSince" = now() - interval '1 day'`)).rejects.toThrow(/kept as heard/);
    // a writer that skips the triggers (replica mode) still cannot part a job from its start
    const r = await voice(f.projectA.id);
    await claim(r);
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(`UPDATE "VoiceTranscript" SET "status" = 'running', "providerJobId" = 'job-r' WHERE "mediaId" = $1`, r);
    })).rejects.toThrow(/VoiceTranscript_running_since_check/);
    // a short note sent whole is done with no job, and so with no start
    const s = await voice(f.projectA.id);
    await claim(s);
    await set(s, `"status" = 'done', "text" = ''`);
    expect(await since(s)).toBeNull();
  });

  it('answers the busy lookup from its partial index, reading only recent rows with an error and no lease (VT1e)', async () => {
    // the lookup as the server asks it (Prisma's findFirst: an equality on the error, no lease, a recent write)
    const lookup = `SELECT "mediaId" FROM "VoiceTranscript" WHERE "lastError" = $1 AND "leaseToken" IS NULL AND "updatedAt" > $2 LIMIT 1`;
    const plan = await t.prisma.$transaction(async (tx) => {
      // the table is near empty here, so a scan would win on cost: forbid it, to ask only whether the index answers
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${lookup}`, 'Sarvam is busy; asking again shortly', new Date(Date.now() - 20_000));
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/Index (Only )?Scan using "VoiceTranscript_busy_lookup"|Bitmap Index Scan on "VoiceTranscript_busy_lookup"/);
    expect(plan).toMatch(/Index Cond: \("updatedAt" > /);
    // its predicate names no message text, so another busy wording is answered by the same index
    const [{ pred }] = await t.prisma.$queryRawUnsafe<Array<{ pred: string }>>(
      `SELECT pg_get_expr(indpred, indrelid) AS pred FROM pg_index WHERE indexrelid = 'public."VoiceTranscript_busy_lookup"'::regclass`);
    expect(pred).toBe('(("lastError" IS NOT NULL) AND ("leaseToken" IS NULL))');
  });

  it('has exactly its keys, check, indexes and triggers, and re-runs over itself unchanged', async () => {
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ k: string; d: string }>>(
      `SELECT 'c:' || conname AS k, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = '"VoiceTranscript"'::regclass
       UNION ALL SELECT 't:' || tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = '"VoiceTranscript"'::regclass AND NOT tgisinternal
       UNION ALL SELECT 'i:' || indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = '"VoiceTranscript"'::regclass
       ORDER BY 1`);
    const before = await shape();
    expect(before.map((r) => r.k)).toEqual([
      'c:VoiceTranscript_pkey', 'c:VoiceTranscript_projectId_mediaId_fkey', 'c:VoiceTranscript_running_since_check', 'c:VoiceTranscript_shape_check',
      'i:"VoiceTranscript_busy_lookup"', 'i:"VoiceTranscript_pkey"', 'i:"VoiceTranscript_projectId_mediaId_key"',
      't:VoiceTranscript_insert', 't:VoiceTranscript_keys_fixed', 't:VoiceTranscript_no_delete', 't:VoiceTranscript_no_truncate',
      't:VoiceTranscript_running_since',
    ]);
    expect(before.find((r) => r.k === 'c:VoiceTranscript_projectId_mediaId_fkey')?.d).toMatch(/ON DELETE CASCADE/);
    const onMedia = () => t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgrelid = '"Media"'::regclass AND tgname = 'Media_voice_transcript_note_kept'`);
    const media = await onMedia();
    expect(media[0]?.d).toMatch(/BEFORE UPDATE OF mime ON public."Media" FOR EACH ROW/);
    replay();
    // VT1b replaces this file's delete guard (Codex #1213, 4401865953), and runs after it on every deploy; so does it here
    replayCorrections();
    replayStamp();
    replayRunningSince();
    replayRunningSince();
    replayBusyIndex();
    replayBusyIndex();
    expect(await shape()).toEqual(before);
    // the job start stands after the replay, stamped by its own trigger after VT1a's rules
    expect(before.find((r) => r.k === 't:VoiceTranscript_running_since')?.d).toMatch(/BEFORE INSERT OR UPDATE ON public."VoiceTranscript" FOR EACH ROW/);
    // and the stamp that stands after the replay is VT1c's clock read, not VT1a's transaction start
    const [{ src }] = await t.prisma.$queryRawUnsafe<Array<{ src: string }>>(
      `SELECT prosrc AS src FROM pg_proc WHERE oid = 'public.media_voice_transcript_insert()'::regprocedure`);
    expect(src).toContain(`clock_timestamp() AT TIME ZONE 'UTC'`);
    // with the transaction's start as its floor, should the server's clock step back (Codex #1221, 4404642570)
    expect(src).toContain(`pg_catalog.now() AT TIME ZONE 'UTC'`);
    expect(src).not.toContain('LOCALTIMESTAMP');
    expect(await onMedia()).toEqual(media);
  });
});
