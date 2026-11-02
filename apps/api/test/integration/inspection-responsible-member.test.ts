import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ROLE_POLICY, type Role } from '@vitan/shared';
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
  const assignedInspection = () => `${f.projectA.id}-resp-assigned`;
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
    // no architect can be a member yet (the database refuses the role until 4d-iii), so the architect's token is held
    // by an existing user: the policy refuses the token's role before anything reads a membership
    ids.architect = f.clientUser.id;
    tokens.architect = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'architect');
    for (const [key, role] of [['engineer', 'engineer'], ['contractor', 'contractor'], ['consultant', 'consultant'],
      ['racer', 'contractor'], ['leaver', 'contractor'], ['engineer2', 'engineer']] as Array<[string, Role]>) await member(key, role);
    await member('elsewhere', 'contractor', f.projectB.id);
    await t.prisma.inspection.create({ data: { id: inspectionId(), projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '2 Nov', submitted: true } });
    // another engineer's assigned, open re-inspection: the "mine" filter keeps it out of engineer2's checklists
    await t.prisma.inspection.create({ data: { id: assignedInspection(), projectId: f.projectA.id, kind: 'checklist', title: 'Re-check', zone: 'Zone A', date: '2 Nov', assigneeId: ids.engineer } });
    await t.prisma.inspection.create({ data: { id: otherProjectInspection(), projectId: f.projectB.id, kind: 'review', title: 'Wall check', zone: 'Zone B', date: '2 Nov' } });
  });

  afterAll(async () => {
    await t?.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t?.prisma.inspection.deleteMany({ where: { id: { in: [inspectionId(), assignedInspection(), otherProjectInspection()] } } });
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

  it('only the PMC and the engineer may name one: a contractor, a consultant, a client and an architect get 403, and nothing changes', async () => {
    expect(ROLE_POLICY['inspection.responsible']).toEqual(['pmc', 'engineer']);
    for (const who of ['contractor', 'consultant', 'client', 'architect']) {
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
    for (const [role, who] of [['contractor', 'contractor'], ['consultant', 'consultant'], ['client', 'client'], ['architect', 'architect']] as Array<[Role, string]>) {
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
    let changed!: (pid: number) => void;
    const isChanged = new Promise<number>((r) => { changed = r; });
    // the racer becomes a client and the change is not yet committed. A role change away from an active role also
    // try-takes the project's readiness key, through the membership's holder guard trigger, so the naming may wait there
    // or on the membership row: either way, on THIS transaction
    const rerole = t.prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: ids.racer! } }, data: { role: 'client' } });
      changed(pid);
      await held;
    }, { timeout: 20_000 });
    const reroler = await isChanged;
    const naming = put('pmc', ids.racer!).then((r) => r);
    // released only once PostgreSQL shows a backend blocked BY the re-role's own backend, never after a guessed delay
    const waiting = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND ${reroler}::int = ANY(pg_blocking_pids(pid))`)[0]!.n > 0;
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

  it('a member who leaves and comes back is not named again until someone names them (real routes)', async () => {
    const asPmc = (req: request.Test) => req.set('Authorization', `Bearer ${tokens.pmc}`).set('Idempotency-Key', randomUUID());
    const email = `${f.projectA.id}-resp-returner@test.local`;
    expect((await asPmc(http().post(`/projects/${f.projectA.id}/members`)).send({ name: 'A returner', role: 'contractor', email })).status).toBe(201);
    const uid = (await t.prisma.user.findUniqueOrThrow({ where: { email } })).id;
    extra.push(uid);
    const shown = async () => (await listed('pmc', ids.pmc!)).filter((r) => r.inspectionId === inspectionId());
    const role = async (to: Role) => expect((await asPmc(http().patch(`/projects/${f.projectA.id}/members/${uid}`)).send({ role: to })).status).toBe(200);

    expect((await put('pmc', uid)).status).toBe(200);
    expect(await shown()).toEqual([{ inspectionId: inspectionId(), memberId: uid }]);
    // a move between the two named roles, while active, is not a break
    await role('consultant');
    expect(await shown()).toEqual([{ inspectionId: inspectionId(), memberId: uid }]);
    // and neither is a discipline edit, which keeps the role and writes no transition
    const transitions = await t.prisma.membershipTransition.count({ where: { projectId: f.projectA.id, userId: uid } });
    expect((await asPmc(http().patch(`/projects/${f.projectA.id}/members/${uid}`)).send({ role: 'consultant', discipline: 'mep' })).status).toBe(200);
    expect((await t.prisma.membership.findUniqueOrThrow({ where: { projectId_userId: { projectId: f.projectA.id, userId: uid } } })).discipline).toBe('mep');
    expect(await t.prisma.membershipTransition.count({ where: { projectId: f.projectA.id, userId: uid } })).toBe(transitions);
    expect(await shown()).toEqual([{ inspectionId: inspectionId(), memberId: uid }]);

    // removed, then added back: no one, and the stored name stays as the record
    expect((await asPmc(http().delete(`/projects/${f.projectA.id}/members/${uid}`))).status).toBe(200);
    expect(await shown()).toEqual([]);
    expect((await asPmc(http().post(`/projects/${f.projectA.id}/members`)).send({ name: 'A returner', role: 'consultant', email })).status).toBe(201);
    expect(await shown()).toEqual([]);
    expect(await stored()).toBe(uid);

    // named again, then re-roled out and back: no one again
    expect((await put('pmc', uid)).status).toBe(200);
    expect(await shown()).toEqual([{ inspectionId: inspectionId(), memberId: uid }]);
    await role('engineer');
    expect(await shown()).toEqual([]);
    await role('contractor');
    expect(await shown()).toEqual([]);

    // naming them once more holds, and clearing clears the mark with the name
    expect((await put('engineer', uid)).status).toBe(200);
    expect(await shown()).toEqual([{ inspectionId: inspectionId(), memberId: uid }]);
    expect((await put('pmc', null)).status).toBe(200);
    expect(await t.prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId() }, select: { responsibleMemberId: true, responsibleStandingMark: true } }))
      .toEqual({ responsibleMemberId: null, responsibleStandingMark: null });
  });

  it('an engineer names and sees on another engineer\'s assigned inspection, as placedInspections already shows it to them', async () => {
    const view = await t.app.get(SnapshotService).build(f.projectA.id, 'engineer', ids.engineer2!);
    expect(view.openChecklists.some((c) => c.id === assignedInspection())).toBe(false);
    expect(view.placedInspections.some((p) => p.id === assignedInspection())).toBe(true);
    expect((await put('engineer2', ids.contractor!, assignedInspection())).status).toBe(200);
    expect(await listed('engineer', ids.engineer2!)).toContainEqual({ inspectionId: assignedInspection(), memberId: ids.contractor });
    expect((await put('engineer2', null, assignedInspection())).status).toBe(200);
  });

  it('an engineer re-roled while naming: the naming waits on the caller\'s own standing and is refused (403), naming no one', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let changed!: (pid: number) => void;
    const isChanged = new Promise<number>((r) => { changed = r; });
    // engineer2 becomes a contractor and the change is not yet committed: the guard already read their token
    const rerole = t.prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: ids.engineer2! } }, data: { role: 'contractor' } });
      changed(pid);
      await held;
    }, { timeout: 20_000 });
    const reroler = await isChanged;
    const naming = put('engineer2', ids.contractor!).then((r) => r);
    const waiting = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND ${reroler}::int = ANY(pg_blocking_pids(pid))`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await waiting())) {
      if (Date.now() > deadline) { release(); await rerole; await naming; throw new Error('the naming never waited for the caller\'s re-role'); }
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await rerole;
    const res = await naming;
    expect(res.status).toBe(403);
    expect(await stored()).toBeNull();
  });

  // LAST: it leaves project A archived (the fixture's cleanup removes it)
  it('a project archived while naming: the naming waits on the project row and is refused (403), naming no one', async () => {
    const audits = () => t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'inspection.responsible' } });
    const before = await audits();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let changed!: (pid: number) => void;
    const isChanged = new Promise<number>((r) => { changed = r; });
    // an org admin's archive, not yet committed: it takes no readiness key, and the guard reads the project unarchived
    const archive = t.prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.project.update({ where: { id: f.projectA.id }, data: { archivedAt: new Date() } });
      changed(pid);
      await held;
    }, { timeout: 20_000 });
    const archiver = await isChanged;
    const naming = put('pmc', ids.contractor!).then((r) => r);
    const waiting = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND ${archiver}::int = ANY(pg_blocking_pids(pid))`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await waiting())) {
      if (Date.now() > deadline) { release(); await archive; await naming; throw new Error('the naming never waited for the archive'); }
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await archive;
    const res = await naming;
    expect(res.status).toBe(403);
    expect(await stored()).toBeNull();
    expect(await audits()).toBe(before);
  });
});
