import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 F-C4.1 (Q4 C4 on qa-test-d135) — the engineer's submit records a fail as `state = 'fail'` and never writes
 * `result`. The PMC's Send back with no explicit Reject was refused "No items rejected. Use approve instead.",
 * and the failed-item count and "a re-inspection exists" read 0, because each tested only `rejected` or
 * `result === 'FAIL'`. Now an engineer's fail is sent back like an explicit rejection, and the explicit Reject
 * path is unchanged.
 */
describe('#482 F-C4.1 — an engineer-failed item is sent back without an explicit Reject (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: InspectionsService;
  let query: InspectionsQueryService;
  let seq = 0;

  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'InspectionsProjection'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
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
    const scoped = { projectId: { startsWith: 'it-efsb-' } };
    await t.prisma.commandExecution.deleteMany({ where: scoped });
    await t.prisma.media.deleteMany({ where: scoped });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: scoped } });
    await t.prisma.inspection.deleteMany({ where: scoped });
    await t.prisma.notification.deleteMany({ where: scoped });
    await t.prisma.auditLog.deleteMany({ where: scoped });
    await t.prisma.membership.deleteMany({ where: scoped });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-efsb-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-efsb-' } } });
  });

  const as = (sub: string, role: string, projectId: string): AuthUser => ({ sub, role, projectId }) as AuthUser;

  const freshProject = async () => {
    const p = `it-efsb-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'E', descriptor: '', stage: 'x', siteCode: 'E', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    const member = async (tag: string, role: string): Promise<string> => {
      const id = `it-efsb-u-${tag}-${seq}`;
      await t.prisma.user.create({ data: { id, projectId: p, role, name: `${tag} ${seq}`, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role, status: 'active' } });
      return id;
    };
    return { p, pmc: await member('pmc', 'pmc'), eng: await member('eng', 'engineer') };
  };

  /** Issue three items; the engineer passes the first two and FAILS the third (with its linked photo), then submits. */
  const submittedWithEngineerFail = async (p: string, pmc: string, eng: string) => {
    await svc.create(p, { title: 'C4 QA', zone: 'GF', items: ['Rebar', 'Cover', 'Drain slope'] }, as(pmc, 'pmc', p));
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'C4 QA' }, include: { items: { orderBy: { order: 'asc' } } } });
    const [a, b, failed] = insp.items;
    await t.prisma.media.create({ data: { id: `${p}-ev`, projectId: p, kind: 'inspection', mime: 'image/png', uploadedBy: eng, inspectionId: insp.id, inspectionItemId: failed!.id } });
    await svc.submit(p, insp.id, {
      items: [
        { id: a!.id, state: 'pass' as const, photos: 0, note: '' },
        { id: b!.id, state: 'pass' as const, photos: 0, note: '' },
        { id: failed!.id, state: 'fail' as const, photos: 1, note: 'pooling at NE corner' },
      ],
    }, as(eng, 'engineer', p));
    return { id: insp.id, a: a!, b: b!, failed: failed! };
  };

  const childOf = (p: string, parentId: string) =>
    t.prisma.inspection.findFirst({ where: { projectId: p, reinspectionOfId: parentId }, include: { items: { orderBy: { order: 'asc' } } } });

  it('reproduce: the stored fail has no result, yet the PMC sees it as failed before deciding', async () => {
    const { p, pmc, eng } = await freshProject();
    const insp = await submittedWithEngineerFail(p, pmc, eng);
    const stored = await t.prisma.inspectionItem.findUniqueOrThrow({ where: { id: insp.failed.id } });
    expect(stored).toMatchObject({ state: 'fail', result: null, rejected: false });

    const before = await query.snapshotSlice(p, 'pmc', pmc);
    expect(before.placedInspections.find((i) => i.id === insp.id)?.failedItems).toBe(1);
    expect(before.reinspectionCreated).toBe(false);
  });

  it('Send back with no explicit Reject returns the engineer-failed item, marks it rejected and opens its re-inspection', async () => {
    const { p, pmc, eng } = await freshProject();
    const insp = await submittedWithEngineerFail(p, pmc, eng);

    await svc.decide(p, insp.id, { approve: false, rejectedItemIds: [] }, as(pmc, 'pmc', p));

    const child = await childOf(p, insp.id);
    expect(child?.items.map((it) => it.name)).toEqual(['Drain slope']);
    expect(child?.assigneeId).toBe(eng); // the recorded submitter corrects it, as for an explicit rejection
    const items = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id }, orderBy: { order: 'asc' } });
    expect(items.map((it) => it.rejected)).toEqual([false, false, true]);

    const after = await query.snapshotSlice(p, 'pmc', pmc);
    expect(after.reinspectionCreated).toBe(true);
    expect(after.placedInspections.find((i) => i.id === insp.id)).toMatchObject({ decided: true, failedItems: 1 });
  });

  it('Approve anyway on an engineer-failed item keeps the failed count but claims no re-inspection', async () => {
    const { p, pmc, eng } = await freshProject();
    const insp = await submittedWithEngineerFail(p, pmc, eng);

    await svc.decide(p, insp.id, { approve: true, rejectedItemIds: [] }, as(pmc, 'pmc', p));

    expect(await childOf(p, insp.id)).toBeNull();
    const after = await query.snapshotSlice(p, 'pmc', pmc);
    expect(after.reinspectionCreated).toBe(false);
    expect(after.placedInspections.find((i) => i.id === insp.id)).toMatchObject({ decided: true, failedItems: 1 });
  });

  it('the explicit Reject path is unchanged, and adds to the engineer-failed item', async () => {
    const { p, pmc, eng } = await freshProject();
    const insp = await submittedWithEngineerFail(p, pmc, eng);

    await svc.decide(p, insp.id, { approve: false, rejectedItemIds: [insp.a.id] }, as(pmc, 'pmc', p));

    const child = await childOf(p, insp.id);
    expect(child?.items.map((it) => it.name)).toEqual(['Rebar', 'Drain slope']);
    const items = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id }, orderBy: { order: 'asc' } });
    expect(items.map((it) => it.rejected)).toEqual([true, false, true]);
    const after = await query.snapshotSlice(p, 'pmc', pmc);
    expect(after.placedInspections.find((i) => i.id === insp.id)?.failedItems).toBe(2);
  });

  it('an explicit Reject on an all-pass submission still works alone', async () => {
    const { p, pmc, eng } = await freshProject();
    await svc.create(p, { title: 'Pass QA', zone: 'GF', items: ['Level', 'Plumb'] }, as(pmc, 'pmc', p));
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Pass QA' }, include: { items: { orderBy: { order: 'asc' } } } });
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, as(eng, 'engineer', p));

    await svc.decide(p, insp.id, { approve: false, rejectedItemIds: [insp.items[1]!.id] }, as(pmc, 'pmc', p));

    expect((await childOf(p, insp.id))?.items.map((it) => it.name)).toEqual(['Plumb']);
  });

  it('a send-back with nothing failed and nothing rejected is still refused', async () => {
    const { p, pmc, eng } = await freshProject();
    await svc.create(p, { title: 'Clean QA', zone: 'GF', items: ['Level'] }, as(pmc, 'pmc', p));
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Clean QA' }, include: { items: true } });
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, as(eng, 'engineer', p));

    await expect(svc.decide(p, insp.id, { approve: false, rejectedItemIds: [] }, as(pmc, 'pmc', p))).rejects.toThrow('No items rejected. Use approve instead.');
    expect(await childOf(p, insp.id)).toBeNull();
  });
});
