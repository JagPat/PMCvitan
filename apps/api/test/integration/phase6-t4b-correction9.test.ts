import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-9 CORRECTION (Codex, three findings on `92868d7`).
 *
 * Two P1 and one P2. Every probe here was RED at `92868d7` with the corresponding half reverted.
 *
 * **Classification: 3 of 3 SELF-INFLICTED, 0 SEAM — the third consecutive mostly-(b) round**
 * (round 7: 3/3, round 8: ~2/3, round 9: 3/3). Each is a defect an earlier correction in THIS PR
 * introduced:
 *
 *   - R9-1 is ROUND 8's own fix. It required an `approved`/`reapproved` `DecisionEvent` as proof
 *     an approval happened — and nothing stopped that event being INSERTED while the parent sat in
 *     `change`. The idea was right; the proof was forgeable.
 *   - R9-2 is ROUND 7's guard. Making every active membership insert pass the non-blocking
 *     readiness check broke a path that never took the key — self-signup — in the worst possible
 *     way: the `User` committed, the membership did not, and the retry then SKIPPED provisioning.
 *   - R9-3 is the ROUND-6/8 `activates` guard. Narrowing it to activation left the role-CHANGE
 *     half of the same upsert with no check at all, so the seal answered with a 500 where
 *     `updateRole` answers with a 409.
 *
 * Rounds 7-9 found ZERO seam defects: the 4b-i/4b-ii cut is sound, and the churn is re-cutting
 * inside it. That is why the recommendation in the convergence audit is that 4b-ii carry the
 * audience and visibility OVER this seal network rather than extend it.
 */
describe('Phase 6 unit 4b-i round 9 — the three Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let members: MembersService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    members = t.app.get(MembersService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.commandExecution.deleteMany({ where: { projectId: f.projectA.id } });
    for (const [userId, role] of [[f.memberUser.id, 'pmc'], [f.clientUser.id, 'client']] as const) {
      if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId } }))) {
        await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId, role, status: 'active' } });
      } else {
        await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId }, data: { role, status: 'active' } });
      }
    }
  });

  const seedPublished = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `DL-t4bc9-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Draft ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null, ...over,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  // ── R9-1 (P1) — round 8's proof was forgeable ────────────────────────────────────────────────
  it('R9-1: an approval EVENT written AFTER the change request is not restoration proof, so the exemption cannot be borrowed', async () => {
    // The forgery `92868d7` admitted: a published `change` row with the approval columns planted
    // and a null holder tuple. Round 8 asked for an `approved` DecisionEvent as proof — so the
    // forger simply wrote one, and `v_restores` then permanently excused the unattributed approval.
    const forged = `DL-t4bc9-${run}-forged-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id: forged, projectId: f.projectA.id, title: 'Planted evidence', room: 'Kitchen',
        status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        publishedAt: null, approvedOption: 'A', material: 'Teak', approver: 'Nobody',
        approvedById: f.clientUser.id, date: '01 Jan 2026',
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: forged, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: forged, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id: forged }, data: { publishedAt: new Date() } });
    await t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status"='change' WHERE "id" = $1`, forged);

    // THE PROBE: the planted event is ALLOWED to exist — 4a's seals depend on that shape being
    // representable — but it cannot serve as restoration proof, because it was written AFTER the
    // change request it claims to predate.
    await t.prisma.changeRequest.create({
      data: {
        decisionId: forged, status: 'open', requestedById: f.clientUser.id,
        reason: 'planted so the forged event can claim to predate it', costImpact: 0, timeImpactDays: 0,
      },
    });
    await t.prisma.decisionEvent.create({
      data: { decisionId: forged, type: 'approved', actor: 'Nobody', actorId: f.clientUser.id },
    });

    // …so the exemption cannot be borrowed, and the tuple demand still bites.
    await expect(
      t.prisma.decision.update({ where: { id: forged }, data: { status: 'approved' } }),
    ).rejects.toThrow(/records WHO approved it/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: forged } })).status).toBe('change');

    // PRECISION — the ordinary approval path is untouched, and this is the arm that makes the
    // rule RIGHT rather than merely strict. Attempt 1 forbade the event outright and broke 4a,
    // phase-3 legacy reapproval and the upgrade proof, because a non-approved decision CARRYING an
    // approval event is exactly the shape 4a's seals exist to refuse. Ordering leaves every one of
    // those shapes representable and only denies the forgery its PROOF.
    const real = await seedPublished();
    await svc.approve(f.projectA.id, real, { optionIndex: 0 } as never,
      { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: real } })).status).toBe('approved');
    expect(await t.prisma.decisionEvent.count({
      where: { decisionId: real, type: { in: ['approved', 'reapproved'] } },
    })).toBeGreaterThan(0);
  });

  // ── R9-2 (P1) — round 7's guard poisoned the signup path ─────────────────────────────────────
  it('R9-2: self-signup WAITS for the readiness key instead of failing half-provisioned', async () => {
    // The defect was not that provisioning could fail — it is that it failed HALFWAY. Round 7 made
    // every active membership insert pass a NON-BLOCKING readiness guard that REFUSES under
    // contention; the `User` had already committed by then, so the retry FOUND that identity,
    // skipped provisioning, and `signInAccess` rejected it forever.
    //
    // So the probe holds the key and drives the real path. At `92868d7` the membership insert
    // raised immediately and left a User with no membership. Now it WAITS, and commits both.
    const { AuthService } = await import('../../src/auth/auth.service');
    const auth = t.app.get(AuthService);
    const sms = t.app.get<{ verifyOtp: (p: string, c: string) => Promise<boolean> }>(
      (await import('../../src/auth/sms.service')).SmsService as never,
    );
    const originalVerify = sms.verifyOtp.bind(sms);
    sms.verifyOtp = async () => true;
    const prevFlag = process.env.AUTH_ALLOW_PHONE_SIGNUP;
    process.env.AUTH_ALLOW_PHONE_SIGNUP = 'true';
    const phone = `+9199${String(Date.now()).slice(-8)}`;

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const holdingNow = new Promise<void>((r) => { holding = r; });
    // hold the project's readiness key in a separate transaction
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended('readiness:' || $1::text, 0))`, f.projectA.id,
      );
      holding();
      await held;
    }, { timeout: 30_000 });
    await holdingNow;

    try {
      let settled: 'pending' | 'ok' | 'error' = 'pending';
      const signup = auth.verifyOtp({ phone, code: '000000', projectId: f.projectA.id } as never)
        .then(() => { settled = 'ok'; }, () => { settled = 'error'; });

      // it must NOT resolve while the key is held — waiting is the fix
      await new Promise((r) => setTimeout(r, 700));
      expect(settled, 'signup must WAIT for the readiness key, not refuse').toBe('pending');
      // …and nothing may be left behind while it waits
      expect(await t.prisma.user.count({ where: { phone } })).toBe(0);

      release();
      await holder;
      await signup;
      expect(settled).toBe('ok');

      // atomic: the identity exists WITH its active membership
      const created = await t.prisma.user.findFirstOrThrow({ where: { phone } });
      const membership = await t.prisma.membership.findUnique({
        where: { projectId_userId: { projectId: f.projectA.id, userId: created.id } },
      });
      expect(membership?.status).toBe('active');
      await t.prisma.membership.deleteMany({ where: { userId: created.id } });
      await t.prisma.user.delete({ where: { id: created.id } });
    } finally {
      sms.verifyOtp = originalVerify;
      if (prevFlag === undefined) delete process.env.AUTH_ALLOW_PHONE_SIGNUP;
      else process.env.AUTH_ALLOW_PHONE_SIGNUP = prevFlag;
    }
  });

  // ── R9-3 (P2) — the role-CHANGE half of the same upsert ──────────────────────────────────────
  it('R9-3: `members.add` refuses a role change that strands an open decision with the SAME 409 `updateRole` gives', async () => {
    // Re-adding the sole active client as a contractor while a published client-held decision is
    // open. `Membership_t4b_holder_seal` correctly refuses the write either way — the finding is
    // that `add` reached it with no check, so the refusal arrived as a raw 500 instead of an
    // answer, while `updateRole` answered properly for the identical write.
    const id = await seedPublished();
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');

    await expect(
      members.add(f.projectA.id, pmc(), { email: f.clientUser.email!, name: f.clientUser.name ?? 'Client', role: 'contractor' } as never),
    ).rejects.toMatchObject({ status: 409 });

    // the client is untouched — a refusal that half-applied would be worse than the 500 it replaced
    const still = await t.prisma.membership.findUniqueOrThrow({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.clientUser.id } },
    });
    expect(still.role).toBe('client');
    expect(still.status).toBe('active');
  });
});
