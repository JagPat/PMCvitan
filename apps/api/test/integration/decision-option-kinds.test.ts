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
 *   P7  the retired-kind rule holds against a CONCURRENT retirement, in every ordering — the
 *       retirement landing mid-transaction, still in flight at commit, and abandoned
 *   P8  the migration re-applies cleanly, and its guards land on a database that already has the
 *       table
 *   P9  a kind INSERTED inactive concurrently cannot capture an option (the round-1 hole)
 *   P10 the kind the column DEFAULTS to cannot be removed by DELETE, re-key or retirement
 *   P11 the objects the migration creates carry the names schema.prisma implies
 *   P12 the enum guard asks about the type this migration actually uses
 *   P13 an option's kind is frozen once it is named by approval evidence
 *   P14 the DEFAULT kind's base classification cannot be re-pointed, even with zero options
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
  // Each step is attempted INDEPENDENTLY, and that is a correction rather than a style choice. A
  // wipe that aborts on its first failing step leaves everything after it undone, and one stuck row
  // then fails every later probe in the file — observed three times while writing this suite, each
  // time presenting as a dozen unrelated failures rather than as one broken teardown. The last
  // error is re-thrown so a genuinely broken reset is still loud.
  const wipe = async (): Promise<void> => {
    let firstError: unknown = null;
    const step = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      try { await run(); } catch (e) {
        firstError ??= new Error(`teardown step "${what}" failed: ${String(e)}`);
      }
    };
    /** Disable ONE named seal for exactly this delete, inside a single transaction — the
     *  repository's sanctioned destructive-reset contract (`wipeDecisionsVia` does the same).
     *  PostgreSQL DDL is transactional, so a throw rolls the disable back with it. */
    const sealed = (table: string, trigger: string, sql: string) => () =>
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        await tx.$executeRawUnsafe(sql);
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      }, { timeout: 60_000, maxWait: 30_000 });

    // The approval register, the legacy stamp and the approval event are all immutable BY DESIGN —
    // which is exactly why this suite plants real ones: an arm of the freeze that no probe can
    // reach is a check nobody knows works.
    await step('approval register', sealed('DecisionApprovalRevision',
      'DecisionApprovalRevision_append_only',
      `DELETE FROM "DecisionApprovalRevision" WHERE "decisionId" LIKE 'DL-a1-%'`));
    await step('legacy approval stamps', sealed('DecisionLegacyApproval',
      'DecisionLegacyApproval_sealed',
      `DELETE FROM "DecisionLegacyApproval" WHERE "decisionId" LIKE 'DL-a1-%'`));
    await step('approval events', sealed('DecisionEvent',
      'DecisionEvent_no_withdrawn_approval',
      `DELETE FROM "DecisionEvent" WHERE "decisionId" LIKE 'DL-a1-%'`));
    await step('options', () => t.prisma.$executeRawUnsafe(
      `DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`));
    await step('decisions', () => wipeDecisions(t.prisma, { id: { startsWith: 'DL-a1-' } }));
    // Re-arm what a probe may have retired, so a suite running after this one still sees the menu
    // the migration seeded. `material` is guarded and can never be the row this repairs.
    await step('re-arm the menu', () => t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "active" = true WHERE "active" = false AND "code" NOT LIKE 'a1-%'`));
    await step('suite kinds', () => t.prisma.$executeRawUnsafe(
      `DELETE FROM "DecisionOptionKind" WHERE "code" LIKE 'a1-%'`));
    if (firstError) throw firstError;
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
    )).toMatch(/kindCode_fkey/u);

    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-x','other','option.kind.a1X')`);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${id}','${d}','O','k1','Teak',0,'brown','a1-x')`);

    // deleting or re-keying a kind an option carries would leave that option classified by nothing
    expect(await refusal(`DELETE FROM "DecisionOptionKind" WHERE "code"='a1-x'`)).toMatch(/kindCode_fkey/u);
    expect(await refusal(`UPDATE "DecisionOptionKind" SET "code"='a1-y' WHERE "code"='a1-x'`))
      .toMatch(/kindCode_fkey/u);
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

  // ── P7 (Codex round 1, finding 1) ───────────────────────────────────────────────────────────
  //
  // The rule is enforced at COMMIT, so these probes are about what is true when the transaction
  // LANDS rather than when the statement runs. Three orderings, because the interesting ones are
  // exactly the two the round-1 BEFORE trigger could not see.
  it('P7 the retired-kind rule holds against a CONCURRENT retirement, in every ordering', async () => {
    const d = await issue();

    /** Hold a transaction open at a REAL barrier — a promise resolved after its statement returns,
     *  never a sleep, which on a loaded runner proves nothing about who got there first. */
    const hold = (body: (tx: typeof t.prisma) => Promise<unknown>, db: PrismaClient) => {
      let ready!: () => void; let failed!: (e: unknown) => void; let release!: () => void;
      const onReady = new Promise<void>((res, rej) => { ready = res; failed = rej; });
      const held = new Promise<void>((r) => { release = r; });
      let settled: 'pending' | 'ok' | 'error' = 'pending';
      let error: unknown = null;
      const done = db.$transaction(async (tx) => {
        try { await body(tx as unknown as typeof t.prisma); } catch (e) { failed(e); throw e; }
        ready(); await held;
      }, { timeout: 30_000 }).then(
        () => { settled = 'ok'; }, (e) => { settled = 'error'; error = e; failed(e); });
      return { onReady, release, done, state: () => settled, error: () => error };
    };

    /** Wait until SOME other backend is blocked inside COMMIT — which is where a deferred
     *  constraint trigger takes its lock. Observed, not assumed after a delay. */
    const someoneBlockedInCommit = async (ms = 5000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const rows = await raceDb.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
            WHERE query = 'COMMIT' AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
        if (Number(rows[0]?.n ?? 0) > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };

    const kind = async (code: string): Promise<void> => {
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('${code}','other','option.kind.${code}')`);
    };
    const classify = (code: string, id: string) => (tx: typeof t.prisma) => tx.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       VALUES ('${id}','${d}','O','k-${id}','Teak',0,'brown','${code}')`);

    // ORDERING 1 — the retirement lands BETWEEN the option's insert and its commit.
    // The round-1 BEFORE trigger read the menu at INSERT time and passed; this is the window that
    // made its verdict stale. Nothing blocks here: the insert's own foreign-key check takes only
    // FOR KEY SHARE, which does not conflict with the retirement's FOR NO KEY UPDATE.
    await kind('a1-r1');
    const h1 = hold(classify('a1-r1', `opt-a1-${run}-${seq++}`), t.prisma);
    await h1.onReady;
    await raceDb.$executeRawUnsafe(`UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='a1-r1'`);
    h1.release();
    await h1.done;
    expect(h1.state(), 'a selection whose kind was retired before it committed must be refused').toBe('error');
    expect(String(h1.error())).toMatch(/has been retired/u);

    // ORDERING 2 — the retirement is STILL IN FLIGHT when the option commits.
    // This is where the lock strength is decided, and the probe fails if anyone weakens it:
    // `FOR KEY SHARE` does NOT conflict with the `FOR NO KEY UPDATE` a plain `SET active = false`
    // takes, so the commit would sail through and `blocked` below would be false.
    await kind('a1-r2');
    const retire = hold((tx) => tx.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='a1-r2'`), raceDb);
    await retire.onReady;
    const h2 = hold(classify('a1-r2', `opt-a1-${run}-${seq++}`), t.prisma);
    await h2.onReady;
    h2.release();                       // the commit begins — and must WAIT for the retirement
    const blocked = await someoneBlockedInCommit();
    expect(blocked, 'the commit must WAIT for the in-flight retirement').toBe(true);
    expect(h2.state()).toBe('pending');
    retire.release();
    await retire.done;
    await h2.done;
    expect(h2.state()).toBe('error');
    expect(String(h2.error())).toMatch(/has been retired/u);

    // ORDERING 3, PRECISION — the same wait, but the retirement ROLLS BACK. We wait for the real
    // answer, not merely for the presence of a concurrent retirement, so this selection stands.
    await kind('a1-r3');
    const kept = `opt-a1-${run}-${seq++}`;
    let abandon!: () => void;
    const abandoned = new Promise<void>((r) => { abandon = r; });
    const rolledBack = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='a1-r3'`);
      await abandoned;
      throw new Error('deliberate rollback');       // the retirement never happened
    }, { timeout: 30_000 }).catch(() => undefined);
    const h3 = hold(classify('a1-r3', kept), t.prisma);
    await h3.onReady;
    h3.release();
    expect(await someoneBlockedInCommit(), 'the commit must wait here too').toBe(true);
    abandon();
    await rolledBack;
    await h3.done;
    expect(h3.state(), 'an abandoned retirement must not refuse a legitimate selection').toBe('ok');
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ kindCode: string }>>(
      `SELECT "kindCode" FROM "DecisionOption" WHERE "id"='${kept}'`);
    expect(row.kindCode).toBe('a1-r3');
    const stillActive = await one<{ active: boolean }>(
      `SELECT "active" FROM "DecisionOptionKind" WHERE "code"='a1-r3'`);
    expect(stillActive.active).toBe(true);
  });

  // ── P9 (Codex round 1, finding 1 — the exact reproduction) ──────────────────────────────────
  it('P9 a kind INSERTED inactive concurrently cannot capture an option', async () => {
    const d = await issue();

    // THE ROUND-1 HOLE, reproduced. Its mechanism is worth stating precisely, because the obvious
    // reading is wrong: the foreign key does NOT block waiting for a concurrent inserter — a plain
    // racing insert is refused in milliseconds. What leaked is the SNAPSHOT. The FK's check is an
    // AFTER trigger that takes a FRESH snapshot at the END of the statement, so:
    //
    //   1. the option's BEFORE trigger read the menu and found nothing (kind still uncommitted),
    //      and a missing row deliberately fell through so the FK could name an unknown code;
    //   2. the kind committed, `active = false`;
    //   3. the FK's fresh snapshot saw it and passed.
    //
    // The statement below stages exactly that: row 1 names the uncommitted kind, row 2 sleeps while
    // the other session commits, and the FK checks fire afterwards for both.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const onReady = new Promise<void>((r) => { ready = r; });
    const inserter = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey","active")
         VALUES ('a1-born-closed','other','option.kind.a1BornClosed',false)`);
      ready();
      await held;
    }, { timeout: 30_000 });
    await onReady;

    const captured = `opt-a1-${run}-${seq++}`;
    const filler = `opt-a1-${run}-${seq++}`;
    const racing = t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindCode")
       SELECT CASE WHEN i = 1 THEN '${captured}' ELSE '${filler}' END, '${d}', 'O', 'kbc' || i, 'Teak', 0,
              CASE WHEN i = 2 THEN (SELECT 'brown' FROM (SELECT pg_sleep(3)) z) ELSE 'brown' END,
              CASE WHEN i = 1 THEN 'a1-born-closed' ELSE 'material' END
         FROM generate_series(1, 2) i`,
    ).then(() => null, (e: unknown) => e);

    // The kind must commit while that statement is genuinely MID-FLIGHT, and a fixed delay does not
    // establish that: on a loaded runner the racing statement may not have started, the kind commits
    // first, and the probe then passes for the wrong reason — the corrected rule refuses an
    // already-visible inactive kind whether or not the snapshot window was ever entered. A probe
    // that cannot fail for the reason it names is not evidence. So wait for the DATABASE to show
    // the statement has reached its sleeping row, then release.
    const midFlight = await (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const rows = await raceDb.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
            WHERE query LIKE '%a1-born-closed%' AND query NOT LIKE '%pg_stat_activity%'
              AND state = 'active' AND wait_event = 'PgSleep' AND pid <> pg_backend_pid()`);
        if (Number(rows[0]?.n ?? 0) > 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    })();
    expect(midFlight, 'the racing statement must be observed in flight before the kind commits').toBe(true);
    release();
    await inserter;

    const err = await racing;
    expect(err, 'a kind that was never active must not capture an option').not.toBeNull();
    expect(String(err)).toMatch(/has been retired/u);

    // and NOTHING from that statement survived — the transaction is refused whole
    const survivors = await one<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM "DecisionOption" WHERE "id" IN ('${captured}','${filler}')`);
    expect(Number(survivors.n)).toBe(0);

    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOptionKind" WHERE "code"='a1-born-closed'`);
  });

  // ── P10 (Codex round 1, finding 3, and the sibling it implies) ──────────────────────────────
  it('P10 the kind the column DEFAULTS to cannot be removed by any route', async () => {
    // On a populated database the foreign key protects `material`. On an option-EMPTY one — a fresh
    // install, exactly where it would go unnoticed — nothing did. Round 1 guarded only retirement
    // and missed the two other ways to remove the same thing.
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`);

    expect(await refusal(`DELETE FROM "DecisionOptionKind" WHERE "code"='material'`))
      .toMatch(/column default/u);
    expect(await refusal(`UPDATE "DecisionOptionKind" SET "code"='materials' WHERE "code"='material'`))
      .toMatch(/column default/u);
    expect(await refusal(`UPDATE "DecisionOptionKind" SET "active"=false WHERE "code"='material'`))
      .toMatch(/column default/u);

    // PRECISION — the guard is about the DEFAULT, not about menu rows in general: an ordinary
    // unreferenced kind is still ordinary data and deletes plainly.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-spare','other','option.kind.a1Spare')`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOptionKind" WHERE "code"='a1-spare'`);

    // …and the default it protects is READ FROM THE COLUMN, not remembered: this is the value the
    // running release actually takes, so the guard follows a later change instead of going stale.
    const def = await one<{ d: string }>(
      `SELECT pg_get_expr(a.adbin, a.adrelid) AS d FROM pg_attrdef a
        JOIN pg_attribute c ON c.attrelid=a.adrelid AND c.attnum=a.adnum
       WHERE a.adrelid='public."DecisionOption"'::regclass AND c.attname='kindCode'`);
    expect(def.d).toMatch(/'material'/u);
  });

  // ── P11 (Codex round 1, finding 2) ──────────────────────────────────────────────────────────
  it('P11 the objects this migration creates carry the names schema.prisma implies', async () => {
    // `migrate diff` reported two entries for this unit: an index the model did not declare, and a
    // foreign key whose name did not match Prisma's convention for the relation. Either one makes
    // later migration generation emit corrective DDL for a schema that is actually fine. Both are
    // pinned here so a rename cannot silently reintroduce the drift.
    //
    // Honest scope: the repository already carries this drift widely on merged tables (207 entries
    // at this base). This does not clean that up — it only declines to add to it.
    const objects = await t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT conname AS name FROM pg_constraint
        WHERE conrelid='public."DecisionOption"'::regclass AND contype='f'
          AND conname LIKE '%kind%'
       UNION ALL
       SELECT indexname AS name FROM pg_indexes
        WHERE schemaname='public' AND tablename='DecisionOption' AND indexname LIKE '%kind%'`);
    expect(new Set(objects.map((o) => o.name)))
      .toEqual(new Set(['DecisionOption_kindCode_fkey', 'DecisionOption_kindCode_idx']));
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
      `ALTER TABLE "DecisionOption" DROP CONSTRAINT "DecisionOption_kindCode_fkey"`);

    const migrationPath = join(__dirname, '..', '..', 'prisma', 'migrations',
                               '20270920000000_decision_option_kinds', 'migration.sql');
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', url.toString(), '-f', migrationPath],
                 { encoding: 'utf8', stdio: 'pipe' });

    const back = await t.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT c."conname" FROM pg_constraint c
        WHERE c."conname" IN ('DecisionOptionKind_labelKey_check',
                              'DecisionOption_says_what_it_is_check','DecisionOption_kindCode_fkey')
          AND c."convalidated"`);
    expect(new Set(back.map((r) => r.conname))).toEqual(new Set([
      'DecisionOptionKind_labelKey_check', 'DecisionOption_says_what_it_is_check',
      'DecisionOption_kindCode_fkey',
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

  // ── P12 (Codex round 2, F1) ─────────────────────────────────────────────────────────────────
  it('P12 the enum guard asks about the type this migration actually uses', async () => {
    // `pg_type.typname` is not schema-qualified, so a same-named type in ANY schema satisfies a
    // database-wide EXISTS — and the guard then skips creating the one on the search path.
    await t.prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS a1_decoy`);
    await t.prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS a1_decoy."OptionBaseKind"`);
    await t.prisma.$executeRawUnsafe(`CREATE TYPE a1_decoy."OptionBaseKind" AS ENUM ('x')`);
    try {
      const bare = await one<{ n: bigint }>(
        `SELECT COUNT(*) AS n FROM pg_type WHERE typname = 'OptionBaseKind'`);
      expect(Number(bare.n), 'the decoy makes the unqualified test ambiguous').toBeGreaterThan(1);

      // the qualified question is unmoved by it, and re-applying the migration is still a no-op
      const scoped = await one<{ present: boolean }>(
        `SELECT to_regtype('public."OptionBaseKind"') IS NOT NULL AS present`);
      expect(scoped.present).toBe(true);

      const migrationPath = join(__dirname, '..', '..', 'prisma', 'migrations',
                                 '20270920000000_decision_option_kinds', 'migration.sql');
      const url = new URL(process.env.DATABASE_URL!);
      url.search = '';
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', url.toString(), '-f', migrationPath],
                   { encoding: 'utf8', stdio: 'pipe' });
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS a1_decoy CASCADE`);
    }
  });

  // ── P13 (Codex round 2 F2; #370 round 1 F1/F2/F3) ──────────────────────────────────────────
  it('P13 an option’s identity is frozen once its decision carries approval evidence', async () => {
    const mk = async (status: string): Promise<{ d: string; id: string }> => {
      const d = `DL-a1-${run}-${seq++}`;
      const id = `opt-a1-${run}-${seq++}`;
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "Decision"("id","projectId","title","room","status","photoSwatch","authorId")
         VALUES ('${d}','${f.projectA.id}','Which approach?','Hall','${status}','stone','${f.memberUser.id}')`);
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","description")
         VALUES ('${id}','${d}','Teak veneer','ka','Teak',0,'brown','Veneered ply, matt finish')`);
      return { d, id };
    };

    // while nothing has been approved, both columns are ordinary editable data
    const pending = await mk('pending');
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOption" SET "kindCode"='technology' WHERE "id"='${pending.id}'`);
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOption" SET "description"='A poured alternative' WHERE "id"='${pending.id}'`);

    // BOTH identity columns are frozen, not just the kind — an option identified by its
    // description has the same identity at stake as one identified by its kind.
    const approved = await mk('approved');
    expect(await refusal(`UPDATE "DecisionOption" SET "kindCode"='technology' WHERE "id"='${approved.id}'`))
      .toMatch(/cannot be edited/u);
    expect(await refusal(`UPDATE "DecisionOption" SET "description"='precast panels' WHERE "id"='${approved.id}'`))
      .toMatch(/cannot be edited/u);

    // EVERY durable approval signal counts, not only the newest register. An upgraded database can
    // carry an approved decision with no revision row at all.
    const legacy = await mk('pending');
    // That stamp table is migration-owned and sealed against ordinary inserts, which is correct —
    // so the fixture uses the repository's sanctioned bypass (disable the ONE named seal inside a
    // single transaction). Planting it for real matters: an arm of the guard no probe can reach is
    // a check nobody knows works, which is the failure this suite keeps guarding against.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "DecisionLegacyApproval" DISABLE TRIGGER "DecisionLegacyApproval_sealed"');
      await tx.$executeRawUnsafe(
        `INSERT INTO "DecisionLegacyApproval"("decisionId","stampedAt") VALUES ('${legacy.d}', now())`);
      await tx.$executeRawUnsafe(
        'ALTER TABLE "DecisionLegacyApproval" ENABLE TRIGGER "DecisionLegacyApproval_sealed"');
    }, { timeout: 60_000, maxWait: 30_000 });
    expect(await refusal(`UPDATE "DecisionOption" SET "kindCode"='technology' WHERE "id"='${legacy.id}'`))
      .toMatch(/legacy approval stamp/u);

    const evented = await mk('pending');
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionEvent"("id","decisionId","type","actor","at")
       VALUES ('ev-a1-${run}-${seq++}','${evented.d}','approved','pmc', now())`);
    expect(await refusal(`UPDATE "DecisionOption" SET "description"='changed' WHERE "id"='${evented.id}'`))
      .toMatch(/recorded approval event/u);

    // `change` means approved-then-questioned, NOT never-approved
    const changed = await mk('change');
    expect(await refusal(`UPDATE "DecisionOption" SET "kindCode"='solution' WHERE "id"='${changed.id}'`))
      .toMatch(/decision is change/u);

    // PRECISION, and the honest boundary of this unit: `material` on an approved option is STILL
    // editable. That is pre-existing and belongs to the approval register's own unit — asserted
    // here so the limit is recorded rather than assumed away.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOption" SET "material"='Walnut' WHERE "id"='${approved.id}'`);
    const row = await one<{ material: string; kindCode: string }>(
      `SELECT "material","kindCode" FROM "DecisionOption" WHERE "id"='${approved.id}'`);
    expect(row.material).toBe('Walnut');
    expect(row.kindCode).toBe('material');
  });

  // ── P13b (#370 round 1, F3) ─────────────────────────────────────────────────────────────────
  it('P13b an approval landing concurrently cannot be outrun by a reclassification', async () => {
    // Under READ COMMITTED a plain EXISTS cannot see an approval that has not committed, and the
    // register's foreign key takes only KEY SHARE on the option — which does NOT conflict with the
    // non-key UPDATE reclassifying it. Both would commit, and the evidence would then describe
    // something the approver never chose. Locking the DECISION row is what makes them serialize,
    // and it holds because every durable approval signal is ALREADY written under that same lock:
    // `DecisionApprovalRevision_no_withdrawn` and `DecisionEvent_no_withdrawn_approval` each take
    // `FOR UPDATE` on the parent before judging it. The serialization is therefore a property of
    // the database rather than of a service being careful.
    //
    // Both approval routes are raced, because they take that lock for different reasons: the
    // status UPDATE locks the row it is WRITING, while the register INSERT locks a row it only
    // READS. The second is the shape the finding named, and the one that would be easy to get
    // wrong by assuming the first covers it.
    const raceAgainst = async (
      approve: (tx: { $executeRawUnsafe: (sql: string) => Promise<unknown> }, d: string) => Promise<unknown>,
      expected: RegExp,
    ): Promise<void> => {
      const d = `DL-a1-${run}-${seq++}`;
      const id = `opt-a1-${run}-${seq++}`;
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "Decision"("id","projectId","title","room","status","photoSwatch","authorId")
         VALUES ('${d}','${f.projectA.id}','Q','Hall','pending','stone','${f.memberUser.id}')`);
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
         VALUES ('${id}','${d}','Teak','ka','Teak',0,'brown')`);

      let ready!: () => void; let release!: () => void;
      const onReady = new Promise<void>((r) => { ready = r; });
      const held = new Promise<void>((r) => { release = r; });
      const approving = raceDb.$transaction(async (tx) => {
        await approve(tx, d);
        ready();
        await held;
      }, { timeout: 30_000 });
      await onReady;

      let outcome: 'pending' | 'ok' | 'error' = 'pending';
      let err: unknown = null;
      const racing = t.prisma.$executeRawUnsafe(
        `UPDATE "DecisionOption" SET "kindCode"='technology' WHERE "id"='${id}'`)
        .then(() => { outcome = 'ok'; }, (e) => { outcome = 'error'; err = e; });

      // it must BLOCK on the decision row rather than read a stale "nothing approved yet"
      const blocked = await (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const rows = await raceDb.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
              WHERE query LIKE '%${id}%' AND query NOT LIKE '%pg_stat_activity%'
                AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
          if (Number(rows[0]?.n ?? 0) > 0) return true;
          await new Promise((r) => setTimeout(r, 25));
        }
        return false;
      })();
      expect(blocked, 'the reclassification must wait for the in-flight approval').toBe(true);

      release();
      await approving;
      await racing;
      expect(outcome, 'and then be refused, because by commit time the approval IS there').toBe('error');
      expect(String(err)).toMatch(expected);

      const row = await one<{ kindCode: string }>(
        `SELECT "kindCode" FROM "DecisionOption" WHERE "id"='${id}'`);
      expect(row.kindCode).toBe('material');
    };

    // (a) the approval WRITES the decision row
    await raceAgainst(
      (tx, d) => tx.$executeRawUnsafe(`UPDATE "Decision" SET "status"='approved' WHERE "id"='${d}'`),
      /decision is approved/u);

    // (b) the approval writes only the REGISTER and leaves the decision's own status alone — the
    // exact shape the finding named. Its entry seal reads the parent FOR UPDATE to judge
    // withdrawal, so this transaction holds the same row lock without ever writing to it.
    await raceAgainst(
      (tx, d) => tx.$executeRawUnsafe(
        `INSERT INTO "DecisionApprovalRevision"("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
         VALUES ('ar-a1-${run}-${seq++}','${f.projectA.id}','${d}',1,'ka', now(),'${f.memberUser.id}')`),
      /entry in the approval register/u);
  });

  // ── P14 (Codex round 2, F3) ─────────────────────────────────────────────────────────────────
  it('P14 the DEFAULT kind cannot be re-pointed, even before anything references it', async () => {
    // The option-EMPTY database is exactly where this matters: nothing references `material` yet,
    // so the in-use test is false, while every later insert from the serving release takes this
    // default and would be read as whatever it was re-pointed to.
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`);
    const inUse = await one<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM "DecisionOption" WHERE "kindCode"='material'`);
    expect(Number(inUse.n), 'this probe is only meaningful with the default unreferenced').toBe(0);

    expect(await refusal(`UPDATE "DecisionOptionKind" SET "baseKind"='technology' WHERE "code"='material'`))
      .toMatch(/base kind cannot be re-pointed/u);

    // PRECISION — an ordinary unreferenced kind is still ordinary data
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('a1-free','other','option.kind.a1Free')`);
    await t.prisma.$executeRawUnsafe(
      `UPDATE "DecisionOptionKind" SET "baseKind"='solution' WHERE "code"='a1-free'`);
  });
});
