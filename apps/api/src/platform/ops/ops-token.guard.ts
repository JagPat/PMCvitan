import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

/** The shortest `OPS_TOKEN` the door accepts; anything shorter keeps it closed, so a weak key cannot open it. */
export const OPS_TOKEN_MIN_LENGTH = 32;

/** Wrong or missing tokens one address may present per window before the door answers 429 instead of 401. */
export const OPS_DOOR_FAILURES_PER_ADDRESS = 10;
/** Wrong or missing tokens all addresses together may present per window, so rotating addresses does not help. */
export const OPS_DOOR_FAILURES_GLOBAL = 50;
export const OPS_DOOR_WINDOW_MS = 60_000;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

// address (or ALL) -> fixed window of refused tokens. One in-process map shared by every guarded route, the same
// single-instance storage `ThrottleGuard` uses; pruned lazily so it stays bounded by active addresses.
const ALL = '*';
const refused = new Map<string, { count: number; resetAt: number }>();
let nextPrune = 0;

/** Count one refused token against `key`; true when that window is now over `limit`. A window left more than one
 *  window ahead (the clock stepped back) counts as expired. */
function overLimit(key: string, limit: number, now: number): boolean {
  const entry = refused.get(key);
  if (!entry || now >= entry.resetAt || entry.resetAt - now > OPS_DOOR_WINDOW_MS) {
    refused.set(key, { count: 1, resetAt: now + OPS_DOOR_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

/**
 * #482 operator door — the `/ops` routes answer only a caller holding `OPS_TOKEN` (`Authorization: Bearer`).
 *
 * The door is CLOSED unless the deployment sets an `OPS_TOKEN` of at least {@link OPS_TOKEN_MIN_LENGTH}
 * characters: every guarded route then answers Nest's own unrouted 404 (`Cannot <METHOD> <url>`), the same body
 * and length a server without the routes gives, and nothing is counted. The token is read per request, so
 * removing it from the environment and restarting closes the door. Comparison is on fixed-length digests in
 * constant time, so neither the token's length nor a matching prefix leaks.
 *
 * A correct token passes without reading or touching the refusal counter, so the operator is never locked out.
 * A wrong or missing token is counted per address ({@link OPS_DOOR_FAILURES_PER_ADDRESS}) and across all
 * addresses ({@link OPS_DOOR_FAILURES_GLOBAL}) per {@link OPS_DOOR_WINDOW_MS}; over either it answers 429
 * instead of 401. `THROTTLE_DISABLED` does not apply: no legitimate caller presents wrong tokens.
 */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const expected = process.env.OPS_TOKEN?.trim() ?? '';
    if (expected.length < OPS_TOKEN_MIN_LENGTH) throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    const header: unknown = req.headers?.authorization;
    const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (presented && timingSafeEqual(digest(presented), digest(expected))) return true;

    const now = Date.now();
    if (now >= nextPrune || nextPrune - now > OPS_DOOR_WINDOW_MS) {
      for (const [key, entry] of refused) if (now >= entry.resetAt) refused.delete(key);
      nextPrune = now + OPS_DOOR_WINDOW_MS;
    }
    const address: string = req.ip || req.socket?.remoteAddress || 'unknown';
    // an address already over its own window is refused without spending the shared one
    if (overLimit(address, OPS_DOOR_FAILURES_PER_ADDRESS, now) || overLimit(ALL, OPS_DOOR_FAILURES_GLOBAL, now)) {
      const resetAt = Math.max(refused.get(address)!.resetAt, refused.get(ALL)?.resetAt ?? 0);
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      throw new HttpException({ message: 'Too many requests — please wait a moment and try again.', retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new UnauthorizedException();
  }
}
