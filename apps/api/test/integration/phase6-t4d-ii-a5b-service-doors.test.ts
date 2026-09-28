import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import {
  PHASE6_4D_DRAIN_DIRECTIVE, PHASE6_4D_RESERVATION_DOORS, assertPhase6_4dOpen, readPhase6_4dRollout,
} from '../../src/platform/phase6-4d-rollout';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5b — the reservation doors on the SERVICE path (§A.1; P28b's service
 * arms), proven against live PostgreSQL with 4d-i's doors standing.
 *
 * The zod enums admit `architect` from this unit, so every command naming the role now reaches its
 * service, which refuses it 409 naming the drain directive BEFORE any write, judged by the ONE catalog
 * read the shell's `rollout.phase6_4d` is baked from. RED at base: the enums refused the value with a
 * 400, so no 409 naming the directive was ever returned, and the shell had no rollout field.
 */
describe('4d-ii-a / A5b — the service refuses every architect shape while the reservation stands (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  const run = randomUUID().slice(0, 8);
  const email = (label: string) => `a5b-${label}-${run}@test.local`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await sanctionedReset(t.prisma, ['MembershipTransition'], { cascade: true });
    const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 'a5b-', endsWith: `-${run}@test.local` } }, select: { id: true } });
    const ids = provisioned.map((u) => u.id);
    await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
    await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
    await t.prisma.commandExecution.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { projectId }] } });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const auth = <R extends { set: (k: string, v: string) => R }>(r: R) => r.set('Authorization', `Bearer ${pmcToken}`);
  const expectDrainRefusal = (r: request.Response) => {
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toContain(PHASE6_4D_DRAIN_DIRECTIVE);
  };
  const options = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  it('the reservation stands on this database: the read says `reserved`, and the shell carries it', async () => {
    expect(await readPhase6_4dRollout(t.prisma)).toBe('reserved');
    const shell = await auth(http().get(`/projects/${f.projectA.id}/shell`));
    expect(shell.status, shell.text).toBe(200);
    expect(shell.body.rollout).toEqual({ phase6_4d: 'reserved' });
  });

  it('members.add in the architect role, by a NEW email: 409, and NO identity, membership or receipt left behind', async () => {
    const addr = email('add');
    const receipts = () => t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'members.add' } });
    const before = await receipts();
    const r = await auth(http().post(`/projects/${f.projectA.id}/members`)).send({ name: 'A5b Architect', role: 'architect', email: addr });
    expectDrainRefusal(r);
    expect(await t.prisma.user.count({ where: { email: addr } })).toBe(0);
    expect(await t.prisma.membership.count({ where: { projectId: f.projectA.id, role: 'architect' } })).toBe(0);
    expect(await receipts(), 'the refusal rolled the receipt back with everything else').toBe(before);
  });

  it('members.updateRole into the architect role: 409, and the member keeps their role', async () => {
    const added = await auth(http().post(`/projects/${f.projectA.id}/members`)).send({ name: 'A5b Engineer', role: 'engineer', email: email('rerole') });
    expect(added.status, added.text).toBe(201);
    const r = await auth(http().patch(`/projects/${f.projectA.id}/members/${added.body.userId}`)).send({ role: 'architect' });
    expectDrainRefusal(r);
    expect((await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: added.body.userId } })).role).toBe('engineer');
  });

  it('decisions.create designating the architect role, as a draft and as a published issue: 409, and no decision born', async () => {
    for (const publish of [false, true]) {
      const title = `A5b ${publish ? 'issued' : 'draft'} ${run}`;
      const r = await auth(http().post(`/projects/${f.projectA.id}/decisions`)).set('Idempotency-Key', randomUUID())
        .send({ title, room: 'Kitchen', publish, deciderKind: 'architect', options });
      expectDrainRefusal(r);
      expect(await t.prisma.decision.count({ where: { projectId: f.projectA.id, title } })).toBe(0);
    }
  });

  it('decisions.updateDraft re-pointing a draft at the architect role: 409, and the draft keeps its decider', async () => {
    const title = `A5b repoint ${run}`;
    const created = await auth(http().post(`/projects/${f.projectA.id}/decisions`)).set('Idempotency-Key', randomUUID())
      .send({ title, room: 'Kitchen', publish: false, options });
    expect(created.status, created.text).toBe(201);
    const draft = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    const r = await auth(http().patch(`/projects/${f.projectA.id}/decisions/${draft.id}/draft`)).set('Idempotency-Key', randomUUID())
      .send({ deciderKind: 'architect' });
    expectDrainRefusal(r);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: draft.id } })).deciderKind).toBe('client');
  });

  it('the dev session refuses the architect role before either branch', async () => {
    const prev = process.env.ALLOW_DEV_AUTH;
    process.env.ALLOW_DEV_AUTH = 'true';
    try {
      const r = await http().post('/auth/session').send({ role: 'architect', projectId: f.projectA.id });
      expectDrainRefusal(r);
      // the gate is the role, not the dev path: another role still gets its session
      expect((await http().post('/auth/session').send({ role: 'engineer', projectId: f.projectA.id })).status).toBe(201);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_DEV_AUTH;
      else process.env.ALLOW_DEV_AUTH = prev;
    }
  });

  it('the read follows the doors: with them dropped (in a transaction rolled back) it reads `open` and the assertion passes', async () => {
    const sentinel = new Error('rollback');
    await expect(t.prisma.$transaction(async (tx) => {
      expect(await readPhase6_4dRollout(tx)).toBe('reserved');
      await expect(assertPhase6_4dOpen(tx, 'probe')).rejects.toThrow(PHASE6_4D_DRAIN_DIRECTIVE);
      // FAIL CLOSED: any one door standing keeps the state reserved
      const [first, ...rest] = PHASE6_4D_RESERVATION_DOORS;
      for (const door of rest) {
        const table = (await tx.$queryRaw<Array<{ relname: string }>>(Prisma.sql`
          SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = ${door}`))[0]?.relname;
        if (table) await tx.$executeRawUnsafe(`DROP TRIGGER "${door}" ON "${table}"`);
      }
      expect(await readPhase6_4dRollout(tx), `${first} alone still reserves`).toBe('reserved');
      const table = (await tx.$queryRaw<Array<{ relname: string }>>(Prisma.sql`
        SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = ${first}`))[0]!.relname;
      await tx.$executeRawUnsafe(`DROP TRIGGER "${first}" ON "${table}"`);
      expect(await readPhase6_4dRollout(tx)).toBe('open');
      await assertPhase6_4dOpen(tx, 'probe');
      throw sentinel;
    })).rejects.toBe(sentinel);
    // and the rollback restored every door
    expect(await readPhase6_4dRollout(t.prisma)).toBe('reserved');
  });
});
