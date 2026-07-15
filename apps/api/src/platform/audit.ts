import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor';

/**
 * Phase 2 Task 3 — the platform audit kernel.
 *
 * `recordAudit` is the ONE canonical `AuditLog` writer. Every consequential state change
 * records its audit row through it, so attribution is uniform by construction: the `actor`
 * display label, `actorId` and `actorRole` all come from a resolved {@link Actor}
 * (`resolveActor` for a signed-in human, `systemActor` for a named system process) — never a
 * bare role string with a null id (the two-convention gap Phase 1 left behind). Task 4's
 * event kernel reuses the same `Actor`, so an audit row and its DomainEvent always agree on
 * who acted. `audit.test.ts` asserts no domain service writes `auditLog.create` directly.
 */

/** A DB handle able to write the AuditLog — the request transaction client (`$transaction`
 *  callback) OR the PrismaService itself (array-form `$transaction([...])`); a full
 *  PrismaClient is assignable to the reduced TransactionClient type. */
export type AuditDb = Prisma.TransactionClient;

export interface AuditEntry {
  projectId: string | null;
  actor: Actor;
  action: string;
  entity: string;
  entityId: string;
  payload?: Prisma.InputJsonValue;
}

/** Write one canonical audit row. Returns the `PrismaPromise` so it composes in both an
 *  awaited call and an array-form `$transaction([...])`. */
export function recordAudit(db: AuditDb, entry: AuditEntry) {
  return db.auditLog.create({
    data: {
      projectId: entry.projectId,
      actor: entry.actor.actorName,
      actorId: entry.actor.actorId,
      actorRole: entry.actor.actorRole,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
    },
  });
}
