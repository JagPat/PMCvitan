import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const THROTTLE_KEY = 'throttle';

export interface ThrottleOpts {
  /** Max requests allowed per window, per client IP + handler. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Rate-limit a handler to `limit` requests per `windowMs`, keyed by client IP. Applied to
 * the sensitive auth endpoints (OTP/login/worker-token) to blunt brute-force and cost-abuse
 * (each OTP is a paid SMS). Storage is a single in-process map — the same single-instance
 * assumption the OTP store already makes; a horizontally-scaled deploy would move both to
 * a shared store (Redis). Handlers with no `@Throttle` are not limited.
 */
export const Throttle = (limit: number, windowMs: number): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_KEY, { limit, windowMs } satisfies ThrottleOpts);

@Injectable()
export class ThrottleGuard implements CanActivate {
  // key -> fixed window counter. Pruned lazily so it can't grow without bound.
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextPrune = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<ThrottleOpts | undefined>(THROTTLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!opts) return true; // not throttled

    // Guard against a clock/store hiccup ever locking users out: fail open on any error.
    try {
      const now = Date.now();
      const req = ctx.switchToHttp().getRequest();
      const ip: string = req.ip || req.socket?.remoteAddress || 'unknown';
      const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${ip}`;

      if (now >= this.nextPrune) this.prune(now);

      const entry = this.hits.get(key);
      if (!entry || now >= entry.resetAt) {
        this.hits.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      entry.count += 1;
      if (entry.count > opts.limit) {
        const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        throw new HttpException(
          { message: 'Too many requests — please wait a moment and try again.', retryAfter },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err; // the 429 is intentional
      return true; // any unexpected error → don't block the request
    }
  }

  /** Drop expired windows so the map stays bounded by active clients, not total traffic. */
  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
    this.nextPrune = now + 60_000; // at most once a minute
  }
}
