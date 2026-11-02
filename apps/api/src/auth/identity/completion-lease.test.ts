/**
 * Redbracket ID A4a — the lease a claimed password completion holds its account by must outlast the longest that
 * completion can run, or a slow (not stopped) completion would lose its hold and a newer one could start beside it.
 * The lease is derived from the issuer timeout; these pins keep its inputs true to the code they count.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTITY_TIMEOUT_MS } from './identity-client';
import {
  COMPLETION_ISSUER_CALLS,
  COMPLETION_LEASE_MS,
  COMPLETION_TRANSACTIONS,
  PRISMA_TRANSACTION_BOUND_MS,
} from '../password-credentials.service';

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');

describe('password completion lease (A4a)', () => {
  it('outlasts every issuer call to its timeout and every transaction to its bound, with a margin', () => {
    const longest = COMPLETION_ISSUER_CALLS * IDENTITY_TIMEOUT_MS + COMPLETION_TRANSACTIONS * PRISMA_TRANSACTION_BOUND_MS;
    expect(COMPLETION_LEASE_MS).toBeGreaterThanOrEqual(longest + 30_000);
  });

  it('counts every issuer call the client can make (making a person and setting a password are one or the other)', () => {
    const client = read('identity-client.ts');
    // every call site, awaited or not, however it is written: `this.send(` and nothing else reaches the network
    const sends = client.match(/\bthis\.send\(/g) ?? [];
    expect(sends.length - 1).toBe(COMPLETION_ISSUER_CALLS);
    expect(client.match(/\bsend\b/g)?.length).toBe(sends.length + 1); // + its declaration: no alias, no wrapper
    // one plain fetch per send, in send itself: no retrying wrapper, no loop, no second request
    expect(client.match(/\bfetch\(/g) ?? []).toHaveLength(1);
    const send = client.slice(client.indexOf('  private async send('), client.indexOf('\n  }\n', client.indexOf('  private async send(')));
    expect(send.match(/\bfetch\(/g) ?? []).toHaveLength(1);
    expect(send).not.toMatch(/\b(for|while|do)\b|\.then\(|setTimeout|retr(y|ies)/i);
    expect(client).not.toMatch(/\bretr(y|ies)\b|setTimeout|setInterval/i);
  });

  it('the completion uses the issuer timeout and Prisma\'s default transaction bounds, never longer ones', () => {
    const signIn = read('identity-sign-in.service.ts');
    expect(signIn).toContain('new IdentityClient(config)');
    // the service reaches the issuer only through that client: no request of its own, no retry, no timer
    for (const path of ['identity-sign-in.service.ts', '../password-credentials.service.ts']) {
      const source = read(path);
      expect(source).not.toMatch(/\bfetch\(|\bhttps?\.request\(|XMLHttpRequest|setTimeout|setInterval/);
      expect(source).not.toMatch(/\bretr(y|ies)\b/i);
    }
    expect(signIn).not.toMatch(/timeoutMs|maxWait|timeout:/);
    expect(read('../password-credentials.service.ts')).not.toMatch(/maxWait|timeout:/);
    // the transactions after the claim: sessions ended before the issuer write (one call in each of the two branches,
    // only one of which runs), again after a failed step, and the settle (the one transaction in setPassword itself)
    const setPassword = signIn.slice(signIn.indexOf('  async setPassword('), signIn.indexOf('  private async endSessions('));
    const endSessions = signIn.slice(signIn.indexOf('  private async endSessions('));
    expect(setPassword.match(/\bthis\.endSessions\(/g) ?? []).toHaveLength(3);
    expect(setPassword.match(/\$transaction\(/g) ?? []).toHaveLength(1);
    expect(endSessions.slice(0, endSessions.indexOf('\n  }\n')).match(/\$transaction\(/g) ?? []).toHaveLength(1);
    expect(3 - 1 + 1).toBe(COMPLETION_TRANSACTIONS);
  });
});
