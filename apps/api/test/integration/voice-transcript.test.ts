import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import type { SpeechJobState, SpeechProvider } from '../../src/media/speech/speech-provider';
import { CapabilitiesService, VOICE_TEXT_CAPABILITY } from '../../src/platform/capabilities.service';
import { ProjectController } from '../../src/snapshot/project.controller';
import { VoiceTranscriptService } from '../../src/media/voice-transcript.service';

/**
 * #1177 VT2-C1 — a voice note's words, through the real routes against PostgreSQL. The step that writes the words out
 * through the provider is VT2-C2's; here the rows it would leave are written directly, in VT1a's order. Proves: the
 * per-project switch (off = not found), no provider = 503 and nothing written, the one "Try again", the words kept as
 * heard beside an attributed correction, who may correct, a hidden place, an archived project, and tenancy. The provider
 * is configured but must never be called.
 */

/** A provider that is configured (the feature is open) and fails the test if anything here calls it. */
class SilentProvider implements SpeechProvider {
  calls = 0;
  async createJob(): Promise<string> { this.calls++; throw new Error('VT2-C1 makes no provider call'); }
  async startJob(): Promise<void> { this.calls++; throw new Error('VT2-C1 makes no provider call'); }
  async checkJob(): Promise<SpeechJobState> { this.calls++; throw new Error('VT2-C1 makes no provider call'); }
}

describe('#1177 VT2-C1 — a voice note\'s words read, corrected and tried again (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const provider = new SilentProvider();
  const extra: string[] = [];
  let pmc: string;
  let engineer: string;
  let engineerId: string;
  let contractor: string;
  let contractorId: string;
  let client: string;
  let otherPmc: string;

  const http = () => request(t.app.getHttpServer());
  const path = (mediaId: string, projectId = f.projectA.id) => `/projects/${projectId}/media/${mediaId}/transcript`;
  const get = (token: string, mediaId: string, projectId?: string) => http().get(path(mediaId, projectId)).set('Authorization', `Bearer ${token}`);
  const retry = (token: string, mediaId: string) => http().post(`${path(mediaId)}/retry`).set('Authorization', `Bearer ${token}`).send({});
  /** `basedOn`: the place of the correction the screen showed (0: none) */
  const correct = (token: string, mediaId: string, text: string | null, basedOn: number) =>
    http().post(`${path(mediaId)}/correction`).set('Authorization', `Bearer ${token}`).send({ text, basedOn });
  /** the words a job heard, as VT2-C2's step will store them: claimed, run as a job, then done (VT1a's order) */
  const heard = async (mediaId: string, text: string, languageCode: string | null = 'en-IN') => {
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId } });
    await t.prisma.voiceTranscript.update({ where: { mediaId }, data: { status: 'running', providerJobId: `job-${mediaId}` } });
    await t.prisma.voiceTranscript.update({ where: { mediaId }, data: { status: 'done', text, languageCode } });
  };
  /** a note whose tries are spent, as the step leaves it */
  const failedNote = async (mediaId: string) => {
    await t.prisma.voiceTranscript.create({ data: { projectId: f.projectA.id, mediaId } });
    await t.prisma.voiceTranscript.update({ where: { mediaId }, data: { status: 'running', providerJobId: `job-${mediaId}` } });
    await t.prisma.voiceTranscript.update({ where: { mediaId }, data: { status: 'failed', attempts: 3, lastError: 'Sarvam job Failed' } });
  };
  /** Holds the note's row as a delete would, until `release()`: a write that comes meanwhile waits at its first lock. */
  const holdNote = (mediaId: string) => {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const taken = new Promise<void>((r) => { held = r; });
    const done = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Media" WHERE "id" = ${mediaId} FOR UPDATE`;
      held();
      await released;
    }, { timeout: 30_000 });
    return { taken, release, done };
  };
  /** Waits, on PostgreSQL's own word, until `n` writes are queued on a note's row. */
  const queuedOnNote = async (n: number) => {
    for (;;) {
      const [row] = await t.prisma.$queryRaw<Array<{ c: number }>>`
        SELECT count(*)::int AS c FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%"Media"%FOR NO KEY UPDATE%'`;
      if (Number(row!.c) >= n) return;
      await new Promise((r) => setImmediate(r));
    }
  };
  const note = async (uploadedBy = f.memberUser.id, projectId = f.projectA.id, mime = 'audio/webm') =>
    (await t.prisma.media.create({
      data: { projectId, kind: 'visit', mime, uploadedBy, durationSec: 12, data: Buffer.from('a recording') },
    })).id;

  beforeAll(async () => {
    t = await createTestApp({ speechProvider: provider });
    f = await createTwoProjectFixture(t.prisma);
    for (const role of ['engineer', 'contractor'] as const) {
      const id = `vt-${role}-${f.projectA.id}`;
      extra.push(id);
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: role, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    }
    [engineerId, contractorId] = extra as [string, string];
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engineer = t.issueProjectToken(engineerId, f.projectA.id, 'engineer');
    contractor = t.issueProjectToken(contractorId, f.projectA.id, 'contractor');
    client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    otherPmc = t.issueProjectToken(f.otherUser.id, f.projectB.id);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      if (f) {
        await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
        await t.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id, id: { startsWith: 'vt-draft-' } } });
        await t.prisma.projectCapability.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
        await t.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
        await t.prisma.user.deleteMany({ where: { id: { in: extra } } });
        await f.cleanup();
      }
    } finally {
      await t.close();
    }
  });

  it('is not there for a project whose switch is off', async () => {
    const m = await note();
    expect((await get(pmc, m)).status).toBe(404);
    expect((await retry(pmc, m)).status).toBe(404);
    expect((await correct(pmc, m, 'words', 0)).status).toBe(404);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: m } })).toBe(0);
    await t.app.get(CapabilitiesService).enable(f.projectA.id, VOICE_TEXT_CAPABILITY, f.memberUser.id);
  });

  it('reads a note nothing has been asked of yet as none, and writes nothing on a read', async () => {
    const m = await note();
    expect((await get(pmc, m)).body).toEqual({
      mediaId: m, status: 'none', text: null, languageCode: null, correction: null, correctionSeq: 0, canCorrect: false, canRetry: false,
    });
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: m } })).toBe(0);
  });

  it('with no provider configured, no route reads or writes a transcript, and the shell does not offer it', async () => {
    const m = await note();
    await heard(m, 'words heard');
    const f2 = await note();
    await failedNote(f2);
    const shell = async () => (await http().get(`/projects/${f.projectA.id}/shell`).set('Authorization', `Bearer ${pmc}`).expect(200)).body.capabilities as string[];
    expect(await shell()).toContain(VOICE_TEXT_CAPABILITY);
    const service = t.app.get(VoiceTranscriptService) as unknown as { provider: SpeechProvider | null };
    const controller = t.app.get(ProjectController) as unknown as { speech: SpeechProvider | null };
    service.provider = null;
    controller.speech = null;
    try {
      // the switch is still on, but with no provider the feature is closed and not offered
      expect(await shell()).not.toContain(VOICE_TEXT_CAPABILITY);
      expect((await get(pmc, m)).status).toBe(503);
      expect((await correct(pmc, m, 'new words', 0)).status).toBe(503);
      expect((await retry(pmc, f2)).status).toBe(503);
      expect(await t.prisma.voiceTranscriptCorrection.count({ where: { mediaId: m } })).toBe(0);
      // the one "Try again" is kept for when a provider is configured
      expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: f2 } })).toMatchObject({ status: 'failed', retried: false });
    } finally {
      service.provider = provider;
      controller.speech = provider;
    }
  });

  it('"Try again" starts a failed note over once, by the people allowed to, and never twice', async () => {
    const m = await note();
    await failedNote(m);
    expect((await get(pmc, m)).body).toMatchObject({ status: 'failed', canRetry: true });
    expect((await get(client, m)).body).toMatchObject({ status: 'failed', canRetry: false });
    expect((await retry(client, m)).status).toBe(403);
    expect((await retry(engineer, m)).body).toMatchObject({ status: 'pending', canRetry: false });
    // the row starts over as a fresh claim: no job, no tries, no error, marked retried (VT1a)
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({
      status: 'pending', providerJobId: null, attempts: 0, retried: true, lastError: null, leaseToken: null,
    });
    // asked again once started over (a lost answer sent again): answered as the first was, and nothing written
    const before = await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } });
    expect((await retry(pmc, m)).body).toMatchObject({ status: 'pending', canRetry: false });
    expect((await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).updatedAt).toEqual(before.updatedAt);
    // once only: after failing again there is no try left
    await t.prisma.voiceTranscript.update({ where: { mediaId: m }, data: { status: 'running', providerJobId: `job2-${m}` } });
    await t.prisma.voiceTranscript.update({ where: { mediaId: m }, data: { status: 'failed', attempts: 3, lastError: 'Sarvam job Failed' } });
    expect((await retry(pmc, m)).status).toBe(409);
    const done = await note();
    await heard(done, 'words heard');
    expect((await retry(pmc, done)).status).toBe(409);
    const untouched = await note();
    expect((await retry(pmc, untouched)).status).toBe(409);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: untouched } })).toBe(0);
  });

  it('two people asking "Try again" at once: it starts over once, and both are told it has', async () => {
    const m = await note();
    await failedNote(m);
    // both queue behind a held row, then go one after the other: the second finds it started over
    const hold = holdNote(m);
    await hold.taken;
    const answers = Promise.all([retry(pmc, m), retry(engineer, m)]);
    await queuedOnNote(2);
    hold.release();
    await hold.done;
    expect((await answers).map((r) => [r.status, r.body.status])).toEqual([[200, 'pending'], [200, 'pending']]);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({ status: 'pending', retried: true, attempts: 0 });
  });

  it('the person who recorded a note may correct it and try again whatever their role is now', async () => {
    const m = await note(contractorId);
    await failedNote(m);
    const n = await note(contractorId);
    await heard(n, 'words heard');
    // the recorder is a consultant now: a role that may neither correct nor try again on someone else's note
    await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: contractorId }, data: { role: 'consultant' } });
    try {
      const recorder = t.issueProjectToken(contractorId, f.projectA.id, 'consultant');
      expect((await get(recorder, m)).body).toMatchObject({ status: 'failed', canRetry: true });
      expect((await retry(recorder, m)).body).toMatchObject({ status: 'pending' });
      expect((await get(recorder, n)).body).toMatchObject({ status: 'done', canCorrect: true });
      expect((await correct(recorder, n, 'words said', 0)).body).toMatchObject({ correction: { text: 'words said', byId: contractorId } });
      const other = await note();
      await heard(other, 'words heard');
      expect((await correct(recorder, other, 'not mine', 0)).status).toBe(403);
    } finally {
      await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: contractorId }, data: { role: 'contractor' } });
    }
  });

  it('keeps the words heard beside a correction that names who wrote it, by the people allowed to', async () => {
    const m = await note(contractorId);
    expect((await correct(pmc, m, 'too early', 0)).status).toBe(409);
    await heard(m, 'pipe line goes from hear');
    expect((await get(pmc, m)).body).toMatchObject({ status: 'done', text: 'pipe line goes from hear', languageCode: 'en-IN', correctionSeq: 0 });

    expect((await correct(client, m, 'not mine', 0)).status).toBe(403);
    expect((await correct(engineer, m, '   ', 0)).status).toBe(400);
    // spaces outside ASCII (ideographic, no-break, next-line) and marks that show nothing are blank too
    expect((await correct(engineer, m, '\u3000\u00a0 ', 0)).status).toBe(400);
    expect((await correct(engineer, m, '\u0085', 0)).status).toBe(400);
    expect((await correct(engineer, m, '\u200b\ufeff \u2060', 0)).status).toBe(400);
    for (const blank of ['\u2800', '\u3164', '\u200d\ufe0f', '\u0301', '\u115f\u1160\uffa0']) {
      expect((await correct(engineer, m, blank, 0)).status, JSON.stringify(blank)).toBe(400);
    }
    expect((await correct(engineer, m, 'x'.repeat(20_001), 0)).status).toBe(400);
    expect((await correct(engineer, m, 'a\u0000b', 0)).status).toBe(400);
    // half a surrogate pair is no character, and PostgreSQL cannot hold it
    expect((await correct(engineer, m, 'a\ud800b', 0)).status).toBe(400);
    expect((await correct(engineer, m, 'a\udc00', 0)).status).toBe(400);
    // the words heard, sent back as they are, are no correction
    expect((await correct(engineer, m, ' pipe line goes from hear ', 0)).body).toMatchObject({ correction: null, correctionSeq: 0 });
    expect(await t.prisma.voiceTranscriptCorrection.count({ where: { mediaId: m } })).toBe(0);

    const byEngineer = await correct(engineer, m, '  Pipe line goes from here 😀', 0);
    expect(byEngineer.status).toBe(200);
    expect(byEngineer.body).toMatchObject({ status: 'done', text: 'pipe line goes from hear', correction: { text: 'Pipe line goes from here 😀', byId: engineerId }, correctionSeq: 1 });
    const at = byEngineer.body.correction.at as string;
    // the same correction sent again by its author (its answer lost): answered as the first was, and nothing added
    expect((await correct(engineer, m, '  Pipe line goes from here 😀', 0)).body).toMatchObject({ correction: { text: 'Pipe line goes from here 😀', byId: engineerId, at }, correctionSeq: 1 });

    // the same words again change nothing, not even who wrote them
    expect((await correct(contractor, m, 'Pipe line goes from here 😀', 1)).body.correction).toEqual({ text: 'Pipe line goes from here 😀', byId: engineerId, at });
    // a screen still showing the words heard does not replace the newer correction it never showed
    const stale = await correct(contractor, m, 'Pipe line starts there', 0);
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe('Someone else changed these words just now');
    // the person who recorded it may correct it
    expect((await correct(contractor, m, 'Pipe line starts here', 1)).body).toMatchObject({ correction: { text: 'Pipe line starts here', byId: contractorId }, correctionSeq: 2 });
    // and the correction can be taken back
    expect((await correct(pmc, m, null, 2)).body).toMatchObject({ text: 'pipe line goes from hear', correction: null, correctionSeq: 3 });
    // taking it back again changes nothing, nor do the words heard sent back unchanged
    expect((await correct(pmc, m, null, 3)).body).toMatchObject({ correction: null, correctionSeq: 3 });
    expect((await correct(pmc, m, 'pipe line goes from hear', 3)).body).toMatchObject({ correction: null, correctionSeq: 3 });

    // every change is its own row, in order, by whom it was made; the same words again added none (VT1b)
    const kept = await t.prisma.voiceTranscriptCorrection.findMany({ where: { mediaId: m }, orderBy: { seq: 'asc' } });
    expect(kept.map((r) => [r.seq, r.text, r.correctedById])).toEqual([
      [1, 'Pipe line goes from here 😀', engineerId], [2, 'Pipe line starts here', contractorId], [3, null, f.memberUser.id],
    ]);
    // the words heard are as heard
    expect((await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).text).toBe('pipe line goes from hear');

    // the client reads the words but may not change them
    expect((await get(client, m)).body).toMatchObject({ status: 'done', canCorrect: false, correctionSeq: 3 });
  });

  it('two people correcting the same words at once: one is kept, the other is told', async () => {
    const m = await note();
    await heard(m, 'words heard');
    // both queue behind a held row, then go one after the other: the second was made on words that changed since
    const hold = holdNote(m);
    await hold.taken;
    const answers = Promise.all([correct(pmc, m, 'first words', 0), correct(engineer, m, 'second words', 0)]);
    await queuedOnNote(2);
    hold.release();
    await hold.done;
    expect((await answers).map((r) => r.status).sort()).toEqual([200, 409]);
    const kept = await t.prisma.voiceTranscriptCorrection.findMany({ where: { mediaId: m } });
    expect(kept).toHaveLength(1);
    expect((await get(pmc, m)).body).toMatchObject({ correction: { text: kept[0]!.text }, correctionSeq: 1 });
  });

  it('words heard with spaces about them, sent back as shown, are no correction', async () => {
    const m = await note();
    await heard(m, '  padded heard words \n');
    expect((await correct(engineer, m, '  padded heard words \n', 0)).body).toMatchObject({ correction: null, correctionSeq: 0 });
    expect(await t.prisma.voiceTranscriptCorrection.count({ where: { mediaId: m } })).toBe(0);
  });

  it('a note filed on another member\'s private draft place is not found by others', async () => {
    const nodeId = `vt-draft-${f.projectA.id}`;
    await t.prisma.projectNode.create({ data: { id: nodeId, projectId: f.projectA.id, name: 'draft', kind: 'zone', publishedAt: null, authorId: f.memberUser.id } });
    const m = (await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'visit', mime: 'audio/webm', uploadedBy: f.memberUser.id, durationSec: 12, data: Buffer.from('a recording'), nodeId },
    })).id;
    expect((await get(engineer, m)).status).toBe(404);
    expect((await retry(engineer, m)).status).toBe(404);
    expect((await correct(engineer, m, 'words', 0)).status).toBe(404);
    expect((await get(pmc, m)).status).toBe(200);
  });

  it('a write on a note filed on a place takes the place tree before the note\'s row, as a node delete and a visit removal do', async () => {
    const nodeId = `vt-place-${f.projectA.id}`;
    await t.prisma.projectNode.create({ data: { id: nodeId, projectId: f.projectA.id, name: 'kitchen', kind: 'zone', publishedAt: new Date(), authorId: f.memberUser.id } });
    try {
      const m = (await t.prisma.media.create({
        data: { projectId: f.projectA.id, kind: 'visit', mime: 'audio/webm', uploadedBy: f.memberUser.id, durationSec: 12, data: Buffer.from('a recording'), nodeId },
      })).id;
      await heard(m, 'words heard');
      // the project's row held, so the write stops inside its transaction at `phase6_project_operable`, after the note's
      // row and after the route's own visibility check (which reads the tree in a transaction of its own)
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const taken = new Promise<void>((r) => { held = r; });
      const holder = t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Project" WHERE "id" = ${f.projectA.id} FOR UPDATE`;
        held();
        await released;
      }, { timeout: 30_000 });
      await taken;
      const answer = correct(engineer, m, 'filed words', 0).then((r) => r);
      for (;;) {
        const [row] = await t.prisma.$queryRaw<Array<{ c: number }>>`
          SELECT count(*)::int AS c FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%phase6_project_operable%'`;
        if (Number(row!.c) >= 1) break;
        await new Promise((r) => setImmediate(r));
      }
      // waiting there, the write already holds the tree's shared side, taken before the note's row: a node delete or a
      // visit removal (tree first, then the note's row) waits at the tree and never holds the note's row the write needs
      const [tree] = await t.prisma.$transaction(async (tx) =>
        tx.$queryRaw<Array<{ got: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`project-tree:${f.projectA.id}`}, 0)) AS got`);
      expect(tree!.got).toBe(false);
      release();
      await holder;
      expect((await answer).body).toMatchObject({ correction: { text: 'filed words' }, correctionSeq: 1 });
    } finally {
      await t.prisma.media.deleteMany({ where: { nodeId } });
      await t.prisma.projectNode.deleteMany({ where: { id: nodeId } });
    }
  });

  it('a write asks again, under lock, everything it was let through on: archive, membership, the switch', async () => {
    // each change commits while the write waits at its first lock, after the route let it through
    const raced = async (change: () => Promise<unknown>, undo: () => Promise<unknown>, send: (m: string) => Promise<request.Response>) => {
      const m = await note();
      await heard(m, 'words heard');
      const hold = holdNote(m);
      await hold.taken;
      // a supertest request is sent only once something waits on it
      const answer = send(m).then((r) => r);
      await queuedOnNote(1);
      await change();
      hold.release();
      await hold.done;
      try {
        return (await answer).status;
      } finally {
        await undo();
        expect(await t.prisma.voiceTranscriptCorrection.count({ where: { mediaId: m } })).toBe(0);
      }
    };
    const archive = () => t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = now() WHERE "id" = ${f.projectA.id}`;
    const unarchive = () => t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = ${f.projectA.id}`;
    expect(await raced(archive, unarchive, (m) => correct(engineer, m, 'after archive', 0))).toBe(403);
    const leave = () => t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: engineerId }, data: { status: 'removed' } });
    const rejoin = () => t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: engineerId }, data: { status: 'active' } });
    expect(await raced(leave, rejoin, (m) => correct(engineer, m, 'after leaving', 0))).toBe(403);
    const off = () => t.prisma.projectCapability.deleteMany({ where: { projectId: f.projectA.id, capability: VOICE_TEXT_CAPABILITY } });
    const on = () => t.app.get(CapabilitiesService).enable(f.projectA.id, VOICE_TEXT_CAPABILITY, f.memberUser.id);
    expect(await raced(off, on, (m) => correct(engineer, m, 'after switch-off', 0))).toBe(404);
    // and "Try again" the same way
    const m = await note();
    await failedNote(m);
    const hold = holdNote(m);
    await hold.taken;
    const answer = retry(engineer, m).then((r) => r);
    await queuedOnNote(1);
    await archive();
    hold.release();
    await hold.done;
    try {
      expect((await answer).status).toBe(403);
    } finally {
      await unarchive();
    }
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({ status: 'failed', retried: false });
  });

  it('is refused on an archived project', async () => {
    const m = await note();
    await failedNote(m);
    await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = now() WHERE "id" = ${f.projectA.id}`;
    try {
      expect((await get(pmc, m)).status).toBe(403);
      expect((await retry(pmc, m)).status).toBe(403);
      expect((await correct(pmc, m, 'words', 0)).status).toBe(403);
    } finally {
      await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = ${f.projectA.id}`;
    }
  });

  it('is only for a voice note of the project named, as its members see it', async () => {
    const photo = (await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: f.memberUser.id, data: Buffer.from('png') },
    })).id;
    expect((await get(pmc, photo)).status).toBe(404);
    expect((await retry(pmc, photo)).status).toBe(404);

    await t.app.get(CapabilitiesService).enable(f.projectB.id, VOICE_TEXT_CAPABILITY, f.otherUser.id);
    const m = await note();
    // another project's member, through their own project or through this one
    await failedNote(m);
    expect((await get(otherPmc, m, f.projectB.id)).status).toBe(404);
    expect([403, 404]).toContain((await get(otherPmc, m)).status);
    expect([403, 404]).toContain((await retry(otherPmc, m)).status);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({ status: 'failed', retried: false });
  });

  it('never calls the provider', () => {
    expect(provider.calls).toBe(0);
  });
});
