import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * #482 proof photos, "Who fixes this?" (Jagrut, 14 Oct 2026) — the PMC or the engineer names the contractor or
 * consultant member who fixes an inspection's failed work (`PUT …/inspections/:id/responsible`), or nobody. Proven
 * through the real route against PostgreSQL. Reproduce-first: on the base the route does not exist (404).
 */
describe('the PMC or engineer names who fixes an inspection\'s failed work (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: string[] = [];
  const tokens = {} as Record<string, string>;
  const ids = {} as Record<string, string>;
  const inspectionId = () => `${f.projectA.id}-resp-insp`;
  const otherProjectInspection = () => `${f.projectB.id}-resp-insp`;

  const http = () => request(t.app.getHttpServer());
  const put = (who: string, memberId: string | null, insp = inspectionId(), key: string = randomUUID()) =>
    http().put(`/projects/${f.projectA.id}/inspections/${insp}/responsible`)
      .set('Authorization', `Bearer ${tokens[who]}`).set('Idempotency-Key', key).send({ memberId });
  const stored = async () => (await t.prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId() }, select: { responsibleMemberId: true } })).responsibleMemberId;
  const listed = async (role: Role, userId: string) => (await t.app.get(SnapshotService).build(f.projectA.id, role, userId)).responsibleMembers;

  const member = async (key: string, role: Role, project = f.projectA.id) => {
    const id = `${f.projectA.id}-resp-${key}`;
    await t.prisma.user.create({ data: { id, projectId: project, role, name: `A ${key}`, email: `${id}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: project, userId: id, role, status: 'active' } });
    extra.push(id);
    ids[key] = id;
    tokens[key] = t.issueProjectToken(id, project, role);
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    ids.pmc = f.memberUser.id;
    tokens.pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    ids.client = f.clientUser.id;
    tokens.client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    for (const [key, role] of [['engineer', 'engineer'], ['contractor', 'contractor'], ['consultant', 'consultant'],
      ['racer', 'contractor'], ['leaver', 'contractor'], ['engineer2', 'engineer']] as Array<[string, Role]>) await member(key, role);
    await member('elsewhere', 'contractor', f.projectB.id);
    await t.prisma.inspection.create({ data: { id: inspectionId(), projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '2 Nov', submitted: true } });
    await t.prisma.inspection.create({ data: { id: otherProjectInspection(), projectId: f.projectB.id, kind: 'review', title: 'Wall check', zone: 'Zone B', date: '2 Nov' } });
  });

  afterAll(async () => {
    await t?.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t?.prisma.inspection.deleteMany({ where: { id: { in: [inspectionId(), otherProjectInspection()] } } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it('the PMC names a contractor, the engineer changes it to a consultant, and either clears it', async () => {
    expect((await put('pmc', ids.contractor!)).status).toBe(200);
    expect(await stored()).toBe(ids.contractor);
    expect(await listed('pmc', ids.pmc!)).toContainEqual({ inspectionId: inspectionId(), memberId: ids.contractor });
    const changed = await put('engineer', ids.consultant!);
    expect(changed.status).toBe(200);
    expect(changed.body.responsibleMembers).toContainEqual({ inspectionId: inspectionId(), memberId: ids.consultant });
    expect(await listed('engineer', ids.engineer!)).toContainEqual({ inspectionId: inspectionId(), memberId: ids.consultant });
    expect((await put('engineer', null)).status).toBe(200);
    expect(await stored()).toBeNull();
    expect((await listed('pmc', ids.pmc!)).some((r) => r.inspectionId === inspectionId())).toBe(false);
    const audit = await t.prisma.auditLog.findMany({ where: { projectId: f.projectA.id, action: 'inspection.responsible', entityId: inspectionId() }, orderBy: { at: 'asc' } });
    expect(audit.map((a) => (a.payload as { to: string | null }).to)).toEqual([ids.contractor, ids.consultant, null]);
  });

  it('only the PMC and the engineer may name one: a contractor, a consultant and a client get 403, and nothing changes', async () => {
    for (const who of ['contractor', 'consultant', 'client']) {
      expect((await put(who, ids.contractor!)).status).toBe(403);
    }
    expect(await stored()).toBeNull();
  });

  it('only an active contractor or consultant of this project can be named: anyone else is 400 and nothing changes', async () => {
    await put('pmc', ids.contractor!);
    for (const bad of [ids.engineer2!, ids.pmc!, ids.client!, ids.elsewhere!, `${f.projectA.id}-nobody`]) {
      const res = await put('pmc', bad);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/active contractor or consultant/);
    }
    expect(await stored()).toBe(ids.contractor);
    await put('pmc', null);
  });

  it('another project\'s inspection or an unknown one is 404; a body that is not one member id or null is 400', async () => {
    expect((await put('pmc', ids.contractor!, otherProjectInspection())).status).toBe(404);
    expect((await put('pmc', ids.contractor!, `${f.projectA.id}-no-such`)).status).toBe(404);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: otherProjectInspection() } })).responsibleMemberId).toBeNull();
    for (const body of [{}, { memberId: '' }, { memberId: 7 }, { memberId: ids.contractor, extra: 1 }]) {
      const res = await http().put(`/projects/${f.projectA.id}/inspections/${inspectionId()}/responsible`)
        .set('Authorization', `Bearer ${tokens.pmc}`).set('Idempotency-Key', randomUUID()).send(body);
      expect(res.status).toBe(400);
    }
  });

  it('nobody but the PMC and the engineer sees who is named', async () => {
    await put('pmc', ids.contractor!);
    for (const [role, who] of [['contractor', 'contractor'], ['consultant', 'consultant'], ['client', 'client']] as Array<[Role, string]>) {
      expect(await listed(role, ids[who]!)).toEqual([]);
    }
    await put('pmc', null);
  });

  it('a replay of the same key changes nothing twice and answers the same', async () => {
    const key = randomUUID();
    const before = await t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'inspection.responsible' } });
    expect((await put('pmc', ids.consultant!, inspectionId(), key)).status).toBe(200);
    expect((await put('pmc', ids.consultant!, inspectionId(), key)).status).toBe(200);
    expect(await t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'inspection.responsible' } })).toBe(before + 1);
    await put('pmc', null);
  });

  it('a named member is removed through the real route: the removal goes through, and the read names no one while the record keeps the name', async () => {
    await put('pmc', ids.leaver!);
    const removed = await http().delete(`/projects/${f.projectA.id}/members/${ids.leaver}`)
      .set('Authorization', `Bearer ${tokens.pmc}`).set('Idempotency-Key', randomUUID());
    expect(removed.status).toBe(200);
    expect(await stored()).toBe(ids.leaver);
    expect((await listed('pmc', ids.pmc!)).some((r) => r.inspectionId === inspectionId())).toBe(false);
    // and they cannot be named again while removed
    expect((await put('pmc', ids.leaver!)).status).toBe(400);
    await put('pmc', null);
  });

  it('a member re-roled while being named: the naming waits on their membership row and is refused, as if it came after', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let changed!: () => void;
    const isChanged = new Promise<void>((r) => { changed = r; });
    // the racer becomes a client and the change is not yet committed (a re-role takes no readiness key)
    const rerole = t.prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: ids.racer! } }, data: { role: 'client' } });
      changed();
      await held;
    }, { timeout: 20_000 });
    await isChanged;
    const naming = put('pmc', ids.racer!).then((r) => r);
    // released only once PostgreSQL shows the naming waiting, never after a guessed delay: on the project's readiness key
    // (a membership write takes it through its standing trigger) or on the membership row itself
    const waiting = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND (query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%FROM "Membership"%FOR UPDATE%')`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await waiting())) {
      if (Date.now() > deadline) { release(); await rerole; await naming; throw new Error('the naming never waited for the re-role'); }
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await rerole;
    const res = await naming;
    expect(res.status).toBe(400);
    expect(await stored()).toBeNull();
  });
});
