import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import type { Actor } from '../../src/common/actor';
import type { Role } from '../../src/common/auth';

/**
 * Phase 2 Task 9 Step 2 — the DECISIONS read path moves onto its rebuildable projection, proven
 * EQUIVALENT to the live snapshot slice (the Task-1 characterization) and proven live == rebuild.
 *
 * The `decisions.inbox` projection consumer (registered by the app boot) maintains a DecisionProjection
 * row per decision from the canonical Decision on every `decision.*` event. The module's
 * `projectionSlice` serves those rows with the SAME per-viewer authz filter as `snapshotSlice`, so the
 * two are byte-identical — for every role, and after a full rebuild.
 */

const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };

describe('Phase 2 Task 9 — decisions projection == live slice, live == rebuild (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let query: DecisionsQueryService;
  let authorId = '';
  let projSeq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    query = t.app.get(DecisionsQueryService);
    human.actorId = f.memberUser.id;
    authorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection"');
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { startsWith: 'it-dpj-' } } } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { startsWith: 'it-dpj-' } } } });
    await t.prisma.decision.deleteMany({ where: { projectId: { startsWith: 'it-dpj-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-dpj-' } } });
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-dpj-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    return id;
  };

  /** Create a canonical decision (with one option) and emit its lifecycle event, so the projection
   *  consumer has a delivery to apply. `draft` → published_at null + a `decision.drafted` event. */
  const makeDecision = async (
    projectId: string,
    id: string,
    opts: { status?: 'pending' | 'approved' | 'change'; draft?: boolean; withChangeRequest?: boolean } = {},
  ): Promise<void> => {
    const status = opts.status ?? 'pending';
    const publishedAt = opts.draft ? null : new Date();
    await t.prisma.decision.create({
      data: { id, projectId, title: `Title ${id}`, room: 'GF · Living', status, ageDays: 2, photoSwatch: 'marble', publishedAt, authorId },
    });
    await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'Opt A', optionKey: 'a', material: 'Teak', delta: 1000, swatch: 'teak', recommended: true, order: 0 } });
    if (opts.withChangeRequest) {
      await t.prisma.changeRequest.create({ data: { decisionId: id, reason: 'reopen', costImpact: 500, timeImpactDays: 3, status: 'open', requestedById: authorId } });
    }
    const eventType = opts.draft ? 'decision.drafted' : status === 'change' ? 'decision.change_requested' : status === 'approved' ? 'decision.approved' : 'decision.published';
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType, entityType: 'Decision', entityId: id, effectKey: eventType, dispatch: {} }));
  };

  /** Drain every pending decisions.inbox (and noop) delivery for a project. */
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DECISIONS_PROJECTION, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  const seedMix = async (projectId: string): Promise<void> => {
    await makeDecision(projectId, 'DL-001', { status: 'pending' });
    await makeDecision(projectId, 'DL-002', { status: 'approved' });
    await makeDecision(projectId, 'DL-003', { status: 'change', withChangeRequest: true });
    await makeDecision(projectId, 'DL-004', { draft: true }); // author-private draft
  };

  const roles: Role[] = ['pmc', 'client', 'engineer', 'contractor'];

  it('the projection slice is BYTE-IDENTICAL to the live snapshot slice for every role', async () => {
    const p = await freshProject();
    await seedMix(p);
    await applyProjection(p);

    for (const role of roles) {
      const live = await query.snapshotSlice(p, role, authorId);
      const proj = await query.projectionSlice(p, role, authorId);
      expect(proj.decisions, `decisions for role=${role}`).toEqual(live.decisions);
      // the unfiltered readiness map matches too (every decision's true status)
      expect([...proj.statuses.entries()].sort()).toEqual([...live.statuses.entries()].sort());
    }
    // the projection served from an ACTIVE generation
    const proj = await query.projectionSlice(p, 'pmc', authorId);
    expect(proj.generation).toBe(1);
  });

  it('query-time authz holds on the projection: pending hidden from non-pmc/client, drafts author-only', async () => {
    const p = await freshProject();
    await seedMix(p);
    await applyProjection(p);

    const asPmc = await query.projectionSlice(p, 'pmc', authorId);
    // pmc sees the pending decision + the (published) approved + change; and the author sees their draft
    expect(asPmc.decisions.map((d) => d.id).sort()).toEqual(['DL-001', 'DL-002', 'DL-003', 'DL-004']);

    // an engineer never sees the pending decision, and never sees someone else's draft
    const asEngOther = await query.projectionSlice(p, 'engineer', 'someone-else');
    const engIds = asEngOther.decisions.map((d) => d.id);
    expect(engIds).not.toContain('DL-001'); // pending — hidden from engineer
    expect(engIds).not.toContain('DL-004'); // draft — author-private
    expect(engIds.sort()).toEqual(['DL-002', 'DL-003']);

    // the draft is visible ONLY to its author
    const draftForAuthor = (await query.projectionSlice(p, 'engineer', authorId)).decisions.map((d) => d.id);
    expect(draftForAuthor).toContain('DL-004');
  });

  it('live == rebuild: a rebuild activates a new generation (checkpoint == H) whose slice matches the live one', async () => {
    const p = await freshProject();
    await seedMix(p);
    await applyProjection(p);
    const before = await query.projectionSlice(p, 'pmc', authorId);
    expect(before.generation).toBe(1);

    // the final committed position for the project
    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p } });
    const H = stream.nextPosition - 1n;

    const res = await rebuilder.rebuild(DECISIONS_PROJECTION, p);
    expect(res.checkpoint).toBe(H); // activated at the barrier position
    const after = await query.projectionSlice(p, 'pmc', authorId);
    expect(after.generation).toBe(2); // now serving the rebuilt generation
    // live == rebuild == snapshot: identical served decisions across the generation swap
    const live = await query.snapshotSlice(p, 'pmc', authorId);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.decisions).toEqual(live.decisions);
  });

  it('two projects are isolated: each has its own active decisions generation', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await makeDecision(p1, 'DL-A', { status: 'pending' });
    await makeDecision(p2, 'DL-B', { status: 'approved' });
    await applyProjection(p1);
    await applyProjection(p2);

    const s1 = await query.projectionSlice(p1, 'pmc', authorId);
    const s2 = await query.projectionSlice(p2, 'pmc', authorId);
    expect(s1.decisions.map((d) => d.id)).toEqual(['DL-A']);
    expect(s2.decisions.map((d) => d.id)).toEqual(['DL-B']);
  });
});
