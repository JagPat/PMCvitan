import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOMATION_IDENTITIES, isSystemEnvelope, resolveActorEnvelope, systemEnvelope } from './actor-envelope';
import type { Prisma } from '@prisma/client';

/**
 * Phase 6 task 4d-iii / R0c — the TypeScript set of registered automations is the database's. The
 * seal admits a `system` pair only when `platform_t4d_automation_identity(name)` is true, so a name
 * this side lists that the LATEST migration issuing the function does not would be refused at the
 * INSERT, and a name only the function lists is one no emitter can write.
 */
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

function latestRegisteredSet(): string[] {
  const issued = readdirSync(MIGRATIONS).sort()
    .map((dir) => {
      try { return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'); } catch { return ''; }
    })
    .map((sql) => /CREATE OR REPLACE FUNCTION platform_t4d_automation_identity\(p_name TEXT\)[\s\S]*?SELECT p_name IN \(([^)]*)\)/u.exec(sql))
    .filter((m): m is RegExpExecArray => m !== null);
  expect(issued.length).toBeGreaterThan(0);
  return [...issued.at(-1)![1]!.matchAll(/'([^']+)'/gu)].map((m) => m[1]!);
}

describe('the registered automation identities (4d-iii / R0c)', () => {
  it('equal the set the latest migration issues for platform_t4d_automation_identity', () => {
    expect([...AUTOMATION_IDENTITIES].sort()).toEqual(latestRegisteredSet().sort());
  });

  it('a system pair is the system role and a registered name, and nothing else', () => {
    for (const name of AUTOMATION_IDENTITIES) expect(isSystemEnvelope(systemEnvelope(name))).toBe(true);
    expect(isSystemEnvelope({ actorRole: 'system', actorName: 'membership-standing' })).toBe(false);
    expect(isSystemEnvelope({ actorRole: 'pmc', actorName: 'decisions-effects' })).toBe(false);
  });

  it('a system actor resolves its automation’s pair without reading a register, and no pair without one', async () => {
    const tx = { $queryRaw: () => { throw new Error('a system actor reads no register'); } } as unknown as Prisma.TransactionClient;
    await expect(resolveActorEnvelope(tx, 'p', { actorId: 'u1', actorKind: 'system', actorRole: 'pmc', automation: 'commercial-activation' }))
      .resolves.toEqual({ actorRole: 'system', actorName: 'commercial-activation' });
    await expect(resolveActorEnvelope(tx, 'p', { actorId: 'system:x', actorKind: 'system', actorRole: 'system' })).resolves.toBeNull();
    await expect(resolveActorEnvelope(tx, 'p', { actorId: 'u1', actorKind: 'system', actorRole: 'system', automation: 'nope' as never }))
      .rejects.toThrow(/not a registered automation/);
  });
});
