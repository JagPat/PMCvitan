import { PrismaClient, type Prisma } from '@prisma/client';
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
 * The deploy-configured `system_identifier` of the PostgreSQL cluster this deployment serves.
 *
 * THE ANCHOR IDENTIFIES THE DATASET; THIS IDENTIFIES THE DATABASE (Codex round 3 on `00e655f`).
 * A project id and a project count travel WITH the data: a clone or a `pg_dump`/`pg_restore` of
 * production contains the same anchor project and at least the same number of projects, so a
 * deployment misconfigured to point at that copy satisfied both checks and started the API against
 * the wrong database — exactly the realistic misconfiguration the guarantee claimed to catch.
 *
 * `system_identifier` is generated by `initdb`, lives in the control file rather than in any table,
 * and `pg_dump` does not carry it. A logical restore into another cluster therefore has a DIFFERENT
 * one, and this check refuses it while the anchor check cannot.
 *
 * Obtain it once per deployment: `SELECT system_identifier FROM pg_control_system();`
 */
export const SYSTEM_IDENTITY_ENV = 'PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER';
/**
 * The deploy-configured OID of the DATABASE this deployment serves.
 *
 * THE CLUSTER IS NOT THE DATABASE (Codex F2 on `bee2ed9`). `system_identifier` above is shared by
 * every database in one PostgreSQL cluster, so `pg_restore`-ing production into a SECOND database
 * beside it — the most ordinary restore there is — produces a copy that carries the same anchor
 * project, the same project count AND the same cluster identifier. The previous head selected
 * `current_database()` alongside the identifier and then never compared it, so that copy passed
 * every check. The claim was cluster-scoped while the guarantee was database-scoped.
 *
 * The OID rather than the name, deliberately. A name is re-usable: restore into `pmcvitan_copy`,
 * rename it to `pmcvitan`, and a name check cannot tell the difference. `pg_database.oid` is
 * assigned by `CREATE DATABASE` and is not carried by a dump, so the restored copy has a different
 * one however it is subsequently named.
 *
 * The honest limit is UNCHANGED and still stated: a BLOCK-LEVEL copy of the whole cluster (a
 * snapshot restore, a filesystem clone, a physical replica) reproduces the control file and the
 * catalog alike, so it carries both this OID and that identifier. Nothing readable from inside the
 * database can separate it. What the pair closes is the copy that ordinary logical tooling makes,
 * into another cluster OR into a sibling database.
 *
 * Obtain it once per deployment, against the database this deployment serves:
 *   `SELECT oid FROM pg_database WHERE datname = current_database();`
 * It changes whenever the database is RECREATED (dump/restore, a `pg_upgrade` into a fresh
 * cluster), which is precisely when a human should be re-confirming which database this is.
 */
export const DATABASE_IDENTITY_ENV = 'PHASE6_4C_IIIR_EXPECTED_DATABASE_OID';

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
  /** The cluster `system_identifier` this deployment is configured to serve. */
  expectedSystemIdentifier: string;
  /** The `pg_database.oid` of the database within that cluster this deployment is configured to serve. */
  expectedDatabaseOid: string;
}

export type RefusalCode =
  | 'identity-unconfigured'
  | 'minimum-invalid'
  | 'system-identity-invalid'
  | 'system-identity-unreadable'
  | 'system-identity-mismatch'
  | 'database-identity-invalid'
  | 'database-identity-mismatch'
  | 'anchor-absent'
  | 'below-minimum'
  | 'rebuild-not-verified'
  | 'concurrent-corruption'
  | 'marked-but-corrupt';

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
 * Read the four identity variables.
 *
 * `applicable` says whether this database has ever served the `decisions.inbox` register, and it
 * decides ONE thing only: whether an ALL-UNSET tuple is the fresh-install exemption or a refusal.
 * A partially set tuple is a declaration and is always held to in full, and any variable that is
 * SET is validated regardless of applicability.
 */
export function readIdentityConfig(
  env: Record<string, string | undefined>,
  applicable: boolean,
): { ok: true; config: IdentityConfig | null } | { ok: false; refusal: Refusal } {
  const anchor = (env[ANCHOR_ENV] ?? '').trim();
  const minimumRaw = (env[MINIMUM_ENV] ?? '').trim();
  const systemIdentifier = (env[SYSTEM_IDENTITY_ENV] ?? '').trim();
  const databaseOid = (env[DATABASE_IDENTITY_ENV] ?? '').trim();

  const present = [anchor, minimumRaw, systemIdentifier, databaseOid].filter(Boolean).length;
  if (present < 4) {
    // NOTHING SET is the fresh-install exemption. SOMETHING SET IS A DECLARATION (Codex F1 on
    // `bee2ed9`). The exemption exists for a database that has never served this register and for
    // the harnesses that drive the real `migrate.sh` over synthetic databases -- neither of which
    // configures ANY of these. A deployment that sets some of them has declared which database it
    // serves; dropping that declaration because the connected database happens to look
    // not-applicable is exactly backwards, because "looks not-applicable" is what a WRONG database
    // looks like. Concretely: a production deploy that keeps its anchor and minimum but loses the
    // cluster identifier, repointed by a bad `DATABASE_URL` at a fresh empty database, used to
    // report `not-applicable` and start the API against it.
    //
    // So a PARTIAL tuple refuses regardless of applicability, and only the all-unset tuple is
    // exempt -- and even then only when this database has nothing to repair.
    if (present === 0 && !applicable) return { ok: true, config: null };
    const missing = [
      !anchor ? ANCHOR_ENV : null,
      !minimumRaw ? MINIMUM_ENV : null,
      !systemIdentifier ? SYSTEM_IDENTITY_ENV : null,
      !databaseOid ? DATABASE_IDENTITY_ENV : null,
    ].filter(Boolean);
    const because = present > 0
      ? `${present} of the 4 identity variables are set, so this deployment has declared which `
        + 'database it serves; the declaration is then honoured in full, whatever the connected '
        + 'database looks like. A partial declaration is never treated as no declaration.'
      : 'this database has served the decisions.inbox register, so all 4 are required.';
    return {
      ok: false,
      refusal: {
        code: 'identity-unconfigured',
        message:
          `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} unset: ${because} They exist `
          + 'so the repair can never report success against an empty or wrong database. Set them '
          + 'per docs/RUNBOOK.md §P64CIIIR and redeploy.',
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
  // `system_identifier` is a uint64 rendered as digits. Strict, for the same reason the minimum is:
  // a value this cannot parse is a misconfiguration to NAME, never one to coerce.
  if (!/^\d+$/u.test(systemIdentifier)) {
    return {
      ok: false,
      refusal: {
        code: 'system-identity-invalid',
        message:
          `${SYSTEM_IDENTITY_ENV}='${systemIdentifier}' is not a PostgreSQL system identifier; it `
          + 'is a bare integer. Read it from the cluster this deployment serves with '
          + '`SELECT system_identifier FROM pg_control_system();`',
      },
    };
  }
  // The database OID is a uint32 rendered as digits, and strict for the same reason.
  if (!/^\d+$/u.test(databaseOid)) {
    return {
      ok: false,
      refusal: {
        code: 'database-identity-invalid',
        message:
          `${DATABASE_IDENTITY_ENV}='${databaseOid}' is not a pg_database OID; it is a bare `
          + 'integer. Read it from the database this deployment serves with '
          + '`SELECT oid FROM pg_database WHERE datname = current_database();`',
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
  return {
    ok: true,
    config: {
      anchorProjectId: anchor,
      expectedMinProjects,
      expectedSystemIdentifier: systemIdentifier,
      expectedDatabaseOid: databaseOid,
    },
  };
}

/** The minimum a client needs to answer the identity question — so it can be exercised directly. */
export interface IdentityReadable {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * The connected database's own identity: which CLUSTER, and which DATABASE within it.
 *
 * MEASURED, not assumed: on PostgreSQL 16.13 all four `pg_control_*` functions carry a NULL
 * `proacl` — the default, which is EXECUTE to PUBLIC — and a login role with no superuser attribute
 * and no role memberships reads `system_identifier` successfully; `pg_database` is world-readable in
 * any case. (Codex F3 on `42a1903` reported this as superuser/pg_monitor-only; the catalog says
 * otherwise on this version, and the test suite asserts it against the live server so a future
 * version that DOES restrict it fails there rather than in production.)
 *
 * A DEPLOYMENT may still revoke it, so that failure is CAUGHT and NAMED with the exact one-line
 * remedy instead of surfacing as an opaque crash on the deploy path. It is never swallowed: the
 * refusal still exits non-zero and writes no marker, because a permission this check cannot obtain
 * must not become a way to skip the check.
 *
 * Separated from the step so the refusal path can be exercised over a stub that simply throws — the
 * alternative, wrapping the real client, reaches through Prisma's proxy and was MEASURED to break
 * the step's session advisory lock and cascade into unrelated probes.
 */
export async function readDatabaseIdentity(
  prisma: IdentityReadable,
): Promise<
  | { ok: true; systemIdentifier: string; database: string; databaseOid: string }
  | { ok: false; refusal: Refusal }
> {
  try {
    const rows = await prisma.$queryRaw<Array<{ system_identifier: bigint; current_database: string; database_oid: number }>>`
      SELECT c.system_identifier,
             current_database() AS current_database,
             (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()) AS database_oid
        FROM pg_control_system() c`;
    const row = rows[0];
    return {
      ok: true,
      systemIdentifier: String(row.system_identifier),
      database: row.current_database,
      databaseOid: String(row.database_oid),
    };
  } catch (e) {
    return {
      ok: false,
      refusal: {
        code: 'system-identity-unreadable',
        message:
          "this deployment's database role cannot read the cluster identity (pg_control_system()): "
          + `${(e as Error).message.split('\n')[0]}. The identity check is not optional — a role that `
          + 'cannot make the check must not be allowed to skip it. Grant exactly this, as a '
          + 'superuser, and redeploy: GRANT EXECUTE ON FUNCTION pg_control_system() TO <the '
          + 'DATABASE_URL role>; See docs/RUNBOOK.md §P64CIIIR.',
      },
    };
  }
}

/**
 * Lock the active `decisions.inbox` generation of every named project, in the transaction the
 * caller owns — the boundary the RELAY actually obeys.
 *
 * `OutboxRelay.dispatchProjection` applies an event by taking `lockActiveGeneration`, which is
 * `SELECT … FROM "ProjectionGeneration" … status='active' FOR UPDATE`. It never touches
 * `ProjectEventStream`. An earlier head fenced the marker with the STREAM lock instead, on the
 * strength of a comment in `diagnoseIn` describing that lock as covering "every writer of every
 * projection" — true of event ALLOCATION (`emitEvent`), which is a different writer from projection
 * APPLICATION. A relay could therefore still apply its v1 serializer straight through that fence
 * (Codex on `e3d5c8d`). This takes the row the relay takes, so it genuinely blocks.
 *
 * It does NOT use `lockActiveGeneration` itself, because that helper CREATES a generation when none
 * exists. Fabricating one is exactly wrong here: a project with no generation has nothing to serve
 * and nothing to corrupt, and a verification path must not write.
 *
 * Ascending project id — a stable global order, so two of these can never deadlock against each
 * other. Nothing else in the codebase takes both this lock and the stream lock, so the pair cannot
 * cycle either.
 */
export async function lockActiveGenerationsForVerify(
  tx: Prisma.TransactionClient,
  consumer: string,
  projectIds: readonly string[],
): Promise<void> {
  for (const projectId of [...projectIds].sort()) {
    await tx.$queryRaw`
      SELECT "id" FROM "ProjectionGeneration"
       WHERE "consumer" = ${consumer} AND "projectId" = ${projectId} AND "status" = 'active'
       FOR UPDATE`;
  }
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
    const { projectCount, anchorPresent, projectIds } = await orgs.deploymentProjectIdentity(
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
      // THE DATABASE, BEFORE THE DATASET (Codex round 3 on `00e655f`). `system_identifier` is
      // generated by `initdb`, lives in the control file and is not carried by `pg_dump`, so a
      // clone or logical restore of production — which contains the SAME anchor project and at
      // least the same project count — is refused here, where the anchor and minimum below cannot
      // refuse it. Asked first because it is the stronger claim: the dataset checks are about
      // whether the data looks right, this is about whether it is the right database at all.
      //
      // The honest limit, stated rather than implied: a BLOCK-LEVEL copy (a snapshot restore, a
      // filesystem clone, a physical replica) reproduces the control file too, so it carries the
      // same identifier and this check cannot see it. Nothing readable from inside the database
      // can. What it does close is the copy that ordinary tooling makes.
      // MEASURED, not assumed: on PostgreSQL 16.13 all four `pg_control_*` functions carry a NULL
      // `proacl` — the default, which is EXECUTE to PUBLIC — and an unprivileged role with no role
      // memberships reads `system_identifier` successfully. (Codex F3 on `42a1903` reported this as
      // superuser/pg_monitor-only; the catalog says otherwise on this version, and `pg_database` is
      // world-readable in any case.) A DEPLOYMENT may still revoke it, so the failure is CAUGHT and
      // NAMED with the exact one-line remedy instead of surfacing as an opaque crash on the deploy
      // path. It is never swallowed: a refusal still exits non-zero and writes no marker, because a
      // permission this check cannot obtain must not become a way to skip the check.
      const identity = await readDatabaseIdentity(prisma);
      if (!identity.ok) {
        log(`[4c-iii-r] REFUSED (${identity.refusal.code}): ${identity.refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal: identity.refusal };
      }
      const { systemIdentifier: liveSystemIdentifier, database: liveDatabase, databaseOid: liveDatabaseOid } = identity;
      if (String(liveSystemIdentifier) !== config.expectedSystemIdentifier) {
        const refusal: Refusal = {
          code: 'system-identity-mismatch',
          message:
            `${SYSTEM_IDENTITY_ENV}=${config.expectedSystemIdentifier} does not match the connected `
            + `cluster (${String(liveSystemIdentifier)}, database "${liveDatabase}"). This is a `
            + 'different PostgreSQL cluster from the one this deployment is configured for — a '
            + 'clone or a restore carries the same projects, so the anchor alone cannot see this.',
        };
        log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal };
      }
      // AND THE DATABASE WITHIN IT (Codex F2 on `bee2ed9`). The identifier above is shared by every
      // database in the cluster, so on its own it accepts a `pg_restore` of production into a
      // sibling database beside it — the same anchor, the same count, the same cluster. The
      // previous head selected this OID's `current_database()` companion and never compared
      // anything, which is how that copy passed. Compared as the OID rather than the name so a
      // restore-then-rename cannot impersonate the original either.
      if (String(liveDatabaseOid) !== config.expectedDatabaseOid) {
        const refusal: Refusal = {
          code: 'database-identity-mismatch',
          message:
            `${DATABASE_IDENTITY_ENV}=${config.expectedDatabaseOid} does not match the connected `
            + `database "${liveDatabase}" (oid ${String(liveDatabaseOid)}) — the cluster is the one `
            + 'this deployment is configured for, but the DATABASE within it is not. A restore of '
            + 'production into a second database on the same cluster carries the same projects and '
            + 'the same cluster identifier, so only this check can see it.',
        };
        log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal };
      }
      log(`[4c-iii-r] database identity ok: cluster ${config.expectedSystemIdentifier}, database "${liveDatabase}" (oid ${String(liveDatabaseOid)})`);

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
      // THE MARKER RECORDS THAT THE REPAIR RAN. IT IS NOT A PROMISE ABOUT THE FUTURE.
      //
      // It used to end the step outright, so once written, every later deployment skipped without
      // looking — and a register corrupted AFTER it was written could never be noticed again. No
      // lock can prevent that write: a process older than the drain fence applies its v1 serializer
      // through `lockActiveGeneration`, which it takes and this step cannot hold forever. What CAN
      // be done is to stop treating the marker as a reason not to look (Codex on `e3d5c8d`).
      //
      // So a marked database is still diagnosed, under the relay's own generation lock. Clean is
      // the ordinary case and skips as before, at the cost of one read per project. Corrupt REFUSES
      // and names it, rather than repairing silently: a register that regressed after a verified
      // repair means something is still writing it, and repairing under that writer would just
      // produce another marker over the same damage. The operator stops it and redeploys.
      const regressed: string[] = [];
      await prisma.$transaction(async (tx) => {
        await lockActiveGenerationsForVerify(tx, DECISIONS_PROJECTION, projectIds);
        for (const projectId of [...projectIds].sort()) {
          const state = await ops.diagnoseIn(tx as never, DECISIONS_PROJECTION, projectId);
          if (state.state === 'corrupt') regressed.push(`${projectId}/${DECISIONS_PROJECTION}`);
        }
      });
      if (regressed.length > 0) {
        const refusal: Refusal = {
          code: 'marked-but-corrupt',
          message:
            `this database carries the 4c-iii-r marker (written ${marker.at.toISOString()}), but `
            + `${regressed.length} generation(s) are corrupt again: ${regressed.join(', ')}. A `
            + 'verified repair does not regress on its own — something is still writing this '
            + 'register, and a process older than the drain fence is the expected cause. The repair '
            + 'is NOT re-run here, because repairing underneath that writer would only mark the same '
            + 'damage a second time. Stop every pre-4c-ii process, then rebuild with the operator '
            + 'command. See docs/RUNBOOK.md §P64CIIIR.',
        };
        log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal };
      }
      log(`[4c-iii-r] already repaired on ${marker.at.toISOString()}, and every generation still `
        + 'matches canonical — skipping');
      return { ...base, ok: true, action: 'skipped-marker-present', projectCount };
    }

    log(`[4c-iii-r] rebuilding ${DECISIONS_PROJECTION} for all ${projectCount} project(s)`);
    const report = await ops.run({
      operatorIdentity: PHASE6_4C_IIIR_OPERATOR,
      reason: PHASE6_4C_IIIR_REASON,
      consumers: [DECISIONS_PROJECTION],
      // The projects come from their OWNER (Codex F3 on `bee2ed9`). Left to itself `ops.run`
      // enumerates `Project` with its own `prisma.project.findMany` from the platform module —
      // so the previous head routed the identity COUNT through the participant and then, a
      // moment later, re-read the same orgs-owned table directly to decide what to rebuild.
      // These are the ids read under this same advisory lock a few lines above, which also makes
      // the set the verification counts and the set the rebuild walks provably the same one.
      projectIds,
    });
    const refusal = verifyReport(report, projectCount);
    if (refusal) {
      log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
      return { ...base, ok: false, action: 'refused', projectCount, refusal, report };
    }

    // THE MARKER IS COMMITTED UNDER THE WRITERS' OWN LOCK, NOT MERELY AFTER A GOOD REPORT.
    //
    // `report` describes the register as it was DURING `ops.run`. The marker is permanent and every
    // later start skips on it, so writing it in a separate, later transaction leaves a window in
    // which a writer this step's advisory lock does not fence — a pre-4c-ii relay is the case this
    // whole unit exists for — could rewrite the freshly rebuilt generation with its v1 serializer
    // and advance its checkpoint. The generation would still be stamped current and caught up, the
    // read path would serve stale-shaped rows, and the marker would permanently skip the repair
    // that fixes it (Codex F2 on `42a1903`).
    //
    // So the re-check and the marker write are ONE transaction, and it holds the lock those writers
    // DO obey: `ProjectEventStream … FOR UPDATE` per project, which `emitEvent` takes to allocate
    // stream positions and which `diagnoseIn`'s own comment records as covering every writer of
    // every projection. Taken in ascending project id — a stable global order, so two of these can
    // never deadlock against each other.
    //
    // What is refused is CORRUPTION specifically, not activity: a concurrent post-4c-ii relay that
    // legitimately appends leaves the projection `lagging` (correct, behind) or `current-match`,
    // and neither is a reason to withhold the marker. Only a generation whose stored rows no longer
    // match canonical — the exact damage a v1 serializer does — refuses. A refusal writes NO marker
    // and exits non-zero, so the next start (with the old release gone) repairs and marks.
    const concurrent: string[] = [];
    await prisma.$transaction(async (tx) => {
      // The RELAY's own lock first, held to COMMIT, then the diagnosis. Taking the generation row
      // before the stream row also matches `dispatchProjection`'s order (it takes the generation
      // and never the stream), so the pair cannot cycle.
      await lockActiveGenerationsForVerify(tx, DECISIONS_PROJECTION, projectIds);
      for (const projectId of [...projectIds].sort()) {
        const again = await ops.diagnoseIn(tx as never, DECISIONS_PROJECTION, projectId);
        if (again.state === 'corrupt') concurrent.push(`${projectId}/${DECISIONS_PROJECTION}`);
      }
      if (concurrent.length > 0) return;                       // leave the transaction without a marker
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
    if (concurrent.length > 0) {
      const refusal: Refusal = {
        code: 'concurrent-corruption',
        message:
          `the rebuild succeeded, but re-checking under the event-stream lock found ${concurrent.length} `
          + `generation(s) corrupt again before the marker could be committed: ${concurrent.join(', ')}. `
          + 'Something wrote this register between the rebuild and the marker — the pre-4c-ii relay '
          + 'the drain prerequisite exists to eliminate is the expected cause. NO marker was written; '
          + 'stop every process older than the drain fence and redeploy. See docs/RUNBOOK.md §P64CIIIR.',
      };
      log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
      return { ...base, ok: false, action: 'refused', projectCount, refusal, report };
    }
    log(`[4c-iii-r] repaired and marked: ${report.projects} project(s), corruptBefore=${report.corruptBefore}`);
    return { ...base, ok: true, action: 'repaired', projectCount, markerWritten: true, report };
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
  }
}
