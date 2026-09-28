import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerConsumer, syncConsumerCatalog, unregisterConsumer, type OutboxConsumer } from '../../src/platform/outbox/registry';
import { OutboxConsumerActivationService, ConsumerActivationConflictError } from '../../src/platform/outbox/consumer-activation.service';
import { sanctionedConsumerRemoval } from '../../prisma/sanctioned-reset';
import type { PrismaService } from '../../src/prisma.service';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6b — the MIRROR'S SOLE WRITER and the OPERATOR PROTOCOL, against
 * live PostgreSQL (the companion document's P-A2, P-A3, P-A4, P-A5, P-A6's freeze arms, P-A9, P-A10
 * and P-A11).
 *
 * The register's committed state is touched only through the protocol on consumers this suite
 * registers, which leave through the row-scoped sanctioned seam; every hostile statement runs under
 * a SAVEPOINT on a rolled-back transaction.
 */
describe('4d-ii-a / A6b — the mirror freeze and the outbox:consumer protocol (live PG)', () => {
  let prisma: PrismaClient;
  let activation: OutboxConsumerActivationService;
  const MIGRATION = '20271229000000_phase6_t4d_ii_a6b_activation_rules';
  const A6A = '20271228000000_phase6_t4d_ii_a6a_activation_register';
  const C = 'test.a6b.protocol';
  const SENTINEL = new Error('rollback');
  type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
  const consumer = (name: string): OutboxConsumer => ({
    name, kind: 'unordered', effect: 'external', catalogVersion: 1, dispatchRule: { kind: 'types', eventTypes: [] },
    handle: async () => {},
  });

  const rolledBack = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
    let thrown: unknown = null;
    await prisma.$transaction(async (tx) => {
      try { await body(tx); } catch (e) { thrown = e; }
      throw SENTINEL;
    }, { timeout: 30_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    if (thrown) throw thrown;
  };
  let savepoints = 0;
  const attempt = async (tx: Tx, sql: string, ...params: unknown[]): Promise<string | null> => {
    const sp = `a6b_${++savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await tx.$executeRawUnsafe(sql, ...params);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return null;
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      return e instanceof Error ? e.message : String(e);
    }
  };
  const mirror = async (client: Tx | PrismaClient, name = C) => client.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer: name }, select: { active: true, activationSeq: true } });
  const facts = async (client: Tx | PrismaClient, name = C) => client.outboxConsumerActivation.findMany({ where: { consumer: name }, orderBy: { seq: 'asc' } });
  const ask = (over: Partial<{ consumer: string; active: boolean; reason: string; actorId: string; requestToken: string }>) =>
    activation.request({ consumer: C, active: false, reason: 'probe', actorId: 'op-a', requestToken: randomUUID(), ...over });

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    // the service over a bare client: it needs nothing of the application but the database
    activation = new OutboxConsumerActivationService(prisma as unknown as PrismaService);
    await sanctionedConsumerRemoval(prisma, [C]);
    registerConsumer(consumer(C));
    await syncConsumerCatalog(prisma);
  });

  afterAll(async () => {
    unregisterConsumer(C);
    await sanctionedConsumerRemoval(prisma, [C]);
    await prisma.$disconnect();
  });

  // ── the registration path still works under the freeze ───────────────────────────────────
  it('a consumer registered under the freeze gets its head through the seam: the nested apply is admitted', async () => {
    expect(await mirror(prisma)).toEqual({ active: true, activationSeq: 1 });
    expect((await facts(prisma)).map((f) => f.actorKind)).toEqual(['registration']);
  });

  it('the migration is on ALWAYS_EXECUTE and re-applies over the migrated database', async () => {
    const list = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate.sh'), 'utf8').match(/ALWAYS_EXECUTE="([^"]+)"/)?.[1] ?? '';
    expect(list.split('\n').map((l) => l.trim())).toContain(MIGRATION);
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    // Re-applied AS A REPLAY IS: every ALWAYS_EXECUTE file from this one onward, in ledger order. A6c
    // (20271230) re-issues `platform_t4d_catalog_rules` one column family wider under the same trigger
    // name; a replay of this file ALONE would leave the database holding the narrower body, which no
    // real replay ever does — migrate.sh runs the list in order.
    const later = list.split('\n').map((l) => l.trim()).filter((m) => m >= MIGRATION).sort();
    expect(later[0]).toBe(MIGRATION);
    for (const m of later) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', join(__dirname, '..', '..', 'prisma', 'migrations', m, 'migration.sql')], { stdio: 'pipe' });
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'OutboxConsumerCatalog_t4d_rules' AND NOT tgisinternal`);
    expect(rows[0]!.n).toBe(1);
  });

  // ── P-A6: the freeze arms ─────────────────────────────────────────────────────────────────
  it('P-A6: a direct UPDATE of active, activationSeq or registeredAt is refused at depth 1 — the marker set by the caller changes nothing', async () => {
    await rolledBack(async (tx) => {
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "active" = false WHERE "consumer" = $1`, C)).toMatch(/MIRROR[\s\S]*direct UPDATE \(trigger depth 1, marker off\)/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "activationSeq" = 9 WHERE "consumer" = $1`, C)).toMatch(/MIRROR[\s\S]*direct UPDATE/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "registeredAt" = now() + interval '1 day' WHERE "consumer" = $1`, C)).toMatch(/"registeredAt"[\s\S]*FROZEN/);
      // a direct writer that sets the marker itself is still at depth 1: refused
      await tx.$executeRawUnsafe(`SELECT set_config('vitan.outbox_activation_applying', 'on', true)`);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "active" = false WHERE "consumer" = $1`, C)).toMatch(/direct UPDATE \(trigger depth 1, marker on\)/);
      await tx.$executeRawUnsafe(`SELECT set_config('vitan.outbox_activation_applying', '', true)`);
      // every other column still moves (the freeze is the mirror's, not the row's)
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "updatedAt" = now() WHERE "consumer" = $1`, C)).toBeNull();
      expect(await mirror(tx)).toEqual({ active: true, activationSeq: 1 });
    });
  });

  it('P-A6: a NESTED update from another trigger without the marker is refused; the register\'s own AFTER INSERT is admitted', async () => {
    await rolledBack(async (tx) => {
      // a probe trigger on an unrelated table that tries to flip the mirror from depth 2
      await tx.$executeRawUnsafe(`CREATE FUNCTION a6b_probe_flip() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN UPDATE "OutboxConsumerCatalog" SET "active" = false WHERE "consumer" = '${C}'; RETURN NULL; END $$`);
      await tx.$executeRawUnsafe(`CREATE TRIGGER a6b_probe_flip AFTER INSERT ON "OutboxOperatorAction" FOR EACH ROW EXECUTE FUNCTION a6b_probe_flip()`);
      const nested = await attempt(tx, `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason") VALUES ($1,'a6b-probe','probe','probe')`, randomUUID());
      expect(nested).toMatch(/nested UPDATE \(trigger depth 2, marker off\)/);
      expect(await mirror(tx)).toEqual({ active: true, activationSeq: 1 });
      // the register's own apply: an appended fact moves the mirror through the seam
      expect(await attempt(tx, `INSERT INTO "OutboxConsumerActivation" ("consumer","seq","active","reason","actorKind","actorId","requestToken") VALUES ($1, 2, false, 'seam', 'operator', 'op', 'tok-seam')`, C)).toBeNull();
      expect(await mirror(tx)).toEqual({ active: false, activationSeq: 2 });
    });
    expect(await mirror(prisma)).toEqual({ active: true, activationSeq: 1 });
  });

  // ── P-A2 / P-A4 / P-A9 / P-A3 ─────────────────────────────────────────────────────────────
  it('P-A2: the same token with the same request appends exactly ONE fact; the second call replays it and moves nothing', async () => {
    const token = randomUUID();
    const first = await ask({ requestToken: token, active: false, reason: 'pause', actorId: 'op-a' });
    expect(first.replayed).toBe(false);
    expect(first.fact).toMatchObject({ seq: 2, active: false, actorKind: 'operator', requestToken: token });
    expect(await mirror(prisma)).toEqual({ active: false, activationSeq: 2 });
    const second = await ask({ requestToken: token, active: false, reason: 'pause', actorId: 'op-a' });
    expect(second.replayed).toBe(true);
    expect(second.fact.seq).toBe(2);
    expect(await mirror(prisma)).toEqual({ active: false, activationSeq: 2 });
    expect(await facts(prisma)).toHaveLength(2);
  });

  it('P-A4 and P-A9: activate → deactivate → activate with three tokens appends three facts; a known token with a DIFFERENT request is refused naming the conflict', async () => {
    const before = (await facts(prisma)).length;
    const t1 = randomUUID(); const t2 = randomUUID(); const t3 = randomUUID();
    await ask({ requestToken: t1, active: true, reason: 'resume' });
    await ask({ requestToken: t2, active: false, reason: 'pause again' });
    await ask({ requestToken: t3, active: true, reason: 'resume again' });
    expect((await facts(prisma)).length).toBe(before + 3);
    expect(await mirror(prisma)).toMatchObject({ active: true });
    for (const bad of [{ active: false, reason: 'resume again', actorId: 'op-a' }, { active: true, reason: 'other reason', actorId: 'op-a' }, { active: true, reason: 'resume again', actorId: 'op-b' }]) {
      await expect(ask({ requestToken: t3, ...bad })).rejects.toBeInstanceOf(ConsumerActivationConflictError);
      await expect(ask({ requestToken: t3, ...bad })).rejects.toThrow(/already used by a DIFFERENT request/);
    }
    // the identical request still replays
    expect((await ask({ requestToken: t3, active: true, reason: 'resume again', actorId: 'op-a' })).replayed).toBe(true);
    expect((await facts(prisma)).length).toBe(before + 3);
    // surface refusals (P-A7 / P-A10 at the surface; the CHECKs behind them are A6a's)
    await expect(ask({ actorId: ' ' })).rejects.toThrow(/actorId/);
    await expect(ask({ requestToken: 'sys:planted' })).rejects.toThrow(/reserved `sys:` prefix/);
    await expect(ask({ requestToken: A6A })).rejects.toThrow(/migration name/);
    await expect(ask({ consumer: 'test.a6b.unregistered' })).rejects.toThrow(/not a registered catalog contract/);
  });

  it('P-A3: a retry after a lost response and a later operator\'s opposite intent replays its own fact and does NOT undo that intent — from inactive and from already-active', async () => {
    for (const start of [false, true] as const) {
      await ask({ active: start, reason: `start ${start}` });
      expect((await mirror(prisma)).active).toBe(start);
      const before = (await facts(prisma)).length;
      const tokenA = randomUUID();
      const a = await ask({ requestToken: tokenA, active: true, reason: 'A activates', actorId: 'op-a' }); // response "lost"
      expect(a.replayed).toBe(false); // a confirming request STILL appends (the state-only branch is gone)
      await ask({ active: false, reason: 'B deactivates', actorId: 'op-b' });
      expect((await mirror(prisma)).active).toBe(false);
      const retry = await ask({ requestToken: tokenA, active: true, reason: 'A activates', actorId: 'op-a' });
      expect(retry.replayed).toBe(true);
      expect(retry.fact.seq).toBe(a.fact.seq);
      expect((await mirror(prisma)).active, `start=${start}: B's intent stands`).toBe(false);
      expect((await facts(prisma)).length).toBe(before + 2);
    }
  });

  // ── P-A5: the pre-lock rendezvous ─────────────────────────────────────────────────────────
  it('P-A5: two concurrent operator requests with distinct tokens BOTH commit in the order they serialized; the terminal mirror is the second\'s intent', async () => {
    await ask({ active: true, reason: 'baseline for P-A5' });
    const head = (await mirror(prisma)).activationSeq;
    const tokenA = randomUUID();
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => { releaseA = r; });
    let aLocked!: () => void;
    const locked = new Promise<void>((r) => { aLocked = r; });
    // A: takes the lock, appends and HOLDS without committing
    const a = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT "activationSeq" FROM "OutboxConsumerCatalog" WHERE "consumer" = $1 FOR UPDATE /* a6b-A */`, C);
      await tx.$executeRawUnsafe(`INSERT INTO "OutboxConsumerActivation" ("consumer","seq","active","reason","actorKind","actorId","requestToken") VALUES ($1, $2, false, 'A pauses', 'operator', 'op-a', $3)`, C, head + 1, tokenA);
      aLocked();
      await gate;
    }, { timeout: 30_000 });
    await locked;
    // B: the protocol, observed BLOCKED on that row
    const b = ask({ active: true, reason: 'B resumes', actorId: 'op-b' });
    const deadline = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < deadline && !blocked) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%' AND query LIKE '%OutboxConsumerCatalog%' AND pid <> pg_backend_pid()`,
      );
      blocked = Number(rows[0]?.n ?? 0) > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    expect(blocked, 'B waits on the catalog row A holds').toBe(true);
    releaseA();
    await a;
    const result = await b;
    expect(result.replayed).toBe(false);
    expect(result.fact.seq).toBe(head + 2);
    const all = await facts(prisma);
    expect(all.slice(-2).map((f) => [f.seq, f.requestToken])).toEqual([[head + 1, tokenA], [head + 2, result.fact.requestToken]]);
    expect(await mirror(prisma)).toEqual({ active: true, activationSeq: head + 2 });
  });

  // ── P-A10 past the surface ────────────────────────────────────────────────────────────────
  it('P-A10: an operator fact planted past the surface with a migration\'s name as its token does not preempt the migration\'s own fact, and a retry finds its own row', async () => {
    const REG = 'test.a6b.planted';
    registerConsumer(consumer(REG));
    try {
      await syncConsumerCatalog(prisma);
      await rolledBack(async (tx) => {
        expect(await attempt(tx, `INSERT INTO "OutboxConsumerActivation" ("consumer","seq","active","reason","actorKind","actorId","requestToken") VALUES ($1, 2, false, 'planted', 'operator', 'op', $2)`, REG, A6A)).toBeNull();
        // the migration's own kind under that token is untouched, and a lookup by its kind finds only its own rows
        const byKind = await tx.outboxConsumerActivation.findMany({ where: { consumer: REG, actorKind: 'migration' } });
        expect(byKind).toEqual([]);
        const mine = await tx.outboxConsumerActivation.findUnique({ where: { consumer_actorKind_requestToken: { consumer: REG, actorKind: 'operator', requestToken: A6A } } });
        expect(mine).toMatchObject({ seq: 2, actorKind: 'operator' });
      });
      // A6a's backfill re-applied appends nothing for a consumer that already has a head
      const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
      const before = await facts(prisma, REG);
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', join(__dirname, '..', '..', 'prisma', 'migrations', A6A, 'migration.sql')], { stdio: 'pipe' });
      expect(await facts(prisma, REG)).toEqual(before);
    } finally {
      unregisterConsumer(REG);
      await sanctionedConsumerRemoval(prisma, [REG]);
    }
  });
});
