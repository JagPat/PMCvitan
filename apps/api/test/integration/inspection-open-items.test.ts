import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * #482 proof photos, "Your open items" (Jagrut, 14 Oct 2026) — a contractor or consultant's snapshot lists the open
 * inspections they are named to fix and their failed items, each with how many proof photos it holds. Proven against
 * PostgreSQL, naming through the real route. Reproduce-first: on the base the snapshot has no `openItems` key.
 */
describe('a contractor or consultant sees the open items they are named to fix (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: string[] = [];
  const tokens = {} as Record<string, string>;
  const ids = {} as Record<string, string>;
  const insp = (key: string) => `${f.projectA.id}-open-${key}`;
  const made: string[] = [];
  const items = {} as Record<string, string>;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  const http = () => request(t.app.getHttpServer());
  /** the PMC names `who` to fix `inspection`, through the real route */
  const name = (who: string, inspection: string) =>
    http().put(`/projects/${f.projectA.id}/inspections/${inspection}/responsible`)
      .set('Authorization', `Bearer ${tokens.pmc}`).set('Idempotency-Key', randomUUID()).send({ memberId: ids[who] });
  const openItems = async (who: string, role: Role) => (await t.app.get(SnapshotService).build(f.projectA.id, role, ids[who])).openItems;
  const proof = (who: string, inspection: string, itemId: string) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${tokens[who]}`)
      .send({ mime: 'image/png', data: px, kind: 'proof', inspectionId: inspection, inspectionItemId: itemId });

  const member = async (key: string, role: Role) => {
    const id = `${f.projectA.id}-open-${key}`;
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `A ${key}`, email: `${id}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    extra.push(id);
    ids[key] = id;
    tokens[key] = t.issueProjectToken(id, f.projectA.id, role);
  };
  const inspection = async (key: string, data: { submitted?: boolean; decided?: boolean; reinspectionOf?: string }, marks: Array<[string, { state?: string; rejected?: boolean }]> = []) => {
    await t.prisma.inspection.create({ data: {
      id: insp(key), projectId: f.projectA.id, kind: data.submitted ? 'review' : 'checklist', title: `Check ${key}`, zone: 'Zone A', date: '2 Nov',
      submitted: data.submitted ?? false, decided: data.decided ?? false, reinspectionOfId: data.reinspectionOf ? insp(data.reinspectionOf) : null,
    } });
    made.push(insp(key));
    for (const [i, [label, mark]] of marks.entries()) {
      items[`${key}.${label}`] = (await t.prisma.inspectionItem.create({ data: { inspectionId: insp(key), name: label, order: i, ...mark } })).id;
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    ids.pmc = f.memberUser.id;
    tokens.pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    ids.client = f.clientUser.id;
    for (const [key, role] of [['engineer', 'engineer'], ['contractor', 'contractor'], ['consultant', 'consultant'], ['other', 'contractor'], ['leaver', 'contractor']] as Array<[string, Role]>) {
      await member(key, role);
    }
    // issued, not submitted: open, and its marks are the engineer's work in progress
    await inspection('issued', {}, [['Draft fail', { state: 'fail' }]]);
    // submitted, waiting on the PMC: open, with its failed items (an engineer's fail and a PMC reject), not its pass
    await inspection('review', { submitted: true }, [['Cover', { state: 'fail' }], ['Level', { state: 'pass' }], ['Curing', { state: 'pass', rejected: true }]]);
    // rejected: its re-inspection is under way, so it is still open
    await inspection('sentback', { submitted: true, decided: true }, [['Joints', { state: 'fail' }]]);
    await inspection('sentback-re', { reinspectionOf: 'sentback' }, [['Joints', {}]]);
    // approved: closed
    await inspection('approved', { submitted: true, decided: true }, [['Plaster', { state: 'pass' }]]);
    // rejected, then its re-inspection approved: the lineage is closed
    await inspection('fixed', { submitted: true, decided: true }, [['Drains', { state: 'fail' }]]);
    await inspection('fixed-re', { submitted: true, decided: true, reinspectionOf: 'fixed' }, [['Drains', { state: 'pass' }]]);
    // named to someone else
    await inspection('theirs', { submitted: true }, [['Grout', { state: 'fail' }]]);
    for (const key of ['issued', 'review', 'sentback', 'approved', 'fixed']) expect((await name('contractor', insp(key))).status).toBe(200);
    expect((await name('other', insp('theirs'))).status).toBe(200);
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.auditLog.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: made } } });
    // children before their predecessors (the lineage key)
    await t?.prisma.inspection.deleteMany({ where: { id: { in: made }, reinspectionOfId: { not: null } } });
    await t?.prisma.inspection.deleteMany({ where: { id: { in: made } } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it('lists the open inspections the viewer is named to fix, by id, with where each stands and its failed items', async () => {
    expect(await openItems('contractor', 'contractor')).toEqual([
      { inspectionId: insp('issued'), title: 'Check issued', zone: 'Zone A', nodeId: null, status: 'issued', failedItems: [] },
      { inspectionId: insp('review'), title: 'Check review', zone: 'Zone A', nodeId: null, status: 'in-review', failedItems: [
        { itemId: items['review.Cover'], name: 'Cover', proofCount: 0 },
        { itemId: items['review.Curing'], name: 'Curing', proofCount: 0 },
      ] },
      { inspectionId: insp('sentback'), title: 'Check sentback', zone: 'Zone A', nodeId: null, status: 'reinspection', failedItems: [
        { itemId: items['sentback.Joints'], name: 'Joints', proofCount: 0 },
      ] },
    ]);
  });

  it('an approved inspection, and one whose re-inspection was approved, are not open', async () => {
    const listed = (await openItems('contractor', 'contractor')).map((i) => i.inspectionId);
    expect(listed).not.toContain(insp('approved'));
    expect(listed).not.toContain(insp('fixed'));
    // and an inspection named to another member is theirs alone
    expect(listed).not.toContain(insp('theirs'));
    expect((await openItems('other', 'contractor')).map((i) => i.inspectionId)).toEqual([insp('theirs')]);
  });

  it('a three-step lineage (rejected, rejected again, then approved) is closed: the walk follows it to its end', async () => {
    await inspection('g0', { submitted: true, decided: true }, [['Beam', { state: 'fail' }]]);
    await inspection('g1', { submitted: true, decided: true, reinspectionOf: 'g0' }, [['Beam', { state: 'fail' }]]);
    await inspection('g2', { submitted: true, decided: true, reinspectionOf: 'g1' }, [['Beam', { state: 'pass' }]]);
    expect((await name('contractor', insp('g0'))).status).toBe(200);
    expect((await openItems('contractor', 'contractor')).map((i) => i.inspectionId)).not.toContain(insp('g0'));
  });

  it('only a contractor or consultant gets the list: a consultant named nowhere has none, and the PMC, engineer and client get none', async () => {
    expect(await openItems('consultant', 'consultant')).toEqual([]);
    expect(await openItems('pmc', 'pmc')).toEqual([]);
    expect(await openItems('engineer', 'engineer')).toEqual([]);
    expect(await openItems('client', 'client')).toEqual([]);
    // the same viewer under a role the read does not serve gets none
    expect(await openItems('contractor', 'engineer')).toEqual([]);
  });

  it('a consultant named on an inspection sees it the same way', async () => {
    expect((await name('consultant', insp('review'))).status).toBe(200);
    expect((await openItems('consultant', 'consultant')).map((i) => i.inspectionId)).toEqual([insp('review')]);
    expect((await openItems('contractor', 'contractor')).map((i) => i.inspectionId)).not.toContain(insp('review'));
    expect((await name('contractor', insp('review'))).status).toBe(200);
  });

  it('each failed item counts every member\'s proof photos on it (the count the upload\'s cap counts)', async () => {
    expect((await proof('contractor', insp('review'), items['review.Cover']!)).status).toBe(201);
    expect((await proof('consultant', insp('review'), items['review.Cover']!)).status).toBe(201);
    expect((await proof('other', insp('review'), items['review.Curing']!)).status).toBe(201);
    const review = (await openItems('contractor', 'contractor')).find((i) => i.inspectionId === insp('review'))!;
    expect(review.failedItems).toEqual([
      { itemId: items['review.Cover'], name: 'Cover', proofCount: 2 },
      { itemId: items['review.Curing'], name: 'Curing', proofCount: 1 },
    ]);
  });

  it('a named member removed through the real route is named nowhere: their list is empty, and stays so if they come back', async () => {
    expect((await name('leaver', insp('review'))).status).toBe(200);
    expect((await openItems('leaver', 'contractor')).map((i) => i.inspectionId)).toEqual([insp('review')]);
    const asPmc = (r: request.Test) => r.set('Authorization', `Bearer ${tokens.pmc}`).set('Idempotency-Key', randomUUID());
    expect((await asPmc(http().delete(`/projects/${f.projectA.id}/members/${ids.leaver}`))).status).toBe(200);
    expect(await openItems('leaver', 'contractor')).toEqual([]);
    // added back through the real route: still named nowhere, until someone names them again
    expect((await asPmc(http().post(`/projects/${f.projectA.id}/members`)).send({ name: 'A leaver', role: 'contractor', email: `${ids.leaver}@test.local` })).status).toBe(201);
    expect(await openItems('leaver', 'contractor')).toEqual([]);
    expect((await name('contractor', insp('review'))).status).toBe(200);
  });
});
