import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { DecisionStatus } from '../domain/transitions';
import type { Role } from '../common/auth';
import type { DecisionDto } from '../snapshot/types';
import { serializeDecision, decisionVisibleToViewer } from './decision-serialize';
import { DECISIONS_PROJECTION } from './decisions.projection';

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

    // The serialization + the per-viewer filter are the SAME functions the decisions projection uses
    // (decision-serialize.ts), so the projection-served slice is byte-identical to this live slice.
    const decisions: DecisionDto[] = rows
      .filter((d) => decisionVisibleToViewer(d, role, userId))
      .map(serializeDecision);

    return { decisions, statuses };
  }

  /**
   * Phase 2 Task 9 — the decisions slice served from the REBUILDABLE PROJECTION (`decisions.inbox`)
   * instead of the live join. Reads the project's ACTIVE generation's `DecisionProjection` rows (the
   * pre-serialized `DecisionDto`s the projection consumer refreshed from canonical) and applies the
   * SAME per-viewer authz filter as {@link snapshotSlice} (via `decisionVisibleToViewer`) — so a
   * projection read is never an RBAC bypass, and the result is byte-identical to the live slice.
   *
   * `generation` is the served generation number (null when the projection has no active generation
   * yet — a project whose decision events the relay has not applied, or which has never been rebuilt);
   * the caller decides whether to fall back to the live slice while the projection warms up.
   */
  async projectionSlice(
    projectId: string,
    role: Role,
    userId?: string,
  ): Promise<{ decisions: DecisionDto[]; statuses: Map<string, DecisionStatus>; generation: number | null }> {
    const gen = await this.prisma.projectionGeneration.findFirst({
      where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' },
      select: { id: true, generation: true },
    });
    if (!gen) return { decisions: [], statuses: new Map(), generation: null };

    const rows = await this.prisma.decisionProjection.findMany({
      where: { generationId: gen.id },
      // the snapshot slice orders decisions by id descending — mirror it so the served array matches
      orderBy: { decisionId: 'desc' },
    });
    // the readiness map is UNFILTERED (every decision's true status), exactly like snapshotSlice
    const statuses = new Map<string, DecisionStatus>(rows.map((r) => [r.decisionId, r.status as DecisionStatus]));
    const decisions = rows
      .filter((r) => decisionVisibleToViewer({ publishedAt: r.publishedAt, authorId: r.authorId, status: r.status }, role, userId))
      .map((r) => r.dto as unknown as DecisionDto);
    return { decisions, statuses, generation: gen.generation };
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
