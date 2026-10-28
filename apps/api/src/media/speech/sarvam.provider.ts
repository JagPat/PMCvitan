import { SpeechProviderError, type SpeechJobState, type SpeechProvider } from './speech-provider';

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
 * answers a bad key with 403. A 429 or 5xx may be tried again; any other 4xx (401 and 403 too) is final for that note.
 */

export const SARVAM_BASE_URL = 'https://api.sarvam.ai';
/** Sarvam's speech model and mode for a note: the words as spoken, in the language spoken (auto-detected). */
export const SARVAM_JOB_PARAMETERS = { model: 'saaras:v3', mode: 'transcribe', language_code: 'unknown' } as const;
/** One exchange with Sarvam or its blob storage is given this long before it counts as a failed try. */
export const SARVAM_TIMEOUT_MS = 20_000;

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
    const created = await this.api('POST', '/speech-to-text/job/v1', { job_parameters: SARVAM_JOB_PARAMETERS });
    const jobId = typeof created.job_id === 'string' && created.job_id.trim() !== '' ? created.job_id : null;
    if (!jobId || jobId.length > 200) throw new SpeechProviderError('Sarvam did not return a job id', false);
    return jobId;
  }

  async startJob(jobId: string, audio: Buffer, mime: string, fileName: string): Promise<void> {
    const links = await this.api('POST', '/speech-to-text/job/v1/upload-files', { job_id: jobId, files: [fileName] });
    const uploadUrl = fileUrl(links.upload_urls as UrlMap | undefined, fileName);
    if (!uploadUrl) throw new SpeechProviderError('Sarvam did not return an upload link', false);
    const put = await this.exchange(uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': mime }, body: audio });
    if (!put.ok) throw failure('upload', put.status);
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
    if (!res.ok) throw failure('download', res.status);
    // a body cut short or garbled on the way is not the job's end: the job keeps its output, and it is read again
    const body = (await res.json().catch(() => undefined)) as { transcript?: unknown; language_code?: unknown } | null | undefined;
    if (body === undefined) throw new SpeechProviderError('Sarvam output could not be read', false);
    if (!body || typeof body.transcript !== 'string') return { state: 'failed', reason: 'Sarvam output had no transcript' };
    return { state: 'done', text: body.transcript, languageCode: typeof body.language_code === 'string' ? body.language_code : null };
  }

  /** One JSON call to Sarvam's API, authenticated by header. */
  private async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.exchange(`${this.baseUrl}${path}`, {
      method,
      headers: { 'api-subscription-key': this.apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw failure(path.split('/').slice(-1)[0] ?? 'call', res.status);
    const json = (await res.json().catch(() => null)) as unknown;
    // an answer that is not a JSON object is Sarvam's fault, not the note's: it costs a try
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SpeechProviderError(`Sarvam ${path.split('/').slice(-1)[0] ?? 'call'} answered with no JSON`, false);
    return json as Record<string, unknown>;
  }

  private async exchange(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, signal: AbortSignal.timeout(SARVAM_TIMEOUT_MS) });
    } catch {
      // a network failure or a timeout: worth one more try, and nothing of the request is echoed
      throw new SpeechProviderError('Sarvam could not be reached', false);
    }
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

/** A refused exchange. 429 and 5xx may be tried again. Any other 4xx is final for that note: a refused file, a
 *  malformed request, and a bad or missing key (401, 403) too, which no later try mends until the key is fixed; the
 *  note's one "Try again" is left for then. */
function failure(step: string, status: number): SpeechProviderError {
  const retryable = status === 429 || status >= 500;
  return new SpeechProviderError(`Sarvam ${step} answered ${status}`, !retryable);
}
