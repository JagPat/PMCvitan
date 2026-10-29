import { describe, it, expect } from 'vitest';
import { SarvamSpeechProvider, SARVAM_JOB_PARAMETERS } from './sarvam.provider';
import { SpeechProviderError } from './speech-provider';
import { readSarvamKey } from './speech-config';

/**
 * #1177 VT2 — the Sarvam batch job exchanges, against a fake fetch that plays Sarvam's side. Proves the order of calls,
 * that the key travels only in its header and never in an error, how each answer maps to a state, and which refusals
 * end a note (final) and which may be tried again.
 */

const KEY = 'sk_test_0123456789abcdef';
const BASE = 'https://sarvam.test';
const UPLOAD = 'https://blob.test/in/note.webm?sig=1';
const DOWNLOAD = 'https://blob.test/out/note.json?sig=2';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect?: RequestInit['redirect'] };
type Answer = { status?: number; json?: unknown; raw?: string; stream?: Uint8Array[] } | Error;

function fake(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, headers, body, redirect: init?.redirect });
    const key = `${method} ${url.replace(BASE, '')}`;
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected ${key}`);
    if (answer instanceof Error) throw answer;
    if (answer.stream) {
      // a body sent in chunks with no length
      const chunks = answer.stream;
      return new Response(new ReadableStream({ pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); } }), { status: answer.status ?? 200 });
    }
    const payload = answer.raw ?? (answer.json === undefined ? null : JSON.stringify(answer.json));
    return new Response(payload, { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { calls, provider: new SarvamSpeechProvider(KEY, http, BASE) };
}

const START: Record<string, Answer> = {
  'POST /speech-to-text/job/v1': { json: { job_id: 'job-7', job_state: 'Accepted' } },
  'POST /speech-to-text/job/v1/upload-files': { json: { job_id: 'job-7', upload_urls: { 'm1.webm': { file_url: UPLOAD } } } },
  [`PUT ${UPLOAD}`]: { status: 201 },
  'POST /speech-to-text/job/v1/job-7/start': { json: { job_id: 'job-7', job_state: 'Pending' } },
};

const status = (job_state: string, outputs: unknown[] = []) => ({
  'GET /speech-to-text/job/v1/job-7/status': { json: { job_id: 'job-7', job_state, job_details: [{ inputs: [{ file_name: 'm1.webm' }], outputs }] } },
});

async function refusal(p: Promise<unknown>): Promise<SpeechProviderError> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(SpeechProviderError);
  return error as SpeechProviderError;
}

describe('SarvamSpeechProvider', () => {
  it('creates a job and hands back its id before anything is sent, then uploads the recording to its link and starts it', async () => {
    const { calls, provider } = fake(START);
    const audio = Buffer.from('voice bytes');
    expect(await provider.createJob()).toBe('job-7');
    expect(calls).toHaveLength(1);
    await provider.startJob('job-7', audio, 'audio/webm', 'm1.webm');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/speech-to-text/job/v1`,
      `POST ${BASE}/speech-to-text/job/v1/upload-files`,
      `PUT ${UPLOAD}`,
      `POST ${BASE}/speech-to-text/job/v1/job-7/start`,
    ]);
    expect(calls[0]!.body).toEqual({ job_parameters: SARVAM_JOB_PARAMETERS });
    expect(calls[1]!.body).toEqual({ job_id: 'job-7', files: ['m1.webm'] });
    expect(calls[2]!.headers).toEqual({ 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'audio/webm' });
    expect(calls[2]!.body).toBe(audio);
    // the key goes to Sarvam's API only, never to the blob store
    // and never follows a redirect, which would carry the key to another host
    for (const c of [calls[0]!, calls[1]!, calls[3]!]) expect(c).toMatchObject({ headers: { 'api-subscription-key': KEY }, redirect: 'error' });
    expect(JSON.stringify(calls[2]!.headers)).not.toContain(KEY);
    // the recording goes only to the link Sarvam gave: the upload follows no redirect either
    expect(calls[2]!.redirect).toBe('error');
  });

  it('a made job\'s answer with no usable id ends the note, so no try makes another job; an id is handed back as sent', async () => {
    // a job may exist whatever the answer says: no id, a blank one, an answer that is not JSON, or one past the bound
    const big = new Uint8Array(70_000).fill(0x20);
    for (const answer of [{ json: {} }, { json: { job_id: 7 } }, { json: { job_id: '' } }, { json: { job_id: '  ' } }, { raw: 'not json' }, { stream: [big] }] as Answer[]) {
      expect((await refusal(fake({ ...START, 'POST /speech-to-text/job/v1': answer }).provider.createJob())).final, JSON.stringify(answer)).toBe(true);
    }
    // an id the database would refuse is the caller's to judge (it refuses one as final before storing it)
    expect(await fake({ ...START, 'POST /speech-to-text/job/v1': { json: { job_id: 'j'.repeat(201) } } }).provider.createJob()).toBe('j'.repeat(201));
  });

  it('an answer without an https upload link is Sarvam\'s fault, not the note\'s: it may be tried again', async () => {
    const plain = { 'POST /speech-to-text/job/v1/upload-files': { json: { upload_urls: { 'm1.webm': { file_url: 'http://blob.test/in' } } } } };
    expect((await refusal(fake({ ...START, ...plain }).provider.startJob('job-7', Buffer.from('x'), 'audio/webm', 'm1.webm'))).final).toBe(false);
  });

  it('may try again after 408, 429, 5xx or no answer; any other 4xx, a bad key\'s 401 or 403 too, ends the note', async () => {
    const cases: Array<[Answer, boolean]> = [
      [{ status: 408 }, false], [{ status: 429 }, false], [{ status: 503 }, false], [{ status: 401 }, true], [{ status: 403 }, true],
      [new Error('socket hang up'), false], [{ status: 400 }, true], [{ status: 422 }, true],
    ];
    for (const [answer, final] of cases) {
      const error = await refusal(fake({ ...START, 'POST /speech-to-text/job/v1': answer }).provider.createJob());
      expect(error.final, JSON.stringify(answer)).toBe(final);
      // a 429 is Sarvam's account-wide limit: busy, which spends no running job's try
      expect(error.busy, JSON.stringify(answer)).toBe(!(answer instanceof Error) && answer.status === 429);
      expect(error.message).not.toContain(KEY);
    }
    // the blob store's refusal of the upload is judged the same way
    expect((await refusal(fake({ ...START, [`PUT ${UPLOAD}`]: { status: 413 } }).provider.startJob('job-7', Buffer.from('x'), 'audio/webm', 'm1.webm'))).final).toBe(true);
    // and so is the start
    expect((await refusal(fake({ ...START, 'POST /speech-to-text/job/v1/job-7/start': { status: 503 } }).provider.startJob('job-7', Buffer.from('x'), 'audio/webm', 'm1.webm'))).final).toBe(false);
  });

  it('lets a refused answer\'s body go unread, from the API and from the blob store, so no connection is held', async () => {
    for (const refusedAt of ['POST /speech-to-text/job/v1/upload-files', `PUT ${UPLOAD}`]) {
      let cancelled = false;
      const http = (async (input: string | URL | Request, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(input).replace(BASE, '')}`;
        if (key === refusedAt) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
        const answer = START[key] as { json?: unknown } | undefined;
        if (!answer) throw new Error(`unexpected ${key}`);
        return new Response(JSON.stringify(answer.json ?? null), { status: 200 });
      }) as typeof fetch;
      const error = await refusal(new SarvamSpeechProvider(KEY, http, BASE).startJob('job-7', Buffer.from('x'), 'audio/webm', 'm1.webm'));
      expect(error.final, refusedAt).toBe(false);
      expect(cancelled, refusedAt).toBe(true);
    }
  });

  it('reads a job made but not started as waiting, a running job as running, and a failed or partly failed one as failed', async () => {
    for (const s of ['Accepted', 'accepted']) expect(await fake(status(s)).provider.checkJob('job-7')).toEqual({ state: 'waiting' });
    for (const s of ['Pending', 'Running', 'running', 'RUNNING', 'Queued']) expect(await fake(status(s)).provider.checkJob('job-7')).toEqual({ state: 'running' });
    expect(await fake(status('Failed')).provider.checkJob('job-7')).toEqual({ state: 'failed', reason: 'Sarvam job Failed' });
    expect(await fake(status('PartiallyCompleted')).provider.checkJob('job-7')).toMatchObject({ state: 'failed' });
    expect(await fake(status('Completed')).provider.checkJob('job-7')).toEqual({ state: 'failed', reason: 'Sarvam job completed without an output file' });
  });

  it('a state it does not know, or an answer that is not JSON, is not the job\'s end: it costs a try', async () => {
    for (const s of ['Paused', '']) {
      const error = await refusal(fake(status(s)).provider.checkJob('job-7'));
      expect(error.final, s).toBe(false);
    }
    const error = await refusal(fake({ 'GET /speech-to-text/job/v1/job-7/status': { json: 'busy' } }).provider.checkJob('job-7'));
    expect(error.final).toBe(false);
  });

  it('an API answer past its bound is never held whole: read in chunks, dropped, and it costs a try', async () => {
    // a status answer of 70 kB sent in chunks with no length; the stream counts how much was pulled before the cancel
    let pulled = 0;
    const chunk = new Uint8Array(16_000).fill(0x20);
    const chunks = Array.from({ length: 10 }, () => chunk);
    const http = (async () => new Response(new ReadableStream({
      pull(c) { const next = chunks.shift(); if (next) { pulled += next.byteLength; c.enqueue(next); } else c.close(); },
    }), { status: 200 })) as typeof fetch;
    const error = await refusal(new SarvamSpeechProvider(KEY, http, BASE).checkJob('job-7'));
    expect(error.final).toBe(false);
    expect(pulled).toBeLessThan(160_000);
    // and one that states a length past the bound is not read at all
    const stated = await refusal(fake({ 'GET /speech-to-text/job/v1/job-7/status': { raw: ' '.repeat(65_000) } }).provider.checkJob('job-7'));
    expect(stated.final).toBe(false);
  });

  it('downloads a completed job\'s words and language', async () => {
    const { calls, provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { json: { request_id: 'r', transcript: 'પાઇપ લાઇન', language_code: 'gu-IN' } },
    });
    expect(await provider.checkJob('job-7')).toEqual({ state: 'done', text: 'પાઇપ લાઇન', languageCode: 'gu-IN' });
    expect(calls[1]!.body).toEqual({ job_id: 'job-7', files: ['m1.json'] });
    expect(calls[2]!.headers['api-subscription-key']).toBeUndefined();
    // and the download follows no redirect: nothing is read from a host Sarvam did not name
    expect(calls.every((c) => c.redirect === 'error')).toBe(true);
  });

  it('an output cut short on the way is not the job\'s end: it costs a try, and is read again', async () => {
    const { provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { raw: '{"transcript":"પાઇપ' },
    });
    expect((await refusal(provider.checkJob('job-7'))).final).toBe(false);
  });

  it('an output that is not UTF-8 is unreadable: it costs a try, and is never kept as words with characters replaced', async () => {
    const words = new TextEncoder().encode(JSON.stringify({ transcript: 'પાઇપ', language_code: 'gu-IN' }));
    const bad = new Uint8Array([...words.slice(0, 16), 0xff, 0xfe, ...words.slice(16)]);
    const { provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { stream: [bad] },
    });
    expect((await refusal(provider.checkJob('job-7'))).final).toBe(false);
  });

  it('an output far beyond any note\'s words is not kept: the job ends failed', async () => {
    const { provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { raw: JSON.stringify({ transcript: 'x'.repeat(1_000_001) }) },
    });
    expect(await provider.checkJob('job-7')).toEqual({ state: 'failed', reason: 'Sarvam output was too large' });
  });

  it('an output sent in chunks with no length is counted as it comes, and dropped once past the bound', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(100_000));
    const big = { stream: Array.from({ length: 20 }, () => chunk.slice()) };
    const { provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: big,
    });
    expect(await provider.checkJob('job-7')).toEqual({ state: 'failed', reason: 'Sarvam output was too large' });
    // the rest was never read
    expect(big.stream.length).toBeGreaterThan(0);
    // and words sent in chunks, split inside a character, read whole
    const words = new TextEncoder().encode(JSON.stringify({ transcript: 'પાઇપ લાઇન', language_code: 'gu-IN' }));
    const cut = words.indexOf(0xaa);
    const { provider: small } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { stream: [words.slice(0, cut), words.slice(cut)] },
    });
    expect(await small.checkJob('job-7')).toEqual({ state: 'done', text: 'પાઇપ લાઇન', languageCode: 'gu-IN' });
  });

  it('a completed output without words is a failed job', async () => {
    const { provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { json: { language_code: 'gu-IN' } },
    });
    expect(await provider.checkJob('job-7')).toEqual({ state: 'failed', reason: 'Sarvam output had no transcript' });
  });
});

describe('readSarvamKey', () => {
  it('is the key when set and shaped like one, else null (the feature stays closed)', () => {
    expect(readSarvamKey({ SARVAM_API_KEY: ` ${KEY}\n` })).toBe(KEY);
    expect(readSarvamKey({})).toBeNull();
    expect(readSarvamKey({ SARVAM_API_KEY: '' })).toBeNull();
    expect(readSarvamKey({ SARVAM_API_KEY: 'short' })).toBeNull();
    expect(readSarvamKey({ SARVAM_API_KEY: 'has a space in it' })).toBeNull();
    expect(readSarvamKey({ SARVAM_API_KEY: 'x'.repeat(513) })).toBeNull();
    expect(readSarvamKey({ SARVAM_API_KEY: `sk_${'x'.repeat(510)}` })).toBeNull();
    // a placeholder left in place of a key, or any value not shaped like Sarvam's (`sk_…`), keeps the feature closed
    for (const v of ['YOUR_SARVAM_API_KEY', 'changeme-changeme', '<sarvam-key-here>', 'SK_0123456789abcdef', 'sk_short']) {
      expect(readSarvamKey({ SARVAM_API_KEY: v }), v).toBeNull();
    }
  });
});
