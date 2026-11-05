import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { liveArchitectStanding } from './live-standing';

// Redbracket ID A4b r1 (Codex 4451627333) — the architect's live standing drops a retired holder, as every other role's does
function kernel(count: number, holders: string[], retired: string[]): Prisma.TransactionClient {
  return {
    $queryRawUnsafe: async (sql: string) =>
      sql.includes('platform_role_standing') ? [{ n: count }] : holders.map((userId) => ({ userId })),
    identityRetirement: { count: async ({ where }: { where: { userId: string } }) => (retired.includes(where.userId) ? 1 : 0) },
  } as unknown as Prisma.TransactionClient;
}

describe('liveArchitectStanding', () => {
  it('counts only the architects someone can still act as', async () => {
    expect(await liveArchitectStanding(kernel(2, ['a', 'b'], []), 'p')).toBe(2);
    expect(await liveArchitectStanding(kernel(2, ['a', 'b'], ['b']), 'p')).toBe(1);
    expect(await liveArchitectStanding(kernel(1, ['b'], ['b']), 'p')).toBe(0);
    expect(await liveArchitectStanding(kernel(0, [], []), 'p')).toBe(0);
  });
  it('fails closed when the count and the holder list disagree', async () => {
    expect(await liveArchitectStanding(kernel(1, ['a', 'b'], []), 'p')).toBe(1);
    expect(await liveArchitectStanding(kernel(3, ['a'], []), 'p')).toBe(1);
  });
});
