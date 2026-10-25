import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { LabourService } from '../../src/labour/labour.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #1129 — a worker-device bind that meets a committed archive answers 409 and writes nothing, against live PostgreSQL.
 *
 * `WorkerDevicesService.bind` judged the project live only at the door, before its ledgered transaction, and
 * an archive takes no readiness key. So an archive that committed after the door check was bound past: the
 * device was bound to its worker on the archived project, and the bind answered success. The bind now locks
 * and re-reads the project row (`isProjectOperable`) first thing inside its transaction. The case forces the
 * interleaving: a holder transaction H stops the archive after its project UPDATE (at its event-stream
 * counter), so the bind passes its door checks against a live project and then waits on the archive at that
 * project-row lock; H is released. The archive commits first, and the bind must answer exactly 409 and leave
 * the device unbound.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1129 — a worker-device bind racing a project archive answers 409 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let ownerToken: string;
  const ARCHIVED = 'This project is archived — no device can be bound on it';
  const RESET_TABLES = ['CommandExecution', 'WorkerDevice', 'WorkerSkill', 'Worker', 'LabourSkill', 'LabourTrade', 'ProjectCapability'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const pmc = { sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
    const labour = t.app.get(LabourService);
    await t.app.get(CapabilitiesService).enable(f.projectA.id, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(f.projectA.id, { code: 'mason', name: 'Mason' }, pmc);
    await labour.upsertSkill(f.projectA.id, { code: 'bar-bending', name: 'Bar Bending' }, pmc);
  });

  afterAll(async () => {
    try {
      if (t?.prisma && f) {
        await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
        await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
      }
    } finally {
      await f?.cleanup();
      await t?.close();
    }
  });

  const http = () => request(t.app.getHttpServer());
  const bind = (deviceId: string, workerId: string) => http().post(`/projects/${f.projectA.id}/worker-devices/${deviceId}/bind`)
    .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send({ workerId });
  const archive = () => http().delete(`/orgs/${f.orgA.id}/projects/${f.projectA.id}`).set('Authorization', `Bearer ${ownerToken}`);
  const restore = () => t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: null } });
  const workerAndDevice = async () => {
    const pmc = { sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
    const w = await t.app.get(LabourService).onboardWorker(f.projectA.id, { name: `T1129 ${randomUUID().slice(0, 6)}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo: null }, pmc);
    const d = await t.prisma.workerDevice.create({ data: { projectId: f.projectA.id, token: `t1129-${randomUUID()}` } });
    return { workerId: w.id, deviceId: d.id };
  };
  const boundTo = async (deviceId: string) => (await t.prisma.workerDevice.findUniqueOrThrow({ where: { id: deviceId }, select: { workerId: true } })).workerId;

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

  it('1. a bind behind an archive: 409, and the device stays unbound with no receipt', async () => {
    const { workerId, deviceId } = await workerAndDevice();
    const receipts = () => t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'orgs.workerDevice.bind' } });
    const before = await receipts();
    const inFlight: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    try {
      // H holds the project's event-stream counter, so the archive stops at its emit, after its project UPDATE:
      // it holds the archived row, uncommitted, and the bind's door checks see a live project. Without H the
      // archive could commit before the bind starts (the door's 403, not this race), or the bind could commit first.
      const h = await hold((tx) => tx.$queryRawUnsafe('SELECT 1 FROM "ProjectEventStream" WHERE "projectId" = $1 FOR UPDATE', f.projectA.id));
      const arc = settle(archive());
      inFlight.push({ release: h.release, settled: Promise.all([h.done, arc]) });
      const arcPid = await waiterOn([h.pid], 'the archive waits on H at the event stream, after its project UPDATE');
      const cmd = settle(bind(deviceId, workerId));
      inFlight.push({ release: () => {}, settled: cmd });
      // The barrier also stops on the bind's own answer, so a bind that never waits on the archive fails by
      // assertion here, at once, not by the barrier's deadline.
      let answered = false;
      void cmd.then(() => { answered = true; });
      let cmdPid = 0;
      await until(async () => {
        if (answered) return true;
        const rows = await t.prisma.$queryRawUnsafe<Array<{ pid: number }>>(
          'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]', [arcPid]);
        cmdPid = Number(rows[0]?.pid ?? 0);
        return cmdPid > 0;
      }, 'the bind waits on the archive, or answers');
      if (cmdPid === 0) {
        expect(status(await cmd), 'the bind answered without waiting on the archive').toBe(409);
      } else {
        const [{ q }] = await t.prisma.$queryRawUnsafe<Array<{ q: string }>>('SELECT query AS q FROM pg_stat_activity WHERE pid = $1', cmdPid);
        expect(q, 'the bind waits at its project-row lock').toMatch(/FROM "Project" WHERE "id" = \$1 FOR NO KEY UPDATE/);
      }
      h.release();
      const [ar, cr] = await Promise.all([arc, cmd]);
      await h.done;
      expect(status(ar), text(ar)).toBe(200);
      expect(status(cr), text(cr)).toBe(409);
      expect(text(cr)).toContain(ARCHIVED);
      expect(await boundTo(deviceId)).toBeNull();
      expect(await receipts()).toBe(before);
    } finally {
      for (const x of inFlight) x.release();
      await Promise.all(inFlight.map((x) => x.settled));
      await restore();
    }
  }, 60_000);

  it('2. a bind on a live project still lands', async () => {
    const { workerId, deviceId } = await workerAndDevice();
    const r = await bind(deviceId, workerId);
    expect(r.status, r.text).toBe(201);
    expect(await boundTo(deviceId)).toBe(workerId);
  }, 60_000);
});
