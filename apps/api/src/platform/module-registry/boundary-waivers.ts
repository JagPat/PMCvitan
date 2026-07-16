/**
 * Phase 2 PR C Task 4 — the TYPED, BOUNDED boundary waivers.
 *
 * The boundary analyzer ({@link ./boundary-analyzer}) enforces two structural rules that a
 * small, exhaustively-enumerated set of REAL runtime sites legitimately breaks. Each break
 * is declared here as a NARROW, NON-WILDCARD waiver so the analyzer can prove the site is
 * the one we reviewed — never a blanket exemption:
 *
 *   1. {@link RAW_SQL_WRITE_WAIVERS} — a runtime raw-SQL statement that writes rows. Raw SQL
 *      is opaque to the delegate-level model attribution, so EVERY runtime raw write must be
 *      named by exact file + enclosing symbol. A waiver that matches zero sites (stale) OR
 *      more than one site (ambiguous) OR a raw write with no waiver is a boundary FINDING.
 *
 *   2. {@link CROSS_MODULE_WRITE_WAIVERS} — a delegate write to a Prisma model owned by
 *      ANOTHER (non-platform) module. The ONE such edge that survives Task 7 is auth's
 *      first-sign-in identity provisioning: the actor does not yet exist, so the command
 *      ledger's `(scope, actorId, key)` subject is undefined and the write cannot yet route
 *      through an orgs command. It is BOUNDED — its `removalTask` names Task 10's identity
 *      command work, so the Phase-2 final gate does not treat it as an indefinite waiver.
 *
 * There are NO wildcards and NO indefinite waivers. Prisma migration SQL (under
 * `prisma/migrations`) is out of the analyzed source tree entirely and is the only raw-SQL
 * path exclusion.
 */

/** A reviewed runtime raw-SQL write. Must match EXACTLY ONE analyzed write site. */
export interface RawSqlWriteWaiver {
  /** Source path relative to `apps/api/src` (posix separators). */
  readonly file: string;
  /** The enclosing function/method name of the raw write. */
  readonly symbol: string;
  /** The module id that owns the table(s) the statement writes (must be a registered module). */
  readonly owner: string;
  /** Why the raw statement is necessary and cannot be a delegate call. */
  readonly reason: string;
}

/**
 * The single runtime raw-SQL write: the outbox relay leases due deliveries with one atomic
 * `UPDATE "OutboxDelivery" SET status='leased' … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
 * RETURNING id`. `SKIP LOCKED` + `RETURNING` in one statement is not expressible through the
 * Prisma delegate API. `OutboxDelivery` is a platform-owned shared table and the relay is the
 * platform module, so this is an own-module write — the waiver records that the raw statement
 * was reviewed, not that it crosses a boundary.
 */
export const RAW_SQL_WRITE_WAIVERS: ReadonlyArray<RawSqlWriteWaiver> = [
  {
    file: 'platform/outbox/relay.service.ts',
    symbol: 'claim',
    owner: 'platform',
    reason:
      'Atomic lease claim: UPDATE "OutboxDelivery" SET status=leased … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING id — SKIP LOCKED + RETURNING in one statement is not expressible via the Prisma delegate API. Own-module write (platform owns OutboxDelivery).',
  },
];

/** A reviewed, BOUNDED delegate write to another module's model. Keyed by (module, model). */
export interface CrossModuleWriteWaiver {
  /** The module whose runtime code performs the write (from the writing file's `src/<dir>`). */
  readonly module: string;
  /** The Prisma model delegate written (owned by {@link owner}). */
  readonly model: string;
  /** The module id that OWNS the model. */
  readonly owner: string;
  /** Why the cross-module write is currently necessary. */
  readonly reason: string;
  /** The task that removes this waiver — a bounded waiver names its exit, never open-ended. */
  readonly removalTask: string;
}

/**
 * Auth's first-sign-in identity provisioning writes the orgs-owned identity rows (User,
 * Membership, WorkerDevice). This is the ONE cross-module persistence edge that survives
 * Task 7, and it is BOUNDED — Task 10's identity-command work removes it.
 */
export const CROSS_MODULE_WRITE_WAIVERS: ReadonlyArray<CrossModuleWriteWaiver> = [
  { module: 'auth', model: 'user', owner: 'orgs', reason: 'first sign-in provisions the account before any orgs command actor exists', removalTask: 'Task 10 — identity command work' },
  { module: 'auth', model: 'membership', owner: 'orgs', reason: 'first sign-in grants the initial project membership alongside the account', removalTask: 'Task 10 — identity command work' },
  { module: 'auth', model: 'workerDevice', owner: 'orgs', reason: 'anonymous worker-token onboarding provisions the device row before any actor exists', removalTask: 'Task 10 — identity command work' },
];
