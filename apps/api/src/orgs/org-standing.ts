import { Prisma } from '@prisma/client';
import { lockOrgStanding, lockProjectReadiness } from '../common/readiness-lock';

/**
 * Phase 6 task 4d unit 4d-ii-a / A3c — the org standing protocol, built on `lockOrgStanding`.
 *
 * WHY THE `Org` ROW IS BUMPED. Project creation runs SERIALIZABLE (`runSerializableProjectInit`),
 * and a SERIALIZABLE transaction's snapshot is fixed at the START of its first statement. If that
 * statement is the org key and has to WAIT for an org writer, the snapshot predates the writer it
 * waited for (measured on PG 16: after acquiring the key the reader still sees the pre-write value).
 * The creation's in-key re-judge of its creator, and 4d-i's `Project_t4d_user_standing` trigger
 * seeding the new project's owners, would then read the standing as it was BEFORE the org write, so
 * the key would serialize the writers and still let the phantom through.
 *
 * So every org writer, under the key, writes a new version of the org's own row
 * ({@link markOrgStandingWrite}), and the creation, right after taking the key, locks that row
 * FOR SHARE ({@link assertOrgStandingSnapshotCurrent}). Under REPEATABLE READ or SERIALIZABLE,
 * locking a row that a transaction committed AFTER the snapshot is a serialization failure (40001),
 * which the creation retries with a fresh snapshot that sees the writer; with no such writer the
 * lock is taken and the snapshot is current (measured both ways). A READ COMMITTED writer needs
 * none of this: every statement after the key reads a fresh snapshot.
 */

/** Write a new version of the org row, under the org key: the marker a SERIALIZABLE reader checks. */
export async function markOrgStandingWrite(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`UPDATE "Org" SET "name" = "name" WHERE "id" = ${orgId}`);
}

/**
 * Refuse a stale snapshot, right after the org key is taken: lock the org row FOR SHARE, which a
 * REPEATABLE READ / SERIALIZABLE transaction cannot do on a row an org writer changed after its
 * snapshot. The failure is a serialization failure, retried by `runSerializableProjectInit`.
 */
export async function assertOrgStandingSnapshotCurrent(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "Org" WHERE "id" = ${orgId} FOR SHARE`);
}

/**
 * The owner/admin org writer's keys, in the one order: the org key, the org-row marker, then every
 * project of the org by ascending id (additions and promotions included, not only reductions).
 * The enumeration runs under the org key, so it sees every committed project and no project can be
 * created until this transaction ends. Returns the projects in the order their keys were taken.
 */
export async function lockOrgStandingWriters(tx: Prisma.TransactionClient, orgId: string): Promise<Array<{ id: string }>> {
  await lockOrgStanding(tx, orgId);
  await markOrgStandingWrite(tx, orgId);
  const projects = await tx.project.findMany({ where: { orgId }, select: { id: true }, orderBy: { id: 'asc' } });
  for (const p of projects) await lockProjectReadiness(tx, p.id);
  return projects;
}

/** Whether an org role carries owner/admin standing — the roles the org key protects. */
export function holdsOrgStanding(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
