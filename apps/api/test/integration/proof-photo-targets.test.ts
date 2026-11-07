import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Role } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';

/**
 * #482 proof photos, U-4a: each served proof says its own item's name (`itemName`) and the root of its inspection's
 * lineage (`lineageRootId`). With them the web can show a lineage's proofs on its open row, whichever inspection of the
 * lineage a proof was added on, each labelled by its own item. A re-inspection's items are new rows, never matched to
 * the items they re-check. The fields reach exactly the viewers `proofs` reaches (staff every proof, a member their
 * own, nobody else). Proven through the real upload route and the real snapshot against PostgreSQL.
 */
describe('a proof says its item and its lineage root (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: string[] = [];
  const tokens = {} as Record<Role, string>;
  const ids = {} as Record<Role, string>;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  // a lineage A -> B -> C (A and B rejected, C submitted and waiting on the PMC), and a lone inspection D
  const A = () => `${f.projectA.id}-u4a-A`;
  const B = () => `${f.projectA.id}-u4a-B`;
  const C = () => `${f.projectA.id}-u4a-C`;
  const D = () => `${f.projectA.id}-u4a-D`;
  const item = {} as Record<'aCover' | 'cCover' | 'cCover2' | 'dPlaster', string>;
  const proofIds = {} as Record<'onA' | 'onC' | 'onC2' | 'onD', string>;

  const http = () => request(t.app.getHttpServer());
  const proof = (role: Role, inspectionId: string, inspectionItemId: string) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${tokens[role]}`)
      .send({ mime: 'image/png', data: px, kind: 'proof', inspectionId, inspectionItemId });
  const snapshot = (role: Role) => t.app.get(SnapshotService).build(f.projectA.id, role, ids[role]);
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r] as const));

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    tokens.pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    ids.pmc = f.memberUser.id;
    tokens.client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    ids.client = f.clientUser.id;
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const id = `${f.projectA.id}-u4a-${role}`;
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `A ${role}`, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
      extra.push(id);
      ids[role] = id;
      tokens[role] = t.issueProjectToken(id, f.projectA.id, role);
    }
    const base = { projectId: f.projectA.id, kind: 'review', zone: 'Zone A', date: '20 Oct', submitted: true } as const;
    await t.prisma.inspection.create({ data: { ...base, id: A(), title: 'Slab check', decided: true } });
    await t.prisma.inspection.create({ data: { ...base, id: B(), title: 'Slab check (re-inspection)', decided: true, reinspectionOfId: A() } });
    await t.prisma.inspection.create({ data: { ...base, id: C(), title: 'Slab check (re-inspection)', reinspectionOfId: B() } });
    await t.prisma.inspection.create({ data: { ...base, id: D(), title: 'Wall check', zone: 'Zone B' } });
    const mk = async (inspection: string, name: string, data: { state?: string; rejected?: boolean }) =>
      (await t.prisma.inspectionItem.create({ data: { inspectionId: inspection, name, ...data } })).id;
    item.aCover = await mk(A(), 'Cover', { state: 'fail', rejected: true });
    await mk(B(), 'Cover', { state: 'fail', rejected: true });
    // two items of one name on C: each proof is labelled by its own item, never told apart by name
    item.cCover = await mk(C(), 'Cover', { state: 'fail' });
    item.cCover2 = await mk(C(), 'Cover', { state: 'fail' });
    item.dPlaster = await mk(D(), 'Plaster', { state: 'fail' });

    const add = async (role: Role, inspectionId: string, itemId: string) => {
      const res = await proof(role, inspectionId, itemId);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    proofIds.onA = await add('contractor', A(), item.aCover);
    proofIds.onC = await add('contractor', C(), item.cCover);
    proofIds.onC2 = await add('consultant', C(), item.cCover2);
    proofIds.onD = await add('consultant', D(), item.dPlaster);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    const insp = [A(), B(), C(), D()];
    await t?.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: insp } } });
    // children first: a re-inspection's parent is a foreign key
    for (const id of [C(), B(), A(), D()]) await t?.prisma.inspection.deleteMany({ where: { id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it.each(['pmc', 'engineer'] as Role[])('the %s sees every proof with its own item name and its lineage root', async (role) => {
    const proofs = byId((await snapshot(role)).proofs);
    expect(proofs.size).toBe(4);
    expect(proofs.get(proofIds.onA)).toMatchObject({ inspectionId: A(), inspectionItemId: item.aCover, itemName: 'Cover', lineageRootId: A() });
    // added on the open re-inspection two levels down: its root is still A
    expect(proofs.get(proofIds.onC)).toMatchObject({ inspectionId: C(), inspectionItemId: item.cCover, itemName: 'Cover', lineageRootId: A() });
    expect(proofs.get(proofIds.onC2)).toMatchObject({ inspectionId: C(), inspectionItemId: item.cCover2, itemName: 'Cover', lineageRootId: A() });
    // an inspection that re-checks nothing is its own root
    expect(proofs.get(proofIds.onD)).toMatchObject({ inspectionId: D(), inspectionItemId: item.dPlaster, itemName: 'Plaster', lineageRootId: D() });
  });

  it('the root it says is the one the open row carries', async () => {
    const snap = await snapshot('pmc');
    const row = snap.reviews.find((r) => r.id === C());
    expect(row?.lineageRootId).toBe(A());
    const onC = snap.proofs.filter((p) => p.lineageRootId === row?.lineageRootId).map((p) => p.id).sort();
    expect(onC).toEqual([proofIds.onA, proofIds.onC, proofIds.onC2].sort());
  });

  it('a contractor or consultant still sees only their own proofs, with the same fields; a client sees none', async () => {
    const contractor = byId((await snapshot('contractor')).proofs);
    expect([...contractor.keys()].sort()).toEqual([proofIds.onA, proofIds.onC].sort());
    expect(contractor.get(proofIds.onC)).toMatchObject({ itemName: 'Cover', lineageRootId: A() });
    const consultant = byId((await snapshot('consultant')).proofs);
    expect([...consultant.keys()].sort()).toEqual([proofIds.onC2, proofIds.onD].sort());
    expect((await snapshot('client')).proofs).toEqual([]);
  });

  it('a proof whose item the inspections module does not answer for is still served: no item name, its own inspection as root', async () => {
    // not possible on stored data (the proof's item is a NO ACTION foreign key), so the module's answer is withheld here
    const spy = vi.spyOn(t.app.get(InspectionsQueryService), 'proofTargets').mockResolvedValueOnce(new Map());
    const proofs = byId((await snapshot('pmc')).proofs);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(proofs.size).toBe(4);
    const onC = proofs.get(proofIds.onC)!;
    expect(onC.lineageRootId).toBe(C());
    expect('itemName' in onC).toBe(false);
  });

  it('answers only for this project\'s items', async () => {
    const q = t.app.get(InspectionsQueryService);
    expect((await q.proofTargets(f.projectB.id, [item.cCover])).size).toBe(0);
    expect((await q.proofTargets(f.projectA.id, [])).size).toBe(0);
    expect([...(await q.proofTargets(f.projectA.id, [item.cCover, item.cCover, 'no-such-item'])).entries()])
      .toEqual([[item.cCover, { itemName: 'Cover', lineageRootId: A() }]]);
  });
});
