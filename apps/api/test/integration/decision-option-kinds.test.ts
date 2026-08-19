import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, wipeDecisions, type TwoProjectFixture } from './fixtures';

/**
 * Issue generalization unit A1-i — AN OPTION DECLARES WHAT KIND OF CHOICE IT IS.
 *
 * No writer ships in this unit, so every probe goes at the database directly: during the expansion
 * phase direct SQL is the only writer these columns can have, and a rule that holds only when the
 * service cooperates is not a rule.
 *
 * Probes
 *   P1  the kind menu is SERVER-DRIVEN — four seeded base kinds, ordered, keyed for localization
 *       rather than carrying display strings
 *   P2  ROLLOUT: an insert that mentions only the legacy columns keeps its meaning — classified
 *       `material`, and its `delta` re-expressed as a cost STATE rather than silently reading as
 *       "nobody has assessed this"
 *   P3  cost impact is a STATE: an amount is required for estimated/confirmed and FORBIDDEN for
 *       pending/none, so `pending` can never read as free and no stale amount lingers
 *   P4  a CONFIRMED cost freezes the proposal it was agreed for, not just the number
 *   P5  a kind's base classification is frozen once anything is classified by it
 *   P6  an option must say WHAT IT IS — it names a material, or it describes itself
 *   P7  the kind reference is real, and a kind in use cannot be deleted or re-keyed
 *   P8  nothing in this unit ever asserts a finality nobody claimed
 *   P9  a confirmed cost cannot be ERASED either — not by delete, and not by truncate
 *   P10 a retired kind cannot be newly selected, and the default kind cannot be retired
 *   P11 the legacy `delta` and the new cost state may not disagree while both are read
 *   P12 the migration re-applies cleanly even after a real confirmed cost exists
 */
describe('A1-i — the option kind vocabulary and its cost state (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const run = Math.floor(Math.random() * 1e6);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  // An APPROVED decision is permanent: `phase6_t4a_withdrawn_no_delete` refuses the delete on the
  // decision's own status, and `decision_t4b_no_truncate` blocks the escape a TRUNCATE would
  // otherwise give. The repository already answers this with `wipeDecisions`, which disables
  // exactly those named seals inside one transaction and re-enables them.
  //
  // A teardown that can fail reports OTHER people's tests as broken, so this one is written to
  // survive every seal these probes can meet.
  const wipe = async (): Promise<void> => {
    // These probes record CONFIRMED costs, and a confirmed cost is not deletable (P9). A test reset
    // is the same sanctioned destructive contract the repository's other evidence tables use:
    // disable the ONE named seal for exactly this wipe, inside a transaction, so a wipe that throws
    // rolls the disable back with it and no failure path leaves the seal off for later suites.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_confirmed_no_delete"`),
      t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`),
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_confirmed_no_delete"`),
    ]);
    await wipeDecisions(t.prisma, { id: { startsWith: 'DL-a1-' } });
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOptionKind" WHERE "code" LIKE 'a1-%'`);
  };
  afterEach(wipe);
  afterAll(async () => {
    await wipe();
    await f?.cleanup();
    await t?.close();
  });

  /** An issue. `photoSwatch` is still NOT NULL in this unit — relaxing the material half is A1-ii. */
  const issue = async (): Promise<string> => {
    const id = `DL-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Decision"("id","projectId","title","room","status","photoSwatch","authorId")
       VALUES ('${id}','${f.projectA.id}','Which approach?','Hall','pending','stone','${f.memberUser.id}')`,
    );
    return id;
  };

  /** An option written the way the RUNNING RELEASE writes one: legacy columns only. */
  const legacyOption = (decisionId: string, over: { delta?: number; material?: string } = {}): string => {
    const id = `opt-a1-${run}-${seq++}`;
    return `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
            VALUES ('${id}','${decisionId}','Option ${seq}','k${seq}','${over.material ?? 'Teak'}',${over.delta ?? 31500},'brown')`;
  };

  const refusal = async (sql: string): Promise<string> => {
    const err = await t.prisma.$executeRawUnsafe(sql).then(() => null, (e: unknown) => e);
    expect(err, `expected PostgreSQL to refuse: ${sql.slice(0, 100)}`).not.toBeNull();
    return String(err);
  };

  const one = async <T>(sql: string): Promise<T> =>
    (await t.prisma.$queryRawUnsafe<T[]>(sql))[0];

  // ── P1 ──────────────────────────────────────────────────────────────────────────────────────
  it('P1 the kind menu is server-driven, ordered, and carries localization KEYS not labels', async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ code: string; baseKind: string; labelKey: string }>>(
      `SELECT "code","baseKind"::text AS "baseKind","labelKey" FROM "DecisionOptionKind"
        WHERE "active" ORDER BY "displayOrder"`,
    );
    expect(rows.map((r) => r.code)).toEqual(['material', 'technology', 'solution', 'other']);
    // every base kind is reachable from the menu, so a question that is not about a product has
    // somewhere to go
    expect(new Set(rows.map((r) => r.baseKind)))
      .toEqual(new Set(['material', 'technology', 'solution', 'other']));
    // a KEY, not a display string: the frontend hardcodes no labels, so retiring or renaming a kind
    // is a data change rather than a release
    for (const r of rows) expect(r.labelKey).toMatch(/^option\.kind\./u);
  });

  // ── P2 ──────────────────────────────────────────────────────────────────────────────────────
  it('P2 rollout: an insert that mentions only the legacy columns keeps its meaning', async () => {
    const d = await issue();

    // The running release does not know these columns exist. Left alone its rows would take the
    // defaults — `pending`/NULL — so a cost a PMC really typed would read to the next release as
    // "nobody has assessed this", and the amount would be gone.
    await t.prisma.$executeRawUnsafe(legacyOption(d, { delta: 31500 }));
    const priced = await one<{ kindCode: string; costImpact: string; costAmount: number }>(
      `SELECT "kindCode","costImpact"::text AS "costImpact","costAmount" FROM "DecisionOption"
        WHERE "decisionId"='${d}' ORDER BY "id" DESC LIMIT 1`,
    );
    expect(priced.kindCode).toBe('material');   // truthful: in this unit an option must name a material
    expect(priced.costImpact).toBe('estimated'); // a real number, but nothing says it was final
    expect(priced.costAmount).toBe(31500);

    // …and a stated zero IS an assessment, so it maps to `none` rather than to `pending`
    await t.prisma.$executeRawUnsafe(legacyOption(d, { delta: 0 }));
    const free = await one<{ costImpact: string; costAmount: number | null }>(
      `SELECT "costImpact"::text AS "costImpact","costAmount" FROM "DecisionOption"
        WHERE "decisionId"='${d}' ORDER BY "id" DESC LIMIT 1`,
    );
    expect(free.costImpact).toBe('none');
    expect(free.costAmount).toBeNull();
  });

  // ── P3 ──────────────────────────────────────────────────────────────────────────────────────
  it('P3 cost impact is a state: the amount is required where it means something, forbidden where it does not', async () => {
    const d = await issue();
    // `delta` tracks the amount: the two representations of one fact may not disagree while both are
    // being read (P11). Holding them consistent here keeps each refusal below attributable to the
    // coherence rule it is actually testing.
    const base = (impact: string, amount: string): string => {
      const id = `opt-a1-${run}-${seq++}`;
      const delta = amount === 'NULL' ? '0' : amount;
      return `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","costImpact","costAmount")
              VALUES ('${id}','${d}','O','k${seq}','Teak',${delta},'brown','${impact}',${amount})`;
    };

    expect(await refusal(base('estimated', 'NULL'))).toMatch(/cost_impact_check/u);
    expect(await refusal(base('confirmed', 'NULL'))).toMatch(/cost_impact_check/u);
    // the forbidding half matters as much: a stale amount on a `pending` row is how a number
    // nobody stands behind gets read as a price
    expect(await refusal(base('pending', '31500'))).toMatch(/cost_impact_check/u);
    expect(await refusal(base('none', '0'))).toMatch(/cost_impact_check/u);

    // PRECISION — the coherent combinations are accepted, so this is a rule and not a wall
    await t.prisma.$executeRawUnsafe(base('estimated', '31500'));
    await t.prisma.$executeRawUnsafe(base('confirmed', '28000'));
  });

  // ── P4 (Codex, P1 on the previous unit) ─────────────────────────────────────────────────────
  it('P4 a confirmed cost freezes the PROPOSAL it was agreed for, not just the number', async () => {
    const d = await issue();
    const id = `opt-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","description","costImpact","costAmount")
       VALUES ('${id}','${d}','Teak veneer','k1','Teak',31500,'brown','Veneered ply, matt finish','confirmed',31500)`,
    );

    // Freezing only the amount leaves the worse hole open: keep the trusted 31,500 and rewrite what
    // it was agreed FOR, and a price for one proposal now sits against a different one.
    for (const set of [
      `"costAmount"=28000`,
      `"costImpact"='estimated'`,
      `"label"='Walnut veneer'`,
      `"description"='Solid walnut, oiled'`,
      `"material"='Walnut'`,
      `"kindCode"='technology'`,
      `"swatch"='grey'`,
    ]) {
      expect(await refusal(`UPDATE "DecisionOption" SET ${set} WHERE "id"='${id}'`),
             `expected the confirmed-cost freeze to refuse: ${set}`)
        .toMatch(/CONFIRMED cost/u);
    }

    // PRECISION — the freeze is about the CLAIM, not about the row. Which option is recommended and
    // what order they read in carry no assertion about the proposal, and stay editable.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOption" SET "recommended"=true, "order"=3 WHERE "id"='${id}'`);
    const row = await one<{ recommended: boolean; costAmount: number }>(
      `SELECT "recommended","costAmount" FROM "DecisionOption" WHERE "id"='${id}'`);
    expect(row.recommended).toBe(true);
    expect(row.costAmount).toBe(31500);
  });

  // ── P5 (Codex, P1 on the previous unit) ─────────────────────────────────────────────────────
  it('P5 a kind’s base classification is frozen once anything is classified by it', async () => {
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey","displayOrder")
       VALUES ('a1-precast','material','option.kind.a1Precast',90)`);

    // unreferenced, so it is still ordinary data and may be corrected
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "baseKind"='solution' WHERE "code"='a1-precast'`);
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "baseKind"='material' WHERE "code"='a1-precast'`);

    const d = await issue();
    const id = `opt-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${id}','${d}','Precast panel','k1','Precast concrete',0,'grey','a1-precast')`);

    // Re-pointing it now silently re-classifies every option carrying the code — and no option row
    // changes, so nothing that watches options would ever fire.
    expect(await refusal(
      `UPDATE "DecisionOptionKind" SET "baseKind"='technology' WHERE "code"='a1-precast'`,
    )).toMatch(/base kind is frozen/u);

    // PRECISION — the rest of the menu row is still editable: retiring a kind is the supported move
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "active"=false, "displayOrder"=99 WHERE "code"='a1-precast'`);
    const kind = await one<{ active: boolean; baseKind: string }>(
      `SELECT "active","baseKind"::text AS "baseKind" FROM "DecisionOptionKind" WHERE "code"='a1-precast'`);
    expect(kind.active).toBe(false);
    expect(kind.baseKind).toBe('material');
  });

  // ── P6 (Codex, P2 on the previous unit) ─────────────────────────────────────────────────────
  it('P6 an option must say what it is: it names a material, or it describes itself', async () => {
    const d = await issue();
    const mk = (material: string, description: string): string => {
      const id = `opt-a1-${run}-${seq++}`;
      return `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","description")
              VALUES ('${id}','${d}','O','k${seq}','${material}',0,'brown',${description})`;
    };

    // NOT NULL is not the same as legible: an empty string satisfies it, and so does a run of
    // spaces or a lone tab.
    expect(await refusal(mk('', 'NULL'))).toMatch(/says_what_it_is_check/u);
    expect(await refusal(mk('   ', "'   '"))).toMatch(/says_what_it_is_check/u);

    // …and a description that is present but says nothing is refused INDEPENDENTLY of the material.
    // Without that second clause a material-bearing option satisfies the identity rule and a lone
    // tab rides along unchecked, leaving a nullable column with two ways to mean "absent" — NULL and
    // whitespace — only one of which any reader will test for.
    expect(await refusal(mk('Teak', "'   '"))).toMatch(/says_what_it_is_check/u);
    expect(await refusal(mk('Teak', "E'\\t'"))).toMatch(/says_what_it_is_check/u);

    // PRECISION, and the reason this rule is shaped the way it is: an option identified by its
    // DESCRIPTION is already legal here, so when A1-ii makes the material half optional this same
    // constraint becomes exactly the rule that matters without being rewritten.
    await t.prisma.$executeRawUnsafe(mk(' ', "'A poured-in-place alternative to the panel system'"));
    await t.prisma.$executeRawUnsafe(mk('Teak', 'NULL'));
  });

  // ── P7 ──────────────────────────────────────────────────────────────────────────────────────
  it('P7 the kind reference is real, and a kind in use cannot be deleted or re-keyed', async () => {
    const d = await issue();
    const id = `opt-a1-${run}-${seq++}`;
    expect(await refusal(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${id}','${d}','O','k1','Teak',0,'brown','no-such-kind')`,
    )).toMatch(/kind_fkey/u);

    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-x','other','option.kind.a1X')`);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${id}','${d}','O','k1','Teak',0,'brown','a1-x')`);

    // deleting or re-keying a kind an option carries would leave that option classified by nothing
    expect(await refusal(`DELETE FROM "DecisionOptionKind" WHERE "code"='a1-x'`)).toMatch(/kind_fkey/u);
    expect(await refusal(`UPDATE "DecisionOptionKind" SET "code"='a1-y' WHERE "code"='a1-x'`))
      .toMatch(/kind_fkey/u);
  });

  // ── P8 ──────────────────────────────────────────────────────────────────────────────────────
  it('P8 nothing in this unit asserts a finality nobody claimed', async () => {
    const d = await issue();
    await t.prisma.$executeRawUnsafe(legacyOption(d, { delta: 31500 }));
    await t.prisma.$executeRawUnsafe(legacyOption(d, { delta: 0 }));

    // `confirmed` is a claim a person makes. The derivation preserves a number that was really
    // entered and says only that it is provisional; it never manufactures agreement.
    const n = await one<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM "DecisionOption" WHERE "costImpact"='confirmed' AND "id" LIKE 'opt-a1-%'`);
    expect(Number(n.n)).toBe(0);
  });

  // ── P9 (Codex round 1, P1) ──────────────────────────────────────────────────────────────────
  it('P9 a confirmed cost cannot be ERASED either — not by delete, and not by truncate', async () => {
    const d = await issue();
    const id = `opt-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","costImpact","costAmount")
       VALUES ('${id}','${d}','Teak veneer','k1','Teak',31500,'brown','confirmed',31500)`);

    // Freezing the row against UPDATE while leaving DELETE open protects the evidence from being
    // edited and not from being removed — and removal is the more complete erasure of the two. The
    // task-4a seal does not cover this: it refuses deletes on a WITHDRAWN decision, and a decision
    // carrying a confirmed price is typically very much alive.
    expect(await refusal(`DELETE FROM "DecisionOption" WHERE "id" = '${id}'`))
      .toMatch(/not deletable/u);

    // …and a row trigger does not fire for TRUNCATE, so one statement would walk straight around it
    expect(await refusal(`TRUNCATE TABLE "DecisionOption" CASCADE`)).toMatch(/not erased by truncation/u);

    const [row] = await t.prisma.$queryRawUnsafe<Array<{ costAmount: number }>>(
      `SELECT "costAmount" FROM "DecisionOption" WHERE "id" = '${id}'`);
    expect(row.costAmount).toBe(31500);

    // PRECISION — an option carrying NO confirmed cost is ordinary data and deletes normally, and a
    // truncate that erases no confirmed cost is permitted. Refusing those would teach every fixture
    // reset to disable the seal as a matter of routine, and a seal disabled by habit is not a seal.
    const plain = `opt-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
       VALUES ('${plain}','${d}','Ordinary','k2','Birch',0,'tan')`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" = '${plain}'`);
  });

  // ── P10 (Codex round 1, P2) ─────────────────────────────────────────────────────────────────
  it('P10 a retired kind cannot be newly selected, and the default kind cannot be retired', async () => {
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-legacy','other','option.kind.a1Legacy')`);
    const d = await issue();
    const kept = `opt-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${kept}','${d}','Classified before retirement','k1','Teak',0,'brown','a1-legacy')`);

    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='a1-legacy'`);

    // The foreign key proves the code EXISTS, which is not the same as the menu still offering it.
    const fresh = `opt-a1-${run}-${seq++}`;
    expect(await refusal(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${fresh}','${d}','Too late','k2','Teak',0,'brown','a1-legacy')`,
    )).toMatch(/has been retired/u);

    // …and moving a DIFFERENT option onto the retired kind is the same act by another route. It has
    // to be a different one: re-writing `kept`'s code to the value it already holds changes nothing,
    // so the rule correctly ignores it.
    const mover = `opt-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
       VALUES ('${mover}','${d}','On the default kind','k3','Birch',0,'tan')`);
    expect(await refusal(
      `UPDATE "DecisionOption" SET "kindCode"='a1-legacy' WHERE "id"='${mover}'`,
    )).toMatch(/has been retired/u);

    // PRECISION — retiring is not deleting: the option classified before retirement keeps its
    // classification, and reads of it are untouched.
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ kindCode: string }>>(
      `SELECT "kindCode" FROM "DecisionOption" WHERE "id" = '${kept}'`);
    expect(row.kindCode).toBe('a1-legacy');

    // The DEFAULT kind is load-bearing for the running release, which does not name a kind at all
    // and therefore takes the default on every insert. Retiring it would take that release down by
    // a data edit.
    expect(await refusal(`UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='material'`))
      .toMatch(/column default/u);
  });

  // ── P11 (Codex round 1, P2) ─────────────────────────────────────────────────────────────────
  it('P11 the legacy and new cost representations may not disagree while both are read', async () => {
    const d = await issue();
    const mk = (delta: number, impact: string, amount: string): string => {
      const id = `opt-a1-${run}-${seq++}`;
      return `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","costImpact","costAmount")
              VALUES ('${id}','${d}','O','k${seq}','Teak',${delta},'brown','${impact}',${amount})`;
    };

    // The serving release returns only `delta`. A row that says 31,500 in the new state and 0 in the
    // old one displays as FREE to every client on that release…
    expect(await refusal(mk(0, 'estimated', '31500'))).toMatch(/delta_agrees_check/u);
    // …and the reverse displays as priced while the new state says it costs nothing.
    expect(await refusal(mk(31500, 'none', 'NULL'))).toMatch(/delta_agrees_check/u);

    // PRECISION — agreeing rows are accepted in every state the unit can produce
    await t.prisma.$executeRawUnsafe(mk(31500, 'estimated', '31500'));
    await t.prisma.$executeRawUnsafe(mk(0, 'none', 'NULL'));
    await t.prisma.$executeRawUnsafe(mk(28000, 'confirmed', '28000'));
  });

  // ── P12 (Codex round 1, P2) ─────────────────────────────────────────────────────────────────
  it('P12 the migration re-applies cleanly even after a real confirmed cost exists', async () => {
    const d = await issue();
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","costImpact","costAmount")
       VALUES ('opt-a1-${run}-${seq++}','${d}','Agreed','k1','Teak',31500,'brown','confirmed',31500)`);

    // The closing verification asserts the BACKFILL never manufactured a finality. Counted over the
    // whole table it would abort here — punishing the migration for somebody else's correct data the
    // moment the feature is used, and breaking the re-runnability it claims. Scoped to the rows this
    // run rewrote, a replay rewrites nothing and the question is trivially answered.
    const migrationPath = join(__dirname, '..', '..', 'prisma', 'migrations',
                               '20270915000000_decision_option_kinds', 'migration.sql');
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', url.toString(), '-f', migrationPath],
                 { encoding: 'utf8', stdio: 'pipe' });

    // …and the replay changed nothing about the confirmed row
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ costImpact: string; costAmount: number }>>(
      `SELECT "costImpact"::text AS "costImpact","costAmount" FROM "DecisionOption"
        WHERE "decisionId"='${d}' ORDER BY "id" DESC LIMIT 1`);
    expect(row.costImpact).toBe('confirmed');
    expect(row.costAmount).toBe(31500);
  });
});
