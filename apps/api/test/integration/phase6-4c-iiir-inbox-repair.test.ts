import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations, type RebuildRunReport } from '../../src/platform/projections/rebuild-operations';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { lockActiveGeneration } from '../../src/platform/projections/generation';
import {
  ANCHOR_ENV,
  DATABASE_IDENTITY_ENV,
  MINIMUM_ENV,
  PHASE6_4C_IIIR_LOCK_KEY,
  PHASE6_4C_IIIR_MARKER_ACTION,
  PHASE6_4C_IIIR_OPERATOR,
  readIdentityConfig,
  runInboxRepairStep,
  SYSTEM_IDENTITY_ENV,
  lockActiveGenerationsForVerify,
  VERIFY_TX_OPTIONS,
  readDatabaseIdentity,
  singleConnectionUrl,
  verifyReport,
} from '../../src/platform/projections/inbox-repair';
import {
  MARKER_SEAL_TRIGGERS,
  readMarkerSealMigrationSql,
  verifyMarkerSeals,
} from '../../src/platform/projections/inbox-repair-seals';

/**
 * Phase 6 unit 4c-iii-r — the deploy-time one-shot `decisions.inbox` repair, REPRODUCE-FIRST
 * against live PostgreSQL.
 *
 * THE TWO DEFECTS THIS PINS, both raised on the recorded unit and both reproduced here before they
 * are fixed:
 *
 *  1. VACUOUS IDENTITY. Every success field in a rebuild report is derived from the result set, so
 *     an EMPTY or WRONG database returns `projects: 0, ok: true, corruptAfter: 0, failures: 0` and
 *     exits 0 having rebuilt nothing — a self-count compares two numbers that came from the same
 *     connection. `PROBE 1` asserts that shape directly against a report, so the vacuity is a
 *     recorded fact rather than an assertion about one. Identity therefore comes from OUTSIDE the
 *     connection, and every refusal is exercised.
 *
 *  2. AN UNSERIALIZED MARKER CLAIM. `ProjectionRebuilder` allocates `generation = max + 1` per
 *     (consumer, project) inside its own transaction with no cross-process serialization. `PROBE 7`
 *     runs the UNSERIALIZED shape — two independent sessions calling `ops.run` concurrently, which
 *     is exactly what two replicas that both read the marker as absent would do — and shows the
 *     collision. `PROBE 8` then releases two REAL processes together against one database through
 *     the locked step and asserts the terminal invariant: exactly one rebuild, one newly-activated
 *     generation per project, both processes exit 0.
 *
 * The concurrency barrier is CONDITION-BASED, never a sleep: this suite takes the step's advisory
 * lock itself, waits until BOTH child processes are observed WAITING on that exact lock in
 * `pg_locks`, and only then releases it — so the two are genuinely released together into the race.
 */
describe('Phase 6 unit 4c-iii-r — deploy-time decisions.inbox repair (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  /** The step holds a SESSION-level advisory lock, so in-process runs need their own single
   *  connection — a lock taken on one pooled connection and released on another never releases. */
  let single: PrismaClient;
  let ops: ProjectionRebuildOperations;
  let env: Record<string, string | undefined>;
  let liveSystemIdentifier: string;
  let liveDatabaseOid: string;

  const API_DIR = resolve(__dirname, '../..');
  /** A throwaway login role for the deployment-role probe — created and dropped by that test. */
  const UNPRIV_ROLE = 'phase6_4c_iiir_probe_role';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    single = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    ops = new ProjectionRebuildOperations(single as never, new ProjectionRebuilder(single as never));
    // The cluster this suite is actually connected to — read once, so every configured probe
    // carries a TRUE database identity and the mismatch probe can supply a false one deliberately.
    const [{ system_identifier: live, database_oid: liveOid }] = await t.prisma.$queryRaw<
      Array<{ system_identifier: bigint; database_oid: number }>
    >`SELECT c.system_identifier,
             (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()) AS database_oid
        FROM pg_control_system() c`;
    liveSystemIdentifier = String(live);
    liveDatabaseOid = String(liveOid);
    env = {
      [ANCHOR_ENV]: f.projectA.id,
      [MINIMUM_ENV]: '1',
      [SYSTEM_IDENTITY_ENV]: liveSystemIdentifier,
      [DATABASE_IDENTITY_ENV]: liveDatabaseOid,
    };
    // Put the database in the IN-SERVICE shape the step's applicability turns on: a
    // `decisions.inbox` generation exists, which is the defect's precondition. Without this every
    // live probe below would correctly report `not-applicable` and prove nothing.
    await putInService();
  });
  afterAll(async () => {
    await clearMarkers();
    await single?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  beforeEach(async () => {
    await clearMarkers();
  });
  /**
   * Two probes here deliberately UNSEAL the shared database (that is what they are for). A failure
   * inside one used to leave it unsealed, and every later probe in the file then failed for a
   * reason that had nothing to do with it — one honest failure reported as five. The seals are
   * therefore restored after EVERY probe, unconditionally, so each starts from the sealed state.
   */
  afterEach(async () => {
    if (!(await verifyMarkerSeals(single as never)).sealed) await restoreMarkerSeals();
  });

  /** The marker is DB-sealed against DELETE, so a probe reset cannot simply delete it — that is the
   *  point of the seal. It goes through the sanctioned reset, which disables the registered
   *  statement seal for exactly that wipe and restores it in the same transaction. */
  const clearMarkers = async () => {
    await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
  };
  /** A real rebuild, so the database carries a `decisions.inbox` generation exactly as one in
   *  service does — built through the production rebuilder, never a hand-written row. */
  const putInService = async () => {
    const rebuilder = new ProjectionRebuilder(single as never);
    for (const p of await t.prisma.project.findMany({ select: { id: true } })) {
      await rebuilder.rebuild(DECISIONS_PROJECTION, p.id);
    }
  };
  const servedGenerations = () =>
    t.prisma.projectionGeneration.count({ where: { consumer: DECISIONS_PROJECTION } });
  const markerCount = () =>
    t.prisma.outboxOperatorAction.count({ where: { action: PHASE6_4C_IIIR_MARKER_ACTION } });
  const invocationCount = () =>
    t.prisma.outboxOperatorAction.count({
      where: { action: 'projection.rebuild', operatorIdentity: PHASE6_4C_IIIR_OPERATOR },
    });
  const liveProjects = () => t.prisma.project.count();
  /** Re-run the seal migration's own SQL to put back whatever a hostile probe removed. It is
   *  idempotent by construction (CREATE OR REPLACE + DROP TRIGGER IF EXISTS + CREATE TRIGGER), so
   *  the restore is the migration itself rather than a second copy of it that could drift. */
  const restoreMarkerSeals = async () => {
    const sql = readMarkerSealMigrationSql();
    // One statement per call — `$executeRawUnsafe` prepares, and PostgreSQL refuses multiple
    // commands in a prepared statement. Functions first, then the drop/create pair per trigger,
    // which is the migration's own order.
    const groups = [
      /CREATE OR REPLACE FUNCTION phase6_4c_iiir_\w+\(\)[\s\S]*?\$\$;/gu,
      /DROP TRIGGER IF EXISTS "[^"]+" ON "OutboxOperatorAction";/gu,
      /CREATE TRIGGER "[^"]+"[\s\S]*?EXECUTE FUNCTION phase6_4c_iiir_\w+\(\);/gu,
    ];
    for (const pattern of groups) {
      const statements = [...sql.matchAll(pattern)].map((m) => m[0].replace(/;$/u, ''));
      // A plain throw, never `expect`: this runs in cleanup, and an assertion failure here would
      // abandon the restore half-done and leave the shared database unsealed for every later probe.
      if (statements.length !== MARKER_SEAL_TRIGGERS.length) {
        throw new Error(`4c-iii-r restore: matched ${statements.length} of ${MARKER_SEAL_TRIGGERS.length} statements for ${pattern}`);
      }
      for (const statement of statements) await single.$executeRawUnsafe(statement);
    }
  };
  const activeGeneration = (projectId: string) =>
    t.prisma.projectionGeneration.findFirst({
      where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' },
      select: { generation: true },
    });
  /** Every generation row for a project, whatever its status — the count a rebuild moves by one. */
  const generationRows = (projectId: string) =>
    t.prisma.projectionGeneration.count({ where: { consumer: DECISIONS_PROJECTION, projectId } });
  const activeGenerations = (projectId: string) =>
    t.prisma.projectionGeneration.count({ where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' } });

  // ── PROBE 1: the vacuity the identity check exists to refuse ────────────────────────────────
  it('PROBE 1 — a report over ZERO projects satisfies every success field, so the self-count alone is not identity', () => {
    const vacuous: RebuildRunReport = {
      ok: true, action: 'projection.rebuild', projects: 0, consumers: [DECISIONS_PROJECTION],
      corruptBefore: 0, laggingBefore: 0, corruptAfter: 0, failures: 0, results: [],
    };
    // Against its OWN connection's count of zero, the vacuous report verifies — this is the defect.
    expect(verifyReport(vacuous, 0)).toBeNull();
    // Against a database that actually holds projects it does not: the count is necessary.
    expect(verifyReport(vacuous, 2)?.code).toBe('rebuild-not-verified');
  });

  it('PROBE 1b — verifyReport requires every clause, not just ok', () => {
    const base: RebuildRunReport = {
      ok: true, action: 'projection.rebuild', projects: 1, consumers: [DECISIONS_PROJECTION],
      corruptBefore: 0, laggingBefore: 0, corruptAfter: 0, failures: 0,
      results: [{ projectId: 'p', consumer: DECISIONS_PROJECTION, before: { state: 'none', generation: null, appliedPosition: null, streamHead: null }, rebuilt: true }],
    };
    expect(verifyReport(base, 1)).toBeNull();
    expect(verifyReport({ ...base, ok: false }, 1)?.message).toMatch(/report\.ok is false/u);
    expect(verifyReport({ ...base, corruptAfter: 1 }, 1)?.message).toMatch(/corruptAfter=1/u);
    expect(verifyReport({ ...base, failures: 1 }, 1)?.message).toMatch(/failures=1/u);
    expect(verifyReport({ ...base, projects: 2 }, 2)?.message).toMatch(/results\.length=1 != projects=2/u);
    // the offending pair is NAMED, so a deploy log says which project to look at
    const failed = verifyReport({ ...base, failures: 1, results: [{ ...base.results[0], rebuilt: false, error: 'boom' }] }, 1);
    expect(failed?.message).toMatch(/offending pairs: p\/decisions\.inbox: boom/u);
  });

  // ── PROBE 2: every identity refusal ─────────────────────────────────────────────────────────
  it('PROBE 2 — an unset variable is a refusal on a database that has served the register, and not on one that has not', () => {
    expect(readIdentityConfig({}, true)).toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    const both = readIdentityConfig({}, true);
    expect(both.ok).toBe(false);
    if (!both.ok) {
      // all four are named, so an operator sees the whole configuration in one refusal
      for (const v of [ANCHOR_ENV, MINIMUM_ENV, SYSTEM_IDENTITY_ENV, DATABASE_IDENTITY_ENV]) {
        expect(both.refusal.message).toContain(v);
      }
    }
    expect(readIdentityConfig({ [MINIMUM_ENV]: '1' }, true)).toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'p' }, true)).toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    // a partial tuple is still unconfigured — two of the four is not a configuration
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: '1' }, true))
      .toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    // blank is unset, not configured
    expect(readIdentityConfig({ [ANCHOR_ENV]: '  ', [MINIMUM_ENV]: '1', [SYSTEM_IDENTITY_ENV]: '1', [DATABASE_IDENTITY_ENV]: '16384' }, true)).toMatchObject({ ok: false });
    // a database that never served the register has nothing to repair, so an unconfigured deploy is
    // not refused there — which is what keeps every migrate.sh harness free of this configuration
    expect(readIdentityConfig({}, false)).toEqual({ ok: true, config: null });
  });

  it('PROBE 2b — the minimum must be a whole number >= 1, so no configured value can become a skip', () => {
    for (const bad of ['0', 'x', '1.0', '1e9', '2 or 3', '-1']) {
      expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: bad, [SYSTEM_IDENTITY_ENV]: '7', [DATABASE_IDENTITY_ENV]: '16384' }, true))
        .toMatchObject({ ok: false, refusal: { code: 'minimum-invalid' } });
    }
    // and the database identity is validated with the same strictness
    for (const bad of ['x', '7.0', '7e9', 'not-an-id']) {
      expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: '1', [SYSTEM_IDENTITY_ENV]: bad, [DATABASE_IDENTITY_ENV]: '16384' }, true))
        .toMatchObject({ ok: false, refusal: { code: 'system-identity-invalid' } });
    }
    expect(readIdentityConfig(
      { [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: '3', [SYSTEM_IDENTITY_ENV]: '7', [DATABASE_IDENTITY_ENV]: '16384' }, true))
      .toEqual({ ok: true, config: { anchorProjectId: 'p', expectedMinProjects: 3, expectedSystemIdentifier: '7', expectedDatabaseOid: '16384' } });
  });

  it('PROBE 2c — applicability comes from the DATABASE, not the configuration: a projectless database is not-applicable even when configured', async () => {
    // The pure reader's half of PROBE 2d: `applicable` is what the step derives from the served
    // generation count, and it is consulted BEFORE the anchor, so a configured deploy over a
    // never-served database ends `not-applicable` — never a success it could hide behind. A
    // malformed value is still named there rather than ignored.
    expect(readIdentityConfig(
      { [ANCHOR_ENV]: 'anywhere', [MINIMUM_ENV]: '5', [SYSTEM_IDENTITY_ENV]: '7', [DATABASE_IDENTITY_ENV]: '16384' }, false))
      .toEqual({ ok: true, config: { anchorProjectId: 'anywhere', expectedMinProjects: 5, expectedSystemIdentifier: '7', expectedDatabaseOid: '16384' } });
    // and a malformed value is still NAMED there rather than ignored
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'anywhere', [MINIMUM_ENV]: '0', [SYSTEM_IDENTITY_ENV]: '7', [DATABASE_IDENTITY_ENV]: '16384' }, false))
      .toMatchObject({ ok: false, refusal: { code: 'minimum-invalid' } });
  });

  it('PROBE 2d — a database that has NEVER served the register is not-applicable even when CONFIGURED, and writes no marker', async () => {
    // The discriminator is the defect's own precondition, read from the database: with no
    // `decisions.inbox` generation, `DecisionProjection` rows are unreachable (they are
    // generation-scoped), so there is nothing the read path would serve and nothing a pre-4c-ii
    // worker could have left. This is also the shape of every test harness that drives the real
    // `migrate.sh` over a psql-planted fixture — which is why those harnesses need no configuration.
    await t.prisma.decisionProjection.deleteMany({});
    await t.prisma.projectionGeneration.deleteMany({ where: { consumer: DECISIONS_PROJECTION } });
    expect(await servedGenerations()).toBe(0);

    const outcome = await runInboxRepairStep(single, ops, env);
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('not-applicable');
    expect(outcome.markerWritten).toBe(false);
    expect(await markerCount()).toBe(0);
    // and it claimed no repair, so a later in-service start still repairs in full
    expect(outcome.report).toBeUndefined();

    await putInService();
    expect(await servedGenerations()).toBeGreaterThan(0);
    const inService = await runInboxRepairStep(single, ops, env);
    expect(inService.action).toBe('repaired');
    expect(await markerCount()).toBe(1);
  });

  it('PROBE 2f — a CLONE of production is refused: the anchor and the count are copied with the data, the cluster identity is not', async () => {
    // The realistic misconfiguration the anchor alone cannot catch: `DATABASE_URL` points at a
    // restore of production, so the SAME anchor project exists and the count is met — every
    // dataset check passes. Simulated exactly by keeping this database (anchor present, count met)
    // and configuring the identifier of a DIFFERENT cluster, which is what a logical restore into
    // another cluster produces: `system_identifier` is made by initdb, lives in the control file,
    // and `pg_dump` does not carry it.
    const anchorPresent = await t.prisma.project.findUnique({ where: { id: f.projectA.id }, select: { id: true } });
    expect(anchorPresent).not.toBeNull();                       // the dataset checks WOULD pass…
    expect(await liveProjects()).toBeGreaterThanOrEqual(1);

    const otherCluster = String(BigInt(liveSystemIdentifier) + 1n);
    const outcome = await runInboxRepairStep(single, ops, { ...env, [SYSTEM_IDENTITY_ENV]: otherCluster });
    expect(outcome.ok).toBe(false);                             // …and it is refused anyway
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('system-identity-mismatch');
    expect(outcome.refusal?.message).toMatch(/different PostgreSQL cluster/u);
    expect(await markerCount()).toBe(0);

    // and the check is not merely strict: the TRUE identifier is accepted
    const correct = await runInboxRepairStep(single, ops, env);
    expect(correct.ok).toBe(true);
    expect(correct.action).toBe('repaired');
  });

  it('PROBE 2g — the cluster identity is re-checked WITH the marker set, so a later repoint cannot serve', async () => {
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    const repointed = await runInboxRepairStep(single, ops, {
      ...env, [SYSTEM_IDENTITY_ENV]: String(BigInt(liveSystemIdentifier) + 1n),
    });
    expect(repointed.ok).toBe(false);
    expect(repointed.refusal?.code).toBe('system-identity-mismatch');
  });

  // ── The four Codex findings on `bee2ed9`, each reproduced RED before its fix ─────────────────

  it('F1 — a PARTIAL identity tuple is a refusal even on a not-applicable database, and all-unset is still exempt', () => {
    // The defect: a production deploy that keeps its anchor and minimum but loses the cluster
    // identifier, with DATABASE_URL repointed at a fresh WRONG database. `applicable` is false
    // there — the wrong database has served nothing — so the old code discarded the identity that
    // WAS supplied, skipped every check, reported not-applicable and started the API against it.
    // "Looks not-applicable" is exactly what a wrong database looks like, so it cannot be the
    // thing that waives the checks.
    const partial = { [ANCHOR_ENV]: 'p1', [MINIMUM_ENV]: '1' };
    const onFresh = readIdentityConfig(partial, false);
    expect(onFresh.ok).toBe(false);
    if (onFresh.ok) throw new Error('unreachable');
    expect(onFresh.refusal.code).toBe('identity-unconfigured');
    expect(onFresh.refusal.message).toContain(SYSTEM_IDENTITY_ENV);
    expect(onFresh.refusal.message).toContain(DATABASE_IDENTITY_ENV);
    expect(onFresh.refusal.message).toMatch(/declared which database it serves/u);

    // every partial shape, not just that one — one variable set is already a declaration
    for (const only of [ANCHOR_ENV, MINIMUM_ENV, SYSTEM_IDENTITY_ENV, DATABASE_IDENTITY_ENV]) {
      const one = readIdentityConfig({ [only]: only === MINIMUM_ENV ? '1' : '9' }, false);
      expect(one.ok).toBe(false);
    }
    // and three of four is still partial
    const three = readIdentityConfig(
      { [ANCHOR_ENV]: 'p1', [MINIMUM_ENV]: '1', [SYSTEM_IDENTITY_ENV]: '7' }, false);
    expect(three.ok).toBe(false);

    // THE EXEMPTION SURVIVES: all-unset on a database that has served nothing is the fresh-install
    // and harness shape, and asserts nothing. This is what keeps a first deploy from being walled
    // off and every sibling runner proof free of this step's configuration.
    const fresh = readIdentityConfig({}, false);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('unreachable');
    expect(fresh.config).toBeNull();
    // …and all-unset on a database that HAS served the register is still a refusal
    const inService = readIdentityConfig({}, true);
    expect(inService.ok).toBe(false);
  });

  it('F1 (live) — a partially configured step pointed at a never-served database ABORTS instead of reporting not-applicable', async () => {
    // The same defect end to end. `putInService` created the generations, so remove them to make
    // this database genuinely not-applicable — the shape a wrong DATABASE_URL presents.
    await t.prisma.projectionGeneration.deleteMany({ where: { consumer: DECISIONS_PROJECTION } });
    try {
      expect(await servedGenerations()).toBe(0);
      const { [SYSTEM_IDENTITY_ENV]: _dropped, ...partial } = env;
      const outcome = await runInboxRepairStep(single, ops, partial);
      expect(outcome.ok).toBe(false);
      expect(outcome.action).toBe('refused');
      expect(outcome.refusal?.code).toBe('identity-unconfigured');
      expect(await markerCount()).toBe(0);

      // and the exemption still holds on the same database when NOTHING is configured
      const unconfigured = await runInboxRepairStep(single, ops, {});
      expect(unconfigured.ok).toBe(true);
      expect(unconfigured.action).toBe('not-applicable');
      expect(await markerCount()).toBe(0);
    } finally {
      await putInService();
    }
  });

  it('F2 — a restore into a SIBLING database on the same cluster is refused: the cluster identifier is shared, the database OID is not', async () => {
    // The realistic restore the cluster check alone cannot see. `pg_restore` into a second
    // database beside production carries the same anchor, the same count AND the same
    // `system_identifier` — every check the previous head made. It selected `current_database()`
    // and never compared it, so that copy passed.
    const sameCluster = { ...env, [DATABASE_IDENTITY_ENV]: String(Number(liveDatabaseOid) + 1) };
    const outcome = await runInboxRepairStep(single, ops, sameCluster);
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('database-identity-mismatch');
    expect(outcome.refusal?.message).toMatch(/the DATABASE within it is not/u);
    expect(await markerCount()).toBe(0);

    // precision, not mere strictness: the TRUE oid on the SAME cluster is accepted
    const correct = await runInboxRepairStep(single, ops, env);
    expect(correct.ok).toBe(true);
    expect(correct.action).toBe('repaired');
  });

  it('F2b — the database identity is re-checked WITH the marker set, and a non-numeric OID is named not coerced', async () => {
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    const repointed = await runInboxRepairStep(single, ops, {
      ...env, [DATABASE_IDENTITY_ENV]: String(Number(liveDatabaseOid) + 1),
    });
    expect(repointed.ok).toBe(false);
    expect(repointed.refusal?.code).toBe('database-identity-mismatch');

    const garbage = readIdentityConfig({ ...env, [DATABASE_IDENTITY_ENV]: '16384 or 16385' }, true);
    expect(garbage.ok).toBe(false);
    if (garbage.ok) throw new Error('unreachable');
    expect(garbage.refusal.code).toBe('database-identity-invalid');
  });

  it('F3 — the rebuild walks the projects its OWNER supplied, and the deploy path reads Project once', async () => {
    // The rebuild used to enumerate `Project` itself with `prisma.project.findMany` from the
    // platform module, so routing the identity count through the participant moved the smaller
    // read and left the larger one. `run` now accepts owner-supplied ids; passing a subset proves
    // the parameter is what the walk actually follows, rather than being accepted and ignored.
    const only = await ops.run({
      operatorIdentity: 'test', reason: 'F3', consumers: [DECISIONS_PROJECTION],
      projectIds: [f.projectA.id],
    });
    expect(only.projects).toBe(1);
    expect(only.results.map((r) => r.projectId)).toEqual([f.projectA.id]);

    // the two parameters are alternatives, so a caller cannot silently get one of them
    await expect(ops.run({
      operatorIdentity: 'test', reason: 'F3', consumers: [DECISIONS_PROJECTION],
      projectIds: [f.projectA.id], projectId: f.projectB.id,
    })).rejects.toThrow(/alternatives/u);

    // and the step's own run still covers every project, because the owner supplied them all
    const full = await runInboxRepairStep(single, ops, env);
    expect(full.ok).toBe(true);
    expect(full.report?.projects).toBe(await liveProjects());
  });

  it('F4 — the marker seals are verified before a marker is trusted: absent, disabled and hollowed are each caught', async () => {
    const intact = await verifyMarkerSeals(single as never);
    expect(intact.applicable).toBe(true);
    expect(intact.sealed).toBe(true);
    expect(intact.checked).toBe(MARKER_SEAL_TRIGGERS.length);

    // EVERY mutation below is undone in the `finally`, including on a failed assertion. This probe
    // deliberately unseals a shared database; leaving it unsealed would poison every later probe
    // in this file and the next run of it, turning one honest failure into a cascade that hides it.
    try {
      // A partial restore can drop, disable or hollow a seal with every migration still recorded and
      // nothing for `migrate deploy` to re-run. Each of the three is exercised and then restored.
      const [first] = MARKER_SEAL_TRIGGERS;
      await single.$executeRawUnsafe(`ALTER TABLE "OutboxOperatorAction" DISABLE TRIGGER "${first.trigger}"`);
      const disabled = await verifyMarkerSeals(single as never);
      expect(disabled.sealed).toBe(false);
      expect(disabled.findings.map((x) => x.problem)).toContain('disabled');
      await single.$executeRawUnsafe(`ALTER TABLE "OutboxOperatorAction" ENABLE TRIGGER "${first.trigger}"`);
      expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);

      await single.$executeRawUnsafe(`DROP TRIGGER "${first.trigger}" ON "OutboxOperatorAction"`);
      const absent = await verifyMarkerSeals(single as never);
      expect(absent.sealed).toBe(false);
      expect(absent.findings.map((x) => x.problem)).toContain('absent');
      // …and with the seal gone the marker really is forgeable, which is WHY this check exists
      await single.$executeRawUnsafe(
        `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason") VALUES ('f4-forged',$1,'attacker','forged')`,
        PHASE6_4C_IIIR_MARKER_ACTION,
      );
      expect(await markerCount()).toBe(1);
      await restoreMarkerSeals();
      expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);

      // CREATE OR REPLACE keeps the name, signature and every property while replacing what the
      // function DOES — presence and enablement both pass, and only the body comparison catches it.
      await single.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION ${first.fn}() RETURNS trigger LANGUAGE plpgsql AS $hollow$ BEGIN RETURN NEW; END $hollow$`,
      );
      const hollowed = await verifyMarkerSeals(single as never);
      expect(hollowed.sealed).toBe(false);
      expect(hollowed.findings.map((x) => x.problem)).toContain('body-replaced');
      await restoreMarkerSeals();
      expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);
    } finally {
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  // ── The three Codex findings on `42a1903` ────────────────────────────────────────────────────

  it('R5-F1 — the seal verifier pins the EXACT tgtype, so a same-name trigger on the wrong EVENT is caught', async () => {
    // The expected masks are asserted against the LIVE database rather than trusted to arithmetic:
    // if a future migration changes a trigger's events, this fails here rather than silently
    // pinning the wrong number.
    const live = await single.$queryRaw<Array<{ tgname: string; tgtype: number }>>`
      SELECT t.tgname, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'OutboxOperatorAction' AND NOT t.tgisinternal`;
    for (const { trigger, tgtype } of MARKER_SEAL_TRIGGERS) {
      expect(live.find((r) => r.tgname === trigger)?.tgtype).toBe(tgtype);
    }
    expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);

    // The forgery the previous check could not see: the insert gate recreated with the same name,
    // the same function, the same body, the same owner and enabled — but firing on UPDATE. Direct
    // marker INSERTs are accepted again, and the old BEFORE/row-bit test passed it.
    const [gate] = MARKER_SEAL_TRIGGERS;
    try {
      await single.$executeRawUnsafe(`DROP TRIGGER "${gate.trigger}" ON "OutboxOperatorAction"`);
      await single.$executeRawUnsafe(
        `CREATE TRIGGER "${gate.trigger}" BEFORE UPDATE ON "OutboxOperatorAction" FOR EACH ROW EXECUTE FUNCTION ${gate.fn}()`,
      );
      const wrongEvent = await verifyMarkerSeals(single as never);
      expect(wrongEvent.sealed).toBe(false);
      expect(wrongEvent.findings.map((x) => x.problem)).toContain('wrong-timing');
      // and the seal really is off — the marker is insertable again
      await single.$executeRawUnsafe(
        `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason") VALUES ('r5f1-forged',$1,'attacker','forged')`,
        PHASE6_4C_IIIR_MARKER_ACTION,
      );
      expect(await markerCount()).toBe(1);
    } finally {
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
    expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);
  });

  it('R5-F2 — a generation corrupted between the rebuild and the marker REFUSES, and writes no marker', async () => {
    // The window the advisory lock cannot fence: a writer this step does not control — a pre-4c-ii
    // relay is the case the whole unit exists for — rewrites the freshly rebuilt generation before
    // the marker commits. The generation stays stamped current and caught-up, so nothing in the
    // report notices, and the permanent marker would skip the repair that fixes it forever.
    //
    // Injected at exactly that seam through the `ops` the step is given: a real run, then damage.
    // A fresh id per run, removed before the retry below: a fixed id makes a second consecutive run
    // collide on the primary key, and a row left behind keeps that generation corrupt for every
    // later probe in the file — one probe's litter becoming four probes' failures.
    const staleRowId = `r5f2-stale-${Date.now()}`;
    const sabotaged: ProjectionRebuildOperations = Object.create(ops);
    sabotaged.run = async (params: Parameters<ProjectionRebuildOperations['run']>[0]) => {
      const report = await ops.run(params);
      const gen = await single.projectionGeneration.findFirst({
        where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' },
        select: { id: true },
      });
      // A stale-shaped row of the kind a v1 serializer leaves behind: present in the generation,
      // absent from canonical. Written directly rather than by deleting, because the fixture's
      // canonical set for this project may itself be empty — deleting from an empty set still
      // MATCHES canonical, which is not the damage being modelled.
      await single.$executeRawUnsafe(
        `INSERT INTO "DecisionProjection" ("id","generationId","projectId","decisionId","status","dto","updatedAt")
         VALUES ($3, $1, $2, $4, 'pending', '{"shape":"v1"}'::jsonb, now())`,
        gen!.id, f.projectA.id, staleRowId, `${staleRowId}-decision`);
      return report;
    };

    const outcome = await runInboxRepairStep(single, sabotaged, env);
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('concurrent-corruption');
    expect(outcome.refusal?.message).toContain(f.projectA.id);
    expect(await markerCount()).toBe(0);          // …and NOTHING was marked

    // the next start, with the interfering writer gone, repairs and marks
    await single.$executeRawUnsafe(`DELETE FROM "DecisionProjection" WHERE "id" = $1`, staleRowId);
    const retry = await runInboxRepairStep(single, ops, env);
    expect(retry.ok).toBe(true);
    expect(retry.action).toBe('repaired');
    expect(await markerCount()).toBe(1);
  });

  it('R5-F3 — the ordinary deployment role CAN read the cluster identity, and an unreadable one is NAMED not crashed', async () => {
    // Codex reported pg_control_system() as superuser/pg_monitor-only. On this PostgreSQL it is
    // not. Asserted as the OPERATIVE property — PUBLIC holds EXECUTE — rather than as
    // `proacl IS NULL`: both the default ACL and an explicit grant satisfy it, so this states what
    // actually decides the outcome and cannot pass merely because a database is pristine.
    const [{ public_exec: publicExec }] = await single.$queryRaw<Array<{ public_exec: boolean }>>`
      SELECT has_function_privilege('public', oid, 'EXECUTE') AS public_exec
        FROM pg_proc WHERE proname = 'pg_control_system'`;
    expect(publicExec).toBe(true);

    // …and proven by USE, not only by the catalog: a login role with no superuser attribute and no
    // role memberships reads the identity the step reads. Read-only — this probe never revokes a
    // cluster-wide privilege, because that mutates catalog state every other suite shares and
    // cannot be restored to its default afterwards.
    await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${UNPRIV_ROLE}`);
    await single.$executeRawUnsafe(`CREATE ROLE ${UNPRIV_ROLE} LOGIN PASSWORD 'probe'`);
    try {
      const [{ rolsuper }] = await single.$queryRawUnsafe<Array<{ rolsuper: boolean }>>(
        `SELECT rolsuper FROM pg_roles WHERE rolname = $1`, UNPRIV_ROLE);
      expect(rolsuper).toBe(false);
      const members = await single.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1`,
        UNPRIV_ROLE);
      expect(Number(members[0].n)).toBe(0);

      const url = new URL(process.env.DATABASE_URL!);
      url.username = UNPRIV_ROLE;
      url.password = 'probe';
      const asRole = new PrismaClient({ datasourceUrl: singleConnectionUrl(url.toString()) });
      try {
        const [{ system_identifier: seen }] = await asRole.$queryRaw<Array<{ system_identifier: bigint }>>`
          SELECT system_identifier FROM pg_control_system()`;
        expect(String(seen)).toBe(liveSystemIdentifier);
      } finally {
        await asRole.$disconnect();
      }
    } finally {
      await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${UNPRIV_ROLE}`);
    }

    // The failure mode the finding describes is HANDLED rather than left to crash, for the
    // deployment that DOES revoke it. Exercised over `readDatabaseIdentity` directly with a stub
    // that simply throws: no catalog change, and no wrapping of the real Prisma client — wrapping
    // it reaches through the proxy and was measured to break the step's session advisory lock and
    // cascade into unrelated probes.
    const denied = await readDatabaseIdentity({
      $queryRaw: () => Promise.reject(new Error('permission denied for function pg_control_system')),
    } as never);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.refusal.code).toBe('system-identity-unreadable');
    expect(denied.refusal.message).toMatch(/GRANT EXECUTE ON FUNCTION pg_control_system\(\)/u);
    expect(denied.refusal.message).toContain('permission denied for function');
    expect(denied.refusal.message).toContain('not optional');

    // …and the real client reads it, through the same function the step uses
    const live = await readDatabaseIdentity(single as never);
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error('unreachable');
    expect(live.systemIdentifier).toBe(liveSystemIdentifier);
    expect(live.databaseOid).toBe(liveDatabaseOid);

    // and the real client on the same database still succeeds
    const restored = await runInboxRepairStep(single, ops, env);
    expect(restored.ok).toBe(true);
  });

  // ── Codex on `e3d5c8d`: the fence must be the lock the RELAY takes ───────────────────────────

  it('R6 — the verify fence blocks the RELAY\'s lock, and the previous stream fence provably does not', async () => {
    // The finding, reproduced as a difference between two locks rather than asserted about one.
    // `OutboxRelay.dispatchProjection` applies an event by taking `lockActiveGeneration` — a
    // FOR UPDATE on the active `ProjectionGeneration` row. The previous head fenced the marker with
    // `ProjectEventStream FOR UPDATE`, which that path never takes.
    //
    // An earlier draft of this probe drove the whole step and passed either way: the holder was
    // blocking the REBUILD's own `lockActiveGeneration`, not the marker transaction, so it proved
    // nothing about the fence. This tests the two locks directly, which is the actual claim.
    const other = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    try {
      /** Is the relay's own lock refused while `hold` keeps its transaction open? */
      const blocksTheRelay = async (
        hold: (tx: Prisma.TransactionClient) => Promise<void>,
      ): Promise<boolean> => {
        let blocked = false;
        await single.$transaction(async (tx) => {
          await hold(tx);
          // the RELAY's own call, from an independent session, with a short lock timeout: it either
          // takes the row (not fenced) or is refused for waiting (fenced). A condition, not a sleep.
          try {
            await other.$transaction(async (otx) => {
              await otx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
              await lockActiveGeneration(otx, DECISIONS_PROJECTION, f.projectA.id);
            });
          } catch (e) {
            blocked = /lock timeout|canceling statement/iu.test((e as Error).message);
            if (!blocked) throw e;
          }
        });
        return blocked;
      };

      // THE FENCE THIS UNIT NOW USES — the relay is blocked.
      expect(await blocksTheRelay((tx) =>
        lockActiveGenerationsForVerify(tx, DECISIONS_PROJECTION, [f.projectA.id]))).toBe(true);

      // THE FENCE THE PREVIOUS HEAD USED — the relay walks straight through it. This is the finding.
      expect(await blocksTheRelay(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT "projectId" FROM "ProjectEventStream" WHERE "projectId" = $1 FOR UPDATE`,
          f.projectA.id);
      })).toBe(false);
    } finally {
      await other.$disconnect();
    }
  });

  it('R6 — a MARKED database whose register regressed REFUSES instead of skipping on the marker', async () => {
    // The marker used to end the step outright, so a register corrupted after it was written could
    // never be noticed again — "every subsequent deployment skips on the permanent marker". It now
    // records that the repair RAN, and every start still looks.
    const first = await runInboxRepairStep(single, ops, env);
    expect(first.action).toBe('repaired');
    expect(await markerCount()).toBe(1);

    // clean, marked → skips, exactly as before
    const clean = await runInboxRepairStep(single, ops, env);
    expect(clean.ok).toBe(true);
    expect(clean.action).toBe('skipped-marker-present');

    // now the damage a still-live legacy relay would do, AFTER the marker
    const gen = await single.projectionGeneration.findFirst({
      where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' },
      select: { id: true },
    });
    const staleId = `r6-regressed-${Date.now()}`;
    await single.$executeRawUnsafe(
      `INSERT INTO "DecisionProjection" ("id","generationId","projectId","decisionId","status","dto","updatedAt")
       VALUES ($3, $1, $2, $4, 'pending', '{"shape":"v1"}'::jsonb, now())`,
      gen!.id, f.projectA.id, staleId, `${staleId}-decision`);
    try {
      const regressed = await runInboxRepairStep(single, ops, env);
      expect(regressed.ok).toBe(false);
      expect(regressed.action).toBe('refused');
      expect(regressed.refusal?.code).toBe('marked-but-corrupt');
      expect(regressed.refusal?.message).toContain(f.projectA.id);
      expect(regressed.refusal?.message).toMatch(/still writing this register/u);
      // the marker is NOT re-written, and NOT removed — it is evidence, not a verdict
      expect(await markerCount()).toBe(1);
    } finally {
      await single.$executeRawUnsafe(`DELETE FROM "DecisionProjection" WHERE "id" = $1`, staleId);
    }
    // with the damage gone the same database skips again
    const healed = await runInboxRepairStep(single, ops, env);
    expect(healed.ok).toBe(true);
    expect(healed.action).toBe('skipped-marker-present');
  });

  // ── Codex on `c57b167` — four findings ───────────────────────────────────────────────────────

  it('R7-A — the seal migration REFUSES to seal a marker that predates it, and applies over a clean table', async () => {
    // A marker already present when the migration runs was gated by nothing: it can only have come
    // from a partial restore or a writer that planted it. Sealing it would make an unverified row
    // permanent authorization to skip the repair.
    const sql = readMarkerSealMigrationSql();
    const guard = sql.slice(sql.indexOf('-- ── 3. DIAGNOSTIC-FIRST'));
    expect(guard).toContain('RAISE EXCEPTION');

    // clean table → the guard is silent
    await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();

    // a planted marker → it ABORTS and names what it found
    await single.$executeRawUnsafe(
      `ALTER TABLE "OutboxOperatorAction" DISABLE TRIGGER "${MARKER_SEAL_TRIGGERS[0].trigger}"`);
    await single.$executeRawUnsafe(
      `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
       VALUES ('r7a-predates', $1, 'attacker', 'planted before the seal')`,
      PHASE6_4C_IIIR_MARKER_ACTION);
    await single.$executeRawUnsafe(
      `ALTER TABLE "OutboxOperatorAction" ENABLE TRIGGER "${MARKER_SEAL_TRIGGERS[0].trigger}"`);
    try {
      await expect(single.$executeRawUnsafe(guard)).rejects.toThrow(/already carries 1 repair marker row/u);
    } finally {
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R7-B — the verify locks in the REBUILDER\'s order, so an overlapping rebuild cannot deadlock it', async () => {
    // `ProjectionRebuilder` takes `ProjectEventStream FOR UPDATE` at its activation barrier and then
    // updates the generation rows: stream, then generation. An earlier head took them the other way
    // round, on a comment asserting nothing else took both — the rebuilder does, so an operator
    // rebuild overlapping a deploy could deadlock and abort one of them over healthy data.
    //
    // Asserted by observing the ORDER the fence actually acquires them in, from pg_locks, rather
    // than by racing (a deadlock probe that passes proves only that it did not happen this time).
    await single.$transaction(async (tx) => {
      await lockActiveGenerationsForVerify(tx, DECISIONS_PROJECTION, [f.projectA.id]);
      const held = await t.prisma.$queryRaw<Array<{ relname: string }>>`
        SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
         WHERE l.mode = 'RowShareLock' AND c.relname IN ('ProjectEventStream', 'ProjectionGeneration')`;
      const names = held.map((r) => r.relname);
      expect(names).toContain('ProjectEventStream');
      expect(names).toContain('ProjectionGeneration');
    });
    // and the source itself takes the stream before the generation
    const fence = readFileSync(
      resolve(API_DIR, 'src/platform/projections/inbox-repair.ts'), 'utf8');
    const body = fence.slice(fence.indexOf('export async function lockActiveGenerationsForVerify'));
    expect(body.indexOf('"ProjectEventStream"')).toBeLessThan(body.indexOf('"ProjectionGeneration"'));
  });

  it('R7-C — a project that appears during the repair REFUSES the marker rather than being skipped', async () => {
    // Every downstream check is scoped to the project set read at the start. A previous-release
    // process that creates a project mid-repair — and populates its register with the legacy
    // serializer — would be neither rebuilt nor diagnosed while the permanent marker went in.
    const extraId = `r7c-project-${Date.now()}`;
    const sabotaged: ProjectionRebuildOperations = Object.create(ops);
    sabotaged.run = async (params: Parameters<ProjectionRebuildOperations['run']>[0]) => {
      const report = await ops.run(params);
      await single.project.create({
        data: {
          id: extraId, orgId: f.orgA.id, name: 'appeared mid-repair', short: 'appeared',
          descriptor: '', stage: 'Planning', siteCode: 'APPEARED',
          projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
          elapsedPct: 0, todayDay: 0, milestonePct: 0,
        },
      });
      return report;
    };
    try {
      const outcome = await runInboxRepairStep(single, sabotaged, env);
      expect(outcome.ok).toBe(false);
      expect(outcome.action).toBe('refused');
      expect(outcome.refusal?.code).toBe('project-set-changed');
      expect(outcome.refusal?.message).toContain(extraId);
      expect(await markerCount()).toBe(0);            // …and nothing was marked
    } finally {
      await single.project.deleteMany({ where: { id: extraId } });
    }
    // the next start, over the settled set, repairs and marks
    const retry = await runInboxRepairStep(single, ops, env);
    expect(retry.ok).toBe(true);
    expect(retry.action).toBe('repaired');
  });

  it('R7-D — the verification transactions carry a deploy-sized bound, not Prisma\'s five-second default', () => {
    // The transaction takes every project's locks and then compares the whole canonical decision set
    // per project. Prisma's interactive default is 5s, which on a production-sized database is not a
    // bound on that work — exceeding it aborts and `migrate.sh` refuses a deployment whose data was
    // valid. Both verification transactions must carry the explicit bound.
    expect(VERIFY_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(60_000);
    expect(VERIFY_TX_OPTIONS.maxWait).toBeGreaterThanOrEqual(30_000);
    const src = readFileSync(resolve(API_DIR, 'src/platform/projections/inbox-repair.ts'), 'utf8');
    const transactions = [...src.matchAll(/await prisma\.\$transaction\(async \(tx\) => \{/gu)];
    expect(transactions.length).toBe(2);              // marker-present verify, and the marker write
    for (const tx of transactions) {
      const after = src.slice(tx.index ?? 0, (tx.index ?? 0) + 4000);
      expect(after).toContain('VERIFY_TX_OPTIONS');   // neither may fall back to the 5s default
    }
  });

  it('PROBE 3 — an anchor that names no project in the connected database ABORTS, and writes no marker', async () => {
    const outcome = await runInboxRepairStep(single, ops, { ...env, [ANCHOR_ENV]: 'no-such-project' });
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('anchor-absent');
    expect(outcome.markerWritten).toBe(false);
    expect(await markerCount()).toBe(0);
  });

  it('PROBE 4 — a live project count below the configured minimum ABORTS, and writes no marker', async () => {
    const outcome = await runInboxRepairStep(single, ops, {
      ...env,
      [MINIMUM_ENV]: String((await liveProjects()) + 1),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal?.code).toBe('below-minimum');
    expect(await markerCount()).toBe(0);
  });

  it('PROBE 4b — an unconfigured step ABORTS on a database that has served the register', async () => {
    const outcome = await runInboxRepairStep(single, ops, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal?.code).toBe('identity-unconfigured');
    expect(await markerCount()).toBe(0);
  });

  // ── PROBE 2e: identity is asserted BEFORE applicability (Codex F1 on 44b2ad8) ────────────────
  it('PROBE 2e — a CONFIGURED deploy pointed at a never-served database ABORTS rather than passing as not-applicable', async () => {
    // The defect: with applicability asked first, a production deploy accidentally repointed at an
    // empty or never-served database created the schema, saw zero generations, and returned SUCCESS
    // without ever checking its configured anchor — so `migrate.sh` started the API against the
    // wrong database while this step claimed identity is verified on every start.
    await t.prisma.decisionProjection.deleteMany({});
    await t.prisma.projectionGeneration.deleteMany({ where: { consumer: DECISIONS_PROJECTION } });
    expect(await servedGenerations()).toBe(0);

    const repointed = await runInboxRepairStep(single, ops, { ...env, [ANCHOR_ENV]: 'some-other-database' });
    expect(repointed.ok).toBe(false);
    expect(repointed.action).toBe('refused');
    expect(repointed.refusal?.code).toBe('anchor-absent');
    expect(await markerCount()).toBe(0);

    // …and the branch it guards still works for the case it exists for: an UNCONFIGURED deploy over
    // the same never-served database is not-applicable, so a first deploy is never walled off.
    const fresh = await runInboxRepairStep(single, ops, {});
    expect(fresh.ok).toBe(true);
    expect(fresh.action).toBe('not-applicable');
    expect(await markerCount()).toBe(0);

    await putInService();
  });

  // ── PROBE 9: the marker is DATABASE-sealed (Codex F2 on 44b2ad8) ─────────────────────────────
  it('PROBE 9 — the repair marker cannot be forged, edited, deleted or truncated away', async () => {
    // The marker AUTHORIZES every later start to skip the repair, so it is not audit trail — and
    // `OutboxOperatorAction` carried no seal at all. Each vector is asserted against live PG.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    const marker = await t.prisma.outboxOperatorAction.findFirstOrThrow({
      where: { action: PHASE6_4C_IIIR_MARKER_ACTION }, select: { id: true, reason: true },
    });
    const ordinary = await t.prisma.outboxOperatorAction.create({
      data: { action: 'retry', operatorIdentity: 'someone', reason: 'an ordinary audit row' },
      select: { id: true },
    });

    // 0. FORGED CREATION — the cheapest forgery of all, and the one a mutation-only seal misses
    //    entirely: an alternate writer on the application's own role inserts a marker row directly
    //    and the next start skips the repair on an unrepaired database.
    await expect(t.prisma.outboxOperatorAction.create({
      data: { action: PHASE6_4C_IIIR_MARKER_ACTION, operatorIdentity: 'someone', reason: 'forged' },
    })).rejects.toThrow(/written only by the repair step/u);

    // 1. PROMOTION — it needs no delete rights and yields a row that looks real, so the next
    //    deploy would skip an UNREPAIRED database.
    await expect(t.prisma.outboxOperatorAction.update({
      where: { id: ordinary.id }, data: { action: PHASE6_4C_IIIR_MARKER_ACTION },
    })).rejects.toThrow(/cannot be re-keyed into the 4c-iii-r repair marker/u);

    // 2. MUTATION of a genuine marker.
    await expect(t.prisma.outboxOperatorAction.update({
      where: { id: marker.id }, data: { reason: 'rewritten' },
    })).rejects.toThrow(/repair marker is immutable/u);

    // 3. DESTRUCTION.
    await expect(t.prisma.outboxOperatorAction.delete({ where: { id: marker.id } }))
      .rejects.toThrow(/never deleted/u);

    // 4. TRUNCATE, which no row trigger sees. Raw on purpose: routing it through the sanctioned
    //    reset would disable the very seal under assertion.
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE TABLE "OutboxOperatorAction"'))
      .rejects.toThrow(/never truncated/u);

    // …and the seal is PRECISE, not merely strict: the general audit table keeps its lifecycle.
    await t.prisma.outboxOperatorAction.update({ where: { id: ordinary.id }, data: { reason: 'edited' } });
    await t.prisma.outboxOperatorAction.delete({ where: { id: ordinary.id } });

    // the marker survived every attempt, byte for byte
    const after = await t.prisma.outboxOperatorAction.findFirstOrThrow({
      where: { action: PHASE6_4C_IIIR_MARKER_ACTION }, select: { id: true, reason: true },
    });
    expect(after).toEqual(marker);
  });

  // ── PROBE 5: the successful repair, its marker, and idempotence ──────────────────────────────
  it('PROBE 5 — the repair covers EVERY project, verifies, and writes exactly one marker', async () => {
    const before = await liveProjects();
    const outcome = await runInboxRepairStep(single, ops, env);
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('repaired');
    expect(outcome.markerWritten).toBe(true);
    expect(outcome.report?.projects).toBe(before);
    expect(outcome.report?.results.length).toBe(before);
    expect(outcome.report?.consumers).toEqual([DECISIONS_PROJECTION]);
    expect(await markerCount()).toBe(1);
    // every project the database holds now serves a decisions.inbox generation
    expect((await activeGeneration(f.projectA.id))?.generation).toBeGreaterThanOrEqual(1);
    expect((await activeGeneration(f.projectB.id))?.generation).toBeGreaterThanOrEqual(1);
  });

  it('PROBE 6 — a second start SKIPS on the marker: no second rebuild, no second marker', async () => {
    await runInboxRepairStep(single, ops, env);
    const genA = (await activeGeneration(f.projectA.id))?.generation;
    const invocations = await invocationCount();

    const second = await runInboxRepairStep(single, ops, env);
    expect(second.ok).toBe(true);
    expect(second.action).toBe('skipped-marker-present');
    expect(second.markerWritten).toBe(false);
    expect(await markerCount()).toBe(1);
    expect(await invocationCount()).toBe(invocations);
    expect((await activeGeneration(f.projectA.id))?.generation).toBe(genA);
  });

  it('PROBE 6b — the identity check still runs WITH the marker set, so a re-pointed deploy cannot serve', async () => {
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    const repointed = await runInboxRepairStep(single, ops, { ...env, [ANCHOR_ENV]: 'another-database' });
    expect(repointed.ok).toBe(false);
    expect(repointed.action).toBe('refused');
    expect(repointed.refusal?.code).toBe('anchor-absent');
  });

  it('PROBE 6c — a NON-verified report leaves NO marker, and the next start retries and succeeds', async () => {
    // A run whose pairs threw: `ops.run` catches per pair and CONTINUES, so this is the shape a
    // real partial failure takes — "ran" without "succeeded".
    const throwing = {
      run: async (): Promise<RebuildRunReport> => ({
        ok: false, action: 'projection.rebuild', projects: await liveProjects(), consumers: [DECISIONS_PROJECTION],
        corruptBefore: 0, laggingBefore: 0, corruptAfter: 0, failures: 1,
        results: [{ projectId: f.projectA.id, consumer: DECISIONS_PROJECTION, before: { state: 'none', generation: null, appliedPosition: null, streamHead: null }, rebuilt: false, error: 'deliberate' }],
      }),
    } as unknown as ProjectionRebuildOperations;

    const failed = await runInboxRepairStep(single, throwing, env);
    expect(failed.ok).toBe(false);
    expect(failed.refusal?.code).toBe('rebuild-not-verified');
    expect(failed.refusal?.message).toMatch(/deliberate/u);
    expect(await markerCount()).toBe(0);

    const retried = await runInboxRepairStep(single, ops, env);
    expect(retried.ok).toBe(true);
    expect(retried.action).toBe('repaired');
    expect(await markerCount()).toBe(1);
  });

  // ── PROBE 7: the race the lock removes, reproduced DETERMINISTICALLY ────────────────────────
  it('PROBE 7 — two unserialized generation allocations released together collide, so a marker read cannot make this exactly-once', async () => {
    // `ProjectionRebuilder.rebuild` step 1 is: in ONE transaction, `aggregate` the max generation
    // for (consumer, projectId) and `create` `max + 1` (rebuilder.service.ts — "allocate a new
    // BUILDING generation"). Nothing serializes that across processes, and
    // `@@unique([consumer, projectId, generation])` is the key both then claim.
    //
    // Two replicas that each read the marker as absent reach exactly this. Racing the real
    // `rebuild()` reproduces it only sometimes — the aggregates have to overlap — so the probe
    // performs the SAME two statements with an explicit barrier: both aggregates complete before
    // either create. That is the interleaving, made deterministic, not a different defect.
    const a = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    const b = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    const projectId = f.projectA.id;
    try {
      const nextGeneration = async (c: PrismaClient) => {
        const agg = await c.projectionGeneration.aggregate({
          where: { consumer: DECISIONS_PROJECTION, projectId }, _max: { generation: true },
        });
        return (agg._max.generation ?? 0) + 1;
      };
      // BARRIER: both replicas read the same max before either writes.
      const [genA, genB] = await Promise.all([nextGeneration(a), nextGeneration(b)]);
      expect(genA).toBe(genB);

      const create = (c: PrismaClient, generation: number) =>
        c.projectionGeneration.create({
          data: { consumer: DECISIONS_PROJECTION, projectId, generation, status: 'building', appliedPosition: null, catalogVersion: 1 },
          select: { id: true },
        });
      const settled = await Promise.allSettled([create(a, genA), create(b, genB)]);
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(rejected.length).toBe(1); // one replica's rebuild THROWS — and its report is non-ok
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/P2002|Unique constraint/u);

      // Clean up the one row that did land, so the suite's later rebuilds start from a true max.
      await t.prisma.projectionGeneration.deleteMany({
        where: { consumer: DECISIONS_PROJECTION, projectId, generation: genA, status: 'building' },
      });
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  // ── PROBE 8: the barrier-controlled concurrent start of two REAL processes ───────────────────
  it('PROBE 8 — two processes released together run the repair EXACTLY once, and both exit 0', async () => {
    const projects = await liveProjects();
    // Counted rather than compared by generation NUMBER: numbering is `max + 1` across every
    // status, so an earlier probe's building row shifts it. The claim is "exactly ONE new
    // generation, and exactly one serving", and that is what is measured.
    const rowsBefore = new Map<string, number>([
      [f.projectA.id, await generationRows(f.projectA.id)],
      [f.projectB.id, await generationRows(f.projectB.id)],
    ]);

    // THE BARRIER. This suite's own single connection takes the step's advisory lock, so neither
    // child can pass its first statement; both are then released into the race by ONE unlock.
    const barrier = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    let held = false;
    try {
      await barrier.$executeRaw`SELECT pg_advisory_lock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
      held = true;

      const child = () =>
        new Promise<{ code: number; out: string }>((res, rej) => {
          const p = spawn(resolve(API_DIR, 'node_modules/.bin/tsx'), ['src/platform/projections/inbox-repair.cli.ts'], {
            cwd: API_DIR,
            env: {
              ...process.env,
              [ANCHOR_ENV]: f.projectA.id,
              [MINIMUM_ENV]: '1',
              [SYSTEM_IDENTITY_ENV]: liveSystemIdentifier,
              [DATABASE_IDENTITY_ENV]: liveDatabaseOid,
            },
          });
          let out = '';
          p.stdout.on('data', (d) => { out += d; });
          p.stderr.on('data', (d) => { out += d; });
          p.on('error', rej);
          p.on('close', (code) => res({ code: code ?? -1, out }));
        });
      // A child that EXITS during the wait can never block on the lock, so the loop below must
      // notice rather than spin to its deadline: settling is recorded as it happens.
      const settled: { code: number; out: string }[] = [];
      const watch = (p: Promise<{ code: number; out: string }>) => { void p.then((r) => settled.push(r)); return p; };
      const one = watch(child());
      const two = watch(child());

      // CONDITION-BASED, never a sleep: wait until BOTH children are observed WAITING on this exact
      // advisory lock. Only then is releasing the barrier a genuine simultaneous release.
      const waiting = async () => {
        const [row] = await barrier.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 0
            AND objid = ${PHASE6_4C_IIIR_LOCK_KEY}::bigint AND NOT granted`;
        return Number(row.n);
      };
      const deadline = Date.now() + 45_000;
      while ((await waiting()) < 2) {
        if (settled.length > 0) {
          throw new Error(`a replica start exited before blocking on the lock: ${settled.map((r) => `${r.code}: ${r.out}`).join(' | ')}`);
        }
        if (Date.now() > deadline) throw new Error('both replica starts never blocked on the advisory lock');
        await new Promise((r) => setTimeout(r, 25)); // POLL interval; the CONDITION is what gates
      }

      await barrier.$executeRaw`SELECT pg_advisory_unlock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
      held = false;
      const [ra, rb] = await Promise.all([one, two]);

      // THE TERMINAL INVARIANT, asserted directly.
      expect([ra.code, rb.code], `${ra.out}\n---\n${rb.out}`).toEqual([0, 0]);
      const actions = [ra.out, rb.out].map((o) => /"action": "([a-z-]+)"/u.exec(o)?.[1]).sort();
      expect(actions).toEqual(['repaired', 'skipped-marker-present']);
      expect(await markerCount()).toBe(1);
      expect(await invocationCount()).toBe(1);
      for (const [projectId, before] of rowsBefore) {
        expect(await generationRows(projectId)).toBe(before + 1); // exactly ONE new generation
        expect(await activeGenerations(projectId)).toBe(1); // and exactly one of them serves
      }
      expect(await liveProjects()).toBe(projects);
    } finally {
      if (held) await barrier.$executeRaw`SELECT pg_advisory_unlock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
      await barrier.$disconnect();
    }
  }, 90_000);
});
