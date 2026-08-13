import { Prisma } from '@prisma/client';

/**
 * Phase 6 task 2 (nested locations, §A) — ONE database-level protocol serializing
 * every write that can change a node's depth, ancestry, or visibility relation.
 *
 * The tree invariants (no cycle; never more than MAX_TREE_DEPTH levels; a node is
 * never more visible than its parent) are properties of the WHOLE project tree, and
 * ancestry can span any subset of it — so the project's node set is the honest lock
 * granularity. `create`, `move` and `publish` take this lock as the FIRST statement
 * of their transaction and re-derive every check INSIDE it: two concurrent moves
 * (`A under B` ∥ `B under A`), a create racing a reparent of its ancestry, or a
 * publish racing a move of its branch each serialize here instead of both passing
 * on stale snapshots.
 *
 * This is deliberately NOT `lockProjectReadiness`: the location tree gates no
 * activity start, and widening the readiness lock's §A enumeration with tree writes
 * would couple two unrelated protocols. A node write takes only this lock, so no
 * cross-lock ordering exists.
 *
 * pg_advisory_xact_lock releases automatically at COMMIT/ROLLBACK.
 */
export async function lockProjectTree(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${treeLockKey(projectId)}, 0))`);
}

/** The lock's KEY, exported so a probe (or a non-DI caller) takes the SAME lock
 *  rather than one that merely looks like it — one derivation, every caller. */
export function treeLockKey(projectId: string): string {
  return 'project-tree:' + projectId;
}
