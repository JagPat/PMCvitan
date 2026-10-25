import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #1072 — a member command that meets an archive at the transition seal answers 409, against live PostgreSQL.
 *
 * A member add, re-role or removal passes its checks against a live project, then records its
 * `MembershipTransition` fact, whose 4d-i seal locks the project row and re-judges it. An archive that
 * commits in between is met there ("is archived — no decision fact may be recorded against it"). That
 * raise used to surface as a 500. Each case forces the interleaving: a holder transaction H stops the
 * archive after its project UPDATE (at its event-stream counter), the member command (of a member
 * unrelated to the archiver) then waits on the archive at the seal, and H is released. The archive
 * commits first, and the command must answer exactly 409 and write nothing.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1072 — a member command racing a project archive answers 409 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let ownerToken: string;
  const run = randomUUID().slice(0, 8);
  const email = (label: string) => `t1072-${label}-${run}@test.local`;
  const ARCHIVED = 'This project is archived — its team can no longer be changed';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
  });

  afterAll(async () => {
    try {
      if (t?.prisma && f) {
        await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
        await sanctionedReset(t.prisma, ['MembershipTransition'], { cascade: true });
        const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 't1072-', endsWith: `-${run}@test.local` } }, select: { id: true } });
        const ids = provisioned.map((u) => u.id);
        await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
        await t.prisma.commandExecution.deleteMany({ where: { actorId: { in: ids } } });
        await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    } finally {
      await f?.cleanup();
      await t?.close();
    }
  });

  const http = () => request(t.app.getHttpServer());
  const base = () => `/projects/${f.projectA.id}/members`;
  const add = (body: object) => http().post(base()).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const patch = (userId: string, body: object) => http().patch(`${base()}/${userId}`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const del = (userId: string) => http().delete(`${base()}/${userId}`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send();
  const archive = () => http().delete(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${ownerToken}`);

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
  /** The one backend, not in `seen`, waiting on a lock any of `holders` holds. */
  const waiterOn = async (holders: number[], what: string, seen: number[] = []): Promise<number> => {
    let pid = 0;
    await until(async () => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ pid: number }>>(
        'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]', holders);
      pid = rows.map((r) => Number(r.pid)).find((p) => !seen.includes(p) && !holders.includes(p)) ?? 0;
      return pid > 0;
    }, what);
    return pid;
  };
  /** Open a transaction, run `body` in it, report its pid, and keep it open until released. */
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

  const addNew = async (label: string, role: string) => {
    const r = await add({ name: `T1072 ${label}`, role, email: email(label) });
    expect(r.status, r.text).toBe(201);
    return { userId: r.body.userId as string, membershipId: r.body.membershipId as string };
  };
  const factCount = (membershipId: string) => t.prisma.membershipTransition.count({ where: { projectId: f.projectA.id, membershipId } });

  /** H holds the project's event-stream counter, so the archive stops at its emit, after its project UPDATE: it
   *  holds the archived row, uncommitted. `send` then waits on the archive itself at the transition seal's
   *  project-row lock, and H is released. Without H the two would both wait on whoever held the row, and the
   *  member command could take the row first and commit before the archive (a legitimate 2xx, not this race). */
  const raceArchive = async (send: () => request.Test) => {
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "ProjectEventStream" WHERE "projectId" = $1 FOR UPDATE', f.projectA.id));
      const arc = settle(archive());
      inFlight.push({ release: h.release, settled: Promise.all([h.done, arc]) });
      const arcPid = await waiterOn([h.pid], 'the archive waits on H at the event stream, after its project UPDATE');
      const cmd = settle(send());
      inFlight.push({ release: () => {}, settled: cmd });
      const cmdPid = await waiterOn([arcPid], 'the member command waits on the archive');
      const [{ q }] = await t.prisma.$queryRawUnsafe<Array<{ q: string }>>('SELECT query AS q FROM pg_stat_activity WHERE pid = $1', cmdPid);
      expect(q, 'the member command waits at its transition fact (the seal locks the project row)').toMatch(/^INSERT INTO "public"\."MembershipTransition"/);
      h.release();
      const [ar, cr] = await Promise.all([arc, cmd]);
      await h.done;
      expect(status(ar), text(ar)).toBe(200);
      return cr;
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  };

  it('1. a re-role of an unrelated member, behind an archive: 409, and the role and its facts are unchanged', async () => {
    const m = await addNew('rerole', 'contractor');
    const before = await factCount(m.membershipId);
    const r = await raceArchive(() => patch(m.userId, { role: 'engineer' }));
    expect(status(r), text(r)).toBe(409);
    expect(text(r)).toContain(ARCHIVED);
    expect((await t.prisma.membership.findUniqueOrThrow({ where: { id: m.membershipId } })).role).toBe('contractor');
    expect(await factCount(m.membershipId)).toBe(before);
  }, 60_000);

  it('2. an add, behind an archive: 409, and no membership or identity is written', async () => {
    const r = await raceArchive(() => add({ name: 'T1072 added', role: 'contractor', email: email('added') }));
    expect(status(r), text(r)).toBe(409);
    expect(text(r)).toContain(ARCHIVED);
    expect(await t.prisma.user.count({ where: { email: email('added') } })).toBe(0);
  }, 60_000);

  it('3. a removal of an unrelated member, behind an archive: 409, and the member stays active', async () => {
    const m = await addNew('remove', 'contractor');
    const before = await factCount(m.membershipId);
    const r = await raceArchive(() => del(m.userId));
    expect(status(r), text(r)).toBe(409);
    expect(text(r)).toContain(ARCHIVED);
    expect((await t.prisma.membership.findUniqueOrThrow({ where: { id: m.membershipId } })).status).toBe('active');
    expect(await factCount(m.membershipId)).toBe(before);
  }, 60_000);
});
