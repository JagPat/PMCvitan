import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { RoleStandingQuery } from '../../src/platform/role-standing.query';
import { lockProjectReadiness } from '../../src/common/readiness-lock';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5c — the KERNEL standing reads (§A.2), proven against live PostgreSQL
 * over 4d-i's registers, which the orgs-owned triggers project from `Membership`:
 *
 * - `RoleStandingQuery` answers from `ProjectRoleStanding` / `ProjectUserStanding`, the registers the
 *   seals read, never an orgs table;
 * - `countersignRequired` is overlaid by both decision read paths when an active architect holds the
 *   role, and ABSENT otherwise, so a project with no chain is served exactly today's DTO;
 * - the orgs participant's `effectiveRoleHolderUserIds` answers the `architect` audience from the
 *   kernel register.
 *
 * No architect can exist while 4d-i's reservation stands, so the chain arm runs inside a transaction
 * that opens the `Membership` door, seats an architect through the delivered projection triggers, reads
 * everything on that transaction, and ROLLS BACK: the door and the registers are as they were after.
 */
describe('4d-ii-a / A5c — the kernel standing reads and the countersign overlay (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let orgs: OrgsParticipant;
  let pmcToken: string;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    orgs = t.app.get(OrgsParticipant);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const r = await request(t.app.getHttpServer()).post(`/projects/${f.projectA.id}/decisions`)
      .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({
        title: `A5c ${run}`, room: 'Kitchen', publish: true,
        options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ],
      });
    expect(r.status, r.text).toBe(201);
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await f?.cleanup();
    await t?.close();
  });

  it('with no architect: the kernel reads say so, and no decision DTO carries countersignRequired', async () => {
    expect(await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect')).toBe(0);
    expect(await RoleStandingQuery.holderUserIds(t.prisma, f.projectA.id, 'architect')).toEqual([]);
    // the per-user register answers every role: the fixture's pmc member holds `pmc`
    expect(await RoleStandingQuery.holdsRole(t.prisma, f.projectA.id, f.memberUser.id, 'pmc')).toBe(true);
    expect(await RoleStandingQuery.holdsRole(t.prisma, f.projectA.id, f.memberUser.id, 'architect')).toBe(false);

    const live = await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id);
    expect(live.decisions.length).toBeGreaterThan(0);
    for (const d of live.decisions) expect(Object.prototype.hasOwnProperty.call(d, 'countersignRequired')).toBe(false);
    const served = await request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken}`);
    expect(served.status, served.text).toBe(200);
    for (const d of served.body.decisions) expect(d).not.toHaveProperty('countersignRequired');
    expect(await orgs.effectiveRoleHolderUserIds(t.prisma, f.projectA.id, 'architect')).toEqual([]);
  });

  it('with an active architect (inside a rolled-back transaction): the kernel reads, the overlay and the audience all see the chain', async () => {
    const sentinel = new Error('rollback');
    let architectId = '';
    await expect(t.prisma.$transaction(async (tx) => {
      await lockProjectReadiness(tx, f.projectA.id);
      // 4d-iii's act, rehearsed and undone: open the Membership door, seat an architect through the
      // delivered projection triggers
      await tx.$executeRawUnsafe(`DROP TRIGGER "Membership_t4d_architect_reserved" ON "Membership"`);
      const architect = await tx.user.create({
        data: { projectId: f.projectA.id, role: 'engineer', name: 'A5c Architect', email: `a5c-arch-${run}@test.local` },
      });
      architectId = architect.id;
      await tx.membership.create({ data: { projectId: f.projectA.id, userId: architect.id, role: 'architect', status: 'active' } });

      expect(await RoleStandingQuery.activeCount(tx, f.projectA.id, 'architect')).toBe(1);
      expect(await RoleStandingQuery.holderUserIds(tx, f.projectA.id, 'architect')).toEqual([architect.id]);
      expect(await RoleStandingQuery.holdsRole(tx, f.projectA.id, architect.id, 'architect')).toBe(true);
      // the consultation requester's architect arm asks exactly this read
      expect(await RoleStandingQuery.holdsRole(tx, f.projectA.id, f.memberUser.id, 'architect')).toBe(false);

      // the overlay: every DTO of the response says the chain is active
      const live = await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id, tx);
      expect(live.decisions.length).toBeGreaterThan(0);
      for (const d of live.decisions) expect(d.countersignRequired).toBe(true);

      // the push audience for the role is the kernel register
      expect(await orgs.effectiveRoleHolderUserIds(tx, f.projectA.id, 'architect')).toEqual([architect.id]);
      throw sentinel;
    })).rejects.toBe(sentinel);

    // …and the rollback undid it all: the door stands, the architect never existed
    expect(await RoleStandingQuery.activeCount(t.prisma, f.projectA.id, 'architect')).toBe(0);
    expect(await t.prisma.user.count({ where: { id: architectId } })).toBe(0);
    const door = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'Membership_t4d_architect_reserved'`);
    expect(door[0]!.n).toBe(1);
  });

  it('pmc and client audiences keep the delivered orgs-truth SQL while the rollout reads reserved', async () => {
    // the fixture's membership-less org OWNER holds pmc through the delivered org arm, which the
    // fanned-out register may lack in the 4d-i → 4d-iii window; the delivered SQL still names them
    const pmcHolders = await orgs.effectiveRoleHolderUserIds(t.prisma, f.projectA.id, 'pmc');
    expect(pmcHolders).toEqual(expect.arrayContaining([f.memberUser.id, f.ownerUser.id]));
    expect(await orgs.effectiveRoleHolderUserIds(t.prisma, f.projectA.id, 'client')).toEqual([f.clientUser.id]);
  });
});
