import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 gate finding 3 (P2) — reproduce-first, written to assert the CORRECT
 * behavior and run RED against the pre-fix head: inspection items were
 * submitted/rejected by their non-unique NAMES, so two items sharing a label
 * collapsed into one payload — a valid mixed-outcome submission 400'd, and a
 * targeted rejection could not address the exact evidenced row. Items are rows
 * with server ids; the contracts must speak in those ids.
 */
describe('inspection item identity (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');
    await t.prisma.membership.createMany({
      data: [{ projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' }],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.media.deleteMany({ where: { projectId } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { projectId, userId: f.ownerUser.id } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  it('duplicate labels with MIXED outcomes: each row keeps its own result, and the evidence chain stays addressable', async () => {
    // the reviewer's probe: two items both named "Slope"
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title: 'Dup labels', zone: 'Terrace', items: ['Slope', 'Slope'] })).status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Dup labels' }, include: { items: { orderBy: { order: 'asc' } } } });
    const [first, second] = insp.items;

    // evidence linked to the SECOND row only
    expect((await as(engToken)(`/projects/${f.projectA.id}/media`, { kind: 'inspection', mime: 'image/png', data: px, inspectionId: insp.id, inspectionItemId: second.id, clientKey: 'ii-ev-1' })).status).toBe(201);

    // a valid mixed-outcome submission, addressed by ROW ID (red pre-fix: the
    // name-keyed server collapsed both rows into the final "Slope" payload and
    // demanded evidence on BOTH -> 400)
    const submit = await as(engToken)(`/projects/${f.projectA.id}/inspections/${insp.id}/submit`, {
      items: [
        { id: first.id, name: 'Slope', state: 'pass', photos: 0, note: '' },
        { id: second.id, name: 'Slope', state: 'fail', photos: 1, note: 'ponding at drain' },
      ],
    });
    expect(submit.status).toBe(201);

    // each row carries ITS OWN result — never the same collapsed payload
    const after = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id }, orderBy: { order: 'asc' } });
    expect(after.map((it) => it.state)).toEqual(['pass', 'fail']);
    expect(after.map((it) => it.note)).toEqual(['', 'ponding at drain']);

    // rejection addresses the exact evidenced row by id — the passed twin stays clean
    const decide = await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${insp.id}/decide`, {
      approve: false,
      rejectedItemIds: [second.id],
      assigneeId: f.ownerUser.id,
    });
    expect(decide.status).toBe(201);
    const decided = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id }, orderBy: { order: 'asc' } });
    expect(decided.map((it) => it.rejected)).toEqual([false, true]);

    // exactly one reinspection child with exactly the ONE rejected item
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, reinspectionOfId: insp.id }, include: { items: true } });
    expect(child.items).toHaveLength(1);
    expect(child.items[0].name).toBe('Slope');
  });

  it('a submitted id that does not belong to the inspection is refused (containment), and an incomplete cover is refused', async () => {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title: 'Foreign id probe', zone: 'Hall', items: ['Coat'] })).status).toBe(201);
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title: 'Foreign id donor', zone: 'Hall', items: ['Donor item'] })).status).toBe(201);
    const target = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Foreign id probe' }, include: { items: true } });
    const donor = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Foreign id donor' }, include: { items: true } });

    // ANOTHER inspection's item id cannot mark this one's rows...
    const foreign = await as(engToken)(`/projects/${f.projectA.id}/inspections/${target.id}/submit`, {
      items: [{ id: donor.items[0].id, name: 'Coat', state: 'pass', photos: 0, note: '' }],
    });
    expect(foreign.status).toBe(400);
    // ...and nothing was written to either inspection
    expect((await t.prisma.inspectionItem.findUniqueOrThrow({ where: { id: target.items[0].id } })).state).toBeNull();
    expect((await t.prisma.inspectionItem.findUniqueOrThrow({ where: { id: donor.items[0].id } })).state).toBeNull();

    // rejecting by a foreign id marks nothing on this inspection either
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${target.id}/submit`, {
      items: [{ id: target.items[0].id, name: 'Coat', state: 'pass', photos: 0, note: '' }],
    })).status).toBe(201);
    const reject = await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${target.id}/decide`, {
      approve: false,
      rejectedItemIds: [donor.items[0].id],
      assigneeId: f.ownerUser.id,
    });
    expect(reject.status).toBe(400); // no item of THIS inspection was named
    expect((await t.prisma.inspectionItem.findUniqueOrThrow({ where: { id: donor.items[0].id } })).rejected).toBe(false);
  });
});
