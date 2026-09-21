// The lock-order probe (reform-1b) against REAL PostgreSQL: it FAILS on each broken guard and PASSES
// on the corrected one, and — the concern of this unit — no holder, contender, or competitor lock it
// starts ever outlives its return. Scratch table only. Three real sessions interleave on _probe_lock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_LIFETIMES, TEST_TIMEOUT_MS, lockOrderProbe, worstCase,
} from '../invariants/lock-order-probe';
import { ProbeFailure } from '../invariants/probes';

const a = new PrismaClient(); // holder + competitor + inspection (session A pool)
const b = new PrismaClient(); // contender (session B pool)
const sql = (client: PrismaClient, text: string) => client.$executeRawUnsafe(text);
const rows = <T,>(client: PrismaClient, text: string) => client.$queryRawUnsafe<T[]>(text);
const failsWith = (pattern: RegExp) => async (run: () => Promise<unknown>) => {
  await expect(run()).rejects.toSatisfy((e: unknown) => e instanceof ProbeFailure && pattern.test((e as Error).message));
};

const disposable = (database: string) => /(?:^|_)test$/u.test(database);
let setupPassed = false;
beforeAll(async () => {
  const database = (() => { try { return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)); } catch { return ''; } })();
  if (!disposable(database)) throw new Error(`DATABASE_URL must name a disposable test database (\`test\` or \`*_test\`), not "${database}"`);
  await sql(a, 'DROP TABLE IF EXISTS _probe_lock');
  await sql(a, 'CREATE TABLE _probe_lock (id int PRIMARY KEY, status text NOT NULL)');
  await sql(a, "INSERT INTO _probe_lock VALUES (1, 'open')");
  setupPassed = true;
});
afterAll(async () => {
  if (setupPassed) await sql(a, 'DROP TABLE IF EXISTS _probe_lock');
  await a.$disconnect(); await b.$disconnect();
});

describe('lockOrderProbe', () => {
  // This unit's honest worst case (readiness + initial inspection, then the settle/competitor waits,
  // THEN the terminal verify(), plus the bounded cleanup of every participant) exceeds a bare 30s, so
  // the probe declares its own wider per-test bound; pin THIS file to it (the rest of the integration
  // suite keeps the default) so the probe can NAME a hang before Vitest kills the test.
  vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });
  beforeEach(() => sql(a, "UPDATE _probe_lock SET status = 'open' WHERE id = 1"));
  const L = DEFAULT_LIFETIMES;
  const TX = { timeout: L.holderTxMs, maxWait: L.maxWaitMs };  // the holder: its DECLARED bound, so cleanup can await it out even when abort() fails
  const CTX = { timeout: L.contenderTxMs, maxWait: L.maxWaitMs }; // the contender: short, below the settle window
  const COMP = { timeout: L.competitorTxMs, maxWait: L.maxWaitMs };

  /** the holder on session A: locks the row, closes it, holds the transaction open until released.
   * `txMs` lets a test give the holder a short timeout so its transaction DIES after readiness. */
  const holder = (opts: { txMs?: number; body?: (t: { $executeRawUnsafe: (s: string) => Promise<unknown>; $queryRawUnsafe: (s: string) => Promise<unknown> }) => Promise<void> } = {}) => {
    let release!: () => void; let abort!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => { release = resolve; abort = reject; });
    gate.catch(() => undefined);
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const tx = a.$transaction(async (t) => {
      await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
      await t.$executeRawUnsafe("UPDATE _probe_lock SET status = 'closed' WHERE id = 1");
      if (opts.body) await opts.body(t as never);
      ready(); await gate;
    }, { timeout: opts.txMs ?? TX.timeout, maxWait: TX.maxWait });
    // readiness is COUPLED to the transaction: a holder that fails (or ends) before ready() rejects readiness instead of hanging
    const ended = tx.then(() => { throw new Error('the holder transaction ended before it was ready'); }, (error: unknown) => { throw error; });
    ended.catch(() => undefined);
    return {
      holderReady: () => Promise.race([locked, ended]),
      holderMonitor: () => tx, // rejects if the holder transaction fails/times out; resolves on a clean release
      release: async () => { release(); await tx; },
      abort: async () => { abort(new Error('holder aborted')); await tx.catch(() => undefined); },
    };
  };

  const INSPECT_WINDOW_MS = L.maxWaitMs + 3_000;
  const inspectBlocked = async () => {
    for (let i = 0; i < INSPECT_WINDOW_MS / 50; i += 1) {
      const waiting = await rows<{ n: bigint }>(a,
        `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%_probe_lock%' AND pid <> pg_backend_pid()`);
      if (waiting[0]!.n > 0n) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const competitor = (comp = COMP) => async () => { await a.$transaction(async (t) => { await t.$executeRawUnsafe("UPDATE _probe_lock SET status = status || '+raced' WHERE id = 1"); }, comp); };
  const VERIFY_TX = { timeout: L.verifyTxMs, maxWait: L.maxWaitMs };
  // verify honors the contract: it reads back the terminal order inside a BOUNDED transaction, so a
  // read that hangs after a connection fault is rolled back by the database rather than left holding the
  // row. The `signal` is accepted for a cooperative verify; the happy-path read completes long before it.
  const verify = async (_signal?: AbortSignal) => {
    const status = await a.$transaction(async (t) => (await (t as unknown as { $queryRawUnsafe: <T>(s: string) => Promise<T[]> })
      .$queryRawUnsafe<{ status: string }>('SELECT status FROM _probe_lock WHERE id = 1'))[0]!.status, VERIFY_TX);
    expect(status).toBe('closed+guard+raced');
  };
  const read = (suffix: string) => rows<{ status: string }>(b, `SELECT status FROM _probe_lock WHERE id = 1${suffix}`);
  const guardMark = "UPDATE _probe_lock SET status = status || '+guard' WHERE id = 1";
  const fixture = (h = holder()) => ({ ...h, inspectBlocked, competitor: competitor(), verify });
  const guardedContender = ({ observed, proceed }: { observed: () => void; proceed: Promise<void> }) => b.$transaction(async (t) => {
    const r = await t.$queryRawUnsafe<{ status: string }[]>('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
    observed(); await proceed;
    await t.$executeRawUnsafe(guardMark);
    return r;
  }, CTX);
  /** the row is lockable once any abandoned contender read drains; poll past the transient, a row that stays locked is a real failure */
  const assertFreeSoon = async () => {
    for (let i = 0; i < 120; i += 1) {
      try { await read(' FOR UPDATE NOWAIT'); return; } catch (error) {
        if (!/55P03|could not obtain lock/u.test(String((error as Error).message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await read(' FOR UPDATE NOWAIT');
  };

  it('budgets its worst case under the per-test timeout, refuses bounds that would not fit, and still frees the holder it was given', async () => {
    expect(worstCase(L, DEFAULT_LIFETIMES.maxWaitMs + DEFAULT_LIFETIMES.contenderTxMs + 1_000)).toBeLessThan(TEST_TIMEOUT_MS);
    // the fixture has already started a holder transaction; a rejected budget must still run through
    // cleanup and free that holder, not return and leave it holding the row until its own timeout.
    await failsWith(/does not fit under the .* per-test timeout/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: guardedContender, lifetimes: { competitorTxMs: 60_000 } }));
    await assertFreeSoon();
  });

  it('passes on a guard that locks first inside one transaction and holds through its mutation', async () => {
    await lockOrderProbe({ ...fixture(), contenderStarted: guardedContender });
    await assertFreeSoon();
  });

  it('fails on a guard that reads the status before locking: never blocked, or read first then locked', async () => {
    await failsWith(/lock-after-read/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: ({ observed }) => (async () => { const r = await read(''); observed(); return r; })() }));
    await failsWith(/status read before the holder released/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: ({ observed }) => (async () => { await read(''); observed(); return read(' FOR UPDATE'); })() }));
    await failsWith(/never reported its status read/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: () => (async () => read(' FOR UPDATE'))() }));
    await assertFreeSoon();
  });

  it('fails on a guard that does not hold its lock through the mutation', async () => {
    await failsWith(/competing writer landed between the guard's status read and its mutation/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: ({ observed, proceed }) => (async () => { const r = await read(' FOR UPDATE'); observed(); await proceed; await sql(b, guardMark); return r; })() }));
    await failsWith(/terminal invariant does not hold after the interleaving.*closed\+raced\+guard/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: async ({ observed, proceed }) => {
        await b.$transaction(async (t) => { await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE'); observed(); await proceed; }, CTX);
        await sql(b, guardMark);
      } }));
    await assertFreeSoon();
  });

  // ---- reproduce-first: the participant-lifecycle findings that terminated #594 ----

  it('names a contender that crashes BEFORE it can take the lock, instead of misreading the absent lock wait as lock-after-read', async () => {
    await failsWith(/contender failed instead of completing.*connection refused/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: () => Promise.reject(new Error('connection refused')) }));
    await assertFreeSoon();
  });

  it('classifies a holder transaction failure before any lock-order diagnosis, even when the contender escaped', async () => {
    // the holder is monitored AFTER readiness: when its transaction dies while it is meant to hold the
    // lock, the contender unblocks and reports before the probe released — which #594 diagnosed as a
    // lock-after-read (escaped). The monitor names the holder failure first. Here the contender reads
    // without locking (escaped=true) AND the monitor reports the holder dead: the holder wins.
    await failsWith(/holder .*failed after it was ready.*holder connection dropped/u)(() => lockOrderProbe({ ...fixture(),
      holderMonitor: () => Promise.reject(new Error('holder connection dropped')),
      contenderStarted: ({ observed }) => (async () => { const r = await read(''); observed(); return r; })() }));
    await assertFreeSoon();
  });

  it('does not let a leaked contender outlive the probe under a SHORT settle override (cleanup is independent of the verdict)', async () => {
    // a contender that acquires the row after release and hangs, with a settle override far below its
    // transaction lifetime: #594 recorded `stuck`, returned early from cleanup, and left the row
    // locked. Here cleanup waits the contender's full bound regardless of the recorded verdict.
    await failsWith(/ignored its abort signal|still running after the holder/u)(() => lockOrderProbe({ ...fixture(), contenderSettleMs: 300,
      contenderStarted: ({ observed }) => b.$transaction(async (t) => {
        await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE'); observed();
        await new Promise(() => undefined); // holds the lock, ignores cancellation, until its own tx timeout
      }, CTX) }));
    await assertFreeSoon(); // the row is free the moment the probe returns: cleanup waited the contender out
  });

  it('waits out a competitor that acquires the row and then hangs, using the SAME bounds the fixture declares', async () => {
    // the guard behaves, but the COMPETITOR blocks behind it, acquires the row once the guard commits,
    // writes, and then hangs without committing. Its lock lifetime is maxWait + competitorTxMs from
    // when it started; cleanup waits exactly that, computed from the bounds the fixture declares — the
    // defect fixed here is a cleanup deadline that assumed a shorter acquisition than the fixture used.
    await failsWith(/competing writer never landed after the guard finished.*row is still locked/u)(() => lockOrderProbe({ ...fixture(),
      competitor: () => a.$transaction(async (t) => { await t.$executeRawUnsafe("UPDATE _probe_lock SET status = status || '+raced' WHERE id = 1"); await new Promise(() => undefined); }, COMP),
      contenderStarted: guardedContender }));
    await assertFreeSoon(); // the row is free once the probe returns: cleanup waited the competitor's full bound
  });

  it('names a holder abort that fails, and STILL frees the row by awaiting the holder to its declared bound', async () => {
    const stalled = ({ observed, signal }: { observed: () => void; signal: AbortSignal }) => (async () => {
      const r = await Promise.race([read(' FOR UPDATE'), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      observed(); return r;
    })();
    // release() and abort() both throw, so nothing the probe calls rolls the holder back. #594 would
    // have returned with the row still locked. Here the holder was registered as a participant, so
    // cleanup awaits its transaction to maxWait + holderTxMs, by which the database has reclaimed it —
    // no external abort is needed for the row to be free the moment the probe returns.
    await failsWith(/holder's abort failed.*abort connection lost/u)(() => lockOrderProbe({ ...fixture(holder()),
      release: async () => { throw new Error('connection lost'); }, abort: async () => { throw new Error('abort connection lost'); }, contenderStarted: stalled }));
    await assertFreeSoon();
  });

  it('fails, and still frees the row, when the release rejects before unlocking', async () => {
    await failsWith(/holder .*failed after it was ready.*connection lost|holder's release failed.*connection lost/u)(() => lockOrderProbe({ ...fixture(),
      release: async () => { throw new Error('connection lost'); }, contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('force-releases, via its bounded transaction timeout, a contender that holds its lock and ignores cancellation', async () => {
    await failsWith(/ignored its abort signal.*holds no lock|failed instead of completing/u)(() => lockOrderProbe({ ...fixture(),
      contenderStarted: ({ observed, signal }) => b.$transaction(async (t) => {
        await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE'); observed();
        void signal; await new Promise(() => undefined);
      }, CTX) }));
    await assertFreeSoon();
  });

  it('fails, and still frees the row, when the lock inspection itself throws', async () => {
    await failsWith(/lock inspection failed.*connection reset/u)(() => lockOrderProbe({ ...fixture(),
      inspectBlocked: async () => { throw new Error('connection reset'); }, contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('classifies a cooperative hung guard the probe cancelled as a timeout, not a broken-fixture crash', async () => {
    // the guard takes the lock, reports, then hangs but LISTENS to cancellation. When it outlives the
    // settle window the probe aborts it and it rejects with the probe's OWN reason — that is the
    // hung-guard verdict, not "the contender failed instead of completing" (a broken fixture).
    await failsWith(/still running after the holder was released and aborted/u)(() => lockOrderProbe({ ...fixture(), contenderSettleMs: 500,
      contenderStarted: ({ observed, signal }) => b.$transaction(async (t) => {
        await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE'); observed();
        await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }, CTX) }));
    await assertFreeSoon();
  });

  it('names a window-phase inspection that hangs, and still frees the row', async () => {
    // the initial inspection succeeds so the probe proceeds; the SECOND inspection (inside the guard's
    // window) hangs. It is bounded by the same ceiling and named as a window inspection failure, rather
    // than parking the contender on `proceed` and hanging the probe past cleanup.
    let calls = 0;
    await failsWith(/lock inspection failed during the guard's window.*did not settle/u)(() => lockOrderProbe({ ...fixture(),
      inspectBlocked: () => { calls += 1; return calls === 1 ? inspectBlocked() : new Promise<boolean>(() => undefined); },
      contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('bounds a terminal verification that never settles at all (no transaction to roll it back)', async () => {
    // verify() never settles and never rejects — a fixture that ignores the bounded-transaction
    // contract. The probe still names the timeout via its own bound and aborts the verify signal,
    // rather than reaching Vitest's generic timeout with the call outstanding.
    await failsWith(/terminal invariant check did not settle/u)(() => lockOrderProbe({ ...fixture(),
      verify: (signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('reclaims a terminal verification whose bounded read hangs, freeing the row before it returns', async () => {
    // the REAL database consequence a fake promise cannot exercise: verify()'s read acquires the row and
    // then hangs. Because it honors the contract and runs inside a BOUNDED transaction, the database
    // rolls it back at the transaction timeout; the probe registers verify as a participant and drains
    // it in cleanup, so its lock does not outlive the probe — the row is free the moment it returns.
    await failsWith(/terminal invariant (does not hold|check did not settle)/u)(() => lockOrderProbe({ ...fixture(),
      verify: () => a.$transaction(async (t) => {
        await (t as unknown as { $queryRawUnsafe: (s: string) => Promise<unknown> }).$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
        await new Promise<never>(() => undefined); // hangs holding the row lock; the bounded tx rolls it back
      }, { timeout: L.verifyTxMs, maxWait: L.maxWaitMs }),
      contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('classifies a lock-free read that returns after release begins but before the holder commits as escaped', async () => {
    // a DELAYED lock-free guard: its plain SELECT (no FOR UPDATE, never seen waiting) returns during the
    // release WINDOW — after the probe began releasing but before the holder actually committed. The read
    // happened while the holder still held its lock, so it is a lock-after-read, not a legitimate
    // post-release read. `releaseCompleted` + `blockedSeen` catch it where a bare `released` flag did not.
    const h = holder();
    let readNow!: () => void;
    const readGate = new Promise<void>((r) => { readNow = r; });
    await failsWith(/lock-after-read|status read before the holder released/u)(() => lockOrderProbe({ ...fixture(h),
      // release() lets the lock-free contender read while the holder still holds, gives it a beat to
      // report, THEN actually releases the holder — landing the read squarely inside the release window.
      release: async () => { readNow(); await new Promise((r) => setTimeout(r, 250)); await h.release(); },
      contenderStarted: ({ observed }) => (async () => { await readGate; const r = await read(''); observed(); return r; })() }));
    await assertFreeSoon();
  });

  it('names a release that never settles, and still frees the row', async () => {
    // release() neither resolves nor rejects. It must not block settle()/finalize() and hand the test to
    // Vitest's generic timeout: the probe bounds it, names it as a holder failure, aborts the holder, and
    // finalize awaits the holder to its declared bound so the row is free when the probe returns.
    await failsWith(/holder .*failed after it was ready.*release did not settle/u)(() => lockOrderProbe({ ...fixture(),
      release: () => new Promise<void>(() => undefined), contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('names an abort that never settles even when release also hangs, and still frees the row via the holder bound', async () => {
    // both control callbacks hang. finalize still returns: abortHolder() is bounded, and the holder is a
    // registered participant awaited to maxWait+holderTxMs, by which the database has rolled its own
    // transaction back at its timeout — no external release or abort is needed for the row to be free.
    await failsWith(/release did not settle|abort did not settle|holder's abort failed/u)(() => lockOrderProbe({ ...fixture(),
      release: () => new Promise<void>(() => undefined), abort: () => new Promise<void>(() => undefined),
      contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('names, rather than masks, a window it cannot inspect within the remaining contender transaction', async () => {
    // the residual the round-4 window-ceiling floor could still admit: the initial inspection is slow
    // enough that by the time the guard reports, almost none of its transaction lifetime remains. The
    // window ceiling is now bounded STRICTLY below that remainder (never a floor that exceeds it), so the
    // probe NAMES the window it cannot fit rather than running an inspection that outlasts the guard's
    // own lock and lets a competitor landing on the imminent rollback be misread.
    let calls = 0;
    await failsWith(/lock inspection failed during the guard's window.*insufficient remaining contender transaction lifetime/u)(() => lockOrderProbe({ ...fixture(),
      inspectBlocked: () => { calls += 1; return calls === 1
        ? (async () => { const r = await inspectBlocked(); await new Promise((res) => setTimeout(res, L.contenderTxMs - 2_000)); return r; })()
        : inspectBlocked(); },
      contenderStarted: guardedContender }));
    await assertFreeSoon();
  });

  it('rejects a fixture that does not own its holder transaction (no holderMonitor)', async () => {
    // without a holderMonitor the probe cannot register the holder, so a failing abort() would leave the
    // row locked; the probe refuses the configuration up front and still aborts the started holder.
    await failsWith(/requires a holderMonitor/u)(() => lockOrderProbe({ ...fixture(),
      holderMonitor: undefined as unknown as () => Promise<unknown>, contenderStarted: guardedContender }));
    await assertFreeSoon();
  });
});
