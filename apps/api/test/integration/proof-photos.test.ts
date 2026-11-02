import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Role } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * #482 site photos unit 4 (Board, 14 Oct 2026) — a contractor or consultant adds a PROOF photo on an inspection item
 * that has failed: "this is fixed". It is not evidence, so the inspection is unchanged by it; the PMC and the engineer
 * see every proof, the member who added one sees their own, and no proof is ever a site photo. Proven through the real
 * routes against PostgreSQL. Reproduce-first: on the base the `proof` kind is refused by the contract (400).
 */
describe('a contractor or consultant adds a proof photo on a failed inspection item (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: string[] = [];
  const tokens = {} as Record<Role, string>;
  const ids = {} as Record<Role, string>;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const inspectionId = () => `${f.projectA.id}-proof-insp`;
  const otherInspectionId = () => `${f.projectA.id}-proof-insp-2`;
  const item = {} as Record<'failed' | 'passed' | 'rejected' | 'other' | 'racing' | 'deciding', string>;

  const http = () => request(t.app.getHttpServer());
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send({ mime: 'image/png', data: px, ...body });
  const proof = (role: Role, itemId: string, extraBody: Record<string, unknown> = {}) =>
    upload(tokens[role], { kind: 'proof', inspectionId: inspectionId(), inspectionItemId: itemId, ...extraBody });
  const proofCount = () => t.prisma.media.count({ where: { projectId: f.projectA.id, kind: 'proof' } });
  const snapshot = (role: Role) => t.app.get(SnapshotService).build(f.projectA.id, role, ids[role]);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    tokens.pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    ids.pmc = f.memberUser.id;
    tokens.client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    ids.client = f.clientUser.id;
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const id = `${f.projectA.id}-proof-${role}`;
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `A ${role}`, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
      extra.push(id);
      ids[role] = id;
      tokens[role] = t.issueProjectToken(id, f.projectA.id, role);
    }
    // a submitted inspection, assigned to the engineer, whose items the engineer marked
    await t.prisma.inspection.create({ data: { id: inspectionId(), projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '20 Oct', submitted: true, assigneeId: ids.engineer } });
    await t.prisma.inspection.create({ data: { id: otherInspectionId(), projectId: f.projectA.id, kind: 'review', title: 'Wall check', zone: 'Zone B', date: '20 Oct', submitted: true } });
    const mk = async (inspection: string, name: string, data: { state?: string; rejected?: boolean }) =>
      (await t.prisma.inspectionItem.create({ data: { inspectionId: inspection, name, ...data } })).id;
    item.failed = await mk(inspectionId(), 'Cover', { state: 'fail' });
    item.passed = await mk(inspectionId(), 'Level', { state: 'pass' });
    item.rejected = await mk(inspectionId(), 'Curing', { state: 'pass', rejected: true });
    item.racing = await mk(inspectionId(), 'Joints', { state: 'fail' });
    item.deciding = await mk(inspectionId(), 'Drains', { state: 'fail' });
    item.other = await mk(otherInspectionId(), 'Plaster', { state: 'fail' });
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: [inspectionId(), otherInspectionId()] } } });
    await t?.prisma.inspection.deleteMany({ where: { id: { in: [inspectionId(), otherInspectionId()] } } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it.each(['contractor', 'consultant'] as Role[])('a %s adds a proof on a failed item; it is no evidence and sends no notice', async (role) => {
    const notices = await t.prisma.notification.count({ where: { projectId: f.projectA.id } });
    const before = await t.prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId() } });
    const res = await proof(role, item.failed, { clientKey: `proof-${role}` });
    expect(res.status).toBe(201);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ kind: 'proof', uploadedBy: ids[role], inspectionId: inspectionId(), inspectionItemId: item.failed, dailyLogId: null, nodeId: null });
    expect(await t.prisma.inspectionEvidence.count({ where: { mediaId: res.body.id } })).toBe(0);
    expect(await t.prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId() } })).toEqual(before);
    expect(await t.prisma.notification.count({ where: { projectId: f.projectA.id } })).toBe(notices);
  });

  it('a proof on a rejected item (sent back by the PMC) is taken as well', async () => {
    expect((await proof('contractor', item.rejected)).status).toBe(201);
  });

  it.each(['pmc', 'engineer', 'client'] as Role[])('a %s may not add a proof, and nothing is stored', async (role) => {
    const n = await proofCount();
    expect((await proof(role, item.failed)).status).toBe(403);
    expect(await proofCount()).toBe(n);
  });

  it('refuses a proof on an item that has not failed, on another inspection\'s item, or on an unknown item', async () => {
    const n = await proofCount();
    const passed = await proof('contractor', item.passed);
    expect(passed.status).toBe(409);
    expect(passed.body.message).toMatch(/has failed/);
    expect((await proof('contractor', item.other)).status).toBe(400);
    expect((await proof('contractor', 'no-such-item')).status).toBe(400);
    expect((await upload(tokens.contractor, { kind: 'proof', inspectionId: 'no-such-inspection', inspectionItemId: item.failed })).status).toBe(400);
    expect(await proofCount()).toBe(n);
  });

  it('refuses a proof filed on anything but its item, and one that is not a photo', async () => {
    const n = await proofCount();
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'proof' } });
    try {
      expect((await proof('contractor', item.failed, { dailyLogId: log.id })).status).toBe(400);
      expect((await proof('contractor', item.failed, { decisionId: 'd1' })).status).toBe(400);
      expect((await proof('contractor', item.failed, { nodeId: 'n1' })).status).toBe(400);
      expect((await proof('contractor', item.failed, { siteVisit: { visitId: 'v1' } })).status).toBe(400);
      expect((await upload(tokens.contractor, { kind: 'proof', inspectionId: inspectionId() })).status).toBe(400);
      expect((await proof('contractor', item.failed, { mime: 'audio/webm', durationSec: 3 })).status).toBe(400);
      expect(await proofCount()).toBe(n);
    } finally {
      await t.prisma.dailyLog.delete({ where: { id: log.id } });
    }
  });

  it('a replay of the same key returns the same proof; another member\'s key is refused', async () => {
    const first = await proof('contractor', item.failed, { clientKey: 'proof-replay' });
    expect(first.status).toBe(201);
    const again = await proof('contractor', item.failed, { clientKey: 'proof-replay' });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect((await proof('consultant', item.failed, { clientKey: 'proof-replay' })).status).toBe(403);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: 'proof-replay' } })).toBe(1);
  });

  it('the PMC and the engineer see every proof; a member sees their own; a client sees none; none is a site photo', async () => {
    const all = await t.prisma.media.findMany({ where: { projectId: f.projectA.id, kind: 'proof' }, select: { id: true, uploadedBy: true } });
    const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    for (const role of ['pmc', 'engineer'] as Role[]) {
      const snap = await snapshot(role);
      expect(idsOf(snap.proofs)).toEqual(idsOf(all));
    }
    for (const role of ['contractor', 'consultant'] as Role[]) {
      const snap = await snapshot(role);
      expect(idsOf(snap.proofs)).toEqual(idsOf(all.filter((m) => m.uploadedBy === ids[role])));
      expect(snap.proofs.length).toBeGreaterThan(0);
    }
    expect((await snapshot('client')).proofs).toEqual([]);
    const pmcSnap = await snapshot('pmc');
    const one = pmcSnap.proofs.find((p) => p.inspectionItemId === item.rejected)!;
    expect(one).toMatchObject({ inspectionId: inspectionId(), by: 'A contractor', byRole: 'contractor' });
    expect(one.url).toMatch(/\/media\//);
    const proofIds = new Set(all.map((m) => m.id));
    expect(pmcSnap.photos.some((p) => proofIds.has(p.id))).toBe(false);
    expect((pmcSnap.dailyLog?.photos ?? []).some((p) => proofIds.has(p.id))).toBe(false);
  });

  it('a member may not delete their own proof; the PMC deletes it', async () => {
    const own = (await proof('contractor', item.failed)).body.id as string;
    expect((await http().delete(`/media/${own}`).set('Authorization', `Bearer ${tokens.contractor}`)).status).toBe(403);
    expect(await t.prisma.media.count({ where: { id: own } })).toBe(1);
    expect((await http().delete(`/media/${own}`).set('Authorization', `Bearer ${tokens.pmc}`)).status).toBe(200);
    expect(await t.prisma.media.count({ where: { id: own } })).toBe(0);
  });

  it('an item cleared while the proof is being added: the proof waits for it and is refused, as if it came after', async () => {
    const n = await proofCount();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let cleared!: () => void;
    const isCleared = new Promise<void>((r) => { cleared = r; });
    // the item is marked passed and not yet committed
    const clearing = t.prisma.$transaction(async (tx) => {
      await tx.inspectionItem.update({ where: { id: item.racing }, data: { state: 'pass' } });
      cleared();
      await held;
    }, { timeout: 20_000 });
    await isCleared;
    const adding = proof('contractor', item.racing).then((r) => r);
    // released only once PostgreSQL shows the proof waiting on the item row's lock, never after a guessed delay:
    // without the lock the proof never waits, and this times out
    const blockedOnItem = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "InspectionItem"%FOR SHARE%'`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await blockedOnItem())) {
      if (Date.now() > deadline) { release(); await clearing; await adding; throw new Error('the proof never waited on the item row lock'); }
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await clearing;
    const res = await adding;
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/has failed/);
    expect(await proofCount()).toBe(n);
  });

  it('a decide in flight on the inspection: the proof waits for it on the inspection row, and the two never deadlock', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    // a decide takes the inspection FOR UPDATE, then marks its items rejected
    const deciding = t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Inspection" WHERE "id" = ${inspectionId()} FOR UPDATE`;
      locked();
      await held;
      await tx.inspectionItem.update({ where: { id: item.deciding }, data: { rejected: true } });
    }, { timeout: 20_000 });
    await isLocked;
    const adding = proof('contractor', item.deciding).then((r) => r);
    const blockedOnInspection = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "Inspection"%FOR KEY SHARE%'`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await blockedOnInspection())) {
      if (Date.now() > deadline) { release(); await deciding; await adding; throw new Error('the proof never waited on the inspection row'); }
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await deciding;
    // the item is still failed (sent back now), so the proof is taken after the decide
    expect((await adding).status).toBe(201);
  });

  it('an item passed before the proof is asked: the same refusal', async () => {
    // the racing item above is passed now
    const res = await proof('contractor', item.racing);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/has failed/);
  });
});
