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

  /** Seed a canonical daily log (crew + its own materials) and emit its lifecycle event, so the
   *  projection consumer has a delivery to apply. The handler refreshes the WHOLE project slice, so a
   *  single emitted event captures the seeded canonical state. */
  const makeDailyLog = async (
    projectId: string,
    id: string,
    opts: { logDate?: string; submitted?: boolean; progress?: number; crew?: { trade: string; count: number }[]; materials?: { name: string; qty: string; zone?: string; matched?: boolean; swatch?: string }[] } = {},
  ): Promise<void> => {
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

  it('a project with an active generation but no daily log serves the EMPTY slice (matches live)', async () => {
    const p = await freshProject();
    // emit a non-daily-log event so the ordered cursor bootstraps generation 1 via a noop
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p);

    const proj = await query.projectionSlice(p);
    const live = await query.snapshotSlice(p);
    expect(proj.generation).toBe(1); // an active generation exists…
    expect(proj.dailyLog).toBeNull(); // …but no row yet → the empty slice, identical to live
    expect(proj.materials).toEqual([]);
    expect(proj.dailyLog).toEqual(live.dailyLog);
    expect(proj.materials).toEqual(live.materials);
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
