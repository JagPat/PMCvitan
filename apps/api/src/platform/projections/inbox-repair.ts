import { PrismaClient } from '@prisma/client';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import { DECISIONS_PROJECTION } from '../../decisions/decisions.projection';
import type { ProjectionRebuildOperations, RebuildRunReport } from './rebuild-operations';

/**
 * Phase 6 unit 4c-iii-r — the DEPLOY-TIME, ONE-SHOT `decisions.inbox` repair.
 *
 * WHY IT EXISTS. 4c-iii's enablement transition ran while the `phase-6-4c-previous-release-drained`
 * prerequisite was unmet, so a pre-4c-ii worker may have written a `decisions.inbox` generation that
 * holds a non-empty SUBSET of the canonical register while presenting as caught-up. The read path
 * serves such a generation as authoritative until the next decision event, and no audit can
 * establish which projects it touched — so the register is rebuilt from canonical for EVERY
 * project. Making that a property of the deployment rather than a step a person performs and
 * reports is the whole point of the unit: the loop clears its own directive.
 *
 * WHERE IT RUNS. `scripts/migrate.sh`, on BOTH success paths, AFTER `prisma migrate deploy` and its
 * seal verifications and BEFORE `node dist/main.js` starts — as the COMPILED artifact
 * `dist/platform/projections/inbox-repair.cli.js`, the same fail-closed pattern the preflights use.
 * Because it runs before the server accepts connections, the CLIENT REFRESH IS STRUCTURAL: the
 * container restart that carries this deploy disconnects every client and `useApiSync` refreshes on
 * socket `connect`, so no client can hold a stale view across the deploy.
 *
 * THE THREE PROPERTIES IT MUST HAVE, and how each is obtained.
 *
 * 1. EXACTLY ONCE ACROSS CONCURRENT REPLICA STARTS — by a lock, not by reading a marker. Two
 *    replacement containers starting together can both read the marker as absent before either
 *    writes it, and `ProjectionRebuilder` allocates `generation = max + 1` per (consumer, project)
 *    inside its own transaction with NO cross-process serialization: the second insert violates the
 *    generation unique key, and across several projects the failures can split so BOTH reports are
 *    non-`ok` and NEITHER start writes the marker. So this step takes a SESSION-LEVEL
 *    `pg_advisory_lock` on its own connection BEFORE reading the marker and holds it across
 *    check-marker -> rebuild -> verify -> write-marker. The loser BLOCKS, then re-reads the marker
 *    under the lock: set -> skip and start; absent (the winner failed) -> run the step itself. A
 *    failed attempt leaves NO marker and exits non-zero, so its deploy fails closed and the next
 *    start retries.
 *
 *    The lock is session-level, so it is only sound on a connection this process does not share.
 *    {@link singleConnectionUrl} pins the client's pool to ONE connection for exactly that reason.
 *
 * 2. "SUCCEEDED", NOT "RAN". `ProjectionRebuildOperations.run` catches a failure per
 *    (project, consumer) pair and CONTINUES, so a run can finish with one project's register still
 *    unrepaired. The criterion is therefore the whole of {@link verifyReport}: exit 0, `ok: true`,
 *    `corruptAfter: 0`, `failures: 0`, `results.length === projects` (one consumer), AND
 *    `projects` equal to the live `Project` count read under the same lock.
 *
 * 3. THE DATABASE IS PROVABLY THE CONFIGURED ONE. Every field above is derived from the result set,
 *    so an EMPTY or WRONG database returns `projects: 0, ok: true` and exits 0 having rebuilt
 *    nothing — the self-count is NECESSARY but NOT SUFFICIENT, because it compares two numbers that
 *    came from the same connection. Identity comes from OUTSIDE the connection instead: two
 *    deploy-configured environment variables, {@link ANCHOR_ENV} (a production `Project.id` that
 *    MUST exist in the connected database — ids are unguessable, so a wrong database does not
 *    contain it) and {@link MINIMUM_ENV} (an integer >= 1 that `count(Project)` must meet). The
 *    identity check runs on EVERY start, marker or not, so a later misconfiguration cannot serve.
 *
 * APPLICABILITY IS THE DEFECT'S OWN PRECONDITION, READ FROM THE DATABASE. The record makes both
 * variables unconditionally required ("an unset one aborts the deploy"). Taken literally that
 * refuses the FIRST deploy of a brand-new environment, whose database has no anchor id to configure
 * — a gate that cannot be cleared — and it would equally refuse every test harness that drives the
 * real `migrate.sh` over a synthetic database. So the step is schema-aware in the same way every
 * other preflight in `migrate.sh` already is, and asks the one question that decides whether the
 * defect can exist here at all: DOES THIS DATABASE HAVE ANY `decisions.inbox` PROJECTION GENERATION?
 *
 *   - NONE — nothing has ever served this register here. `DecisionProjection` rows are
 *     generation-scoped, so with no generation there is nothing the read path would serve and
 *     nothing a pre-4c-ii worker could have left behind. No migration creates a generation on a
 *     fresh database (`20270810000000`'s repair inserts only INSIDE a loop over generations that
 *     already exist), so this is exactly the fresh-install and test-harness shape. NOT APPLICABLE:
 *     no marker is written and no repair is claimed, so a later start over a database that HAS been
 *     in service still runs the repair in full.
 *   - ONE OR MORE — a database in service, which is the only kind that can carry the defect. Both
 *     identity variables are REQUIRED and an unset one ABORTS.
 *
 * Deciding it from the database rather than from a settable value is the point, not an accident. An
 * "allowance" variable — a configured minimum of 0, say — would put the step's own bypass back
 * inside the very configuration the identity check exists to distrust, and a production deploy
 * carrying it would pass while repairing nothing. Nothing this step reads can be set to make it
 * skip a database that has served this register; a minimum below 1 is refused outright.
 *
 * The earlier discriminator here was "does the database hold any project", and it is worse in both
 * directions: it is not the defect's precondition (a project that has never been read has no
 * generation to corrupt), and it forces every harness that drives `migrate.sh` over a populated
 * fixture to carry this step's configuration — a coupling that grows with every future proof.
 */

/** The deploy-configured production `Project.id` that must exist in the connected database. */
export const ANCHOR_ENV = 'PHASE6_4C_IIIR_ANCHOR_PROJECT_ID';
/** The deploy-configured integer >= 1 that `count(Project)` must meet. */
export const MINIMUM_ENV = 'PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS';

/**
 * The session-level advisory lock this step serializes on. An arbitrary but FIXED key, unique in
 * this codebase (no other advisory lock is taken anywhere) and distinct from Prisma Migrate's own
 * (72707369), so a concurrent `migrate deploy` never contends with it.
 */
export const PHASE6_4C_IIIR_LOCK_KEY = 640_303_041;

/** The marker row: one `OutboxOperatorAction` recording that the repair has succeeded here. */
export const PHASE6_4C_IIIR_MARKER_ACTION = 'projection.rebuild.phase6-4c-iii-r';
export const PHASE6_4C_IIIR_OPERATOR = 'deploy';
export const PHASE6_4C_IIIR_REASON =
  'phase6-4c-iii-r: repair any generation a pre-4c-ii worker may have written';

export interface IdentityConfig {
  anchorProjectId: string;
  expectedMinProjects: number;
}

export type RefusalCode =
  | 'identity-unconfigured'
  | 'minimum-invalid'
  | 'anchor-absent'
  | 'below-minimum'
  | 'rebuild-not-verified';

export interface Refusal {
  code: RefusalCode;
  message: string;
}

export interface InboxRepairOutcome {
  ok: boolean;
  step: 'phase6-4c-iii-r';
  /** what the step did: nothing to repair · marker already set · repaired now · refused */
  action: 'not-applicable' | 'skipped-marker-present' | 'repaired' | 'refused';
  projectCount: number;
  anchorProjectId: string | null;
  expectedMinProjects: number | null;
  markerWritten: boolean;
  refusal?: Refusal;
  report?: RebuildRunReport;
}

/**
 * Pin a Prisma connection URL's pool to ONE connection. A session-level `pg_advisory_lock` is held
 * by the SESSION that took it, so every statement between the lock and the unlock must run on that
 * same connection; with `connection_limit=1` the pool has exactly one and the process issues its
 * queries sequentially, so that is guaranteed rather than hoped for.
 */
export function singleConnectionUrl(raw: string): string {
  const separator = raw.includes('?') ? '&' : '?';
  return `${raw}${separator}connection_limit=1`;
}

/**
 * Read the two identity variables. `applicable` says whether the database holds any project, and is
 * what decides between "unconfigured is a refusal" and "there is nothing here to repair" — see the
 * deviation note above. A variable that is SET is validated regardless.
 */
export function readIdentityConfig(
  env: Record<string, string | undefined>,
  applicable: boolean,
): { ok: true; config: IdentityConfig | null } | { ok: false; refusal: Refusal } {
  const anchor = (env[ANCHOR_ENV] ?? '').trim();
  const minimumRaw = (env[MINIMUM_ENV] ?? '').trim();

  if (!anchor || !minimumRaw) {
    if (!applicable) return { ok: true, config: null };
    const missing = [!anchor ? ANCHOR_ENV : null, !minimumRaw ? MINIMUM_ENV : null].filter(Boolean);
    return {
      ok: false,
      refusal: {
        code: 'identity-unconfigured',
        message:
          `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} unset while this database `
          + 'has served the decisions.inbox register. Both are required so the repair can never '
          + 'report success against an empty or wrong database. Set them per docs/RUNBOOK.md '
          + '§P64CIIIR and redeploy.',
      },
    };
  }

  // Deliberately strict: only a bare non-negative integer literal. `parseInt` would accept "2 or 3"
  // and `Number` would accept "1e9" and " 1.0", each of which is a misconfiguration this check
  // exists to name rather than round off.
  if (!/^\d+$/u.test(minimumRaw)) {
    return {
      ok: false,
      refusal: {
        code: 'minimum-invalid',
        message: `${MINIMUM_ENV}='${minimumRaw}' is not an integer; it must be a whole number >= 1.`,
      },
    };
  }
  const expectedMinProjects = Number(minimumRaw);
  if (expectedMinProjects < 1) {
    return {
      ok: false,
      refusal: {
        code: 'minimum-invalid',
        message:
          `${MINIMUM_ENV}='${minimumRaw}' must be >= 1; a minimum of 0 is satisfied by an empty `
          + 'database, which is the vacuity this check exists to refuse.',
      },
    };
  }
  return { ok: true, config: { anchorProjectId: anchor, expectedMinProjects } };
}

/**
 * The full success criterion for one run. Every clause is necessary: `ok` alone tolerates a run that
 * covered no project, and `projects` alone tolerates a run whose pairs all threw.
 */
export function verifyReport(
  report: RebuildRunReport,
  liveProjectCount: number,
): Refusal | null {
  const faults: string[] = [];
  if (!report.ok) faults.push('report.ok is false');
  if (report.corruptAfter !== 0) faults.push(`corruptAfter=${report.corruptAfter}`);
  if (report.failures !== 0) faults.push(`failures=${report.failures}`);
  if (report.results.length !== report.projects) {
    faults.push(`results.length=${report.results.length} != projects=${report.projects}`);
  }
  if (report.projects !== liveProjectCount) {
    faults.push(`projects=${report.projects} != live Project count=${liveProjectCount}`);
  }
  if (faults.length === 0) return null;

  // Name the offending pairs, so an operator reading the deploy log knows which projects to look at
  // rather than only that something was wrong.
  const offenders = report.results
    .filter((r) => r.error !== undefined || r.after?.state === 'corrupt')
    .map((r) => `${r.projectId}/${r.consumer}: ${r.error ?? r.after?.state}`);
  return {
    code: 'rebuild-not-verified',
    message:
      `the decisions.inbox rebuild did not satisfy the success criterion (${faults.join('; ')})`
      + (offenders.length > 0 ? `; offending pairs: ${offenders.join(', ')}` : ''),
  };
}

/**
 * Run the step. `prisma` MUST be a client whose pool holds a single connection
 * ({@link singleConnectionUrl}); the advisory lock is otherwise not held by the session that runs
 * the rebuild. The lock is released in `finally` on every path, including a throw.
 */
export async function runInboxRepairStep(
  prisma: PrismaClient,
  ops: ProjectionRebuildOperations,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = () => {},
  // The ORGS-owned answer to "which database is this". `Project` is orgs-owned, and this module
  // may not read it (Codex round 2, P1) — the participant channel platform already declares in its
  // manifest is how the question is asked. Defaulted so the CLI and the suites construct nothing
  // extra, and injectable so a test can drive it.
  orgs: OrgsParticipant = new OrgsParticipant(),
): Promise<InboxRepairOutcome> {
  const base = {
    step: 'phase6-4c-iii-r' as const,
    markerWritten: false,
    anchorProjectId: null as string | null,
    expectedMinProjects: null as number | null,
  };

  // The lock comes FIRST — before the marker is read, before the count that decides applicability,
  // and it is held across every decision below. A count read outside the lock could be taken while
  // the winner's rebuild is in flight, and the marker read is the very check the race defeats.
  log(`[4c-iii-r] taking session advisory lock ${PHASE6_4C_IIIR_LOCK_KEY}`);
  // `$executeRaw`, not `$queryRaw`: `pg_advisory_lock` returns `void`, which Prisma's row decoder
  // cannot deserialize. The lock is taken by the STATEMENT either way.
  await prisma.$executeRaw`SELECT pg_advisory_lock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
  try {
    // The defect's precondition, asked directly: has this database ever served the register?
    const servedGenerations = await prisma.projectionGeneration.count({
      where: { consumer: DECISIONS_PROJECTION },
    });
    // ONE round trip, through the OWNER, BEFORE any return path — every outcome reports the
    // project count, including the unconfigured refusal. `Project` is orgs-owned and this module
    // may not read it (Codex round 2, P1); the participant channel platform already declares in
    // its manifest is how the question is asked. An unconfigured deploy asks about the
    // empty-string anchor, which no project has, and uses only the count.
    const { projectCount, anchorPresent } = await orgs.deploymentProjectIdentity(
      prisma as never,
      (env[ANCHOR_ENV] ?? '').trim(),
    );
    const identity = readIdentityConfig(env, servedGenerations > 0);
    if (!identity.ok) {
      log(`[4c-iii-r] REFUSED (${identity.refusal.code}): ${identity.refusal.message}`);
      return { ...base, ok: false, action: 'refused', projectCount, refusal: identity.refusal };
    }
    const config = identity.config;
    base.anchorProjectId = config?.anchorProjectId ?? null;
    base.expectedMinProjects = config?.expectedMinProjects ?? null;

    if (config) {
      // THE IDENTITY ASSERTIONS RUN ON EVERY START — marker or not, applicable or not, and BEFORE
      // the not-applicable exit below (Codex F1 on 44b2ad8). An earlier head asked applicability
      // first, so a CONFIGURED production deploy accidentally repointed at an empty or never-served
      // database returned success without ever checking the anchor: `migrate deploy` creates the
      // schema, `servedGenerations` is 0, the step reports not-applicable, and `migrate.sh` starts
      // the API against the wrong database. That contradicted this step's own stated guarantee.
      //
      // Ordering identity first costs nothing that the not-applicable branch exists to protect: a
      // fresh environment and every `migrate.sh` harness are UNCONFIGURED, so `config` is null here
      // and nothing is asserted. Only a deploy that HAS declared which database it serves is held
      // to that declaration — which is exactly who should be.
      if (!anchorPresent) {
        const refusal: Refusal = {
          code: 'anchor-absent',
          message:
            `${ANCHOR_ENV}='${config.anchorProjectId}' names no project in the connected database `
            + `(it holds ${projectCount}). This is not the database this deploy is configured for.`,
        };
        log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal };
      }
      if (projectCount < config.expectedMinProjects) {
        const refusal: Refusal = {
          code: 'below-minimum',
          message:
            `the connected database holds ${projectCount} project(s), below `
            + `${MINIMUM_ENV}=${config.expectedMinProjects}.`,
        };
        log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal };
      }
      log(
        `[4c-iii-r] identity ok: anchor ${config.anchorProjectId} present; `
        + `${projectCount} project(s) >= minimum ${config.expectedMinProjects}`,
      );
    }

    if (servedGenerations === 0) {
      // NOT APPLICABLE, and decided from the DATABASE rather than from configuration — which is what
      // keeps it out of reach of a misconfiguration. With no generation, nothing has ever served
      // this register here: `DecisionProjection` rows are generation-scoped, so there is nothing the
      // read path would serve and nothing a pre-4c-ii worker could have left behind. Not a vacuous
      // success either — NO marker is written and no repair is claimed, so a later start over a
      // database that HAS been in service still runs the repair in full.
      //
      // Reached only AFTER the identity assertions above, so a configured deploy pointed at a
      // database it did not declare has already been refused. A first deploy of a new environment
      // is unconfigured, has no project to anchor to, and passes here — which is the whole reason
      // this branch exists.
      log('[4c-iii-r] not applicable: no decisions.inbox generation exists, so this database has '
        + 'never served the register and carries nothing to repair');
      return { ...base, ok: true, action: 'not-applicable', projectCount };
    }

    const marker = await prisma.outboxOperatorAction.findFirst({
      where: { action: PHASE6_4C_IIIR_MARKER_ACTION },
      select: { id: true, at: true },
    });
    if (marker) {
      log(`[4c-iii-r] already repaired on ${marker.at.toISOString()} — skipping`);
      return { ...base, ok: true, action: 'skipped-marker-present', projectCount };
    }

    log(`[4c-iii-r] rebuilding ${DECISIONS_PROJECTION} for all ${projectCount} project(s)`);
    const report = await ops.run({
      operatorIdentity: PHASE6_4C_IIIR_OPERATOR,
      reason: PHASE6_4C_IIIR_REASON,
      consumers: [DECISIONS_PROJECTION],
    });
    const refusal = verifyReport(report, projectCount);
    if (refusal) {
      log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
      return { ...base, ok: false, action: 'refused', projectCount, refusal, report };
    }

    // The marker is written only after the VERIFIED report, still under the lock, so a marker can
    // never stand for a repair that did not succeed — and inside ONE transaction that first sets
    // the transaction-local flag the DB creation gate requires. `SET LOCAL` disappears at COMMIT,
    // so no later statement on this connection inherits the right to write a marker.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('vitan.phase6_4c_iiir_repair', 'on', true)`;
      await tx.outboxOperatorAction.create({
        data: {
          action: PHASE6_4C_IIIR_MARKER_ACTION,
          consumer: DECISIONS_PROJECTION,
          operatorIdentity: PHASE6_4C_IIIR_OPERATOR,
          reason:
            `${PHASE6_4C_IIIR_REASON} — verified over ${report.projects} project(s); `
            + `anchor ${config?.anchorProjectId ?? 'n/a'}`,
        },
      });
    });
    log(`[4c-iii-r] repaired and marked: ${report.projects} project(s), corruptBefore=${report.corruptBefore}`);
    return { ...base, ok: true, action: 'repaired', projectCount, markerWritten: true, report };
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
  }
}
