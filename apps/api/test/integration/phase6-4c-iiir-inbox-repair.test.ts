import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
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
  acquireRepairLock,
  PHASE6_4C_IIIR_MARKER_ACTION,
  PHASE6_4C_IIIR_OPERATOR,
  readIdentityConfig,
  runInboxRepairStep,
  summarizeForDeployLog,
  resolveCatchUpBudgetMs,
  CATCH_UP_BUDGET_MS,
  CATCH_UP_BUDGET_DEFAULT_MS,
  CATCH_UP_BUDGET_MAX_MS,
  SYSTEM_IDENTITY_ENV,
  diagnoseCurrentProjects,
  lockActiveGenerationsForVerify,
  VERIFY_TX_OPTIONS,
  readDatabaseIdentity,
  singleConnectionUrl,
  verifyReport,
} from '../../src/platform/projections/inbox-repair';
import {
  MARKER_FORGERY_SEALS,
  opensForgeryWindow,
  MARKER_SEAL_TRIGGERS,
  SealRepairPrivilegeError,
  extractCanonicalMarkerBodies,
  readMarkerSealMigrationSql,
  repairMarkerSeals,
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
  const orgsParticipant = new OrgsParticipant();
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
    const guard = sql.slice(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'), sql.indexOf('-- ── 1.'));
    expect(guard).toContain('RAISE EXCEPTION');

    // clean table → the guard is silent
    await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();

    // a planted marker → it ABORTS and names what it found
    // The genuine pre-migration state has NO seals at all, which is also what now distinguishes a
    // pre-seal marker from one written under a working seal (see R9-3).
    for (const { trigger } of MARKER_SEAL_TRIGGERS) {
      await single.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "OutboxOperatorAction"`);
    }
    await single.$executeRawUnsafe(
      `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
       VALUES ('r7a-predates', $1, 'attacker', 'planted before the seal')`,
      PHASE6_4C_IIIR_MARKER_ACTION);
    try {
      await expect(single.$executeRawUnsafe(guard)).rejects.toThrow(/carries 1 repair marker row\(s\)/u);
    } finally {
      await restoreMarkerSeals();
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
    // valid. EVERY verification transaction must carry the explicit bound, and the count is pinned
    // so a new one cannot be added without this probe noticing — it caught the row-comparison
    // transaction round 17 added, and again when round 18 removed it.
    expect(VERIFY_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(60_000);
    expect(VERIFY_TX_OPTIONS.maxWait).toBeGreaterThanOrEqual(30_000);
    const src = readFileSync(resolve(API_DIR, 'src/platform/projections/inbox-repair.ts'), 'utf8');
    const transactions = [...src.matchAll(/await prisma\.\$transaction\(async \(tx\) => \{/gu)];
    // `diagnoseCurrentProjects` (which the post-commit re-ask reuses) · the marker write.
    // Round 17 briefly added a third; round 18 removed it again by re-asking through the fenced
    // path instead of comparing rows itself, so the count is back to two.
    expect(transactions.length).toBe(2);
    for (const tx of transactions) {
      // to the END of that call, not a fixed window: the bodies grow, and a probe that silently
      // stopped scanning before the options would pass while the bound was gone.
      const from = tx.index ?? 0;
      const end = src.indexOf('\n    }, ', from) >= 0 ? src.indexOf('\n    }, ', from) : src.indexOf('\n      }, ', from);
      expect(end).toBeGreaterThan(from);
      expect(src.slice(from, end + 200)).toContain('VERIFY_TX_OPTIONS');
    }
  });

  // ── Codex on `e8b6d8c` — five findings ───────────────────────────────────────────────────────

  it('R8-1 — the migration asks its question BEFORE installing anything, so the documented cleanup works', () => {
    // Placed after the trigger installs, a database carrying a pre-seal marker would have the seals
    // applied and THEN abort — and the DELETE the message documents would be refused by the seal
    // that had just been installed, leaving every retry to reinstall and hit the same exception.
    const sql = readMarkerSealMigrationSql();
    const guardEnd = sql.indexOf('-- ── 1.');
    expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(guardEnd);
    expect(sql.indexOf('CANNOT be shown to')).toBeLessThan(guardEnd);
    // the DDL STATEMENTS, anchored to the start of a line so that a mention of one inside a comment
    // cannot stand in for the real thing — every one of them comes after the question is asked.
    expect(sql.indexOf('\nCREATE OR REPLACE FUNCTION phase6_4c_iiir_')).toBeGreaterThan(guardEnd);
    expect(sql.indexOf('\nDROP TRIGGER IF EXISTS "')).toBeGreaterThan(guardEnd);
    expect(sql.indexOf('\nCREATE TRIGGER "')).toBeGreaterThan(guardEnd);
  });

  it('R8-2 — a LAGGING generation is not evidence: the post-rebuild check requires a content match', async () => {
    // `diagnoseIn` returns `lagging` as soon as the checkpoint trails the head — before comparing a
    // single row. An old relay's v1-shaped rewrite plus one undelivered position therefore reported
    // `lagging`, and a "not corrupt" test wrote the marker over it.
    const sabotaged: ProjectionRebuildOperations = Object.create(ops);
    sabotaged.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      return projectId === f.projectA.id ? { ...real, state: 'lagging' as const } : real;
    };
    const outcome = await runInboxRepairStep(single, sabotaged, env);
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('concurrent-corruption');
    expect(outcome.refusal?.message).toContain('lagging');
    expect(await markerCount()).toBe(0);

    // …and the honest states still pass: an unmolested run marks
    const clean = await runInboxRepairStep(single, ops, env);
    expect(clean.ok).toBe(true);
    expect(clean.action).toBe('repaired');
  });

  it('R8-4 — the marker-present path re-reads the CURRENT project set, not the start-of-step snapshot', async () => {
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);

    // a project that exists NOW but was not in any earlier snapshot, carrying a corrupt generation
    const lateId = `r8-late-${Date.now()}`;
    await single.project.create({
      data: {
        id: lateId, orgId: f.orgA.id, name: 'late project', short: 'late', descriptor: '',
        stage: 'Planning', siteCode: 'LATE', projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
        elapsedPct: 0, todayDay: 0, milestonePct: 0,
      },
    });
    try {
      await new ProjectionRebuilder(single as never).rebuild(DECISIONS_PROJECTION, lateId);
      const gen = await single.projectionGeneration.findFirst({
        where: { consumer: DECISIONS_PROJECTION, projectId: lateId, status: 'active' },
        select: { id: true },
      });
      await single.$executeRawUnsafe(
        `INSERT INTO "DecisionProjection" ("id","generationId","projectId","decisionId","status","dto","updatedAt")
         VALUES ($3, $1, $2, $4, 'pending', '{"shape":"v1"}'::jsonb, now())`,
        gen!.id, lateId, `${lateId}-stale`, `${lateId}-decision`);

      // THE DIFFERENCE, made visible: the same check over a STALE snapshot (the set as it was
      // before this project existed) misses it entirely, while re-reading the live set finds it.
      // That contrast is the finding — a probe that only asserted the end state would pass whether
      // the code re-read or not, because the project already existed when the step began.
      const stale = (await single.project.findMany({
        where: { id: { not: lateId } }, select: { id: true }, orderBy: { id: 'asc' },
      })).map((r) => r.id);
      expect((await diagnoseCurrentProjects(single as never, ops, orgsParticipant, f.projectA.id, stale)).corrupt)
        .toEqual([]);                                   // the snapshot cannot see it…
      expect((await diagnoseCurrentProjects(single as never, ops, orgsParticipant, f.projectA.id)).corrupt)
        .toContain(`${lateId}/${DECISIONS_PROJECTION}`); // …and the live re-read does

      // and end to end, on the marker-present skip path
      const outcome = await runInboxRepairStep(single, ops, env);
      expect(outcome.ok).toBe(false);
      expect(outcome.refusal?.code).toBe('marked-but-corrupt');
      expect(outcome.refusal?.message).toContain(lateId);
    } finally {
      await single.$executeRawUnsafe(`DELETE FROM "DecisionProjection" WHERE "projectId" = $1`, lateId);
      await single.projectionGeneration.deleteMany({ where: { projectId: lateId } });
      await single.project.deleteMany({ where: { id: lateId } });
    }
  });

  it('R8-5 — `seals repair` restores the seals with a GENUINE marker present, where the migration cannot', async () => {
    // The database that actually needs repairing is one that HAS a marker and lost a trigger. The
    // migration's own first act now refuses exactly that database, so re-running it is not the
    // recovery — this command is, and it must succeed and verify rather than half-apply.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      // ALL THREE, not just the first: dropping only one is restored by a repair that applies only
      // the first statement of each group, so a one-trigger probe cannot tell a complete reinstall
      // from a partial one — measured, on exactly that mutation.
      for (const { trigger } of MARKER_SEAL_TRIGGERS) {
        await single.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "OutboxOperatorAction"`);
      }
      const broken = await verifyMarkerSeals(single as never);
      expect(broken.sealed).toBe(false);
      expect(broken.findings.length).toBe(MARKER_SEAL_TRIGGERS.length);

      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.findings).toEqual([]);
      // the marker is INVALIDATED, not preserved: it lived through a window with no seal, so it
      // cannot be vouched for (R9-2). The next start earns a new one.
      expect(repaired.markersInvalidated).toBe(1);
      expect(await markerCount()).toBe(0);

      // and it is idempotent: running it on an already-sealed database is still sealed, and now
      // finds no marker to invalidate
      const again = await repairMarkerSeals(single as never);
      expect(again.sealed).toBe(true);
      expect(again.markersInvalidated).toBe(0);
    } finally {
      await restoreMarkerSeals();
    }
    // the same database now deploys — and REPAIRS, because the invalidated marker must be earned
    const after = await runInboxRepairStep(single, ops, env);
    expect(after.ok).toBe(true);
    expect(after.action).toBe('repaired');
  });

  // ── Codex on `8eea3ca` — three findings ──────────────────────────────────────────────────────

  it('R9-1 — a MARKED start that cannot verify a generation REPAIRS rather than skipping', async () => {
    // `lagging`/`blocked` come back before a single row is compared, so they are the absence of
    // evidence. Skipping on them let a legacy relay's rewrite ride through: the rewrite plus one
    // undelivered position reads as `lagging`, the start skips, and the current relay then advances
    // the checkpoint past that position as a noop without refreshing the rows.
    //
    // Refusing would be worse than the hole — a lagging projection is ordinary between deploys and
    // the process that would catch it up is the container being replaced — so the step repairs.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);

    let rebuilds = 0;
    const laggy: ProjectionRebuildOperations = Object.create(ops);
    laggy.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      // report `lagging` for projectA only until the repair has run, so the post-rebuild check
      // sees the honest state and the marker path sees the unverifiable one.
      return projectId === f.projectA.id && rebuilds === 0 ? { ...real, state: 'lagging' as const } : real;
    };
    laggy.run = async (params: Parameters<ProjectionRebuildOperations['run']>[0]) => {
      rebuilds += 1;
      return ops.run(params);
    };

    const outcome = await runInboxRepairStep(single, laggy, env);
    expect(rebuilds).toBe(1);                       // it REPAIRED instead of skipping…
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('repaired');
    expect(await markerCount()).toBe(1);            // …and did not write a second marker
  });

  it('R9-2 — `seals repair` INVALIDATES a marker it cannot vouch for, so the next start must earn a new one', async () => {
    // The repair runs because a seal was missing — and while it was missing, any marker on this
    // database could have been inserted, promoted or rewritten by anyone holding the app's role.
    // Restoring the seal AROUND such a row would make an unverifiable marker permanent evidence.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      for (const { trigger } of MARKER_SEAL_TRIGGERS) {
        await single.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "OutboxOperatorAction"`);
      }
      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.markersInvalidated).toBe(1);
      expect(await markerCount()).toBe(0);          // the untrustworthy marker is gone

      // …so the next start REPAIRS and writes a fresh, verified marker rather than skipping
      const next = await runInboxRepairStep(single, ops, env);
      expect(next.ok).toBe(true);
      expect(next.action).toBe('repaired');
      expect(await markerCount()).toBe(1);
      // …and it is PRECISE, not merely destructive: the TRUNCATE guard can only DESTROY a marker,
      // never manufacture one, so a marker that outlived its absence is exactly as trustworthy as
      // one that never met it and is KEPT. (The two seals whose failure DOES open a forgery window
      // — the insert gate and the row seal — are R10-1 and R10-1b.)
      expect(await markerCount()).toBe(1);          // the fresh marker `next` just earned
      await single.$executeRawUnsafe(
        `DROP TRIGGER "OutboxOperatorAction_4c_iiir_no_truncate" ON "OutboxOperatorAction"`);
      const partial = await repairMarkerSeals(single as never);
      expect(partial.sealed).toBe(true);
      expect(partial.markersInvalidated).toBe(0);
      expect(await markerCount()).toBe(1);          // the genuine marker survives
    } finally {
      await restoreMarkerSeals();
    }
  });

  it('R9-3 — the completed migration RE-RUNS over a sealed database, and still refuses a pre-seal marker', async () => {
    // A restore or ledger repair can lose this migration's `_prisma_migrations` row while the
    // triggers and a genuine marker survive; `migrate deploy` then re-runs the file. Without the
    // seal test it aborts forever, and the DELETE its message suggests is refused by the very seal
    // still installed.
    const sql = readMarkerSealMigrationSql();
    const guard = sql.slice(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'), sql.indexOf('-- ── 1.'));

    await runInboxRepairStep(single, ops, env);     // a GENUINE marker, written under the seal
    expect(await markerCount()).toBe(1);
    await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();   // re-runnable

    // and with the seal ABSENT the same marker is refused — the check it exists for still bites
    try {
      await single.$executeRawUnsafe(
        `DROP TRIGGER "OutboxOperatorAction_4c_iiir_marker_sealed" ON "OutboxOperatorAction"`);
      await expect(single.$executeRawUnsafe(guard))
        .rejects.toThrow(/carries 1 repair marker row\(s\)[\s\S]*marker_sealed: trigger .* is absent/u);
    } finally {
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  // ── Codex round 10 — two findings ────────────────────────────────────────────────────────────

  it('R10-1 — `seals repair` invalidates markers after an INSERT-GATE gap, with the row seal intact', async () => {
    // The earlier predicate keyed invalidation on the ROW SEAL alone. But the row seal fires BEFORE
    // UPDATE OR DELETE and never sees an INSERT, so the insert gate failing on its own is a window
    // in which a marker can be manufactured by the cheapest write there is — and the repair then
    // reinstalled the gate AROUND the forgery, making it permanent evidence.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      // exactly as a partial restore opens it: the row seal and the truncate guard are untouched
      // and perfect, so every check but one reads as sealed.
      await single.$executeRawUnsafe(
        `DROP TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" ON "OutboxOperatorAction"`);
      const broken = await verifyMarkerSeals(single as never);
      expect(broken.findings.map((x) => x.fn)).toEqual(['phase6_4c_iiir_marker_insert_gated']);

      // WHAT THE WINDOW ADMITS, demonstrated rather than asserted: a plain INSERT by the
      // application's own role now manufactures a marker the next start would skip on.
      await single.$executeRawUnsafe(
        `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
         VALUES ('r10-forged',$1,'attacker','forged through the insert-gate gap')`,
        PHASE6_4C_IIIR_MARKER_ACTION);
      expect(await markerCount()).toBe(2);

      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      // BOTH go. The genuine one is indistinguishable from the forgery — that is what a window
      // means — and the delete has to run through an INTACT row seal, which is why the repair now
      // drops the triggers, deletes, and recreates inside ONE transaction.
      expect(repaired.markersInvalidated).toBe(2);
      expect(await markerCount()).toBe(0);
    } finally {
      await restoreMarkerSeals();
    }
    // the gate is back and enforcing: the same insert is refused again…
    await expect(single.$executeRawUnsafe(
      `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
       VALUES ('r10-forged-2',$1,'attacker','forged')`, PHASE6_4C_IIIR_MARKER_ACTION))
      .rejects.toThrow(/written only by the repair step/u);
    // …and the next start EARNS a fresh marker rather than skipping on the invalidated one
    const next = await runInboxRepairStep(single, ops, env);
    expect(next.ok).toBe(true);
    expect(next.action).toBe('repaired');
    expect(await markerCount()).toBe(1);
  });

  it('R10-1b — a DISABLED insert gate is the same window, and invalidates the same way', async () => {
    // `ALTER TABLE … DISABLE TRIGGER` leaves the row in `pg_trigger` untouched, so presence says
    // nothing; the gap it opens is identical to the dropped one.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      await single.$executeRawUnsafe(
        `ALTER TABLE "OutboxOperatorAction" DISABLE TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated"`);
      const broken = await verifyMarkerSeals(single as never);
      expect(broken.findings.map((x) => x.problem)).toEqual(['disabled']);

      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.markersInvalidated).toBe(1);
      expect(await markerCount()).toBe(0);
    } finally {
      await restoreMarkerSeals();
    }
  });

  it('R10-2 — the re-run adoption test verifies the WHOLE seal, not a trigger name', async () => {
    // A name is not enforcement. The earlier test counted a same-named row trigger and adopted the
    // marker on that alone, so a seal that was disabled, hollowed, re-masked or missing its insert
    // gate was blessed and its triggers replaced with canonical ones — permanently.
    const sql = readMarkerSealMigrationSql();
    const guard = sql.slice(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'), sql.indexOf('-- ── 1.'));
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      // baseline: fully sealed, so the genuine marker IS adopted and the completed file re-runs
      await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();

      // (a) the insert gate DISABLED — present, correctly named, right function, right body
      await single.$executeRawUnsafe(
        `ALTER TABLE "OutboxOperatorAction" DISABLE TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated"`);
      await expect(single.$executeRawUnsafe(guard)).rejects.toThrow(/marker_insert_gated: tgenabled='D'/u);
      await single.$executeRawUnsafe(
        `ALTER TABLE "OutboxOperatorAction" ENABLE TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated"`);
      await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();

      // (b) the row seal HOLLOWED — `CREATE OR REPLACE FUNCTION` keeps the OID, name, signature and
      // every other identity property while replacing what the function DOES
      await single.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION phase6_4c_iiir_marker_sealed() RETURNS trigger
         LANGUAGE plpgsql AS $hollow$ BEGIN RETURN NEW; END $hollow$`);
      await expect(single.$executeRawUnsafe(guard))
        .rejects.toThrow(/marker_sealed: the function body is not the one this migration installs/u);
      await restoreMarkerSeals();

      // (c) the WRONG EVENT MASK — same name, function, body and owner, but BEFORE UPDATE, so
      // direct marker INSERTs were accepted throughout (tgtype 19, not 7)
      await single.$executeRawUnsafe(
        `DROP TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" ON "OutboxOperatorAction"`);
      await single.$executeRawUnsafe(
        `CREATE TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" BEFORE UPDATE
           ON "OutboxOperatorAction" FOR EACH ROW
           EXECUTE FUNCTION phase6_4c_iiir_marker_insert_gated()`);
      await expect(single.$executeRawUnsafe(guard)).rejects.toThrow(/tgtype=19 is not 7/u);
      await restoreMarkerSeals();

      // (d) and the exclusion is DELIBERATE, not an oversight: the truncate guard can only destroy
      // a marker, never manufacture one, so a marker that outlived its absence is still adopted.
      await single.$executeRawUnsafe(
        `DROP TRIGGER "OutboxOperatorAction_4c_iiir_no_truncate" ON "OutboxOperatorAction"`);
      await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();
    } finally {
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R10-3 — the body digests the re-run test pins ARE the bodies this migration installs', () => {
    // The adoption test compares `md5(prosrc)` against constants, and a constant is a second copy
    // of the truth. This is what stops it drifting: the digests are recomputed here from the very
    // `$$ … $$` literals the file installs FROM, so editing a trigger function without repinning
    // fails HERE rather than silently turning the adoption test into a no-op.
    const sql = readMarkerSealMigrationSql();
    const bodies = extractCanonicalMarkerBodies(sql);
    const guard = sql.slice(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'), sql.indexOf('-- ── 1.'));
    const digest = (fn: string) => createHash('md5').update(bodies.get(fn)!, 'utf8').digest('hex');

    for (const fn of MARKER_FORGERY_SEALS) expect(guard).toContain(digest(fn));
    // and NOT the truncate guard's — its exclusion is a decision, so it is asserted, not assumed
    expect(guard).not.toContain(digest('phase6_4c_iiir_no_truncate'));
    // exactly those two, so a stale digest left behind by a rename cannot masquerade as a pin
    expect([...guard.matchAll(/'([0-9a-f]{32})'/gu)].map((m) => m[1]).sort())
      .toEqual([...MARKER_FORGERY_SEALS].map(digest).sort());
    // the tgtype values it pins are the same ones the runtime verifier pins
    for (const { fn, tgtype } of MARKER_SEAL_TRIGGERS) {
      if (MARKER_FORGERY_SEALS.has(fn)) expect(guard).toContain(`${tgtype}, '${digest(fn)}'`);
    }
  });

  // ── Codex round 11 — one P1, one P2 ──────────────────────────────────────────────────────────

  const conditionalGate = async () => {
    await single.$executeRawUnsafe(
      `DROP TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" ON "OutboxOperatorAction"`);
    // Same name, same function, same body, same owner, same tgtype (7 — a WHEN clause is NOT part
    // of the mask), enabled. The ONLY difference is a predicate that is never true.
    await single.$executeRawUnsafe(
      `CREATE TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" BEFORE INSERT
         ON "OutboxOperatorAction" FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION phase6_4c_iiir_marker_insert_gated()`);
  };

  it('R11-1 — a seal carrying a WHEN predicate is NOT sealed, and the gate it bypasses is real', async () => {
    // The predicate lives in `pg_trigger.tgqual`, which no earlier check read. So this trigger
    // matched the whole inventory — presence, enablement, function, body, owner AND the exact
    // tgtype the round-5 finding pinned — while never firing once.
    try {
      await conditionalGate();

      // the mask really is identical, so tgtype cannot be what catches this
      const [row] = await single.$queryRaw<Array<{ tgtype: number; tgenabled: string; has_when: boolean }>>`
        SELECT t.tgtype::int AS tgtype, t.tgenabled::text AS tgenabled, t.tgqual IS NOT NULL AS has_when
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'OutboxOperatorAction'
           AND t.tgname = 'OutboxOperatorAction_4c_iiir_marker_insert_gated'`;
      expect(row).toMatchObject({ tgtype: 7, tgenabled: 'O', has_when: true });

      // WHAT IT COSTS, demonstrated rather than asserted: the plain INSERT the gate exists to
      // refuse is accepted, so a later start would skip the rebuild on a marker nothing wrote.
      await single.$executeRawUnsafe(
        `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
         VALUES ('r11-when-forged',$1,'attacker','forged through a WHEN(false) gate')`,
        PHASE6_4C_IIIR_MARKER_ACTION);
      expect(await markerCount()).toBe(1);

      const report = await verifyMarkerSeals(single as never);
      expect(report.sealed).toBe(false);
      expect(report.findings).toEqual([expect.objectContaining({
        trigger: 'OutboxOperatorAction_4c_iiir_marker_insert_gated',
        problem: 'conditional',
      })]);

      // …and because the insert gate is forgery-relevant, the repair INVALIDATES what it found
      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.markersInvalidated).toBe(1);
      expect(await markerCount()).toBe(0);
    } finally {
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R11-2 — the migration REFUSES to adopt a marker whose seal carries a WHEN predicate', async () => {
    const sql = readMarkerSealMigrationSql();
    const guard = sql.slice(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'), sql.indexOf('-- ── 1.'));
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();   // baseline: adopted
      await conditionalGate();
      await expect(single.$executeRawUnsafe(guard))
        .rejects.toThrow(/marker_insert_gated: the trigger carries a WHEN predicate/u);
    } finally {
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R11-3 — the seal migration is ONE explicit transaction, so a partial apply is unrepresentable', () => {
    // Prisma DOCUMENTS that it does not wrap a migration in a transaction. Without an explicit
    // one, a process dying between a DROP TRIGGER and its CREATE TRIGGER leaves the marker with its
    // gate gone — a state the adoption test (correctly) refuses, so the retry cannot clear itself.
    const sql = readMarkerSealMigrationSql();
    const begin = sql.search(/^BEGIN;$/mu);
    const commit = sql.search(/^COMMIT;$/mu);
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    // everything that MATTERS is inside it: the diagnostic and all three DROP/CREATE pairs
    expect(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST')).toBeGreaterThan(begin);
    for (const marker of ['\nCREATE OR REPLACE FUNCTION phase6_4c_iiir_', '\nDROP TRIGGER IF EXISTS "', '\nCREATE TRIGGER "']) {
      expect(sql.indexOf(marker)).toBeGreaterThan(begin);
      expect(sql.indexOf(marker)).toBeLessThan(commit);
    }
    expect(sql.lastIndexOf('EXECUTE FUNCTION phase6_4c_iiir_')).toBeLessThan(commit);
    // and nothing follows the commit but whitespace
    expect(sql.slice(commit + 'COMMIT;'.length).trim()).toBe('');
  });

  // ── Codex round 12 — two P1s, one P2 ─────────────────────────────────────────────────────────

  const chainedForger = async () => {
    // Name sorts AFTER the gate, so PostgreSQL runs it second and it sees the NEW the gate approved.
    await single.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION zz_chain_forge() RETURNS trigger LANGUAGE plpgsql AS $chain$
         BEGIN NEW."action" := '${PHASE6_4C_IIIR_MARKER_ACTION}'; RETURN NEW; END $chain$`);
    await single.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "zz_OutboxOperatorAction_chain" ON "OutboxOperatorAction"`);
    await single.$executeRawUnsafe(
      `CREATE TRIGGER "zz_OutboxOperatorAction_chain" BEFORE INSERT ON "OutboxOperatorAction"
         FOR EACH ROW EXECUTE FUNCTION zz_chain_forge()`);
  };
  const dropChainedForger = async () => {
    await single.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "zz_OutboxOperatorAction_chain" ON "OutboxOperatorAction"`);
    await single.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_chain_forge()`);
  };

  it('R12-1 — a CHAINED trigger can forge a marker past an intact gate, and the verifier says so', async () => {
    // PostgreSQL chains same-event BEFORE row triggers in NAME order, each handing its NEW to the
    // next. Every one of our three seals is present, enabled, canonical, unconditioned and
    // correctly masked here — the gate simply approved an ordinary row that a later trigger then
    // rewrote. Enumerating properties of OUR triggers cannot see this; only closing the inventory
    // can, which is why rounds 5/10/11/12 all landed on this surface.
    try {
      await chainedForger();
      expect((await verifyMarkerSeals(single as never)).findings.map((f) => f.fn))
        .not.toContain('phase6_4c_iiir_marker_insert_gated');   // our seals really are intact

      // the forgery is REAL: an ordinary action goes in, a marker comes out
      await single.$executeRawUnsafe(
        `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
         VALUES ('r12-chain','some.ordinary.action','attacker','rewritten by a later trigger')`);
      expect(await markerCount()).toBe(1);

      const report = await verifyMarkerSeals(single as never);
      expect(report.sealed).toBe(false);
      expect(report.findings).toEqual([expect.objectContaining({
        trigger: 'zz_OutboxOperatorAction_chain',
        problem: 'unexpected-writer',
      })]);
      // …and it opens a forgery window, so the repair invalidates what it found
      expect(report.findings.some(opensForgeryWindow)).toBe(true);
    } finally {
      await dropChainedForger();
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R12-2 — the migration REFUSES to adopt a marker while an unexpected writer trigger exists', async () => {
    const sql = readMarkerSealMigrationSql();
    const guard = sql.slice(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'), sql.indexOf('-- ── 1.'));
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);
    try {
      await expect(single.$executeRawUnsafe(guard)).resolves.toBeDefined();   // baseline: adopted
      await chainedForger();
      await expect(single.$executeRawUnsafe(guard))
        .rejects.toThrow(/unexpected trigger "zz_OutboxOperatorAction_chain"/u);
    } finally {
      await dropChainedForger();
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R12-3 — an AFTER trigger is NOT a finding: the inventory closes on what can rewrite a row', async () => {
    // Precision, not mere strictness. An AFTER trigger cannot change the row being written, so
    // rejecting it would be a false positive that makes the seal unusable on a real table.
    try {
      await single.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION zz_after_noop() RETURNS trigger LANGUAGE plpgsql AS $a$
           BEGIN RETURN NULL; END $a$`);
      await single.$executeRawUnsafe(
        `CREATE TRIGGER "zz_OutboxOperatorAction_after" AFTER INSERT ON "OutboxOperatorAction"
           FOR EACH ROW EXECUTE FUNCTION zz_after_noop()`);
      expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);
    } finally {
      await single.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "zz_OutboxOperatorAction_after" ON "OutboxOperatorAction"`);
      await single.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_after_noop()`);
      await restoreMarkerSeals();
    }
  });

  it('R12-4 — advisory-lock acquisition is BOUNDED, so a stalled holder cannot park the rollout', async () => {
    // `pg_advisory_lock` blocks forever and is taken BEFORE the try block, so a holder that is alive
    // but stalled parks every later replica with no deadline and no retryable failure.
    const holder = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    try {
      const [held] = await holder.$queryRaw<Array<{ taken: boolean }>>`
        SELECT pg_try_advisory_lock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint) AS taken`;
      expect(held.taken).toBe(true);                       // the lock is genuinely held elsewhere

      // a bounded wait GIVES UP rather than hanging — measured against a real contended lock
      const started = Date.now();
      expect(await acquireRepairLock(single as never, 600)).toBe(false);
      expect(Date.now() - started).toBeLessThan(20_000);

      // and the step turns that into a retryable refusal that writes NO marker
      const outcome = await runInboxRepairStep(single, ops, { ...env }, undefined, undefined, 600);
      expect(outcome.ok).toBe(false);
      expect(outcome.refusal?.code).toBe('lock-unavailable');
      expect(await markerCount()).toBe(0);

      // released, the very next start proceeds normally
      await holder.$executeRaw`SELECT pg_advisory_unlock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
      const next = await runInboxRepairStep(single, ops, env);
      expect(next.ok).toBe(true);
      expect(next.action).toBe('repaired');
    } finally {
      await holder.$disconnect();
    }
  });

  // ── Codex round 13 — three P1s, one P2 (the fourth is routed, not faked) ─────────────────────

  it('R13-1 — the seal migration LOCKS the marker table before it reads it, and that lock excludes writers', async () => {
    // The adoption test is a plain SELECT and the first write-conflicting statement is the DROP
    // TRIGGER further down. Between them a writer can insert or promote a marker and the file would
    // seal AROUND it. Reading a row and acting on it two statements later is not a check.
    const sql = readMarkerSealMigrationSql();
    const lock = sql.search(/^LOCK TABLE "OutboxOperatorAction" IN SHARE ROW EXCLUSIVE MODE;$/mu);
    expect(lock).toBeGreaterThan(-1);
    expect(sql.search(/^BEGIN;$/mu)).toBeLessThan(lock);                  // inside the transaction…
    expect(lock).toBeLessThan(sql.indexOf('-- ── 0. DIAGNOSTIC-FIRST'));  // …before the marker read
    expect(lock).toBeLessThan(sql.indexOf('\nDROP TRIGGER IF EXISTS "')); // …and before any DDL

    // AND THE MODE REALLY EXCLUDES A WRITER — asserted against PostgreSQL, not from the manual.
    // One session holds SHARE ROW EXCLUSIVE; a second session's INSERT must block on it.
    const writer = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = single.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "OutboxOperatorAction" IN SHARE ROW EXCLUSIVE MODE');
      await held;
    }, { timeout: 30_000 });
    try {
      const insert = writer.$executeRawUnsafe(
        `INSERT INTO "OutboxOperatorAction" ("id","action","operatorIdentity","reason")
         VALUES ('r13-blocked','some.ordinary.action','someone','should block on the table lock')`);
      let settled = false;
      void insert.then(() => { settled = true; }, () => { settled = true; });

      // CONDITION-BASED: wait until PostgreSQL reports that writer genuinely waiting on a lock.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await t.prisma.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*)::bigint AS waiting FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'OutboxOperatorAction' AND NOT l.granted`;
        if (Number(row.waiting) > 0) break;
        if (Date.now() > deadline) throw new Error('the INSERT never blocked on the table lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(settled).toBe(false);                 // still blocked while the lock is held
      release();
      await holder;
      await insert;                                // …and it completes once the lock is released
    } finally {
      release();
      await holder.catch(() => {});
      await writer.$disconnect();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R13-4 — corruption landing AFTER the marker commits fails the deploy closed', async () => {
    // Committing releases the generation locks, and a pre-4c-ii relay waiting on one takes it at
    // that instant. Before this, the step returned success into that window and migrate.sh started
    // the API over a register something was still rewriting.
    //
    // This NARROWS the window rather than closing it — a writer acting after the recheck is still
    // unseen, and no check inside this process can be the last word about a process it cannot fence.
    // Closing it needs the drain itself. What it changes is the outcome in the realistic case:
    // failing the deployment instead of serving corrupt data silently.
    // THE DISCRIMINATOR IS THE MARKER ITSELF. It is written inside the verification transaction, so
    // a SEPARATE connection cannot see it until that transaction commits. Reporting corruption only
    // once it is visible therefore reproduces exactly the window this fix is about — after the
    // commit, after the locks were released — and not the pre-existing in-transaction check, which
    // would otherwise catch the sabotage first and refuse on the older path.
    const sabotage: ProjectionRebuildOperations = Object.create(ops);
    sabotage.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      if (projectId !== f.projectA.id) return real;
      // `corrupt` specifically — that is what a legacy serializer's rewrite produces. R14-2 below
      // covers the OTHER post-commit states: rounds 8 and 9 settled that `lagging`/`blocked` must
      // not fail a deploy on the DIAGNOSIS path, and that rule does not reach across the commit.
      const committed = await markerCount();
      return committed > 0 ? { ...real, state: 'corrupt' as const } : real;
    };

    const outcome = await runInboxRepairStep(single, sabotage, env);
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('concurrent-corruption');
    expect(outcome.refusal?.message).toContain('re-reading immediately afterwards');
  });

  it('R14-2 — a post-commit generation that resolves to CORRUPT fails the deploy closed', async () => {
    // Codex on `b5f7c1f`: the post-commit recheck tested `after.corrupt` alone, so a relay that
    // rewrote a generation AND advanced the stream head landed in `unverified` — `diagnoseIn`
    // returns `lagging` BEFORE it compares a single stored row — and the deployment reported
    // success over it.
    //
    // Codex on `5f0d382` and again on `1eb5f20` narrowed what the fix may be: BENIGN lag lands on
    // that same label (R17-1), and comparing stored rows to CURRENT canonical cannot separate them
    // because an honest lag necessarily mismatches. The separation is made by letting the relay
    // finish and re-asking. This is the corrupt half: once caught up, the answer is `corrupt`.
    //
    // Same discriminator as R13-4 — the marker is written inside the verification transaction, so a
    // separate connection sees it only after that transaction commits.
    let phase: 'pre' | 'lagging' | 'settled' = 'pre';
    const sabotage: ProjectionRebuildOperations = Object.create(ops);
    sabotage.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      if (projectId !== f.projectA.id) return real;
      if (await markerCount() === 0) return real;             // still inside the verification tx
      if (phase === 'settled') return { ...real, state: 'corrupt' as const };
      phase = 'settled';                                      // first post-commit look: lagging…
      return { ...real, state: 'lagging' as const };          // …then the re-ask finds it corrupt
    };

    const outcome = await runInboxRepairStep(single, sabotage, env);
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('concurrent-corruption');
    expect(outcome.refusal?.message).toContain(f.projectA.id);
    // …and the marker DID commit on this path, so the outcome must say so (Codex on `1eb5f20`)
    expect(outcome.markerWritten).toBe(true);
    expect(await markerCount()).toBe(1);
  });

  it('R18-1 — a per-function GUC cannot bless a forged marker while the verifier reports sealed', async () => {
    // Codex on `1eb5f20`, and MEASURED before it was fixed. The insert gate admits a marker only
    // when `current_setting('vitan.phase6_4c_iiir_repair')` is 'on', which the step sets with
    // SET LOCAL inside its own transaction. `ALTER FUNCTION ... SET` attaches that same setting to
    // the FUNCTION, so it is 'on' for EVERY invocation — including a forged INSERT — while prosrc,
    // tgtype, tgqual, the owner and the enablement all stay byte-identical.
    //
    // This is the SIXTH property this verifier has been bypassed on (rounds 5, 10, 11, 12, and
    // this), so the fix closes the function identity rather than adding a sixth check: every
    // pg_proc column that can change what the function does.
    const gate = 'phase6_4c_iiir_marker_insert_gated';
    try {
      expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);      // intact to begin

      await single.$executeRawUnsafe(
        `ALTER FUNCTION ${gate}() SET vitan.phase6_4c_iiir_repair = 'on'`);

      // the body really is untouched — a body-only comparison sees nothing
      const [{ src_md5 }] = await single.$queryRawUnsafe<Array<{ src_md5: string }>>(
        `SELECT md5(prosrc) AS src_md5 FROM pg_proc WHERE proname = $1`, gate);
      const canonical = extractCanonicalMarkerBodies(readMarkerSealMigrationSql()).get(gate)!;
      const [{ want_md5 }] = await single.$queryRawUnsafe<Array<{ want_md5: string }>>(
        `SELECT md5($1::text) AS want_md5`, canonical);
      expect(src_md5).toBe(want_md5);

      // …but the seal is NOT intact, and the verifier now says so
      const broken = await verifyMarkerSeals(single as never);
      expect(broken.sealed).toBe(false);
      const finding = broken.findings.find((x) => x.fn === gate && x.problem === 'config-altered');
      expect(finding).toBeDefined();
      expect(finding!.detail).toContain('proconfig');
      // and it invalidates markers, because it is exactly a forgery window
      expect(broken.findings.some(opensForgeryWindow)).toBe(true);
    } finally {
      await single.$executeRawUnsafe(`ALTER FUNCTION ${gate}() RESET ALL`);
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R17-1 — ordinary post-commit LAG that catches up does NOT fail the deploy', async () => {
    // Codex on `5f0d382`. During a rolling deployment the still-serving old container handles an
    // ordinary request and commits an event; until the relay applies it the generation reads
    // `lagging` while the read path falls back to canonical for the un-applied tail. Nothing is
    // wrong — but an earlier head added every `unverified` entry to `moved`, so the new container
    // failed its deployment on ordinary traffic.
    //
    // Codex on `1eb5f20` then showed the round-17 remedy could not work either: comparing those
    // stored rows to CURRENT canonical necessarily mismatches, because the rows honestly describe
    // the previous checkpoint. So the deployment waits for the relay and re-asks — and a benign lag
    // resolves to `current-match`.
    let seen = 0;
    const laggy: ProjectionRebuildOperations = Object.create(ops);
    laggy.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      if (projectId !== f.projectA.id || await markerCount() === 0) return real;
      seen += 1;
      return seen === 1 ? { ...real, state: 'lagging' as const } : real;   // the re-ask sees the truth
    };

    const outcome = await runInboxRepairStep(single, laggy, env);
    expect(seen).toBeGreaterThan(1);                 // it really did re-ask rather than accept blindly
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('repaired');
    expect(await markerCount()).toBe(1);
  });

  it('R19-1 — a generation that never catches up REFUSES the deployment', async () => {
    // Codex on `e7550f5`, reversing what R17-2 asserted one round earlier. Rounds 8 and 9 settled
    // that absence of evidence must not fail a deployment — true at DIAGNOSIS time, and wrong here,
    // because of what happens NEXT: an old relay rewrites v1 rows, a later non-decision event moves
    // the stream head, and the relay stops before consuming it. The poll times out on `lagging`, the
    // new API starts, and ITS relay consumes that event as a no-op — advancing the checkpoint
    // without touching the rows, so `readServableGeneration` then serves the corrupted generation as
    // current. Reporting is not enough when the next thing that happens hides the damage.
    //
    // The budget is shortened through the env so this does not wait the production 30s.
    const stuck: ProjectionRebuildOperations = Object.create(ops);
    stuck.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      if (projectId !== f.projectA.id || await markerCount() === 0) return real;
      return { ...real, state: 'lagging' as const };            // unverifiable on every look
    };

    const outcome = await runInboxRepairStep(single, stuck, { ...env, PHASE6_4C_IIIR_CATCH_UP_MS: '1000' });
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('concurrent-corruption');
    expect(outcome.refusal?.message).toContain(f.projectA.id);
  }, 60_000);

  it('R19-2 — a REAL corrupting write in the post-commit window makes the SKIP path refuse', async () => {
    // Codex on `37e3c34`, and the criticism was right: the previous version stubbed `diagnoseIn` to
    // fabricate `corrupt` and never wrote anything, so it passed without exercising what the fix is
    // for. Here the corruption is a REAL INSERT from a REAL second connection, and the refusal comes
    // from the real diagnosis reading those real rows.
    //
    // WHAT IS SEQUENCED AND WHAT IS OBSERVED, stated exactly. The step asks the orgs participant
    // three times on this path: its own identity read, the marker-present diagnosis, and then
    // `verifyAfterCommit`'s re-enumeration. Hooking the THIRD gives a deterministic hold point
    // INSIDE the post-commit window (writing at the second instead makes the marker-present
    // diagnosis catch it and refuse as `marked-but-corrupt` — a different, also-correct path) — after the diagnosis committed and released its generation locks, before
    // the verification takes them — which is precisely the window a released-lock writer occupies.
    // The hook chooses only WHEN; the write, the rows and the verdict are all real.
    //
    // NOT CLAIMED: this does not queue the writer on the generation lock itself. A plain INSERT into
    // `DecisionProjection` never contends for that row lock, so there is nothing to queue behind;
    // the lock-ordering property is covered by `R6`, which contrasts the two locks directly.
    await runInboxRepairStep(single, ops, env);                  // establish the marker
    expect(await markerCount()).toBe(1);

    const gen = await single.projectionGeneration.findFirst({
      where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' },
      select: { id: true },
    });
    const relay = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    const staleRowId = `r19-2-relay-${Date.now()}`;
    try {
      let identityCalls = 0;
      const realOrgs = new OrgsParticipant();
      const racing = {
        deploymentProjectIdentity: async (tx: never, anchor: string) => {
          identityCalls += 1;
          if (identityCalls === 3) {
            // the post-commit re-enumeration: a legacy relay has just taken the released lock and
            // rewritten the generation with a v1-shaped row canonical does not have
            await relay.$executeRawUnsafe(
              `INSERT INTO "DecisionProjection" ("id","generationId","projectId","decisionId","status","dto","updatedAt")
               VALUES ($3, $1, $2, $4, 'pending', '{"shape":"v1"}'::jsonb, now())`,
              gen!.id, f.projectA.id, staleRowId, `${staleRowId}-decision`);
          }
          return realOrgs.deploymentProjectIdentity(tx, anchor);
        },
      } as unknown as OrgsParticipant;

      const outcome = await runInboxRepairStep(single, ops, env, () => {}, racing);
      expect(identityCalls).toBe(3);                             // the hold point really was reached

      // the corruption is real and in the database…
      const [{ n }] = await single.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "DecisionProjection" WHERE "id" = $1`, staleRowId);
      expect(Number(n)).toBe(1);
      // …and the deployment REFUSED rather than skipping over it
      expect(outcome.action).toBe('refused');                    // NOT 'skipped-marker-present'
      expect(outcome.ok).toBe(false);
      expect(outcome.refusal?.code).toBe('concurrent-corruption');
      expect(outcome.refusal?.message).toContain('NO rebuild was run');
      expect(outcome.markerPresent).toBe(true);                  // and it says the marker is still there
      expect(outcome.markerWritten).toBe(false);                 // …written by an earlier run, not this one
      expect(await markerCount()).toBe(1);
    } finally {
      await relay.$disconnect();
      await single.$executeRawUnsafe(`DELETE FROM "DecisionProjection" WHERE "id" = $1`, staleRowId);
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  }, 60_000);

  it('R19-3 — a non-finite catch-up budget cannot become an unbounded deadline', () => {
    // Codex on `e7550f5`. `Number('Infinity')`, and `1e309` which overflows to it, would make the
    // polling deadline infinite; a blocked generation then keeps the loop alive forever and
    // `migrate.sh` has no outer timeout, so the deployment HANGS instead of refusing retryably.
    for (const hostile of ['Infinity', '-Infinity', '1e309', 'NaN', 'not-a-number', '0', '-5']) {
      expect(resolveCatchUpBudgetMs(hostile)).toBe(CATCH_UP_BUDGET_DEFAULT_MS);
    }
    expect(resolveCatchUpBudgetMs(undefined)).toBe(CATCH_UP_BUDGET_DEFAULT_MS);
    expect(resolveCatchUpBudgetMs('   ')).toBe(CATCH_UP_BUDGET_DEFAULT_MS);
    expect(resolveCatchUpBudgetMs(String(CATCH_UP_BUDGET_MAX_MS + 1))).toBe(CATCH_UP_BUDGET_DEFAULT_MS);
    // …and a sane value is honoured
    expect(resolveCatchUpBudgetMs('5000')).toBe(5_000);
    expect(Number.isFinite(CATCH_UP_BUDGET_MS)).toBe(true);
  });

  it('R19-4 — migrate.sh keys its recovery on whether a marker EXISTS, not on who wrote it', () => {
    // Codex on `e7550f5`, then again on `37e3c34`. The post-commit refusal happens AFTER the marker
    // commits, so "no marker was written, the next start retries" sends the operator into a loop.
    // The first fix keyed on `markerWritten`, which was still wrong on the marker-PRESENT rebuild
    // path: that refusal writes no marker and preserves the one already there, so the operator was
    // told to redeploy while the next start would find the immutable marker, take
    // `marked-but-corrupt`, and refuse without rebuilding. What decides whether a redeploy can help
    // is whether a marker EXISTS. BOTH invocation sites carry it — the ordinary path and the P3005
    // path — because either can hit it.
    const sh = readFileSync(resolve(API_DIR, 'scripts/migrate.sh'), 'utf8');
    expect([...sh.matchAll(/markerPresent": true/gu)].length).toBe(2);
    expect([...sh.matchAll(/A MARKER IS PRESENT on this database/gu)].length).toBe(2);
    expect([...sh.matchAll(/projection rebuild recovery/gu)].length).toBe(2);
    // and it no longer keys on who WROTE it
    expect(sh).not.toMatch(/markerWritten": true/u);
    // the unconditional claim is gone: it now lives only in the else-branch
    for (const m of sh.matchAll(/No marker is present, so the next start retries/gu)) {
      const before = sh.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
      expect(before).toContain('else');
    }
  });

  it('R17-3 — the deploy log carries every field the evidence lease names', async () => {
    // Codex on `5f0d382`. `docs/STATUS.md` holds 4c-iv closed until runtime evidence names complete
    // project coverage, `ok: true`, `corruptAfter: 0` and `failures: 0`, and states that every one
    // of those is a field this step emits. An earlier head dropped `report` wholesale from the
    // printed JSON to keep the deploy log readable — and those counts live in `report`, so even a
    // perfect production run could not produce the evidence that clears the gate.
    const outcome = await runInboxRepairStep(single, ops, env);
    expect(outcome.ok).toBe(true);

    const printed = JSON.parse(JSON.stringify(summarizeForDeployLog(outcome)));
    // the lease's own named fields, present and readable
    expect(printed.ok).toBe(true);
    expect(printed.report.projects).toBe(outcome.report!.projects);
    expect(printed.report.corruptAfter).toBe(0);
    expect(printed.report.failures).toBe(0);
    expect(printed.report.corruptBefore).toBe(outcome.report!.corruptBefore);
    expect(printed.report.consumers).toEqual([DECISIONS_PROJECTION]);
    // …and the verbose part is a count, not one entry per project
    expect(printed.report.resultCount).toBe(outcome.report!.results.length);
    expect(printed.report.results).toBeUndefined();

    await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
  });

  it('R14-3 — a v1-shaped write is INDISTINGUISHABLE from canonical, so no database fence can reject it', async () => {
    // Codex on `b5f7c1f` offers two remedies for the residual legacy-writer window: enforce the
    // drain, or "a fence must prevent legacy writers through the startup boundary". This probe
    // establishes that the SECOND is unavailable on this schema — not merely hard — so that the
    // unit's position rests on evidence rather than on a preference.
    //
    // A fence would have to be a predicate PostgreSQL can evaluate against a stored row, rejecting
    // what a pre-4c-ii serializer writes while accepting what the current one writes. The 4c-ii
    // keys are the only difference between the two serializers, and `serializeDecision` emits them
    // ONLY when the thread is non-empty:
    //
    //     ...(consultations.length ? { consultations, approvalCycle } : {})
    //
    // — a deliberate §D byte-identity decision, so that a decision with no thread carries exactly
    // the pre-4c key set. The consequence is that for such a decision the two serializers produce
    // THE SAME BYTES, and no predicate over the stored row can separate them.
    const decisionId = `r14-3-${Date.now()}`;
    try {
    // deliberately left UNPUBLISHED: the projection covers every decision of the project, and a
    // published OPEN decision held by the fixture's client role trips the phase-4b holder
    // invariant during fixture teardown. The 4c-ii key set does not depend on publication.
    await t.prisma.decision.create({
      data: {
        id: decisionId, projectId: f.projectA.id, title: 'Threadless', room: 'Kitchen',
        status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        options: { createMany: { data: [
          { label: 'Option A', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
        ] } },
      },
    });
    await runInboxRepairStep(single, ops, env);

    const gen = await t.prisma.projectionGeneration.findFirst({
      where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' },
    });
    const rows = await t.prisma.decisionProjection.findMany({ where: { generationId: gen!.id } });
    expect(rows.length).toBeGreaterThan(0);

    const threadless = rows.filter((r) => {
      const dto = r.dto as Record<string, unknown>;
      return !('consultations' in dto);
    });
    // the fixture's decisions carry no consultation thread, so every row is in the ambiguous class
    expect(threadless.length).toBe(rows.length);

    for (const row of threadless) {
      const dto = row.dto as Record<string, unknown>;
      // What a pre-4c-ii serializer would have written for this same decision: it cannot emit keys
      // it does not know about, and it emits everything else identically (the two share one
      // canonical mapping for every pre-4c field).
      const { consultations: _c, approvalCycle: _a, ...asV1Would } = dto;
      expect(JSON.stringify(asV1Would)).toBe(JSON.stringify(dto));   // byte-identical
    }

    // The fence a reviewer would reach for — "reject a payload lacking the 4c-ii keys" — therefore
    // rejects every legitimate threadless decision too. It is not a fence; it is an outage. The
    // remaining remedy is the operational drain, which is what
    // `phase-6-4c-previous-release-drained` gates and what no code in this unit can establish.

    } finally {
      // a published decision held by the fixture's client role blocks the fixture teardown
      // (phase-4b), so it goes even when an assertion above fails — by PREFIX, so an aborted
      // earlier run cannot strand one and break every later suite on this database.
      await single.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "decisionId" LIKE 'r14-3-%'`);
      await single.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" LIKE 'r14-3-%'`);
    }
  });

  it('R15-1 — `seals repair` takes the table lock BEFORE it assesses the seals', async () => {
    // Codex on `9e187be`. `verifyMarkerSeals` is a catalog READ and takes no lock on the table; the
    // first statement that does is the `DROP TRIGGER` several statements later. In between another
    // session can drop the insert gate, INSERT a forged marker and commit — and the repair then
    // reinstalls the canonical seals AROUND that row while its stale assessment says there was
    // nothing to invalidate, making the forgery permanent, sealed evidence.
    //
    // DISCRIMINATING, not merely "does it block". Without the lock the repair still blocks
    // eventually — at `DROP TRIGGER` — so waiting proves nothing on its own. What distinguishes the
    // two versions is WHERE it waits, and therefore whether the assessment already happened:
    // holding a conflicting lock and reading the repair backend's CURRENT statement out of
    // `pg_stat_activity` shows `LOCK TABLE` with the fix and `DROP TRIGGER` without it.
    const holder = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    const worker = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    let release: () => void = () => {};
    let holding: Promise<unknown> = Promise.resolve();
    let repairing: Promise<unknown> = Promise.resolve();
    try {
      const [{ pid: workerPid }] = await worker.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid`;

      // session A holds a lock that conflicts with the repair's own SHARE ROW EXCLUSIVE
      const held = new Promise<void>((resolve) => { release = resolve; });
      holding = holder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE "OutboxOperatorAction" IN SHARE ROW EXCLUSIVE MODE`);
        await held;
      }, { timeout: 120_000, maxWait: 30_000 }).catch(() => undefined);

      // …and is CONFIRMED to hold it before B starts. Without this barrier the repair can run to
      // completion before the holder's lock lands, and the probe observes nothing at all.
      for (let i = 0; i < 400; i += 1) {
        const [got] = await single.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_locks
           WHERE relation = '"OutboxOperatorAction"'::regclass
             AND mode = 'ShareRowExclusiveLock' AND granted`;
        if (Number(got.n) > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // session B runs the repair and must park on its very first table statement
      repairing = repairMarkerSeals(worker as never).catch(() => undefined);

      // condition-based, never a sleep: wait until B is genuinely WAITING on a lock
      let seen = '';
      for (let i = 0; i < 400 && !seen; i += 1) {
        const [row] = await single.$queryRaw<Array<{ query: string }>>`
          SELECT query FROM pg_stat_activity
           WHERE pid = ${workerPid} AND wait_event_type = 'Lock'`;
        if (row?.query) seen = row.query;
        else await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen).not.toBe('');                          // it really is blocked, not just slow
      expect(seen).toMatch(/LOCK TABLE/iu);               // …on the lock, BEFORE assessing
      expect(seen).not.toMatch(/DROP TRIGGER/iu);         // …not after already reading the catalog
    } finally {
      // the holder goes FIRST and unconditionally: everything below needs the table.
      release();
      await holding;
      await repairing;
      await worker.$disconnect();
      await holder.$disconnect();
      await restoreMarkerSeals();
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
    expect((await verifyMarkerSeals(single as never)).sealed).toBe(true);
  }, 120_000);

  it('R15-2 — a seal function RECREATED by the repair is owned by the table owner, not the connected role', async () => {
    // Codex on `9e187be`. `realignFunctionOwners` ran BEFORE the `CREATE OR REPLACE` loop and
    // skipped any function that was ABSENT — so on the documented recovery where a seal function is
    // missing and the operator connects as a superuser or role member rather than as the table
    // owner, the function was created under the CONNECTED role, the post-verify reported
    // `foreign-owner`, and the CLI exited 3 with the deployment still blocked.
    const owner = 'zz_seal_tableowner';
    const [{ o: originalOwner }] = await single.$queryRawUnsafe<Array<{ o: string }>>(
      `SELECT pg_get_userbyid(c.relowner) AS o FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'OutboxOperatorAction'`);
    try {
      await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${owner}`);
      await single.$executeRawUnsafe(`CREATE ROLE ${owner}`);
      // the table belongs to a role the CONNECTED superuser is not
      await single.$executeRawUnsafe(`ALTER TABLE "OutboxOperatorAction" OWNER TO ${owner}`);
      for (const { fn } of MARKER_SEAL_TRIGGERS) {
        await single.$executeRawUnsafe(`ALTER FUNCTION ${fn}() OWNER TO ${owner}`);
      }
      // …and one canonical function is MISSING, the state the recovery exists for
      await single.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "OutboxOperatorAction_4c_iiir_no_truncate" ON "OutboxOperatorAction"`);
      await single.$executeRawUnsafe(`DROP FUNCTION phase6_4c_iiir_no_truncate()`);

      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.findings).toEqual([]);              // RED before the fix: `foreign-owner`

      const rows = await single.$queryRawUnsafe<Array<{ fn: string; owner: string }>>(
        `SELECT p.proname AS fn, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'phase6_4c_iiir_%' ORDER BY p.proname`);
      expect(rows.length).toBe(MARKER_SEAL_TRIGGERS.length);
      for (const r of rows) expect(r.owner).toBe(owner);  // the RECREATED one included
    } finally {
      await single.$executeRawUnsafe(`ALTER TABLE "OutboxOperatorAction" OWNER TO ${originalOwner}`);
      await restoreMarkerSeals();
      for (const { fn } of MARKER_SEAL_TRIGGERS) {
        await single.$executeRawUnsafe(`ALTER FUNCTION ${fn}() OWNER TO ${originalOwner}`).catch(() => 0);
      }
      await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${owner}`);
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R16-1 — a project that APPEARS after the in-transaction check is still caught post-commit', async () => {
    // Codex on `84d819d`. The post-commit recheck was handed the `projectIds` SNAPSHOT read at the
    // top of the step, so it re-diagnosed only the set that existed then. A previous-release process
    // can CREATE a project after the in-transaction set check and populate its `decisions.inbox`
    // generation with the legacy serializer before this runs — and that project was invisible: the
    // marker stayed committed, the deployment returned success, and the API served the corrupt
    // generation until some later deploy happened to notice.
    //
    // The interleaving is driven through the ORGS participant, which is the step's only source of
    // "which projects are there". It reports projectA alone until the marker has COMMITTED — the
    // same visibility discriminator R13-4 and R14-2 use, so the appearance lands strictly after the
    // in-transaction check — and both projects afterwards, which is exactly a project created in
    // the window. projectB's generation reports corrupt, as a legacy rewrite would.
    // The pre-commit set is left EXACTLY as it really is, so every count and report check the step
    // makes before the marker still describes the true database — narrowing it there would refuse
    // early on the minimum-projects gate and never reach the question under test.
    const latecomer = 'r16-1-appeared-after-the-check';
    const appearing = {
      deploymentProjectIdentity: async (tx: never, anchor: string) => {
        const real = await new OrgsParticipant().deploymentProjectIdentity(tx, anchor);
        const committed = await markerCount();
        return committed > 0
          ? { ...real, projectIds: [...real.projectIds, latecomer] }
          : real;
      },
    } as unknown as OrgsParticipant;

    const legacyRewrite: ProjectionRebuildOperations = Object.create(ops);
    legacyRewrite.diagnoseIn = async (tx: never, consumer: string, projectId: string) =>
      (projectId === latecomer
        ? { state: 'corrupt' as const }
        : ops.diagnoseIn(tx, consumer, projectId));

    const outcome = await runInboxRepairStep(single, legacyRewrite, env, () => {}, appearing);
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe('refused');
    expect(outcome.refusal?.code).toBe('concurrent-corruption');
    expect(outcome.refusal?.message).toContain(latecomer);       // the project that APPEARED
  });

  it('R13-2 — a repair under an EXISTING marker reports markerWritten:false', async () => {
    // `markerWritten` says what THIS deployment did. On the marker-present repair path the insert is
    // deliberately skipped — one marker is enough — so reporting true claims a write that never
    // happened, in the CLI output an operator reads.
    await runInboxRepairStep(single, ops, env);
    expect(await markerCount()).toBe(1);

    let rebuilds = 0;
    const laggy: ProjectionRebuildOperations = Object.create(ops);
    laggy.diagnoseIn = async (tx: never, consumer: string, projectId: string) => {
      const real = await ops.diagnoseIn(tx, consumer, projectId);
      return projectId === f.projectA.id && rebuilds === 0 ? { ...real, state: 'lagging' as const } : real;
    };
    laggy.run = async (params: Parameters<ProjectionRebuildOperations['run']>[0]) => {
      rebuilds += 1;
      return ops.run(params);
    };

    const outcome = await runInboxRepairStep(single, laggy, env);
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('repaired');
    expect(rebuilds).toBe(1);                     // it really did repair…
    expect(outcome.markerWritten).toBe(false);    // …without writing a marker
    expect(await markerCount()).toBe(1);          // the pre-existing one, unchanged

    // and the ordinary first repair still reports the write it genuinely made
    await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    const fresh = await runInboxRepairStep(single, ops, env);
    expect(fresh.markerWritten).toBe(true);
  });

  it('R13-3 — `seals repair` RE-OWNS a foreign-owned seal function, which CREATE OR REPLACE cannot', async () => {
    // `foreign-owner` is a supported finding, and PostgreSQL PRESERVES a function's owner across
    // CREATE OR REPLACE — so without an explicit ALTER the documented recovery could never repair
    // the one state it exists for, and the post-verify would keep failing forever.
    const role = 'zz_seal_foreign_owner';
    try {
      await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
      await single.$executeRawUnsafe(`CREATE ROLE ${role}`);
      await single.$executeRawUnsafe(`ALTER FUNCTION phase6_4c_iiir_marker_sealed() OWNER TO ${role}`);

      const broken = await verifyMarkerSeals(single as never);
      expect(broken.findings.map((x) => x.problem)).toContain('foreign-owner');

      const repaired = await repairMarkerSeals(single as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.findings).toEqual([]);
    } finally {
      await restoreMarkerSeals();
      await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
    }
  });

  it('R14-1 — `seals repair` REFUSES BEFORE ANY DDL when the connection cannot own the seal functions', async () => {
    // Codex on `b5f7c1f`. R13-3 above proves the re-own works — but it connects as the SUPERUSER,
    // for whom every ownership check passes vacuously. The state the recovery actually exists for
    // is a restore that left a seal function owned by another role, repaired over the ORDINARY
    // application connection.
    //
    // MEASURED against this database, not reasoned: a non-superuser that owns the TABLE but not the
    // FUNCTION cannot run EITHER statement — `CREATE OR REPLACE FUNCTION` and
    // `ALTER FUNCTION … OWNER TO` both fail with `must be owner of function`. So ordering the
    // transfer first — the obvious reading of the finding — would NOT have fixed it: the transfer
    // needs the very right it was supposed to confer. The repair must refuse up front instead.
    const app = 'zz_seal_app';
    const intruder = 'zz_seal_intruder';
    const [{ o: tableOwner }] = await single.$queryRawUnsafe<Array<{ o: string }>>(
      `SELECT pg_get_userbyid(c.relowner) AS o FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'OutboxOperatorAction'`);
    let asApp: PrismaClient | undefined;
    try {
      // a leftover from an aborted earlier run still holds the schema grant, so revoke then drop
      await single.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${app}`).catch(() => 0);
      for (const r of [app, intruder]) await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${r}`);
      await single.$executeRawUnsafe(`CREATE ROLE ${app} LOGIN PASSWORD 'probe'`);
      await single.$executeRawUnsafe(`CREATE ROLE ${intruder}`);
      await single.$executeRawUnsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${app}`);
      // production shape: the application role owns its own table AND its own seal functions…
      await single.$executeRawUnsafe(`ALTER TABLE "OutboxOperatorAction" OWNER TO ${app}`);
      for (const { fn } of MARKER_SEAL_TRIGGERS) {
        await single.$executeRawUnsafe(`ALTER FUNCTION ${fn}() OWNER TO ${app}`);
      }
      // …and a restore has left exactly ONE of them owned by another role
      await single.$executeRawUnsafe(`ALTER FUNCTION phase6_4c_iiir_marker_sealed() OWNER TO ${intruder}`);

      const url = new URL(process.env.DATABASE_URL!);
      url.username = app;
      url.password = 'probe';
      asApp = new PrismaClient({ datasourceUrl: singleConnectionUrl(url.toString()) });
      const [{ rolsuper }] = await asApp.$queryRaw<Array<{ rolsuper: boolean }>>`
        SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
      expect(rolsuper).toBe(false);                       // the whole point of this probe

      // the finding is visible to this connection…
      expect((await verifyMarkerSeals(asApp as never)).findings.map((x) => x.problem))
        .toContain('foreign-owner');

      // …and the repair refuses it, naming the remedy, WITHOUT attempting a statement
      await expect(repairMarkerSeals(asApp as never)).rejects.toThrow(SealRepairPrivilegeError);
      await expect(repairMarkerSeals(asApp as never)).rejects.toThrow(/must be owned|cannot replace or re-own/u);

      // NOTHING was attempted: the function is still the intruder's, and the seals still stand.
      const [{ owner }] = await single.$queryRawUnsafe<Array<{ owner: string }>>(
        `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
          WHERE proname = 'phase6_4c_iiir_marker_sealed'`);
      expect(owner).toBe(intruder);
      const stillThere = await single.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = '"OutboxOperatorAction"'::regclass AND NOT tgisinternal`);
      expect(Number(stillThere[0].n)).toBe(3);

      // GRANTING the membership is exactly what the refusal asks for, and it is sufficient.
      await single.$executeRawUnsafe(`GRANT ${intruder} TO ${app}`);
      const repaired = await repairMarkerSeals(asApp as never);
      expect(repaired.sealed).toBe(true);
      expect(repaired.findings).toEqual([]);
      const [{ owner: after }] = await single.$queryRawUnsafe<Array<{ owner: string }>>(
        `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
          WHERE proname = 'phase6_4c_iiir_marker_sealed'`);
      expect(after).toBe(app);                            // the TABLE's owner, which is what the verifier compares against
    } finally {
      await asApp?.$disconnect();
      await single.$executeRawUnsafe(`ALTER TABLE "OutboxOperatorAction" OWNER TO ${tableOwner}`);
      for (const { fn } of MARKER_SEAL_TRIGGERS) {
        await single.$executeRawUnsafe(`ALTER FUNCTION ${fn}() OWNER TO ${tableOwner}`);
      }
      await restoreMarkerSeals();
      await single.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${app}`);
      await single.$executeRawUnsafe(`REVOKE ${intruder} FROM ${app}`);
      for (const r of [app, intruder]) await single.$executeRawUnsafe(`DROP ROLE IF EXISTS ${r}`);
      await sanctionedReset(t.prisma, ['OutboxOperatorAction']);
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
