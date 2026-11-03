import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { startFakeIssuer, type FakeIssuer } from '../unit-support/fake-issuer';
import { orgStandingLockKey } from '../../src/common/readiness-lock';
import { OPS_TOKEN_MIN_LENGTH } from '../../src/platform/ops/ops-token.guard';
import { RESEAT_NO_SUCCESSOR, RESEAT_NOT_OWNER, RESEAT_NOT_RETIRED, RESEAT_OWNER_CAN_ACT } from '../../src/orgs/operator-owner-reseat';

const ENV = ['IDENTITY_OIDC', 'IDENTITY_ISSUER', 'IDENTITY_ISSUER_ENDPOINT', 'IDENTITY_CLIENT_ID', 'IDENTITY_REDIRECT_URI', 'IDENTITY_SERVICE_TOKEN', 'THROTTLE_DISABLED', 'OPS_TOKEN'] as const;

/**
 * Redbracket ID A4c — the operator door's company owner re-seat (`POST /ops/orgs/:orgId/owner-reseat`). Every
 * established account's first Redbracket ID sign-in retires its old row, and the person's new account holds no seat;
 * once every owner of a company has signed in that way, no owner can act, so nobody can re-seat anyone. The operator
 * then puts back ONE of those owners: the new account made at that owner's retirement, and only while no owner of the
 * company can act. The retirements here are real (a first sign-in through the fake issuer), so the binding between a
 * retired row and its new account is the one production writes.
 *
 * Company B of the fixture holds no owner of its own; its two owners O1 and O2 are made here.
 */
describe('Redbracket ID A4c — operator owner re-seat (live PG, fake issuer)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: TwoProjectFixture[] = [];
  let fake: FakeIssuer;
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
  const made: string[] = [];
  const OPS = 'rbid-a4c-ops-token-0123456789abcdef';
  const body = (retiredUserId: string) => ({ operator: 'jagrutpatel@gmail.com', reason: 'A4c test: every owner retired', retiredUserId });

  beforeAll(async () => {
    for (const name of ENV) saved[name] = process.env[name];
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    fake = await startFakeIssuer({ redirectUri: 'http://127.0.0.1:1/cb' });
  });

  afterAll(async () => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (made.length) {
      await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: made } }, { actorUserId: { in: made } }] } });
      await t.prisma.orgMembership.deleteMany({ where: { userId: { in: made } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: made } } });
      await t.prisma.user.deleteMany({ where: { id: { in: made } } });
    }
    for (const x of extra) await x.cleanup();
    await f?.cleanup();
    await fake?.close();
    await t?.close();
  });

  beforeEach(() => {
    process.env.THROTTLE_DISABLED = 'true';
    process.env.OPS_TOKEN = OPS;
    process.env.IDENTITY_OIDC = '1';
    process.env.IDENTITY_ISSUER = fake.issuer;
    process.env.IDENTITY_ISSUER_ENDPOINT = fake.url;
    process.env.IDENTITY_CLIENT_ID = fake.clientId;
    process.env.IDENTITY_REDIRECT_URI = 'http://127.0.0.1:1/cb';
    process.env.IDENTITY_SERVICE_TOKEN = fake.serviceToken;
    fake.force = {};
  });

  const http = () => request(t.app.getHttpServer());
  const reseat = (orgId: string, retiredUserId: string) =>
    http().post(`/ops/orgs/${orgId}/owner-reseat`).set('Authorization', `Bearer ${OPS}`).send(body(retiredUserId));
  const ownersOf = async (orgId: string) =>
    (await t.prisma.orgMembership.findMany({ where: { orgId, role: 'owner' }, select: { userId: true }, orderBy: { userId: 'asc' } })).map((o) => o.userId);
  const trail = async () => t.prisma.auditLog.findMany({ where: { projectId: f.projectB.id, action: 'org.ownerReseated' } });

  /** An established PMC account (a password and a proved mailbox from before Redbracket ID), owner (or admin) of company B. */
  async function owner(label: string, role: 'owner' | 'admin' = 'owner', in_: TwoProjectFixture = f) {
    const email = `rbid-a4c-${label}-${Date.now()}@test.local`;
    const user = await t.prisma.user.create({
      data: { projectId: in_.projectB.id, role: 'pmc', name: label, email, passwordHash: await bcrypt.hash(`the ${label} local passphrase`, 4), emailVerifiedAt: new Date() },
    });
    made.push(user.id);
    await t.prisma.orgMembership.create({ data: { orgId: in_.orgB.id, userId: user.id, role } });
    fake.addPerson(email, `the ${label} redbracket passphrase`);
    return { id: user.id, email };
  }

  /** The person's first Redbracket ID sign-in: the old row is retired and a new linked account made, holding nothing. */
  async function firstSignIn(o: { id: string; email: string }, label: string) {
    const first = await http().post('/auth/login').send({ email: o.email, password: `the ${label} redbracket passphrase` });
    expect(first.status, first.text).toBe(401); // joins fresh, on no project yet
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: o.email } });
    made.push(fresh.id);
    expect(fresh.id).not.toBe(o.id);
    expect(await t.prisma.identityRetirement.count({ where: { userId: o.id } })).toBe(1);
    return fresh.id;
  }

  let o1: { id: string; email: string };
  let o2: { id: string; email: string };
  let s1 = '';
  let s2 = '';

  it('while an owner can still sign in, the operator seats nobody (409), and nothing is written', async () => {
    o1 = await owner('o1');
    o2 = await owner('o2');
    s1 = await firstSignIn(o1, 'o1');
    const r = await reseat(f.orgB.id, o1.id);
    expect([r.status, r.body.message]).toEqual([409, RESEAT_OWNER_CAN_ACT]);
    expect(await ownersOf(f.orgB.id)).toEqual([o1.id, o2.id].sort());
    expect(await trail()).toHaveLength(0);
  });

  it('refuses what is not a retired owner of this company, or no company, and the door stays shut without its token', async () => {
    s2 = await firstSignIn(o2, 'o2');
    // a live account
    expect([(await reseat(f.orgB.id, f.otherUser.id)).status, (await reseat(f.orgB.id, f.otherUser.id)).body.message]).toEqual([400, RESEAT_NOT_RETIRED]);
    // a retired owner of company B, named against company A (where it holds nothing)
    const a = await reseat(f.orgA.id, o1.id);
    expect([a.status, a.body.message]).toEqual([400, RESEAT_NOT_OWNER]);
    // a retired ADMIN of company B: the operator puts back owners only (the restored owner re-seats admins)
    const admin = await owner('a1', 'admin');
    await firstSignIn(admin, 'a1');
    const notOwner = await reseat(f.orgB.id, admin.id);
    expect([notOwner.status, notOwner.body.message]).toEqual([400, RESEAT_NOT_OWNER]);
    expect((await reseat('no-such-company', o1.id)).status).toBe(404);
    expect((await http().post(`/ops/orgs/${f.orgB.id}/owner-reseat`).send(body(o1.id))).status).toBe(401);
    // and closed (404, as a path the server does not have) with no OPS_TOKEN, or one shorter than the minimum
    delete process.env.OPS_TOKEN;
    expect((await http().post(`/ops/orgs/${f.orgB.id}/owner-reseat`).set('Authorization', `Bearer ${OPS}`).send(body(o1.id))).status).toBe(404);
    const short = 'x'.repeat(OPS_TOKEN_MIN_LENGTH - 1);
    process.env.OPS_TOKEN = short;
    expect((await http().post(`/ops/orgs/${f.orgB.id}/owner-reseat`).set('Authorization', `Bearer ${short}`).send(body(o1.id))).status).toBe(404);
    process.env.OPS_TOKEN = OPS;
    expect((await http().post(`/ops/orgs/${f.orgB.id}/owner-reseat`).set('Authorization', `Bearer ${OPS}x`).send(body(o1.id))).status).toBe(401);
    const bad = await http().post(`/ops/orgs/${f.orgB.id}/owner-reseat`).set('Authorization', `Bearer ${OPS}`).send({ operator: 'op', reason: 'why' });
    expect(bad.status).toBe(400);
    expect(await ownersOf(f.orgB.id)).toEqual([o1.id, o2.id].sort());
  });

  it('every owner retired: two operator calls at once seat exactly one owner; the other is refused because that owner can now act', async () => {
    // barrier: hold company B's org key, let both calls queue behind it, and release only once both are waiting on it,
    // so the two calls are certainly concurrent (they wait on the key every owner writer takes first)
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('${orgStandingLockKey(f.orgB.id)}', 0))`);
      held();
      await gate;
    }, { timeout: 60_000 });
    await holding;
    const calls = [reseat(f.orgB.id, o1.id).then((r) => r), reseat(f.orgB.id, o2.id).then((r) => r)];
    const waiting = async () =>
      Number((await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      ))[0]!.n);
    let queued = 0;
    for (let i = 0; i < 400 && queued < 2; i++) {
      queued = await waiting();
      if (queued < 2) await new Promise((resolve) => setImmediate(resolve));
    }
    expect(queued).toBe(2);
    release();
    await holder;
    const [x, y] = await Promise.all(calls);
    const answers = [x, y].map((r) => [r.status, r.body.changed ?? r.body.message]);
    expect(answers).toEqual(expect.arrayContaining([[200, true], [409, RESEAT_OWNER_CAN_ACT]]));
    const won = x.status === 200 ? x : y;
    const seated = won.body.userId as string;
    expect([s1, s2]).toContain(seated);
    // the retired seats stay for the restored owner to remove through the team commands
    expect(await ownersOf(f.orgB.id)).toEqual([o1.id, o2.id, seated].sort());
    // the derived standing follows the grant: company authority, and PMC standing on the company's project
    expect(await t.prisma.orgUserAuthority.count({ where: { orgId: f.orgB.id, userId: seated } })).toBe(1);
    expect(await t.prisma.projectUserStanding.count({ where: { projectId: f.projectB.id, userId: seated, role: 'pmc' } })).toBe(1);
    // audited on the project's trail and on the person's security trail
    const rows = await trail();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'Org', entityId: f.orgB.id });
    expect(rows[0]!.payload).toMatchObject({ reason: 'A4c test: every owner retired', via: 'ops-api', userId: seated });
    const security = await t.prisma.securityAuditEvent.findMany({ where: { targetUserId: seated, action: 'auth.operator_owner_reseat' } });
    expect(security).toHaveLength(1);
    expect(security[0]).toMatchObject({ actorKind: 'operator', actorUserId: null });
    expect(security[0]!.payload).toMatchObject({ orgId: f.orgB.id, operator: 'jagrutpatel@gmail.com', via: 'ops-api' });

    // a repeat for the same person changes nothing and writes nothing
    const again = await reseat(f.orgB.id, seated === s1 ? o1.id : o2.id);
    expect([again.status, again.body.changed, again.body.userId]).toEqual([200, false, seated]);
    expect(await trail()).toHaveLength(1);

    // the restored owner signs in, and lands as the company's PMC on its project
    const label = seated === s1 ? 'o1' : 'o2';
    const email = seated === s1 ? o1.email : o2.email;
    const ok = await http().post('/auth/login').send({ email, password: `the ${label} redbracket passphrase` });
    expect(ok.status, ok.text).toBe(201);
    expect((t.app.get(JwtService).verify(ok.body.token) as { sub: string }).sub).toBe(seated);
  });

  it('the account must be the one made at that retirement: a later account at the freed address, or one that moved off it, is refused', async () => {
    // a third retired owner of B, whose address a later invitation now holds (not linked, not made at the retirement)
    const o3 = await owner('o3');
    const s3 = await firstSignIn(o3, 'o3');
    await t.prisma.user.update({ where: { id: s3 }, data: { email: `${o3.email}.moved` } });
    // the made-at-retirement account no longer holds the address: refused
    const moved = await reseat(f.orgB.id, o3.id);
    expect([moved.status, moved.body.message]).toEqual([409, RESEAT_NO_SUCCESSOR]);
    const later = await t.prisma.user.create({ data: { projectId: f.projectB.id, role: 'pmc', name: 'later invitee', email: o3.email } });
    made.push(later.id);
    // a later account at the freed address is not the person's: refused, before any owner count
    const stranger = await reseat(f.orgB.id, o3.id);
    expect([stranger.status, stranger.body.message]).toEqual([409, RESEAT_NO_SUCCESSOR]);
    expect(await t.prisma.orgMembership.count({ where: { orgId: f.orgB.id, userId: { in: [later.id, s3] } } })).toBe(0);
  });

  it('a new account already seated as company ADMIN is promoted to owner, and its authority and standing follow', async () => {
    const g = await createTwoProjectFixture(t.prisma);
    extra.push(g);
    const o = await owner('p1o', 'owner', g);
    const s = await firstSignIn(o, 'p1o');
    // seated as admin before the company's last owner signed in (an earlier re-seat that stopped at admin)
    await t.prisma.orgMembership.create({ data: { orgId: g.orgB.id, userId: s, role: 'admin' } });
    const r = await reseat(g.orgB.id, o.id);
    expect([r.status, r.body.changed, r.body.userId]).toEqual([200, true, s]);
    expect((await t.prisma.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId: g.orgB.id, userId: s } } })).role).toBe('owner');
    expect(await t.prisma.orgUserAuthority.findMany({ where: { orgId: g.orgB.id, userId: s }, select: { role: true } })).toEqual([{ role: 'owner' }]);
    expect(await t.prisma.projectUserStanding.count({ where: { projectId: g.projectB.id, userId: s, role: 'pmc' } })).toBe(1);
  });

  it('a company with no live project gets one company-level audit row', async () => {
    const g = await createTwoProjectFixture(t.prisma);
    extra.push(g);
    const o = await owner('p2o', 'owner', g);
    await firstSignIn(o, 'p2o');
    await t.prisma.project.update({ where: { id: g.projectB.id }, data: { archivedAt: new Date() } });
    const r = await reseat(g.orgB.id, o.id);
    expect([r.status, r.body.changed]).toEqual([200, true]);
    const rows = await t.prisma.auditLog.findMany({ where: { action: 'org.ownerReseated', entityId: g.orgB.id } });
    expect(rows.map((row) => row.projectId)).toEqual([null]);
    await t.prisma.auditLog.deleteMany({ where: { action: 'org.ownerReseated', entityId: g.orgB.id, projectId: null } });
  });
});
