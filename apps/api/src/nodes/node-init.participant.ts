import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Phase 2 Task 7 — the nodes module's project-INITIALIZATION participant (edge 8).
 *
 * Instantiating a new project's starting structure (orgs `createProject`, copyStructure /
 * instantiateModules) creates ProjectNode rows. Those writes route THROUGH this
 * participant on the caller's transaction, so the location-tree write physically lives in
 * the nodes module (its owner) — orgs never writes ProjectNode directly. A leaf provider.
 */
@Injectable()
export class NodeInitParticipant {
  /** Create one ProjectNode while instantiating a project, on the caller's transaction. */
  createForInit(tx: Prisma.TransactionClient, args: Prisma.ProjectNodeCreateArgs): Promise<{ id: string }> {
    return tx.projectNode.create(args);
  }
}
