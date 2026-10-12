import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import { addCivilDays } from '../../src/common/civil-date';
import { SystemClock } from '../../src/common/clock';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #771 read contract (#482 6115700782) — a re-inspection's STORED due date and assignee reach the client through
 * the existing inspection read, for records the viewer already receives, and nothing else changes.
 *
 * The facts were stored since Phase 1 (`Inspection.dueDate`, a civil `@db.Date`; `Inspection.assigneeId`) but the
 * read contract dropped both: the projection base carried the assignee only to FILTER the field view, never the
 * due date, and the served checklist and review rows carried neither. So no screen could say when a re-inspection
 * is due or whose it is.
 *
 * - Live and projection reads serve the same metadata (one serializer), and a projection row written before the
 *   field existed is refused rather than served as "no due date" (the read falls back to the canonical live slice).
 * - An ordinary checklist says `null` for both; a re-inspection says its stored values. `null` (none stored) and an
 *   absent key (a server older than the field) stay distinguishable.
 * - The due date is the stored CIVIL date, compared against Postgres' own text of the column, under process time
 *   zones on both sides of UTC and a project zone east of UTC, so no zone shifts the day.
 * - The stored assignee is a historical fact, not an authority: who RECEIVES the record is still the binding rule
 *   (`bindingAssigneeIds`), so a removed or re-roled assignee's re-inspection reaches the replacement with the stored
 *   id unchanged, and a bound assignee's re-inspection still never reaches another engineer.
 *
 * Isolated automated fixtures only; this is not live role QA.
 */

describe('#771 — re-inspection due date and assignee on the existing inspection read (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let svc: InspectionsService;
  let query: InspectionsQueryService;
  let seq = 0;

  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'InspectionsProjection'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    svc = t.app.get(InspectionsService);
    query = t.app.get(InspectionsQueryService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    const scoped = { projectId: { startsWith: 'it-inrm-' } };
    await t.prisma.commandExecution.deleteMany({ where: scoped });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: scoped } });
    await t.prisma.inspection.deleteMany({ where: scoped });
    await t.prisma.notification.deleteMany({ where: scoped });
    await t.prisma.auditLog.deleteMany({ where: scoped });
    await t.prisma.membership.deleteMany({ where: scoped });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-inrm-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-inrm-' } } });
  });

  const as = (sub: string, role: string, projectId: string): AuthUser => ({ sub, role, projectId }) as AuthUser;

  /** A fresh project (optionally in `timeZone`) with a pmc, engineers A and B, a contractor and a client. */
  const freshProject = async (timeZone?: string) => {
    const p = `it-inrm-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'R', descriptor: '', stage: 'x', siteCode: 'R', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, ...(timeZone ? { timeZone } : {}) },
    });
    const member = async (tag: string, role: string): Promise<string> => {
      const id = `it-inrm-u-${tag}-${seq}`;
      await t.prisma.user.create({ data: { id, projectId: p, role, name: `${tag} ${seq}`, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role, status: 'active' } });
      return id;
    };
    const pmc = await member('pmc', 'pmc');
    return { p, pmc, engA: await member('engA', 'engineer'), engB: await member('engB', 'engineer'), con: await member('con', 'contractor'), client: await member('cli', 'client') };
  };

  /** Issue → submit (all pass, by `submitter`) → reject one item, assigned to `assignee`, due in `dueInDays`.
   *  Returns the original's id and the open re-inspection's id. */
  const rejectedReinspection = async (p: string, pmc: string, submitter: string, assignee: string, dueInDays: number, title = 'Slab QA') => {
    await svc.create(p, { title, zone: 'GF', items: ['Rebar', 'Cover'] }, as(pmc, 'pmc', p));
    const original = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title }, include: { items: { orderBy: { order: 'asc' } } } });
    await svc.submit(p, original.id, { items: original.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, as(submitter, 'engineer', p));
    await svc.decide(p, original.id, { approve: false, rejectedItemIds: [original.items[0]!.id], assigneeId: assignee, dueInDays }, as(pmc, 'pmc', p));
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, reinspectionOfId: original.id } });
    return { originalId: original.id, childId: child.id };
  };

  /** Postgres' own text of the stored civil date — no JavaScript Date in the path. */
  const storedDueText = async (id: string): Promise<string | null> => {
    const rows = await t.prisma.$queryRaw<Array<{ due: string | null }>>`SELECT "dueDate"::text AS due FROM "Inspection" WHERE "id" = ${id}`;
    return rows[0]?.due ?? null;
  };

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

  const snapshot = (p: string, userId: string, role: string) =>
    request(t.app.getHttpServer()).get(`/projects/${p}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(userId, p, role as never)}`);

  const byId = <T extends { id: string }>(rows: T[]): Record<string, T> => Object.fromEntries(rows.map((r) => [r.id, r]));

  it('reproduce: an open re-inspection is served with its stored due date and assignee; an ordinary checklist with explicit nulls (HTTP)', async () => {
    const { p, pmc, engA } = await freshProject();
    const { childId } = await rejectedReinspection(p, pmc, engA, engA, 5);
    await svc.create(p, { title: 'Ordinary QA', zone: 'GF', items: ['Level'] }, as(pmc, 'pmc', p));
    const ordinary = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Ordinary QA' } });
    const due = await storedDueText(childId);
    expect(due).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    const res = await snapshot(p, pmc, 'pmc').expect(200);
    const open = byId(res.body.openChecklists as Array<{ id: string }>);
    expect(open[childId]).toMatchObject({ reinspectionOfId: expect.any(String), assigneeId: engA, dueDate: due });
    // an ordinary checklist states "none stored" — never an absent key, which a client reads as an older server
    expect(open[ordinary.id]).toHaveProperty('assigneeId', null);
    expect(open[ordinary.id]).toHaveProperty('dueDate', null);
    for (const c of res.body.openChecklists as Array<Record<string, unknown>>) {
      expect(c).toHaveProperty('assigneeId');
      expect(c).toHaveProperty('dueDate');
    }

    // the assignee's own field view carries the same facts
    const mine = await snapshot(p, engA, 'engineer').expect(200);
    expect(byId(mine.body.openChecklists as Array<{ id: string }>)[childId]).toMatchObject({ assigneeId: engA, dueDate: due });
  });

  it('reproduce: a submitted re-inspection in the PMC review queue carries the same due date and assignee', async () => {
    const { p, pmc, engA } = await freshProject();
    const { childId } = await rejectedReinspection(p, pmc, engA, engA, 4);
    const child = await t.prisma.inspection.findUniqueOrThrow({ where: { id: childId }, include: { items: true } });
    await svc.submit(p, childId, { items: child.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, as(engA, 'engineer', p));
    const res = await snapshot(p, pmc, 'pmc').expect(200);
    const review = byId(res.body.reviews as Array<{ id: string }>)[childId];
    expect(review).toMatchObject({ reinspectionOfId: expect.any(String), assigneeId: engA, dueDate: await storedDueText(childId) });
  });

  it('live and projection reads agree on the metadata for the same records, for every persona', async () => {
    const { p, pmc, engA, engB, con, client } = await freshProject();
    const { childId } = await rejectedReinspection(p, pmc, engA, engA, 3);
    await svc.create(p, { title: 'Ordinary QA', zone: 'GF', items: ['Level'] }, as(pmc, 'pmc', p));
    await applyProjection(p);
    for (const [viewer, role] of [[pmc, 'pmc'], [engA, 'engineer'], [engB, 'engineer'], [con, 'contractor'], [client, 'client']] as const) {
      const live = await query.snapshotSlice(p, role, viewer);
      const proj = await query.projectionSlice(p, role, viewer);
      expect(proj.generation).toBe(1);
      expect(proj.slices).toEqual(live);
    }
    const pmcLive = await query.snapshotSlice(p, 'pmc', pmc);
    expect(byId(pmcLive.openChecklists)[childId]).toMatchObject({ assigneeId: engA, dueDate: await storedDueText(childId) });
  });

  it('a projection row written before the due date existed is refused, never served as "no due date"; the live read serves it', async () => {
    const { p, pmc, engA } = await freshProject();
    const { childId } = await rejectedReinspection(p, pmc, engA, engA, 6);
    await applyProjection(p);
    expect((await query.projectionSlice(p, 'pmc', pmc)).generation).toBe(1);

    // exactly what the previous release's serializer stored: every entry has `assigneeId`, none has `dueDate`
    const row = await t.prisma.inspectionsProjection.findFirstOrThrow({ where: { projectId: p } });
    const older = row.dto as { inspections: Array<Record<string, unknown>> };
    for (const e of older.inspections) delete e.dueDate;
    await t.prisma.inspectionsProjection.update({ where: { generationId_projectId: { generationId: row.generationId, projectId: p } }, data: { dto: older as never } });

    expect((await query.projectionSlice(p, 'pmc', pmc)).generation).toBeNull();
    const served = await query.moduleInspections(p, 'pmc', pmc);
    expect(served.source).toBe('live');
    expect(byId(served.openChecklists)[childId]).toMatchObject({ assigneeId: engA, dueDate: await storedDueText(childId) });
  });

  it('the stored assignee is not an authority: who receives the re-inspection is unchanged (bound, removed, re-roled)', async () => {
    const { p, pmc, engA, engB, con, client } = await freshProject();
    const { childId } = await rejectedReinspection(p, pmc, engA, engA, 2);
    const due = await storedDueText(childId);
    const openIds = async (viewer: string, role: string) => ((await snapshot(p, viewer, role).expect(200)).body.openChecklists as Array<{ id: string }>).map((c) => c.id);

    // bound to engineer A: the PMC and A receive it; engineer B and the contractor do not (unchanged)
    expect(await openIds(pmc, 'pmc')).toContain(childId);
    expect(await openIds(engA, 'engineer')).toContain(childId);
    expect(await openIds(engB, 'engineer')).not.toContain(childId);
    expect(await openIds(con, 'contractor')).not.toContain(childId);
    // the client's field view follows the same unchanged rule as before this unit (not the assignee's)
    expect(await openIds(client, 'client')).not.toContain(childId);

    // A is re-roled out of corrective work: the assignment stops binding, B receives it — the stored id unchanged
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: p, userId: engA } }, data: { role: 'client' } });
    const reRoled = byId((await snapshot(p, engB, 'engineer').expect(200)).body.openChecklists as Array<{ id: string }>)[childId];
    expect(reRoled).toMatchObject({ assigneeId: engA, dueDate: due });

    // A is removed instead: the same
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: p, userId: engA } }, data: { role: 'engineer', status: 'removed' } });
    const removed = byId((await snapshot(p, engB, 'engineer').expect(200)).body.openChecklists as Array<{ id: string }>)[childId];
    expect(removed).toMatchObject({ assigneeId: engA, dueDate: due });

    // another project's member still receives none of it
    const foreign = await request(t.app.getHttpServer()).get(`/projects/${p}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectB.id)}`);
    expect([401, 403]).toContain(foreign.status);
  });

  it('the due date is the stored civil day under process time zones either side of UTC and a project zone east of UTC', async () => {
    const original = process.env.TZ;
    try {
      const { p, pmc, engA } = await freshProject('Pacific/Kiritimati'); // UTC+14: its "today" is often UTC's tomorrow
      const { childId } = await rejectedReinspection(p, pmc, engA, engA, 1);
      const due = await storedDueText(childId);
      // the stored day is the project's civil today + 1 (the writer's rule), so the read has a fixed target
      expect(due).toBe(addCivilDays(new SystemClock().today('Pacific/Kiritimati'), 1));
      for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'UTC']) {
        process.env.TZ = tz;
        const slice = await query.snapshotSlice(p, 'pmc', pmc);
        expect(byId(slice.openChecklists)[childId]?.dueDate).toBe(due);
        const res = await snapshot(p, pmc, 'pmc').expect(200);
        expect(byId(res.body.openChecklists as Array<{ id: string; dueDate?: string }>)[childId]?.dueDate).toBe(due);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
