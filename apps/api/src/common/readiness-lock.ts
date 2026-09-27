import { Prisma } from '@prisma/client';

/**
 * Phase 1 gate finding 1 (P1) — ONE database-level protocol serializing
 * activity start against every readiness-affecting write.
 *
 * start() evaluates the five-gate readiness and commits the transition while
 * holding this per-project transaction-scoped advisory lock, and every write
 * that can move a gate takes the SAME lock first:
 *
 *   - decision lock-state transitions (approve / change request / withdraw),
 *   - drawing issue/publish (governing revision + frozen recipients),
 *     acknowledgements, and drawing deletion (they move the drawing gate),
 *   - inspection create/submit/decide on the requirement edge,
 *   - membership activation/removal (active members ∩ frozen recipients),
 *   - gate overrides (grant and revoke),
 *   - stored material/team flags and decision-linkage edits on the activity.
 *
 * A gate can therefore flip strictly BEFORE a start (the start sees it and
 * refuses) or strictly AFTER it (the write waits for the start's commit) —
 * never in between, so a "201 over a gate that already failed" is impossible.
 *
 * pg_advisory_xact_lock releases automatically at COMMIT/ROLLBACK. The lock is
 * always the FIRST statement of its transaction — a single uniform acquisition
 * order ahead of any row locks (Drawing FOR UPDATE, Membership FOR UPDATE), so
 * no lock-ordering deadlock is possible. Coarse per-project granularity is
 * deliberate: membership churn affects every activity in the project, and site
 * write rates are human-scale.
 */
export async function lockProjectReadiness(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  // $executeRaw, not $queryRaw: the function returns void, which Prisma's row
  // deserializer refuses; execute only reports the affected-row count
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${readinessLockKey(projectId)}, 0))`);
}

/**
 * The lock's KEY, exported so a caller that cannot use `$executeRaw` takes the SAME lock rather
 * than one that merely looks like it.
 *
 * Phase 5 Task 6A (Codex round 3). `OrgsParticipant` is constructible by non-DI callers and its
 * client interface declares only `$queryRawUnsafe`, so it cannot call `lockProjectReadiness`
 * directly. Spelling `'readiness:' + projectId` there a second time would be two statements of one
 * key: the day this prefix changes, one caller silently stops serializing against the other and
 * nothing fails. One derivation, two callers.
 */
export function readinessLockKey(projectId: string): string {
  return 'readiness:' + projectId;
}

/**
 * Phase 6 task 4d unit 4d-ii-a / A3c — the ORG standing key, `org:<orgId>` in the same advisory
 * shape as the project key (plan §A.2, the push families: #557's review round 1, finding 3).
 *
 * A per-project key cannot close a phantom: an owner/admin `OrgMembership` writer enumerates the
 * org's projects and takes each one's key, and a project whose creation has not committed yet is
 * not in that enumeration, so a writer can miss it and a forward on it can later freeze a `pmc` set
 * the committing owner is absent from. ONE key per org serializes the SET: project creation holds it
 * while it inserts, and every owner/admin org writer takes it FIRST and then the project keys
 * ascending, so its enumeration under the key sees every committed project.
 *
 * The lock order org → project is the only order: a creation takes the org key and then its own new
 * project's key, an org writer takes the org key and then the project keys ascending, and a
 * command takes one project key and never the org key. So no cycle exists.
 */
export async function lockOrgStanding(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgStandingLockKey(orgId)}, 0))`);
}

/** The org key, exported for the same reason as {@link readinessLockKey}: one derivation. */
export function orgStandingLockKey(orgId: string): string {
  return 'org:' + orgId;
}
