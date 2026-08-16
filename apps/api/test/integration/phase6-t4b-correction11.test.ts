import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';

/**
 * Phase 6 unit 4b-i round 11 — the five Codex findings on `f113f94`.
 *
 * Round 10 replaced a forgeable predicate with an enumerated set. Four of these five findings are
 * about that set's EDGES — who is in it, how it survives, and what its existence now implies about
 * a door that only made sense while "legacy" was a shape rather than a list:
 *
 *   R11-1 (P1) the set left out legacy approvals sitting in `change` — a real upgrade bug that
 *              made an ordinary pre-existing change request impossible to withdraw, forever.
 *   R11-2 (P2) the table existed only in hand-written SQL, so schema drift could DROP it.
 *   R11-3 (P1) R4-2's born-approved-tupleless INSERT door outlived its own justification.
 *   R11-4 (P2) the stamp INSERT was not re-runnable: a BEFORE INSERT seal fires before
 *              ON CONFLICT resolves, so the required retry aborted.
 *   R11-5 (P2) a row-level seal never fires for TRUNCATE.
 *
 * R11-1 and R11-4 are proven where the states they concern actually exist — `upgrade-proof.sh`,
 * which plants legacy shapes BEFORE `20270827000000` and then migrates, and re-runs the migration
 * file. A database migrated from empty has an empty stamp set, so neither is constructible here
 * and neither is faked here. R11-2 is proven by `schema-migration-drift.test.ts`. What this file
 * owns is R11-3 and R11-5, plus the structural pins for the rest.
 */
describe('Phase 6 unit 4b-i round 11 — the five Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
  });

  const id = (tag: string): string => `DL-t4bc11-${run}-${tag}-${seq++}`;

  // ── R11-3 ──────────────────────────────────────────────────────────────────────────────────

  it('R11-3: a decision BORN approved with no holder tuple is REFUSED — the legacy shape is a list now, not a shape', async () => {
    // At `f113f94` this INSERT was ACCEPTED, under R4-2's narrowing: an absent tuple was "the
    // legacy shape". Round 10 ended that reading — legacy is the finite set `20270827000000`
    // stamped, every member of which already exists — so a row inserted now is by definition not
    // legacy, and R2-1 forbids filling its tuple afterwards. It would be unattributable forever.
    const born = id('born');
    await expect(t.prisma.decision.create({
      data: {
        id: born, projectId: f.projectA.id, title: 'Born approved', room: 'Kitchen',
        status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        publishedAt: null, approvedOption: 'A', material: 'Teak', approver: 'Client',
        approvedById: f.clientUser.id, date: '01 Jan 2026',
      },
    })).rejects.toThrow(/records WHO approved it/);
    expect(await t.prisma.decision.count({ where: { id: born } })).toBe(0);
  });

  it('R11-3 precision: born approved WITH a coherent tuple still inserts, and a WRONG one is still refused for its own reason', async () => {
    // The rule refuses an unattributed approval, not the shape. A legacy-era import that carries
    // its attribution is still representable.
    const ok = id('ok');
    await t.prisma.decision.create({
      data: {
        id: ok, projectId: f.projectA.id, title: 'Born attributed', room: 'Kitchen',
        status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        publishedAt: null, approvedOption: 'A', material: 'Teak', approver: 'Client',
        approvedById: f.clientUser.id, date: '01 Jan 2026',
        approvedDeciderKind: 'client', approvedDeciderMembershipId: null, approvedDeciderLabel: 'Client',
      },
    });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: ok } })).approvedDeciderLabel).toBe('Client');

    // …and the pre-existing arms still answer first for their own defects, so R11-3 has not
    // swallowed the completeness and holder-binding rules into one blunt refusal.
    await expect(t.prisma.decision.create({
      data: {
        id: id('half'), projectId: f.projectA.id, title: 'Half attributed', room: 'Kitchen',
        status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        publishedAt: null, approvedDeciderKind: 'client', approvedDeciderLabel: '   ',
      },
    })).rejects.toThrow(/WHOLE approval holder tuple/);

    await expect(t.prisma.decision.create({
      data: {
        id: id('wrong'), projectId: f.projectA.id, title: 'Misattributed', room: 'Kitchen',
        status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        publishedAt: null, approvedDeciderKind: 'pmc', approvedDeciderLabel: 'PMC',
      },
    })).rejects.toThrow(/must record the decider of/);
  });

  it('R11-3: the door it closed is closed END TO END — the born-approved row cannot be published either, because it cannot exist', async () => {
    // The finding described a whole path: insert `approved` with a null tuple, add options,
    // publish, and the register carries an approval nobody can be held to. The refusal lands at
    // the first step, so the rest of the path has nothing to stand on — asserted rather than
    // assumed, because "it fails somewhere later" is a different guarantee from "it never exists".
    const ghost = id('ghost');
    await expect(t.prisma.decision.create({
      data: {
        id: ghost, projectId: f.projectA.id, title: 'Ghost', room: 'Kitchen',
        status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    })).rejects.toThrow(/records WHO approved it/);
    expect(await t.prisma.decisionOption.count({ where: { decisionId: ghost } })).toBe(0);
    expect(await t.prisma.decision.count({ where: { id: ghost } })).toBe(0);
  });

  // ── R11-5 ──────────────────────────────────────────────────────────────────────────────────

  it('R11-5 precision: an EMPTY register may still be TRUNCATEd — the seal protects evidence, it does not break sanctioned resets', async () => {
    // The refusal itself needs stamped rows, and this database has none (see the last probe), so
    // the REFUSING arm is proven in `upgrade-proof.sh` where genuine ones exist. What belongs here
    // is the arm that keeps the seal honest rather than merely strict.
    //
    // The first draft of R11-5 refused every truncate unconditionally, and the battery refuted it:
    // `event-catalog`'s sanctioned `TRUNCATE "Decision" … CASCADE` reaches this table through the
    // cascade, and a blanket seal broke a reset that erases the evidence together with the very
    // decisions it exempts — which is the one lawful way for it to go. The rule is therefore the
    // same conditional shape as `DecisionEvent_t4a_no_truncate` next to it: an empty register has
    // nothing at stake; a populated one cannot be emptied by a verb the row seal never sees.
    await t.prisma.$executeRawUnsafe(`TRUNCATE TABLE "DecisionLegacyApproval"`);
    expect(await t.prisma.decisionLegacyApproval.count()).toBe(0);
  });

  it('R11-5 + R11-2: the seal covers every verb, and the evidence is declared in the Prisma schema', async () => {
    // The row seal and the statement seal are separate triggers because PostgreSQL will not let
    // one trigger cover both — pinning the pair structurally means the next verb that is forgotten
    // fails a test rather than waiting for a reviewer.
    // `information_schema.triggers` is SQL-standard and reports INSERT/UPDATE/DELETE ONLY — a
    // TRUNCATE trigger is invisible there, which is a neat echo of the finding itself: the
    // catalogue that omits the verb is the one that would have let the omission pass unnoticed.
    // `pg_trigger.tgtype` carries all four (4=INSERT, 8=DELETE, 16=UPDATE, 32=TRUNCATE).
    const verbs = await t.prisma.$queryRawUnsafe<Array<{ trigger_name: string; events: string }>>(
      `SELECT tg.tgname AS trigger_name,
              btrim(CASE WHEN (tg.tgtype & 4) > 0 THEN 'INSERT,' ELSE '' END
                 || CASE WHEN (tg.tgtype & 8) > 0 THEN 'DELETE,' ELSE '' END
                 || CASE WHEN (tg.tgtype & 16) > 0 THEN 'UPDATE,' ELSE '' END
                 || CASE WHEN (tg.tgtype & 32) > 0 THEN 'TRUNCATE,' ELSE '' END, ',') AS events
         FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
        WHERE c.relname = 'DecisionLegacyApproval' AND NOT tg.tgisinternal
        ORDER BY tg.tgname`,
    );
    expect(Object.fromEntries(verbs.map((r) => [r.trigger_name, r.events]))).toEqual({
      DecisionLegacyApproval_no_truncate: 'TRUNCATE',
      DecisionLegacyApproval_sealed: 'INSERT,DELETE,UPDATE',
    });

    // R11-2: the table is reachable through the generated client, which is only true when it is
    // declared in `schema.prisma` — the desired state `prisma migrate dev` diffs against. Without
    // it, a future generated migration would be entitled to DROP the register.
    // (`schema-migration-drift.test.ts` proves the declaration MATCHES the migration; this proves
    // the declaration exists at all, from the side the application sees.)
    expect(await t.prisma.decisionLegacyApproval.count()).toBe(0);
  });

  // ── R11-1 and R11-4: named here, proven where their states exist ───────────────────────────

  it('R11-1 + R11-4: the stamp set is empty on a database migrated from empty, which is why both are proven in upgrade-proof', async () => {
    // R11-1 (legacy rows sitting in `change` are stamped too) and R11-4 (the stamp INSERT is
    // re-runnable) are both statements about a migration meeting EXISTING rows. This database was
    // migrated from empty, so the set is empty and neither claim has a subject here. Rather than
    // stage a fake one — the exact move round 10 removed from two other suites — both are proven
    // in `scripts/upgrade-proof.sh`, which plants a legacy approval AND a legacy approval already
    // in `change` before `20270827000000`, then migrates, then RE-RUNS the migration file.
    //
    // This assertion is the honest half that belongs here: it pins WHY the others are absent, so a
    // later reader cannot mistake the gap for an oversight and "restore" a fabricated fixture.
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "DecisionLegacyApproval"`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
