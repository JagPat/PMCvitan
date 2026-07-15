import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import type { Role } from '../../src/common/auth';

/**
 * Phase 2 Task 1 — CHARACTERIZATION (live PostgreSQL) of the snapshot's top-level
 * shape and per-role gating, built by the real SnapshotService against real data.
 *
 * It pins two things Phase 2 Task 9 must reproduce when it replaces the full
 * snapshot with a project-shell summary + per-module queries + projections:
 *   1. the exact 16 top-level keys, identical for every role (gating empties
 *      arrays, it never adds or removes keys);
 *   2. the four role gates — pending decisions hidden from non-pmc/client;
 *      `reviews`/`review`/`reinspectionCreated` pmc-only; `placedInspections`
 *      pmc/engineer-only.
 */

const SNAPSHOT_KEYS = [
  'project', 'decisions', 'activities', 'placedInspections', 'reviews', 'review',
  'reinspectionCreated', 'checklist', 'drawings', 'phases', 'dailyLog',
  'notifications', 'companies', 'nodes', 'photos', 'materials',
].sort();

const ALL_ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];

describe('Phase 2 Task 1 — snapshot shape + per-role gating (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshots: SnapshotService;
  const PENDING_ID = 'it-p2-dl-pending';
  const APPROVED_ID = 'it-p2-dl-approved';
  const NODE_ID = 'it-p2-zone';
  const INSP_ID = 'it-p2-insp';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshots = t.app.get(SnapshotService);
    const pid = f.projectA.id;

    // A published PENDING decision (hidden from non-pmc/client) + a published
    // APPROVED one (visible to all). Both published, so the gate under test is the
    // pending-status rule, not draft author-privacy.
    await t.prisma.decision.create({
      data: { id: PENDING_ID, projectId: pid, title: 'Flooring', room: 'Living', photoSwatch: 'marble', status: 'pending', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    await t.prisma.decision.create({
      data: { id: APPROVED_ID, projectId: pid, title: 'Veneer', room: 'Study', photoSwatch: 'teak', status: 'approved', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    // A placed, submitted-but-undecided inspection → a pmc review + a pmc/engineer
    // placed inspection.
    await t.prisma.projectNode.create({ data: { id: NODE_ID, projectId: pid, name: 'Ground Floor', kind: 'zone', order: 0, publishedAt: new Date() } });
    await t.prisma.inspection.create({
      data: { id: INSP_ID, projectId: pid, kind: 'review', title: 'Slab check', zone: 'Ground Floor', date: '', submitted: true, decided: false, closing: false, nodeId: NODE_ID },
    });
    await t.prisma.inspectionItem.create({ data: { inspectionId: INSP_ID, name: 'Level', state: 'pass', order: 0 } });
  });

  afterAll(async () => {
    // FK-safe teardown of the rows this suite seeded, BEFORE the fixture removes the
    // node/project it hangs off.
    await t.prisma.inspectionItem.deleteMany({ where: { inspectionId: INSP_ID } });
    await t.prisma.inspection.deleteMany({ where: { id: INSP_ID } });
    await t.prisma.decision.deleteMany({ where: { id: { in: [PENDING_ID, APPROVED_ID] } } });
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
});
