import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OrgsService } from '../../src/orgs/orgs.service';
import { lockOrgStanding, lockProjectReadiness } from '../../src/common/readiness-lock';
import { lockOrgStandingWriters } from '../../src/orgs/org-standing';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A3c — the org key, proven against live PostgreSQL.
 *
 * The phantom it closes: an owner/admin org write fans its standing out over the org's projects
 * (4d-i's `OrgMembership_t4d_user_standing`), and a new project seeds its owners/admins from the
 * org (`Project_t4d_user_standing`). Each trigger reads only what is committed or visible in its
 * own snapshot, so a creation and a grant that overlap each miss the other, and the new owner has
 * no `pmc` standing on the new project. With the org key they cannot overlap, in either order.
 *
 * Each race is driven deterministically: a test transaction holds the key, the racing call is
 * started and observed WAITING on an advisory lock (`pg_stat_activity`), and only then does the
 * holder commit.
 *
 * - GRANT FIRST: the holder is the grant itself. The creation's SERIALIZABLE snapshot is taken as
 *   it starts waiting, so it predates the grant; without the org-row check the new project's
 *   trigger would seed from that stale snapshot and miss the new owner.
 * - CREATION FIRST: the creation takes the key ahead of a queued grant, so the grant enumerates
 *   the org's projects only after the new one is committed.
 * - DEMOTION FIRST: an admin who passed the creation's fast authority read is demoted by a write
 *   that held the key; the creation's in-key re-judge refuses them (403), and nothing is created.
 * - A PROMOTION takes every project's readiness key, not only a reduction.
 */
describe('4d-ii-a / A3c — owner/admin org writes and project creation serialize on the org key (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let orgs: OrgsService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    orgs = t.app.get(OrgsService);
  });

  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    const created = await t.prisma.project.findMany({ where: { name: { startsWith: `A3C ${run} ` } }, select: { id: true } });
    for (const p of created) {
      await t.prisma.auditLog.deleteMany({ where: { projectId: p.id } });
      await t.prisma.membership.deleteMany({ where: { projectId: p.id } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: p.id } });
      await t.prisma.project.delete({ where: { id: p.id } });
    }
    await t.prisma.orgMembership.deleteMany({ where: { userId: { in: userIds } } });
    await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: userIds } }, { actorUserId: { in: userIds } }] } });
    await t.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await f?.cleanup();
    await t?.close();
  });

  /** A user in the fixture's org, optionally holding an org role already. */
  const person = async (label: string, orgRole?: 'owner' | 'admin' | 'member') => {
    const id = `a3c-${label}-${run}`;
    const user = await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'pmc', name: `A3C ${label}`, email: `${id}@test.local` } });
    userIds.push(user.id);
    if (orgRole) await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: user.id, role: orgRole } });
    return user;
  };

  const projectInput = () => {
    const n = seq++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { name: `A3C ${run} ${n}`, short: `a3c-${run}-${n}`, descriptor: '', stage: 'Planning', siteCode: '', location: '', projStart: '', projEnd: '', modules: [] } as any;
  };

  const pmcStanding = async (projectId: string, userId: string) =>
    t.prisma.$queryRaw<Array<{ membershipId: string | null }>>`
      SELECT "membershipId" FROM "ProjectUserStanding" WHERE "projectId" = ${projectId} AND "userId" = ${userId} AND "role" = 'pmc'`;

  // ── the deterministic barrier: a call is proven to be WAITING on an advisory key ──────────────
  const advisoryWaiters = async (): Promise<number> => {
    const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%'`;
    return rows[0]!.c;
  };
  const waitForWaiters = async (n: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await advisoryWaiters()) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier timeout: expected ${n} advisory-lock waiter(s)`);
  };

  /**
   * Hold a transaction open: `setup` runs first (it takes the key), then the transaction waits
   * until `release` is called, then `finish` runs and the transaction commits.
   */
  const hold = (setup: (tx: Parameters<Parameters<TestApp['prisma']['$transaction']>[0]>[0]) => Promise<void>,
    finish: (tx: Parameters<Parameters<TestApp['prisma']['$transaction']>[0]>[0]) => Promise<void> = async () => undefined) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const started = new Promise<void>((r) => { ready = r; });
    const done = t.prisma.$transaction(async (tx) => {
      await setup(tx);
      ready();
      await gate;
      await finish(tx);
    }, { timeout: 30_000 });
    return { started, release, done };
  };

  /** Settle a promise into its outcome without an unhandled rejection while it is pending. */
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

  it('GRANT FIRST: a creation that waited on the grant re-reads, and the new owner has pmc standing on the new project', async () => {
    const newOwner = await person('grant-first');
    const holder = hold(
      async (tx) => { await lockOrgStandingWriters(tx, f.orgA.id); },
      async (tx) => { await tx.orgMembership.create({ data: { orgId: f.orgA.id, userId: newOwner.id, role: 'owner' } }); },
    );
    await holder.started;
    const creation = outcome(orgs.createProject(f.orgA.id, f.ownerUser.id, projectInput()));
    await waitForWaiters(1);
    holder.release();
    await holder.done;
    const r = await creation;
    expect(r.ok, String(!r.ok && r.error)).toBe(true);
    const projectId = (r as { value: { id: string } }).value.id;
    expect(await pmcStanding(projectId, newOwner.id)).toEqual([{ membershipId: null }]);
    // and the creator's own standing is the membership the creation wrote
    expect(await pmcStanding(projectId, f.ownerUser.id)).toHaveLength(1);
  });

  it('CREATION FIRST: a grant queued behind a creation enumerates the new project, and fans its standing out to it', async () => {
    const newAdmin = await person('creation-first');
    // the holder takes ONLY the key (no org write): the creation queues first, then the grant
    const holder = hold(async (tx) => { await lockOrgStanding(tx, f.orgA.id); });
    await holder.started;
    const creation = outcome(orgs.createProject(f.orgA.id, f.ownerUser.id, projectInput()));
    await waitForWaiters(1);
    const grant = outcome(orgs.addOrgMember(f.orgA.id, f.ownerUser.id, { name: newAdmin.name, email: newAdmin.email!, role: 'admin' }));
    await waitForWaiters(2);
    holder.release();
    await holder.done;
    const [c, g] = await Promise.all([creation, grant]);
    expect(c.ok, String(!c.ok && c.error)).toBe(true);
    expect(g.ok, String(!g.ok && g.error)).toBe(true);
    const projectId = (c as { value: { id: string } }).value.id;
    expect(await pmcStanding(projectId, newAdmin.id)).toEqual([{ membershipId: null }]);
  });

  it('DEMOTION FIRST: an admin demoted by a write that held the key is refused 403 by the in-key re-judge, and nothing is created', async () => {
    const admin = await person('demoted', 'admin');
    const before = await t.prisma.project.count({ where: { orgId: f.orgA.id } });
    const holder = hold(
      async (tx) => { await lockOrgStandingWriters(tx, f.orgA.id); },
      async (tx) => { await tx.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: admin.id } }, data: { role: 'member' } }); },
    );
    await holder.started;
    // the fast authority read runs now, before the demotion commits, and passes
    const creation = outcome(orgs.createProject(f.orgA.id, admin.id, projectInput()));
    await waitForWaiters(1);
    holder.release();
    await holder.done;
    const r = await creation;
    expect(r.ok).toBe(false);
    expect((r as { error: unknown }).error).toBeInstanceOf(ForbiddenException);
    expect(String((r as { error: { message: string } }).error.message)).toMatch(/org role changed/);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id } })).toBe(before);
  });

  it('a PROMOTION takes every project readiness key: it waits while a project key is held', async () => {
    const promoted = await person('promoted', 'member');
    const holder = hold(async (tx) => { await lockProjectReadiness(tx, f.projectA.id); });
    await holder.started;
    let settled = false;
    const promotion = outcome(orgs.updateOrgMemberRole(f.orgA.id, f.ownerUser.id, promoted.id, { role: 'admin' })).finally(() => { settled = true; });
    await waitForWaiters(1);
    expect(settled).toBe(false);
    holder.release();
    await holder.done;
    const r = await promotion;
    expect(r.ok, String(!r.ok && r.error)).toBe(true);
    expect(await pmcStanding(f.projectA.id, promoted.id)).toEqual([{ membershipId: null }]);
  });
});
