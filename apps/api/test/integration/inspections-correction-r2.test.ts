import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 10 (Module 3) correction ROUND 2 — the two narrow findings of the PR #179 re-review,
 * against live PostgreSQL with the real services.
 *
 * F1 — the InspectionEvidence→Media reference is TENANT-CONTAINED. The original backstop was an id-only
 * FK, which accepted a link whose projectId was project A while its mediaId belonged to project B. The
 * round-2 migration (20261125000000) replaces it with the composite (projectId, mediaId) →
 * Media(projectId, id) FK. The adversarial probes here drive raw SQL at the database itself: a
 * cross-project link must be REJECTED by PostgreSQL, a same-project link must succeed, and no forged row
 * may persist. RED at PR #179 (the id-only FK accepted the forgery); GREEN with the composite FK.
 *
 * F2 — the completion claim uses TRANSACTION-CURRENT activity facts. `complete()` pre-reads the Activity
 * as fast validation, but a rename/re-zone/re-file can commit between that read and the completion
 * transaction. The fix re-reads the Activity THROUGH the transaction after the status CAS (row lock held)
 * and stamps the tx-current name/zone/nodeId onto the closing inspection, the notification, and the push.
 * The deterministic barrier tests prove BOTH orderings:
 *   A — complete's pre-read happens, the rename COMMITS in the window, the completion transaction then
 *       continues: the closing inspection must carry the NEW name/zone/nodeId (red at #179: stale values);
 *   B — the completion transaction locks + creates the closing FIRST (held open at its in-tx re-read),
 *       the rename dispatched meanwhile blocks behind the row lock and applies AFTER: the closing keeps
 *       its as-created title, the relabel re-stamps the inspection-owned activityName, and the final
 *       Activity + Inspection facts agree.
 * Both prove projection == live after the relay drain.
 */

const stripTokens = <T>(slices: T): T => JSON.parse(JSON.stringify(slices).replace(/\?t=[^"&]+/g, '?t=X'));

describe('Task 10 (Module 3) correction round 2 — tenant-contained evidence FK + tx-current completion facts (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let activities: ActivitiesService;
  let inspectionsSvc: InspectionsService;
  let query: InspectionsQueryService;
  let seq = 0;

  const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "InspectionsProjection", "InspectionEvidence"';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    activities = t.app.get(ActivitiesService);
    inspectionsSvc = t.app.get(InspectionsService);
    query = t.app.get(InspectionsQueryService);
  });

  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });

  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.commandExecution.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.media.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: { startsWith: 'it-r2-' } } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.activity.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.notification.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-r2-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-r2-' } } });
  });

  /** A fresh project with an active pmc membership for the fixture user. */
  const freshProject = async (): Promise<string> => {
    const id = `it-r2-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'R', descriptor: '', stage: 'x', siteCode: 'R', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  /** Drain every pending inspections.inbox delivery for a project. */
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

  const expectProjectionCurrentAndEqualsLive = async (projectId: string): Promise<void> => {
    const live = await query.snapshotSlice(projectId, 'pmc');
    const proj = await query.projectionSlice(projectId, 'pmc');
    expect(proj.generation, 'projection reports itself CURRENT').not.toBeNull();
    expect(stripTokens(proj.slices), 'a CURRENT projection MUST equal the live read').toEqual(stripTokens(live));
  };

  // ── F1 — the composite (projectId, mediaId) FK tenant-contains evidence links ────────────────────────

  describe('F1 — InspectionEvidence cannot reference another project\'s media (composite FK)', () => {
    it('a cross-project link is REJECTED by PostgreSQL; a same-project link succeeds; no forged row persists', async () => {
      const pA = await freshProject();
      const pB = await freshProject();
      // project A's inspection + item (the link's inspection side is containment-valid)
      const insp = await t.prisma.inspection.create({
        data: { id: `INSP-r2f1-${seq}`, projectId: pA, kind: 'checklist', title: 'A checklist', zone: 'GF', date: '01 Jul 2026', submitted: false, decided: false, items: { create: [{ name: 'A item', order: 0, photos: 0, note: '' }] } },
        include: { items: true },
      });
      const itemId = insp.items[0].id;
      // one media in EACH project
      const mediaA = await t.prisma.media.create({ data: { projectId: pA, kind: 'inspection', mime: 'image/png', uploadedBy: 'u' } });
      const mediaB = await t.prisma.media.create({ data: { projectId: pB, kind: 'inspection', mime: 'image/png', uploadedBy: 'u' } });

      // ADVERSARIAL: a project-A link naming project-B's media — raw SQL, straight at the database.
      // RED at PR #179: the id-only FK accepted this row. GREEN: the composite FK rejects it.
      await expect(t.prisma.$executeRawUnsafe(
        `INSERT INTO "InspectionEvidence" ("id","projectId","inspectionId","inspectionItemId","mediaId") VALUES ('r2-forge-${seq}', $1, $2, $3, $4)`,
        pA, insp.id, itemId, mediaB.id,
      )).rejects.toThrow(/violates foreign key constraint/);

      // the same-project link is accepted (the FK constrains tenancy, not legitimate use)
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "InspectionEvidence" ("id","projectId","inspectionId","inspectionItemId","mediaId") VALUES ('r2-ok-${seq}', $1, $2, $3, $4)`,
        pA, insp.id, itemId, mediaA.id,
      );

      // no forged row persists anywhere: every surviving link's projectId equals its media's projectId
      const crossed = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "InspectionEvidence" ie JOIN "Media" m ON m."id" = ie."mediaId" WHERE ie."projectId" <> m."projectId"`,
      );
      expect(Number(crossed[0].n)).toBe(0);
      expect(await t.prisma.inspectionEvidence.count({ where: { projectId: pA } })).toBe(1);
    });
  });

  // ── F2 — the completion claim stamps TRANSACTION-CURRENT activity facts ──────────────────────────────

  describe('F2 — complete() uses tx-current name/zone/nodeId (deterministic barriers, both orderings)', () => {
    /** Seed: an in-progress activity + a published node (re-file target) + one checklist so the
     *  inspections.inbox generation exists and is current before the race. */
    const seedRace = async (p: string, name: string) => {
      await inspectionsSvc.create(p, { title: `warmup ${name}`, zone: 'GF', items: ['w'] }, pmc(p));
      await applyProjection(p);
      const node = await t.prisma.projectNode.create({
        data: { projectId: p, name: `Zone for ${name}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
      });
      const act = await t.prisma.activity.create({
        data: { id: `ACT-r2-${seq++}`, projectId: p, name, zone: 'Old zone', plannedStart: 0, plannedEnd: 5, status: 'in_progress', nodeId: null },
      });
      return { node, act };
    };

    it('ordering A — a rename/re-zone/re-file commits BETWEEN the pre-read and the completion transaction: the closing carries the NEW facts', async () => {
      const p = await freshProject();
      const { node, act } = await seedRace(p, 'Old name A');

      // Barrier: hold complete() at the moment its PRE-TRANSACTION validation read returns — the exact
      // window the finding names — commit the rename there, then release.
      const delegate = t.prisma.activity as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
      const original = delegate.findUnique.bind(t.prisma.activity);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reachedResolve!: () => void;
      const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
      let hits = 0;
      delegate.findUnique = async (args: { where: { id?: string } }) => {
        const row = await original(args);
        // only the FIRST read of this activity (complete's pre-read) holds; the rename's own pre-read
        // inside the window passes straight through.
        if (args?.where?.id === act.id && ++hits === 1) { reachedResolve(); await held; }
        return row;
      };
      try {
        const completing = activities.complete(p, act.id, pmc(p));
        await reached; // complete has read the OLD name/zone/nodeId
        // the rename + re-zone + re-file COMMITS inside the window, through the real command
        await activities.update(p, act.id, { name: 'New name A', zone: 'New zone', nodeId: node.id }, pmc(p));
        release();
        await completing;
      } finally {
        delegate.findUnique = original;
      }

      // the closing inspection carries the TRANSACTION-CURRENT facts, not the stale pre-read
      const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, activityId: act.id, closing: true } });
      expect(closing.title).toBe('Closing inspection: New name A');
      expect(closing.activityName).toBe('New name A');
      expect(closing.zone).toBe('New zone');
      expect(closing.nodeId).toBe(node.id);
      // the notification text uses the same tx-current name
      const notice = await t.prisma.notification.findFirstOrThrow({ where: { projectId: p, text: { contains: 'Sign-off requested' } } });
      expect(notice.text).toContain('New name A');
      // and the projection agrees with live once the deliveries drain
      await applyProjection(p);
      await expectProjectionCurrentAndEqualsLive(p);
    });

    it('ordering B — the completion transaction locks + creates FIRST; the rename blocks behind the row lock and relabels AFTER: the facts converge', async () => {
      const p = await freshProject();
      const { node, act } = await seedRace(p, 'Old name B');

      // Barrier INSIDE the completion transaction: wrap $transaction so the tx client's
      // activity.findUniqueOrThrow (the F2 in-tx re-read, which runs AFTER the CAS took the row lock)
      // holds until released. The rename dispatched in that window blocks behind the row lock, so its
      // write is guaranteed to apply AFTER the completion commits — the deterministic ordering B.
      type TxFn = (tx: unknown) => Promise<unknown>;
      const prismaAny = t.prisma as unknown as { $transaction: (arg: unknown, opts?: unknown) => Promise<unknown> };
      const origTx = prismaAny.$transaction.bind(t.prisma);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reachedResolve!: () => void;
      const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
      prismaAny.$transaction = async (arg: unknown, opts?: unknown) => {
        if (typeof arg !== 'function') return origTx(arg, opts);
        return origTx(async (tx: unknown) => {
          const txAct = (tx as { activity: { findUniqueOrThrow: (a: { where: { id?: string } }) => Promise<unknown> } }).activity;
          const origFind = txAct.findUniqueOrThrow.bind(txAct);
          txAct.findUniqueOrThrow = async (a: { where: { id?: string } }) => {
            const row = await origFind(a);
            if (a?.where?.id === act.id) { reachedResolve(); await held; }
            return row;
          };
          return (arg as TxFn)(tx);
        }, opts);
      };
      let renaming: Promise<unknown>;
      try {
        const completing = activities.complete(p, act.id, pmc(p));
        await reached; // the CAS committed the row lock and the in-tx re-read has run — the closing is about to be created with the CURRENT (old) name
        // dispatch the rename NOW: its tx write on the same Activity row must WAIT behind the lock
        renaming = activities.update(p, act.id, { name: 'New name B', zone: 'Newer zone', nodeId: node.id }, pmc(p));
        // release the hold — the completion commits first, then the rename applies over it
        release();
        await completing;
        await renaming;
      } finally {
        prismaAny.$transaction = origTx;
      }

      // final facts converge: the Activity carries the rename; the closing was CREATED with the
      // pre-rename facts (its stored title) but its inspection-owned activityName was RELABELED.
      const finalAct = await t.prisma.activity.findUniqueOrThrow({ where: { id: act.id } });
      expect(finalAct.name).toBe('New name B');
      expect(finalAct.status).toBe('awaiting_signoff'); // the completion CAS survived the rename
      const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, activityId: act.id, closing: true } });
      expect(closing.title).toBe('Closing inspection: Old name B'); // as created (stored title semantics)
      expect(closing.activityName).toBe('New name B'); // the participant relabel re-stamped it
      // and the projection agrees with live once the deliveries drain
      await applyProjection(p);
      await expectProjectionCurrentAndEqualsLive(p);
    });
  });
});
