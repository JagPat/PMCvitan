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
 * Phase 2 Task 10 Step 2 — the DAILY-LOG read path moves onto its rebuildable projection, proven
 * EQUIVALENT to the live snapshot slice (the Task-1 characterization) and proven live == rebuild.
 *
 * The `daily-log.inbox` projection consumer (registered by the app boot) maintains ONE per-project
 * DailyLogProjection row from canonical state on every `dailylog.*`/`material.*` event. Unlike the
 * decisions projection (one row per decision, per-viewer authz), the daily-log slice is a per-PROJECT
 * composite (the latest log core + every project material) with NO per-viewer visibility, so the
 * module's `projectionSlice` serves the whole slice with no filter — and it is byte-identical to
 * `snapshotSlice`, before and after a full rebuild.
 */

const human: Actor = { actorId: '', actorName: 'Ravi (Engineer)', actorRole: 'engineer', actorKind: 'human' };

describe('Phase 2 Task 10 — daily-log projection == live slice, live == rebuild (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let query: DailyLogQueryService;
  let projSeq = 0;

  const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DailyLogProjection"';

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
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: { startsWith: 'it-dlpj-' } } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { projectId: { startsWith: 'it-dlpj-' } } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: { startsWith: 'it-dlpj-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-dlpj-' } } });
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-dlpj-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    return id;
  };

  type LogOpts = { logDate?: string; submitted?: boolean; progress?: number; crew?: { trade: string; count: number }[]; materials?: { name: string; qty: string; zone?: string; matched?: boolean; swatch?: string }[] };

  /** Seed CANONICAL daily-log rows (crew + its own materials) WITHOUT emitting any event — the legacy /
   *  pre-projection shape the finding-1 probe needs (real data, no daily-log delivery to apply). */
  const seedCanonicalLog = async (projectId: string, id: string, opts: LogOpts = {}): Promise<void> => {
    await t.prisma.dailyLog.create({
      data: { id, projectId, date: '01 Jun 2026', logDate: opts.logDate ? new Date(opts.logDate) : new Date('2026-06-01'), submitted: opts.submitted ?? true, checkedIn: true, checkinTime: '09:00', progress: opts.progress ?? 40 },
    });
    let order = 0;
    for (const c of opts.crew ?? [{ trade: 'Mason', count: 4 }]) {
      await t.prisma.crewRow.create({ data: { dailyLogId: id, trade: c.trade, count: c.count, order: order++ } });
    }
    order = 0;
    for (const m of opts.materials ?? [{ name: 'Cement', qty: '20 bags', zone: 'GF' }]) {
      await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: id, name: m.name, qty: m.qty, zone: m.zone ?? '', matched: m.matched ?? true, swatch: m.swatch ?? 'tile', order: order++ } });
    }
  };

  /** Seed a canonical daily log AND emit its lifecycle event, so the projection consumer has a delivery
   *  to apply. The handler refreshes the WHOLE project slice, so a single emitted event captures it. */
  const makeDailyLog = async (projectId: string, id: string, opts: LogOpts = {}): Promise<void> => {
    await seedCanonicalLog(projectId, id, opts);
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'dailylog.submitted', entityType: 'DailyLog', entityId: id, effectKey: 'dailylog.submitted', dispatch: {} }));
  };

  /** Drain every pending daily-log.inbox (and noop) delivery for a project. */
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

  it('the projection slice is BYTE-IDENTICAL to the live snapshot slice', async () => {
    const p = await freshProject();
    await makeDailyLog(p, 'DLOG-1', {
      submitted: true,
      progress: 55,
      crew: [{ trade: 'Mason', count: 4 }, { trade: 'Helper', count: 2 }],
      materials: [{ name: 'Cement', qty: '20 bags', zone: 'GF' }, { name: 'Tiles', qty: '400', zone: 'L1', swatch: 'marble' }],
    });
    await applyProjection(p);

    const live = await query.snapshotSlice(p);
    const proj = await query.projectionSlice(p);
    expect(proj.dailyLog).toEqual(live.dailyLog);
    expect(proj.materials).toEqual(live.materials);
    expect(proj.generation).toBe(1); // served from an ACTIVE generation
  });

  // ── Finding 1 (correction): serve a generation ONLY when healthy, caught up AND its row exists ──

  it('finding 1: legacy canonical data + only a no-op delivery serves LIVE, never authoritative-empty projection', async () => {
    const p = await freshProject();
    // canonical daily-log data exists, but NO daily-log event was ever emitted (legacy / pre-projection)
    await seedCanonicalLog(p, 'DLOG-LEGACY', { progress: 33, materials: [{ name: 'Rebar', qty: '3 t', zone: 'GF' }] });
    // only an UNRELATED no-op event fires → bootstraps an active generation with NO DailyLogProjection row
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p);
    // an active, caught-up generation now exists — but it has no row for this project
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: DAILY_LOG_PROJECTION, projectId: p, status: 'active' } });
    expect(gen).not.toBeNull();
    // the module read MUST fall back to canonical LIVE, not serve the empty projection (the bug)
    const mod = await query.moduleDailyLog(p);
    expect(mod.source).toBe('live');
    expect(mod.dailyLog?.progress).toBe(33);
    expect(mod.materials.map((m) => m.name)).toEqual(['Rebar']);
    // projectionSlice signals not-servable (row missing) so the caller falls back
    expect((await query.projectionSlice(p)).generation).toBeNull();
  });

  it('finding 1: no daily log AND only a no-op falls back to live (empty, generation null)', async () => {
    const p = await freshProject();
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p);
    const proj = await query.projectionSlice(p);
    expect(proj.generation).toBeNull(); // caught-up generation but no row → not servable → fallback
    const mod = await query.moduleDailyLog(p);
    expect(mod.source).toBe('live');
    expect(mod.dailyLog).toBeNull();
    expect(mod.materials).toEqual([]);
  });

  it('finding 1: a LAGGING checkpoint (a committed write not yet applied) serves live', async () => {
    const p = await freshProject();
    await makeDailyLog(p, 'DLOG-A', { progress: 10, materials: [{ name: 'A', qty: '1', zone: 'GF' }] });
    await applyProjection(p);
    expect((await query.projectionSlice(p)).generation).toBe(1); // fully applied → servable
    // a SECOND committed daily-log write whose delivery is NOT yet applied — checkpoint now lags head
    await makeDailyLog(p, 'DLOG-B', { progress: 20, materials: [{ name: 'B', qty: '2', zone: 'GF' }] });
    const proj = await query.projectionSlice(p);
    expect(proj.generation).toBeNull(); // appliedPosition < stream head → not current → fallback
    const mod = await query.moduleDailyLog(p);
    expect(mod.source).toBe('live');
    expect(mod.dailyLog?.progress).toBe(20); // live reflects the newest canonical state
  });

  it('finding 1: a BLOCKED generation serves live', async () => {
    const p = await freshProject();
    await makeDailyLog(p, 'DLOG-BL', { progress: 15, materials: [{ name: 'Blk', qty: '1', zone: 'GF' }] });
    await applyProjection(p);
    expect((await query.projectionSlice(p)).generation).toBe(1);
    // a dead earlier position degrades the generation to 'blocked' live; force that state here
    await t.prisma.projectionGeneration.updateMany({ where: { consumer: DAILY_LOG_PROJECTION, projectId: p, status: 'active' }, data: { cursorStatus: 'blocked' } });
    expect((await query.projectionSlice(p)).generation).toBeNull(); // blocked → not served → fallback
    expect((await query.moduleDailyLog(p)).source).toBe('live');
  });

  it('live == rebuild: a rebuild activates a new generation (checkpoint == H) whose slice matches the live one', async () => {
    const p = await freshProject();
    await makeDailyLog(p, 'DLOG-R', { materials: [{ name: 'Sand', qty: '2 t', zone: 'GF' }] });
    await applyProjection(p);
    const before = await query.projectionSlice(p);
    expect(before.generation).toBe(1);

    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p } });
    const H = stream.nextPosition - 1n;

    const res = await rebuilder.rebuild(DAILY_LOG_PROJECTION, p);
    expect(res.checkpoint).toBe(H); // activated at the barrier position
    const after = await query.projectionSlice(p);
    expect(after.generation).toBe(2); // now serving the rebuilt generation
    // live == rebuild == snapshot: identical served slice across the generation swap
    const live = await query.snapshotSlice(p);
    expect(after.dailyLog).toEqual(before.dailyLog);
    expect(after.materials).toEqual(before.materials);
    expect(after.dailyLog).toEqual(live.dailyLog);
    expect(after.materials).toEqual(live.materials);
  });

  it('two projects are isolated: each has its own active daily-log generation + slice', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await makeDailyLog(p1, 'DLOG-A', { materials: [{ name: 'Steel', qty: '1 t', zone: 'GF' }] });
    await makeDailyLog(p2, 'DLOG-B', { materials: [{ name: 'Paint', qty: '10 L', zone: 'L1' }] });
    await applyProjection(p1);
    await applyProjection(p2);

    const s1 = await query.projectionSlice(p1);
    const s2 = await query.projectionSlice(p2);
    expect(s1.materials.map((m) => m.name)).toEqual(['Steel']);
    expect(s2.materials.map((m) => m.name)).toEqual(['Paint']);
    expect(s1.generation).toBe(1);
    expect(s2.generation).toBe(1);
  });

  // ── HTTP surface: the module-owned daily-log read (Task 10 Step 1) ──
  it('GET …/daily-log serves the module read (live fallback while the projection has no generation)', async () => {
    const pid = f.projectA.id;
    const token = t.issueProjectToken(f.memberUser.id, pid, 'pmc');
    const log = await t.prisma.dailyLog.create({ data: { id: 'DLOG-HTTP', projectId: pid, date: '01 Jun 2026', logDate: new Date('2026-06-01'), submitted: true, checkedIn: true, progress: 30 } });
    await t.prisma.siteMaterial.create({ data: { projectId: pid, dailyLogId: log.id, name: 'HTTP-Cement', qty: '5 bags', zone: 'GF', swatch: 'tile', order: 0 } });
    try {
      const res = await request(t.app.getHttpServer()).get(`/projects/${pid}/daily-log`).set('Authorization', `Bearer ${token}`).expect(200);
      // no daily-log.inbox generation for projectA yet → the module read falls back to the live slice
      expect(res.body.source).toBe('live');
      expect(res.body.dailyLog).not.toBeNull();
      expect(res.body.materials.map((m: { name: string }) => m.name)).toContain('HTTP-Cement');
    } finally {
      await t.prisma.siteMaterial.deleteMany({ where: { dailyLogId: 'DLOG-HTTP' } });
      await t.prisma.dailyLog.deleteMany({ where: { id: 'DLOG-HTTP' } });
    }
  });
});
