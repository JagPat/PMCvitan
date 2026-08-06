import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { AUTHORITY_GUARDS } from '../../src/commercial/commercial.authority-guards';
import { dtoRaisedByLabels, writerRaisedByLabels } from '../../src/commercial/commercial.raisedby-sets';

/**
 * CLOSURE 10, DATABASE HALF — what PostgreSQL CURRENTLY ENFORCES, asked of PostgreSQL.
 *
 * `docs/reviews/pr-287-convergence.md` is the audit that put this file here. The closure's first
 * two heads each drew three findings and all six were one defect: it asked about live database
 * objects and answered by parsing migration text. Text cannot answer that question —
 *
 *   - a later `DROP` makes an earlier `ADD CONSTRAINT` a historical fact, not a live one;
 *   - a commented-out example is indistinguishable from executed DDL;
 *   - a `CREATE OR REPLACE FUNCTION` that no trigger runs refuses nothing;
 *   - a trigger's name and bound function say nothing about WHEN it fires;
 *   - and 41 of the 80 migrations wrap DDL in conditional `DO $$ BEGIN` blocks whose execution
 *     depends on runtime catalog predicates, so on more than half of them a regex replay is not
 *     approximating the answer, it is guessing.
 *
 * The catalog has none of those failure modes: it is the post-migration state however it was
 * reached. This follows the cleared `src/labour/t3c` precedent, whose seal notes name three of
 * those defects in advance — `pg_trigger` for attachment, EXACT `tgtype` ("equality, not a
 * bitmask") for firing, and byte-equal `pg_proc.prosrc` because `CREATE OR REPLACE` preserves a
 * function's identity, so a seal that stops at a function's NAME accepts a weakened body.
 *
 * The SOURCE half of the closure stays at the desk in `commercial.contract.test.ts`. Source text
 * is the authority for source facts; it is not the authority for this one.
 */
describe('CLOSURE 10 database half — the commercial seals, read from the live catalog', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  const raw = async <T>(sql: string, ...params: unknown[]): Promise<T[]> =>
    (await t.prisma.$queryRawUnsafe(sql, ...params)) as T[];

  /** `pg_trigger.tgtype` bits — `src/include/catalog/pg_trigger.h`. */
  const TG = { ROW: 1, BEFORE: 2, INSERT: 4, DELETE: 8, UPDATE: 16 } as const;
  /** AFTER INSERT OR UPDATE, FOR EACH ROW — what a deferred consume validator must be. */
  const AFTER_INSERT_UPDATE_ROW = TG.ROW + TG.INSERT + TG.UPDATE;

  interface LiveTrigger {
    tgname: string;
    tgtype: number;
    enabled: string;
    is_constraint: boolean;
    deferrable: boolean;
    initdeferred: boolean;
    fn: string;
    prosrc: string;
  }

  const triggersOn = (table: string): Promise<LiveTrigger[]> =>
    raw<LiveTrigger>(
      `SELECT t.tgname, t.tgtype::int AS tgtype, t.tgenabled AS enabled,
              (t.tgconstraint <> 0) AS is_constraint, t.tgdeferrable AS deferrable,
              t.tginitdeferred AS initdeferred, t.tgfoid::regproc::text AS fn,
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = t.tgfoid) AS prosrc
         FROM pg_trigger t
        WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal
        ORDER BY t.tgname`,
      `"${table}"`,
    );

  const constraintDef = async (name: string): Promise<string | null> => {
    const rows = await raw<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      name,
    );
    return rows[0]?.def ?? null;
  };

  // ── 1. the raisedBy set, against its AUTHORITY ────────────────────────────────────────────────

  it('the live BudgetException_raisedBy_check admits exactly the labels both source sets carry', async () => {
    const def = await constraintDef('BudgetException_raisedBy_check');
    expect(
      def,
      'no LIVE BudgetException_raisedBy_check in pg_constraint — nothing constrains the column, so the desk-level source agreement is being compared against a rule PostgreSQL is not applying',
    ).not.toBeNull();

    const admitted = [...def!.matchAll(/'([a-z_]+)'::text/gu)].map((m) => m[1]!).sort();
    expect(admitted.length, 'the live CHECK admits nothing — the parse is wrong').toBeGreaterThan(5);

    expect(
      dtoRaisedByLabels(),
      'the labels PostgreSQL admits and the labels the shared DTO declares are different sets: a label only the CHECK knows is one the server can return and every client is told is impossible',
    ).toEqual(admitted);
    expect(
      writerRaisedByLabels(),
      'the labels PostgreSQL admits and the movers `HeadroomMover` can write are different sets: a mover the type allows and the CHECK refuses fails at runtime with a green build',
    ).toEqual(admitted);
  });

  // ── 2. every SodGrant consumption target is named AND really validated ─────────────────────────

  /**
   * The consumption-target family, and the function that must validate each. Derived from the
   * schema below rather than trusted from here — this map only says which trigger OWNS each
   * target, and a target with no entry fails.
   */
  const CONSUME_VALIDATOR: Record<string, { trigger: string; fn: string; prosrcSha256: string }> = {
    consumedByCertificateId: {
      trigger: 'SodGrant_sealed',
      fn: 'phase5_t5_grant_sealed',
      prosrcSha256: '54265fe3058ee73c92be78c67b8f1ec838a5b5057fb24ee4a3558fca72215d6d',
    },
    consumedByApprovalId: {
      trigger: 'SodGrant_approval_consume_sealed',
      fn: 'phase5_t6a_grant_approval_consume_sealed',
      prosrcSha256: '670719cf027e35793159ab0cc850b95738fc4388037bd49ec07b5f9c6c372681',
    },
  };

  const consumptionFamily = (): string[] => {
    const schema = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    ) as string;
    const model = /model SodGrant \{([\s\S]*?)\n\}/u.exec(schema);
    expect(model, 'model SodGrant not found — the pin is not reading the schema').not.toBeNull();
    return [...model![1]!.matchAll(/^\s*(consumedBy[A-Za-z]*Id)\s+String\?/gmu)].map((m) => m[1]!);
  };

  it('the live XOR check names every consumption target the schema declares', async () => {
    const family = consumptionFamily();
    expect(
      family.length,
      'fewer than two consumption targets found — this pin exists because the family GREW, so parsing one member means the parse is wrong',
    ).toBeGreaterThan(1);

    const xor = await constraintDef('SodGrant_consumed_together');
    expect(
      xor,
      'no LIVE SodGrant_consumed_together in pg_constraint — the grant is not single-use at PostgreSQL at all, and naming targets is beside the point',
    ).not.toBeNull();

    for (const column of family) {
      expect(
        xor!.includes(`"${column}"`),
        `${column} is a consumption target and the live SodGrant_consumed_together CHECK does not mention it — the grant is single-use only for the targets the CHECK counts, so two targets can be stamped in one transaction`,
      ).toBe(true);
    }
  });

  it('every consumption target has an ATTACHED, enabled, DEFERRABLE INITIALLY DEFERRED row constraint trigger that fires on UPDATE and carries the canonical body', async () => {
    const family = consumptionFamily();
    const live = await triggersOn('SodGrant');
    expect(live.length, 'no live trigger is attached to SodGrant').toBeGreaterThan(0);

    for (const column of family) {
      const expected = CONSUME_VALIDATOR[column];
      expect(
        expected,
        `${column} is a consumption target with no entry in CONSUME_VALIDATOR — name the trigger that validates it, or it is a target nothing checks`,
      ).toBeDefined();

      const trg = live.find((x) => x.tgname === expected!.trigger);
      // attachment is the QUERY, not an inference from text
      expect(
        trg,
        `${expected!.trigger} is not ATTACHED to SodGrant in pg_trigger — a validating function that no trigger runs refuses nothing, which is exactly the state consumedByApprovalId shipped in`,
      ).toBeDefined();
      expect(trg!.enabled, `${expected!.trigger} is not enabled ('O')`).toBe('O');
      expect(
        trg!.is_constraint && trg!.deferrable && trg!.initdeferred,
        `${expected!.trigger} must be a DEFERRABLE INITIALLY DEFERRED constraint trigger: the service stamps the grant with updateMany and inserts the matching override LATER in the same transaction, so a non-deferred check fires before the override row exists`,
      ).toBe(true);
      // equality, not a bitmask: extra events are not harmless, and a missing UPDATE bit means the
      // consume path — which is an UPDATE — sails straight past it
      expect(
        trg!.tgtype,
        `${expected!.trigger} has tgtype ${trg!.tgtype}, expected ${AFTER_INSERT_UPDATE_ROW} (AFTER INSERT OR UPDATE, FOR EACH ROW). Missing events OR extra ones mean this is not that trigger`,
      ).toBe(AFTER_INSERT_UPDATE_ROW);
      expect(trg!.tgtype & TG.UPDATE, `${expected!.trigger} does not fire on UPDATE`).toBe(TG.UPDATE);
      expect(trg!.fn, `${expected!.trigger} is bound to ${trg!.fn}, not ${expected!.fn}`).toBe(expected!.fn);
      expect(
        trg!.prosrc.includes(`"${column}"`),
        `${expected!.fn} is attached but its live body never mentions ${column} — the trigger runs and the target is unvalidated`,
      ).toBe(true);

      // `CREATE OR REPLACE FUNCTION` preserves identity, so name + tgtype + attachment can all hold
      // while the body has been weakened. Byte-pin it (t3c precedent, hashed for size).
      const [{ sha }] = await raw<{ sha: string }>(
        `SELECT encode(digest(prosrc,'sha256'),'hex') AS sha FROM pg_proc WHERE proname = $1`,
        expected!.fn,
      );
      expect(
        sha,
        `${expected!.fn} is attached with the right timing but its body is NOT the canonical one. If the change was deliberate, re-pin the hash in CONSUME_VALIDATOR in the same commit that changes the migration`,
      ).toBe(expected!.prosrcSha256);
    }
  });

  // ── 3. every AUTHORITY_GUARDS seal really exists, and named helpers are really reached ─────────

  it('every seal AUTHORITY_GUARDS names is a LIVE object in the catalog', async () => {
    const named = AUTHORITY_GUARDS.map((r) => r.seal).filter((s): s is string => s !== null);
    expect(named.length, 'no seals named — AUTHORITY_GUARDS is not being read').toBeGreaterThan(5);

    for (const seal of [...new Set(named)]) {
      const [{ n }] = await raw<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM pg_constraint WHERE conname = $1)
         + (SELECT count(*) FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal)
         + (SELECT count(*) FROM pg_proc WHERE proname = $1)
         )::int AS n`,
        seal,
      );
      expect(
        n,
        `AUTHORITY_GUARDS names ${seal} as a seal and no constraint, trigger or function by that name exists in the live database — a named seal that never existed, or that a later migration dropped, is worse than an admitted gap`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * A seal named as a FUNCTION is only a seal if something runs it. `phase5_t6a_approval_override_valid`
   * is the override predicate both §I guards defer to; if a later migration weakens the callers and
   * leaves the helper defined, a presence test stays green while nothing proves the grant's
   * standing, version and consumption before accepting an override.
   */
  const HELPER_CALLERS: Record<string, string[]> = {
    phase5_t6a_approval_override_valid: [
      'PaymentApproval_approver_not_certifier',
      'SodException_approval_sealed',
    ],
  };

  it('every named helper seal is REACHED from the body of a live attached trigger', async () => {
    for (const [helper, callers] of Object.entries(HELPER_CALLERS)) {
      for (const trigger of callers) {
        const [row] = await raw<{ calls: boolean; enabled: string }>(
          `SELECT (p.prosrc LIKE '%' || $2 || '%') AS calls, t.tgenabled AS enabled
             FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgname = $1 AND NOT t.tgisinternal`,
          trigger,
          helper,
        );
        expect(row, `${trigger} is not attached to anything in the live catalog`).toBeDefined();
        expect(row!.enabled, `${trigger} is not enabled`).toBe('O');
        expect(
          row!.calls,
          `${trigger} no longer calls ${helper} — the helper is still defined, so a presence-only seal would stay green while the override path proves nothing`,
        ).toBe(true);
      }
    }
  });

  // ── 4. the closure is LOAD-BEARING: hostile catalog states, each rolled back ───────────────────

  /**
   * The probes above are only worth their runtime if they FAIL when the guarantee is removed. Each
   * of these mutates the live catalog inside a transaction, re-asks the closure's own question, and
   * rolls back — so the hostile state is real (not a mocked string) and leaves nothing behind.
   */
  const inRollback = async (fn: (tx: TestApp['prisma']) => Promise<void>): Promise<void> => {
    await t.prisma
      .$transaction(async (tx) => {
        await fn(tx as unknown as TestApp['prisma']);
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (!/__rollback__/u.test(e.message)) throw e;
      });
  };

  it('RED probe — dropping the consume trigger ATTACHMENT makes the closure fail', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      const rows = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = 'SodGrant_approval_consume_sealed' AND NOT tgisinternal`,
      )) as Array<{ n: number }>;
      // the FUNCTION is untouched and still mentions the column — which is precisely the state the
      // retired text parser called "validated"
      const fn = (await tx.$queryRawUnsafe(
        `SELECT (prosrc LIKE '%consumedByApprovalId%') AS m FROM pg_proc
          WHERE proname = 'phase5_t6a_grant_approval_consume_sealed'`,
      )) as Array<{ m: boolean }>;
      expect(fn[0]!.m, 'fixture invalid: the function body should still mention the column').toBe(true);
      expect(rows[0]!.n, 'the attachment is gone and the catalog closure must see that').toBe(0);
    });
  });

  it('RED probe — a weakened helper caller makes the closure fail while the helper still exists', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_approver_not_certifier() RETURNS trigger AS $weak$
        BEGIN
          RETURN NEW;
        END;
        $weak$ LANGUAGE plpgsql`);
      const [row] = (await tx.$queryRawUnsafe(
        `SELECT (p.prosrc LIKE '%phase5_t6a_approval_override_valid%') AS calls
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'PaymentApproval_approver_not_certifier' AND NOT t.tgisinternal`,
      )) as Array<{ calls: boolean }>;
      const [{ n }] = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'phase5_t6a_approval_override_valid'`,
      )) as Array<{ n: number }>;
      expect(n, 'the helper itself is still defined — a presence test would pass here').toBe(1);
      expect(row!.calls, 'the caller no longer reaches the helper and the closure must see that').toBe(false);
    });
  });

  it('RED probe — re-declaring the consume trigger with the wrong timing changes its tgtype', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      // same name, same function, attached — and INSERT-only, so every consume UPDATE sails past
      await tx.$executeRawUnsafe(`
        CREATE CONSTRAINT TRIGGER "SodGrant_approval_consume_sealed"
          AFTER INSERT ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_grant_approval_consume_sealed()`);
      const [row] = (await tx.$queryRawUnsafe(
        `SELECT tgtype::int AS tgtype FROM pg_trigger
          WHERE tgname = 'SodGrant_approval_consume_sealed' AND NOT tgisinternal`,
      )) as Array<{ tgtype: number }>;
      expect(row!.tgtype, 'fixture invalid: expected an INSERT-only row trigger').toBe(TG.ROW + TG.INSERT);
      expect(
        row!.tgtype === AFTER_INSERT_UPDATE_ROW,
        'an attached, enabled, correctly-bound, DEFERRABLE trigger that does not fire on UPDATE must NOT satisfy the closure',
      ).toBe(false);
      expect(row!.tgtype & TG.UPDATE, 'the hostile trigger fires on UPDATE, so the probe proves nothing').toBe(0);
    });
  });

  it('RED probe — a DROPped CHECK is invisible to the catalog even though the migration text still ADDs it', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together"');
      const [{ n }] = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'SodGrant_consumed_together'`,
      )) as Array<{ n: number }>;
      expect(
        n,
        'the CHECK is dropped; the migration files still contain its ADD CONSTRAINT verbatim, which is exactly why text is not the authority',
      ).toBe(0);
    });
  });

  // ── 5. why the substrate moved: the retired parser, shown accepting each hostile state ─────────

  /**
   * These reproduce the RETIRED design's answers on the same states, with no database. They are
   * kept because the convergence audit's claim is not "the parser had bugs" but "the parser cannot
   * answer this question", and a claim like that should be executable rather than asserted.
   *
   * Each fixture is migration TEXT; each assertion shows the parser reporting a guarantee the live
   * catalog above does not make.
   */
  const retiredLiveCheckBody = (sql: string, constraint: string): string | null => {
    const stream = new RegExp(
      `DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?"${constraint}"`
        + `|ADD\\s+CONSTRAINT\\s+"${constraint}"\\s*CHECK\\s*\\(([\\s\\S]*?)\\);`,
      'gu',
    );
    let live: string | null = null;
    for (const op of sql.matchAll(stream)) live = op[1] ?? null;
    return live;
  };

  it('the retired parser accepts a COMMENTED example as live DDL', () => {
    const sql = [
      'ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together";',
      '-- for reference, the shape we used to install was:',
      '--   ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together" CHECK ("consumedAt" IS NULL);',
    ].join('\n');
    expect(
      retiredLiveCheckBody(sql, 'SodGrant_consumed_together'),
      'the retired parser reads a commented example as an installed CHECK; PostgreSQL has nothing here',
    ).not.toBeNull();
  });

  it('the retired parser cannot evaluate a conditional DO block, which 41 of 80 migrations use', () => {
    const sql = [
      'DO $$ BEGIN',
      '  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = \'SodGrant_consumed_together\') THEN',
      '    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together" CHECK ("consumedAt" IS NULL);',
      '  END IF;',
      'END $$;',
    ].join('\n');
    // The parser returns a body unconditionally. Whether PostgreSQL ran it depends on a predicate
    // evaluated against the catalog at deploy time — which the parser has no way to consult.
    expect(
      retiredLiveCheckBody(sql, 'SodGrant_consumed_together'),
      'the retired parser reports this as installed regardless of the IF NOT EXISTS predicate',
    ).not.toBeNull();
  });
});
