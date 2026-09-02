import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaService } from '../../src/prisma.service';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { registerConsumer, getConsumer } from '../../src/platform/outbox/registry';
import { makeDecisionsProjectionConsumer, DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations, type RebuildRunReport } from '../../src/platform/projections/rebuild-operations';
import {
  runPhase6T4cIiirStep,
  Phase6T4cIiirRefusal,
  PHASE6_T4C_IIIR_MARKER_ACTION,
  PHASE6_T4C_IIIR_LOCK_TAG,
  PHASE6_T4C_IIIR_OPERATOR,
  PHASE6_T4C_IIIR_REASON,
  type Phase6T4cIiirEnv,
} from '../../src/platform/projections/phase6-t4c-iiir';

/**
 * Phase 6 unit 4c-iii-r — the deploy-time `decisions.inbox` repair, proven live over PostgreSQL.
 *
 * Each probe is the reproduce-first answer to a review finding on the unit's specification
 * (#512 round 2, #513 rounds 1 and 2):
 *   - IDENTITY FROM OUTSIDE THE CONNECTION: unset / invalid variables refuse before any database
 *     access; a wrong anchor or a floor above the live count refuses under the lock and writes no
 *     marker; the explicit 0 allowance admits ONLY an empty database and writes no marker.
 *   - SUCCESS, NOT EXECUTION: a rebuild that throws, or reports a failed or still-corrupt pair,
 *     refuses with the offending pairs named, writes no marker, and the NEXT run succeeds.
 *   - EXACTLY ONCE ACROSS CONCURRENT STARTS: a barrier-controlled two-session race (AGENTS.md — an
 *     explicit barrier, never sleep-only synchronization) in which the loser is OBSERVED waiting on
 *     the advisory lock in pg_stat_activity before the winner is released; the terminal invariant is
 *     asserted directly — one invocation row, one activated generation per project, one marker.
 *   - A CORRUPT GENERATION IS REPAIRED: a stored row set that contradicts canonical diagnoses as
 *     'corrupt' before and is replaced by a clean generation after.
 */
const RESET = ['OutboxOperatorAction', 'ProjectionGeneration', 'DecisionProjection', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'] as const;

describe('phase 6 unit 4c-iii-r — the deploy-time decisions.inbox rebuild (live PostgreSQL)', () => {
  let prisma: PrismaService;
  let f: TwoProjectFixture;

  const realRebuild = (client: PrismaService) => (): Promise<RebuildRunReport> =>
    new ProjectionRebuildOperations(client, new ProjectionRebuilder(client)).run({
      operatorIdentity: PHASE6_T4C_IIIR_OPERATOR,
      reason: PHASE6_T4C_IIIR_REASON,
      consumers: [DECISIONS_PROJECTION],
    });

  const projectCount = async (): Promise<number> => prisma.project.count();
  const markers = async (): Promise<number> => prisma.outboxOperatorAction.count({ where: { action: PHASE6_T4C_IIIR_MARKER_ACTION } });
  const invocations = async (): Promise<number> => prisma.outboxOperatorAction.count({ where: { action: 'projection.rebuild' } });
  const activeGenerations = async (projectId: string): Promise<number> =>
    prisma.projectionGeneration.count({ where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' } });
  const productionEnv = async (): Promise<Phase6T4cIiirEnv> => ({ anchorProjectId: f.projectA.id, expectedMinProjects: String(Math.min(1, await projectCount())) });

  const refusal = async (p: Promise<unknown>): Promise<Phase6T4cIiirRefusal> => {
    try { await p; } catch (e) { if (e instanceof Phase6T4cIiirRefusal) return e; throw e; }
    throw new Error('expected a Phase6T4cIiirRefusal, the step resolved');
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    if (!getConsumer(DECISIONS_PROJECTION)) registerConsumer(makeDecisionsProjectionConsumer());
    f = await createTwoProjectFixture(prisma);
  });
  afterEach(async () => {
    await sanctionedReset(prisma, RESET, { cascade: true });
  });
  afterAll(async () => {
    await sanctionedReset(prisma, RESET, { cascade: true });
    await f?.cleanup();
    await prisma?.$disconnect();
  });

  it('refuses BEFORE any database access when either identity variable is unset', async () => {
    // The shared integration database carries other suites' operator-action rows; what this probe
    // asserts is that THIS step wrote none — a delta, never a global zero.
    const before = await prisma.outboxOperatorAction.count();
    let touched = false;
    const rebuild = async (): Promise<RebuildRunReport> => { touched = true; throw new Error('must not be reached'); };
    for (const env of [
      { anchorProjectId: undefined, expectedMinProjects: '1' },
      { anchorProjectId: f.projectA.id, expectedMinProjects: undefined },
      { anchorProjectId: '', expectedMinProjects: '' },
    ]) {
      const e = await refusal(runPhase6T4cIiirStep(prisma, { env, rebuild }));
      expect(e.code).toBe('identity-env-missing');
    }
    const bad = await refusal(runPhase6T4cIiirStep(prisma, { env: { anchorProjectId: f.projectA.id, expectedMinProjects: 'one' }, rebuild }));
    expect(bad.code).toBe('identity-env-invalid');
    expect(touched).toBe(false);
    expect(await prisma.outboxOperatorAction.count()).toBe(before);
  });

  it('refuses under the lock, with NO marker, when the anchor is absent or the floor exceeds the live count', async () => {
    const count = await projectCount();
    const anchor = await refusal(runPhase6T4cIiirStep(prisma, { env: { anchorProjectId: 'no-such-project', expectedMinProjects: '1' }, rebuild: realRebuild(prisma) }));
    expect(anchor.code).toBe('anchor-absent');
    expect(anchor.details).toMatchObject({ anchorProjectId: 'no-such-project', count });
    const floor = await refusal(runPhase6T4cIiirStep(prisma, { env: { anchorProjectId: f.projectA.id, expectedMinProjects: String(count + 100) }, rebuild: realRebuild(prisma) }));
    expect(floor.code).toBe('count-below-minimum');
    expect(await markers()).toBe(0);
    expect(await invocations()).toBe(0);
  });

  it('completes once — rebuilds every project, writes ONE attributable marker — and a second run is a no-op that still verifies identity', async () => {
    const count = await projectCount();
    const first = await runPhase6T4cIiirStep(prisma, { env: await productionEnv(), rebuild: realRebuild(prisma) });
    expect(first.outcome).toBe('completed');
    if (first.outcome !== 'completed') throw new Error('unreachable');
    expect(first.report.projects).toBe(count);
    expect(first.report.results).toBe(count);
    expect(first.report.corruptAfter).toBe(0);
    expect(first.report.failures).toBe(0);
    expect(await markers()).toBe(1);
    expect(await invocations()).toBe(1);
    expect(await activeGenerations(f.projectA.id)).toBe(1);
    expect(await activeGenerations(f.projectB.id)).toBe(1);
    const marker = await prisma.outboxOperatorAction.findFirstOrThrow({ where: { action: PHASE6_T4C_IIIR_MARKER_ACTION } });
    expect(marker.operatorIdentity).toBe(PHASE6_T4C_IIIR_OPERATOR);
    expect(JSON.parse(marker.reason)).toMatchObject({ unit: '4c-iii-r', anchorProjectId: f.projectA.id, count });

    const second = await runPhase6T4cIiirStep(prisma, { env: await productionEnv(), rebuild: realRebuild(prisma) });
    expect(second.outcome).toBe('already-completed');
    expect(await markers()).toBe(1);
    expect(await invocations()).toBe(1);

    // identity still binds after the marker: a wrong anchor refuses even though the work is done
    const later = await refusal(runPhase6T4cIiirStep(prisma, { env: { anchorProjectId: 'moved-elsewhere', expectedMinProjects: '1' }, rebuild: realRebuild(prisma) }));
    expect(later.code).toBe('anchor-absent');
  });

  it('a rebuild that throws, or reports a failed pair, refuses with the pairs named, writes NO marker, and the next run succeeds', async () => {
    const env = await productionEnv();
    const threw = await refusal(runPhase6T4cIiirStep(prisma, { env, rebuild: async () => { throw new Error('boom'); } }));
    expect(threw.code).toBe('report-not-ok');
    expect(await markers()).toBe(0);

    const partial = async (): Promise<RebuildRunReport> => {
      const report = await realRebuild(prisma)();
      // one pair "failed" — the shape rebuild-operations produces when a pair's rebuild throws and
      // the run continues to the next pair
      const doctored = report.results.map((r, i) => (i === 0 ? { ...r, rebuilt: false, error: 'forced: generation unique violation', after: undefined } : r));
      return { ...report, results: doctored, failures: 1, ok: false };
    };
    const failed = await refusal(runPhase6T4cIiirStep(prisma, { env, rebuild: partial }));
    expect(failed.code).toBe('report-not-ok');
    expect((failed.details as { offending: Array<{ projectId: string; error: string | null }> }).offending).toHaveLength(1);
    expect(await markers()).toBe(0);

    const short = async (): Promise<RebuildRunReport> => {
      const report = await realRebuild(prisma)();
      return { ...report, results: report.results.slice(1) };
    };
    const mismatch = await refusal(runPhase6T4cIiirStep(prisma, { env, rebuild: short }));
    expect(mismatch.code).toBe('report-count-mismatch');
    expect(await markers()).toBe(0);

    const retry = await runPhase6T4cIiirStep(prisma, { env, rebuild: realRebuild(prisma) });
    expect(retry.outcome).toBe('completed');
    expect(await markers()).toBe(1);
  });

  it('repairs a generation whose stored row set contradicts canonical (corruptBefore ≥ 1 → corruptAfter 0)', async () => {
    // an active generation with a stored row for a decision that does not exist: stored ≠ canonical
    await realRebuild(prisma)();
    const gen = await prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' } });
    await prisma.decisionProjection.create({
      data: { generationId: gen.id, projectId: f.projectA.id, decisionId: 'phantom-v1-row', status: 'pending', dto: { id: 'phantom-v1-row' } },
    });
    await sanctionedReset(prisma, ['OutboxOperatorAction'], { cascade: true }); // the seeding rebuild's ledger rows are not the unit's

    const out = await runPhase6T4cIiirStep(prisma, { env: await productionEnv(), rebuild: realRebuild(prisma) });
    expect(out.outcome).toBe('completed');
    if (out.outcome !== 'completed') throw new Error('unreachable');
    expect(out.report.corruptBefore).toBeGreaterThanOrEqual(1);
    expect(out.report.corruptAfter).toBe(0);
    const active = await prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' } });
    expect(active.id).not.toBe(gen.id);
    expect(await prisma.decisionProjection.count({ where: { generationId: active.id, decisionId: 'phantom-v1-row' } })).toBe(0);
  });

  it('CONCURRENT START (barrier-controlled): the loser is observed waiting on the advisory lock; exactly one rebuild, one marker, both succeed', async () => {
    const a = new PrismaService();
    const b = new PrismaService();
    await a.$connect();
    await b.$connect();
    try {
      const env = await productionEnv();
      let releaseA!: () => void;
      const aHeld = new Promise<void>((r) => { releaseA = r; });
      let aLocked!: () => void;
      const aHoldsLock = new Promise<void>((r) => { aLocked = r; });

      // A takes the claim and PARKS on the barrier while holding it.
      const runA = runPhase6T4cIiirStep(a, { env, rebuild: realRebuild(a), hooks: { afterLock: async () => { aLocked(); await aHeld; } } });
      await aHoldsLock;

      // B starts only once A provably holds the lock, and must BLOCK on it.
      const runB = runPhase6T4cIiirStep(b, { env, rebuild: realRebuild(b) });
      const deadline = Date.now() + 8000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM pg_stat_activity
            WHERE query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          `%${PHASE6_T4C_IIIR_LOCK_TAG}%`,
        );
        waiting = Number(rows[0]?.n ?? 0);
        if (waiting > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(1); // the barrier: B is WAITING on the claim, not racing past it
      expect(await invocations()).toBe(0); // and nothing has been rebuilt yet

      releaseA();
      const [ra, rb] = await Promise.all([runA, runB]);
      expect(ra.outcome).toBe('completed');
      expect(rb.outcome).toBe('already-completed');
      expect(await invocations()).toBe(1);
      expect(await markers()).toBe(1);
      expect(await activeGenerations(f.projectA.id)).toBe(1);
      expect(await activeGenerations(f.projectB.id)).toBe(1);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it('the explicit 0 allowance skips the anchor (loudly) over a populated database; a floor of 1 binds it — the EMPTY-database case is the runner proof\'s STATE B', async () => {
    // The shared integration database is never empty (other suites' worlds and the seed), so the
    // "no projects → not-applicable, no marker" path is proven by
    // scripts/phase6-t4c-iiir-production-runner-proof.sh STATE B over a fresh scratch database
    // through the REAL runner. What this database CAN prove is the allowance's other edge: with 0,
    // the anchor is not consulted — a warning is logged and the rebuild still runs and completes —
    // while any floor of 1 or more makes the same wrong anchor a refusal.
    const warnings: string[] = [];
    const lenient = await runPhase6T4cIiirStep(prisma, {
      env: { anchorProjectId: 'not-consulted-under-the-allowance', expectedMinProjects: '0' },
      rebuild: realRebuild(prisma),
      log: (line) => { if (line.startsWith('WARNING')) warnings.push(line); },
    });
    expect(lenient.outcome).toBe('completed');
    expect(warnings.some((w) => w.includes('fresh-install allowance'))).toBe(true);
    expect(await markers()).toBe(1);
    await sanctionedReset(prisma, RESET, { cascade: true });

    const strict = await refusal(runPhase6T4cIiirStep(prisma, {
      env: { anchorProjectId: 'not-consulted-under-the-allowance', expectedMinProjects: '1' },
      rebuild: realRebuild(prisma),
    }));
    expect(strict.code).toBe('anchor-absent');
    expect(await markers()).toBe(0);
  });
});
