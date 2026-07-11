import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';
import type { CreateNodeInput, MoveNodeInput, RenameNodeInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

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
    const parent = await this.requireParentForKind(projectId, input.kind, input.parentId ?? null);
    const order = await this.nextOrder(projectId, input.parentId ?? null);
    await this.prisma.projectNode.create({
      data: { projectId, parentId: parent?.id ?? null, name: input.name, kind: input.kind, order },
    });
    return this.done(projectId, user);
  }

  /** Rename a node (its decisions/children are untouched). */
  async rename(projectId: string, nodeId: string, input: RenameNodeInput, user: AuthUser): Promise<SnapshotDto> {
    await this.requireNode(projectId, nodeId);
    await this.prisma.projectNode.update({ where: { id: nodeId }, data: { name: input.name } });
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
    await this.prisma.projectNode.update({ where: { id: nodeId }, data: { parentId: parent?.id ?? null, order } });
    return this.done(projectId, user);
  }

  /**
   * Delete a node. Refuses when the node or any descendant still has a decision attached —
   * the PMC must reassign or remove those first, so a subtree delete can't silently
   * orphan (null out) a pile of decisions. An empty subtree is removed (children cascade).
   */
  async remove(projectId: string, nodeId: string, user: AuthUser): Promise<SnapshotDto> {
    await this.requireNode(projectId, nodeId);
    const subtree = await this.subtreeIds(nodeId);
    const attached = await this.prisma.decision.count({ where: { nodeId: { in: subtree } } });
    if (attached > 0) {
      throw new BadRequestException(`Move or remove the ${attached} decision(s) under this location before deleting it.`);
    }
    await this.prisma.projectNode.delete({ where: { id: nodeId } }); // children cascade
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
}
