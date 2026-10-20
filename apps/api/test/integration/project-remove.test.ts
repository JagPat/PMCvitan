import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, insertRawEvent, type TwoProjectFixture } from './fixtures';
import { inventoryProject } from '../../src/platform/project-inventory';
import { OUTBOX_QUIET_MINUTES, removeProject, type RemovalOptions } from '../../src/platform/project-remove';

/**
 * #482 — step 3, the removal of one project by the list Board reviewed. A dry run changes nothing
 * and shows what a commit would do; a commit removes exactly the listed rows, moves QA users' home
 * project to a protected project they already belong to, and leaves every trigger as it was. It
 * refuses, before any write, a target that is not archived, a list that no longer matches the
 * database, a non-QA account, a user with no membership where they would move, an archived
 * destination, and a delivery that is leased or was touched lately.
 */
describe('project:remove — one project, by the reviewed list (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const letters = (): string => Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const run = letters();
  const logId = `it-rm-log-${run}`;
  const eventId = randomUUID();
  const receipt = `it-rm-receipt-${run}`;
  const qaId = `it-rm-qa-${run}`;
  const qaEmail = `qa.${run}@vitan.in`;
  const loneId = `it-rm-lone-${run}`;
  // a staff account whose home is elsewhere and whose last-used project is the target (jp@ on #482)
  const staffId = `it-rm-staff-${run}`;
  const staffEmail = `staff.${run}@vitan.in`;
  let streamPosition = 0;

  const opts = async (over: Partial<RemovalOptions> = {}): Promise<RemovalOptions> => ({
    projectId: f.projectA.id,
    inventory: await inventoryProject(t.prisma, f.projectA.id),
    protect: [f.projectB.id],
    rehomeTo: f.projectB.id,
    commit: false,
    ...over,
  });
  const projectExists = async (id: string): Promise<boolean> => (await t.prisma.project.count({ where: { id } })) === 1;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    const a = f.projectA.id;
    await t.prisma.projectNode.create({ data: { projectId: a, name: 'Zone', kind: 'zone' } });
    await t.prisma.media.create({ data: { id: `it-rm-media-${run}`, projectId: a, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc', clientKey: `it-rm-media-key-${run}` } });
    // a deleted photo's record (#482): sealed against a direct DELETE, so the removal has to take it as it does events
    await t.prisma.mediaTombstone.create({ data: { projectId: a, clientKey: `it-rm-key-${run}` } });
    await t.prisma.dailyLog.create({ data: { id: logId, projectId: a, date: '01 Jun 2026', logDate: new Date('2026-06-01') } });
    await t.prisma.crewRow.create({ data: { dailyLogId: logId, trade: 'Mason', count: 4, order: 0 } });
    // an append-only event of the project and a consumer's receipt for it, held with no foreign key
    streamPosition = await insertRawEvent(t.prisma, { projectId: a, organizationId: f.orgA.id, eventId });
    await t.prisma.processedEvent.create({ data: { id: receipt, consumer: 'it-remove', eventId } });
  });

  afterAll(async () => {
    await t?.prisma.processedEvent.deleteMany({ where: { id: receipt } });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: [qaId, loneId, staffId] } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: [qaId, loneId, staffId] } } });
    if (f && await projectExists(f.projectA.id)) {
      await t.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
      await t.prisma.crewRow.deleteMany({ where: { dailyLogId: logId } });
      await t.prisma.dailyLog.deleteMany({ where: { id: logId } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id } });
    }
    await f?.cleanup();
    await t?.close();
  });

  it('refuses a project that is not archived', async () => {
    const r = await removeProject(t.prisma, await opts());
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/is not archived/);
    expect(await projectExists(f.projectA.id)).toBe(true);
    await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: new Date() } });
  });

  it('refuses, changing nothing, while a non-QA account has the project as its home project', async () => {
    const r = await removeProject(t.prisma, await opts());
    expect(r.outcome).toBe('refused');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not QA accounts/);
    expect(r.reason).toContain(f.memberUser.email);
    expect(await projectExists(f.projectA.id)).toBe(true);
  });

  it('refuses a QA user who has no membership where their home project would move', async () => {
    // the fixture's own users leave the target; only QA accounts point at it from here on
    await t.prisma.user.updateMany({ where: { projectId: f.projectA.id }, data: { projectId: f.projectB.id } });
    await t.prisma.user.create({ data: { id: loneId, projectId: f.projectA.id, role: 'pmc', name: 'lone', email: `qa.${letters()}@vitan.in` } });
    const r = await removeProject(t.prisma, await opts());
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/would need a membership/);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: loneId } })).projectId).toBe(f.projectA.id);
    await t.prisma.user.delete({ where: { id: loneId } });
  });

  it('refuses a list that no longer matches the database, and an archived destination', async () => {
    await t.prisma.user.create({ data: { id: qaId, projectId: f.projectA.id, lastProjectId: f.projectB.id, role: 'pmc', name: 'qa', email: qaEmail } });
    await t.prisma.user.create({ data: { id: staffId, projectId: f.projectB.id, lastProjectId: f.projectA.id, role: 'pmc', name: 'staff', email: staffEmail } });
    // the QA account's membership on the destination is a row from before the #482 QA company lock, as the live QA
    // accounts' are: the lock refuses a QA account in an unmarked company, and this fixture's company holds real people
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Membership" DISABLE TRIGGER "Membership_qa_lock"`);
    try {
      await t.prisma.membership.create({ data: { projectId: f.projectB.id, userId: qaId, role: 'pmc', status: 'active' } });
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "Membership" ENABLE TRIGGER "Membership_qa_lock"`);
    }
    const stale = await opts();
    const node = await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: 'Late', kind: 'zone' } });
    const r = await removeProject(t.prisma, stale);
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/no longer matches the reviewed list.*ProjectNode/);
    await t.prisma.projectNode.delete({ where: { id: node.id } });

    await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
    try {
      const archived = await removeProject(t.prisma, await opts());
      expect(archived.outcome).toBe('refused');
      expect(archived.reason).toMatch(/is archived/);
    } finally {
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
    }
  });

  it('refuses while one of the project\'s deliveries is leased or lately touched (it may be mid-send)', async () => {
    const d = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: 'socket.invalidation' } });
    const quiet = `now() - interval '${OUTBOX_QUIET_MINUTES + 1} minutes'`;
    const set = (sql: string) => t.prisma.$executeRawUnsafe(`UPDATE "OutboxDelivery" SET ${sql} WHERE id = $1`, d.id);
    const settleAll = () => t.prisma.$executeRawUnsafe(`UPDATE "OutboxDelivery" SET "updatedAt" = ${quiet} WHERE "projectId" = $1`, f.projectA.id);
    // the event's deliveries were all written just now; every other one is settled from here on
    await settleAll();
    // the event's own delivery, as the relay holds it while it sends
    await set(`"status" = 'leased', "leaseOwner" = 'it-relay', "leaseExpiresAt" = now() + interval '1 minute', "updatedAt" = ${quiet}`);
    const leased = await removeProject(t.prisma, await opts());
    expect(leased.outcome).toBe('refused');
    expect(leased.reason).toMatch(/1 outbox delivery\(ies\) of the project are leased or changed/);
    // settled by another relay a moment ago, after the first one's lease ran out: it may still be sending
    await set(`"status" = 'succeeded', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()`);
    const recent = await removeProject(t.prisma, await opts());
    expect(recent.outcome).toBe('refused');
    expect(recent.reason).toMatch(/1 outbox delivery\(ies\)/);
    // quiet since: every delivery of the project counts as settled, and the removal lists and removes them
    await settleAll();
  });

  it('refuses at once, changing nothing, while another transaction holds an uncommitted photo write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    // an upload in the other project, mid-transaction: it holds "Media" and would write its event next
    const writer = t.prisma.$transaction(async (tx) => {
      await tx.media.create({ data: { projectId: f.projectB.id, kind: 'progress', mime: 'image/png', data: Buffer.from('x'), sizeBytes: 1, uploadedBy: 'pmc' } });
      held();
      await gate;
      throw new Error('the writer rolls back');
    }, { timeout: 30_000 }).catch(() => undefined);
    await holding;
    const offTriggers = async () => t.prisma.$queryRawUnsafe<Array<{ name: string }>>(`SELECT tgname::text AS name FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D' ORDER BY 1`);
    const offBefore = await offTriggers();
    try {
      const r = await removeProject(t.prisma, await opts());
      // refused, not failed: it never waited for the writer until its lock_timeout
      expect(r).toMatchObject({ ok: false, outcome: 'refused' });
      expect(r.reason).toMatch(/another transaction is writing one of .*"?Media"?/);
      expect(await projectExists(f.projectA.id)).toBe(true);
      expect(await t.prisma.domainEvent.count({ where: { eventId } })).toBe(1);
      expect(r.triggers.disabled).toEqual([]);
    } finally {
      release();
      await writer;
    }
    // every trigger is as it was
    expect(await offTriggers()).toEqual(offBefore);
  });

  it('dry run: does everything, every check holds, and nothing is changed', async () => {
    const o = await opts();
    const r = await removeProject(t.prisma, o);
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ ok: true, mode: 'dry-run', outcome: 'rolled back' });
    for (const table of ['Project', 'ProjectNode', 'CrewRow', 'DailyLog', 'Media', 'MediaTombstone', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent']) {
      expect(r.removed[table], table).toEqual(o.inventory.keys[table]);
    }
    expect(Object.keys(r.added)).toEqual([]);
    expect(Object.keys(r.changed)).toEqual(['User']);
    expect(r.rehomed).toEqual([{ id: qaId, email: qaEmail, fromProjectId: f.projectA.id, toProjectId: f.projectB.id, lastProjectId: f.projectB.id }]);
    // a non-QA account pointed at only by its last-used project is not refused: that pointer is cleared
    expect(r.lastProjectCleared).toEqual([{ id: staffId, email: staffEmail }]);
    expect(r.users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: qaId, linkedBy: 'User.projectId' }),
      expect.objectContaining({ id: staffId, linkedBy: 'User.lastProjectId' }),
    ]));
    expect(r.users).toHaveLength(2);
    expect(r.changed.User).toHaveLength(2);
    // tables no project path reaches are named and unchanged: Org, OrgMembership, UserIdentity
    for (const table of ['Org', 'OrgMembership', 'UserIdentity']) {
      expect(r.unlinked.find((u) => u.table === table), table).toMatchObject({ unchanged: true });
    }
    expect(r.protected).toEqual([expect.objectContaining({ projectId: f.projectB.id, removed: [], keysUnchanged: true })]);
    expect(r.triggers.disabled.map((d) => d.name)).toEqual(expect.arrayContaining(['DomainEvent_append_only', 'MediaTombstone_immutable', 'Media_tombstone_on_delete']));
    expect(r.triggers.restored).toBe(true);
    expect(r.counts.Project.after).toBe(r.counts.Project.before - 1);
    expect(r.files).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'Media', id: `it-rm-media-${run}` })]));
    // rolled back: the project, its event and the user's home are as they were
    expect(await projectExists(f.projectA.id)).toBe(true);
    expect(await t.prisma.domainEvent.count({ where: { eventId } })).toBe(1);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: qaId } })).projectId).toBe(f.projectA.id);
  });

  it('commit: removes exactly the listed rows, moves the QA user home, and restores every trigger', async () => {
    const triggers = async () => t.prisma.$queryRawUnsafe<Array<{ name: string; enabled: string }>>(
      `SELECT tgname::text AS name, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`);
    const before = await triggers();
    const bBefore = await inventoryProject(t.prisma, f.projectB.id);
    const r = await removeProject(t.prisma, await opts({ commit: true }));
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ ok: true, mode: 'commit', outcome: 'committed' });
    expect(await projectExists(f.projectA.id)).toBe(false);
    expect(await t.prisma.domainEvent.count({ where: { eventId } })).toBe(0);
    expect(await t.prisma.processedEvent.count({ where: { id: receipt } })).toBe(0);
    expect(await t.prisma.crewRow.count({ where: { dailyLogId: logId } })).toBe(0);
    expect(await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id } })).toBe(0);
    const qa = await t.prisma.user.findUniqueOrThrow({ where: { id: qaId } });
    expect({ projectId: qa.projectId, lastProjectId: qa.lastProjectId }).toEqual({ projectId: f.projectB.id, lastProjectId: f.projectB.id });
    const staff = await t.prisma.user.findUniqueOrThrow({ where: { id: staffId } });
    expect({ projectId: staff.projectId, lastProjectId: staff.lastProjectId }).toEqual({ projectId: f.projectB.id, lastProjectId: null });
    expect(await triggers()).toEqual(before);
    const bAfter = await inventoryProject(t.prisma, f.projectB.id);
    const { User: _u1, ...restBefore } = bBefore.keys;
    const { User: _u2, ...restAfter } = bAfter.keys;
    expect(restAfter).toEqual(restBefore);
  });
});
