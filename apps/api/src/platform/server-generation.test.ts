import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERVER_GENERATION, SERVER_GENERATION_MIGRATION, assertServerGenerationAdmitted, judgeServerGeneration, readServerMinimum,
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
});
