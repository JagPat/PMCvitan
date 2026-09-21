// The participant lifecycle owner (reform-1b, layer α) against REAL PostgreSQL. Each test drives the
// owner directly — no lock-order verdict logic — and proves ONE lifetime guarantee by constructing the
// exact situation that, without the guarantee, would leave a lock held past the probe's return. Scratch
// table only; two real sessions interleave on _probe_lock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_LIFETIMES, TEST_TIMEOUT_MS, ProbeFailure, createLifecycle, lockBound, worstCase,
} from '../invariants/lock-lifecycle';

const a = new PrismaClient(); // holder session A
const b = new PrismaClient(); // contender/competitor session B
const sql = (client: PrismaClient, text: string) => client.$executeRawUnsafe(text);

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

describe('lockLifecycle', () => {
  // this unit's honest worst case exceeds a bare 30s; pin the file to the probe's declared bound.
  vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });
  beforeEach(() => sql(a, "UPDATE _probe_lock SET status = 'open' WHERE id = 1"));
  const L = DEFAULT_LIFETIMES;
  const settleMs = L.maxWaitMs + L.contenderTxMs + 2_000;

  const tx = (client: PrismaClient, txMs: number) => ({ timeout: txMs, maxWait: L.maxWaitMs });
  /** locks the row FOR UPDATE inside a bounded transaction, then IGNORES cancellation until the database
   * rolls the transaction back at its own timeout — the leak a naive cleanup would let outlive the probe. */
  const stubborn = (client: PrismaClient, txMs: number) => (_signal: AbortSignal) => client.$transaction(async (t) => {
    await (t as unknown as { $queryRawUnsafe: (s: string) => Promise<unknown> }).$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
    await new Promise<never>(() => undefined);
  }, tx(client, txMs));
  /** locks the row, then releases (rolls back) the instant the shared cancel signal fires */
  const cooperative = (client: PrismaClient, txMs: number) => (signal: AbortSignal) => client.$transaction(async (t) => {
    await (t as unknown as { $queryRawUnsafe: (s: string) => Promise<unknown> }).$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
    await new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, tx(client, txMs));

  /** poll until some OTHER session holds the row (checker's FOR UPDATE NOWAIT fails with 55P03) */
  const heldFrom = async (checker: PrismaClient) => {
    for (let i = 0; i < 200; i += 1) {
      try { await checker.$queryRawUnsafe('SELECT 1 FROM _probe_lock WHERE id = 1 FOR UPDATE NOWAIT'); }
      catch (error) { if (/55P03|could not obtain lock/u.test(String((error as Error).message))) return; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the row was never held');
  };
  /** the row is lockable once the drained operation rolled back; a row that stays locked is a real failure */
  const assertFreeSoon = async (checker: PrismaClient = b) => {
    for (let i = 0; i < 260; i += 1) {
      try { await checker.$queryRawUnsafe('SELECT 1 FROM _probe_lock WHERE id = 1 FOR UPDATE NOWAIT'); return; } catch (error) {
        if (!/55P03|could not obtain lock/u.test(String((error as Error).message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await checker.$queryRawUnsafe('SELECT 1 FROM _probe_lock WHERE id = 1 FOR UPDATE NOWAIT');
  };

  it('budgets its worst case under the per-test timeout and refuses bounds that cannot fit', () => {
    expect(worstCase(L, settleMs)).toBeLessThan(TEST_TIMEOUT_MS);
    const lc = createLifecycle({ ...L, competitorTxMs: 60_000 });
    expect(() => lc.assertBudget(settleMs)).toThrow(ProbeFailure);
    expect(() => lc.assertBudget(settleMs)).toThrow(/does not fit under the .* per-test timeout/u);
  });

  it('refuses an unfit configuration through the barrier, still draining a holder it was already given', async () => {
    const lc = createLifecycle({ ...L, competitorTxMs: 60_000 });
    const holder = lc.start('holder', stubborn(a, L.holderTxMs), L.holderTxMs);
    expect(holder.started).toBe(true);
    await heldFrom(b);
    // the caller's budget check fails, but the holder it already started must be drained, not abandoned.
    expect(() => lc.assertBudget(settleMs)).toThrow(/does not fit/u);
    await lc.finalize();
    await assertFreeSoon(b);
  });

  it('drains a started operation that acquires the row and ignores cancellation, to its declared lock bound', async () => {
    // the leak #594 left: a task that took the row and hung was recorded and then left. Here finalize
    // awaits it to maxWait+contenderTxMs, by which the database rolled its transaction back — the row is
    // free the moment finalize returns, regardless of any verdict the consumer might have reached first.
    const lc = createLifecycle(L);
    const op = lc.start('contender', stubborn(b, L.contenderTxMs), L.contenderTxMs);
    await heldFrom(a);
    lc.cancel(new Error('cancelled')); // the operation ignores it; only its tx timeout frees the row
    expect(lockBound(op.startedAt, op.txMs, L)).toBeGreaterThan(0);
    await lc.finalize();
    await assertFreeSoon(a);
  });

  it('starts no new operation once closed: a late competitor never opens a database operation', async () => {
    // close-before-drain: a late caller that ignored cancellation must not be able to open a fresh
    // operation that would take a lock after the drain loop already passed.
    const lc = createLifecycle(L);
    lc.close();
    let invoked = false;
    const late = lc.start('competitor', async () => { invoked = true; await sql(b, "UPDATE _probe_lock SET status = status || '+late' WHERE id = 1"); }, L.competitorTxMs);
    expect(late.started).toBe(false);
    expect(invoked).toBe(false);
    await lc.finalize();
    await assertFreeSoon(b);
    expect((await b.$queryRawUnsafe<{ status: string }[]>('SELECT status FROM _probe_lock WHERE id = 1'))[0]!.status).toBe('open');
  });

  it('bounds a control that never settles, and still drains the holder to its bound', async () => {
    // a release() that neither resolves nor rejects must not stall the barrier: control() names the
    // timeout and finalize still awaits the holder out.
    const lc = createLifecycle(L);
    lc.start('holder', stubborn(a, L.holderTxMs), L.holderTxMs);
    await heldFrom(b);
    const failure = await lc.control(() => new Promise<void>(() => undefined), 'release');
    expect(failure?.message).toMatch(/release did not settle within \d+ms/u);
    await lc.finalize();
    await assertFreeSoon(b);
  });

  it('records a cleanup control that fails and still awaits the holder to its declared bound', async () => {
    // release() and abort() both fail, so nothing the owner calls rolls the holder back. Because the
    // holder is a registered participant, finalize awaits it to maxWait+holderTxMs — no external abort is
    // needed for the row to be free the moment finalize returns.
    const lc = createLifecycle(L);
    lc.start('holder', stubborn(a, L.holderTxMs), L.holderTxMs);
    await heldFrom(b);
    lc.onClose(async () => { throw new Error('abort connection lost'); }, 'abort');
    await lc.finalize();
    expect(lc.closerFailure('abort')?.message).toMatch(/abort connection lost/u);
    await assertFreeSoon(b);
  });

  it('cancels a cooperative operation through the shared signal and drains it', async () => {
    // every started operation is handed the shared cancel signal; a cooperative one releases at once.
    const lc = createLifecycle(L);
    const op = lc.start('contender', cooperative(b, L.contenderTxMs), L.contenderTxMs);
    await heldFrom(a);
    lc.cancel(new Error('cancelled by test'));
    const settled = await op.result.then(() => 'ok', (e: unknown) => String((e as Error)?.message ?? e));
    expect(settled).toMatch(/cancelled by test/u);
    await lc.finalize();
    await assertFreeSoon(a);
  });
});
