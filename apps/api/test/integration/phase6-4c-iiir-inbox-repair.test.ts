import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations, type RebuildRunReport } from '../../src/platform/projections/rebuild-operations';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import {
  ANCHOR_ENV,
  MINIMUM_ENV,
  PHASE6_4C_IIIR_LOCK_KEY,
  PHASE6_4C_IIIR_MARKER_ACTION,
  PHASE6_4C_IIIR_OPERATOR,
  readIdentityConfig,
  runInboxRepairStep,
  SYSTEM_IDENTITY_ENV,
  singleConnectionUrl,
  verifyReport,
} from '../../src/platform/projections/inbox-repair';

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

  const API_DIR = resolve(__dirname, '../..');

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    single = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!) });
    ops = new ProjectionRebuildOperations(single as never, new ProjectionRebuilder(single as never));
    // The cluster this suite is actually connected to — read once, so every configured probe
    // carries a TRUE database identity and the mismatch probe can supply a false one deliberately.
    const [{ system_identifier: live }] = await t.prisma.$queryRaw<Array<{ system_identifier: bigint }>>`
      SELECT system_identifier FROM pg_control_system()`;
    liveSystemIdentifier = String(live);
    env = {
      [ANCHOR_ENV]: f.projectA.id,
      [MINIMUM_ENV]: '1',
      [SYSTEM_IDENTITY_ENV]: liveSystemIdentifier,
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
      // all three are named, so an operator sees the whole configuration in one refusal
      for (const v of [ANCHOR_ENV, MINIMUM_ENV, SYSTEM_IDENTITY_ENV]) {
        expect(both.refusal.message).toContain(v);
      }
    }
    expect(readIdentityConfig({ [MINIMUM_ENV]: '1' }, true)).toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'p' }, true)).toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    // the DATABASE identity is required too — two of three is still unconfigured
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: '1' }, true))
      .toMatchObject({ ok: false, refusal: { code: 'identity-unconfigured' } });
    // blank is unset, not configured
    expect(readIdentityConfig({ [ANCHOR_ENV]: '  ', [MINIMUM_ENV]: '1', [SYSTEM_IDENTITY_ENV]: '1' }, true)).toMatchObject({ ok: false });
    // a database that never served the register has nothing to repair, so an unconfigured deploy is
    // not refused there — which is what keeps every migrate.sh harness free of this configuration
    expect(readIdentityConfig({}, false)).toEqual({ ok: true, config: null });
  });

  it('PROBE 2b — the minimum must be a whole number >= 1, so no configured value can become a skip', () => {
    for (const bad of ['0', 'x', '1.0', '1e9', '2 or 3', '-1']) {
      expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: bad, [SYSTEM_IDENTITY_ENV]: '7' }, true))
        .toMatchObject({ ok: false, refusal: { code: 'minimum-invalid' } });
    }
    // and the database identity is validated with the same strictness
    for (const bad of ['x', '7.0', '7e9', 'not-an-id']) {
      expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: '1', [SYSTEM_IDENTITY_ENV]: bad }, true))
        .toMatchObject({ ok: false, refusal: { code: 'system-identity-invalid' } });
    }
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'p', [MINIMUM_ENV]: '3', [SYSTEM_IDENTITY_ENV]: '7' }, true))
      .toEqual({ ok: true, config: { anchorProjectId: 'p', expectedMinProjects: 3, expectedSystemIdentifier: '7' } });
  });

  it('PROBE 2c — applicability comes from the DATABASE, not the configuration: a projectless database is not-applicable even when configured', async () => {
    // The pure reader's half of PROBE 2d: `applicable` is what the step derives from the served
    // generation count, and it is consulted BEFORE the anchor, so a configured deploy over a
    // never-served database ends `not-applicable` — never a success it could hide behind. A
    // malformed value is still named there rather than ignored.
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'anywhere', [MINIMUM_ENV]: '5', [SYSTEM_IDENTITY_ENV]: '7' }, false))
      .toEqual({ ok: true, config: { anchorProjectId: 'anywhere', expectedMinProjects: 5, expectedSystemIdentifier: '7' } });
    // and a malformed value is still NAMED there rather than ignored
    expect(readIdentityConfig({ [ANCHOR_ENV]: 'anywhere', [MINIMUM_ENV]: '0', [SYSTEM_IDENTITY_ENV]: '7' }, false))
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
