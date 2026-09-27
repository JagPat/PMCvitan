import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  ReleaseLeaseService, RELEASE_LEASE_RENEW_MS, RELEASE_LEASE_RETRY_MS, RELEASE_LEASE_FENCE_MARGIN_MS,
  RELEASE_LEASE_TTL_SECONDS, releaseLeaseDisabled,
} from './release-lease.service';
import { registerConsumer, unregisterConsumer } from './outbox/registry';

/**
 * 4d-ii-a — the ReleaseLease startup writer outside the test boot: it writes ONE lease, a failed
 * write aborts boot (a serving process with no lease is invisible to the drain), it renews on a
 * timer that stops with the module, and a process that cannot keep its lease live FENCES itself
 * before the lease can expire (#646's review, finding 4114736200). The live SQL is proven in the
 * integration probe.
 */
class Probe extends ReleaseLeaseService {
  readonly terminated = vi.fn<(reason: string) => void>();
  protected override clock = () => Date.now();
  protected override terminate = (reason: string) => this.terminated(reason);
}

const TTL_MS = RELEASE_LEASE_TTL_SECONDS * 1000;
const DEADLINE_MS = TTL_MS - RELEASE_LEASE_FENCE_MARGIN_MS;
const sqlOf = (call: unknown[]) => (call[0] as { sql: string }).sql;

describe('ReleaseLeaseService (4d-ii-a)', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, RELEASE_LEASE_DISABLED: process.env.RELEASE_LEASE_DISABLED };
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NODE_ENV = 'production';
    delete process.env.RELEASE_LEASE_DISABLED;
    registerConsumer({ name: 'probe.lease', kind: 'socket', effect: 'probe', catalogVersion: 7 } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.RELEASE_LEASE_DISABLED === undefined) delete process.env.RELEASE_LEASE_DISABLED;
    else process.env.RELEASE_LEASE_DISABLED = env.RELEASE_LEASE_DISABLED;
    unregisterConsumer('probe.lease');
  });

  it('writes one lease at the compiled version, renews only a LIVE lease on the interval, and stops with the module', async () => {
    const executeRaw = vi.fn(async () => 1);
    const svc = new Probe({ $executeRaw: executeRaw } as never);
    await svc.register();
    await svc.register(); // idempotent: one process, one lease
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const insert = executeRaw.mock.calls[0]![0] as unknown as { sql: string; values: unknown[] };
    expect(insert.sql).toMatch(/INSERT INTO "ReleaseLease"/);
    expect(insert.values).toContain(7);

    await vi.advanceTimersByTimeAsync(RELEASE_LEASE_RENEW_MS);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(executeRaw.mock.calls[1]!)).toMatch(/GREATEST\("leaseUntil"/);
    expect(sqlOf(executeRaw.mock.calls[1]!)).toMatch(/"leaseUntil" > CURRENT_TIMESTAMP/);

    // healthy renewals keep moving the deadline: well past one TTL, nothing is fenced
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);
    expect(svc.terminated).not.toHaveBeenCalled();

    svc.onModuleDestroy();
    const calls = executeRaw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);
    expect(executeRaw).toHaveBeenCalledTimes(calls);
    expect(svc.terminated).not.toHaveBeenCalled();
  });

  it('a refused lease aborts registration rather than serving unregistered', async () => {
    const svc = new Probe({ $executeRaw: vi.fn(async () => { throw new Error('takes no INSERT yet'); }) } as never);
    await expect(svc.register()).rejects.toThrow(/takes no INSERT yet/);
  });

  it('renewals that keep failing FENCE the process before the lease can expire, retrying meanwhile', async () => {
    let down = false;
    const executeRaw = vi.fn(async () => { if (down) throw new Error('connection refused'); return 1; });
    const svc = new Probe({ $executeRaw: executeRaw } as never);
    await svc.register();
    down = true;

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(svc.terminated).not.toHaveBeenCalled();
    // the first attempt at the interval, then a retry every RETRY_MS until the deadline
    const expectedAttempts = 1 + Math.floor((DEADLINE_MS - 1 - RELEASE_LEASE_RENEW_MS) / RELEASE_LEASE_RETRY_MS);
    expect(executeRaw).toHaveBeenCalledTimes(1 + expectedAttempts);

    await vi.advanceTimersByTimeAsync(1);
    expect(svc.terminated).toHaveBeenCalledTimes(1);
    expect(svc.terminated.mock.calls[0]![0]).toMatch(/no renewal succeeded/);
    // fenced strictly inside the lease: the database's lease runs a full TTL from the INSERT
    expect(DEADLINE_MS).toBeLessThan(TTL_MS);
  });

  it('THE RECOVERY INTERLEAVING: the database comes back after the deadline — the process was already fenced and nothing revives the lease', async () => {
    let down = false;
    const executeRaw = vi.fn(async () => { if (down) throw new Error('connection refused'); return 1; });
    const svc = new Probe({ $executeRaw: executeRaw } as never);
    await svc.register();
    down = true;
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(svc.terminated).toHaveBeenCalledTimes(1);

    down = false; // the database recovers after the fence, before the TTL itself runs out
    const calls = executeRaw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TTL_MS * 2);
    expect(executeRaw, 'a fenced process renews nothing').toHaveBeenCalledTimes(calls);
    expect(svc.terminated).toHaveBeenCalledTimes(1);
  });

  it('a renewal that succeeds before the deadline re-arms the fence from when THAT renewal was sent', async () => {
    let failing = 0;
    const executeRaw = vi.fn(async () => { if (failing > 0) { failing--; throw new Error('blip'); } return 1; });
    const svc = new Probe({ $executeRaw: executeRaw } as never);
    await svc.register();
    failing = 2; // the interval attempt and one retry fail, the next retry lands
    await vi.advanceTimersByTimeAsync(RELEASE_LEASE_RENEW_MS + 2 * RELEASE_LEASE_RETRY_MS);
    const recoveredAt = RELEASE_LEASE_RENEW_MS + 2 * RELEASE_LEASE_RETRY_MS;
    // past the ORIGINAL deadline, still serving: the recovery moved it
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - recoveredAt + 1);
    expect(svc.terminated).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('a lease that already LAPSED on the database clock is not revived — the process fences at once', async () => {
    const executeRaw = vi.fn(async () => 1);
    const svc = new Probe({ $executeRaw: executeRaw } as never);
    await svc.register();
    executeRaw.mockImplementation(async () => 0); // the live-row match found nothing
    await vi.advanceTimersByTimeAsync(RELEASE_LEASE_RENEW_MS);
    expect(svc.terminated).toHaveBeenCalledTimes(1);
    expect(svc.terminated.mock.calls[0]![0]).toMatch(/already lapsed/);
  });

  it('registration is skipped under test, and the harness opt-out is honored only OUTSIDE production', async () => {
    expect(releaseLeaseDisabled({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
    expect(releaseLeaseDisabled({ RELEASE_LEASE_DISABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(releaseLeaseDisabled({ NODE_ENV: 'development', RELEASE_LEASE_DISABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(releaseLeaseDisabled({ NODE_ENV: 'production', RELEASE_LEASE_DISABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(releaseLeaseDisabled({} as NodeJS.ProcessEnv)).toBe(false);

    process.env.RELEASE_LEASE_DISABLED = 'true'; // NODE_ENV is production here
    const executeRaw = vi.fn(async () => 1);
    await new Probe({ $executeRaw: executeRaw } as never).register();
    expect(executeRaw, 'a production process registers whatever the opt-out says').toHaveBeenCalledTimes(1);
  });
});
