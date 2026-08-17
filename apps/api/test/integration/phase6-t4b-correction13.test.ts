import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i round 13 — the two Codex findings on `99cbada`.
 *
 *   R13-1 (P2) round 12's new publication arm rejects a stale record draft at the DATABASE, but
 *              `assertPublishableHolder` covered only `member`/`client`/`pmc` — so the seal's
 *              refusal escaped through Prisma as a 500 for an ordinary, actionable case.
 *   R13-2 (P2) the stamp and its seal were separate statements, so a non-transactional apply
 *              interrupted between them commits rows with no seal — a state the retry cannot
 *              resume, because it re-selects the same rows and dies on the primary key.
 *
 * R13-1 is the SPOKESMAN rule this PR has now applied at five doors: the database is the authority
 * and the service says the same thing first, in words a caller can act on. R13-2's proof is in
 * `scripts/upgrade-proof.sh`, which forces the interruption for real against a database that HAS
 * stamped rows — this suite owns the parts that need no legacy state.
 */
describe('Phase 6 unit 4b-i round 13 — the two Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    // This suite mints its own holder identities; the shared fixture cleanup only knows its six,
    // and a leftover `User` blocks the project delete. Removed after the decisions that name them.
    const mine = await t.prisma.user.findMany({ where: { email: { endsWith: '@t4bc13.test' } }, select: { id: true } });
    const mineIds = mine.map((u) => u.id);
    if (mineIds.length) {
      await t.prisma.membership.deleteMany({ where: { userId: { in: mineIds } } });
      await t.prisma.user.deleteMany({ where: { id: { in: mineIds } } });
    }
    for (const [userId, role] of [[f.memberUser.id, 'pmc'], [f.clientUser.id, 'client']] as const) {
      if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId } }))) {
        await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId, role, status: 'active' } });
      } else {
        await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId }, data: { role, status: 'active' } });
      }
    }
  });

  /** A saved RECORD draft — `deciderKind: 'none'`, status `recorded`, unpublished, no options. */
  const seedRecordDraft = async (authorId: string): Promise<string> => {
    const id = `DL-t4bc13-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Record ${id}`, room: 'Kitchen', status: 'recorded',
        deciderKind: 'none', ageDays: 0, photoSwatch: 'sw1', authorId, publishedAt: null,
      },
    });
    return id;
  };

  // ── R13-1 ──────────────────────────────────────────────────────────────────────────────────

  it('R13-1: publishing a record whose author lost authority is an actionable CONFLICT, not a raw database error', async () => {
    // Round 12 made the database refuse this. The service did not ask, so the refusal arrived as a
    // `PrismaClientKnownRequestError` — a 500 — for the ordinary case the arm exists to catch: a
    // record draft saved while its author held authority, published after they lost it.
    const id = await seedRecordDraft(f.memberUser.id);
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.memberUser.id }, data: { status: 'removed' },
    });

    // the caller is a DIFFERENT pmc, so the publish is authorised — it is the AUTHOR who is stale
    const caller = { sub: f.ownerUser.id, role: 'pmc', projectId: f.projectA.id } as AuthUser;
    const err = await svc.publish(f.projectA.id, id, caller).then(() => null, (e: unknown) => e);
    expect(err, 'the publish must be refused').not.toBeNull();
    expect(err, 'and refused by the SERVICE, in words a caller can act on').toBeInstanceOf(ConflictException);
    expect(String((err as Error).message)).toMatch(/no longer has decision authority/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).toBeNull();
  });

  it('R13-1 precision: a record whose author still holds authority publishes through the same path', async () => {
    // The spokesman must not be stricter than the seal it fronts — that was the failure mode round
    // 5 named (`requestChange`), and it is the one this arm could most easily repeat.
    const id = await seedRecordDraft(f.memberUser.id);
    await svc.publish(f.projectA.id, id, pmc());
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).not.toBeNull();
  });

  it('R13-1: the ordinary holder arms still answer for themselves — a departed NAMED member is still the member message', async () => {
    // `none` returns early now, so the member/client/pmc arms must be untouched. The specific
    // refusal round 4 proved is the one that has to survive.
    const holderUser = await t.prisma.user.create({
      data: { projectId: f.projectA.id, role: 'contractor', name: 'Named holder', email: `holder-${run}-${seq++}@t4bc13.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId: holderUser.id, role: 'contractor', status: 'active' },
    });
    const id = `DL-t4bc13-mem-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'Member-held', room: 'Kitchen', status: 'pending',
        deciderKind: 'member', deciderMembershipId: holder.id, ageDays: 0, photoSwatch: 'sw1',
        authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.membership.update({ where: { id: holder.id }, data: { status: 'removed' } });

    await expect(svc.publish(f.projectA.id, id, pmc())).rejects.toThrow(/has left the project/);
    // the holder rows are removed in `afterEach`, AFTER the decisions that name them — a
    // membership cannot be deleted while a decision still designates it.
  });

  // ── R13-2 ──────────────────────────────────────────────────────────────────────────────────

  it('R13-2: the stamp and both seals are created by ONE statement, so the partial state cannot exist', async () => {
    // The finding is about a window BETWEEN two statements. The fix removes the window rather than
    // making it recoverable: PostgreSQL treats a `DO` block as a single statement, so an
    // interruption inside it rolls back the INSERT along with the triggers.
    //
    // The behavioural proof — forcing the interruption against a database that HAS legacy rows to
    // stamp — is in `scripts/upgrade-proof.sh`; a database migrated from empty stamps nothing, so
    // there is nothing here for a rollback to un-commit. What this pins is the outcome that
    // window's absence must produce: after a completed apply BOTH triggers exist, which at
    // `99cbada` was reachable in a partial state where the rows existed and neither did.
    const triggers = await t.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tg.tgname FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
        WHERE c.relname = 'DecisionLegacyApproval' AND NOT tg.tgisinternal
        ORDER BY tg.tgname`,
    );
    expect(triggers.map((r) => r.tgname)).toEqual([
      'DecisionLegacyApproval_no_truncate',
      'DecisionLegacyApproval_sealed',
    ]);
    // …and the set is still empty on a database migrated from empty, so the one-shot guard did not
    // quietly start stamping rows when the statement boundary moved.
    expect(await t.prisma.decisionLegacyApproval.count()).toBe(0);
  });
});
