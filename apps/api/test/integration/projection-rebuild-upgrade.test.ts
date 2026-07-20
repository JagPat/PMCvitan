import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { DrawingsService } from '../../src/drawings/drawings.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { serializeDecision } from '../../src/decisions/decision-serialize';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { DAILY_LOG_PROJECTION } from '../../src/daily-log/daily-log.projection';
import { DRAWINGS_PROJECTION } from '../../src/drawings/drawings.projection';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import { ACTIVITIES_PROJECTION } from '../../src/activities/activities.projection';
import type { AuthUser } from '../../src/common/auth';
import { Prisma } from '@prisma/client';

/**
 * Phase 2 final-review P1 correction — the PRODUCTION UPGRADE PATH for `decisions.inbox`,
 * REPRODUCE-FIRST against live PostgreSQL.
 *
 * The defect this pins (found by the independent Phase-2 review at `main` c94aee3): the pre-#183
 * per-event decisions consumer materialized ONLY the decisions that had post-bootstrap events, so a
 * production database upgraded to #183 can carry an ACTIVE, CAUGHT-UP `decisions.inbox` generation
 * holding a NON-EMPTY SUBSET of the canonical register. The merged read path serves it as
 * authoritative — `readServableGeneration` sees healthy + caught-up, and the hollow guard passes
 * because the row set is non-empty — silently hiding every other decision until the NEXT decision
 * event triggers the full-refresh. At c94aee3 the operator rebuild could not repair it either:
 * `decisions.inbox` was not in the rebuildable registry (`diagnose` threw, `run()` covered only
 * drawings.inbox + daily-log.inbox), so this file is RED there and green at the correction head.
 *
 * The correction proven here:
 *  1. the legacy partial generation is REPRODUCED faithfully (canonical decisions that predate the
 *     stream, one foreign event for the committed head, an active caught-up generation with a
 *     1-of-3 subset) and shown SERVED as `source: 'projection'` — the reproduce step;
 *  2. the row-SET diagnostic calls it 'corrupt' (a served contradiction — decisionId, status,
 *     publishedAt as ISO, authorId AND dto compared over the COMPLETE ordered row set);
 *  3. the DEFAULT operator run — no `--consumer` — covers ALL FIVE production projections and
 *     repairs it WITHOUT any decision event, leaving live == projection == rebuild;
 *  4. the invocation and every per-consumer outcome are audited;
 *  5. every diagnostic state of the decisions adapter is covered: zero-decision, complete,
 *     partial, lagging and corrupt.
 */

const ALL_FIVE = [DECISIONS_PROJECTION, DAILY_LOG_PROJECTION, DRAWINGS_PROJECTION, INSPECTIONS_PROJECTION, ACTIVITIES_PROJECTION];

describe('P1 correction — legacy partial decisions.inbox generation upgrade path (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let drawings: DrawingsService;
  let decisionsQuery: DecisionsQueryService;
  let ops: ProjectionRebuildOperations;
  let seq = 0;

  const OPERATOR = 'it-upg-operator';
  const TINY_PDF = Buffer.from('%PDF-1.4 upgrade probe').toString('base64');
  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "CommandExecution"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    drawings = t.app.get(DrawingsService);
    decisionsQuery = t.app.get(DecisionsQueryService);
    ops = new ProjectionRebuildOperations(t.prisma, t.app.get(ProjectionRebuilder));
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['decisionOption', { decision: { projectId: { startsWith: 'it-upg-' } } }],
      ['decisionEvent', { decision: { projectId: { startsWith: 'it-upg-' } } }],
      ['decision', { projectId: { startsWith: 'it-upg-' } }],
      ['drawingRecipient', { projectId: { startsWith: 'it-upg-' } }],
      ['drawingRevision', { projectId: { startsWith: 'it-upg-' } }],
      ['drawing', { projectId: { startsWith: 'it-upg-' } }],
      ['notification', { projectId: { startsWith: 'it-upg-' } }],
      ['auditLog', { projectId: { startsWith: 'it-upg-' } }],
      ['projectNode', { projectId: { startsWith: 'it-upg-' } }],
      ['membership', { projectId: { startsWith: 'it-upg-' } }],
      ['project', { id: { startsWith: 'it-upg-' } }],
      ['outboxOperatorAction', { operatorIdentity: OPERATOR }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  /** A fresh project with an active pmc. */
  const freshProject = async (): Promise<string> => {
    const id = `it-upg-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };

  /** A canonical PUBLISHED decision created DIRECTLY (predates the event stream — the seeded /
   *  imported register the legacy consumer lazily bootstrapped over; no decision event exists). */
  const makeDecision = async (projectId: string, id: string): Promise<void> => {
    await t.prisma.decision.create({
      data: {
        id,
        projectId,
        title: `Upgrade probe ${id}`,
        room: 'Living',
        photoSwatch: 'sw-probe',
        status: 'pending',
        publishedAt: new Date('2026-07-01T00:00:00.000Z'),
        authorId: f.memberUser.id,
        options: {
          create: [
            { label: 'Option A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw-a', order: 1, recommended: true },
            { label: 'Option B', optionKey: 'b', material: 'Walnut', delta: 25000, swatch: 'sw-b', order: 2 },
          ],
        },
      },
    });
  };

  /** A FOREIGN (non-decision) event — establishes the committed stream head without ever firing
   *  the decisions consumer's full refresh. */
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

  /**
   * Manufacture the EXACT legacy state a production upgrade carries: an ACTIVE `decisions.inbox`
   * generation whose checkpoint is AT the committed stream head (caught up — `readServableGeneration`
   * will serve it) but whose row set holds only `storedIds` — what the pre-#183 per-event consumer
   * materialized when it bootstrapped over pre-stream canonical rows. Each stored row is BUILT WITH
   * THE REAL SERIALIZER, so the row itself is byte-correct: the defect is purely the MISSING rows.
   */
  const manufactureLegacyGeneration = async (projectId: string, storedIds: string[]): Promise<{ id: string }> => {
    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId }, select: { nextPosition: true } });
    const gen = await t.prisma.projectionGeneration.create({
      data: { consumer: DECISIONS_PROJECTION, projectId, generation: 1, status: 'active', cursorStatus: 'live', appliedPosition: stream.nextPosition - 1n, activatedAt: new Date() },
    });
    for (const id of storedIds) {
      const d = await t.prisma.decision.findUniqueOrThrow({
        where: { id },
        include: { options: { orderBy: { order: 'asc' } }, changeRequests: { where: { status: 'open' }, take: 1 } },
      });
      await t.prisma.decisionProjection.create({
        data: {
          generationId: gen.id,
          projectId,
          decisionId: d.id,
          status: d.status,
          publishedAt: d.publishedAt,
          authorId: d.authorId,
          dto: serializeDecision(d) as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return gen;
  };

  it('UPGRADE PATH: a caught-up legacy generation holding a NON-EMPTY SUBSET is served as authoritative; the DEFAULT operator run repairs it with NO decision event', async () => {
    const projectId = await freshProject();
    await makeDecision(projectId, 'IT-UP-D1');
    await makeDecision(projectId, 'IT-UP-D2');
    await makeDecision(projectId, 'IT-UP-D3');
    await issueDrawing(projectId, 'UP-1');
    await manufactureLegacyGeneration(projectId, ['IT-UP-D1']);

    // REPRODUCE the merged-#183 defect: the generation is healthy and caught-up, the row set is
    // non-empty so the read-side hollow guard passes — the PARTIAL register is served as
    // authoritative, silently hiding 2 of the 3 canonical decisions.
    const before = await decisionsQuery.moduleDecisions(projectId, 'pmc', f.memberUser.id);
    expect(before.source).toBe('projection');
    expect(before.decisions.map((d) => d.id)).toEqual(['IT-UP-D1']);

    // The row-SET diagnostic names it: a SERVED contradiction of canonical — corrupt, not lag.
    // (At c94aee3 this line THROWS — 'decisions.inbox is not an operator-rebuildable projection'.)
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('corrupt');

    // The DEFAULT operator run (no consumer filter) covers ALL FIVE production projections and
    // repairs the partial generation WITHOUT any decision event being emitted.
    const report = await ops.run({ operatorIdentity: OPERATOR, reason: 'production upgrade rebuild', projectId });
    expect(report.ok).toBe(true);
    expect([...report.consumers].sort()).toEqual([...ALL_FIVE].sort());
    expect(report.corruptAfter).toBe(0);
    expect(report.failures).toBe(0);
    const decisionsAttempt = report.results.find((r) => r.consumer === DECISIONS_PROJECTION)!;
    expect(decisionsAttempt.before.state).toBe('corrupt');
    expect(decisionsAttempt.after?.state).toBe('current-match');

    // live == projection == rebuild for the COMPLETE register, served as 'projection' again.
    const after = await decisionsQuery.moduleDecisions(projectId, 'pmc', f.memberUser.id);
    expect(after.source).toBe('projection');
    expect(after.decisions.map((d) => d.id).sort()).toEqual(['IT-UP-D1', 'IT-UP-D2', 'IT-UP-D3']);
    const live = await decisionsQuery.snapshotSlice(projectId, 'pmc', f.memberUser.id);
    expect(after.decisions).toEqual(live.decisions);
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('current-match');

    // The invocation and every per-consumer outcome are audited — the run is attributable in full.
    const audits = await t.prisma.outboxOperatorAction.findMany({ where: { operatorIdentity: OPERATOR }, orderBy: { at: 'asc' } });
    expect(audits[0]!.action).toBe('projection.rebuild');
    expect(audits[0]!.reason).toBe('production upgrade rebuild');
    const outcomes = audits.filter((a) => a.action === 'projection.rebuild.result');
    expect(outcomes.map((o) => o.consumer).sort()).toEqual([...ALL_FIVE].sort());
    const decisionsOutcome = outcomes.find((o) => o.consumer === DECISIONS_PROJECTION)!;
    expect(decisionsOutcome.reason).toMatch(/^ok: generation \d+ current-match \(before: corrupt\)$/);
    expect(decisionsOutcome.priorError).toBeNull();
  });

  it('ZERO-DECISION: a noop-advanced generation with no rows over an empty canonical register is current-match', async () => {
    const projectId = await freshProject();
    await issueDrawing(projectId, 'UP-Z1'); // foreign event; its decisions.inbox delivery is a noop
    await drain(DECISIONS_PROJECTION, projectId);
    // the noop bootstrap left an active, caught-up, EMPTY generation — and canonical is empty too
    const d = await ops.diagnose(DECISIONS_PROJECTION, projectId);
    expect(d.state).toBe('current-match');
    expect(d.generation).not.toBeNull();
  });

  it('COMPLETE: a caught-up generation holding the full normalized row set is current-match (ISO publishedAt on both sides)', async () => {
    const projectId = await freshProject();
    await makeDecision(projectId, 'IT-UP-C1');
    await makeDecision(projectId, 'IT-UP-C2');
    await makeDecision(projectId, 'IT-UP-C3');
    await issueDrawing(projectId, 'UP-C');
    await manufactureLegacyGeneration(projectId, ['IT-UP-C1', 'IT-UP-C2', 'IT-UP-C3']);
    // a stored Date vs canonical ISO-string mismatch (or any key-column normalization drift) would
    // make this COMPLETE set read as corrupt — current-match proves both sides normalize identically
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('current-match');
  });

  it('PARTIAL: a caught-up generation missing canonical decisions is corrupt — the emptiness-only probe would call it healthy', async () => {
    const projectId = await freshProject();
    await makeDecision(projectId, 'IT-UP-P1');
    await makeDecision(projectId, 'IT-UP-P2');
    await makeDecision(projectId, 'IT-UP-P3');
    await issueDrawing(projectId, 'UP-P');
    await manufactureLegacyGeneration(projectId, ['IT-UP-P1', 'IT-UP-P2']);
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('corrupt');
  });

  it('LAGGING: a checkpoint behind the committed head is ordinary lag, never corruption — and a drain catches it up clean', async () => {
    const projectId = await freshProject();
    await makeDecision(projectId, 'IT-UP-L1');
    await issueDrawing(projectId, 'UP-L1');
    await manufactureLegacyGeneration(projectId, ['IT-UP-L1']); // complete AND caught up
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('current-match');

    // a second foreign write advances the head past the generation's checkpoint: ordinary lag —
    // the read path already refuses it, so the row comparison is never even consulted
    await issueDrawing(projectId, 'UP-L2');
    const d = await ops.diagnose(DECISIONS_PROJECTION, projectId);
    expect(d.state).toBe('lagging');
    expect(BigInt(d.appliedPosition!)).toBeLessThan(BigInt(d.streamHead!));
    expect((await decisionsQuery.moduleDecisions(projectId, 'pmc', f.memberUser.id)).source).toBe('live');

    await drain(DECISIONS_PROJECTION, projectId);
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('current-match');
  });

  it('CORRUPT: a tampered KEY COLUMN on a stored row (identical dto) is caught — the comparison covers the full normalized row, not just the payload', async () => {
    const projectId = await freshProject();
    await makeDecision(projectId, 'IT-UP-K1');
    await issueDrawing(projectId, 'UP-K');
    const gen = await manufactureLegacyGeneration(projectId, ['IT-UP-K1']);
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('current-match');

    // flip only the key column the readiness map + pending filter read; the dto stays byte-correct
    await t.prisma.decisionProjection.update({
      where: { generationId_decisionId: { generationId: gen.id, decisionId: 'IT-UP-K1' } },
      data: { status: 'approved' },
    });
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('corrupt');

    // the operator run repairs it back to a matching generation
    const report = await ops.run({ operatorIdentity: OPERATOR, reason: 'repair tampered key column', projectId, consumers: [DECISIONS_PROJECTION] });
    expect(report.ok).toBe(true);
    expect((await ops.diagnose(DECISIONS_PROJECTION, projectId)).state).toBe('current-match');
  });
});
