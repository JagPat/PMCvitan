import type { PrismaClient } from '@prisma/client';
import { DECISIONS_PROJECTION } from '../../decisions/decisions.projection';
import type { RebuildRunReport } from './rebuild-operations';

/**
 * Phase 6 unit 4c-iii-r — the post-enablement `decisions.inbox` repair, ONCE, at deploy.
 *
 * WHY THIS EXISTS. 4c-iii enabled `consultation` for every project while the
 * `phase-6-4c-previous-release-drained` prerequisite was unmet (docs/STATUS.md, the 4c-iii landing).
 * A pre-4c-ii worker still serving in that window would have claimed a `decision.*` delivery and
 * upserted the project's whole decision set into the DERIVED `decisions.inbox` register with its v1
 * serializer — erasing the consultation thread and the widened audience from the SERVED view while
 * the canonical rows stayed intact. No claimant audit can establish whether that happened
 * (`OutboxDelivery` carries no claimant version and every success path clears `leaseOwner`), so the
 * remedy is unconditional: rebuild the register from canonical truth under the current serializer.
 *
 * WHY AT DEPLOY, NOT BY HAND. An operator-performed rebuild parks the autonomous loop behind a
 * human-only transition (review of #512 round 2 and #513 round 1). The deploy can run the command,
 * verify its report, and — because every container start reconnects every client and `useApiSync`
 * refreshes on `connect` — the restart that carries the rebuild IS the client refresh. So this step
 * runs from `scripts/migrate.sh` after Prisma and the seal verifiers, BEFORE `node dist/main.js`.
 *
 * THE FOUR PROPERTIES this step holds, each proven by `test/integration/phase6-t4c-iiir.test.ts`
 * and `scripts/phase6-t4c-iiir-production-runner-proof.sh`:
 *
 *   1. IDENTITY FROM OUTSIDE THE CONNECTION (review of #513 round 2, finding 1). The rebuild's own
 *      report and a `count(*)` on the same connection agree trivially over an empty or wrong
 *      database — zero equals zero. So the step requires two deploy-configured variables, BOTH
 *      present or it refuses before touching the database: `PHASE6_4C_IIIR_ANCHOR_PROJECT_ID`, a
 *      production `Project.id` that must exist in the connected database (ids are unguessable; a
 *      wrong database does not contain it), and `PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS`, a floor the
 *      live `count(Project)` must meet. Production sets the floor to 1 or more. Exactly `0` is the
 *      EXPLICIT fresh-install allowance: it admits an empty database (nothing to repair, NO marker
 *      written, the anchor not consulted) and is logged loudly; it is never a production value.
 *      The identity check runs on EVERY start, marker or not, so a later misconfiguration cannot
 *      serve either.
 *   2. EXACTLY ONCE ACROSS CONCURRENT REPLICA STARTS (review of #513 round 2, finding 2). Two
 *      containers that read a marker as absent before either writes it both rebuild, and the
 *      rebuilder allocates `generation = max + 1` with no cross-process serialization, so they
 *      collide on the generation unique key. The step therefore takes a transaction-level advisory
 *      lock on ONE pinned connection FIRST, and holds it across marker-check → rebuild → verify →
 *      marker-write; the marker commits with the lock still held, and the lock is released by that
 *      commit or by the failure rollback — never in between. The loser blocks on the lock, then
 *      re-reads the marker under it: set → skips; absent (the winner failed) → runs itself.
 *   3. FAILS THE DEPLOY CLOSED. `rebuild-operations.ts` catches a failure per (project, consumer)
 *      pair and CONTINUES, reporting `ok = corruptAfter === 0 && failures === 0`; "ran" is not
 *      "succeeded". The step accepts only `ok: true`, `corruptAfter: 0`, `failures: 0`,
 *      `results.length === projects`, and `projects === count(Project)` read under the lock; any
 *      other report is a refusal that names the offending pairs, rolls back, writes no marker, and
 *      exits non-zero so the server does not start. The next start retries.
 *   4. THE MARKER IS AN ATTRIBUTABLE OPERATOR ACTION, NOT A NEW TABLE. `OutboxOperatorAction` already
 *      records every rebuild invocation and every per-pair result; the completion marker is one
 *      more row in that ledger (`action = PHASE6_T4C_IIIR_MARKER_ACTION`), so this unit ships NO
 *      migration and the marker is readable by the same operator tooling as the rebuild it marks.
 */

export const PHASE6_T4C_IIIR_MARKER_ACTION = 'phase6.t4c-iiir.rebuild-completed';
/** The comment tag on the lock statement — how a test finds the WAITING replica in pg_stat_activity. */
export const PHASE6_T4C_IIIR_LOCK_TAG = 'phase6-t4c-iiir-claim';
export const PHASE6_T4C_IIIR_ANCHOR_ENV = 'PHASE6_4C_IIIR_ANCHOR_PROJECT_ID';
export const PHASE6_T4C_IIIR_MIN_ENV = 'PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS';
export const PHASE6_T4C_IIIR_OPERATOR = 'deploy';
export const PHASE6_T4C_IIIR_REASON = 'phase6-4c-iii-r: repair any decisions.inbox generation a pre-4c-ii worker may have written';

/** A rebuild that may take a while on a large register; the loser also waits here for the winner. */
const LOCK_TX_TIMEOUT_MS = 60 * 60 * 1000;
const LOCK_TX_MAX_WAIT_MS = 30 * 1000;

export type Phase6T4cIiirRefusalCode =
  | 'identity-env-missing'
  | 'identity-env-invalid'
  | 'count-below-minimum'
  | 'anchor-absent'
  | 'report-not-ok'
  | 'report-count-mismatch';

export class Phase6T4cIiirRefusal extends Error {
  constructor(
    readonly code: Phase6T4cIiirRefusalCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'Phase6T4cIiirRefusal';
  }
}

export interface Phase6T4cIiirEnv {
  anchorProjectId: string | undefined;
  expectedMinProjects: string | undefined;
}

export function readPhase6T4cIiirEnv(env: NodeJS.ProcessEnv): Phase6T4cIiirEnv {
  return {
    anchorProjectId: env[PHASE6_T4C_IIIR_ANCHOR_ENV],
    expectedMinProjects: env[PHASE6_T4C_IIIR_MIN_ENV],
  };
}

interface ParsedIdentity { anchorProjectId: string; expectedMinProjects: number }

/** Refuses BEFORE any database access: an unconfigured step must never pass vacuously. */
export function parsePhase6T4cIiirIdentity(env: Phase6T4cIiirEnv): ParsedIdentity {
  const anchor = env.anchorProjectId?.trim() ?? '';
  const minRaw = env.expectedMinProjects?.trim() ?? '';
  if (anchor === '' || minRaw === '') {
    throw new Phase6T4cIiirRefusal(
      'identity-env-missing',
      `${PHASE6_T4C_IIIR_ANCHOR_ENV} and ${PHASE6_T4C_IIIR_MIN_ENV} must BOTH be set — the deploy-time rebuild refuses to run unconfigured (it could otherwise pass vacuously over an empty or wrong database).`,
      { anchorSet: anchor !== '', minSet: minRaw !== '' },
    );
  }
  if (!/^\d+$/u.test(minRaw)) {
    throw new Phase6T4cIiirRefusal(
      'identity-env-invalid',
      `${PHASE6_T4C_IIIR_MIN_ENV} must be a non-negative integer (1 or more in production; exactly 0 only as the explicit fresh-install allowance), got ${JSON.stringify(minRaw)}.`,
      { expectedMinProjects: minRaw },
    );
  }
  return { anchorProjectId: anchor, expectedMinProjects: Number(minRaw) };
}

export interface Phase6T4cIiirHooks {
  /** TEST-ONLY seam, invoked INSIDE the pinned transaction immediately after the advisory lock is
   *  acquired and before anything is read — the barrier a concurrent-start probe holds the winner at
   *  while it observes the loser WAITING on the lock in pg_stat_activity. Never set in production. */
  afterLock?: () => Promise<void>;
}

export interface Phase6T4cIiirOptions {
  env: Phase6T4cIiirEnv;
  /** The real rebuild (the CLI wires `ProjectionRebuildOperations.run` for `decisions.inbox`); a test
   *  may inject a rebuild that throws or reports failures to prove the fail-closed path. Runs on the
   *  caller's client — its own transactions — while the pinned transaction holds the lock. */
  rebuild: () => Promise<RebuildRunReport>;
  hooks?: Phase6T4cIiirHooks;
  log?: (line: string) => void;
}

export interface Phase6T4cIiirReportSummary {
  projects: number;
  corruptBefore: number;
  laggingBefore: number;
  corruptAfter: number;
  failures: number;
  results: number;
}

export type Phase6T4cIiirOutcome =
  | { outcome: 'not-applicable'; projects: 0; expectedMinProjects: 0; reason: string }
  | { outcome: 'already-completed'; projects: number; markerId: string; markerAt: string }
  | { outcome: 'completed'; projects: number; markerId: string; report: Phase6T4cIiirReportSummary };

function summarize(report: RebuildRunReport): Phase6T4cIiirReportSummary {
  return {
    projects: report.projects,
    corruptBefore: report.corruptBefore,
    laggingBefore: report.laggingBefore,
    corruptAfter: report.corruptAfter,
    failures: report.failures,
    results: report.results.length,
  };
}

/**
 * Run the step. Resolves with the outcome, or rejects with a {@link Phase6T4cIiirRefusal} (the deploy
 * must then fail) or an unexpected error. Every refusal raised inside the transaction rolls it back,
 * which releases the advisory lock and guarantees no marker was written.
 */
export async function runPhase6T4cIiirStep(prisma: PrismaClient, opts: Phase6T4cIiirOptions): Promise<Phase6T4cIiirOutcome> {
  const log = opts.log ?? (() => undefined);
  const identity = parsePhase6T4cIiirIdentity(opts.env);

  return prisma.$transaction(
    async (tx) => {
      // 1. The claim. Transaction-level, so it is released by exactly the commit that publishes the
      //    marker or by the rollback of a refusal — there is no window in which the lock is gone
      //    and the marker is not yet visible. The comment tag lets a probe find a waiter.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('phase6-t4c-iiir')) /* ${PHASE6_T4C_IIIR_LOCK_TAG} */`);
      await opts.hooks?.afterLock?.();

      // 2. Identity, EVERY start, marker or not.
      const counted = await tx.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*)::bigint AS n FROM "Project"');
      const count = Number(counted[0]?.n ?? 0);
      if (count < identity.expectedMinProjects) {
        throw new Phase6T4cIiirRefusal(
          'count-below-minimum',
          `the connected database holds ${count} project(s) but ${PHASE6_T4C_IIIR_MIN_ENV}=${identity.expectedMinProjects} — this is not the configured production database, or it is missing most of its projects; refusing to rebuild or to start.`,
          { count, expectedMinProjects: identity.expectedMinProjects },
        );
      }
      if (count === 0) {
        // Reachable only with the explicit 0 allowance: nothing to repair, nothing to anchor, and
        // NO marker — a database that later gains projects gets the real run.
        log(`WARNING: ${PHASE6_T4C_IIIR_MIN_ENV}=0 is the fresh-install allowance and the database holds no project; the anchor was not consulted and no marker is written. Never configure 0 in production.`);
        return { outcome: 'not-applicable', projects: 0, expectedMinProjects: 0, reason: 'no projects; explicit fresh-install allowance' };
      }
      if (identity.expectedMinProjects >= 1) {
        const anchor = await tx.project.findUnique({ where: { id: identity.anchorProjectId }, select: { id: true } });
        if (!anchor) {
          throw new Phase6T4cIiirRefusal(
            'anchor-absent',
            `${PHASE6_T4C_IIIR_ANCHOR_ENV}=${identity.anchorProjectId} names no project in the connected database (${count} project(s) present) — this is not the configured production database; refusing to rebuild or to start.`,
            { anchorProjectId: identity.anchorProjectId, count },
          );
        }
      } else {
        log(`WARNING: ${PHASE6_T4C_IIIR_MIN_ENV}=0 is the fresh-install allowance; the anchor is not consulted over this ${count}-project database. Never configure 0 in production.`);
      }

      // 3. Once. Read under the lock, so a loser that waited sees the winner's committed marker.
      const marker = await tx.outboxOperatorAction.findFirst({ where: { action: PHASE6_T4C_IIIR_MARKER_ACTION }, orderBy: { at: 'asc' } });
      if (marker) {
        log(`already completed at ${marker.at.toISOString()} (marker ${marker.id}); identity verified; nothing to do.`);
        return { outcome: 'already-completed', projects: count, markerId: marker.id, markerAt: marker.at.toISOString() };
      }

      // 4. The rebuild, on the caller's client, while this transaction holds the lock.
      log(`rebuilding ${DECISIONS_PROJECTION} for ${count} project(s) (anchor ${identity.anchorProjectId}, floor ${identity.expectedMinProjects})`);
      let report: RebuildRunReport;
      try {
        report = await opts.rebuild();
      } catch (e) {
        throw new Phase6T4cIiirRefusal(
          'report-not-ok',
          `the rebuild threw before producing a report: ${(e as Error).message}; no marker written; the server will not start.`,
          { error: (e as Error).message },
        );
      }

      // 5. Verify — success, not execution, and over EVERY project the database holds.
      const offending = report.results
        .filter((r) => r.error !== undefined || r.after?.state === 'corrupt')
        .map((r) => ({ projectId: r.projectId, consumer: r.consumer, error: r.error ?? null, after: r.after?.state ?? null }));
      if (!report.ok || report.corruptAfter !== 0 || report.failures !== 0) {
        throw new Phase6T4cIiirRefusal(
          'report-not-ok',
          `the rebuild report is not ok (ok=${report.ok}, corruptAfter=${report.corruptAfter}, failures=${report.failures}); no marker written; the server will not start. Offending pairs: ${JSON.stringify(offending)}`,
          { report: summarize(report), offending },
        );
      }
      if (report.projects !== count || report.results.length !== report.projects) {
        throw new Phase6T4cIiirRefusal(
          'report-count-mismatch',
          `the rebuild covered ${report.projects} project(s) with ${report.results.length} result(s) but the database holds ${count} — not every project was rebuilt; no marker written; the server will not start.`,
          { report: summarize(report), count },
        );
      }

      // 6. The marker — inside the lock-holding transaction, after verification, attributable.
      const created = await tx.outboxOperatorAction.create({
        data: {
          action: PHASE6_T4C_IIIR_MARKER_ACTION,
          consumer: DECISIONS_PROJECTION,
          operatorIdentity: PHASE6_T4C_IIIR_OPERATOR,
          reason: JSON.stringify({
            unit: '4c-iii-r',
            anchorProjectId: identity.anchorProjectId,
            expectedMinProjects: identity.expectedMinProjects,
            count,
            report: summarize(report),
          }),
        },
      });
      log(`completed: ${report.projects} project(s) rebuilt (corruptBefore=${report.corruptBefore}, laggingBefore=${report.laggingBefore}); marker ${created.id}`);
      return { outcome: 'completed', projects: count, markerId: created.id, report: summarize(report) };
    },
    { maxWait: LOCK_TX_MAX_WAIT_MS, timeout: LOCK_TX_TIMEOUT_MS },
  );
}
