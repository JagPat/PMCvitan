import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import type { Role } from '../../src/common/auth';

/**
 * Top 10 #4b unit C (#778) — `POST /projects/:projectId/notifications/seen { ids }` and per-notice
 * `unread`, against live PostgreSQL (owner record #482 6110925123).
 *
 * - every role confirms exactly the submitted ids it is served, and only its own receipts are written;
 * - a mixed batch confirms only its served ids; a hidden, a foreign and an unknown id answer
 *   byte-identically, and an earlier receipt for a now-hidden id confirms nothing;
 * - repeated and concurrent submissions converge on one receipt;
 * - a notice committing after the feed was read stays unread;
 * - eligibility is judged at the read: a notice hidden between the read and the write keeps its
 *   receipt and is confirmed; one deleted in between is not;
 * - removal, re-role, org demotion, a phantom grant and archive each serialize with a mark, both
 *   orders, at a DETERMINISTIC barrier (the contender is observed blocked on the holder);
 * - concurrent marks and org-authority writes never deadlock;
 * - a malformed, oversized or unauthorized request writes nothing.
 *
 * Isolated automated-test fixtures only: none of this establishes production or role-live QA.
 */
describe('Top 10 #4b unit C — the seen mark and per-notice unread (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshot: SnapshotService;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
  const decisions: string[] = [];

  const http = () => request(t.app.getHttpServer());
  const mark = (token: string, body: unknown, projectId = f.projectA.id) =>
    http().post(`/projects/${projectId}/notifications/seen`).set('Authorization', `Bearer ${token}`).send(body as object);
  const tokenOf = (userId: string, role: Role) => t.issueProjectToken(userId, f.projectA.id, role);
  const pmcToken = () => tokenOf(f.memberUser.id, 'pmc');

  /** A user with an active membership in project A. */
  const member = async (role: Role, label: string): Promise<string> => {
    const id = `t4bc-${label}-${run}`;
    extraUsers.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `T4BC ${label}`, email: `${id}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    return id;
  };
  /** A membership-less admin of project A's org: `pmc` through the windowed org arm. */
  const orgAdmin = async (label: string): Promise<string> => {
    const id = `t4bc-${label}-${run}`;
    extraUsers.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'pmc', name: `T4BC ${label}`, email: `${id}@test.local` } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: id, role: 'admin' } });
    return id;
  };
  const notice = async (text: string, extra: { decisionId?: string } = {}, projectId = f.projectA.id) =>
    (await t.prisma.notification.create({ data: { projectId, text: `${text} ${run}`, color: '#000', time: 'just now', ...extra } })).id;
  /** A published, client-held decision through the real command; returns its id and its kinded notice. */
  const publish = async (label: string): Promise<{ id: string; title: string; kinded: string }> => {
    const title = `T4BC ${label} ${randomUUID().slice(0, 8)}`;
    const r = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken()}`).set('Idempotency-Key', randomUUID())
      .send({ title, room: 'Kitchen', publish: true, options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ] });
    expect(r.status, r.text).toBe(201);
    const id = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
    decisions.push(id);
    const kinded = (await t.prisma.notification.findFirstOrThrow({ where: { decisionId: id, kind: 'decision.published' } })).id;
    return { id, title, kinded };
  };
  const withdraw = async (decisionId: string) => {
    const w = await http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/withdraw`).set('Authorization', `Bearer ${pmcToken()}`)
      .set('Idempotency-Key', randomUUID()).send({ reason: 'Scope changed' });
    expect(w.status, w.text).toBe(201);
  };
  const receipts = (userId: string, ids?: string[]) =>
    t.prisma.notificationReceipt.findMany({ where: { userId, ...(ids ? { notificationId: { in: ids } } : {}) }, select: { notificationId: true } })
      .then((rows) => rows.map((r) => r.notificationId).sort());
  const servedIds = async (role: Role, userId: string) => (await snapshot.build(f.projectA.id, role, userId)).notifications.map((n) => n.id);
  const unreadOf = async (role: Role, userId: string) =>
    new Map((await snapshot.build(f.projectA.id, role, userId)).notifications.map((n) => [n.id, n.unread]));

  /** A promise resolvable from outside, to hold a transaction open at a known point. */
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** Subscribe at once (supertest and Prisma are lazy) and never reject. */
  const settle = <T>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));
  const until = async (probe: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier not reached: ${what}`);
  };
  /** Some backend is waiting on a lock the backend `holder` holds. */
  const blockedBy = (holder: number, what: string) => until(async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', holder);
    return Number(rows[0]?.n ?? 0) > 0;
  }, what);
  /** The backends waiting on a lock `holder` holds (to name exactly which request is held). */
  const waitersOn = async (holder: number): Promise<number[]> =>
    (await t.prisma.$queryRawUnsafe<Array<{ pid: number }>>(
      'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', holder)).map((r) => Number(r.pid));
  /** The backends blocking the statement tagged with `tag`. */
  const blockersOfTag = async (tag: string): Promise<number[]> =>
    (await t.prisma.$queryRawUnsafe<Array<{ blockers: number[] }>>(
      `SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()`, `%${tag}%`))
      .flatMap((r) => r.blockers.map(Number));
  /** A statement tagged with `tag` is waiting on a lock. */
  const tagWaits = (tag: string, what: string) => until(async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`, `%${tag}%`);
    return Number(rows[0]?.n ?? 0) > 0;
  }, what);
  /** Open a transaction, run `body` in it, report its backend pid, and keep it open until released. */
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
    return { pid: () => pid, release: release.open, done };
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshot = t.app.get(SnapshotService);
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await sanctionedReset(t.prisma, ['Notification', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await t.prisma.auditLog.deleteMany({ where: { projectId } });
    await t.prisma.orgMembership.deleteMany({ where: { userId: { in: extraUsers } } });
    await t.prisma.membership.deleteMany({ where: { userId: { in: extraUsers } } });
    await t.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    await f?.cleanup();
    await t?.close();
  });

  it('every role confirms exactly the submitted ids it is served, writes only its own receipts, and reads them back as seen', async () => {
    const d = await publish('roles');
    const plain = await notice('plain');
    const pendingUnlinked = await notice('Decision awaiting approval: legacy');
    const withdrawnText = await notice('Decision withdrawn: legacy — gone');
    const foreign = await notice('foreign', {}, f.projectB.id);
    const submitted = [plain, pendingUnlinked, withdrawnText, d.kinded, foreign, `unknown-${run}`];

    const viewers: Array<[Role, string, string[]]> = [
      ['pmc', f.memberUser.id, [plain, pendingUnlinked, withdrawnText, d.kinded]],
      // the membership-less org owner is pmc through the windowed arm
      ['pmc', f.ownerUser.id, [plain, pendingUnlinked, withdrawnText, d.kinded]],
      ['client', f.clientUser.id, [plain, pendingUnlinked, d.kinded]],
      ['engineer', await member('engineer', 'eng'), [plain]],
      ['contractor', await member('contractor', 'con'), [plain]],
      ['consultant', await member('consultant', 'cst'), [plain]],
    ];
    for (const [role, userId, expected] of viewers) {
      // the shared served definition and the pinned expectation agree
      expect((await servedIds(role, userId)).filter((id) => submitted.includes(id)).sort(), `${role} ${userId} served`).toEqual([...expected].sort());
      const before = await unreadOf(role, userId);
      for (const id of expected) expect(before.get(id), `${role}: ${id} starts unread`).toBe(true);

      const r = await mark(tokenOf(userId, role), { ids: submitted });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toEqual({ confirmed: expected });
      expect(await receipts(userId, submitted)).toEqual([...expected].sort());
      const after = await unreadOf(role, userId);
      for (const id of expected) expect(after.get(id), `${role}: ${id} is now seen`).toBe(false);
    }
    // read state is per viewer: the pmc's receipts left a fresh viewer's feed unread
    const fresh = await member('contractor', 'fresh');
    expect((await unreadOf('contractor', fresh)).get(plain)).toBe(true);

    // a worker device token and an architect token are refused with no receipt (the architect role is not yet
    // holdable on a project, 4d-i's reservation; a worker device is never served the feed)
    for (const role of ['worker', 'architect'] as const) {
      const r = await mark(tokenOf(`t4bc-${role}-${run}`, role), { ids: submitted });
      expect([401, 403], `${role} refused`).toContain(r.status);
      expect(await t.prisma.notificationReceipt.count({ where: { userId: `t4bc-${role}-${run}` } })).toBe(0);
    }
  });

  it('a mixed batch confirms only its served ids; hidden, foreign and unknown ids answer identically, and an old receipt for a hidden id confirms nothing', async () => {
    const client = f.clientUser.id;
    const clientToken = tokenOf(client, 'client');
    const served = await notice('served');
    const d = await publish('hidden');
    // the client is served the published notice and marks it, then the decision is withdrawn: hidden from the client
    expect((await mark(clientToken, { ids: [d.kinded] })).body).toEqual({ confirmed: [d.kinded] });
    await withdraw(d.id);
    expect(await servedIds('client', client)).not.toContain(d.kinded);
    const foreign = await notice('foreign', {}, f.projectB.id);
    const unknown = `unknown-${randomUUID()}`;

    const r = await mark(clientToken, { ids: [served, d.kinded, foreign, unknown] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ confirmed: [served] });
    expect(await receipts(client, [served, d.kinded, foreign, unknown])).toEqual([served, d.kinded].sort());
    expect(await t.prisma.notificationReceipt.count({ where: { notificationId: foreign } })).toBe(0);

    // each alone: byte-identical answers, whether the id exists here (with a receipt), elsewhere, or nowhere
    const alone = await Promise.all([d.kinded, foreign, unknown].map(async (id) => {
      const res = await mark(clientToken, { ids: [id] });
      return `${res.status} ${res.headers['content-type']} ${res.text}`;
    }));
    expect(new Set(alone).size).toBe(1);
    expect(alone[0]).toMatch(/^200 application\/json.* \{"confirmed":\[\]\}$/);
  });

  it('repeated and concurrent submissions converge on one receipt and answer the same', async () => {
    const client = f.clientUser.id;
    const n = await notice('converge');
    const once = await mark(tokenOf(client, 'client'), { ids: [n, n] });
    expect(once.body).toEqual({ confirmed: [n] });
    const again = await mark(tokenOf(client, 'client'), { ids: [n] });
    expect(again.body).toEqual({ confirmed: [n] });
    const m = await notice('converge-concurrent');
    const all = await Promise.all(Array.from({ length: 4 }, () => mark(tokenOf(client, 'client'), { ids: [m] })));
    for (const r of all) expect([r.status, r.body]).toEqual([200, { confirmed: [m] }]);
    expect(await t.prisma.notificationReceipt.count({ where: { notificationId: { in: [n, m] }, userId: client } })).toBe(2);
  });

  it('a notice committing after the feed was read is not in it, stays unread through the mark, and is marked on its own', async () => {
    const client = f.clientUser.id;
    const late = { id: '' };
    const writer = await hold(async (tx) => {
      late.id = (await tx.notification.create({ data: { projectId: f.projectA.id, text: `late ${run}`, color: '#000', time: 'just now' } })).id;
    });
    const shown = await servedIds('client', client);
    expect(shown).not.toContain(late.id);
    expect((await mark(tokenOf(client, 'client'), { ids: shown })).status).toBe(200);
    writer.release();
    expect((await writer.done).ok).toBe(true);

    const feed = await unreadOf('client', client);
    expect(feed.get(late.id), 'the late notice is served unread').toBe(true);
    for (const id of shown) if (feed.has(id)) expect(feed.get(id)).toBe(false);
    expect((await mark(tokenOf(client, 'client'), { ids: [late.id] })).body).toEqual({ confirmed: [late.id] });
  });

  it('eligibility is fixed at the read: a notice hidden between the read and the write is still recorded and confirmed; one deleted is not', async () => {
    const client = f.clientUser.id;
    const d = await publish('read-hide-write');
    // a kind-less pending notice linked to the decision: the withdrawal DELETES it
    const pending = await notice(`Decision awaiting approval: ${d.title}`, { decisionId: d.id });
    expect(await servedIds('client', client)).toEqual(expect.arrayContaining([d.kinded, pending]));

    // hold the client's standing rows so the mark's write waits after its eligibility read
    const holder = await hold(async (tx) => {
      await tx.$queryRawUnsafe('SELECT 1 FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE', f.projectA.id, client);
    });
    const marking = settle(mark(tokenOf(client, 'client'), { ids: [d.kinded, pending] }));
    await blockedBy(holder.pid(), 'the mark\'s write waits on the client\'s standing rows');
    // between the read and the write: the decision is withdrawn (the kinded notice hidden, the kind-less one deleted)
    await withdraw(d.id);
    expect(await servedIds('client', client)).not.toContain(d.kinded);
    expect(await t.prisma.notification.count({ where: { id: pending } })).toBe(0);
    holder.release();
    await holder.done;

    const r = await marking;
    expect(r.ok && r.v.status).toBe(200);
    expect(r.ok && r.v.body).toEqual({ confirmed: [d.kinded] });
    expect(await receipts(client, [d.kinded, pending])).toEqual([d.kinded]);
  });

  /**
   * One authority change and a mark, in both orders, at deterministic barriers:
   * - change first: the change is held open; the mark's write is observed waiting on it; the change commits
   *   and the mark is refused 403 with no receipt;
   * - mark first: a lock the mark takes after its standing locks (the project row, or a notice row) is held;
   *   the mark is observed waiting on it; the change is observed waiting on the mark; release, and the mark
   *   commits its receipt while the change completes after it.
   */
  const bothOrders = async (opts: {
    label: string;
    actor: () => Promise<{ userId: string; role: Role }>;
    change: (tag: string) => string;
    params: (userId: string) => unknown[];
    markFirstHold?: 'project' | 'notice';
    /** undo the committed change-first arm before the mark-first arm (a shared row, e.g. the project) */
    reset?: () => Promise<unknown>;
  }) => {
    // change first
    {
      const { userId, role } = await opts.actor();
      const n = await notice(`${opts.label}-change-first`);
      const holder = await hold((tx) => tx.$executeRawUnsafe(opts.change(`cf-${run}`), ...opts.params(userId)));
      const marking = settle(mark(tokenOf(userId, role), { ids: [n] }));
      await blockedBy(holder.pid(), `${opts.label}: the mark waits on the uncommitted change`);
      holder.release();
      expect((await holder.done).ok).toBe(true);
      const r = await marking;
      expect(r.ok && r.v.status, `${opts.label}: change first → refused`).toBe(403);
      expect(await t.prisma.notificationReceipt.count({ where: { notificationId: n } })).toBe(0);
      await opts.reset?.();
    }
    // mark first
    {
      const { userId, role } = await opts.actor();
      const n = await notice(`${opts.label}-mark-first`);
      const holder = await hold((tx) => opts.markFirstHold === 'notice'
        ? tx.$queryRawUnsafe('SELECT 1 FROM "Notification" WHERE "id" = $1 FOR UPDATE', n)
        : tx.$queryRawUnsafe('SELECT 1 FROM "Project" WHERE "id" = $1 FOR UPDATE', f.projectA.id));
      const marking = settle(mark(tokenOf(userId, role), { ids: [n] }));
      await blockedBy(holder.pid(), `${opts.label}: the mark holds its standing locks and waits on the held row`);
      const tag = `mf-${opts.label}-${randomUUID().slice(0, 8)}`;
      const changing = settle(t.prisma.$executeRawUnsafe(opts.change(tag), ...opts.params(userId)));
      await tagWaits(tag, `${opts.label}: the change waits on the mark`);
      holder.release();
      await holder.done;
      const r = await marking;
      expect(r.ok && [r.v.status, r.v.body], `${opts.label}: mark first → recorded`).toEqual([200, { confirmed: [n] }]);
      expect((await changing).ok, `${opts.label}: the change completes after the mark`).toBe(true);
      expect(await t.prisma.notificationReceipt.count({ where: { notificationId: n, userId } })).toBe(1);
    }
  };

  it('a membership removal serializes with a mark, both orders', async () => {
    await bothOrders({
      label: 'removal',
      actor: async () => ({ userId: await member('contractor', `rm-${randomUUID().slice(0, 6)}`), role: 'contractor' }),
      change: (tag) => `UPDATE /* ${tag} */ "Membership" SET "status" = 'removed' WHERE "projectId" = $1 AND "userId" = $2`,
      params: (userId) => [f.projectA.id, userId],
    });
  });

  it('a re-role serializes with a mark, both orders (the token role is no longer held)', async () => {
    await bothOrders({
      label: 'rerole',
      actor: async () => ({ userId: await member('contractor', `rr-${randomUUID().slice(0, 6)}`), role: 'contractor' }),
      change: (tag) => `UPDATE /* ${tag} */ "Membership" SET "role" = 'engineer' WHERE "projectId" = $1 AND "userId" = $2`,
      params: (userId) => [f.projectA.id, userId],
    });
  });

  it('an org admin\'s demotion serializes with their mark, both orders', async () => {
    await bothOrders({
      label: 'demotion',
      actor: async () => ({ userId: await orgAdmin(`dm-${randomUUID().slice(0, 6)}`), role: 'pmc' }),
      change: (tag) => `UPDATE /* ${tag} */ "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`,
      params: (userId) => [f.orgA.id, userId],
    });
  });

  it('a phantom grant: a membership granted to an org admin serializes with their mark — mark first stands, grant first refuses', async () => {
    const grantSql = (tag = '') => `INSERT ${tag ? `/* ${tag} */ ` : ''}INTO "Membership" ("id","projectId","userId","role","status") VALUES ($1, $2, $3, 'client', 'active')`;

    // mark first, OVERLAPPING the grant (#482 6112010410): the mark is held at a deterministic point — a notice
    // row it takes only after its standing and project locks — and the grant, started while it is held, is
    // observed waiting on THAT mark's backend. Released, the mark commits its receipt while the admin holds no
    // membership-granted row (a valid serial position), and the grant commits after it.
    const admin = await orgAdmin('phantom');
    const n = await notice('phantom');
    const noticeHold = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Notification" WHERE "id" = $1 FOR UPDATE', n));
    const markFirst = settle(mark(tokenOf(admin, 'pmc'), { ids: [n] }));
    await blockedBy(noticeHold.pid(), 'the mark holds its standing and project locks and waits on the held notice row');
    const [markPid] = await waitersOn(noticeHold.pid());
    expect(markPid, 'the held mark\'s backend').toBeGreaterThan(0);
    const grantTag = `phantom-grant-${randomUUID().slice(0, 8)}`;
    const granting = settle(t.prisma.$executeRawUnsafe(grantSql(grantTag), `t4bc-grant1-${run}`, f.projectA.id, admin));
    await tagWaits(grantTag, 'the grant waits');
    expect(await blockersOfTag(grantTag), 'the grant is blocked by the held mark itself').toContain(markPid);
    expect((await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId: admin } })), 'the grant has not committed').toBe(0);
    noticeHold.release();
    expect((await noticeHold.done).ok).toBe(true);
    const first = await markFirst;
    expect(first.ok && [first.v.status, first.v.body], 'mark first → recorded').toEqual([200, { confirmed: [n] }]);
    expect((await granting).ok, 'the grant commits after the mark').toBe(true);
    expect(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId: admin, status: 'active' } })).toBe(1);
    // the receipt stands; the next mark finds the granted row and is refused
    expect(await t.prisma.notificationReceipt.count({ where: { notificationId: n, userId: admin } })).toBe(1);
    expect((await mark(tokenOf(admin, 'pmc'), { ids: [await notice('phantom-next')] })).status).toBe(403);

    // grant first, held open: the absent row cannot be locked, but the grant's write holds the project row the
    // mark's operability check takes, so the mark is observed WAITING and, once the grant commits, refused
    const admin2 = await orgAdmin('phantom2');
    const m = await notice('phantom-held');
    const grant = await hold((tx) => tx.$executeRawUnsafe(grantSql(), `t4bc-grant2-${run}`, f.projectA.id, admin2));
    const marking = settle(mark(tokenOf(admin2, 'pmc'), { ids: [m] }));
    await blockedBy(grant.pid(), 'the mark waits on the held grant');
    grant.release();
    expect((await grant.done).ok).toBe(true);
    const r = await marking;
    expect(r.ok && r.v.status, 'grant first → refused').toBe(403);
    expect(await t.prisma.notificationReceipt.count({ where: { notificationId: m } })).toBe(0);
  });

  it('no deadlock between marks and concurrent org-authority writes (the projection writers\' lock order)', async () => {
    const admin = await orgAdmin('lockorder');
    const toggles: Array<Promise<{ ok: boolean; e?: string }>> = [];
    const marks: Array<Promise<{ ok: boolean; v?: request.Response; e?: string }>> = [];
    for (let i = 0; i < 6; i += 1) {
      const n = await notice(`lockorder-${i}`);
      marks.push(settle(mark(tokenOf(admin, 'pmc'), { ids: [n] })));
      toggles.push(settle(t.prisma.$executeRawUnsafe(
        `UPDATE "OrgMembership" SET "role" = CASE WHEN "role" = 'admin' THEN 'owner' ELSE 'admin' END WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, admin)));
    }
    for (const r of await Promise.all(toggles)) expect(r.ok ? '' : r.e).not.toMatch(/deadlock/i);
    for (const r of await Promise.all(marks)) {
      expect(r.ok, r.ok ? '' : r.e).toBe(true);
      expect(r.v?.status, r.v?.text).toBe(200);
    }
  });

  it('a role change between org-authority roles keeps a mark\'s authority lock: no deadlock with the next role change (forced order)', async () => {
    const admin = await orgAdmin('evaporate');
    const n = await notice('evaporate');
    const toggleSql = (tag: string) =>
      `UPDATE /* ${tag} */ "OrgMembership" SET "role" = CASE WHEN "role" = 'admin' THEN 'owner' ELSE 'admin' END WHERE "orgId" = $1 AND "userId" = $2`;
    // 1. the first role change, held open after its write: it has rewritten the admin's OrgUserAuthority row
    const first = await hold((tx) => tx.$executeRawUnsafe(toggleSql(`t4bc-first-${run}`), f.orgA.id, admin));
    // 2. a project-row holder, so the mark can be stopped after its standing lock and before its receipt
    const project = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "Project" WHERE "id" = $1 FOR NO KEY UPDATE', f.projectA.id));
    // 3. the mark takes the authority row FOR SHARE: it waits on the first role change
    const marking = settle(mark(tokenOf(admin, 'pmc'), { ids: [n] }));
    await blockedBy(first.pid(), 'the mark waits on the first role change for the authority row');
    // 4. the first role change commits; the mark goes on, takes the standing row FOR SHARE, and stops at the project row
    first.release();
    expect((await first.done).ok).toBe(true);
    await blockedBy(project.pid(), 'the mark waits on the project row, holding its authority and standing locks');
    // 5. the next role change: it must wait on the mark for the authority row, the first lock of the order
    const secondTag = `t4bc-second-${run}`;
    const second = settle(t.prisma.$executeRawUnsafe(toggleSql(secondTag), f.orgA.id, admin));
    await tagWaits(secondTag, 'the next role change waits on a lock');
    const markPid = (await waitersOn(project.pid()))[0]!;
    expect(await blockersOfTag(secondTag), 'the next role change waits on the mark').toEqual([markPid]);
    // the row it waits at: the authority row, the first lock of the order (the old body passed it and waited at the standing row)
    const waitsAt = await t.prisma.$queryRawUnsafe<Array<{ rel: string }>>(
      `SELECT c.relname AS rel FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'tuple' AND a.query LIKE $1 AND a.pid <> pg_backend_pid()`, `%${secondTag}%`);
    expect(waitsAt.map((r) => r.rel), 'the next role change waits at the authority row').toEqual(['OrgUserAuthority']);
    // 6. the project row goes; the mark writes its receipt and commits, then the next role change goes on
    project.release();
    expect((await project.done).ok).toBe(true);
    const r = await marking;
    expect(r.ok && [r.v.status, r.v.body], 'the mark is recorded').toEqual([200, { confirmed: [n] }]);
    const s = await second;
    expect(s.ok ? '' : s.e).toBe('');
  });

  it('an archive serializes with a mark, both orders', async () => {
    try {
      await bothOrders({
        label: 'archive',
        actor: async () => ({ userId: f.clientUser.id, role: 'client' }),
        change: (tag) => `UPDATE /* ${tag} */ "Project" SET "archivedAt" = now() WHERE "id" = $1`,
        params: () => [f.projectA.id],
        // the change itself takes the project row, so the mark-first barrier holds a notice row instead
        markFirstHold: 'notice',
        reset: () => t.prisma.$executeRawUnsafe('UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = $1', f.projectA.id),
      });
    } finally {
      await t.prisma.$executeRawUnsafe('UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = $1', f.projectA.id);
    }
  });

  it('a malformed, oversized or unauthorized request is refused whole and writes nothing', async () => {
    const client = f.clientUser.id;
    const n = await notice('refused');
    const clientToken = tokenOf(client, 'client');
    for (const body of [
      { ids: Array.from({ length: 201 }, () => n) },
      { ids: [n], userId: f.memberUser.id },
      { ids: n },
      { ids: [''] },
      {},
    ]) {
      const r = await mark(clientToken, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    // the cap itself is accepted
    const cap = await mark(clientToken, { ids: Array.from({ length: 200 }, () => n) });
    expect([cap.status, cap.body]).toEqual([200, { confirmed: [n] }]);
    const removed = await member('contractor', 'gone');
    const m = await notice('refused-403');
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: removed } }, data: { status: 'removed' } });
    expect((await mark(tokenOf(removed, 'contractor'), { ids: [m] })).status).toBe(403);
    // another project's route with this project's token
    expect((await mark(clientToken, { ids: [m] }, f.projectB.id)).status).toBe(403);
    expect(await t.prisma.notificationReceipt.count({ where: { notificationId: m } })).toBe(0);
  });
});
