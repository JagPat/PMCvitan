import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { SpeechProviderError, type SpeechJobState, type SpeechProvider } from '../../src/media/speech/speech-provider';
import { CapabilitiesService, VOICE_TEXT_CAPABILITY } from '../../src/platform/capabilities.service';
import { TRANSCRIPT_MAX_ATTEMPTS } from '../../src/media/voice-transcript.service';

/**
 * #1177 VT2 — a voice note's words, through the real routes against PostgreSQL, with a fake speech provider in place
 * of Sarvam. Proves: the per-project switch (off = not found), one step per view (start, then check no more than every
 * few seconds), one paid job however many viewers ask at once, a note deleted while its job runs, bounded tries and the
 * one "Try again", the words kept as heard beside an attributed correction, who may correct, and tenancy.
 */

type Gate = { open: () => void; wait: Promise<void> };
const gate = (): Gate => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
};

class FakeProvider implements SpeechProvider {
  started: Array<{ bytes: number; mime: string; fileName: string }> = [];
  checked: string[] = [];
  startGate: Gate | null = null;
  /** signalled once startJob has been entered (a test waits on it, never on a clock) */
  entered: Gate | null = null;
  startError: SpeechProviderError | Error | null = null;
  checkError: SpeechProviderError | null = null;
  state: SpeechJobState = { state: 'running' };

  async startJob(audio: Buffer, mime: string, fileName: string): Promise<string> {
    this.started.push({ bytes: audio.length, mime, fileName });
    // the job's id is fixed when it is asked for, so a late answer names its own job
    const jobId = `job-${this.started.length}`;
    this.entered?.open();
    // only the first start waits at the gate; a second start (which must never happen) returns at once
    const waitFor = this.startGate;
    this.startGate = null;
    if (waitFor) await waitFor.wait;
    if (this.startError) throw this.startError;
    return jobId;
  }

  async checkJob(jobId: string): Promise<SpeechJobState> {
    this.checked.push(jobId);
    if (this.checkError) throw this.checkError;
    return this.state;
  }

  reset(): void {
    this.started = []; this.checked = []; this.startGate = null; this.entered = null; this.startError = null; this.checkError = null;
    this.state = { state: 'running' };
  }
}

describe('#1177 VT2 — a voice note written out (live PG, fake provider)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const provider = new FakeProvider();
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
  const advance = (token: string, mediaId: string, projectId?: string) => http().post(path(mediaId, projectId)).set('Authorization', `Bearer ${token}`).send({});
  const retry = (token: string, mediaId: string) => http().post(`${path(mediaId)}/retry`).set('Authorization', `Bearer ${token}`).send({});
  /** `basedOn`: the place of the correction the screen showed (0: none) */
  const correct = (token: string, mediaId: string, text: string | null, basedOn: number) =>
    http().post(`${path(mediaId)}/correction`).set('Authorization', `Bearer ${token}`).send({ text, basedOn });
  /** a running row was last looked at long enough ago to be checked again */
  const age = (mediaId: string, seconds = 60) =>
    t.prisma.$executeRaw`UPDATE "VoiceTranscript" SET "updatedAt" = now() - make_interval(secs => ${seconds}) WHERE "mediaId" = ${mediaId}`;
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

  beforeEach(() => provider.reset());

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
    expect((await advance(pmc, m)).status).toBe(404);
    expect(provider.started).toHaveLength(0);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: m } })).toBe(0);
    await t.app.get(CapabilitiesService).enable(f.projectA.id, VOICE_TEXT_CAPABILITY, f.memberUser.id);
  });

  it('starts one job, checks it no more than every few seconds, and keeps the words heard', async () => {
    const m = await note();
    expect((await get(pmc, m)).body).toMatchObject({ mediaId: m, status: 'none', text: null, correction: null });

    const started = await advance(pmc, m);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'running', text: null });
    expect(provider.started).toEqual([{ bytes: 'a recording'.length, mime: 'audio/webm', fileName: `${m}.webm` }]);

    // looked at again at once: the job is not asked about
    expect((await advance(engineer, m)).body.status).toBe('running');
    expect(provider.checked).toEqual([]);

    await age(m);
    expect((await advance(engineer, m)).body.status).toBe('running');
    expect(provider.checked).toEqual(['job-1']);

    provider.state = { state: 'done', text: 'પાઇપ લાઇન અહીંથી જશે', languageCode: 'gu-IN' };
    await age(m);
    const done = await advance(client, m);
    expect(done.body).toMatchObject({ status: 'done', text: 'પાઇપ લાઇન અહીંથી જશે', languageCode: 'gu-IN', canCorrect: false, canRetry: false });
    expect(provider.started).toHaveLength(1);

    // done is done: no further call, whoever looks
    await age(m);
    expect((await advance(pmc, m)).body).toMatchObject({ status: 'done', canCorrect: true });
    expect(provider.checked).toEqual(['job-1', 'job-1']);
  });

  it('a language code the database would refuse is dropped, and overlong words are cut to fit', async () => {
    const m = await note();
    await advance(pmc, m);
    provider.state = { state: 'done', text: 'x'.repeat(25_000), languageCode: 'Gujarati' };
    await age(m);
    const done = await advance(pmc, m);
    expect(done.body.status).toBe('done');
    expect(done.body.text).toHaveLength(20_000);
    expect(done.body.languageCode).toBeNull();

    // a NUL (which PostgreSQL text cannot hold) is dropped, and the cut never splits a character
    const n = await note();
    await advance(pmc, n);
    provider.state = { state: 'done', text: `a\u0000b${'x'.repeat(19_997)}😀`, languageCode: 'hi-IN' };
    await age(n);
    const fitted = await advance(pmc, n);
    expect(fitted.body.status).toBe('done');
    expect(fitted.body.text).toBe(`ab${'x'.repeat(19_997)}😀`);
  });

  it('starts one paid job however many people open the note at once', async () => {
    const m = await note();
    const held = gate();
    provider.startGate = held;
    provider.entered = gate();
    // supertest sends on `then`
    const first = advance(pmc, m).then((r) => r);
    await provider.entered.wait;
    // while the first step holds the claim, others read the row as it stands and start nothing
    const [second, third] = await Promise.all([advance(engineer, m), advance(client, m)]);
    expect(provider.started).toHaveLength(1);
    expect(second.body.status).toBe('pending');
    expect(third.body.status).toBe('pending');
    held.open();
    expect((await first).body.status).toBe('running');
    expect(provider.started).toHaveLength(1);
  });

  it('a note deleted while its job starts takes its row with it, and the late answer writes nothing', async () => {
    const m = await note();
    const held = gate();
    provider.startGate = held;
    provider.entered = gate();
    const pending = advance(pmc, m).then((r) => r);
    await provider.entered.wait;
    await t.prisma.media.delete({ where: { id: m } });
    held.open();
    expect((await pending).status).toBe(404);
    expect(await t.prisma.voiceTranscript.count({ where: { mediaId: m } })).toBe(0);
    expect((await get(pmc, m)).status).toBe(404);
  });

  it('gives up after a bounded number of tries, then may be tried once more', async () => {
    const m = await note(contractorId);
    provider.startError = new SpeechProviderError('Sarvam answered 503', false);
    for (let i = 1; i <= TRANSCRIPT_MAX_ATTEMPTS; i++) {
      if (i > 1) {
        // a view straight after a failed try waits out the pause: no new try
        expect((await advance(pmc, m)).body.status).toBe('pending');
        expect(provider.started).toHaveLength(i - 1);
        await age(m);
      }
      const res = await advance(pmc, m);
      expect(res.body.status).toBe(i < TRANSCRIPT_MAX_ATTEMPTS ? 'pending' : 'failed');
    }
    expect(provider.started).toHaveLength(TRANSCRIPT_MAX_ATTEMPTS);
    // failed: looking again sends nothing
    expect((await advance(pmc, m)).body).toMatchObject({ status: 'failed', canRetry: true });
    expect(provider.started).toHaveLength(TRANSCRIPT_MAX_ATTEMPTS);

    // the client may not ask again; the person who recorded it may
    expect((await get(client, m)).body.canRetry).toBe(false);
    expect((await retry(client, m)).status).toBe(403);
    provider.startError = null;
    const again = await retry(contractor, m);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'running', canRetry: false });
    // once only
    provider.state = { state: 'failed', reason: 'Sarvam job Failed' };
    await age(m);
    expect((await advance(pmc, m)).body).toMatchObject({ status: 'failed', canRetry: false });
    expect((await retry(pmc, m)).status).toBe(409);
  });

  it('a step whose lease ran out and was taken over writes nothing when its late answer comes', async () => {
    const m = await note();
    const held = gate();
    provider.startGate = held;
    provider.entered = gate();
    const first = advance(pmc, m).then((r) => r);
    await provider.entered.wait;
    // the first step's lease runs out while it waits on the provider; the next viewer takes over and starts job-2
    await t.prisma.$executeRaw`UPDATE "VoiceTranscript" SET "leaseUntil" = now() - interval '1 second' WHERE "mediaId" = ${m}`;
    expect((await advance(engineer, m)).body.status).toBe('running');
    held.open();
    await first;
    expect(provider.started).toHaveLength(2);
    expect((await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).providerJobId).toBe('job-2');
  });

  it('a final refusal fails the note at once', async () => {
    const m = await note();
    provider.startError = new SpeechProviderError('Sarvam upload answered 400', true);
    expect((await advance(pmc, m)).body.status).toBe('failed');
    expect(provider.started).toHaveLength(1);
    const row = await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } });
    expect(row).toMatchObject({ attempts: 1, lastError: 'Sarvam upload answered 400', leaseToken: null });
  });

  it('keeps the words heard beside a correction that names who wrote it, by the people allowed to', async () => {
    const m = await note(contractorId);
    expect((await correct(pmc, m, 'too early', 0)).status).toBe(409);
    // the provider's language is kept in the database's shape, whatever case it wrote it in
    provider.state = { state: 'done', text: 'pipe line goes from hear', languageCode: 'EN_in' };
    await advance(pmc, m);
    await age(m);
    expect((await advance(pmc, m)).body).toMatchObject({ status: 'done', languageCode: 'en-IN', correctionSeq: 0 });

    expect((await correct(client, m, 'not mine', 0)).status).toBe(403);
    expect((await correct(engineer, m, '   ', 0)).status).toBe(400);
    // spaces outside ASCII (ideographic, no-break) are blank too
    expect((await correct(engineer, m, '\u3000\u00a0 ', 0)).status).toBe(400);
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
    provider.state = { state: 'done', text: 'words heard', languageCode: 'en-IN' };
    await advance(pmc, m);
    await age(m);
    expect((await advance(pmc, m)).body.status).toBe('done');
    const answers = await Promise.all([correct(pmc, m, 'first words', 0), correct(engineer, m, 'second words', 0)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const kept = await t.prisma.voiceTranscriptCorrection.findMany({ where: { mediaId: m } });
    expect(kept).toHaveLength(1);
    expect((await get(pmc, m)).body).toMatchObject({ correction: { text: kept[0]!.text }, correctionSeq: 1 });
  });

  it('words heard with spaces about them, sent back as shown, are no correction', async () => {
    const m = await note();
    provider.state = { state: 'done', text: '  padded heard words \n', languageCode: 'en-IN' };
    await advance(pmc, m);
    await age(m);
    expect((await advance(pmc, m)).body.status).toBe('done');
    expect((await correct(engineer, m, '  padded heard words \n', 0)).body).toMatchObject({ correction: null, correctionSeq: 0 });
    expect(await t.prisma.voiceTranscriptCorrection.count({ where: { mediaId: m } })).toBe(0);
  });

  it('a lone surrogate half in the words heard is kept as a replacement character', async () => {
    const m = await note();
    provider.state = { state: 'done', text: 'a\ud800b\udc00', languageCode: 'en-IN' };
    await advance(pmc, m);
    await age(m);
    expect((await advance(pmc, m)).body).toMatchObject({ status: 'done', text: 'a\ufffdb\ufffd' });
  });

  it('after a check that failed once, a check that answers puts the job back on the short interval', async () => {
    const m = await note();
    await advance(pmc, m);
    provider.checkError = new SpeechProviderError('Sarvam status answered 503', false);
    await age(m);
    expect((await advance(pmc, m)).body.status).toBe('running');
    expect(provider.checked).toHaveLength(1);
    // a failed try waits out the longer pause
    await age(m, 10);
    await advance(pmc, m);
    expect(provider.checked).toHaveLength(1);
    provider.checkError = null;
    await age(m);
    await advance(pmc, m);
    expect(provider.checked).toHaveLength(2);
    // answered: back to a check every few seconds, though a try once failed
    await age(m, 10);
    await advance(pmc, m);
    expect(provider.checked).toHaveLength(3);
    expect(await t.prisma.voiceTranscript.findUniqueOrThrow({ where: { mediaId: m } })).toMatchObject({ attempts: 1, lastError: null });
  });

  it('a note filed on another member\'s private draft place is not found by others', async () => {
    const nodeId = `vt-draft-${f.projectA.id}`;
    await t.prisma.projectNode.create({ data: { id: nodeId, projectId: f.projectA.id, name: 'draft', kind: 'zone', publishedAt: null, authorId: f.memberUser.id } });
    const m = (await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'visit', mime: 'audio/webm', uploadedBy: f.memberUser.id, durationSec: 12, data: Buffer.from('a recording'), nodeId },
    })).id;
    expect((await get(engineer, m)).status).toBe(404);
    expect((await advance(engineer, m)).status).toBe(404);
    expect((await correct(engineer, m, 'words', 0)).status).toBe(404);
    expect(provider.started).toHaveLength(0);
    expect((await get(pmc, m)).status).toBe(200);
  });

  it('is refused on an archived project', async () => {
    const m = await note();
    await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = now() WHERE "id" = ${f.projectA.id}`;
    try {
      expect((await advance(pmc, m)).status).toBe(403);
      expect(provider.started).toHaveLength(0);
    } finally {
      await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = ${f.projectA.id}`;
    }
  });

  it('is only for a voice note of the project named, as its members see it', async () => {
    const photo = (await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: f.memberUser.id, data: Buffer.from('png') },
    })).id;
    expect((await advance(pmc, photo)).status).toBe(404);

    await t.app.get(CapabilitiesService).enable(f.projectB.id, VOICE_TEXT_CAPABILITY, f.otherUser.id);
    const m = await note();
    // another project's member, through their own project or through this one
    expect((await advance(otherPmc, m, f.projectB.id)).status).toBe(404);
    expect([403, 404]).toContain((await advance(otherPmc, m)).status);
    expect(provider.started).toHaveLength(0);
  });
});
