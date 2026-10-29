import { SPEECH_JOB_ID, SPEECH_LANGUAGE, SPEECH_TEXT_MAX, SpeechProviderError, type SpeechJobState, type SpeechProvider } from './speech-provider';

/**
 * #1177 VT2 — Sarvam's batch speech-to-text job API (H1: every note goes through a batch job, since the synchronous call
 * takes at most 30 s of audio and a note runs to 120 s). The raw endpoints are the ones the official `sarvamai` SDK
 * (1.1.12) calls; we call them with fetch and add no dependency:
 *
 *   POST /speech-to-text/job/v1                    { job_parameters }            -> { job_id }
 *   POST /speech-to-text/job/v1/upload-files       { job_id, files: [name] }     -> { upload_urls: { name: { file_url } } }
 *   PUT  <file_url>  (Azure blob, `x-ms-blob-type: BlockBlob`)
 *   POST /speech-to-text/job/v1/{job_id}/start
 *   GET  /speech-to-text/job/v1/{job_id}/status                                  -> { job_state, job_details }
 *   POST /speech-to-text/job/v1/download-files     { job_id, files: [name] }     -> { download_urls: { name: { file_url } } }
 *   GET  <file_url>                                                              -> { transcript, language_code }
 *
 * The key travels only in the `api-subscription-key` header and never appears in an error, a log or a result. Sarvam
 * answers a bad key with 403. A 429 or 5xx may be tried again; any other 4xx (401 and 403 too), and a 429 that says a
 * seat's spend budget is used up, is final for that note.
 */

export const SARVAM_BASE_URL = 'https://api.sarvam.ai';
/** Sarvam's speech model and mode for a note: the words as spoken, in the language spoken (auto-detected). */
export const SARVAM_JOB_PARAMETERS = { model: 'saaras:v3', mode: 'transcribe', language_code: 'unknown' } as const;
/** One exchange with Sarvam or its blob storage is given this long before it counts as a failed try. */
export const SARVAM_TIMEOUT_MS = 20_000;
/** The most of a job's output read: a 120 s note's words are a few kilobytes. */
const OUTPUT_MAX_BYTES = 1_000_000;
/** The most of one of Sarvam's API answers read (a job id, a state, a pair of links): each is well under a kilobyte. */
const API_MAX_BYTES = 64_000;
/** Sarvam's `error.code` on a 429 that waiting never clears (docs.sarvam.ai, errors and troubleshooting). */
export const SEAT_BUDGET_EXHAUSTED = 'seat_budget_exhausted_error';

type Fetch = typeof fetch;

type UrlMap = Record<string, { file_url?: unknown } | undefined>;

/** Sarvam's job states, compared lower-cased as the `sarvamai` SDK does. `partiallycompleted` of a one-file job means
 *  its one file failed. A state outside these lists is not taken as the job's end: it costs a try, and the job is
 *  asked about again. */
const RUNNING = new Set(['pending', 'running', 'queued']);
/** A job made but not started yet (its file is not in, or its start was not heard): `Accepted`, as Sarvam answers a
 *  job's creation. */
const WAITING = 'accepted';
const FAILED = new Set(['failed', 'partiallycompleted', 'cancelled', 'canceled']);

export class SarvamSpeechProvider implements SpeechProvider {
  constructor(
    private readonly apiKey: string,
    private readonly http: Fetch = fetch,
    private readonly baseUrl: string = SARVAM_BASE_URL,
  ) {}

  async createJob(): Promise<string> {
    // a job may have been made whatever its answer says, so an answer with no usable id is final: no try makes another
    // job, and the note's one "Try again" is left. So is an id the table could not store (blank, too long, not visible
    // ASCII): the caller stores the id before anything is sent, and cannot
    const created = await this.api('POST', '/speech-to-text/job/v1', { job_parameters: SARVAM_JOB_PARAMETERS }, true);
    if (typeof created.job_id !== 'string' || !SPEECH_JOB_ID.test(created.job_id)) throw new SpeechProviderError('Sarvam did not return a usable job id', true);
    return created.job_id;
  }

  async startJob(jobId: string, audio: Buffer, mime: string, fileName: string): Promise<void> {
    const links = await this.api('POST', '/speech-to-text/job/v1/upload-files', { job_id: jobId, files: [fileName] });
    const uploadUrl = fileUrl(links.upload_urls as UrlMap | undefined, fileName);
    if (!uploadUrl) throw new SpeechProviderError('Sarvam did not return an upload link', false);
    const put = await this.exchange(uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': mime }, body: audio });
    if (!put.ok) throw await refused(put, 'upload', 'blob');
    // the blob store's answer to a stored upload is not needed: let it go, as every answer is either read or let go
    await release(put);
    await this.api('POST', `/speech-to-text/job/v1/${encodeURIComponent(jobId)}/start`, {});
  }

  async checkJob(jobId: string): Promise<SpeechJobState> {
    const status = await this.api('GET', `/speech-to-text/job/v1/${encodeURIComponent(jobId)}/status`);
    const raw = typeof status.job_state === 'string' ? status.job_state.trim() : '';
    const state = raw.toLowerCase();
    if (state === WAITING) return { state: 'waiting' };
    if (RUNNING.has(state)) return { state: 'running' };
    if (FAILED.has(state)) return { state: 'failed', reason: `Sarvam job ${raw}` };
    if (state !== 'completed') throw new SpeechProviderError(`Sarvam job in an unknown state${raw ? ` (${raw.slice(0, 40)})` : ''}`, false);
    const output = outputName(status.job_details);
    if (!output) return { state: 'failed', reason: 'Sarvam job completed without an output file' };
    const links = await this.api('POST', '/speech-to-text/job/v1/download-files', { job_id: jobId, files: [output] });
    const downloadUrl = fileUrl(links.download_urls as UrlMap | undefined, output);
    if (!downloadUrl) throw new SpeechProviderError('Sarvam did not return a download link', false);
    const res = await this.exchange(downloadUrl, { method: 'GET' });
    if (!res.ok) throw await refused(res, 'download', 'blob');
    // an output far beyond any note's words is never held whole: it is read in chunks and dropped once past the bound,
    // whatever length it claims; the note ends failed, with its one "Try again"
    const text = await bounded(res, OUTPUT_MAX_BYTES);
    if (text === TOO_LARGE) return { state: 'failed', reason: 'Sarvam output was too large' };
    // a body cut short or garbled on the way is not the job's end: the job keeps its output, and it is read again
    const body = parsed(text) as { transcript?: unknown; language_code?: unknown } | null | undefined;
    if (body === undefined) throw new SpeechProviderError('Sarvam output could not be read', false);
    if (!body || typeof body.transcript !== 'string') return { state: 'failed', reason: 'Sarvam output had no transcript' };
    // words that are empty or only spaces are a note with no speech: done, as heard (VT1a V3, V4), never failed, since
    // a "Try again" would only pay to hear the same silence
    return storable(body.transcript, body.language_code);
  }

  /** One JSON call to Sarvam's API, authenticated by header. An answer that cannot be read (not a JSON object, or
   *  past {@link API_MAX_BYTES}) costs a try, or is final when `unreadableFinal`. */
  private async api(method: 'GET' | 'POST', path: string, body?: unknown, unreadableFinal = false): Promise<Record<string, unknown>> {
    const res = await this.exchange(`${this.baseUrl}${path}`, {
      method,
      headers: { 'api-subscription-key': this.apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const step = path.split('/').slice(-1)[0] ?? 'call';
    if (!res.ok) throw await refused(res, step, 'api');
    // read in chunks and dropped once past the bound, as the output is, so no answer is held whole whatever it claims
    const text = await bounded(res, API_MAX_BYTES);
    const json = text === TOO_LARGE ? undefined : parsed(text);
    // an answer that is not a JSON object is Sarvam's fault, not the note's: it costs a try
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SpeechProviderError(`Sarvam ${step} answered with no JSON`, unreadableFinal);
    return json as Record<string, unknown>;
  }

  /** One exchange, bounded in time. No exchange follows a redirect: the key never leaves Sarvam's API, a recording is
   *  sent only to the link Sarvam gave, and nothing is read from anywhere else (a redirect is a failed try). */
  private async exchange(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(SARVAM_TIMEOUT_MS) });
    } catch {
      // a network failure or a timeout: worth one more try, and nothing of the request is echoed
      throw new SpeechProviderError('Sarvam could not be reached', false);
    }
  }
}

/**
 * A done result as the table can store it (VT1a's shape check), so the caller never holds words it cannot write:
 * - PostgreSQL text holds no NUL and no lone half of a surrogate pair: a NUL is dropped, and a lone half is shown as
 *   U+FFFD, as the decoder shows nothing else (it refuses bytes that are not UTF-8);
 * - more than {@link SPEECH_TEXT_MAX} characters is far beyond any note's words (a note is at most two minutes): the
 *   job reads as failed, as an output past its byte bound does, never as words cut short;
 * - a language not in the table's shape is kept as none, whatever case or separator the provider wrote it in, rather
 *   than refusing the words.
 */
function storable(transcript: string, language: unknown): SpeechJobState {
  const text = transcript.replace(/\u0000/g, '').replace(LONE_SURROGATES, '\uFFFD');
  let chars = 0;
  for (const _ of text) if (++chars > SPEECH_TEXT_MAX) return { state: 'failed', reason: 'Sarvam output was too long' };
  return { state: 'done', text, languageCode: languageCode(language) };
}

/** A half of a surrogate pair standing alone. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The provider's language in the table's shape ('gu-IN', 'en'), whatever case or separator it was written in; else null. */
function languageCode(value: unknown): string | null {
  const m = typeof value === 'string' ? /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}))?$/.exec(value.trim()) : null;
  if (!m) return null;
  const code = m[2] ? `${m[1]!.toLowerCase()}-${m[2].toUpperCase()}` : m[1]!.toLowerCase();
  return SPEECH_LANGUAGE.test(code) ? code : null;
}

const TOO_LARGE = Symbol('too large');

/** A response body read in chunks as UTF-8, its bytes counted as they come: TOO_LARGE (and the rest cancelled) once
 *  past `max`, undefined when the body breaks off on the way or is not UTF-8. */
async function bounded(res: Response, max: number): Promise<string | undefined | typeof TOO_LARGE> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    return TOO_LARGE;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  // fatal: bytes that are not UTF-8 are an unreadable answer, never words with U+FFFD put in their place
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return TOO_LARGE;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // the body broke off, timed out, or is not UTF-8: whatever is left of it is let go, not left for garbage collection
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
}

/** JSON text read, or undefined when there is none to read. */
function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function fileUrl(map: UrlMap | undefined, name: string): string | null {
  const url = map?.[name]?.file_url;
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

/** The output file of the job's one input, as the status names it. */
function outputName(details: unknown): string | null {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const outputs = (d as { outputs?: unknown } | null)?.outputs;
    if (!Array.isArray(outputs)) continue;
    for (const o of outputs) {
      const name = (o as { file_name?: unknown } | null)?.file_name;
      if (typeof name === 'string' && name.trim() !== '') return name;
    }
  }
  return null;
}

/**
 * A refused exchange, judged by whom it was made with.
 * - Sarvam's API (`api`): 408, 429 and 5xx may be tried again, and a 429 is Sarvam's account-wide rate limit (busy).
 *   Any other 4xx is final for that note: a refused file, a malformed request, and a bad or missing key (401, 403) too,
 *   which no later try mends until the key is fixed; the note's one "Try again" is left for then. So is a 429 whose
 *   `error.code` is {@link SEAT_BUDGET_EXHAUSTED} (#1244): a seat's spend budget is used up, and only raising or
 *   topping it up clears it, never waiting, so marking it busy would hold every note without end.
 * - The blob store, through a link Sarvam just gave (`blob`): never busy (its limits are not Sarvam's account's). 408,
 *   429 and 5xx may be tried again, and so may 401, 403 and 404, since a link that expired or a file not there yet is
 *   mended by the fresh link the next try asks for (the note's bounded tries still end it). Any other 4xx (a recording
 *   the store refuses, such as 413) is final.
 */
function failure(step: string, status: number, peer: 'api' | 'blob', code?: string): SpeechProviderError {
  if (peer === 'api' && status === 429 && code === SEAT_BUDGET_EXHAUSTED) {
    return new SpeechProviderError(`Sarvam ${step} answered 429: the seat's spend budget is used up`, true);
  }
  const retryable = status === 408 || status === 429 || status >= 500 || (peer === 'blob' && (status === 401 || status === 403 || status === 404));
  return new SpeechProviderError(`Sarvam ${step} answered ${status}`, !retryable, peer === 'api' && status === 429);
}

/** Let an answer's body go unread, so its connection is freed at once rather than at garbage collection. Every answer
 *  this client receives is either read through {@link bounded} or let go here. */
async function release(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** A refused answer, judged by {@link failure}. The API's 429 is read (bounded) for its `error.code`, the one refusal
 *  whose body changes the verdict; every other refused body is let go. A 429 body that cannot be read stays busy. */
async function refused(res: Response, step: string, peer: 'api' | 'blob'): Promise<SpeechProviderError> {
  if (peer !== 'api' || res.status !== 429) {
    await release(res);
    return failure(step, res.status, peer);
  }
  const text = await bounded(res, API_MAX_BYTES);
  const error = (parsed(text === TOO_LARGE ? undefined : text) as { error?: { code?: unknown } } | null)?.error;
  return failure(step, res.status, peer, typeof error?.code === 'string' ? error.code : undefined);
}
