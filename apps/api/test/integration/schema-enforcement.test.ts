import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationSchema,
  checkEnforcement,
  ENFORCING_SESSION_ROLES,
  REQUIRED_RI_TRIGGERS,
  SAMPLE_LIMIT,
  summarizeEnforcement,
} from '../../src/platform/enforcement/enforcement-check';

/**
 * Schema enforcement — REPRODUCE-FIRST, against a live PostgreSQL.
 *
 * Every forgery below was EXECUTED before the check existed and was ACCEPTED: the orphaned row in
 * the `DISABLE TRIGGER ALL` probe committed against a foreign key whose `convalidated` stayed
 * `true`, and the `R`-mode seal did not raise. Those are the states this suite now refuses.
 *
 * The forgeries run on a DEDICATED SCRATCH DATABASE, created and dropped here. They must, for two
 * reasons: the integration suites share one database, so a probe that disabled a trigger and died
 * would poison every later suite; and the properties under test are universal over a schema, so
 * they are stated most clearly over a schema small enough to read in one screen. The final probe
 * then asks the REAL migrated application database — read-only — and requires it to be CLEAN, so
 * the check is shown to be PRECISE and not merely strict.
 */

const BASE = process.env.DATABASE_URL ?? '';
const SCRATCH_DB = 'pmcvitan_enforcement_probe';

function urlFor(database: string): string {
  const url = new URL(BASE);
  url.pathname = `/${database}`;
  return url.toString();
}

let admin: PrismaClient;
let scratch: PrismaClient;

/** Re-create the scratch schema from nothing, so each probe starts from a database known clean. */
async function resetScratch(): Promise<void> {
  await scratch.$executeRawUnsafe(`DROP TABLE IF EXISTS "PartChild"`);
  await scratch.$executeRawUnsafe(`DROP TABLE IF EXISTS "Child"`);
  await scratch.$executeRawUnsafe(`DROP TABLE IF EXISTS "Parent"`);
  await scratch.$executeRawUnsafe(`CREATE TABLE "Parent" ("id" int PRIMARY KEY)`);
  await scratch.$executeRawUnsafe(
    `CREATE TABLE "Child" ("id" int PRIMARY KEY, "parentId" int REFERENCES "Parent"("id"))`,
  );
  await scratch.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION probe_seal() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'probe_seal fired'; END $$`,
  );
  await scratch.$executeRawUnsafe(
    `CREATE CONSTRAINT TRIGGER "Child_seal" AFTER INSERT ON "Child"
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_seal()`,
  );
  await scratch.$executeRawUnsafe(`INSERT INTO "Parent" VALUES (1)`);
}

/**
 * Catalog surgery leaves a database whose DDL no longer works — `DROP TABLE` on the mutilated table
 * answers `could not find tuple for trigger`, because the constraint's dependency record outlives
 * the row that was taken away. That is not a flaw in the probe; it is what the state IS, and it is
 * why a probe that performs it must have a database of its own to throw away. `DROP DATABASE` is a
 * file-level operation and is unaffected.
 */
async function withSurgeryDatabase(body: (db: PrismaClient) => Promise<void>): Promise<void> {
  const name = `${SCRATCH_DB}_surgery`;
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const db = new PrismaClient({ datasources: { db: { url: urlFor(name) } } });
  try {
    await db.$executeRawUnsafe(`CREATE TABLE "Parent" ("id" int PRIMARY KEY)`);
    await db.$executeRawUnsafe(
      `CREATE TABLE "Child" ("id" int PRIMARY KEY, "parentId" int REFERENCES "Parent"("id"))`,
    );
    await db.$executeRawUnsafe(`INSERT INTO "Parent" VALUES (1)`);
    await body(db);
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}

beforeAll(async () => {
  admin = new PrismaClient({ datasources: { db: { url: urlFor('postgres') } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
  scratch = new PrismaClient({ datasources: { db: { url: urlFor(SCRATCH_DB) } } });
  await resetScratch();
});

afterAll(async () => {
  await scratch?.$disconnect();
  await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await admin?.$disconnect();
});

describe('schema enforcement — the live catalog, not the SQL that wrote it', () => {
  it('accepts a coherent scratch schema, so the check is precise and not merely strict', async () => {
    await resetScratch();
    const report = await checkEnforcement(scratch, 'public');
    expect(report.applicable).toBe(true);
    expect(report.enforcing).toBe(true);
    expect(report.disabledTriggers.total).toBe(0);
    expect(report.unvalidatedForeignKeys.total).toBe(0);
    expect(report.incompleteForeignKeys.total).toBe(0);
    // The foreign key really is implemented as internal triggers, which is why clause 1 has to
    // cover them: MEASURED at 4 per key on PG 16, so the schema is not trigger-free.
    expect(report.counts.triggers).toBeGreaterThan(0);
    expect(report.counts.foreignKeys).toBe(1);
  });

  it("NAMES a foreign key whose triggers were switched off by DISABLE TRIGGER ALL, which convalidated cannot see", async () => {
    await resetScratch();
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" DISABLE TRIGGER ALL`);

    // REPRODUCE-FIRST, executed: the key is now a lie. An orphan commits...
    await scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (10, 999)`);
    const orphans = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "Child" WHERE "parentId" = 999`,
    );
    expect(Number(orphans[0].n)).toBe(1);
    // ...while the catalog row that a presence-only guard reads still says the key is fine. This is
    // exactly what 20270225000000_phase4_t3_correction3:167 asks and all it asks.
    const [{ convalidated }] = await scratch.$queryRawUnsafe<Array<{ convalidated: boolean }>>(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = '"Child"'::regclass AND contype = 'f'`,
    );
    expect(convalidated).toBe(true);

    const report = await checkEnforcement(scratch, 'public');
    expect(report.enforcing).toBe(false);
    expect(report.disabledTriggers.total).toBeGreaterThanOrEqual(3);

    // Every offending object is reported, and an internal trigger is ATTRIBUTED to the foreign key
    // it implements — "RI_ConstraintTrigger_c_24644 is disabled" is not actionable.
    const summary = summarizeEnforcement(report);
    expect(summary).toContain('Child_parentId_fkey');
    expect(summary).toContain('tgenabled=D');
    expect(report.disabledTriggers.sample.some((f) => f.implements === 'Child_parentId_fkey')).toBe(true);
    // The user constraint trigger on the same table is named too, and separately.
    expect(report.disabledTriggers.sample.some((f) => f.trigger === 'Child_seal' && f.implements === null)).toBe(true);

    await scratch.$executeRawUnsafe(`DELETE FROM "Child" WHERE "parentId" = 999`);
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" ENABLE TRIGGER ALL`);
    const cleaned = await checkEnforcement(scratch, 'public');
    expect(cleaned.enforcing).toBe(true);
  });

  it("FAILS a trigger set to R (replica), which does not fire on an ordinary connection", async () => {
    // THE PROBE THE LAST ROUND WOULD HAVE FAILED. `R` is not `D`, so a check that merely compares
    // tgenabled against some member of D/R/O/A passes it — Codex's final P1 on #430. It is inert
    // for every connection the application opens.
    await resetScratch();
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" ENABLE REPLICA TRIGGER "Child_seal"`);

    // REPRODUCE-FIRST, executed: the seal's body raises unconditionally, and this INSERT commits.
    await scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (11, 1)`);
    const rows = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "Child" WHERE id = 11`);
    expect(Number(rows[0].n)).toBe(1);

    const report = await checkEnforcement(scratch, 'public');
    expect(report.enforcing).toBe(false);
    const finding = report.disabledTriggers.sample.find((f) => f.trigger === 'Child_seal');
    expect(finding?.state).toBe('R');
    expect(summarizeEnforcement(report)).toContain('session_replication_role');

    // And returned to O the same seal bites, proving the probe measured enablement and not the body.
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" ENABLE TRIGGER "Child_seal"`);
    await expect(scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (12, 1)`)).rejects.toThrow(/probe_seal fired/);
  });

  it('NAMES a disabled user CONSTRAINT TRIGGER — the shape no migrate.sh check previously covered', async () => {
    // `20270920000000_decision_option_kinds:273` installs two of these and verifies them only at
    // apply time, with no migrate.sh counterpart.
    await resetScratch();
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" DISABLE TRIGGER "Child_seal"`);

    await scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (13, 1)`); // the seal did not fire

    const report = await checkEnforcement(scratch, 'public');
    expect(report.enforcing).toBe(false);
    expect(report.disabledTriggers.total).toBe(1);
    expect(report.disabledTriggers.sample[0]).toMatchObject({ trigger: 'Child_seal', state: 'D', implements: null });
    expect(summarizeEnforcement(report)).toContain('"Child_seal"');
  });

  it('NAMES a table whose triggers PostgreSQL skips wholesale — every tgenabled still reads enabled', async () => {
    // CLAUSE 4. `relhastriggers = false` is the executor's fast path: the table's triggers are not
    // looked up at all. Every pg_trigger row survives and every tgenabled still reads 'O', so
    // clause 1 — which asks each trigger about ITSELF — reports the table perfectly sealed.
    //
    // MEASURED against this file's own check before clause 4 existed: `enforcement verify` returned
    // `ok: true, enforcing: true` over exactly this state. That is a check narrower than the object
    // it judges, which is the shape this whole unit exists to refuse.
    await resetScratch();
    await scratch.$executeRawUnsafe(
      `UPDATE pg_class SET relhastriggers = false WHERE oid = 'public."Child"'::regclass`,
    );

    // The seal is genuinely inert, not merely flagged: this INSERT is what `Child_seal` refuses.
    await scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (41, 1)`);

    const report = await checkEnforcement(scratch, 'public');

    // Clause 1 sees nothing — that is the point, and asserting it is what proves clause 4 is not
    // redundant with it. If this ever becomes non-zero, clause 1 grew to cover this and clause 4
    // should be re-examined rather than left as a second opinion.
    expect(report.disabledTriggers.total).toBe(0);

    expect(report.enforcing).toBe(false);
    expect(report.bypassedTables.total).toBe(1);
    expect(report.bypassedTables.sample[0]).toMatchObject({ table: 'Child' });
    expect(report.bypassedTables.sample[0].triggers).toBeGreaterThan(0);
    expect(summarizeEnforcement(report)).toContain('relhastriggers = FALSE');
    expect(summarizeEnforcement(report)).toContain('"Child"');

    // Precise, not merely strict: restoring the flag restores the verdict AND the seal.
    await scratch.$executeRawUnsafe(
      `UPDATE pg_class SET relhastriggers = true WHERE oid = 'public."Child"'::regclass`,
    );
    expect((await checkEnforcement(scratch, 'public')).bypassedTables.total).toBe(0);
    await expect(scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (42, 1)`)).rejects.toThrow();
  });

  it('NAMES an unvalidated foreign key', async () => {
    await resetScratch();
    await scratch.$executeRawUnsafe(`INSERT INTO "Child" VALUES (14, NULL)`).catch(() => undefined);
    await scratch.$executeRawUnsafe(
      `ALTER TABLE "Child" ADD CONSTRAINT "Child_parent_notvalid_fkey"
         FOREIGN KEY ("parentId") REFERENCES "Parent"("id") NOT VALID`,
    );

    const report = await checkEnforcement(scratch, 'public');
    expect(report.enforcing).toBe(false);
    expect(report.unvalidatedForeignKeys.total).toBe(1);
    expect(summarizeEnforcement(report)).toContain('Child_parent_notvalid_fkey');

    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" VALIDATE CONSTRAINT "Child_parent_notvalid_fkey"`);
    expect((await checkEnforcement(scratch, 'public')).enforcing).toBe(true);
  });

  it('NAMES a foreign key that LOST an internal trigger — absence, which clause 1 cannot see', async () => {
    // THE PROBE FOR THE STATE CLAUSES 1 AND 2 ARE BOTH BLIND TO. Clause 1 asks whether every trigger
    // that EXISTS is enabled; a trigger removed from `pg_trigger` by a partial restore or a catalog
    // repair is not a disabled trigger, it is no trigger, and the survivors are all `O`.
    await withSurgeryDatabase(async (db) => {
      // `DROP TRIGGER` refuses an internal RI trigger, so the catalog surgery a broken restore
      // amounts to is reproduced directly — the only way this state arises in the field. The GUC
      // is set ON THE CONNECTION THAT PERFORMS THE DELETE, the precedent P33 of
      // `schedule-dependency-graph.test.ts` sets for the same surgery: a probe that judges a state
      // it must CREATE cannot have its setup fail quietly into a vacuous pass.
      await db.$executeRawUnsafe(`SET allow_system_table_mods = on`);

      // And a row of "Child" FIRST, so this backend has really built the table's trigger
      // descriptors. Catalog DML sends no relcache invalidation — MEASURED: with the cache warm
      // the orphan below is REFUSED here. Warming it deliberately is what stops this probe from
      // passing on the accident that nothing had yet touched "Child".
      await db.$executeRawUnsafe(`INSERT INTO "Child" VALUES (19, 1)`);

      const removed = await db.$executeRawUnsafe(
        `DELETE FROM pg_trigger t
          USING pg_constraint k, pg_proc p
          WHERE t.tgconstraint = k.oid AND p.oid = t.tgfoid
            AND k.conname = 'Child_parentId_fkey' AND p.proname = 'RI_FKey_check_ins'`,
      );
      expect(removed, 'the surgery removed exactly the referencing-side INSERT check').toBe(1);
      const [{ n: surviving }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_trigger t JOIN pg_constraint k ON k.oid = t.tgconstraint
          WHERE k.conname = 'Child_parentId_fkey'`,
      );
      expect(Number(surviving), 'and the catalog now carries three of the four').toBe(3);

      // REPRODUCE-FIRST, executed, on a FRESH backend — both what makes this measure the catalog
      // rather than a stale cache, and what the field sequence is: a restore, then an application
      // connecting to what it left.
      const restored = new PrismaClient({ datasources: { db: { url: urlFor(`${SCRATCH_DB}_surgery`) } } });
      let report: Awaited<ReturnType<typeof checkEnforcement>>;
      try {
        // The key is now a lie, exactly as in the DISABLE probe…
        await restored.$executeRawUnsafe(`INSERT INTO "Child" VALUES (20, 999)`);
        const orphans = await restored.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "Child" WHERE "parentId" = 999`,
        );
        expect(Number(orphans[0].n), 'the orphan the absent check would have refused').toBe(1);
        const [{ convalidated }] = await restored.$queryRawUnsafe<Array<{ convalidated: boolean }>>(
          `SELECT convalidated FROM pg_constraint WHERE conname = 'Child_parentId_fkey'`,
        );
        expect(convalidated, 'while the flag a presence-only guard reads still says fine').toBe(true);

        report = await checkEnforcement(restored, 'public');
      } finally {
        await restored.$disconnect();
      }

      // …and the point of this probe: the two clauses that shipped see NOTHING. Every surviving
      // trigger is `O`, and the key is validated. Without clause 3 this database reports ENFORCING.
      expect(report.disabledTriggers.total).toBe(0);
      expect(report.unvalidatedForeignKeys.total).toBe(0);

      expect(report.enforcing).toBe(false);
      expect(report.incompleteForeignKeys.total).toBe(1);
      expect(report.incompleteForeignKeys.sample[0]).toMatchObject({
        table: 'Child',
        constraint: 'Child_parentId_fkey',
        enforcingTriggers: 3,
      });
      const summary = summarizeEnforcement(report);
      expect(summary).toContain('Child_parentId_fkey');
      expect(summary).toContain('referencing-side INSERT check');
      expect(summary).toContain(`3/${REQUIRED_RI_TRIGGERS}`);
    });
  });

  it('counts a slot filled by a DISABLED trigger as unfilled — absence and D are one physical fact', async () => {
    // Clause 3 asks whether the slot FIRES, not whether a row is present, so it also covers the
    // hole clause 1 has by construction: clause 1 is scoped by the trigger's own table, so a
    // parent-side trigger on a table outside the scanned schema was never in the question.
    await resetScratch();
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" DISABLE TRIGGER ALL`);
    const report = await checkEnforcement(scratch, 'public');
    expect(report.incompleteForeignKeys.total).toBe(1);
    expect(report.incompleteForeignKeys.sample[0].enforcingTriggers).toBe(2); // the two parent-side ones survive
    expect(report.incompleteForeignKeys.sample[0].why).toContain('referencing-side INSERT check');
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" ENABLE TRIGGER ALL`);
    expect((await checkEnforcement(scratch, 'public')).incompleteForeignKeys.total).toBe(0);
  });

  it('REFUSES a foreign key whose shape it has not measured, rather than passing it', async () => {
    // An enumeration treated as the whole is the defect that closed both predecessors. The four-slot
    // inventory was measured for ordinary, non-derived keys across all 25 action pairs; a PARTITIONED
    // participant produces a different one (a leaf partition's derived constraint carries only the two
    // referencing-side triggers). That shape does not exist in this schema — and if it ever appears,
    // the deploy stops and says so.
    await resetScratch();
    await scratch.$executeRawUnsafe(
      `CREATE TABLE "PartChild" ("id" int, "parentId" int REFERENCES "Parent"("id"), PRIMARY KEY ("id"))
         PARTITION BY RANGE ("id")`,
    );
    await scratch.$executeRawUnsafe(`CREATE TABLE "PartChild_1" PARTITION OF "PartChild" FOR VALUES FROM (0) TO (100)`);

    const report = await checkEnforcement(scratch, 'public');
    expect(report.enforcing).toBe(false);
    const why = report.incompleteForeignKeys.sample.map((f) => f.why).join(' | ');
    expect(why).toContain('DERIVED constraint');   // the leaf partition's own constraint row
    expect(why).toContain('relkind "p"');          // the partitioned root
    // …and the ordinary key on the same schema is NOT swept up with them: refusing the unmeasured
    // shape is not refusing everything.
    expect(report.incompleteForeignKeys.sample.some((f) => f.constraint === 'Child_parentId_fkey')).toBe(false);

    await scratch.$executeRawUnsafe(`DROP TABLE "PartChild"`);
  });

  it('FAILS a session in replica mode, where every `O` trigger — foreign keys included — is inert', async () => {
    // THE STATE ALL THREE CLAUSES READ AS PERFECT. Firing is a property of `tgenabled` RELATIVE to
    // `session_replication_role`; asking about `tgenabled` alone is half the question. Set on the
    // DATABASE rather than by a bare `SET`, so every connection inherits it — what `ALTER ROLE` /
    // `ALTER DATABASE ... SET` does in the field, and what makes this deterministic under a pool.
    const withRole = async (role: string, body: (db: PrismaClient) => Promise<void>) => {
      await resetScratch();
      await scratch.$executeRawUnsafe(`ALTER DATABASE "${SCRATCH_DB}" SET session_replication_role = '${role}'`);
      const db = new PrismaClient({ datasources: { db: { url: urlFor(SCRATCH_DB) } } });
      try { await body(db); } finally {
        await db.$disconnect();
        await scratch.$executeRawUnsafe(`ALTER DATABASE "${SCRATCH_DB}" RESET session_replication_role`);
      }
    };

    await withRole('replica', async (db) => {
      // REPRODUCE-FIRST, executed: the seal that raises unconditionally does not raise, and the key
      // admits an orphan — on a schema where nothing was disabled, dropped or invalidated.
      await db.$executeRawUnsafe(`INSERT INTO "Child" VALUES (40, 999)`);
      const [{ n }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "Child" WHERE "parentId" = 999`,
      );
      expect(Number(n), 'the orphan committed and the seal never fired').toBe(1);

      const report = await checkEnforcement(db, 'public');
      // The three clauses that shipped see NOTHING: every trigger present and `O`, the key
      // validated, all four slots filled. Without this one the check reports ENFORCING while the
      // API — sharing this DATABASE_URL role — has no seals at all.
      expect(report.disabledTriggers.total).toBe(0);
      expect(report.unvalidatedForeignKeys.total).toBe(0);
      expect(report.incompleteForeignKeys.total).toBe(0);

      expect(report.sessionReplicationRole).toBe('replica');
      expect(report.enforcing).toBe(false);
      expect(summarizeEnforcement(report)).toContain('session_replication_role');
    });

    // The precision half: refusing `replica` is not refusing everything. MEASURED on PG 16.13 —
    // under `local` the same seal raised and the same key refused the same orphan, exactly as under
    // `origin` (which every other probe here already runs under), so both are accepted.
    expect([...ENFORCING_SESSION_ROLES]).toEqual(['origin', 'local']);
    await withRole('local', async (db) => {
      await expect(db.$executeRawUnsafe(`INSERT INTO "Child" VALUES (41, 999)`))
        .rejects.toThrow(/Child_parentId_fkey/);
      expect((await checkEnforcement(db, 'public')).enforcing).toBe(true);
    });
  });

  it('reports a fresh/empty schema as NOT APPLICABLE rather than clean', async () => {
    const report = await checkEnforcement(scratch, 'a_schema_that_does_not_exist');
    expect(report.applicable).toBe(false);
    expect(report.counts.tables).toBe(0);
    expect(report.note).toContain('fresh or empty');
    // The two migrate.sh callers differ on what this means, and the CLI — not this function —
    // decides: preflight passes, verify fails with exit 4.
  });

  it('bounds the printed sample without bounding the count', async () => {
    await resetScratch();
    // Enough seals to EXCEED the cap. Asserting `total === sample.length` under it would pass for
    // any cap at all, including none — the bound has to be crossed to be measured.
    for (let i = 0; i <= SAMPLE_LIMIT; i++) {
      await scratch.$executeRawUnsafe(
        `CREATE TRIGGER "Child_bulk_${i}" AFTER INSERT ON "Child" FOR EACH ROW EXECUTE FUNCTION probe_seal()`,
      );
    }
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" DISABLE TRIGGER ALL`);
    const report = await checkEnforcement(scratch, 'public');
    expect(report.disabledTriggers.total).toBeGreaterThan(SAMPLE_LIMIT);
    expect(report.disabledTriggers.sample.length).toBe(SAMPLE_LIMIT);
    expect(summarizeEnforcement(report)).toContain(`sample bounded at ${SAMPLE_LIMIT}`);
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" ENABLE TRIGGER ALL`);
  });

  it('accepts the REAL migrated application database — every seal it carries fires', async () => {
    // The precision claim that matters: this repository installs its invariants as triggers by
    // design, and the whole migrated schema passes. If the check were merely strict, this is where
    // it would fail. READ-ONLY.
    const app = new PrismaClient();
    try {
      const report = await checkEnforcement(app, applicationSchema());
      expect(report.applicable).toBe(true);
      expect(summarizeEnforcement(report)).toBe('');
      expect(report.enforcing).toBe(true);
      expect(report.counts.triggers).toBeGreaterThan(100);
      expect(report.counts.foreignKeys).toBeGreaterThan(50);
      // Clause 3 over the real schema is the precision claim that matters most, because it is the
      // clause that REFUSES shapes it has not measured: every foreign key this repository declares
      // must be an ordinary, non-derived, four-slot key, or a deploy would stop on it.
      expect(report.incompleteForeignKeys.total).toBe(0);
    } finally {
      await app.$disconnect();
    }
  });
});
