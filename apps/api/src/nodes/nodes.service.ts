import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';
import type { CreateNodeInput, MoveNodeInput, RenameNodeInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';

/** The location tree is exactly 3 levels: a zone contains rooms, a room contains
 *  elements (the objects, e.g. "Main Door"). A node's kind fixes what its parent
 *  must be — this keeps the tree well-formed so the UI can render clean breadcrumbs. */
const PARENT_KIND: Record<string, 'zone' | 'room' | null> = {
  zone: null, // top level
  room: 'zone',
  element: 'room',
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
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Create a zone/room/element under the right kind of parent. */
  async create(projectId: string, input: CreateNodeInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const parent = await this.requireParentForKind(projectId, input.kind, input.parentId ?? null);
    const order = await this.nextOrder(projectId, input.parentId ?? null);
    // Draft → Publish: a node under a DRAFT parent must itself be a draft (a published child of a
    // hidden parent would be an orphan on the team's Site Map). Otherwise honour `publish`.
    const parentIsDraft = parent ? parent.publishedAt === null : false;
    const publishedAt = input.publish && !parentIsDraft ? new Date() : null;
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.projectNode.create({
        data: { projectId, parentId: parent?.id ?? null, name: input.name, kind: input.kind, order, authorId: user.sub, publishedAt },
      });
      await emitEvent(tx, { projectId, actor, eventType: 'node.created', entityType: 'ProjectNode', entityId: created.id, payload: { name: input.name, kind: input.kind }, effectKey: 'node.created', dispatch: {} });
    });
    return this.done(projectId, user);
  }

  /** Publish a private draft location → it (its subtree, and any draft ancestors so the path is
   *  whole) become visible to the team and available in the filing pickers. PMC authority. */
  async publish(projectId: string, nodeId: string, user: AuthUser): Promise<SnapshotDto> {
    const node = await this.requireNode(projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    // publish the whole branch: draft ancestors (so the breadcrumb is complete) + the subtree.
    const ancestors = await this.ancestorIds(nodeId);
    const subtree = await this.subtreeIds(nodeId);
    const branch = [...new Set([...ancestors, ...subtree])];
    await this.prisma.$transaction(async (tx) => {
      await tx.projectNode.updateMany({
        where: { id: { in: branch }, projectId, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      await emitEvent(tx, { projectId, actor, eventType: 'node.published', entityType: 'ProjectNode', entityId: nodeId, effectKey: 'node.published', dispatch: {} });
    });
    void node;
    return this.done(projectId, user);
  }

  /** Rename a node (its decisions/children are untouched). */
  async rename(projectId: string, nodeId: string, input: RenameNodeInput, user: AuthUser): Promise<SnapshotDto> {
    await this.requireNode(projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction(async (tx) => {
      await tx.projectNode.update({ where: { id: nodeId }, data: { name: input.name } });
      await emitEvent(tx, { projectId, actor, eventType: 'node.renamed', entityType: 'ProjectNode', entityId: nodeId, payload: { name: input.name }, effectKey: 'node.renamed', dispatch: {} });
    });
    return this.done(projectId, user);
  }

  /** Reparent (and optionally reorder) a node — kind rules and cycle-safety enforced. */
  async move(projectId: string, nodeId: string, input: MoveNodeInput, user: AuthUser): Promise<SnapshotDto> {
    const node = await this.requireNode(projectId, nodeId);
    const parent = await this.requireParentForKind(projectId, node.kind, input.parentId);
    if (parent) {
      if (parent.id === nodeId) throw new BadRequestException('A node cannot be its own parent');
      if (await this.isDescendant(parent.id, nodeId)) throw new BadRequestException('Cannot move a node under one of its own descendants');
    }
    const order = input.order ?? (await this.nextOrder(projectId, input.parentId));
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction(async (tx) => {
      await tx.projectNode.update({ where: { id: nodeId }, data: { parentId: parent?.id ?? null, order } });
      await emitEvent(tx, { projectId, actor, eventType: 'node.moved', entityType: 'ProjectNode', entityId: nodeId, payload: { parentId: parent?.id ?? null }, effectKey: 'node.moved', dispatch: {} });
    });
    return this.done(projectId, user);
  }

  /**
   * Delete a node. Refuses when the node or any descendant still has a decision attached —
   * the PMC must reassign or remove those first, so a subtree delete can't silently
   * orphan (null out) a pile of decisions. An empty subtree is removed (children cascade).
   */
  async remove(projectId: string, nodeId: string, user: AuthUser): Promise<SnapshotDto> {
    await this.requireNode(projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    const subtree = await this.subtreeIds(nodeId);
    const attached = await this.prisma.decision.count({ where: { nodeId: { in: subtree } } });
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
    await this.prisma.$transaction(async (tx) => {
      await tx.projectNode.delete({ where: { id: nodeId } }); // children cascade; FKs unfile placed records
      await emitEvent(tx, { projectId, actor, eventType: 'node.removed', entityType: 'ProjectNode', entityId: nodeId, effectKey: 'node.removed', dispatch: {} });
    });
    return this.done(projectId, user);
  }

  // ---- helpers ----

  private async done(projectId: string, user: AuthUser): Promise<SnapshotDto> {
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  private async requireNode(projectId: string, nodeId: string) {
    const node = await this.prisma.projectNode.findUnique({ where: { id: nodeId } });
    if (!node || node.projectId !== projectId) throw new NotFoundException('Location not found in this project');
    return node;
  }

  /** Validate & load the parent required for a node of `kind` (null when the kind is top-level). */
  private async requireParentForKind(projectId: string, kind: string, parentId: string | null) {
    const expected = PARENT_KIND[kind];
    if (expected === undefined) throw new BadRequestException('Unknown location kind');
    if (expected === null) {
      if (parentId) throw new BadRequestException('A zone is top-level and cannot have a parent');
      return null;
    }
    if (!parentId) throw new BadRequestException(`A ${kind} must sit under a ${expected}`);
    const parent = await this.requireNode(projectId, parentId);
    if (parent.kind !== expected) throw new BadRequestException(`A ${kind} must sit under a ${expected}, not a ${parent.kind}`);
    return parent;
  }

  private async nextOrder(projectId: string, parentId: string | null): Promise<number> {
    const siblings = await this.prisma.projectNode.findMany({ where: { projectId, parentId }, select: { order: true } });
    return siblings.reduce((m, s) => Math.max(m, s.order), -1) + 1;
  }

  /** All node ids in the subtree rooted at `nodeId` (inclusive). */
  private async subtreeIds(nodeId: string): Promise<string[]> {
    const all = await this.prisma.projectNode.findMany({ select: { id: true, parentId: true } });
    const childrenOf = new Map<string, string[]>();
    for (const n of all) {
      if (n.parentId) childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n.id]);
    }
    const ids: string[] = [];
    const walk = (id: string): void => {
      ids.push(id);
      for (const c of childrenOf.get(id) ?? []) walk(c);
    };
    walk(nodeId);
    return ids;
  }

  /** True when `nodeId` is `ancestorId` or a descendant of it (cycle guard for move). */
  private async isDescendant(nodeId: string, ancestorId: string): Promise<boolean> {
    return (await this.subtreeIds(ancestorId)).includes(nodeId);
  }

  /** Ancestor ids of a node (nearest-first), EXCLUDING the node itself (cycle-safe). */
  private async ancestorIds(nodeId: string): Promise<string[]> {
    const all = await this.prisma.projectNode.findMany({ select: { id: true, parentId: true } });
    const parentOf = new Map(all.map((n) => [n.id, n.parentId]));
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = parentOf.get(nodeId) ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return out;
  }
}
