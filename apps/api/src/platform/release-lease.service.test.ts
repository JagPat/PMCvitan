import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ReleaseLeaseService, RELEASE_LEASE_RENEW_MS } from './release-lease.service';
import { registerConsumer, unregisterConsumer } from './outbox/registry';

/**
 * 4d-ii-a — the ReleaseLease startup writer outside the test boot: it writes ONE lease, a failed
 * write aborts boot (a serving process with no lease is invisible to the drain), and it renews on
 * an interval that stops with the module. The live SQL is proven in the integration probe.
 */
describe('ReleaseLeaseService (4d-ii-a)', () => {
  const env = process.env.NODE_ENV;
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NODE_ENV = 'production';
    registerConsumer({ name: 'probe.lease', kind: 'socket', effect: 'probe', catalogVersion: 7 } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = env;
    unregisterConsumer('probe.lease');
  });

  it('writes one lease at the compiled version, renews on the interval, and stops with the module', async () => {
    const executeRaw = vi.fn(async () => 1);
    const svc = new ReleaseLeaseService({ $executeRaw: executeRaw } as never);
    await svc.register();
    await svc.register(); // idempotent: one process, one lease
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const insert = executeRaw.mock.calls[0]![0] as unknown as { sql: string; values: unknown[] };
    expect(insert.sql).toMatch(/INSERT INTO "ReleaseLease"/);
    expect(insert.values).toContain(7);

    await vi.advanceTimersByTimeAsync(RELEASE_LEASE_RENEW_MS);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect((executeRaw.mock.calls[1]![0] as unknown as { sql: string }).sql).toMatch(/GREATEST\("leaseUntil"/);

    svc.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(RELEASE_LEASE_RENEW_MS * 3);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('a refused lease aborts registration rather than serving unregistered', async () => {
    const svc = new ReleaseLeaseService({ $executeRaw: vi.fn(async () => { throw new Error('takes no INSERT yet'); }) } as never);
    await expect(svc.register()).rejects.toThrow(/takes no INSERT yet/);
  });
});
