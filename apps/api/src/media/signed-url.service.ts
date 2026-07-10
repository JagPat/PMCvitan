import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveJwtSecret } from '../config';

export type FileKind = 'media' | 'drawing';

const DEFAULT_TTL_SEC = 3600; // 60 min — a leaked file URL dies quickly; snapshots refetch tokens

/**
 * Short-lived, unforgeable access tokens for private file serving.
 *
 * Media & drawing files are NOT public. Each `GET /media/:id` / `GET /drawings/rev/:id`
 * must carry a `?t=` token that this service minted for that exact (kind, id). Tokens are
 * minted only while building the RBAC-filtered snapshot (or on upload) — i.e. only for a
 * caller already authorized to see the file — and expire in `FILE_URL_TTL_SEC` (default
 * 60 min). So a URL that leaks (shared link, referer, history) stops working shortly after,
 * and a user whose access was revoked can't mint fresh ones. The token rides in the query
 * string because an `<img>`/viewer `src` can't send an Authorization header.
 *
 * HMAC-SHA256 over `${kind}:${id}:${exp}` with the app's JWT secret (rotatable) — no DB
 * round-trip to verify, and nothing in the token but the expiry and signature.
 */
@Injectable()
export class SignedUrlService {
  private readonly secret = resolveJwtSecret();

  private ttlSec(): number {
    const v = Number(process.env.FILE_URL_TTL_SEC);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TTL_SEC;
  }

  private nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  private sig(kind: FileKind, id: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${kind}:${id}:${exp}`).digest('base64url');
  }

  /** Mint a token authorizing GET of one file. Format: `<expEpochSec>.<base64url hmac>`. */
  sign(kind: FileKind, id: string): string {
    const exp = this.nowSec() + this.ttlSec();
    return `${exp}.${this.sig(kind, id, exp)}`;
  }

  /** Verify a token for (kind, id): well-formed, unexpired, and a matching signature. */
  verify(kind: FileKind, id: string, token: string | undefined): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const exp = Number(token.slice(0, dot));
    if (!Number.isInteger(exp) || exp < this.nowSec()) return false;
    const provided = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sig(kind, id, exp));
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  /** Relative, token-carrying path the frontend resolves against the API base. */
  mediaPath(id: string): string {
    return `/media/${id}?t=${this.sign('media', id)}`;
  }

  drawingPath(id: string): string {
    return `/drawings/rev/${id}?t=${this.sign('drawing', id)}`;
  }

  /** TTL in seconds, for the serve endpoint's `Cache-Control: private, max-age`. */
  cacheMaxAge(): number {
    return this.ttlSec();
  }
}
