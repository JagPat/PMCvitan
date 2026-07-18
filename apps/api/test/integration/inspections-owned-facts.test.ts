import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import { OrgsService } from '../../src/orgs/orgs.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 10 (Module 3) CORRECTION — the `inspections.inbox` projection is a TRUTHFUL, module-owned
 * projection: whenever it reports itself CURRENT, it equals the canonical live Inspections read for every
 * mutation that affects an inspection-owned serialized field — INCLUDING mutations a FOREIGN module drives.
 *
 * ROOT CAUSE these probes pin (red at PR #178 base): `computeInspectionsBase` read foreign-owned data
 * (Media evidence rows, `Activity.name`, and `Inspection.nodeId` which a node deletion changed), but the
 * projection consumer only refreshes on `inspection.*` events. Events like `media.uploaded/removed`,
 * `activity.completion_requested`, `activity.updated`, and `node.removed` were no-ops that advanced the
 * ordered cursor WITHOUT recomputing the base — so `readServableGeneration` reported "current" while the
 * projection served a STALE slice (`generation` non-null, but `slices ≠ live`).
 *
 * The correction routes every such foreign mutation through the inspections participant, which appends an
 * inspection-owned signal event (`inspection.closing_created` / `evidence_added` / `evidence_removed` /
 * `relabeled` / `unfiled`) in the SAME transaction — so the ordered cursor refreshes the base from
 * inspection-owned facts. Each probe drives the mutation through the REAL command path, drains the
 * inspections.inbox deliveries, and asserts the projection is BOTH current (generation non-null) AND equal
 * to live. At base the generation is still current but `slices ≠ live` — that is the exact failure the
 * assertions catch.
 */

/** Normalize the per-read signed evidence token (`?t=<exp>.<hmac>`, second-granularity) to a constant so
 *  two reads a microsecond apart compare byte-for-byte on everything BUT the time-based token. */
const stripTokens = <T>(slices: T): T => JSON.parse(JSON.stringify(slices).replace(/\?t=[^"&]+/g, '?t=X'));

describe('Phase 2 Task 10 (Module 3) correction — foreign mutations keep inspections.inbox == live (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let inspectionsSvc: InspectionsService;
  let query: InspectionsQueryService;
  let orgs: OrgsService;
  let seq = 0;

  const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "InspectionsProjection", "InspectionEvidence"';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    inspectionsSvc = t.app.get(InspectionsService);
    query = t.app.get(InspectionsQueryService);
    orgs = t.app.get(OrgsService);
  });

  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });

  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.commandExecution.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.media.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: { startsWith: 'it-iof-' } } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.activity.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.notification.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-iof-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-iof-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-iof-' } } });
  });

  const http = () => request(t.app.getHttpServer());
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'); // tiny fake png

  interface Proj { id: string; pmc: string; engId: string; engToken: string; pmcToken: string; }

  /** A fresh project with an active pmc + an active engineer, and tokens for both. */
  const freshProject = async (): Promise<Proj> => {
    const id = `it-iof-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const engId = `it-iof-u-eng-${seq}`;
    await t.prisma.user.create({ data: { id: engId, projectId: id, role: 'engineer', name: 'Eng One', email: `${engId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: id, userId: engId, role: 'engineer', status: 'active' } });
    return {
      id,
      pmc: f.memberUser.id,
      engId,
      engToken: t.issueProjectToken(engId, id, 'engineer'),
      pmcToken: t.issueProjectToken(f.memberUser.id, id, 'pmc'),
    };
  };

  const post = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (token: string) => (path: string, body: object = {}) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body);
  const del = (token: string) => (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`);
  const pmcUser = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  /** Create a checklist through the module command (so the inbox generation exists + is current). */
  const createChecklist = async (p: Proj, title: string, items: string[], nodeId?: string): Promise<{ id: string; itemIds: string[] }> => {
    await inspectionsSvc.create(p.id, { title, zone: 'GF', items, ...(nodeId ? { nodeId } : {}) }, pmcUser(p.id));
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p.id, title }, include: { items: { orderBy: { order: 'asc' } } } });
    return { id: insp.id, itemIds: insp.items.map((it) => it.id) };
  };

  /** Drain every pending inspections.inbox delivery for a project (real refresh or no-op). */
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 60; pass++) {
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

  /** The invariant the correction guarantees: a CURRENT projection equals the live read (token-normalized). */
  const expectProjectionCurrentAndEqualsLive = async (projectId: string, role = 'pmc'): Promise<void> => {
    const live = await query.snapshotSlice(projectId, role);
    const proj = await query.projectionSlice(projectId, role);
    expect(proj.generation, 'projection reports itself CURRENT (a caught-up generation with a row)').not.toBeNull();
    expect(stripTokens(proj.slices), 'a CURRENT projection MUST equal the live read').toEqual(stripTokens(live));
  };

  // ── (1) activity completion → the closing review is visible in the caught-up projection ──
  it('activity completion creates a closing review the caught-up projection shows; projection == live', async () => {
    const p = await freshProject();
    await createChecklist(p, 'Field checklist', ['A']); // establishes an active inbox generation
    await applyProjection(p.id);

    // the completion claim creates the linked closing inspection through the participant, which appends
    // `inspection.closing_created` in the same tx.
    expect((await post(p.pmcToken)(`/projects/${p.id}/activities`, { name: 'Slab pour', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const act = await t.prisma.activity.findFirstOrThrow({ where: { projectId: p.id, name: 'Slab pour' } });
    expect((await post(p.engToken)(`/projects/${p.id}/activities/${act.id}/start`)).status).toBe(201);
    expect((await post(p.engToken)(`/projects/${p.id}/activities/${act.id}/complete`)).status).toBe(201);

    await applyProjection(p.id);
    const proj = await query.projectionSlice(p.id, 'pmc');
    // the closing review is in the PMC review queue, labelled with the activity name (inspection-owned)
    const closing = proj.slices.reviews.find((r) => r.title === 'Closing inspection: Slab pour');
    expect(closing, 'the closing review is visible in the caught-up projection').toBeTruthy();
    expect(closing?.activityName).toBe('Slab pour');
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  // ── (2) item evidence upload is visible; removal makes it disappear ──
  it('evidence upload is visible in the projection and removal makes it disappear; projection == live throughout', async () => {
    const p = await freshProject();
    const c = await createChecklist(p, 'Rebar QA', ['Cover', 'Spacing']);
    await applyProjection(p.id);

    // upload item-level evidence → media.uploaded + inspection.evidence_added (participant, same tx)
    const up = await post(p.engToken)(`/projects/${p.id}/media`, { kind: 'inspection', mime: 'image/png', data: px, inspectionId: c.id, inspectionItemId: c.itemIds[0], clientKey: 'ev-1' });
    expect(up.status).toBe(201);
    await applyProjection(p.id);

    const withEvidence = await query.projectionSlice(p.id, 'pmc');
    const item = withEvidence.slices.checklist?.items.find((i) => i.id === c.itemIds[0]);
    expect(item?.evidence.length, 'the uploaded evidence is visible in the caught-up projection').toBe(1);
    await expectProjectionCurrentAndEqualsLive(p.id);

    // remove the media → media.removed + inspection.evidence_removed (participant, before the delete)
    expect((await del(p.pmcToken)(`/media/${up.body.id}`)).status).toBe(200);
    await applyProjection(p.id);

    const afterRemoval = await query.projectionSlice(p.id, 'pmc');
    const clearedItem = afterRemoval.slices.checklist?.items.find((i) => i.id === c.itemIds[0]);
    expect(clearedItem?.evidence.length, 'the removed evidence disappears from the projection').toBe(0);
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  // ── (3) node deletion nulls the projected placement ──
  it('node deletion makes the projected nodeId null; projection == live', async () => {
    const p = await freshProject();
    // a published zone the checklist is placed on
    const zoneRes = await post(p.pmcToken)(`/projects/${p.id}/nodes`, { name: 'Zone A', kind: 'zone', publish: true });
    expect(zoneRes.status).toBe(201);
    const zone = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p.id, name: 'Zone A' } });
    const c = await createChecklist(p, 'Placed QA', ['A'], zone.id);
    await applyProjection(p.id);
    expect((await query.projectionSlice(p.id, 'pmc')).slices.placedInspections.find((i) => i.id === c.id)?.nodeId).toBe(zone.id);

    // delete the node → the FK nulls Inspection.nodeId AND the participant appends `inspection.unfiled`
    expect((await del(p.pmcToken)(`/projects/${p.id}/nodes/${zone.id}`)).status).toBe(200);
    await applyProjection(p.id);

    const proj = await query.projectionSlice(p.id, 'pmc');
    const placed = proj.slices.placedInspections.find((i) => i.id === c.id);
    expect(placed?.nodeId, 'the deleted-node placement is nulled in the projection').toBeUndefined();
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  // ── (4) activity rename re-labels the linked closing inspection ──
  it('activity rename updates the projected activityName; projection == live', async () => {
    const p = await freshProject();
    await createChecklist(p, 'Field checklist', ['A']);
    await applyProjection(p.id);
    expect((await post(p.pmcToken)(`/projects/${p.id}/activities`, { name: 'Old name', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const act = await t.prisma.activity.findFirstOrThrow({ where: { projectId: p.id, name: 'Old name' } });
    expect((await post(p.engToken)(`/projects/${p.id}/activities/${act.id}/start`)).status).toBe(201);
    expect((await post(p.engToken)(`/projects/${p.id}/activities/${act.id}/complete`)).status).toBe(201);
    await applyProjection(p.id);
    expect((await query.projectionSlice(p.id, 'pmc')).slices.reviews.find((r) => r.activityId === act.id)?.activityName).toBe('Old name');

    // rename the activity → the participant re-stamps the inspection-owned activityName + `inspection.relabeled`
    expect((await patch(p.pmcToken)(`/projects/${p.id}/activities/${act.id}`, { name: 'New name' })).status).toBe(200);
    await applyProjection(p.id);

    const proj = await query.projectionSlice(p.id, 'pmc');
    const review = proj.slices.reviews.find((r) => r.activityId === act.id);
    expect(review?.title, 'the closing review keeps its stored title').toBe('Closing inspection: Old name');
    expect(review?.activityName, 'the projected activityName tracks the rename').toBe('New name');
    await expectProjectionCurrentAndEqualsLive(p.id);
  });

  // ── (5) project initialization materializes a projection row from init events ──
  it('project initialization materializes an inspections projection row (init emits inspection.created)', async () => {
    const module = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id, name: `iof-init-mod-${seq++}`, category: 'zone', anchorKind: null,
        payload: {
          nodes: [{ key: 'z', parentKey: null, name: 'Init Zone', kind: 'zone', order: 0 }],
          phases: [], activities: [],
          inspections: [{ title: 'Init Checklist', zone: 'Init Zone', nodeKey: 'z', items: ['Init item'] }],
        },
      },
    });
    let created: { id: string } | undefined;
    try {
      created = await orgs.createProject(f.orgA.id, f.ownerUser.id, {
        name: `iof-init-${seq}`, short: `iof-init-${seq}`, descriptor: '', stage: 'Planning', siteCode: '',
        location: '', projStart: '', projEnd: '', scheduleStartDate: '2026-07-16', timeZone: 'Asia/Kolkata',
        modules: [{ moduleId: module.id, count: 1 }],
      } as never);
      await applyProjection(created.id);

      const proj = await query.projectionSlice(created.id, 'pmc');
      expect(proj.generation, 'the projection materialized an active, caught-up generation at init').not.toBeNull();
      expect(proj.slices.checklist?.title).toBe('Init Checklist');
      await expectProjectionCurrentAndEqualsLive(created.id);
    } finally {
      if (created) {
        const cid = created.id;
        await t.prisma.$executeRawUnsafe(TRUNCATE);
        await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: cid } } });
        await t.prisma.inspection.deleteMany({ where: { projectId: cid } });
        await t.prisma.projectNode.deleteMany({ where: { projectId: cid } });
        await t.prisma.membership.deleteMany({ where: { projectId: cid } });
        await t.prisma.project.deleteMany({ where: { id: cid } });
      }
      await t.prisma.templateModule.deleteMany({ where: { id: module.id } });
    }
  });

  // ── (6) two projects stay isolated across foreign-driven refreshes ──
  it('two projects are isolated: a foreign mutation in one never changes the other projection', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    const c1 = await createChecklist(p1, 'P1 QA', ['A']);
    await createChecklist(p2, 'P2 QA', ['B']);
    await applyProjection(p1.id);
    await applyProjection(p2.id);

    // evidence uploaded only into p1
    const up = await post(p1.engToken)(`/projects/${p1.id}/media`, { kind: 'inspection', mime: 'image/png', data: px, inspectionId: c1.id, inspectionItemId: c1.itemIds[0], clientKey: 'iso-1' });
    expect(up.status).toBe(201);
    await applyProjection(p1.id);
    await applyProjection(p2.id);

    await expectProjectionCurrentAndEqualsLive(p1.id);
    await expectProjectionCurrentAndEqualsLive(p2.id);
    expect((await query.projectionSlice(p1.id, 'pmc')).slices.checklist?.items[0].evidence.length).toBe(1);
    expect((await query.projectionSlice(p2.id, 'pmc')).slices.checklist?.items[0].evidence.length).toBe(0);
  });

  // ── (7) a full rebuild reproduces the live read after foreign-driven mutations ──
  it('rebuild == live after foreign mutations (closing review + evidence + unfile + relabel)', async () => {
    const p = await freshProject();
    const c = await createChecklist(p, 'Rebuild QA', ['A']);
    // place it, then evidence it, then rename an activity's closing — a mix of every foreign edge
    const zoneRes = await post(p.pmcToken)(`/projects/${p.id}/nodes`, { name: 'RB Zone', kind: 'zone', publish: true });
    const zone = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p.id, name: 'RB Zone' } });
    await inspectionsSvc.create(p.id, { title: 'RB placed', zone: 'GF', items: ['x'], nodeId: zone.id }, pmcUser(p.id));
    void zoneRes;
    const up = await post(p.engToken)(`/projects/${p.id}/media`, { kind: 'inspection', mime: 'image/png', data: px, inspectionId: c.id, inspectionItemId: c.itemIds[0], clientKey: 'rb-1' });
    expect(up.status).toBe(201);
    expect((await post(p.pmcToken)(`/projects/${p.id}/activities`, { name: 'RB act', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const act = await t.prisma.activity.findFirstOrThrow({ where: { projectId: p.id, name: 'RB act' } });
    expect((await post(p.engToken)(`/projects/${p.id}/activities/${act.id}/start`)).status).toBe(201);
    expect((await post(p.engToken)(`/projects/${p.id}/activities/${act.id}/complete`)).status).toBe(201);
    expect((await patch(p.pmcToken)(`/projects/${p.id}/activities/${act.id}`, { name: 'RB renamed' })).status).toBe(200);
    await applyProjection(p.id);

    const before = await query.projectionSlice(p.id, 'pmc');
    expect(before.generation).not.toBeNull();

    const res = await rebuilder.rebuild(INSPECTIONS_PROJECTION, p.id);
    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p.id } });
    expect(res.checkpoint).toBe(stream.nextPosition - 1n);

    const after = await query.projectionSlice(p.id, 'pmc');
    const live = await query.snapshotSlice(p.id, 'pmc');
    expect(stripTokens(after.slices)).toEqual(stripTokens(before.slices));
    expect(stripTokens(after.slices)).toEqual(stripTokens(live));
  });
});
