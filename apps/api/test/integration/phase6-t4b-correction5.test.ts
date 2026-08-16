import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { OrgsService } from '../../src/orgs/orgs.service';
import { MembersService } from '../../src/orgs/members.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { createDecisionSchema } from '../../src/contracts';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-5 CORRECTION (Codex, six findings on head `cc00c94`).
 *
 * Three P1 and three P2. Every probe here was RED at `cc00c94` with `20270820000000` AND the
 * service half of its finding reverted.
 *
 * Round 5 is where the owner's scope decision lands too. Two of the P1s (R5-1, R5-2) say the same
 * thing about the 4b-i/4b-ii split: a fact half that ships the `recorded` status and the `pmc`/
 * `member` decider kinds WITHOUT the audience that routes them leaves the product actively wrong,
 * not merely incomplete. The instruction was "gate the surface, keep the facts" — so the facts,
 * seals and lifecycle stay exactly as reviewed, and the two surfaces that would misroute are
 * CLOSED until 4b-ii opens them honestly. A refusal that names its reason is a smaller lie than a
 * push sent to the wrong party.
 */
describe('Phase 6 unit 4b-i round 5 — the six Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let orgs: OrgsService;
  let members: MembersService;
  let activities: ActivitiesService;
  let seq = 0;
  let raceDb: PrismaClient;
  // ids are unique PER RUN: a suite whose own cleanup is interrupted must not poison the next run
  // with rows that collide on the primary key (the `Decision` id is global, unlike the fixture's
  // per-run project ids)
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;
  /** a caller `canManage` admits by token role — deliberately NOT the removal target */
  const manager = (): AuthUser => ({ sub: f.clientUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    orgs = t.app.get(OrgsService);
    members = t.app.get(MembersService);
    activities = t.app.get(ActivitiesService);
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    // R5-1 links real work to a decision, and the activity's FK outlives the decision — so the
    // activities go first or the wipe below cannot complete
    await t.prisma.activity.deleteMany({ where: { projectId: f.projectA.id } });
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.commandExecution.deleteMany({ where: { projectId: f.projectA.id } });
    // the fixture roster is restored UNCONDITIONALLY — a failing probe must not strand the next
    // one with its setup (round 3's RED pass taught this the hard way)
    for (const [userId, role] of [[f.memberUser.id, 'pmc'], [f.clientUser.id, 'client']] as const) {
      if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId } }))) {
        await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId, role, status: 'active' } });
      } else {
        await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId }, data: { role, status: 'active' } });
      }
    }
    // …and so is the ORG roster: exactly one owner (`ownerUser`), nobody else
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: { notIn: [f.ownerUser.id] } } });
    if (!(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } }))) {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.ownerUser.id, role: 'owner' } });
    } else {
      await t.prisma.orgMembership.updateMany({ where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'owner' } });
    }
  });

  /** An UNPUBLISHED ordinary draft with two options. */
  const seedDraft = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `DL-t4bc5-${run}-${seq++}`;
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
    return id;
  };

  /** A PUBLISHED recorded issue — the terminal, approvable-by-nobody register entry. */
  const seedRecord = async (): Promise<string> => {
    const id = `DL-t4bc5-${run}-rec-${seq++}`;
    // the recorded-insert seal try-acquires the readiness key, so the fixture holds it too
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `readiness:${f.projectA.id}`);
      await tx.decision.create({
        data: {
          id, projectId: f.projectA.id, title: `Record ${id}`, room: 'Kitchen', status: 'recorded',
          ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: new Date(),
          deciderKind: 'none',
        },
      });
    });
    return id;
  };

  // ── R5-1 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R5-1: a RECORDED issue is not linkable work — it has no approval to wait for', async () => {
    const rec = await seedRecord();

    // At `cc00c94` `linkableInProject` returned 'linkable' for a record, the write paths accepted
    // it, and `deriveDecisionReading` then parked the activity at `wait / Awaiting the client's
    // approval` — for a decision nobody can ever approve.
    const plan = (name: string, decisionId: string) =>
      ({ name, zone: '', plannedStart: 0, plannedEnd: 1, decisionId }) as never;
    await expect(activities.create(f.projectA.id, plan('Work pinned to a record', rec), pmc()))
      .rejects.toThrow(/no approval to wait for/);

    // the WITHDRAWN refusal is untouched — precision, not a widened net
    const w = await seedDraft();
    await t.prisma.decision.update({ where: { id: w }, data: { publishedAt: new Date() } });
    await t.prisma.$executeRaw`
      UPDATE "Decision"
         SET "status"='withdrawn', "withdrawnAt"=NOW(), "withdrawnById"=${f.memberUser.id},
             "withdrawnByName"='PMC', "withdrawReason"='Superseded on site'
       WHERE "id" = ${w}`;
    await expect(activities.create(f.projectA.id, plan('Pinned to a withdrawal', w), pmc()))
      .rejects.toThrow(/was withdrawn/);

    // …and an ORDINARY published decision still links
    const live = await seedDraft();
    await t.prisma.decision.update({ where: { id: live }, data: { publishedAt: new Date() } });
    await expect(activities.create(f.projectA.id, plan('Pinned to live work', live), pmc()))
      .resolves.toBeDefined();
  });

  // ── R5-2 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R5-2: the decider SURFACE is closed until its audience ships — a pmc/member designation is refused, and says why', async () => {
    // The owner's scope decision, enforced at the contract. 4b-i ships the FACTS: the column, the
    // enum, the seals, the approval route that admits a named holder. What it does NOT ship is the
    // audience that routes the pending push and the visibility that shows the row to its holder —
    // that is 4b-ii. Accepting the designation without them would notify the client about a
    // decision the client does not hold and hide it from the person who does.
    const base = {
      title: 'Held by someone else', room: 'Kitchen', publish: true,
      options: [
        { material: 'Teak', delta: 0, swatch: 'sw1', recommended: true },
        { material: 'Oak', delta: 100, swatch: 'sw2', recommended: false },
      ],
    };
    for (const kind of ['pmc', 'member'] as const) {
      const parsed = createDecisionSchema.safeParse({ ...base, deciderKind: kind, deciderMembershipId: 'm-1' });
      expect(parsed.success, `${kind} must be refused at the contract`).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toMatch(/decider audience \(unit 4b-ii\)/);
    }
    // …and the two kinds 4b-i DOES serve are untouched
    expect(createDecisionSchema.safeParse({ ...base, deciderKind: 'client' }).success).toBe(true);
    expect(createDecisionSchema.safeParse({ ...base, deciderKind: 'none', options: [] }).success).toBe(true);
    // the DEFAULT is unchanged, so every existing caller is byte-for-byte the same request
    expect(createDecisionSchema.parse(base).deciderKind).toBe('client');
  });

  // ── R5-3 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R5-3: the frozen approval LABEL is complete, non-blank, and renders the designated holder', async () => {
    const holder = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });

    // (a) the transition writes a kind and NO label — at `cc00c94` this passed, and the write-once
    // arm then made the hole permanent
    const a = await seedDraft();
    await expect(
      t.prisma.decision.update({ where: { id: a }, data: { status: 'approved', approvedDeciderKind: 'client' } }),
    ).rejects.toThrow(/WHOLE holder tuple or none of it/);

    // (b) a BLANK label is a hole that renders as nothing
    const b = await seedDraft();
    await expect(
      t.prisma.decision.update({
        where: { id: b },
        data: { status: 'approved', approvedDeciderKind: 'client', approvedDeciderLabel: '   ' },
      }),
    ).rejects.toThrow(/WHOLE holder tuple or none of it/);

    // (c) a FABRICATED label with the right kind — the finding's exact shape
    const c = await seedDraft();
    await expect(
      t.prisma.decision.update({
        where: { id: c },
        data: { status: 'approved', approvedDeciderKind: 'client', approvedDeciderLabel: 'Someone Else' },
      }),
    ).rejects.toThrow(/must render the designated holder/);

    // (d) the same rule at the INSERT door — the two doors reach the same permanent state
    await expect(
      t.prisma.decision.create({
        data: {
          id: `DL-t4bc5-${run}-born-${seq++}`, projectId: f.projectA.id, title: 'Born mislabelled', room: 'K',
          status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
          approvedDeciderKind: 'client', approvedDeciderLabel: 'Someone Else',
        },
      }),
    ).rejects.toThrow(/must render the designated holder/);

    // (e) a MEMBER-held approval renders the PERSON, from the orgs-owned identity
    const e = await seedDraft({ deciderKind: 'member', deciderMembershipId: holder.id });
    await expect(
      t.prisma.decision.update({
        where: { id: e },
        data: {
          status: 'approved', approvedDeciderKind: 'member',
          approvedDeciderMembershipId: holder.id, approvedDeciderLabel: 'Client',
        },
      }),
    ).rejects.toThrow(/must render the designated holder/);
    const person = await t.prisma.user.findUniqueOrThrow({ where: { id: f.clientUser.id } });
    await t.prisma.decision.update({
      where: { id: e },
      data: {
        status: 'approved', approvedDeciderKind: 'member',
        approvedDeciderMembershipId: holder.id, approvedDeciderLabel: person.name,
      },
    });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: e } })).approvedDeciderLabel).toBe(person.name);

    // (f) PRECISION — a TUPLELESS approval transition is still permitted (R2-1's shape, and the
    // legacy row every pre-`20270815` approval is in)
    const g = await seedDraft();
    await t.prisma.decision.update({ where: { id: g }, data: { status: 'approved' } });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: g } })).approvedDeciderKind).toBeNull();

    // (g) PRECISION, and the point of the whole fix — the REAL approval path writes a label the
    // seal accepts, because the service asks the same function the seal asks. If the two ever
    // disagreed, this ordinary client approval would 500.
    const h = await seedDraft();
    await t.prisma.decision.update({ where: { id: h }, data: { publishedAt: new Date() } });
    await svc.approve(f.projectA.id, h, { optionIndex: 0 } as never, { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser);
    const approved = await t.prisma.decision.findUniqueOrThrow({ where: { id: h } });
    expect(approved.status).toBe('approved');
    expect(approved.approvedDeciderLabel).toBe('Client');
  });

  // ── R5-4 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R5-4: the org-holder check and its write are ONE transaction holding each project readiness key', async () => {
    // a second org owner who supplies NO pmc standing of their own (an active project membership
    // DECIDES, so their org row is suppressed) — the caller, since an org must keep an owner
    const second = await t.prisma.user.create({
      data: { projectId: f.projectA.id, role: 'pmc', name: 'Second owner', email: `second-${run}-${seq++}@t4bc5.test` },
    });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: second.id, role: 'owner' } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: second.id, role: 'contractor', status: 'active' } });

    // hold the project readiness key from another session, exactly as a membership command does.
    // At `cc00c94` the guard ran outside any transaction and the write then met the seal's
    // try-acquire-or-REFUSE, so a raw PostgreSQL error escaped as a 500.
    const g = (() => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; })();
    let held!: () => void;
    const heldP = new Promise<void>((r) => (held = r));
    const holdTx = raceDb.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l',
        `readiness:${f.projectA.id}`,
      );
      held();
      await g.p;
    }, { timeout: 20_000, maxWait: 10_000 });
    await heldP;

    let settled = false;
    const demoting = orgs
      .updateOrgMemberRole(f.orgA.id, second.id, f.ownerUser.id, { role: 'member' } as never)
      .then(() => { settled = true; }, (e) => { settled = true; throw e; });
    for (let i = 0; i < 40 && !settled; i++) await new Promise((r) => setTimeout(r, 50));
    expect(settled, 'the org write must WAIT for the readiness key, not be refused by the seal').toBe(false);
    // …and while it waits the row is UNCHANGED — the guard and the write are inside one
    // transaction, so nothing is committed before the key is held
    expect(
      (await t.prisma.orgMembership.findFirstOrThrow({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } })).role,
    ).toBe('owner');

    g.open();
    await holdTx;
    await demoting;
    expect(
      (await t.prisma.orgMembership.findFirstOrThrow({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } })).role,
    ).toBe('member');

    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: second.id } });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: second.id } });
    await t.prisma.user.delete({ where: { id: second.id } });
  });

  // ── R5-5 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R5-5: reopening a ROLE-held decision whose role has emptied is an actionable 409, not a raw database error', async () => {
    // a client-held decision, approved and closed. Its holder may THEN legally leave: a closed
    // decision blocks nobody's removal, which is exactly what makes this ordinary rather than exotic.
    const id = await seedDraft({ deciderKind: 'client' });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    await t.prisma.decision.update({
      where: { id },
      data: { status: 'approved', approvedDeciderKind: 'client', approvedDeciderLabel: 'Client' },
    });
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id },
      data: { status: 'removed' },
    });

    // At `cc00c94` the service validated only `member`, so this took the seal's ROLE arm and
    // Prisma surfaced the raw exception. The message alone does not distinguish the two heads —
    // the TYPE does.
    const err = await svc.requestChange(f.projectA.id, id, { reason: 'The finish is wrong', costImpact: 0, timeImpactDays: 0 } as never, pmc()).catch((e) => e);
    expect(err, 'a stale role holder is a conflict, not an internal error').toBeInstanceOf(ConflictException);
    expect(String(err.message)).toMatch(/no active client to decide/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('approved');

    // PRECISION — with the role covered again the same reopen succeeds
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id },
      data: { status: 'active' },
    });
    await svc.requestChange(f.projectA.id, id, { reason: 'The finish is wrong', costImpact: 0, timeImpactDays: 0 } as never, pmc());
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('change');
  });

  // ── R5-6 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R5-6: removing a project PMC who is also an org owner strands nobody — their org standing resurfaces', async () => {
    // the precedence rule, exercised: an ACTIVE project membership suppresses its holder's
    // org-derived pmc standing. So with `memberUser` both the sole project pmc AND an org owner,
    // effective standing is 1 before the removal — and 1 after it, because the same person becomes
    // a membership-less effective pmc the moment the membership ends.
    await t.prisma.orgMembership.updateMany({ where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'member' } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.memberUser.id, role: 'owner' } });

    const standing = async (): Promise<number> => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT orgs_effective_role_standing($1, 'pmc')::int AS n`, f.projectA.id,
      );
      return Number(rows[0]!.n);
    };
    expect(await standing()).toBe(1);

    // a published, OPEN, pmc-held decision — the thing the seal exists to protect
    const id = await seedDraft({ deciderKind: 'pmc' });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    // At `cc00c94` this was refused by BOTH the service guard (`count - 1` = 0) and the trigger
    // behind it, for a decision whose holder never stopped being covered.
    await expect(members.remove(f.projectA.id, manager(), f.memberUser.id)).resolves.toEqual({ ok: true });
    expect(await standing()).toBe(1);

    // PRECISION — the seal is not disarmed. Take the org row away too and the SAME removal is
    // refused, because now the role really does empty.
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.memberUser.id },
      data: { status: 'active' },
    });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: f.memberUser.id } });
    expect(await standing()).toBe(1);
    await expect(members.remove(f.projectA.id, manager(), f.memberUser.id)).rejects.toThrow(/published open decision/);
  });
});
