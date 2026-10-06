import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, wipeMembershipTransitionsVia, type TwoProjectFixture } from './fixtures';
import { emitEvent, type EmitInput } from '../../src/platform/events';
import { STALE_ROLE_MESSAGE, resolveActorEnvelope } from '../../src/platform/actor-envelope';
import type { EventActor } from '../../src/common/actor';
import { OrgsService } from '../../src/orgs/orgs.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d-iii / R0a-2 — every HUMAN event carries the frozen pair, proven against live
 * PostgreSQL (`docs/superpowers/plans/2026-10-05-4d-iii-additive-units.md`, R0).
 *
 * - Decision 2: `emitEvent` refuses a human actor whose token role no longer stands on the project with
 *   a re-sign-in (403, {@link STALE_ROLE_MESSAGE}), before the stream counter moves. The whole command
 *   rolls back; the act is never recorded with an empty attribution.
 * - Decision 1: an org owner/admin acting on a project is attributed in a PROJECT role: `pmc` when they
 *   hold no active membership there (the windowed owner/admin arm), else their membership's role.
 * - A `system` actor still emits with no pair: R0b admits the system pair, and R0c writes it.
 */
describe('4d-iii / R0a-2 — emitEvent refuses an unresolved human pair (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let orgs: OrgsService;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    orgs = t.app.get(OrgsService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    const created = await t.prisma.project.findMany({ where: { name: { startsWith: 'R0A2 ' } }, select: { id: true } });
    for (const p of created) {
      await t.prisma.auditLog.deleteMany({ where: { projectId: p.id } });
      await t.prisma.notification.deleteMany({ where: { projectId: p.id } });
      await t.prisma.commandExecution.deleteMany({ where: { projectId: p.id } });
      await t.prisma.membership.deleteMany({ where: { projectId: p.id } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: p.id } });
      await t.prisma.project.delete({ where: { id: p.id } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const human = (actorId: string, actorRole: string): EventActor => ({ actorId, actorRole, actorKind: 'human' });

  const input = (actor: EventActor, projectId = f.projectA.id): EmitInput => ({
    projectId, actor, eventType: 'activity.completion_requested', entityType: 'Activity',
    entityId: `R0A2-${randomUUID()}`, effectKey: 'activity.completion_requested',
    dispatch: { push: { body: 'completion requested' } },
  });

  const position = async (projectId: string) =>
    (await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId } })).nextPosition;

  const eventCount = (projectId: string) => t.prisma.domainEvent.count({ where: { projectId } });

  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(
      `SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId,
    ))[0]?.displayName;

  /** Expect a 403 carrying the re-sign-in message, and nothing written: no event, no stream move. */
  const expectRefusedUnchanged = async (actor: EventActor) => {
    const before = { pos: await position(f.projectA.id), events: await eventCount(f.projectA.id) };
    const err = await t.prisma.$transaction((tx) => emitEvent(tx, input(actor))).then(() => null, (e: unknown) => e);
    expect(err, `${actor.actorId} as ${actor.actorRole} must be refused`).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe(STALE_ROLE_MESSAGE);
    expect({ pos: await position(f.projectA.id), events: await eventCount(f.projectA.id) }).toEqual(before);
  };

  it('an active member acting in the role they hold still emits, with the pair', async () => {
    const { eventId } = await t.prisma.$transaction((tx) => emitEvent(tx, input(human(f.memberUser.id, 'pmc'))));
    const ev = await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId } });
    expect(ev).toMatchObject({ actorRole: 'pmc', actorName: await identityName(f.memberUser.id) });
  });

  it('refuses a token role the actor does not hold (a client member claiming pmc)', async () => {
    await expectRefusedUnchanged(human(f.clientUser.id, 'pmc'));
  });

  it('refuses an actor with no standing on the project (another tenant, a stranger)', async () => {
    await expectRefusedUnchanged(human(f.otherUser.id, 'pmc'));
    await expectRefusedUnchanged(human(f.strangerUser.id, 'pmc'));
  });

  it('refuses a blank token role', async () => {
    await expectRefusedUnchanged(human(f.memberUser.id, '  '));
  });

  it('a re-role after the token was issued refuses the act, and the command’s other writes roll back with it', async () => {
    // A temporary member issued a `pmc` token, then re-roled to engineer: the token role no longer stands.
    const u = await t.prisma.user.create({ data: { id: `r0a2-rerole-${randomUUID().slice(0, 8)}`, name: 'Rerole', email: `${randomUUID()}@test.local`, role: 'pmc', projectId: f.projectA.id } });
    try {
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: u.id, role: 'pmc', status: 'active' } });
      await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: u.id } }, data: { role: 'engineer' } });
      const nameBefore = (await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id } })).descriptor;
      const err = await t.prisma.$transaction(async (tx) => {
        await tx.project.update({ where: { id: f.projectA.id }, data: { descriptor: 'written by a stale role' } });
        return emitEvent(tx, input(human(u.id, 'pmc')));
      }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toBe(STALE_ROLE_MESSAGE);
      expect((await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id } })).descriptor).toBe(nameBefore);
    } finally {
      await t.prisma.membership.deleteMany({ where: { userId: u.id } });
      await t.prisma.user.delete({ where: { id: u.id } });
    }
  });

  it('a system actor still emits with no pair (R0b admits the system pair, R0c writes it)', async () => {
    const { eventId } = await t.prisma.$transaction((tx) =>
      emitEvent(tx, input({ actorId: 'system:r0a2-probe', actorRole: 'system', actorKind: 'system' })));
    expect(await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId } })).toMatchObject({ actorKind: 'system', actorRole: null, actorName: null });
  });

  const projectInput = () => ({
    name: `R0A2 ${seq}`, short: `r0a2-${seq++}-${randomUUID().slice(0, 4)}`, descriptor: '', stage: 'Planning',
    siteCode: '', location: '', projStart: '', projEnd: '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const pairsOf = async (projectId: string, eventType?: string) =>
    t.prisma.domainEvent.findMany({
      where: { projectId, actorKind: 'human', ...(eventType ? { eventType } : {}) },
      select: { eventType: true, actorId: true, actorRole: true, actorName: true },
    });

  it('Decision 1: a membership-less org owner’s project creation is attributed as pmc on every event it emits', async () => {
    const p = await orgs.createProject(f.orgA.id, f.ownerUser.id, projectInput());
    const events = await pairsOf(p.id);
    expect(events.length, 'creation emits at least project.created').toBeGreaterThan(0);
    const name = await identityName(f.ownerUser.id);
    for (const ev of events) expect(ev, ev.eventType).toMatchObject({ actorId: f.ownerUser.id, actorRole: 'pmc', actorName: name });
  });

  it('Decision 1: a membership-less org owner’s edit, archive and restore are attributed as pmc', async () => {
    const p = await orgs.createProject(f.orgA.id, f.ownerUser.id, projectInput());
    // the creator is enrolled as the project's pmc; end that membership so the owner acts membership-less
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: p.id, userId: f.ownerUser.id } }, data: { status: 'removed' } });
    await orgs.updateProject(f.orgA.id, f.ownerUser.id, p.id, { descriptor: 'edited' } as never);
    await orgs.deleteProject(f.orgA.id, f.ownerUser.id, p.id);
    await orgs.restoreProject(f.orgA.id, f.ownerUser.id, p.id);
    const name = await identityName(f.ownerUser.id);
    for (const type of ['project.updated', 'project.archived', 'project.restored']) {
      const [ev] = await pairsOf(p.id, type);
      expect(ev, type).toMatchObject({ actorId: f.ownerUser.id, actorRole: 'pmc', actorName: name });
    }
  });

  it('Decision 1: an org owner who holds an active membership on the project is attributed in that membership’s role', async () => {
    const p = await orgs.createProject(f.orgA.id, f.ownerUser.id, projectInput());
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: p.id, userId: f.ownerUser.id } }, data: { role: 'client' } });
    await orgs.updateProject(f.orgA.id, f.ownerUser.id, p.id, { descriptor: 'edited as client' } as never);
    const [ev] = await pairsOf(p.id, 'project.updated');
    expect(ev).toMatchObject({ actorId: f.ownerUser.id, actorRole: 'client', actorName: await identityName(f.ownerUser.id) });
  });

  it('a member command on the actor’s OWN membership announces them as they stood: an owner adding themselves', async () => {
    // The membership event is emitted with the transition fact's pair, BEFORE the membership write:
    // the envelope seal judges the pair at INSERT, and once the membership-less owner holds an
    // engineer membership the windowed arm no longer admits their `pmc` token role.
    const members = t.app.get(MembersService);
    const requester = { sub: f.ownerUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
    const { email } = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id }, select: { email: true } });
    try {
      await members.add(f.projectA.id, requester, { name: 'owner', role: 'engineer', email: email! }, `r0a2-self-${randomUUID()}`);
      const [ev] = await pairsOf(f.projectA.id, 'membership.added');
      expect(ev).toMatchObject({ actorId: f.ownerUser.id, actorRole: 'pmc', actorName: await identityName(f.ownerUser.id) });
    } finally {
      await wipeMembershipTransitionsVia(t.prisma, [f.ownerUser.id]);
      await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: f.ownerUser.id } });
    }
  });

  it('Codex 4199574223: an owner/admin demoted after the pre-transaction check is refused INSIDE the lifecycle write, even when another membership role would still attribute it', async () => {
    // An org ADMIN who also holds a `client` membership on the project. Attribution would record
    // `client`, a pair the demotion does not disturb, so only an in-transaction authority check can
    // refuse the stale act. The demotion lands between the service's read and its write: the read is
    // made to answer as it did before the demotion committed.
    const p = await orgs.createProject(f.orgA.id, f.ownerUser.id, projectInput());
    const adm = await t.prisma.user.create({ data: { id: `r0a2-adm-${randomUUID().slice(0, 8)}`, name: 'Adm', email: `${randomUUID()}@test.local`, role: 'client', projectId: p.id } });
    const stale = vi.spyOn(orgs as unknown as { orgRole: (o: string, u: string) => Promise<string | null> }, 'orgRole');
    try {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: adm.id, role: 'admin' } });
      await t.prisma.membership.create({ data: { projectId: p.id, userId: adm.id, role: 'client', status: 'active' } });
      await t.prisma.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: adm.id } }, data: { role: 'member' } });
      stale.mockResolvedValue('admin');
      const before = { project: await t.prisma.project.findUniqueOrThrow({ where: { id: p.id } }), events: await eventCount(p.id) };
      for (const act of [
        () => orgs.updateProject(f.orgA.id, adm.id, p.id, { descriptor: 'by a demoted admin' } as never),
        () => orgs.deleteProject(f.orgA.id, adm.id, p.id),
        () => orgs.restoreProject(f.orgA.id, adm.id, p.id),
      ]) {
        await expect(act()).rejects.toBeInstanceOf(ForbiddenException);
      }
      const after = await t.prisma.project.findUniqueOrThrow({ where: { id: p.id } });
      expect([after.descriptor, after.archivedAt]).toEqual([before.project.descriptor, before.project.archivedAt]);
      expect(await eventCount(p.id)).toBe(before.events);
    } finally {
      stale.mockRestore();
      await t.prisma.membership.deleteMany({ where: { userId: adm.id } });
      await t.prisma.orgMembership.deleteMany({ where: { userId: adm.id } });
      await t.prisma.user.delete({ where: { id: adm.id } });
    }
  });

  it('a member command on user U and a concurrent command BY U take standing, then stream, in one order: neither deadlocks', async () => {
    // U's own command holds U's standing rows (its envelope locks them FOR SHARE) and then needs the
    // project's stream. The member command re-roling U emits BEFORE its membership write, so it must
    // take U's rows before the stream too, or the two wait on each other and PostgreSQL aborts one.
    const members = t.app.get(MembersService);
    const u = await t.prisma.user.create({ data: { id: `r0a2-dl-${randomUUID().slice(0, 8)}`, name: 'Deadlock U', email: `${randomUUID()}@test.local`, role: 'engineer', projectId: f.projectA.id } });
    try {
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: u.id, role: 'engineer', status: 'active' } });
      let resolve!: () => void;
      const held = new Promise<void>((r) => { resolve = r; });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const byU = t.prisma.$transaction(async (tx) => {
        expect(await resolveActorEnvelope(tx, f.projectA.id, human(u.id, 'engineer'))).not.toBeNull();
        resolve();
        await released;
        return emitEvent(tx, input(human(u.id, 'engineer')));
      }, { timeout: 30_000 });
      await held;
      const requester = { sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
      const reRole = members.updateRole(f.projectA.id, requester, u.id, { role: 'contractor' } as never, `r0a2-dl-${randomUUID()}`);
      // the re-role must now be WAITING on a lock U's transaction holds — condition-based, not a sleep
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < deadline && waiting === 0) {
        const [row] = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'`);
        waiting = Number(row?.n ?? 0);
      }
      expect(waiting, 'the re-role is blocked on a lock U holds').toBeGreaterThan(0);
      release();
      const [mine, theirs] = await Promise.allSettled([byU, reRole]);
      expect(mine.status, mine.status === 'rejected' ? String(mine.reason) : '').toBe('fulfilled');
      expect(theirs.status, theirs.status === 'rejected' ? String(theirs.reason) : '').toBe('fulfilled');
      expect((await t.prisma.membership.findUniqueOrThrow({ where: { projectId_userId: { projectId: f.projectA.id, userId: u.id } } })).role).toBe('contractor');
    } finally {
      await wipeMembershipTransitionsVia(t.prisma, [u.id]);
      await t.prisma.membership.deleteMany({ where: { userId: u.id } });
      await t.prisma.user.delete({ where: { id: u.id } });
    }
  });
});
