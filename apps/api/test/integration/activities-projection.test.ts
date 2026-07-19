import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { PhasesService } from '../../src/activities/phases.service';
import { ActivitiesQueryService } from '../../src/activities/activities.query';
import { ACTIVITIES_PROJECTION } from '../../src/activities/activities.projection';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import { NodesService } from '../../src/nodes/nodes.service';
import { OrgsService } from '../../src/orgs/orgs.service';
import type { AuthUser } from '../../src/common/auth';
import type { Actor } from '../../src/common/actor';
import type { CreateActivityInput } from '../../src/contracts';

/**
 * Phase 2 Task 10 (Module 4) — the ACTIVITIES read path moves onto its rebuildable projection, proven
 * EQUIVALENT to the live snapshot slices and proven live == rebuild.
 *
 * The `activities.schedule` projection consumer (registered at boot) maintains ONE per-project
 * ActivitiesProjection base row from canonical state on every `activity.*`/`phase.*` event. Like
 * inspections (a per-PROJECT composite, not one row per entity), the module's `projectionSlice` bakes the
 * whole set of slices from that base — byte-identical to `snapshotSlice`, before and after a full rebuild.
 * The finding-1 servability gate (never serve a lagging/blocked/no-row generation) is proven exactly as
 * for inspections. The Module-3 owner-aligned invariant is proven for every FOREIGN mutation of an
 * activity-owned serialized fact: the daily-log material mismatch (`activity.material_blocked`), a node
 * deletion (`activity.unfiled`), the closing-inspection approval (`activity.signed_off`, emitted by
 * inspections decide) and project initialization (`activity.created`/`phase.created` {init:true}) each
 * reach the ordered cursor, so a caught-up projection can never serve a stale conclusion. The activity
 * slices carry no per-read signed path, so every comparison is byte-for-byte with no token stripping.
 */

const human: Actor = { actorId: '', actorName: 'System', actorRole: 'system', actorKind: 'system' };

describe('Phase 2 Task 10 (Module 4) — activities projection == live slices, live == rebuild (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let svc: ActivitiesService;
  let phasesSvc: PhasesService;
  let query: ActivitiesQueryService;
  let inspectionsSvc: InspectionsService;
  let dailyLog: DailyLogService;
  let nodes: NodesService;
  let orgs: OrgsService;
  let projSeq = 0;

  const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "ActivitiesProjection", "InspectionsProjection"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const eng = (projectId: string, engId: string): AuthUser => ({ sub: engId, role: 'engineer', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    svc = t.app.get(ActivitiesService);
    phasesSvc = t.app.get(PhasesService);
    query = t.app.get(ActivitiesQueryService);
    inspectionsSvc = t.app.get(InspectionsService);
    dailyLog = t.app.get(DailyLogService);
    nodes = t.app.get(NodesService);
    orgs = t.app.get(OrgsService);
    human.actorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const pids = { startsWith: 'it-acpj-' };
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
    await t.prisma.gateOverride.deleteMany({ where: { projectId: pids } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pids } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pids } });
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: pids } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { projectId: pids } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.activity.deleteMany({ where: { projectId: pids } });
    await t.prisma.phase.deleteMany({ where: { projectId: pids } });
    await t.prisma.decision.deleteMany({ where: { projectId: pids } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: pids } });
    await t.prisma.notification.deleteMany({ where: { projectId: pids } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-acpj-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  /** A fresh project with an active pmc + one active engineer. Returns the ids. */
  const freshProject = async (): Promise<{ id: string; engId: string }> => {
    const id = `it-acpj-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const engId = `it-acpj-u-eng-${projSeq}`;
    await t.prisma.user.create({ data: { id: engId, projectId: id, role: 'engineer', name: 'Eng One', email: `${engId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: id, userId: engId, role: 'engineer', status: 'active' } });
    return { id, engId };
  };

  /** Plan an activity through the module command and return its id. */
  const createActivity = async (projectId: string, name: string, over: Partial<CreateActivityInput> = {}): Promise<string> => {
    await svc.create(projectId, { name, zone: 'GF', plannedStart: 0, plannedEnd: 5, gateMaterial: 'na', gateTeam: 'na', ...over } as CreateActivityInput, pmc(projectId));
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId, name } });
    return a.id;
  };

  /** Seed a CANONICAL activity + phase WITHOUT emitting any activity/phase event — the legacy/
   *  pre-projection shape the finding-1 probe needs (real data, no activity delivery to apply). */
  const seedLegacyActivity = async (projectId: string, name: string): Promise<void> => {
    const phase = await t.prisma.phase.create({ data: { projectId, name: 'Legacy phase', order: 1, plannedStart: 0, plannedEnd: 10 } });
    await t.prisma.activity.create({
      data: { id: `ACT-legacy-${projSeq++}`, projectId, name, zone: 'GF', plannedStart: 0, plannedEnd: 5, order: 1, phaseId: phase.id },
    });
  };

  /** Drain every pending activities.schedule (and noop) delivery for a project. */
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 60; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: ACTIVITIES_PROJECTION, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  /** The Module-4 invariant: a CURRENT projection equals the live read, byte for byte. */
  const expectProjectionCurrentAndEqualsLive = async (projectId: string): Promise<void> => {
    const live = await query.snapshotSlice(projectId);
    const proj = await query.projectionSlice(projectId);
    expect(proj.generation, 'projection reports itself CURRENT (a caught-up generation with a row)').not.toBeNull();
    expect(proj.slices, 'a CURRENT projection MUST equal the live read').toEqual(live);
  };

  it('the projection slices are BYTE-IDENTICAL to the live snapshot slices', async () => {
    const p = await freshProject();
    await phasesSvc.create(p.id, { name: 'Structure', plannedStart: 0, plannedEnd: 10 }, pmc(p.id));
    const phase = await t.prisma.phase.findFirstOrThrow({ where: { projectId: p.id, name: 'Structure' } });
    const slabId = await createActivity(p.id, 'Slab pour', { phaseId: phase.id });
    await createActivity(p.id, 'Plaster');
    // a manual exception + a real transition, so the base carries overrides AND actuals
    await svc.override(p.id, slabId, { gate: 'material', state: 'ok', reason: 'Advance PO cleared', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, pmc(p.id));
    await svc.start(p.id, slabId, eng(p.id, p.engId));
    await applyProjection(p.id);

    const live = await query.snapshotSlice(p.id);
    const proj = await query.projectionSlice(p.id);
    expect(proj.generation).toBe(1); // served from an ACTIVE generation
    expect(proj.slices).toEqual(live);
    // structure sanity: the started activity reports in-progress with its active override; the phase
    // rollup counts its one filed activity.
    const slab = proj.slices.activities.find((a) => a.id === slabId);
    expect(slab?.status).toBe('in-progress');
    expect(slab?.overrides).toHaveLength(1);
    expect(proj.slices.phases.map((ph) => [ph.name, ph.activityTotal])).toEqual([['Structure', 1]]);
  });

  it('finding 1: legacy canonical data + only a no-op serves LIVE, never authoritative-empty projection', async () => {
    const p = await freshProject();
    await seedLegacyActivity(p.id, 'Legacy waterproofing'); // canonical activity+phase, NO activity event ever emitted
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p.id, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p.id, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p.id);
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: ACTIVITIES_PROJECTION, projectId: p.id, status: 'active' } });
    expect(gen).not.toBeNull(); // an active, caught-up generation exists — but has no row for this project
    const mod = await query.moduleActivities(p.id);
    expect(mod.source).toBe('live'); // MUST fall back to canonical live, not serve the empty projection
    expect(mod.generation).toBeNull();
    expect(mod.activities.map((a) => a.name)).toEqual(['Legacy waterproofing']);
    expect((await query.projectionSlice(p.id)).generation).toBeNull();
  });

  it('finding 1: a LAGGING checkpoint (a committed activity not yet applied) serves live', async () => {
    const p = await freshProject();
    await createActivity(p.id, 'Applied act');
    await applyProjection(p.id);
    expect((await query.projectionSlice(p.id)).generation).toBe(1); // fully applied → servable
    await createActivity(p.id, 'Lagging act'); // committed but NOT applied → checkpoint lags head
    const proj = await query.projectionSlice(p.id);
    expect(proj.generation).toBeNull(); // appliedPosition < stream head → not current → fallback
    const mod = await query.moduleActivities(p.id);
    expect(mod.source).toBe('live');
    expect(mod.generation).toBeNull();
    expect(mod.activities.map((a) => a.name).sort()).toEqual(['Applied act', 'Lagging act']); // live reflects newest canonical
  });

  it('finding 1: a BLOCKED generation serves live; a caught-up healthy one serves the projection', async () => {
    const p = await freshProject();
    await createActivity(p.id, 'Blocked act');
    await applyProjection(p.id);
    // caught-up + healthy → the module read serves the projection with its non-null generation
    const healthy = await query.moduleActivities(p.id);
    expect(healthy.source).toBe('projection');
    expect(healthy.generation).toBe(1);
    await t.prisma.projectionGeneration.updateMany({ where: { consumer: ACTIVITIES_PROJECTION, projectId: p.id, status: 'active' }, data: { cursorStatus: 'blocked' } });
    expect((await query.projectionSlice(p.id)).generation).toBeNull();
    expect((await query.moduleActivities(p.id)).source).toBe('live');
  });

  it('live == rebuild: a rebuild activates a new generation (checkpoint == H) whose slices match the live ones', async () => {
    const p = await freshProject();
    await phasesSvc.create(p.id, { name: 'Rebuild phase', plannedStart: 0, plannedEnd: 10 }, pmc(p.id));
    const phase = await t.prisma.phase.findFirstOrThrow({ where: { projectId: p.id, name: 'Rebuild phase' } });
    const aId = await createActivity(p.id, 'Rebuild act', { phaseId: phase.id });
    await svc.start(p.id, aId, eng(p.id, p.engId));
    await applyProjection(p.id);
    const before = await query.projectionSlice(p.id);
    expect(before.generation).toBe(1);

    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p.id } });
    const H = stream.nextPosition - 1n;

    const res = await rebuilder.rebuild(ACTIVITIES_PROJECTION, p.id);
    expect(res.checkpoint).toBe(H);
    const after = await query.projectionSlice(p.id);
    expect(after.generation).toBe(2);
    const live = await query.snapshotSlice(p.id);
    expect(after.slices).toEqual(before.slices);
    expect(after.slices).toEqual(live);
  });

  // ── FOREIGN-mutation refresh (the Module-3 owner-aligned invariant, applied up front) ──

  it('daily-log flagMismatch blocks the linked activity; the caught-up projection shows it; projection == live', async () => {
    const p = await freshProject();
    const decisionId = `DL-acpj-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.decision.create({
      data: { id: decisionId, projectId: p.id, title: 'Flooring', room: 'Living', status: 'approved', photoSwatch: 'marble', publishedAt: new Date() },
    });
    const actId = await createActivity(p.id, 'Lay flooring', { decisionId });
    await applyProjection(p.id);
    await expectProjectionCurrentAndEqualsLive(p.id);

    // the material mismatch blocks the linked activity THROUGH the participant, which appends
    // `activity.material_blocked` in the same locked transaction.
    await dailyLog.start(p.id, pmc(p.id));
    await dailyLog.addMaterial(p.id, { name: 'Marble', qty: '20 boxes', zone: 'GF', swatch: 'marble', decisionId }, pmc(p.id));
    await dailyLog.flagMismatch(p.id, { decisionId }, pmc(p.id));
    await applyProjection(p.id);

    const proj = await query.projectionSlice(p.id);
    const act = proj.slices.activities.find((a) => a.id === actId);
    expect(act?.status, 'the caught-up projection shows the material block').toBe('blocked');
    expect(act?.gm).toBe('fail');
    expect(act?.block).toBe('Material ≠ approved');
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  it('node deletion unfiles the activity (projected nodeId null); projection == live', async () => {
    const p = await freshProject();
    await nodes.create(p.id, { name: 'Zone A', kind: 'zone', parentId: null, publish: true }, pmc(p.id));
    const zone = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p.id, name: 'Zone A' } });
    const actId = await createActivity(p.id, 'Filed act', { nodeId: zone.id });
    await applyProjection(p.id);
    expect((await query.projectionSlice(p.id)).slices.activities.find((a) => a.id === actId)?.nodeId).toBe(zone.id);

    // delete the node → the participant unfiles the activity AND appends `activity.unfiled` in-tx
    // (the ON DELETE SET NULL FK stays as the database backstop).
    await nodes.remove(p.id, zone.id, pmc(p.id));
    await applyProjection(p.id);

    const proj = await query.projectionSlice(p.id);
    expect(proj.slices.activities.find((a) => a.id === actId)?.nodeId, 'the deleted-node filing is nulled in the projection').toBeUndefined();
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  it('the closing-inspection approval signs the activity off; the caught-up projection shows done; projection == live', async () => {
    const p = await freshProject();
    const actId = await createActivity(p.id, 'Skirting');
    await svc.start(p.id, actId, eng(p.id, p.engId));
    await svc.complete(p.id, actId, eng(p.id, p.engId));
    await applyProjection(p.id);
    expect((await query.projectionSlice(p.id)).slices.activities.find((a) => a.id === actId)?.status).toBe('awaiting-signoff');
    await expectProjectionCurrentAndEqualsLive(p.id);

    // the PMC approves the closing inspection → inspections decide writes the sign-off THROUGH the
    // activities participant and emits `activity.signed_off` (same tx), which the projection consumes.
    const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p.id, activityId: actId, closing: true, decided: false } });
    await inspectionsSvc.decide(p.id, closing.id, { approve: true, rejectedItemIds: [] }, pmc(p.id));
    await applyProjection(p.id);

    const proj = await query.projectionSlice(p.id);
    expect(proj.slices.activities.find((a) => a.id === actId)?.status, 'the caught-up projection shows the sign-off').toBe('done');
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  // ── project-initialization materialization (edge 8) ──

  it('project initialization materializes an activities projection row (init emits activity.created/phase.created {init:true})', async () => {
    const module = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id, name: `acpj-init-mod-${projSeq++}`, category: 'zone', anchorKind: null,
        payload: {
          nodes: [],
          phases: [{ name: 'Init Phase', order: 0, plannedStart: 0, plannedEnd: 10 }],
          activities: [{ name: 'Init Activity', zone: 'GF', plannedStart: 0, plannedEnd: 5, phaseName: 'Init Phase', order: 0 }],
          inspections: [],
        },
      },
    });
    let created: { id: string } | undefined;
    try {
      created = await orgs.createProject(f.orgA.id, f.ownerUser.id, {
        name: `acpj-init-${projSeq}`, short: `acpj-init-${projSeq}`, descriptor: '', stage: 'Planning', siteCode: '',
        location: '', projStart: '', projEnd: '', scheduleStartDate: '2026-07-16', timeZone: 'Asia/Kolkata',
        modules: [{ moduleId: module.id, count: 1 }],
      } as never);

      // the init participants appended the {init:true} materialization events on the init transaction
      const initEvents = await t.prisma.domainEvent.findMany({ where: { projectId: created.id, eventType: { in: ['activity.created', 'phase.created'] } } });
      expect(initEvents.map((e) => e.eventType).sort()).toEqual(['activity.created', 'phase.created']);
      for (const e of initEvents) expect(e.payload).toMatchObject({ init: true });

      await applyProjection(created.id);
      const proj = await query.projectionSlice(created.id);
      expect(proj.generation, 'the projection materialized an active, caught-up generation at init').not.toBeNull();
      expect(proj.slices.phases.map((ph) => ph.name)).toEqual(['Init Phase']);
      expect(proj.slices.activities.map((a) => a.name)).toEqual(['Init Activity']);
      expect(proj.slices.activities[0]?.phaseId).toBe(proj.slices.phases[0]?.id);
      await expectProjectionCurrentAndEqualsLive(created.id);
    } finally {
      if (created) {
        const cid = created.id;
        await t.prisma.$executeRawUnsafe(TRUNCATE);
        await t.prisma.activity.deleteMany({ where: { projectId: cid } });
        await t.prisma.phase.deleteMany({ where: { projectId: cid } });
        await t.prisma.projectNode.deleteMany({ where: { projectId: cid } });
        await t.prisma.notification.deleteMany({ where: { projectId: cid } });
        await t.prisma.auditLog.deleteMany({ where: { projectId: cid } });
        await t.prisma.membership.deleteMany({ where: { projectId: cid } });
        await t.prisma.project.deleteMany({ where: { id: cid } });
      }
      await t.prisma.templateModule.deleteMany({ where: { id: module.id } });
    }
  });

  // ── two-project isolation ──

  it('two projects are isolated: a mutation in project A never changes project B projection row/slices', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    const a1 = await createActivity(p1.id, 'P1 act');
    await createActivity(p2.id, 'P2 act');
    await applyProjection(p1.id);
    await applyProjection(p2.id);
    const rowB = await t.prisma.activitiesProjection.findFirstOrThrow({ where: { projectId: p2.id } });

    // mutate ONLY project A
    await svc.update(p1.id, a1, { name: 'P1 act renamed' }, pmc(p1.id));
    await applyProjection(p1.id);
    await applyProjection(p2.id);

    const rowBAfter = await t.prisma.activitiesProjection.findFirstOrThrow({ where: { projectId: p2.id } });
    expect(rowBAfter.id).toBe(rowB.id); // same generation row —
    expect(rowBAfter.updatedAt.getTime()).toBe(rowB.updatedAt.getTime()); // — never rewritten by A's mutation
    expect(rowBAfter.dto).toEqual(rowB.dto);
    const s1 = await query.projectionSlice(p1.id);
    const s2 = await query.projectionSlice(p2.id);
    expect(s1.generation).toBe(1);
    expect(s2.generation).toBe(1);
    expect(s1.slices.activities.map((a) => a.name)).toEqual(['P1 act renamed']);
    expect(s2.slices.activities.map((a) => a.name)).toEqual(['P2 act']);
    await expectProjectionCurrentAndEqualsLive(p1.id);
    await expectProjectionCurrentAndEqualsLive(p2.id);
  });

  it('GET …/activities serves the module read (live fallback while the projection has no generation)', async () => {
    const pid = f.projectA.id;
    const token = t.issueProjectToken(f.memberUser.id, pid, 'pmc');
    await svc.create(pid, { name: 'HTTP act', zone: 'GF', plannedStart: 0, plannedEnd: 5, gateMaterial: 'na', gateTeam: 'na' } as CreateActivityInput, { sub: f.memberUser.id, role: 'pmc', projectId: pid } as AuthUser);
    try {
      const res = await request(t.app.getHttpServer()).get(`/projects/${pid}/activities`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body.source).toBe('live'); // no activities.schedule generation for projectA yet → live fallback
      expect(res.body.generation).toBeNull();
      expect(res.body.activities.map((a: { name: string }) => a.name)).toEqual(['HTTP act']);
    } finally {
      await t.prisma.activity.deleteMany({ where: { projectId: pid } });
      await t.prisma.notification.deleteMany({ where: { projectId: pid } });
      await t.prisma.auditLog.deleteMany({ where: { projectId: pid } });
    }
  });
});
