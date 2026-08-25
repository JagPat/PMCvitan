import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationSchema,
  checkEnforcement,
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
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" DISABLE TRIGGER ALL`);
    await scratch.$executeRawUnsafe(`ALTER TABLE "Parent" DISABLE TRIGGER ALL`);
    const report = await checkEnforcement(scratch, 'public');
    expect(report.disabledTriggers.total).toBe(report.disabledTriggers.sample.length); // under the cap here
    expect(report.disabledTriggers.sample.length).toBeGreaterThan(1); // not just the first
    await scratch.$executeRawUnsafe(`ALTER TABLE "Child" ENABLE TRIGGER ALL`);
    await scratch.$executeRawUnsafe(`ALTER TABLE "Parent" ENABLE TRIGGER ALL`);
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
    } finally {
      await app.$disconnect();
    }
  });
});
