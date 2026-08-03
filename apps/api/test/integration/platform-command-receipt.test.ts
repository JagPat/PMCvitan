import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Platform kernel — THE COMMAND RECEIPT PROTOCOL, proven live against PostgreSQL.
 *
 * `executeCommand` reserves a ledger row, runs, and completes it in ONE transaction. Phase 2 gave
 * `CommandExecution` its tenancy, its scope truth table, its status vocabulary and its unique
 * indexes; it never gave it the PROTOCOL, so a row could be inserted already `succeeded` with any
 * `resultRef` its author liked.
 *
 * That mattered the moment receipts became PROVENANCE — fifteen `sourceCommandId` columns now cite
 * this table to answer "which command produced this fact". Every probe below is a forgery that
 * PostgreSQL accepted before this migration, and each is paired with the honest operation it must
 * still permit: a seal that only ever refuses is not shown to be checking anything.
 */
describe('Platform — the command receipt protocol is database-enforced (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let decisions: DecisionsService;
  let seq = 0;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    decisions = t.app.get(DecisionsService);
  });

  afterAll(async () => { await t?.close(); });

  afterEach(async () => {
    await t.prisma.commandExecution.deleteMany({ where: { commandType: { startsWith: 'test.receipt' } } });
  });

  /** A row inserted the way the protocol requires: `reserved`, with no result and no completion. */
  const reserved = async (): Promise<string> => {
    const row = await t.prisma.commandExecution.create({
      data: {
        scopeKind: 'project', organizationId: f.orgA.id, projectId: f.projectA.id,
        actorId: f.memberUser.id, commandType: 'test.receipt', requestHash: 'x',
        idempotencyKey: `receipt-${(seq += 1)}-${Date.now() % 1e6}`, status: 'reserved',
      },
      select: { id: true },
    });
    return row.id;
  };

  const raw = (sql: string, ...params: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...params);

  // ── INSERT — a receipt records that a command RAN ────────────────────────────────────────────

  /**
   * The finding this seal exists for, in its purest form. A `succeeded` receipt with a chosen
   * `resultRef` is provenance for anything: the Phase-5 §E verdict seal, the Phase-3 stock ledger's
   * source action and every other `sourceCommandId` join reads exactly these two columns.
   */
  it('a receipt cannot be MINTED already succeeded', async () => {
    await expect(raw(
      `INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status","resultRef","completedAt")
       VALUES ('rcpt-forge',$1,$2,$3,$4,'test.receipt','forge-1','x','succeeded','FORGED',now())`,
      'project', f.orgA.id, f.projectA.id, f.memberUser.id,
    )).rejects.toThrow(/INSERTED as `reserved`/u);
    expect(await t.prisma.commandExecution.count({ where: { id: 'rcpt-forge' } })).toBe(0);
  });

  it('a reserved receipt cannot be pre-loaded with a result or a completion time', async () => {
    await expect(raw(
      `INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status","resultRef")
       VALUES ('rcpt-pre',$1,$2,$3,$4,'test.receipt','pre-1','x','reserved','FORGED')`,
      'project', f.orgA.id, f.projectA.id, f.memberUser.id,
    )).rejects.toThrow(/no result and no completion time/u);
  });

  // ── UPDATE — one direction, exactly once ─────────────────────────────────────────────────────

  it('reserve → succeeded with a result is ACCEPTED (the seal enforces the protocol, it does not forbid it)', async () => {
    const id = await reserved();
    await t.prisma.commandExecution.update({
      where: { id }, data: { status: 'succeeded', resultRef: 'REAL', completedAt: new Date() },
    });
    const row = await t.prisma.commandExecution.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('succeeded');
    expect(row.resultRef).toBe('REAL');
  });

  it('a COMPLETED receipt cannot be re-pointed at a different result', async () => {
    const id = await reserved();
    await t.prisma.commandExecution.update({
      where: { id }, data: { status: 'succeeded', resultRef: 'REAL', completedAt: new Date() },
    });
    await expect(raw(`UPDATE "CommandExecution" SET "resultRef"='OTHER' WHERE "id"=$1`, id))
      .rejects.toThrow(/COMPLETED command receipt is immutable/u);
    await expect(raw(`UPDATE "CommandExecution" SET "status"='failed' WHERE "id"=$1`, id))
      .rejects.toThrow(/COMPLETED command receipt is immutable/u);
    expect((await t.prisma.commandExecution.findFirstOrThrow({ where: { id } })).resultRef).toBe('REAL');
  });

  it('a receipt cannot return to reserved, and cannot complete without recording WHEN', async () => {
    const id = await reserved();
    await expect(raw(`UPDATE "CommandExecution" SET "status"='succeeded' WHERE "id"=$1`, id))
      .rejects.toThrow(/records WHEN it completed/u);
    await t.prisma.commandExecution.update({
      where: { id }, data: { status: 'succeeded', resultRef: 'REAL', completedAt: new Date() },
    });
    await expect(raw(`UPDATE "CommandExecution" SET "status"='reserved', "completedAt"=NULL WHERE "id"=$1`, id))
      .rejects.toThrow(/COMPLETED command receipt is immutable/u);
  });

  it('a FAILED receipt carries no result, and an honest failure is accepted', async () => {
    const bad = await reserved();
    await expect(raw(
      `UPDATE "CommandExecution" SET "status"='failed', "resultRef"='X', "completedAt"=now() WHERE "id"=$1`, bad,
    )).rejects.toThrow(/FAILED command produced no result/u);
    // `failed` is in Phase 2's status vocabulary and no code path writes it today; the arrow stays
    // open because the vocabulary is a cleared decision and a rollback records a real outcome
    await raw(`UPDATE "CommandExecution" SET "status"='failed', "completedAt"=now() WHERE "id"=$1`, bad);
    expect((await t.prisma.commandExecution.findFirstOrThrow({ where: { id: bad } })).status).toBe('failed');
  });

  // ── identity ────────────────────────────────────────────────────────────────────────────────

  /**
   * Identity is who acted, which command, under which key, over which request. The replay lookup
   * and every provenance join read these columns, so a rewritable identity lets a receipt be
   * re-pointed at a different actor or command type after the fact — which is the same forgery as
   * minting one, reached by a different door.
   */
  it('a receipt\'s identity is FROZEN', async () => {
    const id = await reserved();
    for (const [column, value] of [
      ['commandType', 'commercial.bill.verify'],
      ['actorId', f.ownerUser.id],
      ['requestHash', 'tampered'],
      ['idempotencyKey', 'tampered'],
      ['scopeKind', 'org'],
    ] as const) {
      await expect(
        raw(`UPDATE "CommandExecution" SET "${column}"=$1 WHERE "id"=$2`, value, id),
        `${column} must be frozen`,
      ).rejects.toThrow(/identity is FROZEN/u);
    }
  });

  // ── the protocol the code already follows ────────────────────────────────────────────────────

  /**
   * The claim this migration rests on is that it enforces what `executeCommand` ALREADY does, so
   * no runtime change accompanies it. That is a claim about behaviour, so it is proven by
   * behaviour: a real keyed command runs end to end, and its receipt is a completed one carrying
   * the result the command returned.
   *
   * The replay half matters as much as the write half — a replay reads `resultRef` off the stored
   * receipt, and if the seal had made completion impossible this would surface as a second
   * execution rather than as an error.
   */
  it('a REAL command still reserves, completes and replays under the seal', async () => {
    const key = `receipt-e2e-${Date.now() % 1e6}`;
    const input = {
      title: `Receipt protocol ${(seq += 1)}`, room: 'GF',
      options: [
        { material: 'Marble', delta: 0, swatch: '#fff' },
        { material: 'Granite', delta: 100, swatch: '#000' },
      ],
    };
    await decisions.create(f.projectA.id, input as never, pmc(f.projectA.id), key);

    const receipt = await t.prisma.commandExecution.findFirstOrThrow({
      where: { projectId: f.projectA.id, idempotencyKey: key },
    });
    expect(receipt.status).toBe('succeeded');
    expect(receipt.completedAt).not.toBeNull();
    // …and the result it recorded is a REAL decision, not a placeholder — which is what every
    // `sourceCommandId` provenance join ultimately relies on
    expect(receipt.resultRef).toBeTruthy();
    expect(await t.prisma.decision.count({
      where: { projectId: f.projectA.id, id: receipt.resultRef! },
    })).toBe(1);

    // the same key again replays the stored receipt rather than executing a second time
    await decisions.create(f.projectA.id, input as never, pmc(f.projectA.id), key);
    expect(await t.prisma.commandExecution.count({
      where: { projectId: f.projectA.id, idempotencyKey: key },
    })).toBe(1);
    expect(await t.prisma.decision.count({ where: { projectId: f.projectA.id, title: input.title } })).toBe(1);
  });
});
