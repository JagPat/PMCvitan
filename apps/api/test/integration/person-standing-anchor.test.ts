import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { PHASE6_4D_RESERVATION_DOORS } from '../../src/platform/phase6-4d-rollout';
import { standingAnchorKey } from '../../src/common/standing-anchor';

/**
 * #1061 — one lock per person (`common/standing-anchor.ts`), against live PostgreSQL.
 *
 * A reader of a person's standing used to take that person's rows first, and a writer can delete and
 * re-create those rows, so a reader that waited on one could come out holding nothing and deadlock with the
 * next writer at the project row. Each case below forces the interleaving that deadlocked, through the real
 * commands, with a holder transaction H stopping the first command at a known statement. It then asserts
 * the WAIT SITE: the contender waits on the person's anchor (an advisory lock), never on a row, and every
 * command finishes with its own answer. A mark no longer retries, so a deadlock would answer 409, not 200.
 *
 * 1. an org gain, then a loss, around the member's mark (#1061's first case);
 * 2. two project re-roles around the member's mark (#1061's second case);
 * 3. a project edit by an owner/admin who is also a member, against a re-role of them;
 * 4. a forward to a role (the seal locks every holder's standing after the project row), against a
 *    holder's mark — the 4d reservation doors dropped for the case, as 4d-iii will;
 * 5. two discipline edits naming the same two people the other way round, on two projects;
 * 6, 6c. two re-roles, and two removals, naming the same two people the other way round (the up-front sorted call);
 * 7. a forward to a NAMED member, against that member's mark (the seal locks the named holder's standing too);
 * 3b, 8. a project edit and an archive stopped at the project row itself, against a re-role of the actor;
 * 9, 9b, 9c. a daily-log material add, an activity create and a photo upload (no project key; each locks
 *    or references the linked decision before its emit), against a forward of that decision to the actor;
 * 10-13b. the placements no forced deadlock reaches today (a restore, a member add, a visit attendee add,
 *    the two countersign forward-ons): stopped at a row lock after their anchors, they already hold them.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1061 — the person standing anchor (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
  /** The 4d reservation doors case 4 drops, kept so the suite puts back any a timed-out case left dropped. */
  let doors: Array<{ tgname: string; def: string }> = [];
  const http = () => request(t.app.getHttpServer());
  const pmcToken = () => t.issueProjectToken(f.memberUser.id, f.projectA.id);
  const ownerToken = () => t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);

  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** Subscribe at once (supertest and Prisma are lazy) and never reject. */
  const settle = <T>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));
  const until = async (probe: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier not reached: ${what}`);
  };
  /** The one backend, not in `seen`, waiting on a lock `holder` holds. */
  const waiterOn = async (holder: number, what: string, seen: number[] = []): Promise<number> => {
    let pid = 0;
    await until(async () => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ pid: number }>>(
        'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', holder);
      pid = rows.map((r) => Number(r.pid)).find((p) => !seen.includes(p)) ?? 0;
      return pid > 0;
    }, what);
    return pid;
  };
  /** Backend `pid` waits on `userId`'s standing anchor (the bigint advisory key, split as pg_locks shows it). */
  const waitsOnAnchor = async (pid: number, userId: string): Promise<boolean> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM pg_locks l, (SELECT hashtextextended($2, 0) AS k) x
        WHERE l.pid = $1 AND NOT l.granted AND l.locktype = 'advisory' AND l.objsubid = 1
          AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`,
      pid, standingAnchorKey(userId));
    return Number(rows[0]?.n ?? 0) === 1;
  };
  /** Open a transaction, run `body` in it, report its pid, and keep it open until released (each test also
   *  releases it when it finishes, so a red run reports at once instead of at the test timeout). */
  const hold = async (body: (tx: TestApp['prisma']) => Promise<unknown>) => {
    const ready = gate(); const release = gate();
    let pid = 0;
    const done = settle(t.prisma.$transaction(async (tx) => {
      pid = Number((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      await body(tx as unknown as TestApp['prisma']);
      ready.open();
      await release.p;
    }, { timeout: 60_000, maxWait: 10_000 }));
    await Promise.race([ready.p, done.then((r) => { if (!r.ok) throw new Error(`holder failed: ${r.e}`); })]);
    return { pid, release: release.open, done };
  };
  const status = (r: Awaited<ReturnType<typeof settle>>) => (r.ok ? (r.v as request.Response).status : r.e);
  const text = (r: Awaited<ReturnType<typeof settle>>) => (r.ok ? (r.v as request.Response).text : r.e);

  const user = async (label: string, projectId: string, role: string) => {
    const id = `t1061-${label}-${run}`;
    extraUsers.push(id);
    await t.prisma.user.create({ data: { id, projectId, role: role as never, name: `T1061 ${label}`, email: `${id}@test.local` } });
    return id;
  };
  const membership = (projectId: string, userId: string, role: string, discipline?: string) =>
    t.prisma.membership.create({ data: { projectId, userId, role: role as never, status: 'active', ...(discipline ? { discipline } : {}) } });
  const mark = (userId: string, role: string, projectId = f.projectA.id) =>
    http().post(`/projects/${projectId}/notifications/seen`).set('Authorization', `Bearer ${t.issueProjectToken(userId, projectId, role as never)}`).send({ ids: [] });
  const reRole = (userId: string, role: string, token = pmcToken(), projectId = f.projectA.id, discipline?: string) =>
    http().patch(`/projects/${projectId}/members/${userId}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID())
      .send(discipline ? { role, discipline } : { role });
  const orgRole = (userId: string, role: string) =>
    http().patch(`/orgs/${f.orgA.id}/members/${userId}`).set('Authorization', `Bearer ${ownerToken()}`).send({ role });
  const standingRows = (userId: string, projectId = f.projectA.id) =>
    t.prisma.$queryRawUnsafe<Array<{ role: string }>>(
      'SELECT role::text AS role FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 ORDER BY role', projectId, userId)
      .then((rows) => rows.map((r) => r.role));

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    const projectId = f?.projectA.id;
    try {
      if (t?.prisma && projectId) {
        await wipeDecisionEvents(t.prisma, { decision: { projectId } });
        await sanctionedReset(t.prisma, [
          'Notification', 'DecisionCountersign', 'DecisionStrandedResolution', 'DecisionApprovalRevision', 'ChangeRequest',
          'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'CommandExecution',
          'DecisionProjection', 'ProjectionGeneration', 'DomainEventPairingClaim', 'SiteVisitAttendee', 'SiteVisit',
        ], { cascade: true });
        await wipeDecisionsVia(t.prisma, async (tx) => {
          await tx.decisionForward.deleteMany({ where: { projectId } });
          await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
          await tx.decision.deleteMany({ where: { projectId } });
        });
        await t.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
        await wipeMembershipTransitionsVia(t.prisma, [...extraUsers, f.memberUser.id, f.otherUser.id]);
        await t.prisma.orgMembership.deleteMany({ where: { userId: { in: extraUsers } } });
        await t.prisma.membership.deleteMany({ where: { userId: { in: extraUsers } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: extraUsers } }, { actorUserId: { in: extraUsers } }] } });
        await t.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
      }
    } finally {
      if (t?.prisma) {
        for (const d of doors) {
          const [{ n }] = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>('SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = $1', d.tgname);
          if (n === 0) await t.prisma.$executeRawUnsafe(d.def);
        }
      }
      await f?.cleanup();
      await t?.close();
    }
  });

  it('1. an org gain, then a loss, around the member\'s mark: both role changes wait on the mark at the anchor, and all three finish', async () => {
    const u = await user('gain', f.projectA.id, 'client');
    await membership(f.projectA.id, u, 'client');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: u, role: 'member' } });
    // H stops the mark at the member's standing rows, after the reads before them
    const h = await hold((tx) => tx.$queryRawUnsafe(
      'SELECT 1 FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE', f.projectA.id, u));
    onTestFinished(() => h.release());
    const m = settle(mark(u, 'client'));
    const markPid = await waiterOn(h.pid, 'the mark waits on H at the standing rows');
    const gain = settle(orgRole(u, 'admin'));
    const gainPid = await waiterOn(markPid, 'the gain waits on the mark');
    expect(await waitsOnAnchor(gainPid, u), 'the gain waits on the member\'s anchor, not on a row').toBe(true);
    const loss = settle(orgRole(u, 'member'));
    await waiterOn(gainPid, 'the loss waits behind the gain');
    h.release();
    const [mr, gr, lr] = await Promise.all([m, gain, loss]);
    await h.done;
    expect(status(mr), text(mr)).toBe(200);
    expect(status(gr), text(gr)).toBe(200);
    expect(status(lr), text(lr)).toBe(200);
    expect(await standingRows(u)).toEqual(['client']);
    expect(await t.prisma.orgUserAuthority.count({ where: { userId: u } })).toBe(0);
  }, 60_000);

  it('2. two project re-roles around the member\'s mark: the mark waits on the first at the anchor, and every command answers', async () => {
    const u = await user('reroles', f.projectA.id, 'client');
    await membership(f.projectA.id, u, 'client');
    // H stops the first re-role at the project row (its transition seal), holding the member's anchor and rows
    const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Project" WHERE "id" = $1 FOR NO KEY UPDATE', f.projectA.id));
    onTestFinished(() => h.release());
    const a = settle(reRole(u, 'contractor'));
    const aPid = await waiterOn(h.pid, 'the first re-role waits on H at the project row');
    const m = settle(mark(u, 'client'));
    const markPid = await waiterOn(aPid, 'the mark waits on the first re-role');
    expect(await waitsOnAnchor(markPid, u), 'the mark waits on the member\'s anchor, not on a deleted row').toBe(true);
    const b = settle(reRole(u, 'engineer'));
    await waiterOn(aPid, 'the second re-role waits behind the first', [markPid]);
    h.release();
    const [ar, mr, br] = await Promise.all([a, m, b]);
    await h.done;
    expect(status(ar), text(ar)).toBe(200);
    // the mark ran after the first re-role committed: the client token no longer stands, a refusal, not a deadlock
    expect(status(mr), text(mr)).toBe(403);
    expect(status(br), text(br)).toBe(200);
    expect(await standingRows(u)).toEqual(['engineer']);
  }, 60_000);

  it('3. a project edit by an admin who is also a member, against a re-role of them: the re-role waits at the anchor, and both finish', async () => {
    const admin = await user('editor', f.projectA.id, 'pmc');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: admin, role: 'admin' } });
    await membership(f.projectA.id, admin, 'client');
    // H stops the edit after its project UPDATE, at the emit's read of the admin's org authority row
    const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "OrgUserAuthority" WHERE "userId" = $1 FOR UPDATE', admin));
    onTestFinished(() => h.release());
    const edit = settle(http().patch(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`)
      .set('Authorization', `Bearer ${t.issueOrgOwnerToken(admin, f.projectA.id, f.orgA.id)}`).send({ name: `Project A ${run}` }));
    const editPid = await waiterOn(h.pid, 'the edit waits on H');
    const r = settle(reRole(admin, 'contractor'));
    const reRolePid = await waiterOn(editPid, 'the re-role waits on the edit');
    expect(await waitsOnAnchor(reRolePid, admin), 'the re-role waits on the admin\'s anchor, before the project row').toBe(true);
    h.release();
    const [er, rr] = await Promise.all([edit, r]);
    await h.done;
    expect(status(er), text(er)).toBe(200);
    expect(status(rr), text(rr)).toBe(200);
  }, 60_000);

  it('4. a forward to the pmc role, against the mark of a holder of that role: the mark waits at the anchor, and both finish', async () => {
    doors = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS]);
    expect(doors.map((d) => d.tgname)).toEqual([...PHASE6_4D_RESERVATION_DOORS].sort());
    // what is in flight when the case ends: let go and settled before the doors go back, since putting a
    // door back on a table waits for every open transaction that touched it
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      // 4d-iii's act, rehearsed: the reservation doors dropped for this case only
      for (const d of doors) await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${/ON public\."?(\w+)"?/.exec(d.def)![1]}"`);
      // a membership-less org admin: a pmc holder the actor's own locks never touch
      const holder = await user('holder', f.projectA.id, 'pmc');
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: holder, role: 'admin' } });
      const title = `T1061 forward ${run}`;
      const pub = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
        .send({ title, room: 'Kitchen', publish: true, options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ] });
      expect(pub.status, pub.text).toBe(201);
      const decisionId = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
      // H stops the forward inside its seal, at the holder's standing rows, after the project row
      const h = await hold((tx) => tx.$queryRawUnsafe(
        'SELECT 1 FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 FOR SHARE', f.projectA.id, holder));
      const fwd = settle(http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/forward`).set('Authorization', `Bearer ${pmcToken()}`)
        .set('x-vitan-decisions-contract', 'countersign-v1').set('Idempotency-Key', randomUUID())
        .send({ toDesignationKind: 'pmc', reason: 'the PMC decides this one' }));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, fwd]) });
      const fwdPid = await waiterOn(h.pid, 'the forward waits on H at the holder\'s standing');
      const m = settle(mark(holder, 'pmc'));
      inFlight.push({ release: () => {}, settled: m });
      const markPid = await waiterOn(fwdPid, 'the mark waits on the forward', [h.pid]);
      expect(await waitsOnAnchor(markPid, holder), 'the mark waits on the holder\'s anchor, before any row').toBe(true);
      h.release();
      const [fr, mr] = await Promise.all([fwd, m]);
      await h.done;
      expect(status(fr), text(fr)).toBe(201);
      expect(status(mr), text(mr)).toBe(200);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      for (const d of doors) await t.prisma.$executeRawUnsafe(d.def);
    }
  }, 60_000);

  it('5. two discipline edits naming the same two people the other way round, on two projects: one waits on the other at the anchor, and both finish', async () => {
    const x = await user('x', f.projectA.id, 'pmc');
    const y = await user('y', f.projectB.id, 'pmc');
    expect(x < y).toBe(true);
    await membership(f.projectA.id, x, 'pmc');
    await membership(f.projectA.id, y, 'consultant', 'structural');
    await membership(f.projectB.id, y, 'pmc');
    await membership(f.projectB.id, x, 'consultant', 'structural');
    // H stops the first edit at its emit's read of the requester's standing, after it wrote the other's
    const h = await hold((tx) => tx.$queryRawUnsafe(
      'SELECT 1 FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE', f.projectA.id, x));
    onTestFinished(() => h.release());
    const e1 = settle(reRole(y, 'consultant', t.issueProjectToken(x, f.projectA.id), f.projectA.id, 'acoustics'));
    const p1 = await waiterOn(h.pid, 'the first edit waits on H');
    const e2 = settle(reRole(x, 'consultant', t.issueProjectToken(y, f.projectB.id), f.projectB.id, 'acoustics'));
    const p2 = await waiterOn(p1, 'the second edit waits on the first');
    expect(await waitsOnAnchor(p2, x), 'the second edit waits on the lower id\'s anchor, holding neither').toBe(true);
    h.release();
    const [r1, r2] = await Promise.all([e1, e2]);
    await h.done;
    expect(status(r1), text(r1)).toBe(200);
    expect(status(r2), text(r2)).toBe(200);
  }, 60_000);

  it('6. two re-roles naming the same two people the other way round, on two projects: the second waits on the first at the lower id\'s anchor, and both finish', async () => {
    const x = await user('rx', f.projectA.id, 'pmc');
    const y = await user('ry', f.projectB.id, 'pmc');
    expect(x < y).toBe(true);
    await membership(f.projectA.id, x, 'pmc');
    await membership(f.projectA.id, y, 'engineer');
    await membership(f.projectB.id, y, 'pmc');
    await membership(f.projectB.id, x, 'engineer');
    // H stops the first re-role at its requester's identity row (the fact pair), after its anchors and standing reads
    const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "UserIdentity" WHERE "userId" IN ($1, $2) ORDER BY "userId" FOR UPDATE', x, y));
    onTestFinished(() => h.release());
    const r1 = settle(reRole(y, 'contractor', t.issueProjectToken(x, f.projectA.id), f.projectA.id));
    const p1 = await waiterOn(h.pid, 'the first re-role waits on H');
    const r2 = settle(reRole(x, 'contractor', t.issueProjectToken(y, f.projectB.id), f.projectB.id));
    const p2 = await waiterOn(p1, 'the second re-role waits on the first, not on H');
    expect(await waitsOnAnchor(p2, x), 'the second re-role waits on the lower id\'s anchor, holding neither').toBe(true);
    h.release();
    const [a, b] = await Promise.all([r1, r2]);
    await h.done;
    expect(status(a), text(a)).toBe(200);
    expect(status(b), text(b)).toBe(200);
  }, 60_000);

  it('6c. two removals naming the same two people the other way round, on two projects: the second waits on the first at the lower id\'s anchor, and both finish', async () => {
    const x = await user('dx', f.projectA.id, 'pmc');
    const y = await user('dy', f.projectB.id, 'pmc');
    expect(x < y).toBe(true);
    await membership(f.projectA.id, x, 'pmc');
    await membership(f.projectA.id, y, 'engineer');
    await membership(f.projectB.id, y, 'pmc');
    await membership(f.projectB.id, x, 'engineer');
    // H stops the first re-role at its requester's identity row (the fact pair), after its anchors and standing reads
    const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "UserIdentity" WHERE "userId" IN ($1, $2) ORDER BY "userId" FOR UPDATE', x, y));
    onTestFinished(() => h.release());
    const r1 = settle(http().delete(`/projects/${f.projectA.id}/members/${y}`).set('Authorization', `Bearer ${t.issueProjectToken(x, f.projectA.id)}`).set('Idempotency-Key', randomUUID()));
    const p1 = await waiterOn(h.pid, 'the first removal waits on H');
    const r2 = settle(http().delete(`/projects/${f.projectB.id}/members/${x}`).set('Authorization', `Bearer ${t.issueProjectToken(y, f.projectB.id)}`).set('Idempotency-Key', randomUUID()));
    const p2 = await waiterOn(p1, 'the second removal waits on the first, not on H');
    expect(await waitsOnAnchor(p2, x), 'the second removal waits on the lower id\'s anchor, holding neither').toBe(true);
    h.release();
    const [a, b] = await Promise.all([r1, r2]);
    await h.done;
    expect(status(a), text(a)).toBe(200);
    expect(status(b), text(b)).toBe(200);
  }, 60_000);

  it('7. a forward to a NAMED member, against that member\'s mark: the mark waits at the anchor, and both finish', async () => {
    const named = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS]);
    doors = named;
    for (const d of named) await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${/ON public\."?(\w+)"?/.exec(d.def)![1]}"`);
    const restore = async () => { for (const d of named) await t.prisma.$executeRawUnsafe(d.def); };
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      const target = await user('named', f.projectA.id, 'engineer');
      const m = await membership(f.projectA.id, target, 'engineer');
      const title = `T1061 named ${run}`;
      const pub = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
        .send({ title, room: 'Kitchen', publish: true, options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ] });
      expect(pub.status, pub.text).toBe(201);
      const decisionId = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
      // H stops the forward inside its seal at the target's standing row (20271221:613), after the project row
      const h = await hold((tx) => tx.$queryRawUnsafe(
        'SELECT 1 FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 FOR SHARE', f.projectA.id, target));
      const fwd = settle(http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/forward`).set('Authorization', `Bearer ${pmcToken()}`)
        .set('x-vitan-decisions-contract', 'countersign-v1').set('Idempotency-Key', randomUUID())
        .send({ toDesignationKind: 'member', toDesignationMembershipId: m.id, reason: 'the engineer decides this one' }));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, fwd]) });
      const fwdPid = await waiterOn(h.pid, 'the forward waits on H at the target\'s standing');
      const mk = settle(mark(target, 'engineer'));
      inFlight.push({ release: () => {}, settled: mk });
      const markPid = await waiterOn(fwdPid, 'the mark waits on the forward', [h.pid]);
      expect(await waitsOnAnchor(markPid, target), 'the mark waits on the target\'s anchor, before any row').toBe(true);
      h.release();
      const [fr, mr] = await Promise.all([fwd, mk]);
      await h.done;
      expect(status(fr), text(fr)).toBe(201);
      expect(status(mr), text(mr)).toBe(200);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await restore();
    }
  }, 60_000);
  // 3b/8: H holds the PROJECT row, so the lifecycle write stops at its project UPDATE. With its anchor taken first
  // (the fix) it holds the actor's anchor there and the re-role waits on it; without the anchor the re-role gets the
  // actor's anchor and rows and then waits on the project row, and on release the two deadlock. Case 3 stops the edit
  // at the emit's authority row instead, after lockActorStanding has already taken the anchor, so it stays green
  // with the edit's own placement removed.
  const lifecycleVsReRole = async (label: string, send: (token: string) => request.Test, reRoleMay: number[] = [200]) => {
    const admin = await user(label, f.projectA.id, 'pmc');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: admin, role: 'admin' } });
    await membership(f.projectA.id, admin, 'client');
    // H holds the project row the reset below writes: release it, and let both commands finish, before the reset
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Project" WHERE "id" = $1 FOR NO KEY UPDATE', f.projectA.id));
      const act = settle(send(t.issueOrgOwnerToken(admin, f.projectA.id, f.orgA.id)));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, act]) });
      const actPid = await waiterOn(h.pid, 'the lifecycle write waits on H at the project row');
      const r = settle(reRole(admin, 'contractor'));
      inFlight.push({ release: () => {}, settled: r });
      const reRolePid = await waiterOn(actPid, 'the re-role waits on the lifecycle write, not on H');
      expect(await waitsOnAnchor(reRolePid, admin), 'the re-role waits on the admin\'s anchor').toBe(true);
      h.release();
      const [ar, rr] = await Promise.all([act, r]);
      await h.done;
      expect(status(ar), text(ar)).toBe(200);
      expect(reRoleMay, text(rr)).toContain(status(rr));
      return status(rr);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  };

  it('3b. a project edit, stopped at its project UPDATE, against a re-role of the editor: the re-role waits at the anchor', async () => {
    expect(await lifecycleVsReRole('editor2', (tok) => http().patch(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${tok}`).send({ name: `Project A ${run} b` }))).toBe(200);
  }, 60_000);

  // The re-role runs after the archive commits, so it must not succeed. It answers 500 today: the 4d-i seal's
  // "is archived" raise is not mapped. That race is not the anchor's: it is the same with an unrelated member
  // (design-check probe G3, base and patched), so it is pinned here as is and left to #1072.
  it('8. a project archive, stopped at its project UPDATE, against a re-role of the archiver: the re-role waits at the anchor', async () => {
    await lifecycleVsReRole('archiver', (tok) => http().delete(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${tok}`), [409, 500]);
  }, 60_000);
  // 9: a command that takes no project key and locks a row before its emit must take its actor's anchor first. A
  // daily-log material add locks the linked decision FOR SHARE; a forward of that decision to the adder holds the
  // adder's anchor exclusive from before any row and then locks the decision. With the add's anchor taken only at
  // its emit, the two deadlock (the forward is the victim, 500). H holds the daily log row, so the add stops at its
  // material insert already holding the decision.
  it('9. a daily-log material add linking a decision, against a forward of that decision to the adder: the forward waits at the anchor, and both finish', async () => {
    const named = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS]);
    doors = named;
    for (const d of named) await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${/ON public\."?(\w+)"?/.exec(d.def)![1]}"`);
    const restore = async () => { for (const d of named) await t.prisma.$executeRawUnsafe(d.def); };
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: `T1061 ${run}`, logDate: new Date('2999-01-01'), checkedIn: true } });
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      const adder = await user('adder', f.projectA.id, 'engineer');
      const m = await membership(f.projectA.id, adder, 'engineer');
      const title = `T1061 material ${run}`;
      const pub = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
        .send({ title, room: 'Kitchen', publish: true, options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ] });
      expect(pub.status, pub.text).toBe(201);
      const decisionId = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "DailyLog" WHERE "id" = $1 FOR UPDATE', log.id));
      const add = settle(http().post(`/projects/${f.projectA.id}/daily-log/materials`).set('Authorization', `Bearer ${t.issueProjectToken(adder, f.projectA.id, 'engineer' as never)}`)
        .set('Idempotency-Key', randomUUID()).send({ name: 'Cement', qty: '10 bags', decisionId }));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, add]) });
      const addPid = await waiterOn(h.pid, 'the add waits on H at its material insert, holding the decision');
      const fwd = settle(http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/forward`).set('Authorization', `Bearer ${pmcToken()}`)
        .set('x-vitan-decisions-contract', 'countersign-v1').set('Idempotency-Key', randomUUID())
        .send({ toDesignationKind: 'member', toDesignationMembershipId: m.id, reason: 'the engineer decides this one' }));
      inFlight.push({ release: () => {}, settled: fwd });
      const fwdPid = await waiterOn(addPid, 'the forward waits on the add');
      expect(await waitsOnAnchor(fwdPid, adder), 'the forward waits on the adder\'s anchor, before the decision row').toBe(true);
      h.release();
      const [ar, fr] = await Promise.all([add, fwd]);
      await h.done;
      expect(status(ar), text(ar)).toBe(201);
      expect(status(fr), text(fr)).toBe(201);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await t.prisma.siteMaterial.deleteMany({ where: { dailyLogId: log.id } });
      await t.prisma.dailyLog.delete({ where: { id: log.id } });
      await restore();
    }
  }, 60_000);
  // 9b: the same class through activities.create (no project key; it locks the linked decision FOR SHARE before its
  // emit). H holds the linker's anchor exclusive so a forward of that decision to the pmc ROLE (the linker holds it)
  // queues for it first; the create then queues behind the forward. On release the forward holds the linker's anchor
  // and needs the decision: with the create's anchor taken only at its emit, the create already holds the decision
  // and the two deadlock (one answers 500).
  it('9b. an activity create linking a decision, against a forward of that decision to the creator\'s role: both finish', async () => {
    const named = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS]);
    doors = named;
    for (const d of named) await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${/ON public\."?(\w+)"?/.exec(d.def)![1]}"`);
    const restore = async () => { for (const d of named) await t.prisma.$executeRawUnsafe(d.def); };
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    let activityName = '';
    try {
      const linker = await user('linker', f.projectA.id, 'pmc');
      await membership(f.projectA.id, linker, 'pmc');
      const title = `T1061 activity ${run}`;
      const pub = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
        .send({ title, room: 'Kitchen', publish: true, options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ] });
      expect(pub.status, pub.text).toBe(201);
      const decisionId = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
      const h = await hold((tx) => tx.$queryRawUnsafe(`SELECT 1 AS l FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS x`, standingAnchorKey(linker)));
      const fwd = settle(http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/forward`).set('Authorization', `Bearer ${pmcToken()}`)
        .set('x-vitan-decisions-contract', 'countersign-v1').set('Idempotency-Key', randomUUID())
        .send({ toDesignationKind: 'pmc', reason: 'the PMC decides this one' }));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, fwd]) });
      const fwdPid = await waiterOn(h.pid, 'the forward waits on H at the linker\'s anchor');
      expect(await waitsOnAnchor(fwdPid, linker)).toBe(true);
      activityName = `T1061 act ${run}`;
      const create = settle(http().post(`/projects/${f.projectA.id}/activities`).set('Authorization', `Bearer ${t.issueProjectToken(linker, f.projectA.id)}`)
        .set('Idempotency-Key', randomUUID()).send({ name: activityName, plannedStart: 0, plannedEnd: 1, decisionId }));
      inFlight.push({ release: () => {}, settled: create });
      await waiterOn(h.pid, 'the create waits on H at the linker\'s anchor', [fwdPid]);
      h.release();
      const [fr, cr] = await Promise.all([fwd, create]);
      await h.done;
      expect({ forward: status(fr), create: status(cr) }, `${text(fr)} / ${text(cr)}`).toEqual({ forward: 201, create: 201 });
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      if (activityName) await t.prisma.$executeRawUnsafe('DELETE FROM "Activity" WHERE "projectId" = $1 AND "name" = $2', f.projectA.id, activityName).catch(() => undefined);
      await restore();
    }
  }, 60_000);

  // 9c: the same class through a photo upload linked to a decision (no project key outside a visit; its media insert
  // takes the decision's key-share lock through the foreign key, before its emit). H holds the linker's anchor exclusive so a forward of that decision to the pmc ROLE (the linker holds it)
  // queues for it first; the create then queues behind the forward. On release the forward holds the linker's anchor
  // and needs the decision: with the create's anchor taken only at its emit, the create already holds the decision
  // and the two deadlock (one answers 500).
  it('9c. a photo upload linked to a decision, against a forward of that decision to the uploader\'s role: both finish', async () => {
    const named = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS]);
    doors = named;
    for (const d of named) await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${/ON public\."?(\w+)"?/.exec(d.def)![1]}"`);
    const restore = async () => { for (const d of named) await t.prisma.$executeRawUnsafe(d.def); };
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    let activityName = '';
    try {
      const linker = await user('uploader', f.projectA.id, 'pmc');
      await membership(f.projectA.id, linker, 'pmc');
      const title = `T1061 photo ${run}`;
      const pub = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
        .send({ title, room: 'Kitchen', publish: true, options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ] });
      expect(pub.status, pub.text).toBe(201);
      const decisionId = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
      const h = await hold((tx) => tx.$queryRawUnsafe(`SELECT 1 AS l FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS x`, standingAnchorKey(linker)));
      const fwd = settle(http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/forward`).set('Authorization', `Bearer ${pmcToken()}`)
        .set('x-vitan-decisions-contract', 'countersign-v1').set('Idempotency-Key', randomUUID())
        .send({ toDesignationKind: 'pmc', reason: 'the PMC decides this one' }));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, fwd]) });
      const fwdPid = await waiterOn(h.pid, 'the forward waits on H at the linker\'s anchor');
      expect(await waitsOnAnchor(fwdPid, linker)).toBe(true);
      activityName = `t1061-photo-${run}`;
      const create = settle(http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${t.issueProjectToken(linker, f.projectA.id)}`)
        .send({ mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), kind: 'progress', decisionId, clientKey: activityName }));
      inFlight.push({ release: () => {}, settled: create });
      await waiterOn(h.pid, 'the upload waits on H at the uploader\'s anchor', [fwdPid]);
      h.release();
      const [fr, cr] = await Promise.all([fwd, create]);
      await h.done;
      expect({ forward: status(fr), create: status(cr) }, `${text(fr)} / ${text(cr)}`).toEqual({ forward: 201, create: 201 });
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      if (activityName) await t.prisma.$executeRawUnsafe('DELETE FROM "Media" WHERE "projectId" = $1 AND "clientKey" = $2', f.projectA.id, activityName).catch(() => undefined);
      await restore();
    }
  }, 60_000);
  // 10-13: the placements no forced deadlock reaches today (a restore's project is archived, so no member command
  // contends there; the visit attendee and the forward-ons run under the readiness key every standing writer takes,
  // and the forward-ons are reserved until 4d-iii). Each still must take its anchors before its first row: H holds
  // a row the command locks after them (for 13b not the first: the stranded resolution locks the PMC's standing
  // rows first, decisions.service.ts:1656), and while the command waits there its anchors must already be held,
  // in its own mode. Without the placement nobody holds them at that point.
  /** Someone holds `userId`'s anchor in a mode that conflicts with `mode` (asked without waiting, so it never queues). */
  const anchorHeld = async (userId: string, mode: 'shared' | 'exclusive') => {
    const fn = mode === 'shared' ? 'pg_try_advisory_xact_lock_shared' : 'pg_try_advisory_xact_lock';
    const [{ got }] = await t.prisma.$queryRawUnsafe<Array<{ got: boolean }>>(`SELECT ${fn}(hashtextextended($1, 0)) AS got`, standingAnchorKey(userId));
    return !got;
  };
  /** The 4d reservation doors dropped for `body` (4d-iii's state), and put back after what it left in flight. */
  const withoutDoors = async (body: (inFlight: Array<{ release: () => void; settled: Promise<unknown> }>) => Promise<void>) => {
    const named = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS]);
    doors = named;
    for (const d of named) await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${/ON public\."?(\w+)"?/.exec(d.def)![1]}"`);
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      await body(inFlight);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      for (const d of named) await t.prisma.$executeRawUnsafe(d.def);
    }
  };
  const OPTIONS = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];
  const decisionPost = (token: string, path: string, body: object) =>
    http().post(`/projects/${f.projectA.id}/decisions${path}`).set('Authorization', `Bearer ${token}`)
      .set('x-vitan-decisions-contract', 'countersign-v1').set('Idempotency-Key', randomUUID()).send(body);
  /** An architect seated by the attributable act the chain requires (the member add), which arms the countersign chain. */
  const seatArchitect = async (label: string) => {
    const id = await user(label, f.projectA.id, 'architect');
    const r = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
      .send({ name: `T1061 ${label} ${run}`, role: 'architect', email: `${id}@test.local` });
    expect(r.status, r.text).toBe(201);
    return id;
  };
  /** A decision the client approved under an active chain, so it awaits the architect's countersign. */
  const parked = async (label: string) => {
    const title = `T1061 ${label} ${run}`;
    const pub = await decisionPost(pmcToken(), '', { title, room: 'Kitchen', publish: true, options: OPTIONS });
    expect(pub.status, pub.text).toBe(201);
    const id = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
    const ok = await decisionPost(t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client'), `/${id}/approve`, { optionIndex: 0 });
    expect(ok.status, ok.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('awaiting_countersign');
    return id;
  };

  it('10. a project restore, stopped at its project UPDATE: it already holds the restorer\'s anchor', async () => {
    const admin = await user('restorer', f.projectA.id, 'pmc');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: admin, role: 'admin' } });
    await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: new Date() } });
    // H holds the project row the reset below writes: release it, and let the restore finish, before the reset
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Project" WHERE "id" = $1 FOR NO KEY UPDATE', f.projectA.id));
      const r = settle(http().post(`/orgs/${f.orgA.id}/projects/${f.projectA.id}/restore`)
        .set('Authorization', `Bearer ${t.issueOrgOwnerToken(admin, f.projectA.id, f.orgA.id)}`));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, r]) });
      await waiterOn(h.pid, 'the restore waits on H at the project row');
      expect(await anchorHeld(admin, 'exclusive'), 'the restore holds the restorer\'s anchor before the project row').toBe(true);
      h.release();
      const rr = await r;
      await h.done;
      expect([200, 201], text(rr)).toContain(status(rr));
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  }, 60_000);

  it('11. a member add, stopped at the requester\'s identity row (the fact pair): it already holds the new member\'s anchor exclusive', async () => {
    const target = await user('added', f.projectA.id, 'engineer');
    const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "UserIdentity" WHERE "userId" IN ($1, $2) ORDER BY "userId" FOR UPDATE', f.memberUser.id, target));
    onTestFinished(() => h.release());
    const r = settle(http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
      .send({ name: `T1061 added ${run}`, role: 'engineer', email: `${target}@test.local` }));
    await waiterOn(h.pid, 'the add waits on H at an identity row');
    expect(await anchorHeld(target, 'shared'), 'the add holds the new member\'s anchor exclusive before any row').toBe(true);
    h.release();
    const rr = await r;
    await h.done;
    expect(status(rr), text(rr)).toBe(201);
    expect(rr.ok && (rr.v as request.Response).body.userId).toBe(target);
  }, 60_000);

  // 12: the visit's one sorted call takes BOTH people's anchors before EITHER's rows. The re-takes that follow
  // (`lockActorStanding` for the visitor, then for the attendee) would take the attendee's only after the visitor's
  // rows, so two visits naming the same two people the other way round could each hold one person's rows and wait
  // on the other's anchor. H holds the visitor's standing rows, so the add stops at the first of them.
  it('12. a visit attendee add, stopped at the visitor\'s standing rows: it already holds the attendee\'s anchor', async () => {
    const attendee = await user('att', f.projectA.id, 'engineer');
    await membership(f.projectA.id, attendee, 'engineer');
    const visitorToken = pmcToken();
    const visitId = randomUUID();
    const started = await http().post(`/projects/${f.projectA.id}/site-visits`).set('Authorization', `Bearer ${visitorToken}`)
      .send({ id: visitId, claimedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    expect(started.status, started.text).toBe(201);
    const h = await hold((tx) => tx.$queryRawUnsafe(
      'SELECT 1 FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE', f.projectA.id, f.memberUser.id));
    onTestFinished(() => h.release());
    const r = settle(http().post(`/projects/${f.projectA.id}/site-visits/${visitId}/attendees`).set('Authorization', `Bearer ${visitorToken}`)
      .set('Idempotency-Key', randomUUID()).send({ id: randomUUID(), userId: attendee, role: 'engineer' }));
    await waiterOn(h.pid, 'the attendee add waits on H at the visitor\'s standing rows');
    expect(await anchorHeld(attendee, 'exclusive'), 'the add holds the attendee\'s anchor before the visitor\'s rows').toBe(true);
    h.release();
    const rr = await r;
    await h.done;
    expect(status(rr), text(rr)).toBe(201);
  }, 60_000);

  it('13. a disagreement forwarding on to a named member, stopped at the decision row: it already holds the new holder\'s anchor exclusive', async () => {
    await withoutDoors(async (inFlight) => {
      const architect = await seatArchitect('arch');
      try {
        const eng = await user('fwdon', f.projectA.id, 'engineer');
        const m = await membership(f.projectA.id, eng, 'engineer');
        const id = await parked('disagree');
        const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Decision" WHERE "id" = $1 FOR UPDATE', id));
        const r = settle(decisionPost(t.issueProjectToken(architect, f.projectA.id, 'architect'), `/${id}/disagree`,
          { path: 'forward_on', toDesignationKind: 'member', toDesignationMembershipId: m.id, reason: 'the engineer should decide this one' }));
        inFlight.push({ release: h.release, settled: Promise.all([h.done, r]) });
        await waiterOn(h.pid, 'the disagreement waits on H at the decision row');
        expect(await anchorHeld(eng, 'shared'), 'the disagreement holds the new holder\'s anchor before the decision row').toBe(true);
        h.release();
        const rr = await r;
        expect(status(rr), text(rr)).toBe(201);
      } finally {
        // the chain ends with this case (while the doors are still down), so the next case's decision is stranded
        for (const x of inFlight) x.release();
        await Promise.all(inFlight.map((x) => x.settled));
        const gone = await http().delete(`/projects/${f.projectA.id}/members/${architect}`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID());
        expect(gone.status, gone.text).toBe(200);
      }
    });
  }, 60_000);

  it('13b. a stranded resolution returning to a named member, stopped at the decision row: it already holds the new holder\'s anchor exclusive', async () => {
    await withoutDoors(async (inFlight) => {
      const architect = await seatArchitect('arch2');
      const eng = await user('strand', f.projectA.id, 'engineer');
      const m = await membership(f.projectA.id, eng, 'engineer');
      const id = await parked('stranded');
      const gone = await http().delete(`/projects/${f.projectA.id}/members/${architect}`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID());
      expect(gone.status, gone.text).toBe(200);
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Decision" WHERE "id" = $1 FOR UPDATE', id));
      const r = settle(decisionPost(pmcToken(), `/${id}/stranded`,
        { outcome: 'returned', toDesignationKind: 'member', toDesignationMembershipId: m.id, reason: 'the engineer should decide this one' }));
      inFlight.push({ release: h.release, settled: Promise.all([h.done, r]) });
      await waiterOn(h.pid, 'the resolution waits on H at the decision row');
      expect(await anchorHeld(eng, 'shared'), 'the resolution holds the new holder\'s anchor before the decision row').toBe(true);
      h.release();
      const rr = await r;
      expect(status(rr), text(rr)).toBe(201);
    });
  }, 60_000);
});
