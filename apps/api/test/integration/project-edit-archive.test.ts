import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { orgStandingLockKey } from '../../src/common/readiness-lock';

/**
 * #1128 — a project edit on an archived project answers 409 and writes nothing, against live PostgreSQL.
 *
 * `OrgsService.updateProject` checked the caller's authority and the project's org, then wrote the
 * project and emitted `project.updated` with no look at `archivedAt`. So an archived project could be
 * renamed (case 1), and an archive that committed after the edit's door checks was written past (case 2:
 * the two already queue on the org key, but the edit never looked at the project again once it had it).
 * The edit now locks and re-reads the project row after the org key, before its write. Case 2 forces the
 * interleaving: a holder transaction H stops the archive after its project UPDATE (at its event-stream
 * counter), so the edit (by the project's PMC, not the archiving owner) passes its door checks against a
 * live project and then waits on the archive at the org key; H is released. The archive commits first,
 * and the edit must answer exactly 409 and write nothing.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1128 — a project edit on an archived project answers 409 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let ownerToken: string;
  const ARCHIVED = 'This project is archived — restore it before editing it';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
  });

  afterAll(async () => {
    try {
      if (t?.prisma && f) await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    } finally {
      await f?.cleanup();
      await t?.close();
    }
  });

  const http = () => request(t.app.getHttpServer());
  const edit = (token: string, body: object) => http().patch(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${token}`).send(body);
  const archive = () => http().delete(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${ownerToken}`);
  const restore = () => t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
  const name = async () => (await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id }, select: { name: true } })).name;
  const updates = () => t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, eventType: 'project.updated' } });

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
  /** The one backend waiting on a lock any of `holders` holds. */
  const waiterOn = async (holders: number[], what: string): Promise<number> => {
    let pid = 0;
    await until(async () => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ pid: number }>>(
        'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]', holders);
      pid = rows.map((r) => Number(r.pid)).find((p) => !holders.includes(p)) ?? 0;
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

  it('1. an edit of an already archived project: 409, and the name and its events are unchanged', async () => {
    try {
      const before = await name();
      const events = await updates();
      const a = await archive();
      expect(a.status, a.text).toBe(200);
      const r = await edit(ownerToken, { name: `${before} renamed` });
      expect(r.status, r.text).toBe(409);
      expect(r.text).toContain(ARCHIVED);
      expect(await name()).toBe(before);
      expect(await updates()).toBe(events);
    } finally {
      await restore();
    }
  }, 60_000);

  it('2. an edit by the project PMC, behind an archive: 409, and the name and its events are unchanged', async () => {
    const before = await name();
    const events = await updates();
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      // H holds the project's event-stream counter, so the archive stops at its emit, after its project UPDATE:
      // it holds the org key and the archived row, uncommitted. The edit's door checks then see a live project.
      // Without H the archive could commit before the edit even starts (case 1, not this race).
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "ProjectEventStream" WHERE "projectId" = $1 FOR UPDATE', f.projectA.id));
      const arc = settle(archive());
      inFlight.push({ release: h.release, settled: Promise.all([h.done, arc]) });
      const arcPid = await waiterOn([h.pid], 'the archive waits on H at the event stream, after its project UPDATE');
      const cmd = settle(edit(pmcToken, { name: `${before} renamed` }));
      inFlight.push({ release: () => {}, settled: cmd });
      const cmdPid = await waiterOn([arcPid], 'the edit waits on the archive');
      const [{ q }] = await t.prisma.$queryRawUnsafe<Array<{ q: string }>>('SELECT query AS q FROM pg_stat_activity WHERE pid = $1', cmdPid);
      expect(q, 'the edit waits at the org key the archive holds').toMatch(/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/);
      const [{ key }] = await t.prisma.$queryRawUnsafe<Array<{ key: string }>>(
        "SELECT l.objid::text AS key FROM pg_locks l WHERE l.pid = $1 AND l.locktype = 'advisory' AND NOT l.granted", cmdPid);
      const [{ org }] = await t.prisma.$queryRawUnsafe<Array<{ org: string }>>(
        'SELECT (hashtextextended($1, 0) & 4294967295)::text AS org', orgStandingLockKey(f.orgA.id));
      expect(key, 'the awaited advisory key is the org key').toBe(org);
      h.release();
      const [ar, cr] = await Promise.all([arc, cmd]);
      await h.done;
      expect(status(ar), text(ar)).toBe(200);
      expect(status(cr), text(cr)).toBe(409);
      expect(text(cr)).toContain(ARCHIVED);
      expect(await name()).toBe(before);
      expect(await updates()).toBe(events);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await restore();
    }
  }, 60_000);

  it('3. an edit of a live project still lands: 200 and the new name', async () => {
    const before = await name();
    const r = await edit(pmcToken, { name: `${before} live` });
    expect(r.status, r.text).toBe(200);
    expect(await name()).toBe(`${before} live`);
    await t.prisma.project.update({ where: { id: f.projectA.id }, data: { name: before } });
  }, 60_000);
});
