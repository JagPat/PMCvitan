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

  /**
   * The integration config runs files SERIALLY against ONE shared database, so a suite that leaves
   * rows behind hands them to every file after it — and to a local re-run. The real-command probe
   * creates a decision, its domain event, its outbox rows and its receipt, so this suite restores
   * the clean fixture state the same way every other `createTwoProjectFixture` suite does.
   */
  afterAll(async () => {
    // reverse foreign-key order — the real-command probe's decision carries options and its own
    // event log, and `f.cleanup()` does not know about them (it truncates DomainEvent, which is a
    // different table). The change-request and approval-revision deletes are defensive: this suite
    // creates neither today, and a future probe that does should not silently strand rows.
    const inProject = { decision: { projectId: f.projectA.id } };
    await t?.prisma.decisionOption.deleteMany({ where: inProject });
    await t?.prisma.decisionEvent.deleteMany({ where: inProject });
    await t?.prisma.changeRequest.deleteMany({ where: inProject });
    await t?.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.decision.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

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

  /**
   * The protocol as `executeCommand` performs it: reserve and complete inside ONE transaction.
   * The acceptance probes go through here so they exercise the shape the seal describes rather
   * than a shape it merely tolerates.
   */
  const reserveAndComplete = async (
    resultRef: string | null, status: 'succeeded' | 'failed' = 'succeeded',
  ): Promise<string> => t.prisma.$transaction(async (tx) => {
    const row = await tx.commandExecution.create({
      data: {
        scopeKind: 'project', organizationId: f.orgA.id, projectId: f.projectA.id,
        actorId: f.memberUser.id, commandType: 'test.receipt', requestHash: 'x',
        idempotencyKey: `receipt-${(seq += 1)}-${Date.now() % 1e6}`, status: 'reserved',
      },
      select: { id: true },
    });
    await tx.commandExecution.update({
      where: { id: row.id }, data: { status, resultRef, completedAt: new Date() },
    });
    return row.id;
  });

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

  it('reserve → succeeded with a result is ACCEPTED in ONE transaction (the seal enforces the protocol, it does not forbid it)', async () => {
    const id = await reserveAndComplete('REAL');
    const row = await t.prisma.commandExecution.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('succeeded');
    expect(row.resultRef).toBe('REAL');
  });

  /**
   * Codex round-1 on this PR: the first head's seal still allowed a two-statement forgery — reserve
   * in one transaction, complete in another with a chosen `resultRef`. That does not close under a
   * trigger (see the migration's trust-boundary note; SQL that reproduces the protocol is
   * indistinguishable from the protocol), but the SEPARATE-transaction half of it is a real
   * protocol violation and is now refused: Phase 2 states the reserve/execute/receipt sequence is
   * ONE transaction, so a completion arriving later did not come from a command run.
   */
  it('a receipt cannot be adopted and completed by a LATER transaction', async () => {
    const id = await reserved();
    await expect(raw(
      `UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"='FORGED', "completedAt"=now() WHERE "id"=$1`, id,
    )).rejects.toThrow(/SAME transaction that reserved it/u);
    expect((await t.prisma.commandExecution.findFirstOrThrow({ where: { id } })).status).toBe('reserved');
  });

  it('a COMPLETED receipt cannot be re-pointed at a different result', async () => {
    const id = await reserveAndComplete('REAL');
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
    const done = await reserveAndComplete('REAL');
    await expect(raw(`UPDATE "CommandExecution" SET "status"='reserved', "completedAt"=NULL WHERE "id"=$1`, done))
      .rejects.toThrow(/COMPLETED command receipt is immutable/u);
  });

  /**
   * Codex round-2 on this PR: the seal rejected a result on `failed` and said nothing about its
   * absence on `succeeded`. `ExecuteResult.resultRef` is a required `string` and every command site
   * returns an entity id, so this is the type system's rule restated where the database can hold
   * it — and left open it is worse than untidy: the replay path returns `prior.resultRef ?? ''`, so
   * a succeeded receipt with no result SUPPRESSES the retry that would have produced the entity and
   * hands the caller success with nothing in it.
   */
  it('a SUCCEEDED receipt must record the result it produced', async () => {
    await expect(t.prisma.$transaction(async (tx) => {
      const row = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId: f.projectA.id,
          actorId: f.memberUser.id, commandType: 'test.receipt', requestHash: 'x',
          idempotencyKey: `receipt-noresult-${(seq += 1)}`, status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({
        where: { id: row.id }, data: { status: 'succeeded', completedAt: new Date() },
      });
    })).rejects.toThrow(/SUCCEEDED command recorded no result/u);

    // …and blank is not a result either, under the same §0b whitespace rule as every other
    // identity column in this system. The TAB case is the one that matters: PostgreSQL's default
    // `btrim(x)` trims SPACES ONLY, so an earlier head of this seal accepted `E'\t'` as a result
    // (Codex round-3). The full set `E' \t\n\x0B\f\r'` is what the twenty-odd other non-blank
    // checks in this schema use, and now what this one uses.
    for (const blank of ["'   '", "E'\\t'", "E'\\n'", "E'\\r'", "E'\\x0B'", "E'\\f'"]) {
      const id = await reserved();
      await expect(
        raw(`UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"=${blank}, "completedAt"=now() WHERE "id"=$1`, id),
        `${blank} must not count as a result`,
      ).rejects.toThrow(/SUCCEEDED command recorded no result/u);
    }
  });

  it('a FAILED receipt carries no result, and an honest failure is accepted', async () => {
    const bad = await reserved();
    await expect(raw(
      `UPDATE "CommandExecution" SET "status"='failed', "resultRef"='X', "completedAt"=now() WHERE "id"=$1`, bad,
    )).rejects.toThrow(/FAILED command produced no result/u);
    // `failed` is in Phase 2's status vocabulary and no code path writes it today; the arrow stays
    // open because the vocabulary is a cleared decision and a rollback records a real outcome
    const failed = await reserveAndComplete(null, 'failed');
    expect((await t.prisma.commandExecution.findFirstOrThrow({ where: { id: failed } })).status).toBe('failed');
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
