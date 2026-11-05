import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';
import { OrgsService } from '../../src/orgs/orgs.service';
import { z } from 'zod';
import { createInspectionSchema, modulePayloadSchema, type GuidedItemInput } from '../../src/contracts';
import { hashRequest } from '../../src/platform/commands';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Guided site inspections, step 2a — every path that issues checklist items writes their guidance in the INSERT:
 * a new checklist (with its work type), a re-inspection's items (the same guidance and work type as the work it
 * re-checks), and a project or module made from another project or from a module. The reads serve each item's
 * `guide` (null for an item issued by name only) and each checklist's `workType`, live and from the projection alike,
 * and a projection row written before these fields is refused rather than served as unguided.
 *
 * Reproduce-first: at the base (c2f7354) create refuses a guided item (items are names only), nothing writes the
 * guidance columns, and the reads carry neither field.
 *
 * Guided items are never deleted by the database (`InspectionItem_guided_not_deleted`), so the clean-up switches that
 * trigger off by name inside its own transaction, as project removal does.
 */

const SLAB_COVER: GuidedItemInput = {
  name: 'Cover blocks',
  lookAt: 'Lift the steel at three spots',
  passRule: 'A block under each, gap at least 25 mm',
  record: { kind: 'photo', count: 1, when: 'always', hint: 'Hold a tape against the steel' },
};
const SLAB_SHUTTER: GuidedItemInput = { name: 'Shuttering level', record: { kind: 'video', count: 1, when: 'fail' } };
const SLAB_SLEEVES: GuidedItemInput = { name: 'Sleeves', lookAt: 'Check against the plumbing drawing' };
/** A guided item's guidance without its name, as a template payload stores it. */
const guideOnly = ({ name: _name, ...guide }: GuidedItemInput) => guide;

describe('guided site inspections step 2a — items are issued with their guidance (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let svc: InspectionsService;
  let query: InspectionsQueryService;
  let orgs: OrgsService;
  let seq = 0;

  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'InspectionsProjection'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    svc = t.app.get(InspectionsService);
    query = t.app.get(InspectionsQueryService);
    orgs = t.app.get(OrgsService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    const projects = await t.prisma.project.findMany({ where: { OR: [{ id: { startsWith: 'it-gi2a-' } }, { name: { startsWith: 'GI2A ' } }] }, select: { id: true } });
    const ids = projects.map((p) => p.id);
    // a guided item is never deleted; the sanctioned removal switches the refusal off by name, in one transaction
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" DISABLE TRIGGER "InspectionItem_guided_not_deleted"');
      await tx.inspectionItem.deleteMany({ where: { inspection: { projectId: { in: ids } } } });
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" ENABLE TRIGGER "InspectionItem_guided_not_deleted"');
    });
    for (const id of ids) {
      await t.prisma.commandExecution.deleteMany({ where: { projectId: id } });
      await t.prisma.inspection.updateMany({ where: { projectId: id }, data: { reinspectionOfId: null } });
      await t.prisma.inspection.deleteMany({ where: { projectId: id } });
      await t.prisma.notification.deleteMany({ where: { projectId: id } });
      await t.prisma.auditLog.deleteMany({ where: { projectId: id } });
      await t.prisma.activity.deleteMany({ where: { projectId: id } });
      await t.prisma.phase.deleteMany({ where: { projectId: id } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: id } });
      await t.prisma.membership.deleteMany({ where: { projectId: id } });
    }
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-gi2a-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { in: ids } } });
    await f?.cleanup();
    await t?.close();
  });

  const as = (sub: string, role: string, projectId: string): AuthUser => ({ sub, role, projectId }) as AuthUser;

  const freshProject = async () => {
    const p = `it-gi2a-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'G', descriptor: '', stage: 'x', siteCode: 'G', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    const member = async (tag: string, role: string): Promise<string> => {
      const id = `it-gi2a-u-${tag}-${seq}`;
      await t.prisma.user.create({ data: { id, projectId: p, role, name: `${tag} ${seq}`, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role, status: 'active' } });
      return id;
    };
    return { p, pmc: await member('pmc', 'pmc'), eng: await member('eng', 'engineer') };
  };

  const guidanceRows = (inspectionId: string) => t.prisma.inspectionItem.findMany({
    where: { inspectionId },
    orderBy: { order: 'asc' },
    select: { name: true, lookAt: true, passRule: true, recordKind: true, recordCount: true, recordWhen: true, recordHint: true },
  });

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

  const COVER_GUIDE = {
    lookAt: 'Lift the steel at three spots',
    passRule: 'A block under each, gap at least 25 mm',
    record: { kind: 'photo', count: 1, when: 'always', hint: 'Hold a tape against the steel' },
  };
  const SHUTTER_GUIDE = { lookAt: null, passRule: null, record: { kind: 'video', count: 1, when: 'fail', hint: null } };
  const SLEEVES_GUIDE = { lookAt: 'Check against the plumbing drawing', passRule: null, record: null };

  it('reproduce: a checklist issued over HTTP with guided items and a work type stores them and serves them; a plain item has guide null', async () => {
    const { p, pmc, eng } = await freshProject();
    await request(t.app.getHttpServer())
      .post(`/projects/${p}/inspections`)
      .set('Authorization', `Bearer ${t.issueProjectToken(pmc, p, 'pmc')}`)
      .send({ title: 'Slab before pour', zone: 'GF', workType: 'RCC slab', items: [SLAB_COVER, 'Plain check', SLAB_SHUTTER, SLAB_SLEEVES] })
      .expect((res) => { if (res.status >= 300) throw new Error(`${res.status} ${JSON.stringify(res.body)}`); });
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Slab before pour' } });
    expect(insp.workType).toBe('RCC slab');
    expect(await guidanceRows(insp.id)).toEqual([
      { name: 'Cover blocks', lookAt: COVER_GUIDE.lookAt, passRule: COVER_GUIDE.passRule, recordKind: 'photo', recordCount: 1, recordWhen: 'always', recordHint: 'Hold a tape against the steel' },
      { name: 'Plain check', lookAt: null, passRule: null, recordKind: null, recordCount: null, recordWhen: null, recordHint: null },
      { name: 'Shuttering level', lookAt: null, passRule: null, recordKind: 'video', recordCount: 1, recordWhen: 'fail', recordHint: null },
      { name: 'Sleeves', lookAt: 'Check against the plumbing drawing', passRule: null, recordKind: null, recordCount: null, recordWhen: null, recordHint: null },
    ]);

    for (const [viewer, role] of [[pmc, 'pmc'], [eng, 'engineer']] as const) {
      const res = await snapshot(p, viewer, role).expect(200);
      const open = (res.body.openChecklists as Array<{ id: string; workType: unknown; items: Array<{ name: string; guide: unknown }> }>).find((c) => c.id === insp.id)!;
      expect(open.workType).toBe('RCC slab');
      expect(open.items.map((it) => it.guide)).toEqual([COVER_GUIDE, null, SHUTTER_GUIDE, SLEEVES_GUIDE]);
    }
  });

  it('a keyed plain create hashes exactly as the previous release hashed it, so its retry replays instead of conflicting', async () => {
    const { p, pmc } = await freshProject();
    const body = { title: 'Retry', zone: 'GF', items: ['Level', 'Slope'] };
    await svc.create(p, body, as(pmc, 'pmc', p), 'gi2a-retry-key');
    const row = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId: p, commandType: 'inspections.create', idempotencyKey: 'gi2a-retry-key' } });
    // c2f7354's hash input, literally: no workType key at all
    expect(row.requestHash).toBe(hashRequest({ title: body.title, zone: body.zone, nodeId: null, activityId: null, items: body.items }));
    await svc.create(p, body, as(pmc, 'pmc', p), 'gi2a-retry-key');
    expect(await t.prisma.inspection.count({ where: { projectId: p, title: 'Retry' } })).toBe(1);
  });

  it('a plain checklist is unchanged: names only, workType null, every item guide null', async () => {
    const { p, pmc } = await freshProject();
    await svc.create(p, { title: 'Plain', zone: 'GF', items: ['Level', 'Slope'] }, as(pmc, 'pmc', p));
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Plain' } });
    expect(insp.workType).toBeNull();
    const live = await query.snapshotSlice(p, 'pmc', pmc);
    const open = live.openChecklists.find((c) => c.id === insp.id)!;
    expect(open).toHaveProperty('workType', null);
    expect(open.items.map((it) => it.guide)).toEqual([null, null]);
  });

  it('a re-inspection re-checks with the guidance and work type of the work it re-checks; the review queue serves them too', async () => {
    const { p, pmc, eng } = await freshProject();
    await svc.create(p, { title: 'Slab', zone: 'GF', workType: 'RCC slab', items: [SLAB_COVER, 'Plain check', SLAB_SHUTTER] }, as(pmc, 'pmc', p));
    const original = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Slab' }, include: { items: { orderBy: { order: 'asc' } } } });
    await svc.submit(p, original.id, { items: original.items.map((it) => ({ id: it.id, name: it.name, state: 'pass' as const, photos: 0, note: '' })) }, as(eng, 'engineer', p));

    // the review queue shows each item's guide beside its result
    const review = (await query.snapshotSlice(p, 'pmc', pmc)).reviews.find((r) => r.id === original.id)!;
    expect(review.workType).toBe('RCC slab');
    expect(review.items.map((it) => it.guide)).toEqual([COVER_GUIDE, null, SHUTTER_GUIDE]);

    await svc.decide(p, original.id, { approve: false, rejectedItemIds: [original.items[0]!.id, original.items[1]!.id, original.items[2]!.id], assigneeId: eng }, as(pmc, 'pmc', p));
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, reinspectionOfId: original.id } });
    expect(child.workType).toBe('RCC slab');
    expect(await guidanceRows(child.id)).toEqual(await guidanceRows(original.id));
    const open = (await query.snapshotSlice(p, 'engineer', eng)).openChecklists.find((c) => c.id === child.id)!;
    expect(open.items.map((it) => it.guide)).toEqual([COVER_GUIDE, null, SHUTTER_GUIDE]);
  });

  it('the live and projection reads serve the same guidance; a projection row written before it is refused, never served as unguided', async () => {
    const { p, pmc, eng } = await freshProject();
    await svc.create(p, { title: 'Proj', zone: 'GF', workType: 'Waterproofing', items: [SLAB_COVER, 'Plain'] }, as(pmc, 'pmc', p));
    await applyProjection(p);
    for (const [viewer, role] of [[pmc, 'pmc'], [eng, 'engineer']] as const) {
      const live = await query.snapshotSlice(p, role, viewer);
      const proj = await query.projectionSlice(p, role, viewer);
      expect(proj.generation).toBe(1);
      expect(proj.slices).toEqual(live);
    }

    const row = await t.prisma.inspectionsProjection.findFirstOrThrow({ where: { projectId: p } });
    const stored = row.dto as { inspections: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }> };
    // as the previous release stored it: no `guide` on any item (the work type is still there)
    const noGuide = structuredClone(stored);
    for (const e of noGuide.inspections) for (const it of e.items) delete it.guide;
    await t.prisma.inspectionsProjection.update({ where: { generationId_projectId: { generationId: row.generationId, projectId: p } }, data: { dto: noGuide as never } });
    expect((await query.projectionSlice(p, 'pmc', pmc)).generation).toBeNull();
    const served = await query.moduleInspections(p, 'pmc', pmc);
    expect(served.source).toBe('live');
    expect(served.openChecklists[0]!.items[0]!.guide).toEqual(COVER_GUIDE);

    // ... and none of `workType` on the entries
    const noWorkType = structuredClone(stored);
    for (const e of noWorkType.inspections) delete e.workType;
    await t.prisma.inspectionsProjection.update({ where: { generationId_projectId: { generationId: row.generationId, projectId: p } }, data: { dto: noWorkType as never } });
    expect((await query.projectionSlice(p, 'pmc', pmc)).generation).toBeNull();

    // the next inspection event re-materialises the row in the current shape, and the projection serves it again
    await svc.create(p, { title: 'Next', zone: 'GF', items: ['Level'] }, as(pmc, 'pmc', p));
    await applyProjection(p);
    const refreshed = await query.projectionSlice(p, 'pmc', pmc);
    expect(refreshed.generation).toBe(1);
    expect(refreshed.slices).toEqual(await query.snapshotSlice(p, 'pmc', pmc));
    expect(refreshed.slices.openChecklists.find((c) => c.title === 'Proj')!.items[0]!.guide).toEqual(COVER_GUIDE);
  });

  it('a project made from a module issues its checklists with their guidance and work type; a module saved from that project carries them back', async () => {
    const owner = f.ownerUser.id;
    const mod = await orgs.createModule(f.orgA.id, owner, {
      name: `GI2A checklists ${seq++}`,
      category: 'schedule',
      description: '',
      payload: modulePayloadSchema.parse({
        inspections: [
          // the guides sit beside the names, position for position (null: a plain item)
          { title: 'Slab before pour', zone: 'GF', workType: 'RCC slab', items: ['Cover blocks', 'Plain check', 'Sleeves'], guides: [guideOnly(SLAB_COVER), null, guideOnly(SLAB_SLEEVES)] },
          { title: 'Old style', zone: 'GF', items: ['Name only'] },
        ],
      }),
    } as never);
    const made = await orgs.createProject(f.orgA.id, owner, {
      name: `GI2A ${seq}`, short: `gi2a-${seq++}`, descriptor: '', stage: 'Planning', siteCode: '', location: '', projStart: '', projEnd: '',
      modules: [{ moduleId: mod.id, count: 1 }],
    } as never);
    const slab = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: made.id, title: { startsWith: 'Slab before pour' } } });
    expect(slab.workType).toBe('RCC slab');
    expect((await guidanceRows(slab.id)).map((r) => [r.name, r.lookAt, r.recordKind, r.recordHint])).toEqual([
      ['Cover blocks', COVER_GUIDE.lookAt, 'photo', 'Hold a tape against the steel'],
      ['Plain check', null, null, null],
      ['Sleeves', 'Check against the plumbing drawing', null, null],
    ]);
    const old = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: made.id, title: { startsWith: 'Old style' } } });
    expect(old.workType).toBeNull();
    expect((await guidanceRows(old.id)).map((r) => r.lookAt)).toEqual([null]);

    // a module saved from that project carries the guided items as guided items, and the plain one as a name
    const back = await orgs.createModule(f.orgA.id, owner, { name: `GI2A back ${seq++}`, category: 'schedule', description: '', fromProject: made.id } as never);
    const payload = modulePayloadSchema.parse((await t.prisma.templateModule.findUniqueOrThrow({ where: { id: back.id } })).payload);
    const slabBack = payload.inspections.find((i) => i.title.startsWith('Slab before pour'))!;
    expect(slabBack.workType).toBe('RCC slab');
    expect(slabBack.items).toEqual(['Cover blocks', 'Plain check', 'Sleeves']);
    expect(slabBack.guides).toEqual([guideOnly(SLAB_COVER), null, guideOnly(SLAB_SLEEVES)]);
    const oldBack = payload.inspections.find((i) => i.title.startsWith('Old style'))!;
    expect(oldBack.items).toEqual(['Name only']);
    expect(oldBack).not.toHaveProperty('guides');

    // the PREVIOUS release's payload schema (c2f7354, copied literally) still reads the saved module: the guides and
    // the work type are keys it strips, so during a deploy or after a rollback it lists and uses the module as plain
    // checklists instead of refusing it
    const previousRelease = z.object({ inspections: z.array(z.object({ title: z.string().min(1), zone: z.string().default(''), nodeKey: z.string().optional(), items: z.array(z.string().min(1)).min(1).max(50) })).max(100).default([]) });
    const asPrevious = previousRelease.parse((await t.prisma.templateModule.findUniqueOrThrow({ where: { id: back.id } })).payload);
    expect(asPrevious.inspections.find((i) => i.title.startsWith('Slab before pour'))!.items).toEqual(['Cover blocks', 'Plain check', 'Sleeves']);

    // and a project copied from it (structureFrom) issues them again, guided
    const copied = await orgs.createProject(f.orgA.id, owner, {
      name: `GI2A ${seq}`, short: `gi2a-${seq++}`, descriptor: '', stage: 'Planning', siteCode: '', location: '', projStart: '', projEnd: '',
      structureFrom: made.id,
    } as never);
    const slabCopy = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: copied.id, title: { startsWith: 'Slab before pour' } } });
    expect(slabCopy.workType).toBe('RCC slab');
    expect(await guidanceRows(slabCopy.id)).toEqual(await guidanceRows(slab.id));
  });

  it('the create contract: guided items and the work type are bounded as the database bounds them, and a stored plain payload still parses', () => {
    const ok = (body: object) => createInspectionSchema.safeParse({ title: 'T', zone: 'Z', ...body }).success;
    expect(ok({ items: ['Plain'] })).toBe(true);
    expect(ok({ items: [SLAB_COVER], workType: 'RCC slab' })).toBe(true);
    // 500 characters of Gujarati is 500, not 1000 UTF-16 units; 501 is refused
    expect(ok({ items: [{ name: 'x', lookAt: 'ક'.repeat(500) }] })).toBe(true);
    expect(ok({ items: [{ name: 'x', lookAt: 'ક'.repeat(501) }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', passRule: '   ' }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', lookAt: 'a\u0000b' }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', record: { kind: 'photo', count: 0, when: 'always' } }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', record: { kind: 'photo', count: 11, when: 'always' } }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', record: { kind: 'sketch', count: 1, when: 'always' } }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', record: { kind: 'photo', count: 1 } }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', record: { kind: 'voice', count: 1, when: 'fail', hint: 'h'.repeat(301) } }] })).toBe(false);
    expect(ok({ items: [{ name: 'x', extra: 1 }] })).toBe(false);
    // a guided item says something beyond its name (one that says nothing is a plain name), and its name holds no NUL
    expect(ok({ items: [{ name: 'x' }] })).toBe(false);
    expect(ok({ items: [{ name: 'a\u0000b', lookAt: 'Look' }] })).toBe(false);
    expect(ok({ items: ['x'], workType: 'w'.repeat(65) })).toBe(false);
    expect(ok({ items: ['x'], workType: ' ' })).toBe(false);
    // a module payload stored before guided items: names only, kept to the old rule for a name
    expect(modulePayloadSchema.safeParse({ inspections: [{ title: 'T', items: [' padded '] }] }).success).toBe(true);
    // the guides beside the names: one per item, each a guide or null, never a name-only guide
    const mod = (c: object) => modulePayloadSchema.safeParse({ inspections: [{ title: 'T', ...c }] }).success;
    expect(mod({ items: ['a', 'b'], guides: [null, { record: { kind: 'voice', count: 1, when: 'fail' } }] })).toBe(true);
    expect(mod({ items: ['a', 'b'], guides: [null] })).toBe(false);
    expect(mod({ items: ['a'], guides: [{}] })).toBe(false);
    expect(mod({ items: ['a'], guides: [{ name: 'a', lookAt: 'x' }] })).toBe(false);
  });
});
