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
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`);
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
    const base = (impact: string, amount: string): string => {
      const id = `opt-a1-${run}-${seq++}`;
      return `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","costImpact","costAmount")
              VALUES ('${id}','${d}','O','k${seq}','Teak',0,'brown','${impact}',${amount})`;
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
});
