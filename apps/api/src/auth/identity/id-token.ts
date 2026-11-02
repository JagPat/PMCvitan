/**
 * Redbracket ID A2 — checks an id token from the issuer before PMC trusts who it names.
 *
 * Only RS256 (the header's `alg` exactly, no `crit`), signed by a key the issuer publishes (`/oauth/v2/keys`, looked
 * up by `kid`); `iss` exactly the configured issuer; `aud` holding PMC's client id (and, when it names more than one
 * audience, `azp` equal to it; an `azp` that is present is always PMC's client); the `nonce` this sign-in sent; a
 * numeric `iat`; not expired (60 s leeway) and not issued in the future; an RSA key of at least 2048 bits.
 * `sub` must be 1 to 255 printable ASCII characters. Anything else is no token. Plain `node:crypto`, no extra library.
 *
 * What comes back is only who the person is. No claim is ever read as a PMC role (roles stay in PMC's Membership).
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

export type IdClaims = {
  sub: string;
  /** lower-cased; empty when the token has none */
  email: string;
  /** true only when the token says `email_verified: true` (a missing value is false) */
  emailVerified: boolean;
  givenName: string;
  familyName: string;
};

export type IdTokenCheck = {
  issuer: string;
  clientId: string;
  nonce: string;
  /** seconds since the epoch */
  now: number;
  /** the issuer's public key for this `kid`, or null when it has none */
  key: (kid: string) => Promise<KeyObject | null>;
};

const SKEW_SECONDS = 60;
const SUB = /^[\x21-\x7e]{1,255}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

function part(text: string): Record<string, unknown> | null {
  if (!B64URL.test(text)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The checked claims, or null for any token PMC must not trust. Never throws. */
export async function checkIdToken(token: string, check: IdTokenCheck): Promise<IdClaims | null> {
  try {
    if (typeof token !== 'string' || token.length > 16_384) return null;
    const pieces = token.split('.');
    if (pieces.length !== 3) return null;
    const [h, p, s] = pieces as [string, string, string];
    const header = part(h);
    const payload = part(p);
    if (!header || !payload || !B64URL.test(s)) return null;
    if (header.alg !== 'RS256' || header.crit !== undefined) return null;
    const kid = str(header.kid);
    if (!kid) return null;
    const key = await check.key(kid);
    if (!key || key.asymmetricKeyType !== 'rsa') return null;
    // a weak RSA key is no signature PMC relies on (NIST SP 800-131A: at least 2048 bits)
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    if (!verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'), key, Buffer.from(s, 'base64url'))) return null;

    if (payload.iss !== check.issuer) return null;
    const aud = payload.aud;
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every((a) => typeof a === 'string') ? (aud as string[]) : [];
    if (!audiences.includes(check.clientId)) return null;
    // an authorized party, when present, must be PMC's client whatever the audience count (OIDC Core 3.1.3.7)
    if (payload.azp !== undefined && payload.azp !== check.clientId) return null;
    if (audiences.length > 1 && payload.azp !== check.clientId) return null;
    if (payload.nonce !== check.nonce || !check.nonce) return null;
    const exp = payload.exp;
    const iat = payload.iat;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp + SKEW_SECONDS <= check.now) return null;
    // iat is a required id-token claim (OIDC Core 2): a token without one is refused, not let through unchecked
    if (typeof iat !== 'number' || !Number.isFinite(iat) || iat - SKEW_SECONDS > check.now) return null;
    const sub = str(payload.sub);
    if (!SUB.test(sub)) return null;
    return {
      sub,
      email: str(payload.email).trim().toLowerCase(),
      emailVerified: payload.email_verified === true,
      givenName: str(payload.given_name).trim(),
      familyName: str(payload.family_name).trim(),
    };
  } catch {
    return null;
  }
}

/** The one RS256 signing key with this `kid` in a JWKS document, or null (none, or more than one). Never throws. */
export function keyFromJwks(body: string, kid: string): KeyObject | null {
  try {
    const doc: unknown = JSON.parse(body);
    const keys = doc && typeof doc === 'object' && Array.isArray((doc as { keys?: unknown }).keys) ? (doc as { keys: unknown[] }).keys : [];
    let found: KeyObject | null = null;
    for (const k of keys) {
      if (!k || typeof k !== 'object') continue;
      const jwk = k as Record<string, unknown>;
      if (jwk.kid !== kid || jwk.kty !== 'RSA') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      // key_ops, when present, must allow verifying (RFC 7517 4.3); a key marked for other operations is not used
      if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.every((op) => typeof op === 'string') && jwk.key_ops.includes('verify'))) continue;
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
      if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
      // a kid names one key (RFC 7517 4.5): two usable keys under one kid is no key at all, not the first one listed
      if (found) return null;
      found = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    }
    return found;
  } catch {
    return null;
  }
}
