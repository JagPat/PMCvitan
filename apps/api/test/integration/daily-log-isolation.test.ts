import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { DailyLogQueryService } from '../../src/daily-log/daily-log.query';
import { DAILY_LOG_PROJECTION } from '../../src/daily-log/daily-log.projection';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 Task 10 (correction, finding 5) — the MODULE-OWNED daily-log read is tenant-isolated and
 * lifecycle-correct, proven against live PostgreSQL. The module read (query + `GET …/daily-log`) must:
 *   • never serve one project's slice for another (cross-project) or across orgs (cross-org);
 *   • reject a caller whose membership was removed (membership-authoritative auth, SEC-01);
 *   • stay correct when a WRITE lands after the projection caught up (rebuild-while-writing) and when
 *     the relay and a rebuild race (relay-vs-rebuild) — the served slice is always == the live slice,
 *     never double-applied or corrupted;
 *   • upgrade a LEGACY project (canonical data, no events) from the live fallback onto the projection.
 * The lagging/blocked-generation fallbacks (finding 1) are proven in daily-log-projection.test.ts.
 */

const human: Actor = { actorId: '', actorName: 'Ravi (Engineer)', actorRole: 'engineer', actorKind: 'human' };
const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DailyLogProjection"';

describe('Phase 2 Task 10 (correction, finding 5) — module read isolation + lifecycle (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let query: DailyLogQueryService;
  let projSeq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    query = t.app.get(DailyLogQueryService);
    human.actorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    // clean daily-log rows for BOTH the disposable projects and the fixture projects the HTTP tests use
    const pids = { startsWith: 'it-dliso-' };
    await t.prisma.siteMaterial.deleteMany({ where: { OR: [{ projectId: pids }, { projectId: { in: [f.projectA.id, f.projectB.id] } }] } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { OR: [{ projectId: pids }, { projectId: { in: [f.projectA.id, f.projectB.id] } }] } } });
    await t.prisma.dailyLog.deleteMany({ where: { OR: [{ projectId: pids }, { projectId: { in: [f.projectA.id, f.projectB.id] } }] } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  const freshProject = async (orgId: string = f.orgA.id): Promise<string> => {
    const id = `it-dliso-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    return id;
  };

  type LogOpts = { progress?: number; materials?: { name: string; qty: string; zone?: string; swatch?: string }[] };
  const seedCanonicalLog = async (projectId: string, id: string, opts: LogOpts = {}): Promise<void> => {
    await t.prisma.dailyLog.create({
      data: { id, projectId, date: '01 Jun 2026', logDate: new Date('2026-06-01'), submitted: true, checkedIn: true, checkinTime: '09:00', progress: opts.progress ?? 40 },
    });
    await t.prisma.crewRow.create({ data: { dailyLogId: id, trade: 'Mason', count: 4, order: 0 } });
    let order = 0;
    for (const m of opts.materials ?? [{ name: 'Cement', qty: '20 bags', zone: 'GF' }]) {
      await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: id, name: m.name, qty: m.qty, zone: m.zone ?? '', matched: true, swatch: m.swatch ?? 'tile', order: order++ } });
    }
  };
  const makeDailyLog = async (projectId: string, id: string, opts: LogOpts = {}): Promise<void> => {
    await seedCanonicalLog(projectId, id, opts);
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'dailylog.submitted', entityType: 'DailyLog', entityId: id, effectKey: 'dailylog.submitted', dispatch: {} }));
  };
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DAILY_LOG_PROJECTION, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  // ── Cross-project / cross-org / membership isolation ───────────────────────────────────────────

  it('cross-project (query): moduleDailyLog(A) returns ONLY A’s slice, never B’s', async () => {
    const a = await freshProject();
    const b = await freshProject();
    await makeDailyLog(a, 'ISO-A', { progress: 11, materials: [{ name: 'Steel-A', qty: '1 t' }] });
    await makeDailyLog(b, 'ISO-B', { progress: 22, materials: [{ name: 'Paint-B', qty: '10 L' }] });
    await applyProjection(a);
    await applyProjection(b);

    const modA = await query.moduleDailyLog(a);
    const modB = await query.moduleDailyLog(b);
    expect(modA.dailyLog?.progress).toBe(11);
    expect(modA.materials.map((m) => m.name)).toEqual(['Steel-A']);
    expect(modB.dailyLog?.progress).toBe(22);
    expect(modB.materials.map((m) => m.name)).toEqual(['Paint-B']);
    // no leakage in either direction
    expect(modA.materials.some((m) => m.name === 'Paint-B')).toBe(false);
    expect(modB.materials.some((m) => m.name === 'Steel-A')).toBe(false);
  });

  it('cross-org (HTTP): a member of org A cannot read org B’s project daily-log (403)', async () => {
    // memberUser is pmc on projectA (orgA); a token CLAIMING projectB (orgB) has no membership there
    const token = t.issueProjectToken(f.memberUser.id, f.projectB.id, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${f.projectB.id}/daily-log`).set('Authorization', `Bearer ${token}`).expect(403);
    // and the reverse: projectB’s member cannot read projectA
    const tokenB = t.issueProjectToken(f.otherUser.id, f.projectA.id, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/daily-log`).set('Authorization', `Bearer ${tokenB}`).expect(403);
  });

  it('cross-project (HTTP): a same-org project the caller is NOT a member of is forbidden (403)', async () => {
    const other = await freshProject(f.orgA.id); // same org as memberUser, but no membership granted
    const token = t.issueProjectToken(f.memberUser.id, other, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${other}/daily-log`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('removed-membership (HTTP): a caller whose membership was removed can no longer read (403)', async () => {
    const p = await freshProject(f.orgA.id);
    await t.prisma.membership.create({ data: { projectId: p, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await seedCanonicalLog(p, 'ISO-RM', { progress: 7 });
    const token = t.issueProjectToken(f.memberUser.id, p, 'pmc');
    // with an active membership the read works…
    await request(t.app.getHttpServer()).get(`/projects/${p}/daily-log`).set('Authorization', `Bearer ${token}`).expect(200);
    // …remove the membership → the SAME token is now rejected (membership-authoritative, SEC-01)
    await t.prisma.membership.deleteMany({ where: { projectId: p, userId: f.memberUser.id } });
    await request(t.app.getHttpServer()).get(`/projects/${p}/daily-log`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  // ── Lifecycle: rebuild-while-writing, relay-vs-rebuild, legacy upgrade ──────────────────────────

  it('rebuild-while-writing: a write after catch-up lags the generation, then a rebuild catches up to head', async () => {
    const p = await freshProject();
    await makeDailyLog(p, 'RW-1', { progress: 10, materials: [{ name: 'A', qty: '1' }] });
    await applyProjection(p);
    expect((await query.projectionSlice(p)).generation).toBe(1);

    // a NEW committed write whose delivery is not yet applied — the active generation now lags head
    await makeDailyLog(p, 'RW-2', { progress: 25, materials: [{ name: 'B', qty: '2' }] });
    expect((await query.projectionSlice(p)).generation).toBeNull(); // lagging → not servable → live fallback
    expect((await query.moduleDailyLog(p)).source).toBe('live');

    // a rebuild activates a fresh generation AT the current head — now servable and reflecting BOTH writes
    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p } });
    const res = await rebuilder.rebuild(DAILY_LOG_PROJECTION, p);
    expect(res.checkpoint).toBe(stream.nextPosition - 1n);
    const proj = await query.projectionSlice(p);
    const live = await query.snapshotSlice(p);
    expect(proj.generation).toBe(2);
    expect(proj.dailyLog).toEqual(live.dailyLog);
    expect(proj.materials.map((m) => m.name).sort()).toEqual(['A', 'B']);
  });

  it('relay-vs-rebuild: draining a still-pending relay delivery after a rebuild never corrupts the served slice', async () => {
    const p = await freshProject();
    await makeDailyLog(p, 'RR-1', { progress: 10, materials: [{ name: 'A', qty: '1' }] });
    await applyProjection(p); // generation 1 caught up

    // a second write leaves a PENDING relay delivery for the daily-log.inbox consumer
    await makeDailyLog(p, 'RR-2', { progress: 20, materials: [{ name: 'B', qty: '2' }] });
    const pendingBefore = await t.prisma.outboxDelivery.count({ where: { consumer: DAILY_LOG_PROJECTION, projectId: p, status: { in: ['pending', 'leased'] } } });
    expect(pendingBefore).toBeGreaterThan(0);

    // a rebuild swaps in generation 2 at head WHILE that delivery is still queued
    await rebuilder.rebuild(DAILY_LOG_PROJECTION, p);
    // now drain the relay's leftover deliveries — they must NOT double-apply onto the served slice
    await applyProjection(p);

    const proj = await query.projectionSlice(p);
    const live = await query.snapshotSlice(p);
    expect(proj.generation).not.toBeNull();          // still servable
    expect(proj.dailyLog).toEqual(live.dailyLog);     // == live (no corruption)
    expect(proj.materials.map((m) => m.name).sort()).toEqual(['A', 'B']); // each material exactly once
  });

  it('legacy-upgraded-data (HTTP): a legacy project reads LIVE, then serves the PROJECTION after an upgrade', async () => {
    const p = await freshProject(f.orgA.id);
    await t.prisma.membership.create({ data: { projectId: p, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    // canonical data with NO daily-log events — the pre-projection (legacy) shape
    await seedCanonicalLog(p, 'ISO-LEG', { progress: 33, materials: [{ name: 'Rebar', qty: '3 t' }] });
    const token = t.issueProjectToken(f.memberUser.id, p, 'pmc');

    const before = await request(t.app.getHttpServer()).get(`/projects/${p}/daily-log`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(before.body.source).toBe('live'); // no generation yet → live fallback
    expect(before.body.dailyLog.progress).toBe(33);
    expect(before.body.materials.map((m: { name: string }) => m.name)).toEqual(['Rebar']);

    // UPGRADE: emit the lifecycle event + apply the projection (or a rebuild would do the same)
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'dailylog.submitted', entityType: 'DailyLog', entityId: 'ISO-LEG', effectKey: 'dailylog.submitted', dispatch: {} }));
    await applyProjection(p);

    const after = await request(t.app.getHttpServer()).get(`/projects/${p}/daily-log`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.source).toBe('projection'); // now served from the rebuilt read model
    expect(after.body.dailyLog.progress).toBe(33); // identical data, different path
    expect(after.body.materials.map((m: { name: string }) => m.name)).toEqual(['Rebar']);
  });
});
