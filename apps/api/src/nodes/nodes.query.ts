import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isPlaceHiddenFrom } from './node-scope';

/**
 * The nodes module's read contract for other modules: a foreign reader asks here instead of reading the
 * nodes-owned `ProjectNode` table, so the location spine can change how a place is kept private without
 * silently breaking a reader elsewhere.
 */
@Injectable()
export class NodesQueryService {
  /** #1177 VT2-B — is the place `nodeId` a draft hidden from `viewerId`? Decided on the caller's transaction under
   *  the tree lock's shared side (its first statement), as {@link isPlaceHiddenFrom} does; an unfiled record
   *  (null) is never hidden. */
  placeHiddenFrom(tx: Prisma.TransactionClient, projectId: string, nodeId: string | null | undefined, viewerId: string | null | undefined): Promise<boolean> {
    return isPlaceHiddenFrom(tx, projectId, nodeId, viewerId);
  }
}
