import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import type { Role } from '../../src/common/auth';

/**
 * Phase 2 Task 1 — CHARACTERIZATION (live PostgreSQL) of the snapshot's top-level
 * shape, per-role gating, AUTHOR-PRIVATE draft delivery, and nested DTO shapes,
 * built by the real SnapshotService against real data.
 *
 * Phase 2 Task 9 replaces the full snapshot with a project-shell summary +
 * per-module queries + projections; it must reproduce ALL of:
 *   1. the exact 16 top-level keys, identical for every role;
 *   2. the role gates — pending decisions hidden from non-pmc/client;
 *      reviews/review/reinspectionCreated pmc-only; placedInspections pmc/engineer-only;
 *   3. author-private drafts — an unpublished decision/drawing/node reaches ONLY its author;
 *   4. the nested per-key shapes (a decision's options, an activity's five-gate readiness,
 *      a drawing's governing revision, a photo, a placed inspection).
 */

const SNAPSHOT_KEYS = [
  'project', 'decisions', 'activities', 'placedInspections', 'reviews', 'review',
  'reinspectionCreated', 'checklist', 'drawings', 'phases', 'dailyLog',
  'notifications', 'companies', 'nodes', 'photos', 'materials',
].sort();

const ALL_ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];

/** every expected key is present on `obj`; use for DTO shape pinning */
const hasKeys = (obj: Record<string, unknown>, keys: string[]) => keys.every((k) => k in obj);

describe('Phase 2 Task 1 — snapshot shape, gating, drafts & nested DTOs (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshots: SnapshotService;
  let s: (label: string) => string;
  let PENDING_ID: string, APPROVED_ID: string, NODE_ID: string, INSP_ID: string, ACT_ID: string, DWG_ID: string;
  let DRAFT_DEC: string, DRAFT_DWG: string, DRAFT_NODE: string;
  const STRANGER = 'p2-stranger-not-author';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshots = t.app.get(SnapshotService);
    const pid = f.projectA.id;
    const uid = f.memberUser.id;
    s = (label: string) => `${label}-${pid.slice(-8)}`;
    PENDING_ID = s('p2-dl-pending'); APPROVED_ID = s('p2-dl-approved'); NODE_ID = s('p2-zone');
    INSP_ID = s('p2-insp'); ACT_ID = s('p2-act'); DWG_ID = s('p2-dwg');
    DRAFT_DEC = s('p2-draft-dec'); DRAFT_DWG = s('p2-draft-dwg'); DRAFT_NODE = s('p2-draft-node');

    // published pending (hidden from non-pmc/client) + published approved (visible to all)
    await t.prisma.decision.create({ data: { id: PENDING_ID, projectId: pid, title: 'Flooring', room: 'Living', photoSwatch: 'marble', status: 'pending', publishedAt: new Date(), authorId: uid } });
    await t.prisma.decision.create({ data: { id: APPROVED_ID, projectId: pid, title: 'Veneer', room: 'Study', photoSwatch: 'teak', status: 'approved', publishedAt: new Date(), authorId: uid } });
    await t.prisma.decisionOption.create({ data: { decisionId: APPROVED_ID, label: 'Teak', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'teak', order: 0 } });

    await t.prisma.projectNode.create({ data: { id: NODE_ID, projectId: pid, name: 'Ground Floor', kind: 'zone', order: 0, publishedAt: new Date() } });
    // a placed, submitted-but-undecided inspection → a pmc review + a pmc/engineer placed inspection
    await t.prisma.inspection.create({ data: { id: INSP_ID, projectId: pid, kind: 'review', title: 'Slab check', zone: 'Ground Floor', date: '', submitted: true, decided: false, closing: false, nodeId: NODE_ID } });
    await t.prisma.inspectionItem.create({ data: { inspectionId: INSP_ID, name: 'Level', state: 'pass', order: 0 } });
    // an activity (linked decision + node) → exercises the five-gate readiness DTO
    await t.prisma.activity.create({ data: { id: ACT_ID, projectId: pid, name: 'Slab', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 5, decisionId: APPROVED_ID, nodeId: NODE_ID } });
    // a published drawing with a governing for_construction revision
    await t.prisma.drawing.create({ data: { id: DWG_ID, projectId: pid, number: 'A-100', title: 'GA', discipline: 'architectural', nodeId: NODE_ID, publishedAt: new Date(), authorId: uid } });
    await t.prisma.drawingRevision.create({ data: { id: s('p2-rev'), projectId: pid, drawingId: DWG_ID, rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'PMC', issuedAt: '2026-06-01' } });
    // a placed progress photo → exercises the Photo DTO
    await t.prisma.media.create({ data: { id: s('p2-photo'), projectId: pid, kind: 'progress', mime: 'image/png', uploadedBy: uid, nodeId: NODE_ID, takenAt: '2026-06-02' } });

    // author-private DRAFTS (publishedAt null) — reach only their author (uid)
    await t.prisma.decision.create({ data: { id: DRAFT_DEC, projectId: pid, title: 'Draft dec', room: 'X', photoSwatch: 'marble', status: 'pending', publishedAt: null, authorId: uid } });
    await t.prisma.drawing.create({ data: { id: DRAFT_DWG, projectId: pid, number: 'A-900', title: 'Draft dwg', discipline: 'architectural', publishedAt: null, authorId: uid } });
    await t.prisma.projectNode.create({ data: { id: DRAFT_NODE, projectId: pid, name: 'Draft zone', kind: 'zone', order: 9, publishedAt: null, authorId: uid } });
  });

  afterAll(async () => {
    const pid = f.projectA.id;
    await t.prisma.media.deleteMany({ where: { projectId: pid } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspectionId: INSP_ID } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawingRevision.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawing.deleteMany({ where: { projectId: pid } });
    await t.prisma.activity.deleteMany({ where: { projectId: pid } });
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.decision.deleteMany({ where: { projectId: pid } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: pid } });
    await f.cleanup();
    await t.close();
  });

  it('returns exactly the 16 top-level keys for every role', async () => {
    for (const role of ALL_ROLES) {
      const snap = await snapshots.build(f.projectA.id, role, f.memberUser.id);
      expect(Object.keys(snap).sort(), `role ${role} key set drifted`).toEqual(SNAPSHOT_KEYS);
    }
  });

  it('hides published pending decisions from non-pmc/client roles', async () => {
    const idsFor = async (role: Role) =>
      (await snapshots.build(f.projectA.id, role, f.memberUser.id)).decisions.map((d) => d.id);
    for (const role of ['pmc', 'client'] as Role[]) {
      const ids = await idsFor(role);
      expect(ids, `${role} should see the pending decision`).toContain(PENDING_ID);
      expect(ids).toContain(APPROVED_ID);
    }
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const ids = await idsFor(role);
      expect(ids, `${role} must NOT see the pending decision`).not.toContain(PENDING_ID);
      expect(ids, `${role} should still see the approved decision`).toContain(APPROVED_ID);
    }
  });

  it('serializes the review queue only for pmc', async () => {
    for (const role of ALL_ROLES) {
      const snap = await snapshots.build(f.projectA.id, role, f.memberUser.id);
      if (role === 'pmc') {
        expect(snap.reviews.map((r) => r.id)).toContain(INSP_ID);
        expect(snap.review).not.toBeNull();
      } else {
        expect(snap.reviews, `${role} must get an empty review queue`).toEqual([]);
        expect(snap.review, `${role} must get a null singular review`).toBeNull();
        expect(snap.reinspectionCreated).toBe(false);
      }
    }
  });

  it('serializes placed inspections only for pmc and engineer', async () => {
    for (const role of ALL_ROLES) {
      const snap = await snapshots.build(f.projectA.id, role, f.memberUser.id);
      const ids = snap.placedInspections.map((p) => p.id);
      if (role === 'pmc' || role === 'engineer') {
        expect(ids, `${role} should see placed inspections`).toContain(INSP_ID);
      } else {
        expect(snap.placedInspections, `${role} must get no placed inspections`).toEqual([]);
      }
    }
  });

  it('delivers author-private drafts ONLY to their author (decision, drawing, node)', async () => {
    const mine = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id);
    expect(mine.decisions.find((d) => d.id === DRAFT_DEC)?.draft, 'author sees own draft decision, flagged').toBe(true);
    expect(mine.drawings.find((d) => d.id === DRAFT_DWG)?.draft, 'author sees own draft drawing, flagged').toBe(true);
    expect(mine.nodes.find((n) => n.id === DRAFT_NODE)?.draft, 'author sees own draft node, flagged').toBe(true);

    // a different user (also pmc-role, so the pending-gate is not what hides it) sees none of them
    const theirs = await snapshots.build(f.projectA.id, 'pmc', STRANGER);
    expect(theirs.decisions.map((d) => d.id), 'a non-author must not receive the draft decision').not.toContain(DRAFT_DEC);
    expect(theirs.drawings.map((d) => d.id), 'a non-author must not receive the draft drawing').not.toContain(DRAFT_DWG);
    expect(theirs.nodes.map((n) => n.id), 'a non-author must not receive the draft node').not.toContain(DRAFT_NODE);
  });

  it('pins the ProjectMeta shape (the shell identity Task 9 must reproduce)', async () => {
    const snap = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id);
    expect(hasKeys(snap.project as unknown as Record<string, unknown>, [
      'id', 'name', 'short', 'descriptor', 'stage', 'siteCode', 'location', 'projStart', 'projEnd',
      'scheduleStartDate', 'scheduleEndDate', 'timeZone', 'elapsedPct', 'todayDay', 'milestonePct',
    ])).toBe(true);
  });

  it('pins the nested DecisionDto + OptionDto shape', async () => {
    const snap = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id);
    const dec = snap.decisions.find((d) => d.id === APPROVED_ID)!;
    expect(hasKeys(dec as unknown as Record<string, unknown>, ['id', 'title', 'room', 'status', 'photoSwatch', 'options'])).toBe(true);
    expect(['pending', 'approved', 'change']).toContain(dec.status);
    expect(Array.isArray(dec.options)).toBe(true);
    expect(hasKeys(dec.options[0] as unknown as Record<string, unknown>, ['key', 'material', 'delta', 'swatch', 'recommended'])).toBe(true);
  });

  it('pins the ActivityDto five-gate readiness shape {v, source, reason}', async () => {
    const snap = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id);
    const act = snap.activities.find((a) => a.id === ACT_ID)!;
    expect(hasKeys(act as unknown as Record<string, unknown>, ['id', 'name', 'zone', 'decisionId', 'phaseId', 'status', 'gm', 'gt', 'gi', 'readiness', 'overrides'])).toBe(true);
    for (const gate of ['decision', 'material', 'team', 'inspection', 'drawing'] as const) {
      const reading = (act.readiness as Record<string, { v: string; source: string; reason: string }>)[gate];
      expect(reading, `readiness.${gate} present`).toBeTruthy();
      expect(['ok', 'wait', 'fail', 'na']).toContain(reading.v);
      expect(['derived', 'stored', 'override']).toContain(reading.source);
      expect(typeof reading.reason).toBe('string');
    }
  });

  it('pins the DrawingDto governing-revision + Photo + PlacedInspection shapes', async () => {
    const snap = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id);
    const dwg = snap.drawings.find((d) => d.id === DWG_ID)!;
    expect(hasKeys(dwg as unknown as Record<string, unknown>, ['id', 'number', 'title', 'discipline', 'current', 'ackedByMe', 'revisions'])).toBe(true);
    expect(hasKeys(dwg.current as unknown as Record<string, unknown>, ['id', 'rev', 'status', 'mime', 'url'])).toBe(true);
    expect(dwg.current!.status).toBe('for_construction');

    const photo = snap.photos[0]!;
    expect(hasKeys(photo as unknown as Record<string, unknown>, ['id', 'url', 'kind'])).toBe(true);

    const placed = snap.placedInspections.find((p) => p.id === INSP_ID)!;
    expect(hasKeys(placed as unknown as Record<string, unknown>, ['id', 'title', 'zone', 'kind', 'submitted', 'decided', 'failedItems'])).toBe(true);
  });
});
