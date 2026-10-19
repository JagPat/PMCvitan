import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

/** The shortest `OPS_TOKEN` the door accepts; anything shorter keeps it closed, so a weak key cannot open it. */
export const OPS_TOKEN_MIN_LENGTH = 32;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * #482 operator door — the `/ops` routes answer only a caller holding `OPS_TOKEN` (`Authorization: Bearer`).
 *
 * The door is CLOSED unless the deployment sets an `OPS_TOKEN` of at least {@link OPS_TOKEN_MIN_LENGTH}
 * characters: every `/ops` route then answers 404, exactly as a server without the routes would. The token
 * is read per request, so removing it from the environment and restarting closes the door. Comparison is on
 * fixed-length digests in constant time, so neither the token's length nor a matching prefix leaks.
 */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.OPS_TOKEN?.trim() ?? '';
    if (expected.length < OPS_TOKEN_MIN_LENGTH) throw new NotFoundException();
    const header: unknown = ctx.switchToHttp().getRequest().headers?.authorization;
    const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!presented || !timingSafeEqual(digest(presented), digest(expected))) throw new UnauthorizedException();
    return true;
  }
}
