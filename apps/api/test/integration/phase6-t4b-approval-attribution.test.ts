import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 6 task 4b — APPROVAL ATTRIBUTION AND ITS EVIDENCE, proven against live PostgreSQL.
 *
 * This unit ships no writer. Every assertion here is therefore a HOSTILE-SQL assertion: it asks
 * what the database does when something bypasses the application entirely, because during the
 * expansion phase that is the only writer these columns can have. A seal that only holds when the
 * service cooperates is not a seal.
 *
 * Each probe is COUPLED to the object it claims to test: where a trigger is the enforcer, the
 * probe first shows the hostile write SUCCEEDING with that trigger disabled by name, then shows it
 * REFUSED with the trigger restored. A probe that passes because the write was malformed for some
 * unrelated reason is worthless, and the only way to know the difference is to make it fail on
 * demand.
 *
 * Probes
 *   P1  shape        — a half-written attribution is refused; the complete tuple is ACCEPTED
 *   P2  containment  — attributing to another project's membership is a foreign-key violation
 *   P3  write-once   — the act is frozen, including against being cleared; unrelated edits still work
 *   P4  DELETE       — an attributed approval and a legacy-stamped decision are undeletable;
 *                      an unattributed decision still deletes                  (PR #344 finding F1)
 *   P5  TRUNCATE     — with attribution present the table cannot be truncated  (PR #344 finding F2)
 *   P6  evidence     — the legacy stamp cannot be minted, edited, independently deleted or truncated
 *
 * Deliberately NOT here:
 *   * "an approval must carry attribution" — the enforcement phase installs that, because the
 *     release now in production approves without it (see the migration header and RUNBOOK §P6-4B-DB).
 *   * the CONDITIONAL half of P5 (that a database holding nothing permanent still truncates). A
 *     bare `TRUNCATE "Decision"` is a whole-table statement, so its success depends on every other
 *     suite sharing this database at that instant. It is proven in `upgrade-proof.sh`, which owns
 *     its database exclusively — asserting it here would be a race dressed as a guarantee.
 */
describe('Phase 6 task 4b — approval attribution and its evidence (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const run = Math.floor(Math.random() * 1e6);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  /** The permanence seals are doing their job when they refuse this suite's own teardown, so the
   *  teardown uses the sanctioned bypass — disable BY NAME, for exactly the wipe, and restore.
   *  Nothing outside this file changes: the shared fixture helpers are untouched. */
  const wipe = async (): Promise<void> => {
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionLegacyApproval" DISABLE TRIGGER "DecisionLegacyApproval_sealed"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_approval_permanent"'),
      t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionLegacyApproval" WHERE "decisionId" LIKE 'DL-t4bdb-%'`),
      t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "decisionId" LIKE 'DL-t4bdb-%'`),
      t.prisma.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" LIKE 'DL-t4bdb-%'`),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_approval_permanent"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionLegacyApproval" ENABLE TRIGGER "DecisionLegacyApproval_sealed"'),
    ]);
  };

  afterEach(wipe);
  afterAll(async () => {
    await wipe();
    await f?.cleanup();
    await t?.close();
  });

  /** A decision row, created directly. `status` defaults to 'pending' unless overridden — this
   *  unit takes no position on the lifecycle, only on what the attribution columns must look like. */
  const seed = async (
    over: Record<string, unknown> = {},
    projectId: string = f.projectA.id,
  ): Promise<string> => {
    const id = `DL-t4bdb-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId, title: 'Which floor finish?', room: 'Hall', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, ...over,
      },
    });
    return id;
  };

  /** Run `fn` with one named trigger disabled, then restore it no matter what happened. This is
   *  how each probe proves it is measuring the trigger rather than a coincidence. */
  const withoutTrigger = async <T>(table: string, trigger: string, fn: () => Promise<T>): Promise<T> => {
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    try {
      return await fn();
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
  };

  const refusal = async (sql: string): Promise<string> => {
    const err = await t.prisma.$executeRawUnsafe(sql).then(() => null, (e: unknown) => e);
    expect(err, `expected PostgreSQL to refuse: ${sql}`).not.toBeNull();
    return String(err);
  };

  const membershipId = async (projectId: string, userId: string): Promise<string> =>
    (await t.prisma.membership.findFirstOrThrow({ where: { projectId, userId } })).id;

  // ── P1 — a half-written attribution is not a fact ──────────────────────────────────────────
  it('P1 shape: an incomplete approval attribution is refused, and a complete one is accepted', async () => {
    const id = await seed();

    // a kind that names a member, with no member named
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderKind"='member', "approvedDeciderLabel"='Someone' WHERE "id"='${id}'`,
    )).toMatch(/approved_decider_pair_check/i);

    // a kind with nobody to display — an attribution that cannot be shown is not an attribution,
    // and in a register it is worse than none because it looks like one
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderKind"='client' WHERE "id"='${id}'`,
    )).toMatch(/approved_decider_pair_check/i);

    // a label with no kind to type it
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderLabel"='Client' WHERE "id"='${id}'`,
    )).toMatch(/approved_decider_orphan_check/i);

    // …and a non-member kind may not smuggle a membership in
    const mid = await membershipId(f.projectA.id, f.memberUser.id);
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderKind"='client', "approvedDeciderLabel"='Client', "approvedDeciderMembershipId"='${mid}' WHERE "id"='${id}'`,
    )).toMatch(/approved_decider_pair_check/i);

    // PRECISION — the seals are strict, not merely obstructive: both legal shapes commit
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "approvedDeciderKind"='client', "approvedDeciderLabel"='Client' WHERE "id"='${id}'`,
    );
    const other = await seed();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "approvedDeciderKind"='member', "approvedDeciderLabel"='Priya (PMC)', "approvedDeciderMembershipId"='${mid}' WHERE "id"='${other}'`,
    );
    const rows = await t.prisma.decision.findMany({
      where: { id: { in: [id, other] } },
      select: { id: true, approvedDeciderKind: true, approvedDeciderMembershipId: true },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.approvedDeciderKind).sort()).toEqual(['client', 'member']);
    expect(rows.find((r) => r.approvedDeciderKind === 'member')?.approvedDeciderMembershipId).toBe(mid);
  });

  // ── P2 — one project, one register ────────────────────────────────────────────────────────
  it('P2 containment: an approval cannot be attributed to another project\'s member', async () => {
    const id = await seed();
    const foreign = await membershipId(f.projectB.id, f.otherUser.id);

    // the FROZEN act — the reference carries this row's own projectId, so the pair simply does not
    // exist in the target and PostgreSQL refuses it. Not a service check; not representable.
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderKind"='member', "approvedDeciderLabel"='Outsider', "approvedDeciderMembershipId"='${foreign}' WHERE "id"='${id}'`,
    )).toMatch(/approvedDeciderMembershipId_fkey|foreign key/i);

    // and the CURRENT holder, by the same composite key
    expect(await refusal(
      `UPDATE "Decision" SET "deciderKind"='member', "deciderMembershipId"='${foreign}' WHERE "id"='${id}'`,
    )).toMatch(/deciderMembershipId_fkey|foreign key/i);

    // PRECISION — the same shape pointing at THIS project's member is accepted
    const own = await membershipId(f.projectA.id, f.memberUser.id);
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "deciderKind"='member', "deciderMembershipId"='${own}' WHERE "id"='${id}'`,
    );
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).deciderMembershipId).toBe(own);
  });

  // ── P3 — the act does not move ────────────────────────────────────────────────────────────
  it('P3 write-once: a recorded attribution is frozen, including against being cleared', async () => {
    const id = await seed();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "approvedDeciderKind"='client', "approvedDeciderLabel"='Client' WHERE "id"='${id}'`,
    );

    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderLabel"='Someone Else' WHERE "id"='${id}'`,
    )).toMatch(/frozen at the act/);
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderKind"='pmc' WHERE "id"='${id}'`,
    )).toMatch(/frozen at the act/);
    // "nobody approved this after all" is exactly the rewrite a register must refuse
    expect(await refusal(
      `UPDATE "Decision" SET "approvedDeciderKind"=NULL, "approvedDeciderLabel"=NULL WHERE "id"='${id}'`,
    )).toMatch(/frozen at the act/);

    // PRECISION — the freeze is on the ACT, not on the row. The CURRENT holder still moves (that
    // is what forwarding a decision is), and ordinary columns are untouched by this trigger.
    const own = await membershipId(f.projectA.id, f.memberUser.id);
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "deciderKind"='member', "deciderMembershipId"='${own}', "title"='Retitled' WHERE "id"='${id}'`,
    );
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.title).toBe('Retitled');
    expect(after.deciderKind).toBe('member');
    expect(after.approvedDeciderLabel).toBe('Client'); // the act, unchanged

    // COUPLING — with the trigger disabled the same restatement commits, so the refusals above
    // are this trigger's work and not a side effect of something else in the schema.
    await withoutTrigger('Decision', 'Decision_t4b_approval_frozen', async () => {
      await t.prisma.$executeRawUnsafe(
        `UPDATE "Decision" SET "approvedDeciderLabel"='Rewritten' WHERE "id"='${id}'`,
      );
    });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).approvedDeciderLabel).toBe('Rewritten');
  });

  // ── P4 — carried from PR #344 (round 19, P1) ──────────────────────────────────────────────
  it('P4 DELETE: an attributed approval and a stamped legacy approval are permanent; an unapproved decision is not', async () => {
    // (a) the frozen act cannot be deleted
    const attributed = await seed();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "approvedDeciderKind"='client', "approvedDeciderLabel"='Client' WHERE "id"='${attributed}'`,
    );
    expect(await refusal(`DELETE FROM "Decision" WHERE "id"='${attributed}'`))
      .toMatch(/permanent register entry and is never deleted/);
    expect(await t.prisma.decision.count({ where: { id: attributed } })).toBe(1);

    // (b) a LEGACY-stamped decision cannot be deleted either. This is the half that mattered:
    // the stamp cascades from its subject and its own seal permits removal once the parent is
    // gone, so before this trigger existed the only proof a pre-attribution approval happened
    // could be erased by deleting the thing it was proof about.
    // The stamp is planted through the sanctioned bypass because the migration is its only
    // legitimate writer — which is precisely what P6 asserts.
    const stamped = await seed({ status: 'approved' });
    await withoutTrigger('DecisionLegacyApproval', 'DecisionLegacyApproval_sealed', async () => {
      await t.prisma.$executeRawUnsafe(`INSERT INTO "DecisionLegacyApproval"("decisionId") VALUES ('${stamped}')`);
    });
    expect(await refusal(`DELETE FROM "Decision" WHERE "id"='${stamped}'`))
      .toMatch(/stamped as a pre-attribution approval/);
    expect(await t.prisma.decisionLegacyApproval.count({ where: { decisionId: stamped } })).toBe(1);

    // (c) PRECISION — a decision nobody approved carries no permanent evidence and still deletes.
    // Without this the guard would be a blanket ban dressed up as a rule about approvals.
    const plain = await seed();
    expect(await t.prisma.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id"='${plain}'`)).toBe(1);
    expect(await t.prisma.decision.count({ where: { id: plain } })).toBe(0);

    // COUPLING — both refusals are this trigger's
    await withoutTrigger('Decision', 'Decision_t4b_approval_permanent', async () => {
      expect(await t.prisma.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id"='${attributed}'`)).toBe(1);
    });
    expect(await t.prisma.decision.count({ where: { id: attributed } })).toBe(0);
  });

  // ── P5 — carried from PR #344 (round 19, P2) ──────────────────────────────────────────────
  it('P5 TRUNCATE: a row trigger never fires for TRUNCATE, so the statement is guarded separately', async () => {
    const id = await seed();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "approvedDeciderKind"='pmc', "approvedDeciderLabel"='Priya (PMC)' WHERE "id"='${id}'`,
    );

    // TRUNCATE is separately grantable and fires no row trigger, so P4 says nothing about it.
    // This assertion is safe in a shared database in the direction that matters: our own
    // attributed row guarantees the count is non-zero whatever else is present.
    expect(await refusal('TRUNCATE "Decision" CASCADE'))
      .toMatch(/permanent register entry is permanent against every verb/);
    expect(await t.prisma.decision.count({ where: { id } })).toBe(1);

    // COUPLING — with the statement trigger disabled the same TRUNCATE commits, which is what
    // makes the refusal above this guard's work rather than a coincidence.
    //
    // It runs inside a transaction that is then ROLLED BACK. In PostgreSQL both TRUNCATE and
    // `ALTER TABLE … DISABLE TRIGGER` are transactional, so the register is restored and the
    // trigger re-enabled by the rollback alone. The suites share one database, and a probe that
    // proves a point by permanently emptying a table other suites rely on has traded one
    // guarantee for a much worse bug — which is exactly what the first version of this block did.
    const truncated = await t.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_no_truncate"');
        await tx.$executeRawUnsafe('TRUNCATE "Decision" CASCADE');
        const remaining = await tx.decision.count({ where: { id } });
        throw new Error(`__rollback__:${remaining}`); // the only exit — nothing here is kept
      })
      .then(
        () => 'committed',
        (e: unknown) => String(e instanceof Error ? e.message : e),
      );
    expect(truncated, 'the guard was the only thing refusing the TRUNCATE').toContain('__rollback__:0');

    // …and the rollback really did put everything back
    expect(await t.prisma.decision.count({ where: { id } })).toBe(1);
    expect(await refusal('TRUNCATE "Decision" CASCADE'))
      .toMatch(/permanent register entry is permanent against every verb/);
  });

  // ── P6 — the exemption set is closed ─────────────────────────────────────────────────────
  it('P6 evidence: the legacy stamp cannot be minted, edited, independently deleted or truncated', async () => {
    const subject = await seed({ status: 'approved' });
    await withoutTrigger('DecisionLegacyApproval', 'DecisionLegacyApproval_sealed', async () => {
      await t.prisma.$executeRawUnsafe(`INSERT INTO "DecisionLegacyApproval"("decisionId") VALUES ('${subject}')`);
    });

    // MINTING is the attack the whole design exists to stop: strip an approval's tuple, then
    // stamp it as legacy so the missing tuple looks original. The set closed behind the migration.
    const fresh = await seed({ status: 'approved' });
    expect(await refusal(`INSERT INTO "DecisionLegacyApproval"("decisionId") VALUES ('${fresh}')`))
      .toMatch(/one-time migration evidence/);

    expect(await refusal(`UPDATE "DecisionLegacyApproval" SET "stampedAt"=now() WHERE "decisionId"='${subject}'`))
      .toMatch(/never updated/);

    // …and the evidence cannot be lifted out from under a decision that still stands
    expect(await refusal(`DELETE FROM "DecisionLegacyApproval" WHERE "decisionId"='${subject}'`))
      .toMatch(/cannot be deleted while decision/);

    expect(await refusal('TRUNCATE "DecisionLegacyApproval"'))
      .toMatch(/only evidence that those approvals predate attribution/);

    expect(await t.prisma.decisionLegacyApproval.count({ where: { decisionId: subject } })).toBe(1);
  });
});
