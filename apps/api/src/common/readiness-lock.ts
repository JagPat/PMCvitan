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
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'readiness:' + projectId}, 0))`);
}
