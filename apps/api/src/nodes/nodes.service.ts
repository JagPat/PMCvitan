import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { lockProjectTree } from '../common/tree-lock';
import { MAX_TREE_DEPTH, ancestorIdsOf, depthOf, heightOf, subtreeIdsOf, type TreeRow } from './tree-rules';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { InspectionParticipant } from '../inspections/inspection.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { DrawingParticipant } from '../drawings/drawing.participant';
import { DailyLogParticipant } from '../daily-log/daily-log.participant';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import type { AuthUser } from '../common/auth';
import type { CreateNodeInput, MoveNodeInput, RenameNodeInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import type { EmittedEventMeta } from '../platform/outbox/registry';

/** The location tree RULE (nested locations, phase-6-task-2): a zone is top-level
 *  only; a room sits under a zone OR another room; an element (the object, e.g.
 *  "Main Door") is a LEAF and sits under a room OR directly under a zone. The kind
 *  fixes the SET of legal parents — depth is bounded separately (5 levels). */
const ALLOWED_PARENT_KINDS: Record<string, ReadonlyArray<'zone' | 'room'> | null> = {
  zone: null, // top level
  room: ['zone', 'room'],
  element: ['room', 'zone'],
};

/**
 * The project location tree (zones → rooms → elements). PMC authors it; decisions
 * (and later other modules) attach to a node so the register can be grouped, filtered
 * and browsed by where things live in the building.
 */
@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    // PR C Task 2 — the single external-effect sender (replaces the in-request RealtimeGateway).
    private readonly dispatcher: ExternalEffectDispatcher,
    // Task 8 — the "decisions filed under this location" guard goes through the decisions query.
    private readonly decisions: DecisionsQueryService,
    // Task 10 (Module 3) correction — deleting a node unfiles placed inspections through the participant
    // (in-tx), which appends `inspection.unfiled` so the projection observes the location change.
    private readonly inspectionParticipant: InspectionParticipant,
    // Task 10 (Module 4) — the same for filed activities: unfiled through the activities participant
    // (in-tx), which appends `activity.unfiled` so the activities.schedule projection observes it.
    private readonly activityParticipant: ActivityParticipant,
    // Task 10 (Module 4) correction — the same for filed drawings (`drawing.unfiled`) and staged
    // materials (`material.unfiled`): their locations are serialized into the drawings.inbox /
    // daily-log.inbox bases, so a node delete must produce an owner-aligned signal for each.
    private readonly drawingParticipant: DrawingParticipant,
    private readonly dailyLogParticipant: DailyLogParticipant,
  ) {}

  /** Create a zone/room/element under the right kind of parent. The tree invariants (depth,
   *  visibility) are re-derived INSIDE the tree-lock transaction: a create racing a reparent
   *  of its ancestry otherwise passes both checks on stale snapshots and lands at level 6. */
  async create(projectId: string, input: CreateNodeInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      await lockProjectTree(tx, projectId);
      const parent = await this.requireParentForKind(projectId, input.kind, input.parentId ?? null, tx);
      const tree = await this.loadTree(tx, projectId);
      const depth = parent ? depthOf(tree, parent.id) + 1 : 1;
      if (depth > MAX_TREE_DEPTH) {
        throw new BadRequestException(`Cannot add "${input.name}" at level ${depth} — locations nest to ${MAX_TREE_DEPTH} levels`);
      }
      const order = this.nextOrderIn(tree, parent?.id ?? null);
      // Draft → Publish: a node under a DRAFT parent must itself be a draft (a published child of a
      // hidden parent would be an orphan on the team's Site Map). Otherwise honour `publish`.
      const parentIsDraft = parent ? parent.publishedAt === null : false;
      const publishedAt = input.publish && !parentIsDraft ? new Date() : null;
      const created = await tx.projectNode.create({
        data: { projectId, parentId: parent?.id ?? null, name: input.name, kind: input.kind, order, authorId: user.sub, publishedAt },
      });
      return emitEvent(tx, { projectId, actor, eventType: 'node.created', entityType: 'ProjectNode', entityId: created.id, payload: { name: input.name, kind: input.kind }, effectKey: 'node.created', dispatch: {} });
    });
    return this.done(projectId, user, [ev]);
  }

  /** Publish a private draft location → it (its subtree, and any draft ancestors so the path is
   *  whole) become visible to the team and available in the filing pickers. PMC authority.
   *  The branch is computed INSIDE the tree-lock transaction: computed outside it, a concurrent
   *  move of a still-draft child lands a published node beneath a hidden ancestor (§A's race). */
  async publish(projectId: string, nodeId: string, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      await lockProjectTree(tx, projectId);
      await this.requireNode(projectId, nodeId, tx);
      const tree = await this.loadTree(tx, projectId);
      const branch = [...new Set([...ancestorIdsOf(tree, nodeId), ...subtreeIdsOf(tree, nodeId)])];
      await tx.projectNode.updateMany({
        where: { id: { in: branch }, projectId, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      return emitEvent(tx, { projectId, actor, eventType: 'node.published', entityType: 'ProjectNode', entityId: nodeId, effectKey: 'node.published', dispatch: {} });
    });
    return this.done(projectId, user, [ev]);
  }

  /** Rename a node (its decisions/children are untouched). */
  async rename(projectId: string, nodeId: string, input: RenameNodeInput, user: AuthUser): Promise<SnapshotDto> {
    await this.requireNode(projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      await tx.projectNode.update({ where: { id: nodeId }, data: { name: input.name } });
      return emitEvent(tx, { projectId, actor, eventType: 'node.renamed', entityType: 'ProjectNode', entityId: nodeId, payload: { name: input.name }, effectKey: 'node.renamed', dispatch: {} });
    });
    return this.done(projectId, user, [ev]);
  }

  /** Reparent (and optionally reorder) a node. Kind rules, cycle-safety, the 5-level depth cap
   *  (destination depth + the moved subtree's HEIGHT — a cap on the moved node alone lands its
   *  descendants at level 6 silently) and the visibility invariant (`a node may not be more
   *  visible than its parent` — the rule `create` already enforces) are ALL re-derived inside
   *  the tree-lock transaction, serialized against every other tree write. */
  async move(projectId: string, nodeId: string, input: MoveNodeInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      await lockProjectTree(tx, projectId);
      const node = await this.requireNode(projectId, nodeId, tx);
      const parent = await this.requireParentForKind(projectId, node.kind, input.parentId, tx);
      const tree = await this.loadTree(tx, projectId);
      const subtree = subtreeIdsOf(tree, nodeId);
      if (parent) {
        if (parent.id === nodeId) throw new BadRequestException('A node cannot be its own parent');
        if (subtree.includes(parent.id)) throw new BadRequestException('Cannot move a node under one of its own descendants');
      }
      const destinationDepth = parent ? depthOf(tree, parent.id) : 0;
      const deepest = destinationDepth + heightOf(tree, nodeId);
      if (deepest > MAX_TREE_DEPTH) {
        throw new BadRequestException(`Cannot move "${node.name}" here — its deepest location would land at level ${deepest}, and locations nest to ${MAX_TREE_DEPTH} levels`);
      }
      if (parent && parent.publishedAt === null) {
        const byId = new Map(tree.map((row) => [row.id, row]));
        const published = subtree.some((id) => byId.get(id)?.publishedAt != null);
        if (published) {
          throw new BadRequestException(`Cannot move a published location under the draft "${parent.name}" — a published child of a hidden parent would be an orphan on the team's Site Map. Publish "${parent.name}" first.`);
        }
      }
      const order = input.order ?? this.nextOrderIn(tree, parent?.id ?? null);
      await tx.projectNode.update({ where: { id: nodeId }, data: { parentId: parent?.id ?? null, order } });
      return emitEvent(tx, { projectId, actor, eventType: 'node.moved', entityType: 'ProjectNode', entityId: nodeId, payload: { parentId: parent?.id ?? null }, effectKey: 'node.moved', dispatch: {} });
    });
    return this.done(projectId, user, [ev]);
  }

  /**
   * Delete a node. Refuses when the node or any descendant still has a decision attached —
   * the PMC must reassign or remove those first, so a subtree delete can't silently
   * orphan (null out) a pile of decisions. An empty subtree is removed (children cascade).
   */
  async remove(projectId: string, nodeId: string, user: AuthUser): Promise<SnapshotDto> {
    await this.requireNode(projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    const subtree = subtreeIdsOf(await this.loadTree(this.prisma, projectId), nodeId);
    const attached = await this.decisions.countByNodeIds(subtree);
    if (attached > 0) {
      throw new BadRequestException(`Move or remove the ${attached} decision(s) under this location before deleting it.`);
    }
    // Edge 7 (Task 7): the (projectId, nodeId) FKs across the five placed domains
    // (activity, inspection, media, drawing, siteMaterial) are now ON DELETE SET NULL
    // (nodeId) — PostgreSQL nulls ONLY the nodeId (leaving the NOT-NULL tenant projectId
    // intact) as each ProjectNode in the subtree is deleted, so the records stay and just
    // become unplaced. No cross-module write here. Decisions are excluded on purpose:
    // their FK stays NO ACTION and the count guard above refuses the delete instead of
    // silently unfiling them.
    const events = await this.prisma.$transaction(async (tx) => {
      // Task 10 (Modules 3+4 + correction) — unfile EVERY placed record whose location is serialized
      // into a module projection FIRST, through each owning module's participant, which appends its
      // owner-aligned signal (`inspection.unfiled` / `activity.unfiled` / `drawing.unfiled` /
      // `material.unfiled`) when any row changed, so every ordered projection observes the location
      // change (the ON DELETE SET NULL FKs below stay as the DB backstop). Media stays FK-only: no
      // module projection serializes `Media.nodeId` (the snapshot's photo layer is a live read).
      const unfiledEv = await this.inspectionParticipant.unfileForDeletedNodes(tx, { projectId, actor, nodeIds: subtree });
      const unfiledActEv = await this.activityParticipant.unfileForDeletedNodes(tx, { projectId, actor, nodeIds: subtree });
      const unfiledDrawEv = await this.drawingParticipant.unfileForDeletedNodes(tx, { projectId, actor, nodeIds: subtree });
      const unfiledMatEv = await this.dailyLogParticipant.unfileMaterialsForDeletedNodes(tx, { projectId, actor, nodeIds: subtree });
      await tx.projectNode.delete({ where: { id: nodeId } }); // children cascade; FKs unfile remaining placed records
      const removedEv = await emitEvent(tx, { projectId, actor, eventType: 'node.removed', entityType: 'ProjectNode', entityId: nodeId, effectKey: 'node.removed', dispatch: {} });
      return [unfiledEv, unfiledActEv, unfiledDrawEv, unfiledMatEv, removedEv].filter((e): e is EmittedEventMeta => e !== null);
    });
    return this.done(projectId, user, events);
  }

  // ---- helpers ----

  private async done(projectId: string, user: AuthUser, events: EmittedEventMeta[]): Promise<SnapshotDto> {
    await this.dispatcher.dispatchCommitted(events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  private async requireNode(projectId: string, nodeId: string, db: Db = this.prisma) {
    const node = await db.projectNode.findUnique({ where: { id: nodeId } });
    if (!node || node.projectId !== projectId) throw new NotFoundException('Location not found in this project');
    return node;
  }

  /** Validate & load the parent required for a node of `kind` (null when the kind is top-level). */
  private async requireParentForKind(projectId: string, kind: string, parentId: string | null, db: Db = this.prisma) {
    const allowed = ALLOWED_PARENT_KINDS[kind];
    if (allowed === undefined) throw new BadRequestException('Unknown location kind');
    if (allowed === null) {
      if (parentId) throw new BadRequestException('A zone is top-level and cannot have a parent');
      return null;
    }
    const expected = allowed.join(' or a ');
    if (!parentId) throw new BadRequestException(`A ${kind} must sit under a ${expected}`);
    const parent = await this.requireNode(projectId, parentId, db);
    if (!(allowed as readonly string[]).includes(parent.kind)) {
      throw new BadRequestException(`A ${kind} must sit under a ${expected}, not a ${parent.kind}`);
    }
    return parent;
  }

  /** The project's node set, loaded ONCE per write with a PROJECT-SCOPED read (the old
   *  subtree/ancestor helpers scanned every project's rows). The pure walkers in
   *  `tree-rules.ts` then operate on exactly these rows — inside a tree-lock
   *  transaction they are the serialized truth every invariant is derived from. */
  private async loadTree(db: Db, projectId: string): Promise<LoadedTreeRow[]> {
    return db.projectNode.findMany({
      where: { projectId },
      select: { id: true, parentId: true, publishedAt: true, order: true },
    });
  }

  private nextOrderIn(tree: LoadedTreeRow[], parentId: string | null): number {
    return tree.filter((row) => row.parentId === parentId).reduce((m, row) => Math.max(m, row.order), -1) + 1;
  }
}

/** The subset of the client both `this.prisma` and a transaction satisfy. */
type Db = Pick<PrismaService, 'projectNode'> | Prisma.TransactionClient;

interface LoadedTreeRow extends TreeRow {
  publishedAt: Date | null;
  order: number;
}
