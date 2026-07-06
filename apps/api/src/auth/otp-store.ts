interface Entry {
  code: string;
  expires: number;
  attempts: number;
  sentAt: number;
}

/**
 * In-memory OTP store for locally-verified channels (dev-stub, Telegram, email),
 * with two abuse controls that matter once a live channel is on:
 *   • send throttle — reject a new code within `throttleMs` of the last send
 *     (stops OTP spam and, for paid channels like Telegram, cost drain);
 *   • attempt cap — burn the code after `maxAttempts` wrong guesses, so a
 *     4-digit code can't be brute-forced across its whole validity window.
 * (MSG91 is remote-verified and rate-limited by MSG91 itself; it only uses this
 * store's throttle via `markSent`.)
 */
export class OtpStore {
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly throttleMs = 30_000,
    private readonly maxAttempts = 5,
  ) {}

  /** False when a code was sent to `key` within the throttle window (caller should 429). */
  canSend(key: string): boolean {
    const e = this.map.get(key);
    return !e || Date.now() - e.sentAt >= this.throttleMs;
  }

  /** Record a locally-verifiable code (resets attempts + send time). */
  put(key: string, code: string): void {
    this.map.set(key, { code, expires: Date.now() + this.ttlMs, attempts: 0, sentAt: Date.now() });
  }

  /** Record a send with no local code (remote-verified channel) — for throttling only. */
  markSent(key: string): void {
    this.map.set(key, { code: '', expires: Date.now() + this.ttlMs, attempts: 0, sentAt: Date.now() });
  }

  /** Attempt-limited verification. A match consumes the code; too many misses burn it. */
  verify(key: string, code: string): boolean {
    const e = this.map.get(key);
    if (!e || !e.code || e.expires < Date.now()) return false;
    e.attempts += 1;
    if (e.code === code) {
      this.map.delete(key);
      return true;
    }
    if (e.attempts >= this.maxAttempts) this.map.delete(key);
    return false;
  }
}
