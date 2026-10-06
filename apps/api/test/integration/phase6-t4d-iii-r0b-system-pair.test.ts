import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, insertRawEvent, rawDeliveryRowsSql, type TwoProjectFixture } from './fixtures';
import { newInstanceId, writeLease } from '../../src/platform/release-lease.service';
import { effectCoverageVersion } from '../../src/platform/external-effects';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { splitSqlForReplay } from './phase6-t4c-migration-replay';

/**
 * Phase 6 task 4d-iii / R0b — the system pair admitted, and the lease's server generation recorded and
 * frozen (`docs/superpowers/plans/2026-10-05-4d-iii-additive-units.md`, R0's proofs, the R0b bullet),
 * proven against live PostgreSQL and `20280107000000_phase6_t4d_iii_r0b_system_pair`.
 *
 * The event probes write DIRECTLY (`insertRawEvent`, a hand-run writer the seals judge exactly as they
 * judge the emitter): `emitEvent` refuses an envelope on a system actor until R0c makes it write one. The
 * lease probes run in transactions that roll back, because a committed lease is permanent
 * (`ReleaseLease_t4d_frozen` refuses DELETE).
 */
const MIGRATION = '20280107000000_phase6_t4d_iii_r0b_system_pair';
const API = join(__dirname, '..', '..');

describe('4d-iii / R0b — the system pair and the lease generation (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(
      `SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId,
    ))[0]!.displayName;

  /** A raw event on projectA with the given envelope; resolves to its id, or rejects with the seal's error. */
  const plant = async (
    actor: { actorKind: 'human'; actorId: string } | { actorKind: 'system'; systemActor: string },
    pair: { role: string; name: string } | null,
  ): Promise<string> => {
    const eventId = randomUUID();
    await insertRawEvent(t.prisma, {
      projectId: f.projectA.id, organizationId: f.orgA.id, eventId, actor,
      ...(pair ? { columns: ['"actorRole"', '"actorName"'], values: [`'${pair.role}'`, `'${pair.name.replace(/'/g, "''")}'`] } : {}),
    });
    return eventId;
  };

  const pairOf = (eventId: string) => t.prisma.domainEvent.findUniqueOrThrow({
    where: { eventId }, select: { actorKind: true, actorId: true, systemActor: true, actorRole: true, actorName: true },
  });

  // ── the system pair ──────────────────────────────────────────────────────────────────────────

  it('a SYSTEM envelope — actorId NULL, the system role and a registered automation name — commits', async () => {
    for (const name of ['decisions-effects', 'commercial-activation', 'commercial-reevaluate']) {
      const id = await plant({ actorKind: 'system', systemActor: `system:${name}` }, { role: 'system', name });
      expect(await pairOf(id)).toMatchObject({ actorKind: 'system', actorId: null, actorRole: 'system', actorName: name });
    }
  });

  it('the pair names the AUTOMATION, systemActor its trigger: an operator’s user id as systemActor commits beside a registered name', async () => {
    const id = await plant({ actorKind: 'system', systemActor: f.memberUser.id }, { role: 'system', name: 'commercial-reevaluate' });
    expect(await pairOf(id)).toMatchObject({ systemActor: f.memberUser.id, actorRole: 'system', actorName: 'commercial-reevaluate' });
  });

  it('a system envelope with an UNREGISTERED name is refused — an operator’s id, an operator’s display name, an unknown automation', async () => {
    for (const name of [f.memberUser.id, await identityName(f.memberUser.id), 'nightly-cleanup']) {
      await expect(plant({ actorKind: 'system', systemActor: f.memberUser.id }, { role: 'system', name }))
        .rejects.toThrow(/registered automation/);
    }
  });

  it('a system envelope with a BLANK name is refused, and so is one with a blank systemActor', async () => {
    await expect(plant({ actorKind: 'system', systemActor: 'system:decisions-effects' }, { role: 'system', name: '  ' }))
      .rejects.toThrow(/BLANK actor envelope/);
    await expect(plant({ actorKind: 'system', systemActor: '  ' }, { role: 'system', name: 'decisions-effects' }))
      .rejects.toThrow(/registered automation/);
  });

  it('a system event carrying a HUMAN role is refused, even with a registered name', async () => {
    await expect(plant({ actorKind: 'system', systemActor: 'system:decisions-effects' }, { role: 'pmc', name: 'decisions-effects' }))
      .rejects.toThrow(/registered automation/);
  });

  it('the system pair on a HUMAN actor is refused: a human envelope is still judged by phase6_t4d_actor_pair_true', async () => {
    await expect(plant({ actorKind: 'human', actorId: f.memberUser.id }, { role: 'system', name: 'decisions-effects' }))
      .rejects.toThrow();
    const n = await t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, actorKind: 'human', actorRole: 'system' } });
    expect(n).toBe(0);
  });

  it('a HUMAN pair is judged exactly as before: the true pair commits, a false name or a role not held is refused', async () => {
    const name = await identityName(f.memberUser.id);
    const id = await plant({ actorKind: 'human', actorId: f.memberUser.id }, { role: 'pmc', name });
    expect(await pairOf(id)).toMatchObject({ actorKind: 'human', actorId: f.memberUser.id, actorRole: 'pmc', actorName: name });
    await expect(plant({ actorKind: 'human', actorId: f.memberUser.id }, { role: 'pmc', name: 'Somebody Else' })).rejects.toThrow();
    await expect(plant({ actorKind: 'human', actorId: f.clientUser.id }, { role: 'pmc', name: await identityName(f.clientUser.id) })).rejects.toThrow();
  });

  it('a HUMAN envelope with actorId NULL is still refused', async () => {
    const eventId = randomUUID();
    const intent = JSON.stringify({ effectKey: 'decision.drafted', coverageVersion: effectCoverageVersion(), invalidate: false });
    await expect(t.prisma.$transaction(async (tx) => {
      const [{ at }] = await tx.$queryRawUnsafe<Array<{ at: bigint }>>(
        `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = $1 RETURNING "nextPosition" - 1 AS "at"`,
        f.projectA.id);
      await tx.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","actorId","entityType","entityId","dispatchIntent","actorRole","actorName")
         VALUES ($1,'decision.drafted',1,$2,$3,$4,'human',NULL,NULL,'Decision','x',$5::jsonb,'pmc',$6)`,
        eventId, f.orgA.id, f.projectA.id, at, intent, await identityName(f.memberUser.id));
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(eventId));
    })).rejects.toThrow(/no `actorId`/);
  });

  it('a pairless system event still commits: the delivered emitter writes none until R0c (proven at the emitter by the A1 and R0a-2 suites)', async () => {
    const sys = await plant({ actorKind: 'system', systemActor: 'system:seed' }, null);
    expect(await pairOf(sys)).toMatchObject({ actorKind: 'system', actorRole: null, actorName: null });
  });

  // ── the lease's server generation ────────────────────────────────────────────────────────────

  const ROLLBACK = new Error('rolled back on purpose');
  const inRolledBack = async (body: (tx: Prisma.TransactionClient) => Promise<void>) => {
    await t.prisma.$transaction(async (tx) => { await body(tx); throw ROLLBACK; })
      .catch((e) => { if (e !== ROLLBACK) throw e; });
  };

  it('ReleaseLease.serverGeneration is present and nullable, and the delivered writeLease still commits with it NULL', async () => {
    const col = await t.prisma.$queryRawUnsafe<Array<{ data_type: string; is_nullable: string }>>(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'ReleaseLease' AND column_name = 'serverGeneration'`);
    expect(col).toEqual([{ data_type: 'integer', is_nullable: 'YES' }]);
    await inRolledBack(async (tx) => {
      const instanceId = newInstanceId();
      await writeLease(tx, { instanceId, catalogVersion: 3, release: 'r0b-probe' });
      const [row] = await tx.$queryRawUnsafe<Array<{ g: number | null }>>(`SELECT "serverGeneration" AS g FROM "ReleaseLease" WHERE "instanceId" = $1`, instanceId);
      expect(row!.g).toBeNull();
    });
  });

  it('a lease’s serverGeneration is FROZEN: NULL → 3 and 2 → 3 are refused, and the renewal still moves leaseUntil', async () => {
    // the probe ends in ROLLBACK whatever happens, so on a database WITHOUT the freeze it fails rather
    // than committing a lease: a committed lease is permanent and would poison every later lease probe
    const restamp = (from: number | null) => t.prisma.$transaction(async (tx) => {
      const instanceId = newInstanceId();
      await tx.$executeRawUnsafe(
        `INSERT INTO "ReleaseLease" ("instanceId","catalogVersion","release","startedAt","leaseUntil","serverGeneration")
         VALUES ($1, 3, 'r0b-probe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '60 seconds', $2)`, instanceId, from);
      await tx.$executeRawUnsafe(`UPDATE "ReleaseLease" SET "serverGeneration" = 3 WHERE "instanceId" = $1`, instanceId);
      throw ROLLBACK;
    });
    await expect(restamp(null)).rejects.toThrow(/FROZEN/);
    await expect(restamp(2)).rejects.toThrow(/FROZEN/);
    await inRolledBack(async (tx) => {
      const instanceId = newInstanceId();
      await tx.$executeRawUnsafe(
        `INSERT INTO "ReleaseLease" ("instanceId","catalogVersion","release","startedAt","leaseUntil","serverGeneration")
         VALUES ($1, 3, 'r0b-probe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '60 seconds', 3)`, instanceId);
      expect(await tx.$executeRawUnsafe(`UPDATE "ReleaseLease" SET "leaseUntil" = "leaseUntil" + interval '60 seconds' WHERE "instanceId" = $1`, instanceId)).toBe(1);
    });
  });

  // ── re-runnable, and registered ──────────────────────────────────────────────────────────────

  it('the migration is on ALWAYS_EXECUTE after 4d-i, and a replay of the shipped file commits and leaves both arms in place', async () => {
    const sh = readFileSync(join(API, 'scripts/migrate.sh'), 'utf8');
    const list = /ALWAYS_EXECUTE="([^"]+)"/u.exec(sh)![1]!.split('\n').map((s) => s.trim());
    expect(list).toContain(MIGRATION);
    expect(list.indexOf(MIGRATION)).toBeGreaterThan(list.indexOf('20271220000000_phase6_t4d_i_dark_migration'));

    const sql = readFileSync(join(API, 'prisma/migrations', MIGRATION, 'migration.sql'), 'utf8');
    await t.prisma.$transaction(async (tx) => { for (const stmt of splitSqlForReplay(sql)) await tx.$executeRawUnsafe(stmt); });
    const id = await plant({ actorKind: 'system', systemActor: 'system:decisions-effects' }, { role: 'system', name: 'decisions-effects' });
    expect(await pairOf(id)).toMatchObject({ actorRole: 'system', actorName: 'decisions-effects' });
    await expect(t.prisma.$transaction(async (tx) => {
      const instanceId = newInstanceId();
      await writeLease(tx, { instanceId, catalogVersion: 3, release: 'r0b-replay' });
      await tx.$executeRawUnsafe(`UPDATE "ReleaseLease" SET "serverGeneration" = 3 WHERE "instanceId" = $1`, instanceId);
      throw ROLLBACK; // never commits a lease, whatever the database carries
    })).rejects.toThrow(/FROZEN/);
  });
});
