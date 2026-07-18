import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import type { AuthUser } from '../../src/common/auth';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 Task 10 (Module 3) — the INSPECTIONS read path moves onto its rebuildable projection, proven
 * EQUIVALENT to the live snapshot slices and proven live == rebuild.
 *
 * The `inspections.inbox` projection consumer (registered at boot) maintains ONE per-project
 * InspectionsProjection base row from canonical state on every `inspection.*` event. Like daily-log /
 * drawings (a per-PROJECT composite, not one row per entity), the module's `projectionSlice` bakes the
 * whole set of slices from that base — byte-identical to `snapshotSlice`, before and after a full rebuild.
 * The finding-1 servability gate (never serve a lagging/blocked/no-row generation) is proven exactly as
 * for daily-log/drawings. Inspections are created WITHOUT fail-item evidence so no per-read signed path
 * appears — the slices compare byte-for-byte with no token stripping.
 */

const human: Actor = { actorId: '', actorName: 'System', actorRole: 'system', actorKind: 'system' };

describe('Phase 2 Task 10 (Module 3) — inspections projection == live slices, live == rebuild (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let svc: InspectionsService;
  let query: InspectionsQueryService;
  let projSeq = 0;

  const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "InspectionsProjection"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    svc = t.app.get(InspectionsService);
    query = t.app.get(InspectionsQueryService);
    human.actorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.commandExecution.deleteMany({ where: { projectId: { startsWith: 'it-inpj-' } } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: { startsWith: 'it-inpj-' } } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: { startsWith: 'it-inpj-' } } });
    await t.prisma.notification.deleteMany({ where: { projectId: { startsWith: 'it-inpj-' } } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { startsWith: 'it-inpj-' } } });
    await t.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-inpj-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-inpj-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-inpj-' } } });
  });

  /** A fresh project with an active pmc issuer + one active engineer. Returns the project id. */
  const freshProject = async (): Promise<string> => {
    const id = `it-inpj-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const eng = `it-inpj-u-eng-${projSeq}`;
    await t.prisma.user.create({ data: { id: eng, projectId: id, role: 'engineer', name: 'Eng One', email: `${eng}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: id, userId: eng, role: 'engineer', status: 'active' } });
    return id;
  };

  /** Create a checklist and return its id + its item ids (canonical order). */
  const createChecklist = async (projectId: string, title: string, items: string[], key?: string): Promise<{ id: string; itemIds: string[] }> => {
    await svc.create(projectId, { title, zone: 'GF', items }, pmc(projectId), key);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId, title }, include: { items: { orderBy: { order: 'asc' } } } });
    return { id: insp.id, itemIds: insp.items.map((it) => it.id) };
  };

  /** Submit a checklist as all-PASS (no fail items → no evidence required). */
  const submitAllPass = (projectId: string, id: string, itemIds: string[], key?: string) =>
    svc.submit(projectId, id, { items: itemIds.map((iid) => ({ id: iid, state: 'pass', photos: 0, note: '' })) }, pmc(projectId), key);

  /** Seed a CANONICAL inspection WITHOUT emitting any inspection event — the legacy/pre-projection shape
   *  the finding-1 probe needs (real data, no inspection delivery to apply). */
  const seedLegacyInspection = async (projectId: string, title: string): Promise<void> => {
    await t.prisma.inspection.create({
      data: { id: `INSP-legacy-${projSeq++}`, projectId, kind: 'checklist', title, zone: 'GF', date: '01 Jun 2026', submitted: false, decided: false, items: { create: [{ name: 'Legacy check', order: 0, photos: 0, note: '' }] } },
    });
  };

  /** Drain every pending inspections.inbox (and noop) delivery for a project. */
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: INSPECTIONS_PROJECTION, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  it('the projection slices are BYTE-IDENTICAL to the live snapshot slices', async () => {
    const p = await freshProject();
    const a = await createChecklist(p, 'Slab QA', ['Rebar', 'Cover']);
    await submitAllPass(p, a.id, a.itemIds); // submitted, undecided → in the PMC review queue
    await createChecklist(p, 'Plaster QA', ['Line', 'Level']); // unsubmitted → the current field checklist
    await applyProjection(p);

    const live = await query.snapshotSlice(p, 'pmc');
    const proj = await query.projectionSlice(p, 'pmc');
    expect(proj.generation).toBe(1); // served from an ACTIVE generation
    expect(proj.slices).toEqual(live);
    // structure sanity: the submitted-but-undecided inspection is the review queue; the unsubmitted one is
    // the field checklist (open checklists preferred).
    expect(proj.slices.reviews.map((r) => r.title)).toEqual(['Slab QA']);
    expect(proj.slices.checklist?.title).toBe('Plaster QA');
  });

  it('finding 1: legacy canonical data + only a no-op serves LIVE, never authoritative-empty projection', async () => {
    const p = await freshProject();
    await seedLegacyInspection(p, 'Legacy QA'); // canonical inspection, NO inspection event ever emitted
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p);
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: INSPECTIONS_PROJECTION, projectId: p, status: 'active' } });
    expect(gen).not.toBeNull(); // an active, caught-up generation exists — but has no row for this project
    const mod = await query.moduleInspections(p, 'pmc');
    expect(mod.source).toBe('live'); // MUST fall back to canonical live, not serve the empty projection
    expect(mod.checklist?.title).toBe('Legacy QA');
    expect((await query.projectionSlice(p, 'pmc')).generation).toBeNull();
  });

  it('finding 1: a LAGGING checkpoint (a committed inspection not yet applied) serves live', async () => {
    const p = await freshProject();
    await createChecklist(p, 'Applied QA', ['A']);
    await applyProjection(p);
    expect((await query.projectionSlice(p, 'pmc')).generation).toBe(1); // fully applied → servable
    await createChecklist(p, 'Lagging QA', ['B']); // committed but NOT applied → checkpoint lags head
    const proj = await query.projectionSlice(p, 'pmc');
    expect(proj.generation).toBeNull(); // appliedPosition < stream head → not current → fallback
    const mod = await query.moduleInspections(p, 'pmc');
    expect(mod.source).toBe('live');
    expect(mod.placedInspections.map((i) => i.title).sort()).toEqual(['Applied QA', 'Lagging QA']); // live reflects newest canonical
  });

  it('finding 1: a BLOCKED generation serves live', async () => {
    const p = await freshProject();
    await createChecklist(p, 'Blocked QA', ['A']);
    await applyProjection(p);
    expect((await query.projectionSlice(p, 'pmc')).generation).toBe(1);
    await t.prisma.projectionGeneration.updateMany({ where: { consumer: INSPECTIONS_PROJECTION, projectId: p, status: 'active' }, data: { cursorStatus: 'blocked' } });
    expect((await query.projectionSlice(p, 'pmc')).generation).toBeNull();
    expect((await query.moduleInspections(p, 'pmc')).source).toBe('live');
  });

  it('live == rebuild: a rebuild activates a new generation (checkpoint == H) whose slices match the live ones', async () => {
    const p = await freshProject();
    const a = await createChecklist(p, 'Rebuild QA', ['A']);
    await submitAllPass(p, a.id, a.itemIds);
    await applyProjection(p);
    const before = await query.projectionSlice(p, 'pmc');
    expect(before.generation).toBe(1);

    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p } });
    const H = stream.nextPosition - 1n;

    const res = await rebuilder.rebuild(INSPECTIONS_PROJECTION, p);
    expect(res.checkpoint).toBe(H);
    const after = await query.projectionSlice(p, 'pmc');
    expect(after.generation).toBe(2);
    const live = await query.snapshotSlice(p, 'pmc');
    expect(after.slices).toEqual(before.slices);
    expect(after.slices).toEqual(live);
  });

  it('two projects are isolated: each has its own active inspections generation + slices', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await createChecklist(p1, 'P1 QA', ['A']);
    await createChecklist(p2, 'P2 QA', ['B']);
    await applyProjection(p1);
    await applyProjection(p2);
    const s1 = await query.projectionSlice(p1, 'pmc');
    const s2 = await query.projectionSlice(p2, 'pmc');
    expect(s1.slices.checklist?.title).toBe('P1 QA');
    expect(s2.slices.checklist?.title).toBe('P2 QA');
    expect(s1.generation).toBe(1);
    expect(s2.generation).toBe(1);
  });

  it('GET …/inspections serves the module read (live fallback while the projection has no generation)', async () => {
    const pid = f.projectA.id;
    const token = t.issueProjectToken(f.memberUser.id, pid, 'pmc');
    await svc.create(pid, { title: 'HTTP QA', zone: 'GF', items: ['A'] }, { sub: f.memberUser.id, role: 'pmc', projectId: pid } as AuthUser);
    try {
      const res = await request(t.app.getHttpServer()).get(`/projects/${pid}/inspections`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body.source).toBe('live'); // no inspections.inbox generation for projectA yet → live fallback
      expect(res.body.checklist?.title).toBe('HTTP QA');
    } finally {
      await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pid } } });
      await t.prisma.inspection.deleteMany({ where: { projectId: pid } });
      await t.prisma.notification.deleteMany({ where: { projectId: pid } });
      await t.prisma.auditLog.deleteMany({ where: { projectId: pid } });
    }
  });
});
