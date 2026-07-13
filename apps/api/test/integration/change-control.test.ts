import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 Task 2 — decision change-control against live PostgreSQL.
 * The contract: approval locks with REAL attribution; a change request reopens
 * the lock with exactly ONE open ChangeRequest (database-enforced); only the
 * client's re-approval (resolution 'reapproved') or a withdraw (by the requester
 * or PMC) closes it; every transition is a CAS committed with its events, so a
 * concurrent loser gets a deterministic 409.
 */
describe('decision change-control (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;
  let clientToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc, name 'member'
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer'); // name 'owner'
    clientToken = t.issueProjectToken(f.strangerUser.id, f.projectA.id, 'client'); // name 'stranger'
  });

  beforeAll(async () => {
    // the engineer/client tokens above belong to users without an A membership —
    // grant them one so live authorization admits them in their token role
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: f.strangerUser.id, role: 'client', status: 'active' } });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.$transaction([
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decision.deleteMany({ where: { projectId } }),
    ]);
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);

  const decisionInput = (title: string) => ({
    title,
    room: 'Kitchen',
    options: [
      { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
      { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
    ],
    publish: true,
  });

  async function issueDecision(title: string): Promise<string> {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions`, decisionInput(title))).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    return d.id;
  }

  /** Test-only barrier on the decision pre-read (same device as phase1-baseline). */
  function barrierOn(decisionId: string) {
    const delegate = t.prisma.decision as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
    const original = delegate.findUnique.bind(t.prisma.decision);
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    delegate.findUnique = async (args: { where: { id?: string } }) => {
      const row = await original(args);
      if (args?.where?.id === decisionId) {
        reads += 1;
        if (reads === 2) release();
        await both;
      }
      return row;
    };
    return { restore: () => { delegate.findUnique = original; }, reads: () => reads };
  }

  it('the full loop: approve with REAL attribution -> change opens ONE request -> re-approval resolves it', async () => {
    const id = await issueDecision('Counter top');

    // the CLIENT approves — the recorded approver is their real identity
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    let d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.approver).toBe('stranger'); // the fixture user's real name, not 'Mr. Shah'
    expect(d.approvedById).toBe(f.strangerUser.id);
    expect(d.onBehalfOf).toBeNull();

    // locked
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 1 })).status).toBe(409);

    // the engineer raises a change request → decision reopens, ONE open request with requester identity
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'Slab cracked', costImpact: 5000, timeImpactDays: 2 })).status).toBe(201);
    d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('change');
    const open = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: id, status: 'open' } });
    expect(open.requestedById).toBe(f.ownerUser.id);

    // a second request while one is open is refused
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'again', costImpact: 0, timeImpactDays: 0 })).status).toBe(409);

    // the client re-approves → decision locks again AND the request is RESOLVED with resolver identity
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 1 })).status).toBe(201);
    d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('approved');
    const resolved = await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: open.id } });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('reapproved');
    expect(resolved.resolvedById).toBe(f.strangerUser.id);
    expect(resolved.resolvedAt).not.toBeNull();

    // the lifecycle history carries real identity on every transition
    const events = await t.prisma.decisionEvent.findMany({ where: { decisionId: id }, orderBy: { at: 'asc' } });
    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['issued', 'approved', 'change_requested', 'reapproved']));
    for (const e of events) expect(e.actorId).not.toBeNull();
  });

  it('PMC approval on the client\'s behalf is recorded as such, never disguised', async () => {
    const id = await issueDecision('Wardrobe shutters');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.approver).toBe('member'); // the PMC's real name
    expect(d.approvedById).toBe(f.memberUser.id);
    expect(d.onBehalfOf).toBe('client');
  });

  it('withdraw: the requester restores the lock; a third party cannot; the request records the withdrawal', async () => {
    const id = await issueDecision('Balcony rail');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'wrong finish', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);

    // the CLIENT is neither the requester nor the PMC → forbidden
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/change/withdraw`)).status).toBe(403);

    // the REQUESTER withdraws → decision returns to approved, request closed as withdrawn
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change/withdraw`)).status).toBe(201);
    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('approved');
    const cr = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: id } });
    expect(cr.status).toBe('withdrawn');
    expect(cr.resolution).toBe('withdrawn');
    expect(cr.resolvedById).toBe(f.ownerUser.id);

    // nothing left to withdraw
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions/${id}/change/withdraw`)).status).toBe(409);
    const withdrawnEvent = await t.prisma.decisionEvent.findFirst({ where: { decisionId: id, type: 'change_withdrawn' } });
    expect(withdrawnEvent?.actorId).toBe(f.ownerUser.id);
  });

  it('cross-project: a change request against another project\'s decision is refused', async () => {
    const id = await issueDecision('Fascia board');
    const otherToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    const res = await as(otherToken)(`/projects/${f.projectB.id}/decisions/${id}/change`, { reason: 'x', costImpact: 0, timeImpactDays: 0 });
    expect(res.status).toBe(404); // the decision does not exist in project B
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id } })).toBe(0);
  });

  it('CONCURRENCY: two simultaneous change requests -> one winner, one 409, ONE row + ONE event', async () => {
    const id = await issueDecision('Terrace tiles');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);

    const b = barrierOn(id);
    try {
      const [r1, r2] = await Promise.all([
        as(pmcToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'racer one', costImpact: 0, timeImpactDays: 0 }),
        as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'racer two', costImpact: 0, timeImpactDays: 0 }),
      ]);
      expect(b.reads()).toBe(2); // both passed the pre-read on the same approved row
      expect([r1.status, r2.status].sort()).toEqual([201, 409]); // deterministic single winner
    } finally {
      b.restore();
    }
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id } })).toBe(1);
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'change_requested' } })).toBe(1);
  });

  it('CONCURRENCY: two simultaneous re-approvals -> one winner; the request is resolved exactly once', async () => {
    const id = await issueDecision('Study desk');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'r', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);

    const b = barrierOn(id);
    try {
      const [r1, r2] = await Promise.all([
        as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 }),
        as(pmcToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 1 }),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    } finally {
      b.restore();
    }
    const crs = await t.prisma.changeRequest.findMany({ where: { decisionId: id } });
    expect(crs).toHaveLength(1);
    expect(crs[0].status).toBe('resolved');
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'reapproved' } })).toBe(1);
  });

  it('CONCURRENCY: approve-vs-withdraw race -> exactly one outcome and one resolution', async () => {
    const id = await issueDecision('Porch light');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'r', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);

    const b = barrierOn(id);
    try {
      const [r1, r2] = await Promise.all([
        as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 }),
        as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change/withdraw`),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]); // one winner, either way
    } finally {
      b.restore();
    }
    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('approved'); // both paths end locked — but only ONE transition happened
    const cr = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: id } });
    expect(['resolved', 'withdrawn']).toContain(cr.status);
    expect(cr.resolvedById).not.toBeNull();
    const resolutions = await t.prisma.decisionEvent.count({ where: { decisionId: id, type: { in: ['reapproved', 'change_withdrawn'] } } });
    expect(resolutions).toBe(1);
  });

  it('GATE FINDING 1: a change decision with NO open request cannot be re-approved — 409, state unchanged', async () => {
    const id = await issueDecision('Pooja unit');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'shelf depth', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);

    // the legacy inconsistency the deployed backfill permits: the open request was
    // resolved out-of-band while the decision stayed 'change' (zero open requests)
    await t.prisma.changeRequest.updateMany({ where: { decisionId: id, status: 'open' }, data: { status: 'resolved', resolution: null } });

    // re-approval must REFUSE — there is nothing to resolve, so 'reapproved' would lie
    const res = await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 });
    expect(res.status).toBe(409);
    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('change'); // the whole transaction rolled back
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'reapproved' } })).toBe(0);
  });

  it('GATE FINDING 6: events and audits snapshot the actor ROLE held at action time', async () => {
    const id = await issueDecision('Loft ladder');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'headroom', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change/withdraw`)).status).toBe(201);

    const events = await t.prisma.decisionEvent.findMany({ where: { decisionId: id } });
    const roleOf = (type: string) => events.find((e) => e.type === type)?.actorRole;
    expect(roleOf('issued')).toBe('pmc');
    expect(roleOf('approved')).toBe('client');
    expect(roleOf('change_requested')).toBe('engineer');
    expect(roleOf('change_withdrawn')).toBe('engineer');

    const audits = await t.prisma.auditLog.findMany({ where: { entity: 'Decision', entityId: id } });
    expect(audits.find((a) => a.action === 'decision.approve')?.actorRole).toBe('client');
    expect(audits.find((a) => a.action === 'decision.change')?.actorRole).toBe('engineer');
    expect(audits.find((a) => a.action === 'decision.change_withdraw')?.actorRole).toBe('engineer');
  });

  it('GATE FINDING 7: an on-behalf approval is ANNOUNCED as on-behalf; a direct client approval as the client\'s', async () => {
    // direct client approval → the classic announcement
    const direct = await issueDecision('Basin mixer');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${direct}/approve`, { optionIndex: 0 })).status).toBe(201);
    const directNotice = await t.prisma.notification.findFirstOrThrow({
      where: { projectId: f.projectA.id, AND: [{ text: { contains: 'Basin mixer' } }, { text: { contains: 'approved' } }] },
    });
    expect(directNotice.text).toMatch(/^Client approved Basin mixer/);

    // PMC approving on behalf → the announcement NAMES who exercised the authority
    const behalf = await issueDecision('Vanity light');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions/${behalf}/approve`, { optionIndex: 0 })).status).toBe(201);
    const behalfNotice = await t.prisma.notification.findFirstOrThrow({
      where: { projectId: f.projectA.id, AND: [{ text: { contains: 'Vanity light' } }, { text: { contains: 'approved' } }] },
    });
    expect(behalfNotice.text).toMatch(/^member \(PMC\) approved Vanity light on behalf of the client/);
    expect(behalfNotice.text).not.toMatch(/^Client approved/); // never disguised
  });

  it('the DATABASE refuses a duplicate open request even on a direct insert', async () => {
    const id = await issueDecision('Gate motor');
    expect((await as(clientToken)(`/projects/${f.projectA.id}/decisions/${id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/decisions/${id}/change`, { reason: 'r', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);
    await expect(
      t.prisma.changeRequest.create({ data: { decisionId: id, reason: 'forged duplicate', costImpact: 0, timeImpactDays: 0 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
