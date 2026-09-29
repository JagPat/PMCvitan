import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERVER_GENERATION, SERVER_GENERATION_MIGRATION, assertServerGenerationAdmitted, holdAdmission, judgeServerGeneration, readServerMinimum,
} from './server-generation';

/**
 * 4d-ii-a / A6e — the server-generation fence outside the database: the judgement, the compiled
 * constant pinned to the migration's literal, and the startup assertion's fail-closed shape. The live
 * seals are proven in `phase6-t4d-ii-a6e-generation-fence.test.ts`.
 */
describe('the server-generation fence (4d-ii-a / A6e)', () => {
  const minimum = (minimumGeneration: number) => ({ minimumGeneration, raisedBy: 'm', raisedAt: new Date('2026-01-01T00:00:00Z') });

  it('the migration writes exactly the generation this build compiles, so nothing running is refused by its own release', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', SERVER_GENERATION_MIGRATION, 'migration.sql'), 'utf8');
    const literal = sql.match(/VALUES \('singleton', (\d+), '([^']+)', CURRENT_TIMESTAMP\)/);
    expect(literal, 'the raise statement names the generation and the migration').not.toBeNull();
    expect(Number(literal![1])).toBe(SERVER_GENERATION);
    expect(literal![2]).toBe(SERVER_GENERATION_MIGRATION);
    // and the raise is GREATEST: a re-run after a later raise cannot lower it
    expect(sql).toMatch(/GREATEST\("ServerGeneration"\."minimumGeneration", EXCLUDED\."minimumGeneration"\)/);
    // and the raise records its own provenance on an actual raise only (#663 round 1, finding 1)
    expect(sql).toMatch(/"raisedBy" = CASE WHEN EXCLUDED\."minimumGeneration" > "ServerGeneration"\."minimumGeneration"\s+THEN EXCLUDED\."raisedBy" ELSE "ServerGeneration"\."raisedBy" END/);
  });

  it('judges: admitted at or above the minimum, refused below it, refused on no row', () => {
    expect(judgeServerGeneration(1, minimum(1))).toMatchObject({ admitted: true });
    expect(judgeServerGeneration(3, minimum(1))).toMatchObject({ admitted: true });
    const below = judgeServerGeneration(1, minimum(2));
    expect(below).toMatchObject({ admitted: false });
    expect((below as { reason: string }).reason).toMatch(/generation 1, below the persisted minimum 2 raised by m/);
    const none = judgeServerGeneration(1, null);
    expect(none).toMatchObject({ admitted: false });
    expect((none as { reason: string }).reason).toContain(SERVER_GENERATION_MIGRATION);
  });

  it('the startup assertion reads the singleton row, logs the admission, and throws on a refusal', async () => {
    const log = { log: vi.fn() };
    const rows = [{ minimumGeneration: 1, raisedBy: 'm', raisedAt: new Date() }];
    const db = { $queryRaw: vi.fn(async () => rows) };
    await expect(assertServerGenerationAdmitted(db as never, log, 1)).resolves.toMatchObject({ minimumGeneration: 1 });
    // the admission read LOCKS the row: the bootstrap holds it until the process serves (#663 round 1, finding 2)
    expect((db.$queryRaw.mock.calls[0]![0] as unknown as { sql: string }).sql).toMatch(/FROM "ServerGeneration" WHERE "key" = 'singleton' FOR SHARE/);
    const plain = { $queryRaw: vi.fn(async () => rows) };
    await readServerMinimum(plain as never);
    expect((plain.$queryRaw.mock.calls[0]![0] as unknown as { sql: string }).sql).not.toMatch(/FOR SHARE/);
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/server generation 1 admitted \(persisted minimum 1/));
    rows[0]!.minimumGeneration = 5;
    await expect(assertServerGenerationAdmitted(db as never, log, 1)).rejects.toThrow(/server-generation fence: this build compiles server generation 1, below the persisted minimum 5/);
    expect(await readServerMinimum({ $queryRaw: async () => [] } as never)).toBeNull();
    await expect(assertServerGenerationAdmitted({ $queryRaw: async () => [] } as never, log, 1)).rejects.toThrow(/no persisted server-generation minimum/);
  });

  it('holdAdmission keeps the admission transaction open past the serving steps until released, and rejects on a refusal or a failed serve (#663 round 2, finding 1)', async () => {
    const rows = [{ minimumGeneration: 1, raisedBy: 'm', raisedAt: new Date() }];
    let txSettled = false;
    const db = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        try { return await fn({ $queryRaw: async () => rows }); } finally { txSettled = true; }
      }),
    };
    const order: string[] = [];
    const lost = vi.fn<(reason: string) => void>();
    const hold = holdAdmission(db as never, async (minimum) => { order.push(`serve@${minimum.minimumGeneration}`); }, { log: { log: (m) => order.push(m) }, compiled: 1, onLost: lost });
    await expect(hold.admitted).resolves.toMatchObject({ minimumGeneration: 1 });
    expect(order).toEqual([expect.stringMatching(/server generation 1 admitted/), 'serve@1']);
    // admitted and served, yet the transaction is still open: the lock outlives the hook
    await new Promise((r) => setTimeout(r, 10));
    expect(txSettled).toBe(false);
    hold.release();
    hold.release(); // idempotent
    await hold.ended;
    expect(txSettled).toBe(true);
    expect(lost).not.toHaveBeenCalled();
    expect(db.$transaction.mock.calls[0]![1]).toMatchObject({ timeout: 600_000, maxWait: 600_000 });

    // a refusal: serve never runs, the transaction is rolled back, `admitted` rejects
    rows[0]!.minimumGeneration = 2;
    const serve = vi.fn(async () => {});
    const refused = holdAdmission(db as never, serve, { compiled: 1, onLost: lost });
    await expect(refused.admitted).rejects.toThrow(/below the persisted minimum 2/);
    await refused.ended;
    expect(serve).not.toHaveBeenCalled();

    // a serve that throws: `admitted` rejects with its error and the transaction ends
    rows[0]!.minimumGeneration = 1;
    const failing = holdAdmission(db as never, async () => { throw new Error('sender gate refused'); }, { compiled: 1, onLost: lost });
    await expect(failing.admitted).rejects.toThrow(/sender gate refused/);
    await failing.ended;
    expect(lost).not.toHaveBeenCalled();
  });

  it('a hold that ENDS after admission and before release is a LOST admission: the process is fenced, never left to serve (#663 round 3, finding 1)', async () => {
    const rows = [{ minimumGeneration: 1, raisedBy: 'm', raisedAt: new Date() }];
    // the transaction ends on its own (the bounded timeout, a closed connection) while the callback still waits for the release
    let closeTx!: (e: Error) => void;
    const db = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => new Promise((_resolve, reject) => {
        closeTx = reject;
        // the callback's own rollback throw (a lost hold) is Prisma's to swallow in the real client
        fn({ $queryRaw: async () => rows }).catch(() => {});
      })),
    };
    const errors: string[] = [];
    const lost = vi.fn<(reason: string) => void>();
    const hold = holdAdmission(db as never, async () => {}, { compiled: 1, onLost: lost, log: { log: () => {}, error: (m) => errors.push(m) } });
    await expect(hold.admitted).resolves.toMatchObject({ minimumGeneration: 1 });
    closeTx(new Error('Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction'));
    await hold.ended;
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0]![0]).toMatch(/admission was lost before this process served: .*expired transaction/);
    expect(errors[0]).toMatch(/^FENCED — the server-generation admission was lost/);

    // released first, then the transaction ends: the process is serving and the lock was let go on purpose
    const releasedFirst = holdAdmission(db as never, async () => {}, { compiled: 1, onLost: lost });
    await releasedFirst.admitted;
    releasedFirst.release();
    closeTx(new Error('closed after release'));
    await releasedFirst.ended;
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
