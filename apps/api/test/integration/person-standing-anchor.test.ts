import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
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
 * 5. two discipline edits naming the same two people the other way round, on two projects;
 * 6, 6c. two re-roles, and two removals, naming the same two people the other way round (the up-front sorted call);
 * 3b, 8. a project edit and an archive stopped at the project row itself, against a re-role of the actor;
 * 10-12. the placements no forced deadlock reaches today (a restore, a member add, a visit attendee add):
 *    stopped at a row lock after their anchors, they already hold them.
 *
 * The decision forward and its countersign forward-ons take their anchors in a later unit, after the standing
 * projection is serialized for direct writers (#1100); the forward stays reserved until 4d-iii. Their cases
 * (4, 7, 13, 13b), and the forced cases for the three decision-linking commands that take their anchor up front
 * here (9, 9b, 9c: only a forward reaches them), arrive with it.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1061 — the person standing anchor (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
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

  // 10-12: the placements no forced deadlock reaches today (a restore's project is archived, so no member command
  // contends there; the visit attendee add runs under the readiness key every app standing writer takes). Each
  // still must take its anchors before its first row: H holds a row the command locks after them, and while the
  // command waits there its anchors must already be held, in its own mode. Without the placement nobody holds
  // them at that point.
  /** Someone holds `userId`'s anchor in a mode that conflicts with `mode` (asked without waiting, so it never queues). */
  const anchorHeld = async (userId: string, mode: 'shared' | 'exclusive') => {
    const fn = mode === 'shared' ? 'pg_try_advisory_xact_lock_shared' : 'pg_try_advisory_xact_lock';
    const [{ got }] = await t.prisma.$queryRawUnsafe<Array<{ got: boolean }>>(`SELECT ${fn}(hashtextextended($1, 0)) AS got`, standingAnchorKey(userId));
    return !got;
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
});
