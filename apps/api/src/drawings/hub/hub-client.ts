import { createHash } from 'node:crypto';
import { readHubConfig, type HubConfig } from './hub-config';

/**
 * #1118 U4 — fetches one drawing version's bytes from Hub (`notes/hub/1118-plan.md` U4).
 *
 * Hub serves a version at `GET /api/v2/drawings/{fileId}/content?versionId={versionId}` with the office token as a
 * bearer token, always as `application/octet-stream`, with the SHA-256 of the bytes in `X-Sha256` (Hub
 * `ApiV2Controller.content`, `SyncService.contentHash`). A drawing event names that same path as its `contentPath`.
 *
 * - The URL is built only from `HUB_BASE_URL` and the two ids, never from the event: the event's `contentPath` must be
 *   exactly the path built, or nothing is fetched. The ids must be URL-safe as they stand, so the path needs no
 *   encoding and the comparison is exact.
 * - Redirects are followed by hand, at most {@link HUB_REDIRECTS_MAX}, and only to Hub's own origin; anything else is
 *   refused before it is requested, so the token never reaches another host.
 * - At most {@link HUB_CONTENT_MAX_BYTES} are read, counted as the body arrives (a `Content-Length` over it is refused
 *   before reading). One timeout covers every request and the whole body.
 * - The bytes must hash to `X-Sha256`, so a truncated or altered body is refused. The type is read from the bytes
 *   themselves (Hub sends no type), and only the drawing types PMC stores are accepted.
 *
 * Nothing here logs, and a failure carries a code and an HTTP status only: never the token, a URL, a header or a body.
 */

/** The largest drawing version fetched (Hub drawings are a few MB; a large PDF set can reach tens). */
export const HUB_CONTENT_MAX_BYTES = 25 * 1024 * 1024;
/** One timeout for the whole fetch: every request and the whole body. */
export const HUB_FETCH_TIMEOUT_MS = 120_000;
/** Same-origin redirects followed before giving up. */
export const HUB_REDIRECTS_MAX = 3;

/** The drawing types a Hub version may be stored as: the drawing entries of `StorageService`'s type list. */
export type HubContentType = 'application/pdf' | 'image/vnd.dwg' | 'image/vnd.dxf' | 'image/png' | 'image/jpeg';

export type HubFetchFailure =
  /** the integration is closed */
  | 'closed'
  /** the ids aren't URL-safe, or the event's `contentPath` isn't the path PMC builds */
  | 'bad_reference'
  /** a redirect to another origin, a redirect without a usable `Location`, or too many redirects */
  | 'redirect_refused'
  /** Hub answered something other than 200 (`status` says what) */
  | 'http_status'
  /** over {@link HUB_CONTENT_MAX_BYTES}, by `Content-Length` or as read */
  | 'too_large'
  /** no `X-Sha256`, or the bytes don't hash to it */
  | 'hash_mismatch'
  /** the bytes are not a PDF, DWG, DXF, PNG or JPEG */
  | 'unsupported_type'
  /** Hub couldn't be reached, or the connection broke */
  | 'unreachable'
  | 'timeout';

export type HubContent =
  | { ok: true; bytes: Buffer; mime: HubContentType; sha256: string }
  /** `retryable`: the same fetch may succeed later (Hub down, a 5xx, a broken or slow transfer) */
  | { ok: false; failure: HubFetchFailure; status?: number; retryable: boolean };

export type HubContentRef = { fileId: string; versionId: string; contentPath: unknown };

/** URL-safe as written (RFC 3986 unreserved), so a path built from it needs no encoding. */
const HUB_ID = /^[A-Za-z0-9._~-]{1,256}$/;
/** `.` and `..` are dot segments: a URL drops or climbs them, so the request would go to another Hub path */
const DOT_SEGMENT = /^\.\.?$/;

/** The one path PMC fetches a version from, or null when an id isn't URL-safe. */
export function hubContentPath(fileId: string, versionId: string): string | null {
  if (!HUB_ID.test(fileId) || !HUB_ID.test(versionId) || DOT_SEGMENT.test(fileId) || DOT_SEGMENT.test(versionId)) return null;
  return `/api/v2/drawings/${fileId}/content?versionId=${versionId}`;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BINARY_DXF = Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1');
// an ASCII DXF opens with its first section (`0` / `SECTION`), after any number of `999` comments
const DXF_COMMENT = /^[ \t]*999\r?\n/;
const ASCII_DXF_SECTION = /^[ \t]*0\r?\n[ \t]*SECTION[ \t]*\r?\n/;

/** Whether `bytes` is an ASCII DXF: its leading comments are skipped however long they run, then its first section. */
function isAsciiDxf(bytes: Buffer): boolean {
  let at = 0;
  for (let m; (m = DXF_COMMENT.exec(bytes.subarray(at, at + 64).toString('latin1'))); ) {
    const end = bytes.indexOf(0x0a, at + m[0].length); // the comment's own line
    if (end < 0) return false;
    at = end + 1;
  }
  return ASCII_DXF_SECTION.test(bytes.subarray(at, at + 64).toString('latin1'));
}

/** The drawing type of `bytes`, read from their first bytes; null for anything else. */
export function sniffDrawingType(bytes: Buffer): HubContentType | null {
  const head = bytes.subarray(0, 512).toString('latin1');
  if (head.startsWith('%PDF-')) return 'application/pdf';
  // AutoCAD R13 (AC1012) onwards; earlier versions (AC1009 and before) are refused
  if (/^AC10(?:1[2-9]|[2-9]\d)/.test(head)) return 'image/vnd.dwg';
  if (bytes.subarray(0, BINARY_DXF.length).equals(BINARY_DXF) || isAsciiDxf(bytes)) return 'image/vnd.dxf';
  if (bytes.subarray(0, PNG.length).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

const fail = (failure: HubFetchFailure, retryable: boolean, status?: number): HubContent =>
  status === undefined ? { ok: false, failure, retryable } : { ok: false, failure, status, retryable };

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

export type HubFetchOptions = {
  /** the integration's configuration; read from the environment when not given */
  config?: HubConfig;
  maxBytes?: number;
  timeoutMs?: number;
};

/** Fetches the version `ref` names. Never throws for anything Hub or the network does. */
export async function fetchHubContent(ref: HubContentRef, options: HubFetchOptions = {}): Promise<HubContent> {
  let config = options.config;
  if (!config) {
    const hub = readHubConfig();
    if (!hub.open) return fail('closed', false);
    config = hub.config;
  }
  const maxBytes = options.maxBytes ?? HUB_CONTENT_MAX_BYTES;
  const path = hubContentPath(ref.fileId, ref.versionId);
  if (path === null || ref.contentPath !== path) return fail('bad_reference', false);

  const signal = AbortSignal.timeout(options.timeoutMs ?? HUB_FETCH_TIMEOUT_MS);
  let url = new URL(path, config.baseUrl);
  try {
    let res: Response;
    for (let hops = 0; ; hops++) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${config.officeToken}` }, redirect: 'manual', signal });
      if (res.status < 300 || res.status > 399) break;
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (location === null || hops === HUB_REDIRECTS_MAX) return fail('redirect_refused', false);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return fail('redirect_refused', false);
      }
      // the token goes only to Hub's own origin: scheme, host and port
      if (next.origin !== config.baseUrl) return fail('redirect_refused', false);
      url = next;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      // a 5xx, 408 (request timeout) or 429 (rate limited) may pass on a later try
      return fail('http_status', res.status >= 500 || res.status === 408 || res.status === 429, res.status);
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > maxBytes) {
      await res.body?.cancel();
      return fail('too_large', false);
    }
    const want = res.headers.get('x-sha256')?.trim().toLowerCase();

    const chunks: Buffer[] = [];
    let length = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          return fail('too_large', false);
        }
        chunks.push(Buffer.from(value));
      }
    }
    const bytes = Buffer.concat(chunks, length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // a body cut short or altered on the way is retried; a version whose stored hash is wrong stays wrong, but the
    // retries end with Hub's, and refusing it for good would lose a good version to one broken transfer
    if (!want || !/^[0-9a-f]{64}$/.test(want) || want !== sha256) return fail('hash_mismatch', true);
    const mime = sniffDrawingType(bytes);
    if (mime === null) return fail('unsupported_type', false);
    return { ok: true, bytes, mime, sha256 };
  } catch (err) {
    if (signal.aborted || isAbort(err)) return fail('timeout', true);
    return fail('unreachable', true);
  }
}
