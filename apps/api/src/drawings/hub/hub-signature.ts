/**
 * #1118 U2 — checks a Hub webhook's Standard Webhooks signature. Pure: no clock, no environment, no I/O.
 *
 * The signed content is `${webhook-id}.${webhook-timestamp}.${body}`, with the body exactly as received (bytes, never
 * re-encoded). `webhook-signature` is a space-separated list of `version,base64`. Only `v1` (HMAC-SHA256) entries
 * count; any other version is skipped. A delivery passes when one `v1` entry matches one of the configured secrets,
 * so during a rotation both the old and the new secret pass.
 *
 * Every `v1` entry is compared with every secret's HMAC on fixed 32-byte buffers with `timingSafeEqual`, and the loop
 * never stops early, so the time taken says nothing about which entry or secret came close. The timestamp must be
 * within {@link HUB_SIGNATURE_TOLERANCE_SECONDS} of `now`, either side, so a captured delivery can't be replayed
 * later. A webhook-id may not contain `.`, so the id and the timestamp can only be split one way.
 *
 * A header sent more than once is refused, whichever way the caller reads headers: `req.headersDistinct` gives an
 * array (one element is fine), and `req.headers` joins repeats with `", "`, which no real value holds (a signature
 * list is space-separated, base64 has no comma, and an id or a timestamp has no space). The id rules (visible ASCII,
 * no `.`, at most 256) are stricter than the specification and wait on Hub's confirmation (`1118-plan.md` §4).
 *
 * The verdict names a reason for logs and tests; it never carries a header value, a signature or a secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const HUB_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
/** Bounds on what one delivery may make the check do. */
export const HUB_SIGNATURE_HEADER_MAX = 2048;
export const HUB_WEBHOOK_ID_MAX = 256;

export type HubSignatureInput = {
  /** the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, from `req.headersDistinct` or `req.headers` */
  id: string | string[] | undefined;
  timestamp: string | string[] | undefined;
  signature: string | string[] | undefined;
  /** the request body as received */
  body: Buffer;
  secrets: readonly Buffer[];
  now: Date;
};

export type HubSignatureRefusal = 'missing_header' | 'repeated_header' | 'malformed_id' | 'malformed_timestamp' | 'stale' | 'future' | 'malformed_signature' | 'no_match';
export type HubSignatureVerdict = { ok: true } | { ok: false; reason: HubSignatureRefusal };

const ID = /^[\x21-\x2d\x2f-\x7e]+$/; // visible ASCII except '.'
const TIMESTAMP = /^[0-9]{1,12}$/;
const ENTRY = /^v1,([A-Za-z0-9+/]{43}=)$/; // 32 bytes of HMAC-SHA256 in base64

/** a header's one value; `null` when it was sent more than once */
const one = (header: string | string[] | undefined): string | null | undefined => {
  if (!Array.isArray(header)) return header;
  return header.length > 1 ? null : header[0];
};

export function verifyHubSignature(input: HubSignatureInput): HubSignatureVerdict {
  const id = one(input.id);
  const timestamp = one(input.timestamp);
  const signature = one(input.signature);
  if ([id, timestamp, signature].some((value) => value === null || value?.includes(', '))) return { ok: false, reason: 'repeated_header' };
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_header' };
  if (id.length > HUB_WEBHOOK_ID_MAX || !ID.test(id)) return { ok: false, reason: 'malformed_id' };
  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };

  const skew = Number(timestamp) - Math.floor(input.now.getTime() / 1000);
  if (skew < -HUB_SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  if (skew > HUB_SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'future' };

  if (signature.length > HUB_SIGNATURE_HEADER_MAX) return { ok: false, reason: 'malformed_signature' };
  const presented: Buffer[] = [];
  for (const entry of signature.split(' ')) {
    if (!entry) continue;
    const b64 = ENTRY.exec(entry)?.[1];
    if (b64) presented.push(Buffer.from(b64, 'base64'));
    else if (!/^v[0-9]+[a-z]*,\S+$/.test(entry)) return { ok: false, reason: 'malformed_signature' };
  }
  if (presented.length === 0) return { ok: false, reason: 'no_match' };

  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'ascii'), input.body]);
  let match = false;
  for (const secret of input.secrets) {
    const expected = createHmac('sha256', secret).update(signed).digest();
    for (const candidate of presented) match = timingSafeEqual(candidate, expected) || match;
  }
  return match ? { ok: true } : { ok: false, reason: 'no_match' };
}
