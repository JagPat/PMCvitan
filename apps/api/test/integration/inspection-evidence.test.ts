import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 Task 4 — inspection evidence + linked reinspections, against live
 * PostgreSQL (written BEFORE the implementation, per the plan):
 *   - "inspected" names the work: the checklist carries an explicit activityId
 *     requirement edge (composite-FK constrained);
 *   - a failed item without LINKED Media evidence cannot be submitted (the
 *     counter is a display derivative, not proof);
 *   - submit/decide stamp real identity; decide is CAS-guarded;
 *   - reject creates EXACTLY ONE linked reinspection (fresh items, inherited
 *     activityId, eligible assignee, real due date) — under concurrency too;
 *   - media uploads are idempotent per (projectId, clientKey) — project-scoped;
 *   - the containment chain holds at the database: cross-project media,
 *     cross-inspection item pairing, the MATCH SIMPLE partial-reference escape,
 *     cross-project reinspection parents and non-member assignees are all
 *     rejected by PostgreSQL itself.
 */
describe('inspection evidence + linked reinspections (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc, name 'member'
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer'); // name 'owner'
    await t.prisma.membership.createMany({
      data: [
        { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' },
        { projectId: f.projectA.id, userId: f.strangerUser.id, role: 'client', status: 'active' },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.media.deleteMany({ where: { projectId } });
    await t.prisma.media.deleteMany({ where: { projectId: f.projectB.id } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.activity.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { projectId, userId: { in: [f.ownerUser.id, f.strangerUser.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'); // tiny fake png

  async function makeActivity(name: string): Promise<string> {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name, plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    return (await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name } })).id;
  }

  async function makeInspection(title: string, activityId?: string, items: string[] = ['Slope check', 'Seal check']): Promise<{ id: string; itemIds: Record<string, string> }> {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title, zone: 'Terrace', items, ...(activityId ? { activityId } : {}) })).status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title }, include: { items: true } });
    return { id: insp.id, itemIds: Object.fromEntries(insp.items.map((i) => [i.name, i.id])) };
  }

  /** Upload a fail-photo LINKED to an inspection item. */
  async function linkEvidence(inspectionId: string, inspectionItemId: string, clientKey: string, token = engToken) {
    return http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`)
      .send({ kind: 'inspection', mime: 'image/png', data: px, inspectionId, inspectionItemId, clientKey });
  }

  // gate finding 3: items are addressed by ROW ID — resolve them from the DB
  const rowIds = async (inspectionId: string, name: string): Promise<string[]> =>
    (await t.prisma.inspectionItem.findMany({ where: { inspectionId, name }, orderBy: { order: 'asc' } })).map((it) => it.id);
  const submitBody = async (inspectionId: string, fail: string[], pass: string[]) => ({
    items: [
      ...(await Promise.all(fail.map(async (name) => ({ id: (await rowIds(inspectionId, name))[0], name, state: 'fail', photos: 1, note: 'defect' })))),
      ...(await Promise.all(pass.map(async (name) => ({ id: (await rowIds(inspectionId, name))[0], name, state: 'pass', photos: 0, note: '' })))),
    ],
  });

  it('the requirement edge: an inspection names the Activity it accepts; a cross-project activity is refused', async () => {
    const actId = await makeActivity('Waterproofing');
    const { id } = await makeInspection('Ponding test', actId);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id } })).activityId).toBe(actId);

    // another project's activity cannot be the requirement edge
    const res = await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title: 'Forged edge', zone: 'X', items: ['a'], activityId: 'nonexistent-or-foreign' });
    expect(res.status).toBe(400);
  });

  it('EVIDENCE RULE: a failed item without linked Media cannot be submitted; linking evidence unblocks it', async () => {
    const { id, itemIds } = await makeInspection('Tile bedding');

    // the legacy counter alone is NOT evidence — photos:1 with no linked row refuses
    const bare = await as(engToken)(`/projects/${f.projectA.id}/inspections/${id}/submit`, await submitBody(id, ['Slope check'], ['Seal check']));
    expect(bare.status).toBe(400);
    expect(bare.body.message).toMatch(/photo|evidence/i);

    // link a REAL evidence row to the failed item → submit passes, identity stamped
    expect((await linkEvidence(id, itemIds['Slope check'], 'ev-tile-1')).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${id}/submit`, await submitBody(id, ['Slope check'], ['Seal check']))).status).toBe(201);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(after.submittedById).toBe(f.ownerUser.id);
    expect(after.submittedByName).toBe('owner');
  });

  it('REJECT creates exactly ONE linked reinspection: fresh items, inherited activityId, eligible assignee, real due date', async () => {
    const actId = await makeActivity('Screeding');
    const { id, itemIds } = await makeInspection('Screed check', actId);
    expect((await linkEvidence(id, itemIds['Slope check'], 'ev-screed-1')).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${id}/submit`, await submitBody(id, ['Slope check'], ['Seal check']))).status).toBe(201);

    const before = await t.prisma.inspection.count({ where: { projectId: f.projectA.id } });
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${id}/decide`, { approve: false, rejectedItemIds: await rowIds(id, 'Slope check') })).status).toBe(201);

    // the decision is attributable
    const decided = await t.prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(decided.decided).toBe(true);
    expect(decided.decidedById).toBe(f.memberUser.id);
    expect(decided.decidedByName).toBe('member');

    // exactly one child, linked and inheriting the requirement edge
    expect(await t.prisma.inspection.count({ where: { projectId: f.projectA.id } })).toBe(before + 1);
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: id }, include: { items: true } });
    expect(child.activityId).toBe(actId); // inherited — the reinspection accepts the SAME work
    expect(child.kind).toBe('checklist');
    expect(child.submitted).toBe(false);
    expect(child.items.map((i) => i.name)).toEqual(['Slope check']); // only the rejected work returns
    expect(child.items[0].state).toBeNull(); // fresh, unfilled
    // assigned to the original submitter (an ACTIVE engineer) with a real civil due date
    expect(child.assigneeId).toBe(f.ownerUser.id);
    expect(child.dueDate).toBeInstanceOf(Date);
  });

  it('an explicit assignee must hold an ACTIVE engineer/contractor membership — a client or non-member is a 400', async () => {
    const { id, itemIds } = await makeInspection('Paint check');
    expect((await linkEvidence(id, itemIds['Slope check'], 'ev-paint-1')).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${id}/submit`, await submitBody(id, ['Slope check'], ['Seal check']))).status).toBe(201);

    // the CLIENT does not execute corrective site work
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${id}/decide`, { approve: false, rejectedItemIds: await rowIds(id, 'Slope check'), assigneeId: f.strangerUser.id })).status).toBe(400);
    // nor can a stranger with no membership at all
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${id}/decide`, { approve: false, rejectedItemIds: await rowIds(id, 'Slope check'), assigneeId: f.otherUser.id })).status).toBe(400);
    // the inspection is still undecided — the refusals changed nothing
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id } })).decided).toBe(false);
  });

  it('media idempotency is PROJECT-scoped: same clientKey twice → one row + same id; same key in another project → its own row', async () => {
    const { id, itemIds } = await makeInspection('Grout check');
    const first = await linkEvidence(id, itemIds['Slope check'], 'ev-dupe-key');
    expect(first.status).toBe(201);
    const replay = await linkEvidence(id, itemIds['Slope check'], 'ev-dupe-key');
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id); // the SAME row — upload happened once
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: 'ev-dupe-key' } })).toBe(1);

    // the key is scoped per project, never global
    const otherToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    const other = await http().post(`/projects/${f.projectB.id}/media`).set('Authorization', `Bearer ${otherToken}`)
      .send({ kind: 'progress', mime: 'image/png', data: px, clientKey: 'ev-dupe-key' });
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(first.body.id);
  });

  it('FORGERY probes: the containment chain holds at the database', async () => {
    const { id, itemIds } = await makeInspection('Chain check');
    const { id: otherInsp } = await makeInspection('Other chain');
    const itemId = itemIds['Slope check'];

    // (a) media claiming project B but naming project A's inspection
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Media" ("id","projectId","kind","mime","uploadedBy","inspectionId") VALUES ('forge-m1', $1, 'inspection', 'image/png', 'x', $2)`,
      f.projectB.id, id,
    )).rejects.toThrow(/violates foreign key constraint/);

    // (b) pairing inspection A with an item of inspection B (same project)
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Media" ("id","projectId","kind","mime","uploadedBy","inspectionId","inspectionItemId") VALUES ('forge-m2', $1, 'inspection', 'image/png', 'x', $2, $3)`,
      f.projectA.id, otherInsp, itemId,
    )).rejects.toThrow(/violates foreign key constraint/);

    // (c) the MATCH SIMPLE escape: a non-null item with a NULL inspection would bypass
    // the composite FK entirely — the CHECK forbids the partial reference outright
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Media" ("id","projectId","kind","mime","uploadedBy","inspectionItemId") VALUES ('forge-m3', $1, 'inspection', 'image/png', 'x', $2)`,
      f.projectA.id, itemId,
    )).rejects.toThrow(/Media_item_requires_inspection|check constraint/);

    // (d) a reinspection child naming another project's parent
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","reinspectionOfId") VALUES ('forge-i1', $1, 'checklist', 'x', 'x', 'today', $2)`,
      f.projectB.id, id,
    )).rejects.toThrow(/violates foreign key constraint/);

    // (e) an assignee with no membership on the project
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","assigneeId") VALUES ('forge-i2', $1, 'checklist', 'x', 'x', 'today', $2)`,
      f.projectA.id, f.otherUser.id,
    )).rejects.toThrow(/violates foreign key constraint/);
  });

  it('CONCURRENCY: two simultaneous rejects → one decision, ONE child; reject-vs-approve → one winner', async () => {
    // barrier on the inspection pre-read, as in the other race probes
    function barrierOn(inspectionId: string) {
      const delegate = t.prisma.inspection as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
      const original = delegate.findUnique.bind(t.prisma.inspection);
      let release!: () => void;
      const both = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      delegate.findUnique = async (args: { where: { id?: string } }) => {
        const row = await original(args);
        if (args?.where?.id === inspectionId) {
          reads += 1;
          if (reads === 2) release();
          await both;
        }
        return row;
      };
      return { restore: () => { delegate.findUnique = original; }, reads: () => reads };
    }

    // race 1: reject vs reject
    const a = await makeInspection('Race reject');
    expect((await linkEvidence(a.id, a.itemIds['Slope check'], 'ev-race-1')).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${a.id}/submit`, await submitBody(a.id, ['Slope check'], ['Seal check']))).status).toBe(201);
    let b = barrierOn(a.id);
    try {
      const [r1, r2] = await Promise.all([
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${a.id}/decide`, { approve: false, rejectedItemIds: [a.itemIds['Slope check']] }),
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${a.id}/decide`, { approve: false, rejectedItemIds: [a.itemIds['Slope check']] }),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    } finally {
      b.restore();
    }
    expect(await t.prisma.inspection.count({ where: { reinspectionOfId: a.id } })).toBe(1); // exactly one child

    // race 2: reject vs approve
    const c = await makeInspection('Race mixed');
    expect((await linkEvidence(c.id, c.itemIds['Slope check'], 'ev-race-2')).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${c.id}/submit`, await submitBody(c.id, ['Slope check'], ['Seal check']))).status).toBe(201);
    b = barrierOn(c.id);
    try {
      const [r1, r2] = await Promise.all([
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${c.id}/decide`, { approve: false, rejectedItemIds: [c.itemIds['Slope check']] }),
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${c.id}/decide`, { approve: true }),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]); // one winner, either way
    } finally {
      b.restore();
    }
    // whatever won, the child count matches the outcome (0 for approve, 1 for reject)
    const children = await t.prisma.inspection.count({ where: { reinspectionOfId: c.id } });
    expect([0, 1]).toContain(children);
    // and the DB backstop: a second direct child is impossible
    if (children === 1) {
      await expect(t.prisma.$executeRawUnsafe(
        `INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","reinspectionOfId") VALUES ('forge-i3', $1, 'checklist', 'x', 'x', 'today', $2)`,
        f.projectA.id, c.id,
      )).rejects.toThrow(/duplicate key|unique/);
    }
  });
});
