/**
 * Redbracket ID A3 — the per-person limit on password tries while Redbracket ID sign-in is on, so PMC's form cannot be
 * used to guess passwords at the issuer: 5 tries for one email from one address in 15 minutes, and 10 for one email in
 * an hour. A try is counted before the issuer is asked; a spent limit asks nothing.
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
   * (for the one log line) and whether it may go ahead.
   */
  async count(kind: AttemptKind, email: string, address: string, now = new Date()): Promise<{ id: string; allowed: boolean }> {
    const emailHash = this.digest('email', email.trim().toLowerCase());
    const addressHash = this.digest('address', address || 'unknown');
    const row = await this.prisma.signInAttempt.create({ data: { kind, emailHash, addressHash, at: now } });
    const [pair, all] = await Promise.all([
      this.prisma.signInAttempt.count({ where: { kind, emailHash, addressHash, at: { gt: new Date(now.getTime() - PAIR_WINDOW_MS) } } }),
      this.prisma.signInAttempt.count({ where: { kind, emailHash, at: { gt: new Date(now.getTime() - EMAIL_WINDOW_MS) } } }),
    ]);
    await this.prisma.signInAttempt.deleteMany({ where: { at: { lt: new Date(now.getTime() - KEEP_MS) } } });
    return { id: row.id.toString(), allowed: pair <= PAIR_LIMIT && all <= EMAIL_LIMIT };
  }
}
