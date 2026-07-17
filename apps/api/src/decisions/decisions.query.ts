import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { DecisionStatus } from '../domain/transitions';
import type { Role } from '../common/auth';
import type { DecisionDto } from '../snapshot/types';

/**
 * Phase 2 Task 8 — the decisions module's PUBLIC READ boundary (its query contract).
 *
 * The first backend extraction: no other module reads `decision`/`decisionOption`/`decisionEvent`/
 * `changeRequest` persistence directly. Every cross-module read a consumer needs is a narrow,
 * same-transaction-safe query answered HERE, so the module owns its private repository and is reachable
 * only via its contract (commands + these queries) + its events. The boundary CI check
 * (module-registry) enforces that the decision models are read-encapsulated — a stray `prisma.decision`
 * read in another module is a `cross-module-read` finding.
 *
 * Each method is a plain read on the injected client; none mutates. They map exactly onto the reads the
 * consumers performed before extraction — the snapshot serialization (moved here verbatim so the
 * snapshot shape is byte-identical), the existence/tenant checks, and the two counts — so the observable
 * behavior is unchanged.
 */
@Injectable()
export class DecisionsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The decisions slice of the project snapshot: the role-filtered `DecisionDto[]` the store hydrates,
   * PLUS an unfiltered `id → status` map the activities readiness derivation consults (readiness must
   * see the true decision status regardless of a role's visibility). One query serves both.
   */
  async snapshotSlice(
    projectId: string,
    role: Role,
    userId?: string,
  ): Promise<{ decisions: DecisionDto[]; statuses: Map<string, DecisionStatus> }> {
    const rows = await this.prisma.decision.findMany({
      where: { projectId },
      // the OPEN change request travels with a reopened decision (Phase 1 Task 2)
      include: { options: { orderBy: { order: 'asc' } }, changeRequests: { where: { status: 'open' }, take: 1 } },
      orderBy: { id: 'desc' },
    });

    const statuses = new Map<string, DecisionStatus>(rows.map((d) => [d.id, d.status as DecisionStatus]));

    const hidePending = role !== 'pmc' && role !== 'client';
    const decisions: DecisionDto[] = rows
      .filter((d) => {
        // Draft → Publish: an unpublished decision is author-private — it is delivered ONLY
        // to its creator, never to the client or anyone else. Enforced here (server-side),
        // not merely hidden in the UI, so a draft's title can't leak through any surface.
        if (d.publishedAt === null) return !!userId && d.authorId === userId;
        // AUTH-02: only pmc/client see published-but-pending decisions.
        return !(hidePending && d.status === 'pending');
      })
      .map((d) => ({
        id: d.id,
        title: d.title,
        room: d.room,
        nodeId: d.nodeId ?? undefined,
        status: d.status,
        draft: d.publishedAt === null,
        ageDays: d.ageDays ?? undefined,
        photoSwatch: d.photoSwatch,
        approvedOption: d.approvedOption ?? undefined,
        material: d.material ?? undefined,
        approver: d.approver ?? undefined,
        onBehalfOf: d.onBehalfOf ?? undefined,
        date: d.date ?? undefined,
        cost: d.cost ?? undefined,
        // a reopened decision carries its open request so every surface can show
        // WHY it awaits re-approval (reason + impacts) without a second query
        changeRequest: d.status === 'change' && d.changeRequests[0]
          ? { reason: d.changeRequests[0].reason, costImpact: d.changeRequests[0].costImpact, timeImpactDays: d.changeRequests[0].timeImpactDays, requestedById: d.changeRequests[0].requestedById ?? undefined }
          : undefined,
        options: d.options.map((o) => ({
          label: o.label,
          key: o.optionKey,
          material: o.material,
          delta: o.delta,
          swatch: o.swatch,
          photoUrl: o.photoUrl ?? undefined,
          recommended: o.recommended,
        })),
      }));

    return { decisions, statuses };
  }

  /** Does decision `decisionId` exist in project `projectId`? The tenant-ownership check a consumer
   *  runs before storing a reference to it (activities' `assertRefs`, daily-log's material link). */
  async existsInProject(projectId: string, decisionId: string): Promise<boolean> {
    const row = await this.prisma.decision.findFirst({ where: { id: decisionId, projectId }, select: { id: true } });
    return row !== null;
  }

  /**
   * Resolve an OPTIONAL decision reference the same way `resolveProjectRef('decision', …)` did before
   * extraction: null/undefined pass through; a present id must belong to THIS project or the write is
   * rejected with a human-readable error (the composite `(projectId, id)` FK is the DB backstop).
   */
  async resolveRefInProject(projectId: string, id: string | null | undefined, field = 'decisionId'): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }

  /** How many decisions are filed under any of `nodeIds` — the guard a node delete runs before
   *  removing a location subtree. */
  countByNodeIds(nodeIds: string[]): Promise<number> {
    return this.prisma.decision.count({ where: { nodeId: { in: nodeIds } } });
  }

  /** How many of a project's decisions are still pending — the portfolio tile count (the caller gates
   *  this on the viewer's role: only PMC/client may see it). */
  countPending(projectId: string): Promise<number> {
    return this.prisma.decision.count({ where: { projectId, status: 'pending' } });
  }
}
