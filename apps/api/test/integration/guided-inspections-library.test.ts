import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OrgsService } from '../../src/orgs/orgs.service';

/**
 * Guided site inspections, step 2c — THE VITAN CHECKLIST LIBRARY (proposal decision 4, Jagrut 5 Nov 2026: "one Vitan
 * library, which the PMC copies per project").
 *
 * - A library checklist is an org module of category 'checklist': exactly one checklist with its guidance and work
 *   type, and nothing else. The org owner or admin adds and archives it (the module routes).
 * - A project's PMC reads its company's library (`GET /projects/:projectId/inspections/library`) and issues a copy
 *   through the ordinary create; the library entry is unchanged by it.
 * - A template never places one: the Create Project menu leaves it out, and project creation and preset save refuse it.
 *
 * Reproduce-first: at the base (a461f43) the 'checklist' category is refused and the library route does not exist.
 */

describe('guided site inspections step 2c — the checklist library (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let orgs: OrgsService;
  let ownerToken: string;
  let pmcToken: string;
  let engToken: string;
  let otherPmcToken: string;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    orgs = t.app.get(OrgsService);
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engToken = t.issueProjectToken(f.strangerUser.id, f.projectA.id, 'engineer');
    otherPmcToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: f.strangerUser.id, role: 'engineer', status: 'active' } });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" DISABLE TRIGGER "InspectionItem_guided_not_deleted"');
      await tx.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" ENABLE TRIGGER "InspectionItem_guided_not_deleted"');
    });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.projectTemplate.deleteMany({ where: { orgId: f.orgA.id } });
    await t.prisma.templateModule.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const library = (token: string, projectId = f.projectA.id) => http().get(`/projects/${projectId}/inspections/library`).set(as(token));
  const addModule = (body: object, orgId = f.orgA.id, token = ownerToken) => http().post(`/orgs/${orgId}/modules`).set(as(token)).send(body);

  const SLAB = {
    title: 'Slab before pour', zone: 'GF', workType: 'RCC slab',
    items: ['Cover blocks', 'Shuttering', 'Level'],
    guides: [
      { lookAt: 'Lift the steel at three spots', passRule: 'A block under each, gap at least 25 mm', record: { kind: 'photo', count: 2, when: 'always', hint: 'Hold a tape against the steel' } },
      { passRule: 'Gaps under 3 mm', record: { kind: 'video', count: 1, when: 'fail' } },
      null,
    ],
  };
  const SLAB_SPECS = [
    { name: 'Cover blocks', lookAt: 'Lift the steel at three spots', passRule: 'A block under each, gap at least 25 mm', record: { kind: 'photo', count: 2, when: 'always', hint: 'Hold a tape against the steel' } },
    { name: 'Shuttering', passRule: 'Gaps under 3 mm', record: { kind: 'video', count: 1, when: 'fail' } },
    'Level',
  ];
  const addChecklist = async (name: string, checklist: object = SLAB) => {
    const res = await addModule({ name, category: 'checklist', description: 'Before every slab pour', payload: { inspections: [checklist] } });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  it('reproduce: the org adds a library checklist; the project PMC reads it with its guidance and work type, and issues a copy', async () => {
    const id = await addChecklist(`Slab ${seq++}`);
    const res = await library(pmcToken);
    expect(res.status).toBe(200);
    const entry = (res.body as Array<Record<string, unknown>>).find((e) => e.id === id);
    expect(entry).toEqual({ id, name: expect.stringMatching(/^Slab /), description: 'Before every slab pour', title: 'Slab before pour', workType: 'RCC slab', items: SLAB_SPECS });

    // the PMC issues a copy through the ordinary create, adjusting it for this project (one item left out)
    const issued = await http().post(`/projects/${f.projectA.id}/inspections`).set(as(pmcToken))
      .send({ title: `${entry!.title as string} GF-${seq}`, zone: 'GF', workType: entry!.workType, items: (entry!.items as unknown[]).slice(0, 2) });
    expect(issued.status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: `Slab before pour GF-${seq}` }, include: { items: { orderBy: { order: 'asc' } } } });
    expect(insp.workType).toBe('RCC slab');
    expect(insp.items.map((i) => [i.name, i.recordKind, i.recordCount, i.recordWhen])).toEqual([['Cover blocks', 'photo', 2, 'always'], ['Shuttering', 'video', 1, 'fail']]);
    // the library entry is as it was
    expect(((await library(pmcToken)).body as Array<{ id: string; items: unknown[] }>).find((e) => e.id === id)!.items).toEqual(SLAB_SPECS);
  });

  it('only the PMC reads it, and only its own company\'s library', async () => {
    const id = await addChecklist(`Slab ${seq++}`);
    expect((await library(engToken)).status).toBe(403);
    const other = await library(otherPmcToken, f.projectB.id);
    expect(other.status).toBe(200);
    expect((other.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(id);
    // a PMC of project B cannot read project A's library by naming it
    expect((await library(otherPmcToken, f.projectA.id)).status).toBe(403);
  });

  it('a library checklist holds exactly one checklist and nothing else, and only the org owner or admin adds one', async () => {
    const refused = async (payload: object) => (await addModule({ name: `Bad ${seq++}`, category: 'checklist', description: '', payload })).status;
    expect(await refused({ inspections: [] })).toBe(400);
    expect(await refused({ inspections: [SLAB, SLAB] })).toBe(400);
    expect(await refused({ inspections: [{ ...SLAB, nodeKey: 'n1' }], nodes: [{ key: 'n1', name: 'GF', kind: 'zone' }] })).toBe(400);
    expect(await refused({ inspections: [SLAB], phases: [{ name: 'Structure' }] })).toBe(400);
    expect((await addModule({ name: `Bad ${seq++}`, category: 'checklist', description: '', fromProject: f.projectA.id })).status).toBe(400);
    // and only what the create takes, so every entry served can be issued: a title and items that are more than spaces,
    // and at most 20 items (the zone is the PMC's to set at issue)
    expect(await refused({ inspections: [{ ...SLAB, title: '   ' }] })).toBe(400);
    expect(await refused({ inspections: [{ title: 'Blank item', items: ['Level', '  '] }] })).toBe(400);
    const names = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i + 1}`);
    expect(await refused({ inspections: [{ title: 'Too long', items: names(21) }] })).toBe(400);
    const full = await addChecklist(`Full ${seq++}`, { title: 'Twenty points', items: names(20) });
    const entry = ((await library(pmcToken)).body as Array<{ id: string; title: string; items: unknown[] }>).find((e) => e.id === full)!;
    expect(entry.items).toHaveLength(20);
    expect((await http().post(`/projects/${f.projectA.id}/inspections`).set(as(pmcToken))
      .send({ title: `${entry.title} ${seq++}`, zone: 'GF', items: entry.items })).status).toBe(201);
    // a project PMC who is not the org's owner or admin adds nothing to the library
    expect((await addModule({ name: `Bad ${seq++}`, category: 'checklist', description: '', payload: { inspections: [SLAB] } }, f.orgA.id, pmcToken)).status).toBe(403);
  });

  it('archived, it leaves the library; issued copies stay', async () => {
    const id = await addChecklist(`Slab ${seq++}`);
    expect((await http().delete(`/orgs/${f.orgA.id}/modules/${id}`).set(as(ownerToken))).status).toBe(200);
    expect(((await library(pmcToken)).body as Array<{ id: string }>).map((e) => e.id)).not.toContain(id);
  });

  it('a template never places one: the module menu leaves it out, and project creation and preset save refuse it', async () => {
    const id = await addChecklist(`Slab ${seq++}`);
    const menu = await http().get(`/orgs/${f.orgA.id}/modules`).set(as(ownerToken));
    expect(menu.status).toBe(200);
    expect((menu.body as Array<{ id: string }>).map((m) => m.id)).not.toContain(id);

    const words = /is a library checklist: a PMC issues it from a project's inspections, a template does not place it/;
    await expect(orgs.createTemplate(f.orgA.id, f.ownerUser.id, { name: `Preset ${seq++}`, description: '', items: [{ moduleId: id, count: 1 }] } as never)).rejects.toThrow(words);
    const before = await t.prisma.project.count({ where: { orgId: f.orgA.id } });
    await expect(orgs.createProject(f.orgA.id, f.ownerUser.id, {
      name: `GI2C ${seq}`, short: `gi2c-${seq++}`, descriptor: '', stage: 'Planning', siteCode: '', location: '', projStart: '', projEnd: '',
      modules: [{ moduleId: id, count: 1 }],
    } as never)).rejects.toThrow(words);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id } })).toBe(before);

    // a preset saved before (by a release that did not refuse it) names it as a library checklist, not as healthy
    const legacy = await t.prisma.projectTemplate.create({ data: { orgId: f.orgA.id, name: `Legacy ${seq++}`, items: [{ moduleId: id, count: 1 }] } });
    const listed = (await orgs.listTemplates(f.orgA.id, f.ownerUser.id)).find((p) => p.id === legacy.id)!;
    expect(listed.moduleNames).toEqual([expect.stringMatching(/ \(library checklist\)$/)]);
  });

  it('a stored row that is not one library checklist is never served', async () => {
    const stray = await t.prisma.templateModule.create({
      data: { orgId: f.orgA.id, name: `Stray ${seq++}`, category: 'checklist', description: '', payload: { inspections: [SLAB, SLAB] } },
    });
    const res = await library(pmcToken);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(stray.id);
  });
});
