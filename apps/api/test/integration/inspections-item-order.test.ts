import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { InspectionsService } from '../../src/inspections/inspections.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 — `InspectionItem.order` is the checklist's order: `create` writes it, and every read that shows the
 * checklist sorts by it. `submit` and `decide` loaded their items with no `orderBy`, so the re-inspection's
 * items (numbered from that load) and the missing-evidence sentence followed whatever order the plan returned
 * the rows in — the heap on a sequential scan (set by each row's latest write), the id on an index scan. Both
 * agree with `order` only while nothing has moved, which is why `inspections-engineer-fail-sendback` passed alone
 * and failed in a full run.
 *
 * Each test here sets `order` to the REVERSE of id order. Rows are inserted and renumbered in id order (each UPDATE
 * writes a new row version), so the `(inspectionId, id)` index, and on a fresh table the heap, return them in id
 * order, opposite to the checklist. Test 1 rewrites them in id order again after `submit`, because submit itself
 * rewrites them in checklist order.
 */
describe('#482 — submit and decide read an inspection\'s items in checklist order (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: InspectionsService;
  let seq = 0;

  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'InspectionsProjection'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(InspectionsService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    const scoped = { projectId: { startsWith: 'it-iord-' } };
    await t.prisma.commandExecution.deleteMany({ where: scoped });
    await t.prisma.media.deleteMany({ where: scoped });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: scoped } });
    await t.prisma.inspection.deleteMany({ where: scoped });
    await t.prisma.notification.deleteMany({ where: scoped });
    await t.prisma.auditLog.deleteMany({ where: scoped });
    await t.prisma.membership.deleteMany({ where: scoped });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-iord-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-iord-' } } });
  });

  const as = (sub: string, role: string, projectId: string): AuthUser => ({ sub, role, projectId }) as AuthUser;

  const freshProject = async () => {
    const p = `it-iord-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    const member = async (tag: string, role: string): Promise<string> => {
      const id = `it-iord-u-${tag}-${seq}`;
      await t.prisma.user.create({ data: { id, projectId: p, role, name: `${tag} ${seq}`, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role, status: 'active' } });
      return id;
    };
    return { p, pmc: await member('pmc', 'pmc'), eng: await member('eng', 'engineer') };
  };

  /**
   * Issue ['Rebar', 'Cover', 'Drain slope'], then renumber `order` so the checklist reads
   * Drain slope, Cover, Rebar — the reverse of id order, in which the rows are inserted and renumbered.
   */
  const reversedChecklist = async (p: string, pmc: string) => {
    await svc.create(p, { title: 'Order QA', zone: 'GF', items: ['Rebar', 'Cover', 'Drain slope'] }, as(pmc, 'pmc', p));
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Order QA' } });
    const byId = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id }, orderBy: { id: 'asc' } });
    expect(byId.map((it) => it.name)).toEqual(['Rebar', 'Cover', 'Drain slope']);
    for (const [i, it] of byId.entries()) {
      await t.prisma.inspectionItem.update({ where: { id: it.id }, data: { order: byId.length - 1 - i } });
    }
    const checklist = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id }, orderBy: { order: 'asc' } });
    expect(checklist.map((it) => it.name)).toEqual(['Drain slope', 'Cover', 'Rebar']);
    const [drain, cover, rebar] = checklist;
    return { id: insp.id, drain: drain!, cover: cover!, rebar: rebar! };
  };

  it('a sent-back inspection\'s re-inspection lists its items in the parent\'s checklist order', async () => {
    const { p, pmc, eng } = await freshProject();
    const insp = await reversedChecklist(p, pmc);
    for (const it of [insp.rebar, insp.drain]) {
      await t.prisma.media.create({ data: { id: `${it.id}-ev`, projectId: p, kind: 'inspection', mime: 'image/png', uploadedBy: eng, inspectionId: insp.id, inspectionItemId: it.id } });
    }
    await svc.submit(p, insp.id, {
      items: [
        { id: insp.rebar.id, state: 'fail' as const, photos: 1, note: 'cover short' },
        { id: insp.cover.id, state: 'pass' as const, photos: 0, note: '' },
        { id: insp.drain.id, state: 'fail' as const, photos: 1, note: 'pooling' },
      ],
    }, as(eng, 'engineer', p));
    // `submit` rewrites each row in checklist order, which leaves the heap in checklist order too. Rewrite them in id
    // order again, with the values submit wrote, so the rows `decide` loads still come back opposite to the checklist.
    for (const [it, note] of [[insp.rebar, 'cover short'], [insp.cover, ''], [insp.drain, 'pooling']] as const) {
      await t.prisma.inspectionItem.update({ where: { id: it.id }, data: { note } });
    }

    await svc.decide(p, insp.id, { approve: false, rejectedItemIds: [] }, as(pmc, 'pmc', p));

    const child = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, reinspectionOfId: insp.id }, include: { items: { orderBy: { order: 'asc' } } } });
    expect(child.items.map((it) => it.name)).toEqual(['Drain slope', 'Rebar']);
  });

  it('the missing-evidence refusal names the failed items in checklist order', async () => {
    const { p, pmc, eng } = await freshProject();
    const insp = await reversedChecklist(p, pmc);

    await expect(svc.submit(p, insp.id, {
      items: [
        { id: insp.rebar.id, state: 'fail' as const, photos: 0, note: '' },
        { id: insp.cover.id, state: 'pass' as const, photos: 0, note: '' },
        { id: insp.drain.id, state: 'fail' as const, photos: 0, note: '' },
      ],
    }, as(eng, 'engineer', p))).rejects.toThrow('A failed item needs linked photo evidence before you can submit: Drain slope, Rebar');
  });
});
