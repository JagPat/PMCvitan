import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #1177 VT1b, the corrections table of "voice note to text": `20280128000000_voice_transcript_correction` adds
 * "VoiceTranscriptCorrection", a person's correction of a voice note's heard words, added and never changed. This proves
 * what PostgreSQL holds on every writer (C1-C6 in the migration), and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280128000000_voice_transcript_correction/migration.sql');

describe('#1177 voice-note corrections (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      // the notes take their transcripts and corrections with them, before the fixture's people go
      if (f) await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await f?.cleanup();
    } finally {
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = () => (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url(), '-f', MIGRATION], { stdio: 'pipe' });
  // a voice note in the project with its transcript, moved as far as `status` (done by default)
  const heard = async (projectId: string, status: 'pending' | 'running' | 'failed' | 'done' = 'done') => {
    const mediaId = (await t.prisma.media.create({ data: { projectId, kind: 'visit', mime: 'audio/webm', uploadedBy: f.memberUser.id, durationSec: 30 } })).id;
    await t.prisma.voiceTranscript.create({ data: { projectId, mediaId } });
    if (status === 'running' || status === 'failed') await raw(`UPDATE "VoiceTranscript" SET "status" = 'running', "providerJobId" = 'job' WHERE "mediaId" = $1`, mediaId);
    if (status === 'failed') await raw(`UPDATE "VoiceTranscript" SET "status" = 'failed' WHERE "mediaId" = $1`, mediaId);
    if (status === 'done') await raw(`UPDATE "VoiceTranscript" SET "status" = 'done', "text" = 'પાઇપ લાઇન' WHERE "mediaId" = $1`, mediaId);
    return mediaId;
  };
  const correct = (mediaId: string, text: string | null, projectId = f.projectA.id, by = f.memberUser.id) =>
    t.prisma.voiceTranscriptCorrection.create({ data: { projectId, mediaId, text, correctedById: by } });
  const insert = (mediaId: string, extra = '', values = '') =>
    raw(`INSERT INTO "VoiceTranscriptCorrection" ("id", "projectId", "mediaId", "text", "correctedById"${extra})
         VALUES (gen_random_uuid()::text, $1, $2, 'words', $3${values})`, f.projectA.id, mediaId, f.memberUser.id);
  const rows = (mediaId: string) => t.prisma.voiceTranscriptCorrection.findMany({ where: { mediaId }, orderBy: { seq: 'asc' } });

  it('names its transcript in the note\'s own project, and a real person (C1)', async () => {
    const m = await heard(f.projectA.id);
    await correct(m, 'pipe line');
    // another project's transcript, a transcript that does not exist, or a person who does not exist, is refused
    const other = await heard(f.projectB.id);
    await expect(correct(other, 'x')).rejects.toThrow(/VoiceTranscriptCorrection_projectId_mediaId_fkey|Foreign key/);
    await expect(insert('no-such-media')).rejects.toThrow(/VoiceTranscriptCorrection_projectId_mediaId_fkey/);
    await expect(raw(`INSERT INTO "VoiceTranscriptCorrection" ("id", "projectId", "mediaId", "text", "correctedById")
                      VALUES (gen_random_uuid()::text, $1, $2, 'x', 'no-such-user')`, f.projectA.id, m)).rejects.toThrow(/VoiceTranscriptCorrection_correctedById_fkey/);
    // a person who corrected a note is not deleted out from under the record
    await expect(raw(`DELETE FROM "User" WHERE "id" = $1`, f.memberUser.id)).rejects.toThrow(/VoiceTranscriptCorrection_correctedById_fkey|violates foreign key/);
  });

  it('is made only of heard words, once the transcript is done (C2)', async () => {
    for (const status of ['pending', 'running', 'failed'] as const) {
      const m = await heard(f.projectA.id, status);
      await expect(correct(m, 'early')).rejects.toThrow(new RegExp(`corrected only once its words are heard, and it is ${status}`));
    }
  });

  it('takes its place and its time from the database, newest last; going back is its own row (C3, C5)', async () => {
    const m = await heard(f.projectA.id);
    // whatever the writer sends for the place and the time
    await insert(m, ', "seq", "createdAt"', `, 7, '2001-01-01'`);
    await correct(m, 'second');
    await correct(m, null); // back to what was heard, attributed like any other
    await correct(m, 'fourth', f.projectA.id, f.ownerUser.id);
    const list = await rows(m);
    expect(list.map((r) => [r.seq, r.text, r.correctedById])).toEqual([
      [1, 'words', f.memberUser.id], [2, 'second', f.memberUser.id], [3, null, f.memberUser.id], [4, 'fourth', f.ownerUser.id],
    ]);
    const [{ fresh }] = await t.prisma.$queryRawUnsafe<Array<{ fresh: boolean }>>(
      `SELECT bool_and("createdAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour' AND "createdAt" <= clock_timestamp() AT TIME ZONE 'UTC') AS fresh
         FROM "VoiceTranscriptCorrection" WHERE "mediaId" = $1`, m);
    expect(fresh).toBe(true);
    // each note counts its own corrections
    const n = await heard(f.projectA.id);
    expect((await correct(n, 'other note')).seq).toBe(1);
  });

  it('puts two people correcting at once one after the other (C3)', async () => {
    const m = await heard(f.projectA.id);
    // the first correction is made on its own connection and held open, so the second has to wait for it
    const other = new PrismaClient();
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let made!: () => void;
      const firstMade = new Promise<void>((resolve) => { made = resolve; });
      const first = other.$transaction(async (tx) => {
        const row = await tx.voiceTranscriptCorrection.create({ data: { projectId: f.projectA.id, mediaId: m, text: 'first', correctedById: f.memberUser.id } });
        made();
        await released;
        return row;
      }, { timeout: 60_000 });
      await firstMade;
      const second = correct(m, 'second', f.projectA.id, f.ownerUser.id).then((row) => row);
      // the second waits on the transcript's lock (a signal from the server, not a clock)
      for (;;) {
        const [{ waiting }] = await other.$queryRawUnsafe<Array<{ waiting: boolean }>>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
                            AND query LIKE '%VoiceTranscriptCorrection%') AS waiting`);
        if (waiting) break;
      }
      release();
      expect((await first).seq).toBe(1);
      expect((await second).seq).toBe(2);
    } finally {
      await other.$disconnect();
    }
  });

  it('stamps the database clock\'s UTC time after the lock, whatever the session\'s zone or start (C3)', async () => {
    const m = await heard(f.projectA.id);
    const utcNow = `date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')`;
    // a session fourteen hours ahead of UTC does not put the time in the future
    const ahead = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      return tx.voiceTranscriptCorrection.create({ data: { projectId: f.projectA.id, mediaId: m, text: 'ahead', correctedById: f.memberUser.id } });
    });
    const [{ ok }] = await t.prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT "createdAt" <= ${utcNow} AND "createdAt" > ${utcNow} - interval '1 hour' AS ok FROM "VoiceTranscriptCorrection" WHERE "id" = $1`, ahead.id);
    expect(ok).toBe(true);
    // a transaction that began before another correction committed still stamps after it
    const other = new PrismaClient();
    try {
      let go!: () => void;
      const proceed = new Promise<void>((resolve) => { go = resolve; });
      let began!: () => void;
      const hasBegun = new Promise<void>((resolve) => { began = resolve; });
      const late = other.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT 1`);
        began();
        await proceed;
        return tx.voiceTranscriptCorrection.create({ data: { projectId: f.projectA.id, mediaId: m, text: 'late', correctedById: f.ownerUser.id } });
      }, { timeout: 60_000 });
      await hasBegun;
      const meanwhile = await correct(m, 'meanwhile');
      go();
      const row = await late;
      expect([meanwhile.seq, row.seq]).toEqual([2, 3]);
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(meanwhile.createdAt.getTime());
      expect(meanwhile.createdAt.getTime()).toBeGreaterThanOrEqual(ahead.createdAt.getTime());
    } finally {
      await other.$disconnect();
    }
  });

  it('is refused at a fixed snapshot, which could not count a correction committed while it waited (C3)', async () => {
    const m = await heard(f.projectA.id);
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      await expect(t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        await tx.$executeRawUnsafe(`INSERT INTO "VoiceTranscriptCorrection" ("id", "projectId", "mediaId", "text", "correctedById")
          VALUES (gen_random_uuid()::text, $1, $2, 'x', $3) ON CONFLICT DO NOTHING`, f.projectA.id, m, f.memberUser.id);
      })).rejects.toThrow(new RegExp(`only at READ COMMITTED, not ${level.toLowerCase()}`));
    }
    expect(await rows(m)).toEqual([]);
  });

  it('is well formed (C4)', async () => {
    const m = await heard(f.projectA.id);
    const shape = /VoiceTranscriptCorrection_shape_check/;
    await expect(correct(m, '')).rejects.toThrow(shape);
    await expect(correct(m, ' \n\t')).rejects.toThrow(shape);
    await expect(correct(m, 'x'.repeat(20001))).rejects.toThrow(shape);
    expect((await correct(m, 'x'.repeat(20000))).seq).toBe(1);
  });

  it('is kept as made: no change to its words, person, place or time (C5)', async () => {
    const m = await heard(f.projectA.id);
    const row = await correct(m, 'as made');
    const kept = /kept as made/;
    for (const assignment of [`"text" = 'rewritten'`, `"text" = NULL`, `"correctedById" = '${f.ownerUser.id}'`, `"seq" = 9`,
      `"createdAt" = 'infinity'`, `"createdAt" = "createdAt"`]) {
      await expect(raw(`UPDATE "VoiceTranscriptCorrection" SET ${assignment} WHERE "id" = $1`, row.id)).rejects.toThrow(kept);
    }
    await expect(t.prisma.voiceTranscriptCorrection.update({ where: { id: row.id }, data: { text: 'rewritten' } })).rejects.toThrow(kept);
    expect(await rows(m)).toEqual([row]);
  });

  it('goes only with its note (C6)', async () => {
    const m = await heard(f.projectA.id);
    await correct(m, 'stays');
    const alone = /goes only with that note/;
    await expect(raw(`DELETE FROM "VoiceTranscriptCorrection" WHERE "mediaId" = $1`, m)).rejects.toThrow(alone);
    await expect(t.prisma.voiceTranscriptCorrection.deleteMany({ where: { mediaId: m } })).rejects.toThrow(alone);
    await expect(raw(`TRUNCATE "VoiceTranscriptCorrection"`)).rejects.toThrow(/never truncated/);
    // nor by a DELETE that a writer's own trigger runs below depth 1: the transcript still stands
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.vt1b_wipe() RETURNS TRIGGER LANGUAGE plpgsql AS $f$
        BEGIN DELETE FROM public."VoiceTranscriptCorrection" WHERE "mediaId" = NEW."m"; RETURN NEW; END $f$`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE vt1b_wipe_go ("m" TEXT) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TRIGGER vt1b_wipe AFTER INSERT ON vt1b_wipe_go FOR EACH ROW EXECUTE FUNCTION pg_temp.vt1b_wipe()`);
      await tx.$executeRawUnsafe(`INSERT INTO vt1b_wipe_go VALUES ($1)`, m);
    })).rejects.toThrow(alone);
    // nor by deleting the transcript from such a trigger, which would take every correction by cascade (Codex #1213,
    // 4401865953): the transcript too goes only with its note
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.vt1b_wipe_t() RETURNS TRIGGER LANGUAGE plpgsql AS $f$
        BEGIN DELETE FROM public."VoiceTranscript" WHERE "mediaId" = NEW."m"; RETURN NEW; END $f$`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE vt1b_wipe_t_go ("m" TEXT) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TRIGGER vt1b_wipe_t AFTER INSERT ON vt1b_wipe_t_go FOR EACH ROW EXECUTE FUNCTION pg_temp.vt1b_wipe_t()`);
      await tx.$executeRawUnsafe(`INSERT INTO vt1b_wipe_t_go VALUES ($1)`, m);
    })).rejects.toThrow(/the transcript of voice note .* goes only with that note/);
    expect(await rows(m)).toHaveLength(1);
    // the note's own delete takes the transcript and its corrections (cascades, below trigger depth 1)
    await raw(`DELETE FROM "Media" WHERE "id" = $1`, m);
    expect(await t.prisma.voiceTranscriptCorrection.count({ where: { mediaId: m } })).toBe(0);
  });

  it('has exactly its keys, check, indexes and triggers, and re-runs over itself unchanged', async () => {
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ k: string; d: string }>>(
      `SELECT 'c:' || conname AS k, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = '"VoiceTranscriptCorrection"'::regclass
       UNION ALL SELECT 't:' || tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = '"VoiceTranscriptCorrection"'::regclass AND NOT tgisinternal
       UNION ALL SELECT 'i:' || indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = '"VoiceTranscriptCorrection"'::regclass
       ORDER BY 1`);
    const before = await shape();
    expect(before.map((r) => r.k)).toEqual([
      'c:VoiceTranscriptCorrection_correctedById_fkey', 'c:VoiceTranscriptCorrection_pkey',
      'c:VoiceTranscriptCorrection_projectId_mediaId_fkey', 'c:VoiceTranscriptCorrection_shape_check',
      'i:"VoiceTranscriptCorrection_correctedById_idx"', 'i:"VoiceTranscriptCorrection_pkey"', 'i:"VoiceTranscriptCorrection_projectId_mediaId_seq_key"',
      't:VoiceTranscriptCorrection_frozen', 't:VoiceTranscriptCorrection_insert', 't:VoiceTranscriptCorrection_no_delete', 't:VoiceTranscriptCorrection_no_truncate',
    ]);
    expect(before.find((r) => r.k === 'c:VoiceTranscriptCorrection_projectId_mediaId_fkey')?.d).toMatch(/REFERENCES "VoiceTranscript"\("projectId", "mediaId"\) ON DELETE CASCADE/);
    expect(before.find((r) => r.k === 'c:VoiceTranscriptCorrection_correctedById_fkey')?.d).toMatch(/ON DELETE RESTRICT/);
    replay();
    expect(await shape()).toEqual(before);
    // the transcript's delete guard is keyed on its note, not on trigger depth (Codex #1213, 4401865953)
    const [{ src }] = await t.prisma.$queryRawUnsafe<Array<{ src: string }>>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'media_voice_transcript_no_delete'`);
    expect(src).toMatch(/public\."Media"/);
    expect(src).not.toMatch(/pg_trigger_depth/);
  });
});
