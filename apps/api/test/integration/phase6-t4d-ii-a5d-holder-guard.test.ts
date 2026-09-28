import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { rethrowHolderSealViolation } from '../../src/orgs/members.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5d (§A.2, P39) — 4d-i's `Membership_t4d_holder_guard` is an
 * immediate AFTER-row trigger, so on a member command it refuses at the membership WRITE, before the
 * command's own post-write judgement. #656's review round 1: its raise must reach the caller as the
 * command's 409, never a raw database error.
 *
 * The guard's subjects (a decision awaiting countersign, an architect) are unrepresentable while 4d-i's
 * doors stand, so each arm opens the doors it needs INSIDE a transaction, builds the state, runs the
 * membership write the command runs, hands the REAL database error to the command's translator, and
 * ROLLS BACK. The doors and the rows are as they were after.
 */
describe('4d-ii-a / A5d — the 4d-i holder guard answers a member command with a 409 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engineerId: string;
  let engineerMembershipId: string;
  let namedId: string;
  let clientHeldId: string;
  const run = randomUUID().slice(0, 8);
  const FALLBACK = 'the call site fallback';

  const post = (path: string, body: object) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const create = async (title: string, extra: object) => {
    const r = await post(`/projects/${f.projectA.id}/decisions`, {
      title, room: 'Kitchen', publish: true, ...extra,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engineerId = `a5d-guard-eng-${run}`;
    await t.prisma.user.create({ data: { id: engineerId, projectId: f.projectA.id, role: 'engineer', name: 'A5d Guard Engineer', email: `${engineerId}@test.local` } });
    engineerMembershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engineerId, role: 'engineer', status: 'active' } })).id;
    namedId = await create(`A5d named ${run}`, { deciderKind: 'member', deciderMembershipId: engineerMembershipId });
    clientHeldId = await create(`A5d client ${run}`, {});
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { userId: engineerId } });
    await t.prisma.user.deleteMany({ where: { id: engineerId } });
    await f?.cleanup();
    await t?.close();
  });

  /** Opens the awaiting-countersign doors on `tx` and parks `decisionId` there. */
  const park = async (tx: Prisma.TransactionClient, decisionId: string) => {
    for (const trigger of ['Decision_t4d_awaiting_reserved', 'Decision_t4d_entry_seal', 'Decision_t4d_awaiting_paired']) {
      await tx.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "Decision"`);
    }
    await tx.$executeRawUnsafe(`UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = $1`, decisionId);
  };

  /** Runs `arrange` then `write` on one rolled-back transaction; returns what the translator made of the write's raise. */
  const translated = async (
    arrange: (tx: Prisma.TransactionClient) => Promise<void>,
    write: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<unknown> => {
    const sentinel = new Error('rollback');
    let answer: unknown = 'the write was not refused';
    await expect(t.prisma.$transaction(async (tx) => {
      await lockProjectReadiness(tx, f.projectA.id);
      await arrange(tx);
      try {
        await write(tx);
      } catch (e) {
        try { rethrowHolderSealViolation(e, FALLBACK); } catch (out) { answer = out; }
      }
      throw sentinel;
    })).rejects.toBe(sentinel);
    return answer;
  };

  const expectConflict = (answer: unknown, text: RegExp) => {
    expect(answer, String(answer)).toBeInstanceOf(ConflictException);
    expect((answer as ConflictException).message).toMatch(text);
    expect((answer as ConflictException).message).not.toBe(FALLBACK);
  };

  it('removing or re-roling the NAMED holder of a decision awaiting countersign is a 409 naming it', async () => {
    const removed = await translated(
      (tx) => park(tx, namedId),
      (tx) => tx.membership.update({ where: { id: engineerMembershipId }, data: { status: 'removed' } }),
    );
    expectConflict(removed, /named holder of a decision awaiting countersign.*still has 0 active architect/);
    const reRoled = await translated(
      (tx) => park(tx, namedId),
      (tx) => tx.membership.update({ where: { id: engineerMembershipId }, data: { role: 'contractor' } }),
    );
    expectConflict(reRoled, /named holder of a decision awaiting countersign/);
  });

  it('removing the last holder of a role a decision awaiting countersign is designated to is a 409 naming the role', async () => {
    const client = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });
    const answer = await translated(
      (tx) => park(tx, clientHeldId),
      (tx) => tx.membership.update({ where: { id: client.id }, data: { status: 'removed' } }),
    );
    expectConflict(answer, /awaiting countersign is designated to the client role/);
  });

  it('removing the last architect while a pending decision is designated to the role is a 409 naming the role', async () => {
    let architectMembershipId = '';
    const answer = await translated(
      async (tx) => {
        await tx.$executeRawUnsafe(`DROP TRIGGER "Membership_t4d_architect_reserved" ON "Membership"`);
        await tx.$executeRawUnsafe(`DROP TRIGGER "Decision_t4d_architect_reserved" ON "Decision"`);
        const architect = await tx.user.create({
          data: { projectId: f.projectA.id, role: 'engineer', name: 'A5d Architect', email: `a5d-arch-${run}@test.local` },
        });
        architectMembershipId = (await tx.membership.create({
          data: { projectId: f.projectA.id, userId: architect.id, role: 'architect', status: 'active' },
        })).id;
        // a published decision BORN designated to the role (a published holder is frozen, DL-002)
        await tx.decision.create({
          data: { id: `a5d-arch-dec-${run}`, projectId: f.projectA.id, title: `A5d architect ${run}`, room: 'Kitchen', photoSwatch: 'sw1', deciderKind: 'architect', publishedAt: new Date() },
        });
      },
      (tx) => tx.membership.update({ where: { id: architectMembershipId }, data: { status: 'removed' } }),
    );
    expectConflict(answer, /held by the architect role/);
  });

  it('the rollbacks left every door standing and nothing parked', async () => {
    const doors = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = ANY($1::text[])`,
      ['Decision_t4d_awaiting_reserved', 'Decision_t4d_entry_seal', 'Decision_t4d_awaiting_paired', 'Membership_t4d_architect_reserved', 'Decision_t4d_architect_reserved'],
    );
    expect(doors[0]!.n).toBe(5);
    expect(await t.prisma.decision.count({ where: { projectId: f.projectA.id, status: 'awaiting_countersign' } })).toBe(0);
  });
});
