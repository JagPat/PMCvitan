import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerConsumer, syncConsumerCatalog, unregisterConsumer, type OutboxConsumer } from '../../src/platform/outbox/registry';
import { sanctionedConsumerRemoval } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6a — the OUTBOX CONSUMER ACTIVATION REGISTER, against live
 * PostgreSQL (the companion document `2026-09-09-outbox-consumer-activation.md`, its probes P-A1,
 * P-A6, P-A7 and P-A8 as far as this sub-unit installs them; P-A2–P-A5 and P-A9–P-A11 need the
 * operator protocol and the mirror freeze, which are A6b's).
 *
 * Every hostile write runs under a SAVEPOINT inside a transaction that ROLLS BACK — a refused
 * statement aborts a PostgreSQL transaction, so each one is measured on its own savepoint and the
 * next statement still runs — and the shared test database keeps exactly the register it had. The
 * one committed act, a consumer registered through `syncConsumerCatalog()`, leaves through the
 * row-scoped sanctioned seam this unit adds.
 */
describe('4d-ii-a / A6a — the activation register (live PG)', () => {
  let prisma: PrismaClient;
  const MIGRATION = '20271228000000_phase6_t4d_ii_a6a_activation_register';
  const REGISTERED = 'test.a6a.registered';
  const SENTINEL = new Error('rollback');
  const WS = [' ', '\t', '\u000B', '\f', '\r', '\n'];
  type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

  const registered: OutboxConsumer = {
    name: REGISTERED, kind: 'unordered', effect: 'external', catalogVersion: 1, dispatchRule: { kind: 'types', eventTypes: [] },
    deliveryFor: () => ({ action: 'noop' }), handle: async () => {},
  };

  /** Run `body` on a transaction that is always rolled back; rethrows what the body threw. */
  const rolledBack = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
    let thrown: unknown = null;
    await prisma.$transaction(async (tx) => {
      try { await body(tx); } catch (e) { thrown = e; }
      throw SENTINEL;
    }).catch((e) => { if (e !== SENTINEL) throw e; });
    if (thrown) throw thrown;
  };
  let savepoints = 0;
  /** Run one statement under its own savepoint: the seal's message when refused, null when admitted. */
  const attempt = async (tx: Tx, sql: string, ...params: unknown[]): Promise<string | null> => {
    const sp = `a6a_${++savepoints}`;
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
  const INSERT = `INSERT INTO "OutboxConsumerActivation" ("consumer","seq","active","reason","actorKind","actorId","requestToken") VALUES ($1,$2,$3,$4,$5,$6,$7)`;

  /** The head and mirror for one consumer. */
  const headOf = async (client: Tx | PrismaClient, consumer: string) => {
    const catalog = await client.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer } });
    const facts = await client.outboxConsumerActivation.findMany({ where: { consumer }, orderBy: { seq: 'asc' } });
    return { catalog, facts, head: facts[facts.length - 1] ?? null };
  };

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    await sanctionedConsumerRemoval(prisma, [REGISTERED]);
  });

  afterAll(async () => {
    unregisterConsumer(REGISTERED);
    await sanctionedConsumerRemoval(prisma, [REGISTERED]);
    await prisma.$disconnect();
  });

  // ── P-A1 ──────────────────────────────────────────────────────────────────────────────────
  it('P-A1: every catalog row holds exactly one seq = 1 baseline fact, and the mirror equals its head', async () => {
    const rows = await prisma.outboxConsumerCatalog.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows) {
      const { facts, head } = await headOf(prisma, c.consumer);
      expect(facts.filter((f) => f.seq === 1), `${c.consumer}: one seq=1 baseline`).toHaveLength(1);
      expect(facts.map((f) => f.seq), `${c.consumer}: contiguous from 1`).toEqual(facts.map((_, i) => i + 1));
      expect(head, `${c.consumer}: a head`).not.toBeNull();
      expect(c.active, `${c.consumer}: the mirror equals the head`).toBe(head!.active);
      expect(c.activationSeq, `${c.consumer}: activationSeq is the head's seq`).toBe(head!.seq);
      const baseline = facts[0]!;
      expect(['migration', 'registration']).toContain(baseline.actorKind);
      if (baseline.actorKind === 'migration') expect(baseline.requestToken).toBe(MIGRATION);
      else expect(baseline.requestToken).toBeNull();
    }
  });

  it('P-A1: a consumer created AFTER the migration by syncConsumerCatalog() holds its head too — registration, its default active mirrored, no token', async () => {
    registerConsumer(registered);
    await syncConsumerCatalog(prisma);
    const { catalog, facts, head } = await headOf(prisma, REGISTERED);
    expect(facts).toHaveLength(1);
    expect(head).toMatchObject({ seq: 1, active: true, actorKind: 'registration', actorId: 'system:outbox-registration', requestToken: null });
    expect(catalog.active).toBe(true);
    expect(catalog.activationSeq).toBe(1);
    // a second sync is the delivered idempotent path: no second row, no second head
    await syncConsumerCatalog(prisma);
    expect((await headOf(prisma, REGISTERED)).facts).toHaveLength(1);
  });

  it('P-A1 (baseline arm): the migration is on ALWAYS_EXECUTE, and re-applying it over the migrated database appends nothing', async () => {
    const migrateSh = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate.sh'), 'utf8');
    const list = migrateSh.match(/ALWAYS_EXECUTE="([^"]+)"/)?.[1] ?? '';
    expect(list.split('\n').map((l) => l.trim())).toContain(MIGRATION);

    const before = await prisma.outboxConsumerActivation.count();
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, 'migration.sql')], { stdio: 'pipe' });
    expect(await prisma.outboxConsumerActivation.count()).toBe(before);
    for (const c of await prisma.outboxConsumerCatalog.findMany()) {
      const { head } = await headOf(prisma, c.consumer);
      expect(c.active).toBe(head!.active);
      expect(c.activationSeq).toBe(head!.seq);
    }
  });

  // ── the head lock and the apply ───────────────────────────────────────────────────────────
  it('the head lock: a fact at exactly activationSeq + 1 is admitted and the mirror follows it; a stale or skipped seq is refused by name', async () => {
    await rolledBack(async (tx) => {
      const { catalog } = await headOf(tx, REGISTERED);
      const next = catalog.activationSeq + 1;
      const skipped = await attempt(tx, INSERT, REGISTERED, next + 1, false, 'skip', 'operator', 'op-1', 'tok-skip');
      expect(skipped).toMatch(/STALE/);
      expect(skipped).toContain(`the next fact must be seq ${next}`);
      const stale = await attempt(tx, INSERT, REGISTERED, catalog.activationSeq, false, 'stale', 'operator', 'op-1', 'tok-stale');
      expect(stale).toMatch(/STALE/);
      // the register and mirror are untouched by the two refusals
      expect((await headOf(tx, REGISTERED)).catalog).toMatchObject({ active: true, activationSeq: catalog.activationSeq });

      // …and the next fact is admitted, the apply moving the mirror with it
      expect(await attempt(tx, INSERT, REGISTERED, next, false, 'paused for the probe', 'operator', 'op-1', 'tok-apply')).toBeNull();
      const after = await headOf(tx, REGISTERED);
      expect(after.catalog.active).toBe(false);
      expect(after.catalog.activationSeq).toBe(next);
      expect(after.head).toMatchObject({ seq: next, active: false, actorKind: 'operator', requestToken: 'tok-apply' });
      // a second operator token with the same intent is a second fact (the register records requests)
      expect(await attempt(tx, INSERT, REGISTERED, next + 1, false, 'confirmed', 'operator', 'op-2', 'tok-confirm')).toBeNull();
      expect((await headOf(tx, REGISTERED)).catalog.activationSeq).toBe(next + 1);
      // the SAME retry identity twice is refused by the triple uniqueness
      // (Prisma surfaces PostgreSQL's 23505 with its DETAIL line — the offending key — not the index name)
      const replayed = await attempt(tx, INSERT, REGISTERED, next + 2, true, 'replayed', 'operator', 'op-2', 'tok-confirm');
      expect(replayed, replayed ?? 'admitted').toMatch(/23505[\s\S]*\(consumer, "actorKind", "requestToken"\)[\s\S]*already exists/);
    });
    // …and the rollback left the committed register as it was
    expect((await headOf(prisma, REGISTERED)).catalog).toMatchObject({ active: true, activationSeq: 1 });
  });

  // ── P-A6 (this sub-unit's arms) ───────────────────────────────────────────────────────────
  it('P-A6: a direct UPDATE, a direct DELETE and a TRUNCATE of the register are each refused; deleting the catalog row is refused while a head exists', async () => {
    await rolledBack(async (tx) => {
      expect(await attempt(tx, `UPDATE "OutboxConsumerActivation" SET "active" = false WHERE "consumer" = $1`, REGISTERED)).toMatch(/append-only[\s\S]*UPDATE is refused/);
      expect(await attempt(tx, `DELETE FROM "OutboxConsumerActivation" WHERE "consumer" = $1`, REGISTERED)).toMatch(/append-only[\s\S]*DELETE is refused/);
      expect(await attempt(tx, `TRUNCATE "OutboxConsumerActivation"`)).toMatch(/never truncated/);
      // the FK is RESTRICT: the row is referenced by its own head, which every consumer has
      expect(await attempt(tx, `DELETE FROM "OutboxConsumerCatalog" WHERE "consumer" = $1`, REGISTERED)).toMatch(/foreign key constraint|OutboxConsumerActivation_consumer_fkey/);
      expect((await headOf(tx, REGISTERED)).facts).toHaveLength(1);
    });
    expect((await headOf(prisma, REGISTERED)).facts).toHaveLength(1);
  });

  it('P-A6: the row-scoped sanctioned removal takes exactly the named consumers and leaves the seal ENABLED and its neighbours standing', async () => {
    const NEIGHBOUR = 'test.a6a.neighbour';
    const neighbour: OutboxConsumer = { ...registered, name: NEIGHBOUR };
    registerConsumer(neighbour);
    try {
      await syncConsumerCatalog(prisma);
      expect((await headOf(prisma, NEIGHBOUR)).facts).toHaveLength(1);
      await sanctionedConsumerRemoval(prisma, [NEIGHBOUR]);
      expect(await prisma.outboxConsumerCatalog.count({ where: { consumer: NEIGHBOUR } })).toBe(0);
      expect(await prisma.outboxConsumerActivation.count({ where: { consumer: NEIGHBOUR } })).toBe(0);
      // the long-lived neighbour survives a row-scoped removal — the arm a CASCADE truncate fails
      expect((await headOf(prisma, REGISTERED)).facts).toHaveLength(1);
      const seals = await prisma.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string }>>(
        `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'OutboxConsumerActivation\\_t4d\\_%' AND NOT tgisinternal ORDER BY 1`,
      );
      expect(seals.map((s) => s.tgname)).toEqual([
        'OutboxConsumerActivation_t4d_append_only', 'OutboxConsumerActivation_t4d_apply',
        'OutboxConsumerActivation_t4d_head_lock', 'OutboxConsumerActivation_t4d_no_truncate',
      ]);
      for (const s of seals) expect(s.tgenabled, s.tgname).toBe('O');
    } finally {
      unregisterConsumer(NEIGHBOUR);
      await sanctionedConsumerRemoval(prisma, [NEIGHBOUR]);
    }
  });

  // ── P-A7 ──────────────────────────────────────────────────────────────────────────────────
  it('P-A7: the whitespace CHECK at the database boundary — a blank reason, actorId or requestToken is refused, each by its own constraint', async () => {
    const NEXT = `INSERT INTO "OutboxConsumerActivation" ("consumer","seq","active","reason","actorKind","actorId","requestToken") VALUES ($1, (SELECT "activationSeq" + 1 FROM "OutboxConsumerCatalog" WHERE "consumer" = $1), true, $2, $3, $4, $5)`;
    await rolledBack(async (tx) => {
      for (const ws of WS) {
        expect(await attempt(tx, NEXT, REGISTERED, ws, 'operator', 'op', 't'), JSON.stringify(ws)).toContain('OutboxConsumerActivation_reason_present_check');
        expect(await attempt(tx, NEXT, REGISTERED, 'r', 'operator', ws, 't'), JSON.stringify(ws)).toContain('OutboxConsumerActivation_actorId_present_check');
        expect(await attempt(tx, NEXT, REGISTERED, 'r', 'operator', 'op', ws), JSON.stringify(ws)).toContain('OutboxConsumerActivation_requestToken_present_check');
      }
      expect(await attempt(tx, NEXT, REGISTERED, 'r', 'operator', 'op', '')).toContain('OutboxConsumerActivation_requestToken_present_check');
      // the kind rule: a retrying kind without a token, a registration with one, an unknown kind
      expect(await attempt(tx, NEXT, REGISTERED, 'r', 'operator', 'op', null)).toContain('OutboxConsumerActivation_requestToken_kind_check');
      expect(await attempt(tx, NEXT, REGISTERED, 'r', 'migration', 'sys', null)).toContain('OutboxConsumerActivation_requestToken_kind_check');
      expect(await attempt(tx, NEXT, REGISTERED, 'r', 'registration', 'sys', 't')).toContain('OutboxConsumerActivation_requestToken_kind_check');
      expect(await attempt(tx, NEXT, REGISTERED, 'r', 'bot', 'op', 't')).toContain('OutboxConsumerActivation_actorKind_check');
      // …and a well-formed fact is admitted on the same transaction
      expect(await attempt(tx, NEXT, REGISTERED, ' well formed ', 'operator', 'op', 'tok-ok')).toBeNull();
      expect((await headOf(tx, REGISTERED)).facts).toHaveLength(2);
    });
    expect((await headOf(prisma, REGISTERED)).facts).toHaveLength(1);
  });

  // ── P-A8 ──────────────────────────────────────────────────────────────────────────────────
  it('P-A8: a fact naming a consumer with NO catalog row is refused by the STRICT raise naming it, and by the FK with the head lock disabled; no orphan survives', async () => {
    const UNKNOWN = 'test.a6a.unregistered';
    await rolledBack(async (tx) => {
      expect(await attempt(tx, INSERT, UNKNOWN, 1, true, 'orphan', 'operator', 'op', 'tok-orphan'))
        .toContain(`names consumer "${UNKNOWN}", which has no "OutboxConsumerCatalog" row`);
      await tx.$executeRawUnsafe(`ALTER TABLE "OutboxConsumerActivation" DISABLE TRIGGER "OutboxConsumerActivation_t4d_head_lock"`);
      expect(await attempt(tx, INSERT, UNKNOWN, 1, true, 'orphan', 'operator', 'op', 'tok-orphan'))
        .toMatch(/foreign key constraint|OutboxConsumerActivation_consumer_fkey/);
      expect(await tx.outboxConsumerActivation.count({ where: { consumer: UNKNOWN } })).toBe(0);
    });
    expect(await prisma.outboxConsumerActivation.count({ where: { consumer: UNKNOWN } })).toBe(0);
    const lock = await prisma.$queryRawUnsafe<Array<{ tgenabled: string }>>(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'OutboxConsumerActivation_t4d_head_lock'`);
    expect(lock[0]?.tgenabled).toBe('O');
  });
});
