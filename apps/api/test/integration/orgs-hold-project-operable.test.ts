import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { closeProjectExchangeFence, PROJECT_EXCHANGES_BUSY } from '../../src/orgs/project-exchange-fence';

/**
 * #1177 VT2-B — `OrgsParticipant.holdProjectOperable`, against live PostgreSQL. It answers whether a project is
 * operable and holds it so until the caller's transaction ends: an archive started meanwhile waits for the holder,
 * a second holder and a writer of the project's row do not, and a holder that comes after a waiting archive waits
 * behind it. Isolated automated-test fixtures only.
 */
describe('#1177 VT2-B — holding a project operable (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let ownerToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
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

  const orgs = () => t.app.get(OrgsParticipant);
  const archive = () => request(t.app.getHttpServer()).delete(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${ownerToken}`);
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const settle = <T>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));
  const until = async (probe: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier not reached: ${what}`);
  };
  /** A backend other than `holder` that is waiting on a lock `holder` holds. */
  const waitingOn = async (holder: number, what: string) => until(async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ pid: number }>>(
      'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', holder);
    return rows.length > 0;
  }, what);
  /** `pid` itself is waiting on some lock. */
  const waiting = async (pid: number, what: string) => until(async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>('SELECT cardinality(pg_blocking_pids($1::int)) AS n', pid);
    return Number(rows[0]!.n) > 0;
  }, what);
  /**
   * Open a transaction that takes the hold and keeps it open until released. `started` gives its backend pid before
   * the hold is asked for; `ready` gives the hold's answer once granted. `lockTimeout` makes a hold that should not
   * wait fail fast instead of hanging if it ever does.
   */
  const hold = (projectId: string, lockTimeout?: string) => {
    const started = gate(); const ready = gate(); const release = gate();
    let pid = 0;
    let answer: boolean | null = null;
    const done = settle(t.prisma.$transaction(async (tx) => {
      pid = Number((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      if (lockTimeout) await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      started.open();
      answer = await orgs().holdProjectOperable(tx, projectId);
      ready.open();
      await release.p;
    }, { timeout: 60_000, maxWait: 10_000 }));
    const failed = done.then((r) => { if (!r.ok) throw new Error(`holder failed: ${r.e}`); });
    return {
      started: Promise.race([started.p, failed]).then(() => pid),
      ready: Promise.race([ready.p, failed]).then(() => answer as boolean | null),
      release: release.open,
      done,
    };
  };

  it('answers true for a live project, false for an archived or unknown one', async () => {
    expect(await t.prisma.$transaction((tx) => orgs().holdProjectOperable(tx, f.projectA.id))).toBe(true);
    expect(await t.prisma.$transaction((tx) => orgs().holdProjectOperable(tx, 'no-such-project'))).toBe(false);
    await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
    try {
      expect(await t.prisma.$transaction((tx) => orgs().holdProjectOperable(tx, f.projectB.id))).toBe(false);
    } finally {
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
    }
  });

  it('an archive waits for the holder; a second holder and a write of the project row do not', async () => {
    const h = hold(f.projectA.id);
    let archived: ReturnType<typeof settle<request.Response>> | undefined;
    try {
      expect(await h.ready).toBe(true);
      const pid = await h.started;
      // a second holder takes the same hold while the first is held, and is not made to wait (2 s lock_timeout)
      const second = hold(f.projectA.id, '2s');
      expect(await second.ready).toBe(true);
      second.release();
      expect((await second.done).ok).toBe(true);
      // the project's row is not locked by the hold: another writer of it is not made to wait
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
        await tx.project.update({ where: { id: f.projectA.id }, data: { name: 'Held but writable' } });
      });
      // the archive is started, and waits on the holder
      archived = settle(archive());
      await waitingOn(pid, 'the archive waits on the hold');
      expect(await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id }, select: { archivedAt: true } })).toEqual({ archivedAt: null });
      h.release();
      expect((await h.done).ok).toBe(true);
      const r = await archived;
      expect(r.ok && (r.v as request.Response).status).toBe(200);
      // once the archive has committed, the hold answers false
      expect(await t.prisma.$transaction((tx) => orgs().holdProjectOperable(tx, f.projectA.id))).toBe(false);
    } finally {
      h.release();
      // let a pending archive end before the project is put back, so it cannot archive it again after
      await archived;
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  });

  it('a holder that comes after a waiting archive waits behind it, then answers false: holders cannot starve an archive', async () => {
    const first = hold(f.projectA.id);
    let late: ReturnType<typeof hold> | undefined;
    let archived: ReturnType<typeof settle<request.Response>> | undefined;
    try {
      expect(await first.ready).toBe(true);
      archived = settle(archive());
      await waitingOn(await first.started, 'the archive waits on the first holder');
      // a later holder, while the archive waits: it is not let past the archive
      late = hold(f.projectA.id);
      await waiting(await late.started, 'the later holder waits');
      first.release();
      expect((await first.done).ok).toBe(true);
      const r = await archived;
      expect(r.ok && (r.v as request.Response).status).toBe(200);
      // the archive went first, so the later holder sees it
      expect(await late.ready).toBe(false);
      late.release();
      expect((await late.done).ok).toBe(true);
    } finally {
      first.release();
      late?.release();
      await archived;
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  });

  it('an archive outlasts Prisma\'s default 5 s transaction bound while it waits, and still archives', async () => {
    const h = hold(f.projectA.id);
    let archived: ReturnType<typeof settle<request.Response>> | undefined;
    try {
      expect(await h.ready).toBe(true);
      archived = settle(archive());
      await waitingOn(await h.started, 'the archive waits on the hold');
      // the database's own clock says the archive's wait has run past 6 s (a default interactive transaction ends at 5 s)
      await until(async () => {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND clock_timestamp() - query_start > interval '6 seconds'`,
          await h.started);
        return Number(rows[0]!.n) > 0;
      }, 'the archive has waited past 6 s');
      h.release();
      const r = await archived;
      expect(r.ok && (r.v as request.Response).status).toBe(200);
    } finally {
      h.release();
      await archived;
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
    }
  }, 40_000);

  it('the archive\'s wait is bounded: past it, a 409 that changes nothing; within it, the transaction\'s own lock_timeout is put back', async () => {
    const h = hold(f.projectA.id);
    try {
      expect(await h.ready).toBe(true);
      const r = await settle(t.prisma.$transaction((tx) => closeProjectExchangeFence(tx, f.projectA.id, 300)));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.e).toContain(PROJECT_EXCHANGES_BUSY);
    } finally {
      h.release();
      await h.done;
    }
    const after = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
      await closeProjectExchangeFence(tx, f.projectA.id, 300);
      return (await tx.$queryRawUnsafe<Array<{ v: string }>>(`SELECT current_setting('lock_timeout') AS v`))[0]!.v;
    });
    expect(after).toBe('3s');
    expect(await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id }, select: { archivedAt: true } })).toEqual({ archivedAt: null });
  });

  it('refuses to hold outside READ COMMITTED, where its read could miss a committed archive', async () => {
    for (const isolationLevel of [Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable]) {
      const r = await settle(t.prisma.$transaction((tx) => orgs().holdProjectOperable(tx, f.projectA.id), { isolationLevel }));
      expect(r.ok, isolationLevel).toBe(false);
      expect(!r.ok && r.e).toContain('needs READ COMMITTED');
    }
  });
});
