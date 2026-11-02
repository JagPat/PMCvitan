/**
 * Redbracket ID A3 — the per-person limit on password tries while Redbracket ID sign-in is on, so PMC's form cannot be
 * used to guess passwords at the issuer: 5 tries for one email from one address in 15 minutes, and 10 for one email in
 * an hour. A try is counted before the issuer is asked; a spent limit asks nothing. Sign-in (break-glass included) and
 * reset requests share the one quota: the kind is kept on each row for the record only, never to split the count.
 *
 * Only keyed digests are stored (HMAC-SHA256 under a key derived from PMC's own signing secret), never an email or an
 * address. Rows older than a day are removed as tries are counted.
 */
import { createHmac } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';
import { resolveJwtSecret } from '../../config';

export type AttemptKind = 'sign-in' | 'reset';

const PAIR_LIMIT = 5;
const PAIR_WINDOW_MS = 15 * 60_000;
const EMAIL_LIMIT = 10;
const EMAIL_WINDOW_MS = 60 * 60_000;
const KEEP_MS = 24 * 60 * 60_000;

export class SignInAttempts {
  private readonly key = createHmac('sha256', resolveJwtSecret()).update('redbracket-id sign-in attempts').digest();

  constructor(private readonly prisma: PrismaService) {}

  private digest(label: string, value: string): string {
    return createHmac('sha256', this.key).update(`${label}:${value}`).digest('hex');
  }

  /**
   * Counts this try and says whether it is within the limits. The try is written first and then counted with every
   * other one, so tries racing each other all see each other and none slips past the limit. Returns the try's id
   * (for the one log line), whether it may go ahead, and, when it may not, how long until the next try would be
   * within every limit (a refused try is counted too, so it is part of that wait).
   */
  async count(kind: AttemptKind, email: string, address: string, now = new Date()): Promise<{ id: string; allowed: boolean; retryAfterSeconds: number }> {
    const emailHash = this.digest('email', email.trim().toLowerCase());
    const addressHash = this.digest('address', address || 'unknown');
    const row = await this.prisma.signInAttempt.create({ data: { kind, emailHash, addressHash, at: now } });
    const windows = [
      { where: { emailHash, addressHash, at: { gt: new Date(now.getTime() - PAIR_WINDOW_MS) } }, limit: PAIR_LIMIT, ms: PAIR_WINDOW_MS },
      { where: { emailHash, at: { gt: new Date(now.getTime() - EMAIL_WINDOW_MS) } }, limit: EMAIL_LIMIT, ms: EMAIL_WINDOW_MS },
    ];
    const counts = await Promise.all(windows.map((w) => this.prisma.signInAttempt.count({ where: w.where })));
    await this.prisma.signInAttempt.deleteMany({ where: { at: { lt: new Date(now.getTime() - KEEP_MS) } } });
    const allowed = windows.every((w, i) => counts[i]! <= w.limit);
    let retryAfterMs = 0;
    for (const [i, w] of windows.entries()) {
      if (counts[i]! <= w.limit) continue;
      // the next try is within this limit once only limit - 1 of the tries now counted remain in the window: when the
      // limit-th newest of them leaves it
      const [edge] = await this.prisma.signInAttempt.findMany({ where: w.where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: w.limit - 1, take: 1, select: { at: true } });
      if (edge) retryAfterMs = Math.max(retryAfterMs, edge.at.getTime() + w.ms - now.getTime());
    }
    return { id: row.id.toString(), allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
}
