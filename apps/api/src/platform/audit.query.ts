import type { Prisma } from '@prisma/client';

/**
 * U3a — the platform kernel's read of its own `AuditLog`, beside `recordAudit` (its one writer). A
 * domain module that needs a fact only its audit trail keeps asks here, so the audit schema and that
 * module's query boundary evolve independently: the module names the action it owns, the kernel owns
 * how the trail is read.
 */
export type AuditReadClient = Pick<Prisma.TransactionClient, 'auditLog'>;

export const AuditQuery = {
  /** How many DISTINCT entities had `action` recorded on the project at or after `since` (an entity
   *  audited several times in the window counts once). */
  async distinctEntitiesSince(db: AuditReadClient, projectId: string, action: string, since: Date): Promise<number> {
    const rows = await db.auditLog.findMany({
      where: { projectId, action, at: { gte: since } },
      select: { entityId: true },
      distinct: ['entityId'],
    });
    return rows.length;
  },
};
