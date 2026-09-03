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

/**
 * How long a start waits for that lock before refusing (Codex round 12, P2).
 *
 * `pg_advisory_lock` blocks forever and is taken BEFORE the try block, so a holder that is alive but
 * stalled mid-rebuild parks every later replica with no deadline anywhere: `VERIFY_TX_OPTIONS` bounds
 * only the later interactive transactions and `migrate.sh` supplies no outer timeout. A deploy that
 * hangs is worse than one that fails, because a failure is retried and a hang needs a human to find
 * and kill the holder. The budget is larger than any healthy rebuild of this database, so a
 * legitimate winner still finishes and the loser still SKIPS on the marker exactly as before.
 */
export const PHASE6_4C_IIIR_LOCK_WAIT_MS = 15 * 60 * 1000;

/**
 * Take the session advisory lock, or give up on a deadline. False means the wait expired.
 *
 * BOUNDED BY `lock_timeout` rather than by polling `pg_try_advisory_lock`. Both bound the wait; the
 * difference is what the rest of the system can still observe. A polling loop never BLOCKS, so a
 * contending start stops appearing in `pg_locks` as an ungranted waiter — and that row is exactly
 * what PROBE 8's barrier waits for before releasing two real processes into the race together. The
 * polling version silently made that barrier's condition unsatisfiable; PROBE 8 failed honestly, and
 * this is the version that bounds the wait without trading the observable away.
 *
 * That `lock_timeout` governs `pg_advisory_lock` at all is MEASURED, not assumed — the documentation
 * says "a table, index, row, or other database object", and an advisory lock's membership in "other"
 * deserved checking. Against a held lock with `lock_timeout = 1500`, the wait ends in 1.55s with
 * `canceling statement due to lock timeout`.
 *
 * The timeout is restored afterwards: it is set to bound THIS acquisition, and leaving it would
 * silently bound every `FOR UPDATE` the rebuild takes later.
 */
export async function acquireRepairLock(
  prisma: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] },
  waitMs: number = PHASE6_4C_IIIR_LOCK_WAIT_MS,
): Promise<boolean> {
  await prisma.$executeRawUnsafe(`SET lock_timeout = ${Math.max(1, Math.trunc(waitMs))}`);
  try {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`);
    return true;
  } catch (error) {
    // 55P03 lock_not_available is what `lock_timeout` raises. Anything else is a real fault and
    // must not be reported as "someone else holds the lock".
    const code = (error as { meta?: { code?: string } })?.meta?.code;
    if (code === '55P03' || /lock timeout/iu.test(String((error as Error)?.message ?? ''))) return false;
    throw error;
  } finally {
    await prisma.$executeRawUnsafe('SET lock_timeout = DEFAULT');
  }
}

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
  | 'marked-but-corrupt'
  | 'project-set-changed'
  | 'lock-unavailable';

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
    // STREAM FIRST, THEN GENERATION — the order `ProjectionRebuilder` uses at its activation
    // barrier (it takes `ProjectEventStream … FOR UPDATE`, then updates the generation rows).
    // An earlier head took them the other way round and asserted in a comment that nothing else
    // in the codebase took both, so the pair could not cycle. That was simply wrong: the rebuilder
    // takes both, and an operator rebuild overlapping a deploy could deadlock, aborting one of them
    // on a database where nothing was actually wrong. Matching its order removes the cycle
    // (Codex on `c57b167`).
    //
    // The GENERATION lock is still what fences the relay — `dispatchProjection` takes only that —
    // so taking the stream lock first costs nothing and fences `emitEvent` as well.
    await tx.$queryRaw`
      SELECT "projectId" FROM "ProjectEventStream" WHERE "projectId" = ${projectId} FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "id" FROM "ProjectionGeneration"
       WHERE "consumer" = ${consumer} AND "projectId" = ${projectId} AND "status" = 'active'
       FOR UPDATE`;
  }
}

/**
 * How long the all-project verification transaction may take, and how long it may wait to start.
 *
 * Prisma's interactive `$transaction` defaults to a FIVE SECOND timeout. This transaction takes
 * every project's locks and then loads and compares the whole canonical decision set for each one,
 * so on a production-sized database — or whenever one of those locks is briefly held by a relay —
 * five seconds is not a bound on the work, it is a coin flip. Exceeding it aborts with an expired
 * transaction and `migrate.sh` then refuses a deployment whose data was perfectly valid
 * (Codex on `c57b167`).
 *
 * Sized for a deploy step rather than a request: this runs once per start, before the server
 * accepts connections, and failing it costs a whole deployment. It is still a BOUND — a genuinely
 * stuck lock fails the deploy rather than hanging it forever.
 */
export const VERIFY_TX_OPTIONS = { timeout: 120_000, maxWait: 60_000 } as const;

/**
 * Diagnose every project that exists RIGHT NOW, under the locks, and name the corrupt ones.
 *
 * The set is re-read here rather than taken from the caller (Codex on `e8b6d8c`). This runs on the
 * marker-present path, which is what catches anything the repair-time windows could not — including
 * a project that appeared during an earlier deploy's repair — so diagnosing the ids read at the top
 * of the step would be diagnosing a snapshot, which is the very thing that path exists to correct.
 * `snapshot` exists ONLY so a test can pass a deliberately stale set and show the difference; the
 * production caller never passes it.
 *
 * Two lists, because they mean different things. `corrupt` is a generation whose stored rows were
 * COMPARED and did not match canonical. `unverified` is one `diagnoseIn` returned `lagging` or
 * `blocked` for — states it reports before comparing anything, so they are the absence of evidence
 * rather than evidence of soundness. An earlier head treated `unverified` as a pass on the
 * marker-present path, which let a legacy relay's rewrite ride through: the rewrite plus one
 * undelivered position reads as `lagging`, the start skips, and the current relay then advances the
 * checkpoint past that position as a `noop` without refreshing the rows (Codex on `8eea3ca`).
 */
export async function diagnoseCurrentProjects(
  prisma: PrismaClient,
  ops: Pick<ProjectionRebuildOperations, 'diagnoseIn'>,
  orgs: Pick<OrgsParticipant, 'deploymentProjectIdentity'>,
  anchorProjectId: string,
  snapshot?: readonly string[],
): Promise<{ corrupt: string[]; unverified: string[] }> {
  const corrupt: string[] = [];
  const unverified: string[] = [];
  await prisma.$transaction(async (tx) => {
    const ids = snapshot
      ?? (await orgs.deploymentProjectIdentity(tx as never, anchorProjectId)).projectIds;
    await lockActiveGenerationsForVerify(tx, DECISIONS_PROJECTION, ids);
    for (const projectId of [...ids].sort()) {
      const state = await ops.diagnoseIn(tx as never, DECISIONS_PROJECTION, projectId);
      const named = `${projectId}/${DECISIONS_PROJECTION}`;
      if (state.state === 'corrupt') corrupt.push(named);
      // `lagging` and `blocked` are returned BEFORE a single stored row is compared, so neither is
      // evidence that the register is sound — they are the ABSENCE of evidence, and the caller must
      // not read them as a pass (Codex on `8eea3ca`).
      else if (state.state !== 'current-match' && state.state !== 'none') {
        unverified.push(`${named} (${state.state})`);
      }
    }
  }, VERIFY_TX_OPTIONS);
  return { corrupt, unverified };
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
  // Injectable ONLY so a probe can contend a real lock without waiting the production budget.
  lockWaitMs: number = PHASE6_4C_IIIR_LOCK_WAIT_MS,
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
  if (!(await acquireRepairLock(prisma, lockWaitMs))) {
    // projectCount is 0 on purpose: the count is read UNDER the lock, and this path never held it.
    // Reporting a number read outside the lock would be the very vacuity this step exists to refuse.
    const refusal = {
      code: 'lock-unavailable' as const,
      message:
        `another start has held the 4c-iii-r advisory lock ${PHASE6_4C_IIIR_LOCK_KEY} for longer `
        + `than ${lockWaitMs / 1000}s. A healthy repair finishes well inside that, so the holder is `
        + 'not making progress: find it by joining `pg_locks` (locktype \'advisory\') to '
        + '`pg_stat_activity`. See docs/RUNBOOK.md section P64CIIIR. No marker was written and the '
        + 'deploy fails closed, so the next start retries.',
    };
    log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
    return { ...base, ok: false, action: 'refused', projectCount: 0, refusal };
  }
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
      // THE CURRENT SET, NOT THE SNAPSHOT (Codex on `e8b6d8c`). This path is what catches anything
      // the repair-time windows could not — including a project that appeared during an earlier
      // deploy's repair — so diagnosing the ids read at the top of THIS start is not enough: those
      // are a snapshot too. The set is re-read through its owner inside the transaction, and the
      // locks are taken over what it returns.
      const { corrupt, unverified } = await diagnoseCurrentProjects(
        prisma, ops, orgs, (env[ANCHOR_ENV] ?? '').trim());
      if (corrupt.length > 0) {
        const refusal: Refusal = {
          code: 'marked-but-corrupt',
          message:
            `this database carries the 4c-iii-r marker (written ${marker.at.toISOString()}), but `
            + `${corrupt.length} generation(s) are corrupt again: ${corrupt.join(', ')}. A `
            + 'verified repair does not regress on its own — something is still writing this '
            + 'register, and a process older than the drain fence is the expected cause. The repair '
            + 'is NOT re-run here, because repairing underneath that writer would only mark the same '
            + 'damage a second time. Stop every pre-4c-ii process, then rebuild with the operator '
            + 'command. See docs/RUNBOOK.md §P64CIIIR.',
        };
        log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
        return { ...base, ok: false, action: 'refused', projectCount, refusal };
      }
      if (unverified.length === 0) {
        log(`[4c-iii-r] already repaired on ${marker.at.toISOString()}, and every generation still `
          + 'matches canonical — skipping');
        return { ...base, ok: true, action: 'skipped-marker-present', projectCount };
      }
      // UNVERIFIABLE IS NOT A PASS — AND NOT A REFUSAL EITHER. `lagging`/`blocked` come back before
      // any row is compared, so this start cannot say the register is sound. Skipping on it is the
      // hole (Codex on `8eea3ca`). Refusing on it would be worse than the hole: a lagging projection
      // is ordinary between deploys, and the process that would catch it up is the container this
      // deploy is replacing — on a recreate strategy nothing ever advances it, so the deploy could
      // never succeed.
      //
      // So the step does the one thing that resolves the ambiguity instead of guessing about it: it
      // REPAIRS. The rebuild is recompute-only and idempotent, it makes the generation
      // `current-match` by construction, and the post-rebuild verification below then holds it to
      // the strict criterion. The cost is one extra rebuild on a deploy that finds the register
      // lagging; the alternative is serving rows nothing checked.
      log(`[4c-iii-r] marked, but ${unverified.length} generation(s) could not be verified `
        + `(${unverified.join(', ')}) — these states are reported before any row is compared, so `
        + 'the repair is re-run rather than skipped');
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
    let appeared: string[] = [];
    await prisma.$transaction(async (tx) => {
      // The locks the writers obey, held to COMMIT, then the diagnosis.
      await lockActiveGenerationsForVerify(tx, DECISIONS_PROJECTION, projectIds);

      // THE PROJECT SET IS RE-READ HERE, NOT TRUSTED FROM THE SNAPSHOT (Codex on `c57b167`).
      // `projectIds` was read at the top of the step. A previous-release process can CREATE a
      // project after that — and populate its `decisions.inbox` generation with the legacy
      // serializer — and every downstream check (the rebuild, the report's project count, the locks
      // above) is scoped to the old set. Asked through the owning module, as the first read was.
      //
      // WHAT THIS CLOSES, AND WHAT IT DOES NOT. It closes the window from the snapshot to this
      // re-read, which is where the rebuild itself runs and is by far the longest part of the step.
      // It does NOT close the window from here to COMMIT: an earlier head claimed SERIALIZABLE made
      // that a serialization failure, and that was WRONG — SSI may legitimately order this
      // transaction before an inserting one that does not depend on it, so the phantom simply does
      // not conflict (Codex on `e8b6d8c`). Nor can it be locked away, because a previous-release
      // writer takes no lock this code can name.
      //
      // The residual window is covered instead by the marker-present path below, which re-reads and
      // re-diagnoses the CURRENT set on every start: a project that slipped in here is caught on
      // the next deploy rather than never. That is the same guarantee the corruption check already
      // relies on, and it is why the marker is no longer terminal.
      const now = await orgs.deploymentProjectIdentity(tx as never, (env[ANCHOR_ENV] ?? '').trim());
      appeared = now.projectIds.filter((id) => !projectIds.includes(id));
      const vanished = projectIds.filter((id) => !now.projectIds.includes(id));
      if (appeared.length > 0 || vanished.length > 0) {
        appeared = [...appeared, ...vanished.map((id) => `${id} (gone)`)];
        return;                                                // leave the transaction without a marker
      }

      // CONTENT-VERIFIED, NOT MERELY "NOT CORRUPT" (Codex on `e8b6d8c`). `diagnoseIn` returns
      // `lagging` as soon as the checkpoint trails the stream head — BEFORE it compares any stored
      // row against canonical. So a generation an old relay had just rewritten with v1-shaped rows,
      // with one unrelated position allocated but not yet delivered, reported `lagging` and passed a
      // "not corrupt" test. The current relay could then consume that position as a `noop`,
      // advancing the checkpoint without touching the rows, and the read path would serve the
      // corrupt contents from a generation that now looks caught up.
      //
      // Immediately after `ops.run`, holding every lock, `current-match` is the only state a
      // successful rebuild produces: it seeds the new generation through the stream head, and
      // nothing may advance the head while these locks are held. `none` is the one other honest
      // answer — a project the rebuild found nothing to serve for. Anything else means something
      // moved, and the marker is withheld.
      for (const projectId of [...projectIds].sort()) {
        const again = await ops.diagnoseIn(tx as never, DECISIONS_PROJECTION, projectId);
        if (again.state !== 'current-match' && again.state !== 'none') {
          concurrent.push(`${projectId}/${DECISIONS_PROJECTION} (${again.state})`);
        }
      }
      if (concurrent.length > 0) return;                       // leave the transaction without a marker
      if (marker) return;                                      // re-verified an existing marker; one is enough
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
    }, VERIFY_TX_OPTIONS);
    if (appeared.length > 0) {
      const refusal: Refusal = {
        code: 'project-set-changed',
        message:
          'the project set changed while the repair was running: '
          + `${appeared.join(', ')}. The rebuild, its verification and the locks above are all `
          + 'scoped to the set read at the start, so a project that appeared since has been neither '
          + 'rebuilt nor diagnosed — and a previous-release process is exactly what would create one '
          + 'and populate its register with the legacy serializer. NO marker was written; the next '
          + 'start covers the full set. See docs/RUNBOOK.md §P64CIIIR.',
      };
      log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
      return { ...base, ok: false, action: 'refused', projectCount, refusal, report };
    }
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
    // markerWritten says what THIS deployment DID, not what the database now has (Codex round 13,
    // P2). On the marker-present repair path the insert is deliberately skipped — one marker is
    // enough — so reporting `true` claims a write that never happened, and the CLI output is the
    // record an operator reads.
    // ── THE POST-COMMIT RECHECK (Codex round 13, P1) ────────────────────────────────────────────
    //
    // Committing the transaction above RELEASES the generation locks, and a pre-4c-ii relay that was
    // waiting on one takes it immediately and rewrites the generation with the legacy serializer.
    // Until now the step returned success into exactly that window: `migrate.sh` started the API and
    // the corrupted generation could be served until some LATER deployment happened to notice.
    //
    // WHAT THIS IS, STATED HONESTLY. It NARROWS the window; it does not close it. A writer that acts
    // after this read is still not seen, and no check placed inside this process can be the last
    // word about a process it cannot fence. What it does buy is the realistic case: a relay that was
    // already WAITING on the lock acquires it the moment the commit lands, so it has almost always
    // acted by the time this runs — and the outcome flips from "serve corrupt data silently" to
    // "fail the deployment closed". The marker stays; the next start reads it, re-diagnoses under
    // the lock, and refuses `marked-but-corrupt`, which is the correct terminal state for a register
    // something is still writing.
    //
    // CLOSING the window needs the drain itself — no process older than the fence running at all —
    // which is what `phase-6-4c-previous-release-drained` gates and what this code cannot establish.
    // Enforcing that gate at deploy time is a change to production deploy behaviour, so it is routed
    // rather than taken here.
    //
    // UNVERIFIABLE IS A REFUSAL *HERE*, unlike at diagnosis time (Codex on `b5f7c1f`). An earlier
    // head tested only `after.corrupt` and so was strictly weaker than the in-transaction check
    // twenty lines above, which already treats anything but `current-match`/`none` as something
    // having moved. That gap is exploitable in the exact scenario this recheck exists for:
    // `diagnoseIn` returns `lagging` BEFORE it compares a single stored row, so a relay that
    // rewrote the generation and advanced the stream head lands in `unverified`, not `corrupt`,
    // and the deployment reported success over it.
    //
    // Why the opposite rule is right on the marker-present path: THERE `lagging` is an ordinary
    // state of a database nobody has just rebuilt, and refusing on it would park deployments on a
    // projection that is merely behind. HERE the rebuild has just seeded every generation through
    // the stream head under the generation locks, so `current-match`/`none` is the only state a
    // successful commit can leave. Anything else means something wrote after the commit — which is
    // precisely the finding.
    const after = await diagnoseCurrentProjects(prisma, ops, orgs, config?.anchorProjectId ?? '', projectIds);
    const moved = [...after.corrupt, ...after.unverified];
    if (moved.length > 0) {
      const refusal: Refusal = {
        code: 'concurrent-corruption',
        message:
          `the repair verified and committed, but re-reading immediately afterwards found `
          + `${moved.length} generation(s) no longer verifiably current: ${moved.join(', ')}. `
          + 'Committing releases the generation locks, and a process older than the drain fence that '
          + 'was waiting on one takes it at that moment — which is exactly what the drain '
          + 'prerequisite exists to eliminate. The deployment FAILS CLOSED rather than starting the '
          + 'API over a register something is still rewriting. Stop every pre-4c-ii process and '
          + 'redeploy. See docs/RUNBOOK.md §P64CIIIR.',
      };
      log(`[4c-iii-r] REFUSED (${refusal.code}): ${refusal.message}`);
      return { ...base, ok: false, action: 'refused', projectCount, refusal, report };
    }

    log(marker
      ? `[4c-iii-r] repaired under an EXISTING marker (none written): ${report.projects} project(s), corruptBefore=${report.corruptBefore}`
      : `[4c-iii-r] repaired and marked: ${report.projects} project(s), corruptBefore=${report.corruptBefore}`);
    return { ...base, ok: true, action: 'repaired', projectCount, markerWritten: !marker, report };
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${PHASE6_4C_IIIR_LOCK_KEY}::bigint)`;
  }
}
