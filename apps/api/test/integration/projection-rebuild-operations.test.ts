import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { DrawingsService } from '../../src/drawings/drawings.service';
import { DrawingsQueryService } from '../../src/drawings/drawings.query';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { DRAWINGS_PROJECTION } from '../../src/drawings/drawings.projection';
import { DAILY_LOG_PROJECTION } from '../../src/daily-log/daily-log.projection';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import { ACTIVITIES_PROJECTION } from '../../src/activities/activities.projection';
import { MATERIAL_READINESS_PROJECTION } from '../../src/activities/material-readiness.projection';
import type { AuthUser } from '../../src/common/auth';
import { Prisma } from '@prisma/client';

/**
 * Task 10 finalization — the operator rebuild's CHECKPOINT-AWARE diagnostics + attributable partial
 * runs, proven against live PostgreSQL INCLUDING under a deterministic concurrent write.
 *
 * The hardening this pins (three operator items):
 *  1. ORDINARY LAG IS NEVER CORRUPTION — a generation whose checkpoint trails the committed stream
 *     head has pending deliveries; the module read path refuses to serve it and falls back to live,
 *     so its stale stored base is invisible to users. Diagnosis must say 'lagging', not 'corrupt' —
 *     even though the stored base provably differs from canonical at that instant.
 *  2. ONLY A SERVED CONTRADICTION IS CORRUPTION — a generation at the head whose stored base differs
 *     from the module's own canonical serializer is the real defect class.
 *  3. PARTIAL RUNS STAY ATTRIBUTABLE — the invocation is audited BEFORE any rebuild, and every
 *     (project, consumer) attempt records its own success/failure outcome row.
 *
 * The concurrent-write probe is DETERMINISTIC: the rebuilder's test-only `barrierHook` fires while
 * the activation barrier HOLDS the project's stream-allocation lock, so a write started inside the
 * hook provably blocks until the barrier commits and lands at a position > H in the new generation
 * — no sleeps, no timing assumptions.
 */

describe('Task 10 finalization — checkpoint-aware operator rebuild diagnostics (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let drawings: DrawingsService;
  let drawingsQuery: DrawingsQueryService;
  let rebuilder: ProjectionRebuilder;
  let ops: ProjectionRebuildOperations;
  let seq = 0;

  const OPERATOR = 'it-prop-operator';
  const TINY_PDF = Buffer.from('%PDF-1.4 rebuild-ops probe').toString('base64');
  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    drawings = t.app.get(DrawingsService);
    drawingsQuery = t.app.get(DrawingsQueryService);
    rebuilder = t.app.get(ProjectionRebuilder);
    ops = new ProjectionRebuildOperations(t.prisma, rebuilder);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    rebuilder.barrierHook = null;
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['drawingRecipient', { projectId: { startsWith: 'it-prop-' } }],
      ['drawingRevision', { projectId: { startsWith: 'it-prop-' } }],
      ['drawing', { projectId: { startsWith: 'it-prop-' } }],
      ['notification', { projectId: { startsWith: 'it-prop-' } }],
      ['auditLog', { projectId: { startsWith: 'it-prop-' } }],
      ['projectNode', { projectId: { startsWith: 'it-prop-' } }],
      ['membership', { projectId: { startsWith: 'it-prop-' } }],
      ['project', { id: { startsWith: 'it-prop-' } }],
      ['outboxOperatorAction', { operatorIdentity: OPERATOR }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  /** A fresh project with an active pmc. */
  const freshProject = async (): Promise<string> => {
    const id = `it-prop-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };

  const issueDrawing = (projectId: string, number: string) =>
    drawings.issue(projectId, pmc(projectId), {
      number, title: `Probe ${number}`, discipline: 'architectural', rev: 'A',
      status: 'for_construction', mime: 'application/pdf', data: TINY_PDF, publish: true,
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

  it('a checkpoint that trails the committed head is LAG, never corruption — even with a provably stale base', async () => {
    const projectId = await freshProject();
    await issueDrawing(projectId, 'RB-1');
    await drain(DRAWINGS_PROJECTION, projectId);
    expect((await ops.diagnose(DRAWINGS_PROJECTION, projectId)).state).toBe('current-match');

    // A second write commits but its deliveries are NOT applied: head advances, checkpoint trails.
    await issueDrawing(projectId, 'RB-2');
    const d = await ops.diagnose(DRAWINGS_PROJECTION, projectId);
    expect(d.state).toBe('lagging'); // NOT 'corrupt' — the read path is already serving live
    expect(BigInt(d.appliedPosition!)).toBeLessThan(BigInt(d.streamHead!));
    // the read path indeed refuses the lagging generation (the lag is invisible to users)
    expect((await drawingsQuery.moduleDrawings(projectId, f.memberUser.id)).source).toBe('live');

    await drain(DRAWINGS_PROJECTION, projectId);
    expect((await ops.diagnose(DRAWINGS_PROJECTION, projectId)).state).toBe('current-match');
  });

  it('a SERVED base that contradicts canonical is corruption; the run repairs it and audits every step', async () => {
    const projectId = await freshProject();
    await issueDrawing(projectId, 'RB-3');
    await drain(DRAWINGS_PROJECTION, projectId);

    // Corrupt the CURRENT generation's stored base directly (the defect class the command repairs).
    const gen = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: DRAWINGS_PROJECTION, projectId, status: 'active' } });
    await t.prisma.drawingsProjection.update({
      where: { generationId_projectId: { generationId: gen.id, projectId } },
      data: { dto: { corrupted: true } as unknown as Prisma.InputJsonValue },
    });
    expect((await ops.diagnose(DRAWINGS_PROJECTION, projectId)).state).toBe('corrupt');

    const report = await ops.run({ operatorIdentity: OPERATOR, reason: 'repair corrupted probe generation', projectId });
    expect(report.ok).toBe(true);
    expect(report.corruptBefore).toBe(1); // the drawings pair
    expect(report.corruptAfter).toBe(0);
    expect(report.failures).toBe(0);
    const drawingsAttempt = report.results.find((r) => r.consumer === DRAWINGS_PROJECTION)!;
    expect(drawingsAttempt.before.state).toBe('corrupt');
    expect(drawingsAttempt.after?.state).toBe('current-match');

    // The invocation record precedes the per-pair outcome records, and every pair recorded one —
    // the default run covers ALL FIVE production projections (final-review P1 correction).
    const audits = await t.prisma.outboxOperatorAction.findMany({ where: { operatorIdentity: OPERATOR }, orderBy: { at: 'asc' } });
    expect(audits[0]!.action).toBe('projection.rebuild');
    expect(audits[0]!.reason).toBe('repair corrupted probe generation');
    const outcomes = audits.filter((a) => a.action === 'projection.rebuild.result');
    expect(outcomes.map((o) => o.consumer).sort()).toEqual(
      [DECISIONS_PROJECTION, DAILY_LOG_PROJECTION, DRAWINGS_PROJECTION, INSPECTIONS_PROJECTION, ACTIVITIES_PROJECTION, MATERIAL_READINESS_PROJECTION].sort(),
    );
    for (const o of outcomes) {
      expect(o.projectId).toBe(projectId);
      expect(o.reason).toMatch(/^ok: generation \d+/);
      expect(o.priorError).toBeNull();
    }
  });

  it('a deterministic CONCURRENT write held at the activation barrier lands > H and reads as lag, then catches up clean', async () => {
    const projectId = await freshProject();
    await issueDrawing(projectId, 'RB-4');
    await drain(DRAWINGS_PROJECTION, projectId);

    // The held-write-at-handoff pattern: the hook fires INSIDE the barrier while the stream lock is
    // held, so the write started here provably blocks until activation commits and lands > H.
    let held: Promise<unknown> | null = null;
    rebuilder.barrierHook = async () => {
      held = issueDrawing(projectId, 'RB-5');
    };
    const result = await rebuilder.rebuild(DRAWINGS_PROJECTION, projectId);
    rebuilder.barrierHook = null;
    expect(held).not.toBeNull();
    await held; // the blocked write completes only after the barrier released the lock

    // The concurrent write advanced the head past the fresh generation's checkpoint H: ordinary lag.
    const d = await ops.diagnose(DRAWINGS_PROJECTION, projectId);
    expect(d.state).toBe('lagging');
    expect(BigInt(d.appliedPosition!)).toBe(result.checkpoint!); // checkpoint is exactly H
    expect(BigInt(d.streamHead!)).toBeGreaterThan(result.checkpoint!);

    // Draining the >H deliveries catches the SAME generation up — no rebuild needed, and the base
    // now includes the concurrently-written drawing (live == projection).
    await drain(DRAWINGS_PROJECTION, projectId);
    expect((await ops.diagnose(DRAWINGS_PROJECTION, projectId)).state).toBe('current-match');
    const slice = await drawingsQuery.projectionSlice(projectId, f.memberUser.id);
    expect(slice.drawings.map((x) => x.number).sort()).toEqual(['RB-4', 'RB-5']);
  });

  it('one pair failure is recorded and does not abort the rest of the run', async () => {
    const projectId = await freshProject();
    await issueDrawing(projectId, 'RB-6');
    // Sabotage ONLY the daily-log rebuild via the barrier hook (throw on its second invocation is
    // not deterministic — instead target the consumer registry indirectly: an unknown consumer in
    // the list is rejected up-front, so use a per-call hook that fails for daily-log's rebuild).
    const original = rebuilder.rebuild.bind(rebuilder);
    const failing = async (consumerName: string, pid: string) => {
      if (consumerName === DAILY_LOG_PROJECTION) throw new Error('injected daily-log failure');
      return original(consumerName, pid);
    };
    (rebuilder as { rebuild: typeof rebuilder.rebuild }).rebuild = failing as typeof rebuilder.rebuild;
    try {
      const report = await ops.run({ operatorIdentity: OPERATOR, reason: 'partial-failure attribution probe', projectId });
      expect(report.ok).toBe(false);
      expect(report.failures).toBe(1);
      const failed = report.results.find((r) => r.consumer === DAILY_LOG_PROJECTION)!;
      expect(failed.rebuilt).toBe(false);
      expect(failed.error).toContain('injected daily-log failure');
      const succeeded = report.results.find((r) => r.consumer === DRAWINGS_PROJECTION)!;
      expect(succeeded.rebuilt).toBe(true); // the failure did not abort the drawings pair
      // both outcomes are attributably recorded — the failed pair carries its error
      const outcomes = await t.prisma.outboxOperatorAction.findMany({ where: { operatorIdentity: OPERATOR, action: 'projection.rebuild.result' } });
      expect(outcomes.find((o) => o.consumer === DAILY_LOG_PROJECTION)!.priorError).toContain('injected daily-log failure');
      expect(outcomes.find((o) => o.consumer === DRAWINGS_PROJECTION)!.priorError).toBeNull();
    } finally {
      (rebuilder as { rebuild: typeof rebuilder.rebuild }).rebuild = original;
    }
  });
});
