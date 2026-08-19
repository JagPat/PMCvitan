import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, wipeDecisions, type TwoProjectFixture } from './fixtures';

/**
 * Issue generalization unit A1-i — AN OPTION DECLARES WHAT KIND OF CHOICE IT IS.
 *
 * ONE concern: an option's own vocabulary. Today an option can only be read as a product choice, so
 * a question about technology, sequencing or a proposed remedy has to be dressed up as one or not
 * asked at all. This unit gives an option a KIND, drawn from a server-driven menu.
 *
 * No writer ships in this unit, so every probe goes at the database directly: during the expansion
 * phase direct SQL is the only writer these columns can have, and a rule that holds only when the
 * service cooperates is not a rule.
 *
 * Probes
 *   P1  the kind menu is SERVER-DRIVEN — four seeded base kinds, ordered, keyed for localization
 *       rather than carrying display strings
 *   P2  ROLLOUT: an insert that mentions only the legacy columns keeps its meaning, and is
 *       classified truthfully rather than left unclassified
 *   P3  a kind's base classification is frozen once anything is classified by it
 *   P4  an option must say WHAT IT IS — it names a material, or it describes itself
 *   P5  the kind reference is real, and a kind in use cannot be deleted or re-keyed
 *   P6  a retired kind cannot be newly selected, and the DEFAULT kind cannot be retired
 *   P7  the retired-kind rule holds against a CONCURRENT retirement — two real sessions
 *   P8  the migration re-applies cleanly, and its guards land on a database that already has the
 *       table
 */
describe('A1-i — the option kind vocabulary (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let raceDb: PrismaClient;
  let seq = 0;
  const run = Math.floor(Math.random() * 1e6);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // A SECOND connection, because P7 needs two sessions genuinely contending for one row. A
    // second transaction on the same client would be serialized by the pool rather than by
    // PostgreSQL, which is the opposite of what that probe is measuring.
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });

  // These probes never withdraw a decision, so `DecisionOption_t4a_frozen` is not in the way and
  // the options delete plainly. `wipeDecisions` is still the right way to remove the decisions
  // themselves: an APPROVED decision is permanent, and it disables exactly the named seals that
  // make it so, inside one transaction.
  const wipe = async (): Promise<void> => {
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`);
    await wipeDecisions(t.prisma, { id: { startsWith: 'DL-a1-' } });
    // Re-arm what a probe may have retired, so a suite that runs after this one still sees the
    // menu the migration seeded. `material` is guarded and can never be the row this repairs.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "active" = true WHERE "active" = false AND "code" NOT LIKE 'a1-%'`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOptionKind" WHERE "code" LIKE 'a1-%'`);
  };
  afterEach(wipe);
  afterAll(async () => {
    await wipe();
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });

  /** An issue. `photoSwatch` and `material` are still NOT NULL in this unit — relaxing the
   *  material half is a later unit, with the procurement qualification that protects it. */
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
    // and a menu row must actually say which key to look up
    expect(await refusal(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-blank','other','   ')`,
    )).toMatch(/labelKey_check/u);
  });

  // ── P2 ──────────────────────────────────────────────────────────────────────────────────────
  it('P2 rollout: an insert that mentions only the legacy columns keeps its meaning', async () => {
    const d = await issue();

    // The running release does not know `kindCode` exists and never mentions it. The column DEFAULT
    // is what keeps its inserts valid — and `material` is the TRUTHFUL default rather than a guess,
    // because in this unit an option still must name a material.
    await t.prisma.$executeRawUnsafe(legacyOption(d, { delta: 31500 }));
    const row = await one<{ kindCode: string; delta: number; material: string; description: string | null }>(
      `SELECT "kindCode","delta","material","description" FROM "DecisionOption"
        WHERE "decisionId"='${d}' ORDER BY "id" DESC LIMIT 1`,
    );
    expect(row.kindCode).toBe('material');
    // NOTHING ELSE about that option changed. This unit ships no second representation of any
    // existing fact, so `delta` is still the one and only statement about cost and this migration
    // has no opinion about it.
    expect(row.delta).toBe(31500);
    expect(row.material).toBe('Teak');
    expect(row.description).toBeNull();

    // …and NOT NULL means there is no such thing as an unclassified option, at any point in the
    // rollout — no permanent nulls for every future reader to special-case.
    const nulls = await one<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM "DecisionOption" WHERE "kindCode" IS NULL`);
    expect(Number(nulls.n)).toBe(0);
  });

  // ── P3 ──────────────────────────────────────────────────────────────────────────────────────
  it('P3 a kind’s base classification is frozen once anything is classified by it', async () => {
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

  // ── P4 ──────────────────────────────────────────────────────────────────────────────────────
  it('P4 an option must say what it is: it names a material, or it describes itself', async () => {
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
    // DESCRIPTION is already legal here, so when the material half becomes optional this same
    // constraint is already exactly the rule that matters, without being rewritten.
    await t.prisma.$executeRawUnsafe(mk(' ', "'A poured-in-place alternative to the panel system'"));
    await t.prisma.$executeRawUnsafe(mk('Teak', 'NULL'));
  });

  // ── P5 ──────────────────────────────────────────────────────────────────────────────────────
  it('P5 the kind reference is real, and a kind in use cannot be deleted or re-keyed', async () => {
    const d = await issue();
    const id = `opt-a1-${run}-${seq++}`;
    // A code naming no kind at all is reported by the FOREIGN KEY as what it is. It is deliberately
    // NOT reported as "retired": sending whoever hit it looking for a menu row that was never there
    // is a worse answer than no answer.
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

  // ── P6 ──────────────────────────────────────────────────────────────────────────────────────
  it('P6 a retired kind cannot be newly selected, and the default kind cannot be retired', async () => {
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

  // ── P7 ──────────────────────────────────────────────────────────────────────────────────────
  it('P7 the retired-kind rule holds against a CONCURRENT retirement', async () => {
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-race','other','option.kind.a1Race')`);
    const d = await issue();
    const id = `opt-a1-${run}-${seq++}`;
    const marker = `a1race${run}`;

    // Without a lock the classifying session reads `active = true`, the retirement commits, and the
    // insert then passes the foreign key and commits carrying a kind the menu no longer offers —
    // exactly the state the rule promises cannot exist.
    //
    // This probe is the experiment that decides the lock STRENGTH, and it fails if anyone weakens
    // it. `FOR KEY SHARE` would not do: a plain `SET active = false` is a NON-key update and takes
    // `FOR NO KEY UPDATE`, which does not conflict with `FOR KEY SHARE` — the retirement would sail
    // past and `blocked` below would be false.
    let signalReady!: () => void;
    let signalFailed!: (e: unknown) => void;
    let release!: () => void;
    const ready = new Promise<void>((res, rej) => { signalReady = res; signalFailed = rej; });
    const held = new Promise<void>((r) => { release = r; });
    const holder = t.prisma.$transaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
           VALUES ('${id}','${d}','Classified while the menu still offered it','k1','Teak',0,'brown','a1-race')`);
      } catch (e) { signalFailed(e); throw e; }
      signalReady();          // the FOR SHARE is HELD from here — a real acquisition barrier, not a sleep
      await held;
    }, { timeout: 30_000 }).then(() => undefined, (e) => { signalFailed(e); throw e; });
    await ready;

    // The retirement is DISPATCHED on the second connection (a Prisma raw promise is lazy, and an
    // undispatched one starts nothing at all) and its outcome captured.
    let retire: 'pending' | 'ok' | 'error' = 'pending';
    const retirement = raceDb.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='a1-race' /* ${marker} */`,
    ).then(() => { retire = 'ok'; }, () => { retire = 'error'; });

    // Blocking is OBSERVED in `pg_stat_activity` rather than assumed after a delay: on a loaded
    // runner a fixed sleep proves nothing about which session got there first.
    const blocked = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
            WHERE query LIKE '%${marker}%' AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
        if (Number(rows[0]?.n ?? 0) > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    })();
    expect(blocked, 'the retirement must WAIT for the classifying transaction').toBe(true);
    expect(retire).toBe('pending');

    release();
    await holder;
    await retirement;
    expect(retire).toBe('ok');

    // The coherent end state, and it is not "the retirement lost": the option classified while the
    // menu still offered the kind keeps its classification, because retiring is not deleting…
    const [kept] = await t.prisma.$queryRawUnsafe<Array<{ kindCode: string }>>(
      `SELECT "kindCode" FROM "DecisionOption" WHERE "id"='${id}'`);
    expect(kept.kindCode).toBe('a1-race');
    // …and the very next selection, which arrives after the retirement is visible, is refused.
    expect(await refusal(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('opt-a1-${run}-${seq++}','${d}','After','k2','Teak',0,'brown','a1-race')`,
    )).toMatch(/has been retired/u);
  });

  // ── P8 ──────────────────────────────────────────────────────────────────────────────────────
  it('P8 the migration re-applies cleanly, and its guards land on a table that already exists', async () => {
    const d = await issue();
    await t.prisma.$executeRawUnsafe(legacyOption(d, { delta: 31500 }));

    // `CREATE TABLE IF NOT EXISTS` is skipped WHOLESALE when the table already exists, and the table
    // CAN exist without this file having run: `schema.prisma` describes it, so a baseline or a
    // `db push`-shaped reconciliation produces the table, the columns and the foreign key — but
    // never a CHECK and never a trigger. A constraint written inline would then be silently absent
    // on exactly the databases that most need it. Dropping the constraints and re-applying the
    // migration is that database, reproduced: if any of them were inline, they would not come back.
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "DecisionOptionKind" DROP CONSTRAINT "DecisionOptionKind_labelKey_check"`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "DecisionOption" DROP CONSTRAINT "DecisionOption_says_what_it_is_check"`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "DecisionOption" DROP CONSTRAINT "DecisionOption_kind_fkey"`);

    const migrationPath = join(__dirname, '..', '..', 'prisma', 'migrations',
                               '20270920000000_decision_option_kinds', 'migration.sql');
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', url.toString(), '-f', migrationPath],
                 { encoding: 'utf8', stdio: 'pipe' });

    const back = await t.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT c."conname" FROM pg_constraint c
        WHERE c."conname" IN ('DecisionOptionKind_labelKey_check',
                              'DecisionOption_says_what_it_is_check','DecisionOption_kind_fkey')
          AND c."convalidated"`);
    expect(new Set(back.map((r) => r.conname))).toEqual(new Set([
      'DecisionOptionKind_labelKey_check', 'DecisionOption_says_what_it_is_check',
      'DecisionOption_kind_fkey',
    ]));

    // …and they are ENFORCING, not merely present
    expect(await refusal(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-post','other',' ')`,
    )).toMatch(/labelKey_check/u);

    // The replay left the seeded menu and the existing option exactly as they were: this migration
    // writes to no existing row, so a re-run has nothing to redo.
    const kinds = await t.prisma.$queryRawUnsafe<Array<{ code: string }>>(
      `SELECT "code" FROM "DecisionOptionKind" WHERE "code" NOT LIKE 'a1-%' ORDER BY "displayOrder"`);
    expect(kinds.map((r) => r.code)).toEqual(['material', 'technology', 'solution', 'other']);
    const row = await one<{ kindCode: string; delta: number }>(
      `SELECT "kindCode","delta" FROM "DecisionOption" WHERE "decisionId"='${d}' ORDER BY "id" DESC LIMIT 1`);
    expect(row.kindCode).toBe('material');
    expect(row.delta).toBe(31500);
  });
});
