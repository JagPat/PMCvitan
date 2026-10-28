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

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Answer = { status?: number; json?: unknown } | Error;

function fake(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, headers, body });
    const key = `${method} ${url.replace(BASE, '')}`;
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected ${key}`);
    if (answer instanceof Error) throw answer;
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status ?? 200 });
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
  it('creates a job, uploads the recording to its link, starts it, and hands back the job id', async () => {
    const { calls, provider } = fake(START);
    const audio = Buffer.from('voice bytes');
    expect(await provider.startJob(audio, 'audio/webm', 'm1.webm')).toBe('job-7');
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
    for (const c of [calls[0]!, calls[1]!, calls[3]!]) expect(c.headers['api-subscription-key']).toBe(KEY);
    expect(JSON.stringify(calls[2]!.headers)).not.toContain(KEY);
  });

  it('an answer without a job id or an https upload link is Sarvam\'s fault, not the note\'s: it may be tried again', async () => {
    expect((await refusal(fake({ ...START, 'POST /speech-to-text/job/v1': { json: {} } }).provider.startJob(Buffer.from('x'), 'audio/webm', 'm1.webm'))).final).toBe(false);
    const plain = { 'POST /speech-to-text/job/v1/upload-files': { json: { upload_urls: { 'm1.webm': { file_url: 'http://blob.test/in' } } } } };
    expect((await refusal(fake({ ...START, ...plain }).provider.startJob(Buffer.from('x'), 'audio/webm', 'm1.webm'))).final).toBe(false);
  });

  it('may try again after 429, 5xx, 401, 403 or no answer; any other 4xx ends the note', async () => {
    const cases: Array<[Answer, boolean]> = [
      [{ status: 429 }, false], [{ status: 503 }, false], [{ status: 401 }, false], [{ status: 403 }, false],
      [new Error('socket hang up'), false], [{ status: 400 }, true], [{ status: 422 }, true],
    ];
    for (const [answer, final] of cases) {
      const error = await refusal(fake({ ...START, 'POST /speech-to-text/job/v1': answer }).provider.startJob(Buffer.from('x'), 'audio/webm', 'm1.webm'));
      expect(error.final, JSON.stringify(answer)).toBe(final);
      expect(error.message).not.toContain(KEY);
    }
    // the blob store's refusal of the upload is judged the same way
    expect((await refusal(fake({ ...START, [`PUT ${UPLOAD}`]: { status: 413 } }).provider.startJob(Buffer.from('x'), 'audio/webm', 'm1.webm'))).final).toBe(true);
  });

  it('reads a running job as running, and a failed or partly failed one as failed', async () => {
    for (const s of ['Accepted', 'Pending', 'Running', 'running', 'RUNNING', 'Queued']) expect(await fake(status(s)).provider.checkJob('job-7')).toEqual({ state: 'running' });
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

  it('downloads a completed job\'s words and language', async () => {
    const { calls, provider } = fake({
      ...status('Completed', [{ file_name: 'm1.json' }]),
      'POST /speech-to-text/job/v1/download-files': { json: { download_urls: { 'm1.json': { file_url: DOWNLOAD } } } },
      [`GET ${DOWNLOAD}`]: { json: { request_id: 'r', transcript: 'પાઇપ લાઇન', language_code: 'gu-IN' } },
    });
    expect(await provider.checkJob('job-7')).toEqual({ state: 'done', text: 'પાઇપ લાઇન', languageCode: 'gu-IN' });
    expect(calls[1]!.body).toEqual({ job_id: 'job-7', files: ['m1.json'] });
    expect(calls[2]!.headers['api-subscription-key']).toBeUndefined();
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
  });
});
