import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { DrawingsService } from '../../src/drawings/drawings.service';
import { DrawingsQueryService } from '../../src/drawings/drawings.query';
import { DRAWINGS_PROJECTION } from '../../src/drawings/drawings.projection';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import { DailyLogQueryService } from '../../src/daily-log/daily-log.query';
import { DAILY_LOG_PROJECTION } from '../../src/daily-log/daily-log.projection';
import { NodesService } from '../../src/nodes/nodes.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 10 Module-4 correction — ON DELETE SET NULL must not silently mutate a PROJECTED
 * canonical fact (the gate's architectural finding, three manifestations).
 *
 * `Drawing.activityId` (activity delete), `Drawing.nodeId` (node delete) and `SiteMaterial.nodeId`
 * (node delete) are all serialized into module projection bases (`drawings.inbox`, `daily-log.inbox`)
 * and all mutate through database `ON DELETE SET NULL` FK actions — with NO owner-aligned event before
 * this correction. The projection consumer then sees only the deleting command's foreign event
 * (`activity.deleted` / `node.removed`) as a NOOP: the ordered cursor advances past it, the generation
 * reports CURRENT again, and the base row still carries the deleted reference — a silently-stale
 * projection (the exact Module-3 lesson, resurfacing through the FK side channel).
 *
 * REPRODUCE-FIRST: at `main` @ 5d24d82 the after-drain probes below are RED (generation current, base
 * stale ≠ live). The correction routes each mutation through the OWNING module's workflow participant
 * (`DrawingParticipant.unlinkFromDeletedActivity` / `unfileForDeletedNodes`,
 * `DailyLogParticipant.unfileMaterialsForDeletedNodes`) inside the SAME deleting transaction — the
 * explicit updateMany runs BEFORE the delete (the SET NULL FK stays as the database backstop) and an
 * owner-aligned signal event (`drawing.activity_unlinked` / `drawing.unfiled` / `material.unfiled`)
 * is appended ONLY when rows changed, so the owning projection's ordered cursor observes the change.
 *
 * The before-drain probes pin the finding-1 servability discipline: while the deleting command's
 * deliveries are pending, the module query must FALL BACK TO LIVE (never serve the not-yet-current
 * generation).
 */

describe('Module-4 correction — SET NULL FKs produce owner-aligned projection signals (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let activities: ActivitiesService;
  let drawings: DrawingsService;
  let drawingsQuery: DrawingsQueryService;
  let dailyLog: DailyLogService;
  let dailyLogQuery: DailyLogQueryService;
  let nodes: NodesService;
  let seq = 0;

  const TINY_PDF = Buffer.from('%PDF-1.4 set-null probe').toString('base64');
  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "CommandExecution"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    activities = t.app.get(ActivitiesService);
    drawings = t.app.get(DrawingsService);
    drawingsQuery = t.app.get(DrawingsQueryService);
    dailyLog = t.app.get(DailyLogService);
    dailyLogQuery = t.app.get(DailyLogQueryService);
    nodes = t.app.get(NodesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['gateOverride', { projectId: { startsWith: 'it-snos-' } }],
      ['drawingRecipient', { projectId: { startsWith: 'it-snos-' } }],
      ['drawingRevision', { projectId: { startsWith: 'it-snos-' } }],
      ['drawing', { projectId: { startsWith: 'it-snos-' } }],
      ['siteMaterial', { dailyLog: { projectId: { startsWith: 'it-snos-' } } }],
      ['crewRow', { dailyLog: { projectId: { startsWith: 'it-snos-' } } }],
      ['dailyLog', { projectId: { startsWith: 'it-snos-' } }],
      ['inspection', { projectId: { startsWith: 'it-snos-' } }],
      ['activity', { projectId: { startsWith: 'it-snos-' } }],
      ['phase', { projectId: { startsWith: 'it-snos-' } }],
      ['notification', { projectId: { startsWith: 'it-snos-' } }],
      ['auditLog', { projectId: { startsWith: 'it-snos-' } }],
      ['projectNode', { projectId: { startsWith: 'it-snos-' } }],
      ['membership', { projectId: { startsWith: 'it-snos-' } }],
      ['project', { id: { startsWith: 'it-snos-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  /** A fresh project with an active pmc + one published zone node. */
  const freshProject = async (): Promise<{ projectId: string; nodeId: string }> => {
    const id = `it-snos-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'S', descriptor: '', stage: 'x', siteCode: 'S', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const node = await t.prisma.projectNode.create({
      data: { projectId: id, parentId: null, name: `Zone ${seq}`, kind: 'zone', order: 0, publishedAt: new Date(), authorId: f.memberUser.id },
    });
    return { projectId: id, nodeId: node.id };
  };

  /** The one planned activity of a probe project (created through the real command). */
  const createActivity = async (projectId: string): Promise<string> => {
    await activities.create(projectId, { name: 'Probe activity', zone: 'Z', plannedStart: 0, plannedEnd: 2, gateMaterial: 'na', gateTeam: 'na' } as never, pmc(projectId));
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId }, select: { id: true } });
    return a.id;
  };

  const issueDrawing = (projectId: string, opts: { activityId?: string; nodeId?: string } = {}) =>
    drawings.issue(projectId, pmc(projectId), {
      number: 'SN-1', title: 'SetNull probe', discipline: 'architectural', rev: 'A',
      status: 'for_construction', mime: 'application/pdf', data: TINY_PDF, publish: true,
      ...(opts.activityId ? { activityId: opts.activityId } : {}),
      ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
    });

  /** Drain every pending delivery of ONE consumer for a project (dispatch + noop alike). */
  const drain = async (consumer: string, projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  // ── Manifestation 1: activity delete → Drawing.activityId ──────────────────────────────────

  it('activity delete: Drawing.activityId nulls in live AND (after drain) in the drawings projection', async () => {
    const { projectId } = await freshProject();
    const actId = await createActivity(projectId);
    await issueDrawing(projectId, { activityId: actId });
    await drain(DRAWINGS_PROJECTION, projectId);
    const seeded = await drawingsQuery.projectionSlice(projectId, f.memberUser.id);
    expect(seeded.generation).toBe(1);
    expect(seeded.drawings[0]!.activityId).toBe(actId); // the linked fact IS serialized in the base

    await activities.remove(projectId, actId, pmc(projectId));
    // canonical truth immediately: the FK backstop + the participant's explicit updateMany
    expect((await t.prisma.drawing.findFirstOrThrow({ where: { projectId } })).activityId).toBeNull();

    // BEFORE the relay drains the delete's deliveries: the generation is not current → live fallback.
    const before = await drawingsQuery.moduleDrawings(projectId, f.memberUser.id);
    expect(before.source).toBe('live');
    expect(before.drawings[0]!.activityId).toBeNull();

    // AFTER a full drain: the generation must be CURRENT and the projection must EQUAL live.
    // RED at 5d24d82: no drawing-owned event exists, the delete's events are noops, the cursor
    // advances, the generation claims current — and the base still carries the deleted activity id.
    await drain(DRAWINGS_PROJECTION, projectId);
    const after = await drawingsQuery.projectionSlice(projectId, f.memberUser.id);
    expect(after.generation).toBe(1); // current again (all deliveries applied)
    expect(after.drawings[0]!.activityId).toBeNull(); // owner-aligned refresh landed
    const live = await drawingsQuery.snapshotSlice(projectId, f.memberUser.id);
    expect(after.drawings.map((d) => ({ ...d, current: d.current && { ...d.current, url: d.current.url.split('?')[0] }, revisions: d.revisions.map((r) => ({ ...r, url: r.url.split('?')[0] })) })))
      .toEqual(live.map((d) => ({ ...d, current: d.current && { ...d.current, url: d.current.url.split('?')[0] }, revisions: d.revisions.map((r) => ({ ...r, url: r.url.split('?')[0] })) })));
  });

  // ── Manifestation 2: node delete → Drawing.nodeId ──────────────────────────────────────────

  it('node delete: Drawing.nodeId nulls in live AND (after drain) in the drawings projection', async () => {
    const { projectId, nodeId } = await freshProject();
    await issueDrawing(projectId, { nodeId });
    await drain(DRAWINGS_PROJECTION, projectId);
    const seeded = await drawingsQuery.projectionSlice(projectId, f.memberUser.id);
    expect(seeded.generation).toBe(1);
    expect(seeded.drawings[0]!.nodeId).toBe(nodeId);

    await nodes.remove(projectId, nodeId, pmc(projectId));
    expect((await t.prisma.drawing.findFirstOrThrow({ where: { projectId } })).nodeId).toBeNull();

    const before = await drawingsQuery.moduleDrawings(projectId, f.memberUser.id);
    expect(before.source).toBe('live');
    expect(before.drawings[0]!.nodeId).toBeUndefined(); // the register omits an absent filing

    await drain(DRAWINGS_PROJECTION, projectId);
    const after = await drawingsQuery.projectionSlice(projectId, f.memberUser.id);
    expect(after.generation).toBe(1);
    expect(after.drawings[0]!.nodeId).toBeUndefined(); // RED at 5d24d82: still the deleted node id
  });

  // ── Manifestation 3: node delete → SiteMaterial.nodeId ─────────────────────────────────────

  it('node delete: SiteMaterial.nodeId nulls in live AND (after drain) in the daily-log projection', async () => {
    const { projectId, nodeId } = await freshProject();
    await dailyLog.start(projectId, pmc(projectId));
    await dailyLog.addMaterial(projectId, { name: 'Teak battens', qty: '12', zone: 'Z', swatch: 'tile', nodeId } as never, pmc(projectId));
    await drain(DAILY_LOG_PROJECTION, projectId);
    const seeded = await dailyLogQuery.projectionSlice(projectId);
    expect(seeded.generation).toBe(1);
    expect(seeded.materials[0]!.nodeId).toBe(nodeId);

    await nodes.remove(projectId, nodeId, pmc(projectId));
    expect((await t.prisma.siteMaterial.findFirstOrThrow({ where: { dailyLog: { projectId } } })).nodeId).toBeNull();

    const before = await dailyLogQuery.moduleDailyLog(projectId);
    expect(before.source).toBe('live');
    expect(before.materials[0]!.nodeId).toBeUndefined();

    await drain(DAILY_LOG_PROJECTION, projectId);
    const after = await dailyLogQuery.projectionSlice(projectId);
    expect(after.generation).toBe(1);
    expect(after.materials[0]!.nodeId).toBeUndefined(); // RED at 5d24d82: still the deleted node id
    const live = await dailyLogQuery.snapshotSlice(projectId);
    expect(after.materials).toEqual(live.materials);
    expect(after.dailyLog).toEqual(live.dailyLog);
  });

  // ── Two-project isolation ──────────────────────────────────────────────────────────────────

  it('two projects are isolated: A’s delete never touches B’s generations or base rows', async () => {
    const a = await freshProject();
    const b = await freshProject();
    const actA = await createActivity(a.projectId);
    const actB = await createActivity(b.projectId);
    await issueDrawing(a.projectId, { activityId: actA, nodeId: a.nodeId });
    await issueDrawing(b.projectId, { activityId: actB, nodeId: b.nodeId });
    await drain(DRAWINGS_PROJECTION, a.projectId);
    await drain(DRAWINGS_PROJECTION, b.projectId);
    const bRowBefore = await t.prisma.drawingsProjection.findFirstOrThrow({ where: { projectId: b.projectId } });

    await activities.remove(a.projectId, actA, pmc(a.projectId));
    await drain(DRAWINGS_PROJECTION, a.projectId);

    // B's generation is still current and its base row is bit-for-bit untouched
    const sB = await drawingsQuery.projectionSlice(b.projectId, f.memberUser.id);
    expect(sB.generation).toBe(1);
    expect(sB.drawings[0]!.activityId).toBe(actB);
    const bRowAfter = await t.prisma.drawingsProjection.findFirstOrThrow({ where: { projectId: b.projectId } });
    expect(bRowAfter.updatedAt).toEqual(bRowBefore.updatedAt);
    expect(bRowAfter.dto).toEqual(bRowBefore.dto);
    // A's projection reflects the unlink
    const sA = await drawingsQuery.projectionSlice(a.projectId, f.memberUser.id);
    expect(sA.generation).toBe(1);
    expect(sA.drawings[0]!.activityId).toBeNull();
  });
});
