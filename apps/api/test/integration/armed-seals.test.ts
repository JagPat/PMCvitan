import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { verifyArmedSeals } from '../../src/platform/seals/armed-seals';

/**
 * ARMED SEALS — every enforcement object in a migrated database is switched on, and the check that
 * says so is precise rather than merely strict.
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST. The subject is a real PostgreSQL catalog.
 * A unit test would need a model of `pg_trigger`/`pg_constraint`, and a model is narrower than the
 * thing it models — which is the exact defect that cost four review units (#423, #430, #431, #432)
 * sixteen findings and merged nothing. The retirement of that lineage is recorded in
 * docs/MIGRATION_INVARIANTS.md. This asks the real catalog.
 *
 * The falsification of the DEPLOY PATH — tampering, then requiring the real `scripts/migrate.sh` to
 * refuse and name the object — is `apps/api/scripts/armed-seals-falsification-proof.sh`, run by the
 * required `api` job. This file covers the verifier itself, inside `pnpm check`.
 *
 * EVERY TAMPER RUNS INSIDE A ROLLED-BACK TRANSACTION. PostgreSQL's DDL is transactional, so a
 * disabled trigger inside an aborted transaction never becomes visible to anyone and cannot outlive
 * this file — not even if the process is killed mid-test. The integration suites share one database;
 * repairing only in a `finally` would leave a disabled seal behind on SIGKILL, which would then look
 * exactly like the production defect this check exists to report.
 */

/** Apply a tamper, ask the verifier, and ALWAYS roll back. Returns the report seen while tampered. */
async function whileTampered(app: TestApp, ...statements: string[]) {
  const ROLLBACK = new Error('__rollback__');
  try {
    return await app.prisma.$transaction(async (tx) => {
      for (const sql of statements) await tx.$executeRawUnsafe(sql);
      const report = await verifyArmedSeals(tx);
      // Thrown, not returned: an interactive transaction commits on a normal return.
      throw Object.assign(ROLLBACK, { report });
    });
  } catch (e) {
    if (e === ROLLBACK) return (e as typeof ROLLBACK & { report: Awaited<ReturnType<typeof verifyArmedSeals>> }).report;
    throw e;
  }
}
describe('armed seals — every enforcement object in this database enforces (live PG)', () => {
  let app: TestApp;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await app.close(); });

  it('reports a migrated database fully armed, having actually looked at the schema', async () => {
    const report = await verifyArmedSeals(app.prisma);

    // `considered` is asserted, not just `armed`. A scan that finds nothing because it LOOKED at
    // nothing would otherwise pass forever — the vacuous-green failure `upgrade-proof.sh` guards
    // against with its own missing-command trap.
    expect(report.applicable).toBe(true);
    expect(report.considered).toBeGreaterThan(500);
    expect(report.findings).toEqual([]);
    expect(report.armed).toBe(true);
  });

  it('catches a DISABLED trigger — the shape a bad restore leaves', async () => {
    // Measured before this check existed: with these two seals disabled, `scripts/migrate.sh`
    // exited 0 and never named them. They were verified once, while 20270920000000 applied, and
    // never asked about again.
    const report = await whileTampered(app,
      'ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_kind_selectable_ins"');
    expect(report.armed).toBe(false);
    expect(report.findings.map((f) => f.identity))
      .toContain('DecisionOption.DecisionOption_kind_selectable_ins');
    expect(report.findings.find((f) => f.identity.endsWith('kind_selectable_ins'))?.kind).toBe('trigger');

    // Rolled back: the check must go quiet again, or it is strict rather than precise.
    expect((await verifyArmedSeals(app.prisma)).armed).toBe(true);
  });

  it('catches a foreign key whose internal RI triggers are off, which pg_constraint cannot show', async () => {
    // The whole reason the enforcement rule was ever written. `DISABLE TRIGGER ALL` leaves conname,
    // contype, conrelid, confrelid AND convalidated byte-for-byte unchanged while the key stops
    // enforcing, so a guard reading those columns passes over a key that contains nothing. This is
    // the live defect at 20270225000000_phase4_t3_correction3:167, which reads exactly those.
    const ROLLBACK = new Error('__rollback__');
    const seen = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "LabourWorkFact" DISABLE TRIGGER ALL');
      const stillValid = await tx.$queryRawUnsafe<{ convalidated: boolean }[]>(
        `SELECT convalidated FROM pg_constraint
          WHERE conname = 'LabourWorkFact_command_fkey' AND conrelid = to_regclass('"LabourWorkFact"')`);
      const report = await verifyArmedSeals(tx);
      throw Object.assign(ROLLBACK, { convalidated: stillValid[0]?.convalidated, report });
    }).catch((e) => {
      if (e === ROLLBACK) return e as typeof ROLLBACK & { convalidated: boolean; report: Awaited<ReturnType<typeof verifyArmedSeals>> };
      throw e;
    });

    expect(seen.convalidated).toBe(true); // the guard's own predicate is untouched…
    expect(seen.report.armed).toBe(false); // …and the key is not enforcing.
    expect(seen.report.findings.some((f) => f.kind === 'foreign_key' && f.identity.startsWith('LabourWorkFact.')))
      .toBe(true);
    expect((await verifyArmedSeals(app.prisma)).armed).toBe(true);
  });

  it('catches a NOT VALID constraint and a relhastriggers bypass', async () => {
    const notValid = await whileTampered(app,
      `ALTER TABLE "DecisionOption" ADD CONSTRAINT "probe_not_valid" CHECK ("optionKey" <> '__never__') NOT VALID`);
    expect(notValid.findings.map((f) => f.identity)).toContain('DecisionOption.probe_not_valid');

    // A verifier that enumerates pg_trigger and stops there reports this table fully sealed: every
    // trigger row survives intact and PostgreSQL skips all of them.
    const bypassed = await whileTampered(app,
      `UPDATE pg_class SET relhastriggers = false WHERE oid = 'public."DecisionOption"'::regclass`);
    expect(bypassed.findings.some((f) => f.kind === 'table' && f.identity === 'DecisionOption')).toBe(true);

    expect((await verifyArmedSeals(app.prisma)).armed).toBe(true);
  });
});
