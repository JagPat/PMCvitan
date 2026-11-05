import type { HubClientConfig } from './hub-config';
import { HUB_PROJECT_ID } from '../../contracts';

/**
 * #1118 U7a — the Hub calls a project link needs (notes/hub/u7a/plan.md §4), against Hub's `/api/v2` with the office
 * token (Hub `ApiV2Controller`, docs/hub-api.md):
 *
 * - `GET /projects`: the projects the token reaches, each `{ id, number, name, archived }`.
 * - `POST /projects/{id}/links/pmc` (form fields `externalId`, `url`, `label`): links the Hub project to its PMC twin, or
 *   changes the link (Hub upserts it), for a company admin's token with `site:write`.
 * - `DELETE /projects/{id}/links/pmc`: removes that link. Hub answers 400 when there is none, so a failed delete is
 *   followed by `GET /projects/{id}/links`: no `pmc` link there means the link is already gone.
 *
 * Every call has one short timeout ({@link HUB_CALL_TIMEOUT_MS}), follows no redirect (the token goes to Hub's origin
 * only) and reads at most {@link HUB_CALL_MAX_BYTES}. A failure carries a code and the HTTP status only: never the token,
 * a URL, a header or a body. Nothing here logs and nothing throws for anything Hub or the network does.
 */

/** One short wait per call: a person is waiting on the screen (the plan's 4 s). */
export const HUB_CALL_TIMEOUT_MS = 4_000;
/** The most of an answer read; a project list is a few KB. */
export const HUB_CALL_MAX_BYTES = 1024 * 1024;
/** What the link label columns hold (20280209000000's CHECK): number up to 128, name up to 256. */
export const HUB_PROJECT_NUMBER_MAX = 128;
export const HUB_PROJECT_NAME_MAX = 256;

/** A Hub project id as Hub writes it (one definition, in the contracts the route validates with). */
export { HUB_PROJECT_ID };

export type HubProject = { id: string; number: string | null; name: string | null };

export type HubCallFailure =
  /** Hub couldn't be reached, broke the connection, or redirected */
  | 'unreachable'
  | 'timeout'
  /** Hub refused the office token (401 or 403): an operator renews it */
  | 'refused'
  /** Hub answered another non-2xx (`status` says which) */
  | 'http_status'
  /** the answer wasn't the JSON Hub sends, or was too large */
  | 'unreadable';

export type HubCall<T> = { ok: true; value: T } | { ok: false; failure: HubCallFailure; status?: number };

export type HubCallOptions = { timeoutMs?: number; fetchImpl?: typeof fetch };

const fail = <T>(failure: HubCallFailure, status?: number): HubCall<T> =>
  status === undefined ? { ok: false, failure } : { ok: false, failure, status };

/** Whether a failure may pass on a later try (the screen says "try again" rather than "renew the key"). */
export function hubCallRetryable(failure: HubCallFailure, status?: number): boolean {
  if (failure === 'unreachable' || failure === 'timeout') return true;
  if (failure === 'http_status') return status === undefined || status >= 500 || status === 408 || status === 429;
  return false;
}

/** Trims text from Hub to fit its column: control characters become spaces; blank is null; longer is cut. */
export function clipHubText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text === '') return null;
  return [...text].slice(0, max).join('').trim() || null;
}

async function call(
  config: HubClientConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: HubCallOptions,
  form?: Record<string, string>,
): Promise<HubCall<{ status: number; json: unknown }>> {
  const doFetch = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? HUB_CALL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.officeToken}`, Accept: 'application/json' };
    let body: string | undefined;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await doFetch(new URL(path, config.baseUrl), { method, headers, body, redirect: 'manual', signal });
    if (res.status >= 300 && res.status <= 399) {
      await res.body?.cancel();
      return fail('unreachable');
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return fail('refused', res.status);
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel();
      return fail('http_status', res.status);
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > HUB_CALL_MAX_BYTES) {
      await res.body?.cancel();
      return fail('unreadable');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > HUB_CALL_MAX_BYTES) {
          await reader.cancel();
          return fail('unreadable');
        }
        chunks.push(Buffer.from(value));
      }
    }
    const text = Buffer.concat(chunks, length).toString('utf8');
    if (text.trim() === '') return { ok: true, value: { status: res.status, json: null } };
    try {
      return { ok: true, value: { status: res.status, json: JSON.parse(text) as unknown } };
    } catch {
      return fail('unreadable');
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))) return fail('timeout');
    return fail('unreachable');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads one row of Hub's project list; null when it isn't a usable project. */
function readProject(row: unknown): (HubProject & { archived: boolean }) | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) ? String(row.id) : typeof row.id === 'string' ? row.id : null;
  if (id === null || !HUB_PROJECT_ID.test(id)) return null;
  const archived = row.archived === true || row.archived === 1 || row.archived === '1';
  return { id, number: clipHubText(row.number, HUB_PROJECT_NUMBER_MAX), name: clipHubText(row.name, HUB_PROJECT_NAME_MAX), archived };
}

/** The live (not archived) Hub projects the office token reaches, in Hub's order (by number). */
export async function listHubProjects(config: HubClientConfig, options: HubCallOptions = {}): Promise<HubCall<HubProject[]>> {
  const r = await call(config, 'GET', '/api/v2/projects', options);
  if (!r.ok) return r;
  const list = isRecord(r.value.json) ? r.value.json.projects : undefined;
  if (!Array.isArray(list)) return fail('unreadable');
  const out: HubProject[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const p = readProject(row);
    if (!p || p.archived || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, number: p.number, name: p.name });
  }
  return { ok: true, value: out };
}

/** Links Hub project `hubProjectId` to PMC project `externalId` (Hub upserts, so a repeat changes nothing). */
export async function linkHubProject(
  config: HubClientConfig,
  hubProjectId: string,
  link: { externalId: string; url: string | null; label: string },
  options: HubCallOptions = {},
): Promise<HubCall<null>> {
  if (!HUB_PROJECT_ID.test(hubProjectId)) return fail('http_status', 400);
  const form: Record<string, string> = { externalId: link.externalId, label: link.label };
  if (link.url) form.url = link.url;
  const r = await call(config, 'POST', `/api/v2/projects/${hubProjectId}/links/pmc`, options, form);
  return r.ok ? { ok: true, value: null } : r;
}

/** Removes Hub project `hubProjectId`'s `pmc` link. A link already gone (Hub lists no `pmc` link) counts as removed. */
export async function unlinkHubProject(config: HubClientConfig, hubProjectId: string, options: HubCallOptions = {}): Promise<HubCall<null>> {
  if (!HUB_PROJECT_ID.test(hubProjectId)) return fail('http_status', 400);
  const r = await call(config, 'DELETE', `/api/v2/projects/${hubProjectId}/links/pmc`, options);
  if (r.ok) return { ok: true, value: null };
  if (r.failure !== 'http_status' || r.status !== 400) return r;
  // Hub answers 400 when the project has no such link: ask Hub what it lists
  const links = await call(config, 'GET', `/api/v2/projects/${hubProjectId}/links`, options);
  if (!links.ok) return r;
  const list = isRecord(links.value.json) ? links.value.json.links : undefined;
  if (!Array.isArray(list)) return r;
  const stillLinked = list.some((l) => isRecord(l) && typeof l.app === 'string' && l.app.toLowerCase() === 'pmc');
  return stillLinked ? r : { ok: true, value: null };
}
