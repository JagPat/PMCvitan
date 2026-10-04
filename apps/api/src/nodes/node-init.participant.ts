import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeNodeName } from './tree-rules';

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
  /** Create one ProjectNode while instantiating a project, on the caller's transaction.
   *  #705 — initialization is a writer of the sibling-name rule too: a copied source (or two
   *  selected modules) may carry the same name twice under one parent. The same kind under that
   *  name IS that place, so its id is returned and the source's children graft beneath it; another
   *  kind under the name is refused with the reason stated, as `create` refuses it. */
  async createForInit(tx: Prisma.TransactionClient, args: Prisma.ProjectNodeCreateArgs): Promise<{ id: string }> {
    const { projectId, parentId, name, kind } = args.data as Prisma.ProjectNodeUncheckedCreateInput;
    const wanted = normalizeNodeName(name);
    const siblings = await tx.projectNode.findMany({
      where: { projectId, parentId: parentId ?? null },
      select: { id: true, name: true, kind: true, projectId: true, parentId: true },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
    // the scope is re-applied here so the rule never rests on how a reader honours `where`
    const holders = siblings.filter((row) =>
      row.projectId === projectId && (row.parentId ?? null) === (parentId ?? null) && normalizeNodeName(row.name) === wanted);
    const same = holders.find((row) => row.kind === kind);
    if (same) return { id: same.id };
    if (holders.length > 0) {
      throw new BadRequestException(`The structure holds "${holders[0]!.name}" twice under one parent as different kinds — rename one before copying it`);
    }
    return tx.projectNode.create(args);
  }
}
