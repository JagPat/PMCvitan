import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { DecisionStatus } from '../domain/transitions';
import type { Role } from '../common/auth';
import type { DecisionDto } from '../snapshot/types';
import { serializeDecision, decisionVisibleToViewer } from './decision-serialize';
import { DECISIONS_PROJECTION } from './decisions.projection';
import { readServableGeneration } from '../platform/projections/generation';

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
   * Phase 2 Task 10 — the UNFILTERED `id → status` map alone (no DTO serialization). The activities
   * module bakes each activity's readiness from this at read time (readiness must see the true decision
   * status regardless of a role's visibility); the snapshot instead passes the `statuses` it already got
   * from {@link snapshotSlice} so it never reads twice.
   */
  async statusMap(projectId: string): Promise<Map<string, DecisionStatus>> {
    const rows = await this.prisma.decision.findMany({ where: { projectId }, select: { id: true, status: true } });
    return new Map(rows.map((d) => [d.id, d.status as DecisionStatus]));
  }

  /**
   * Phase 2 Task 9 — the decisions slice served from the REBUILDABLE PROJECTION (`decisions.inbox`)
   * instead of the live join. Reads the project's ACTIVE generation's `DecisionProjection` rows (the
   * pre-serialized `DecisionDto`s the projection consumer refreshed from canonical) and applies the
   * SAME per-viewer authz filter as {@link snapshotSlice} (via `decisionVisibleToViewer`) — so a
   * projection read is never an RBAC bypass, and the result is byte-identical to the live slice.
   *
   * `generation` is the served generation number — null when there is no generation SAFE to serve.
   * Task 10 finalization: this read now applies the same {@link readServableGeneration} currency
   * discipline as every other module (daily-log/drawings/inspections/activities) — a generation that
   * is blocked, merely bootstrapped, or whose checkpoint lags the committed stream head returns
   * `generation: null`, so the caller falls back to the always-current live slice instead of serving
   * a stale-but-active generation as authoritative.
   */
  async projectionSlice(
    projectId: string,
    role: Role,
    userId?: string,
  ): Promise<{ decisions: DecisionDto[]; statuses: Map<string, DecisionStatus>; generation: number | null }> {
    const gen = await readServableGeneration(this.prisma, DECISIONS_PROJECTION, projectId);
    if (!gen) return { decisions: [], statuses: new Map(), generation: null };

    const rows = await this.prisma.decisionProjection.findMany({
      where: { generationId: gen.id },
      // the snapshot slice orders decisions by id descending — mirror it so the served array matches
      orderBy: { decisionId: 'desc' },
    });
    // The per-decision-row analogue of the composite modules' row-exists check: a generation that
    // only NOOP deliveries advanced (bootstrapped over pre-stream rows, no decision event applied
    // yet) is caught-up but HOLLOW — zero rows while canonical decisions exist. Serving it would
    // hide the whole register; fall back to live instead. A genuinely decision-less project serves
    // projection-empty (the cheap existence probe confirms it).
    if (rows.length === 0) {
      const any = await this.prisma.decision.findFirst({ where: { projectId }, select: { id: true } });
      if (any) return { decisions: [], statuses: new Map(), generation: null };
    }
    // the readiness map is UNFILTERED (every decision's true status), exactly like snapshotSlice
    const statuses = new Map<string, DecisionStatus>(rows.map((r) => [r.decisionId, r.status as DecisionStatus]));
    const decisions = rows
      .filter((r) => decisionVisibleToViewer({ publishedAt: r.publishedAt, authorId: r.authorId, status: r.status }, role, userId))
      .map((r) => r.dto as unknown as DecisionDto);
    return { decisions, statuses, generation: gen.generation };
  }

  /**
   * Phase 2 Task 9 — the MODULE-OWNED decision read the frontend calls (the `GET …/decisions`
   * endpoint). Serves from the rebuildable projection when it has an active generation; otherwise
   * falls back to the live slice (a project whose decision events the relay has not applied yet, or a
   * legacy project never rebuilt) — additive and correct, never empty during warm-up. `source` tells
   * the client which path served it (observability; the DTOs are byte-identical either way).
   */
  async moduleDecisions(
    projectId: string,
    role: Role,
    userId?: string,
  ): Promise<{ decisions: DecisionDto[]; source: 'projection' | 'live'; generation: number | null }> {
    const proj = await this.projectionSlice(projectId, role, userId);
    if (proj.generation !== null) return { decisions: proj.decisions, source: 'projection', generation: proj.generation };
    const live = await this.snapshotSlice(projectId, role, userId);
    return { decisions: live.decisions, source: 'live', generation: null };
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
   *  this on the viewer's role: only PMC/client may see it). Task 10 finalization: a DRAFT
   *  (`publishedAt` null) is weightless — it is not awaiting the client, and counting it here leaked
   *  an author-private draft into every PMC/client member's portfolio rollup while the shell,
   *  dashboard and inbox surfaces all excluded it (cross-surface disagreement + a privacy leak). */
  countPending(projectId: string): Promise<number> {
    return this.prisma.decision.count({ where: { projectId, status: 'pending', publishedAt: { not: null } } });
  }
  /**
   * Phase 3 Task 1 correction (review finding 1) — the AUTHORITATIVE, immutable decision
   * approval reference a material requirement pins as provenance. SERVER-resolved, never
   * caller-authored:
   *   • the decision must be PUBLISHED and status `approved` (a pending, draft or reopened
   *     `change` decision cannot anchor procurement provenance — refused with a readable 400);
   *   • `decisionVersion` is the count of `approved`/`reapproved` events in the decision's
   *     append-only event log (min 1 for a legacy approved row imported without events) — the
   *     real re-approval counter, not a caller claim;
   *   • `optionKey` is the SELECTED option's key, resolved from the decision's own options via
   *     the recorded `approvedOption` label (falling back to the recorded label itself for
   *     legacy rows whose option list no longer carries it). An approved decision with NO
   *     recorded selection cannot anchor provenance and refuses.
   * Runs on the caller's transaction client when provided (same-tx validation, spec §6).
   */
  async approvedRef(
    projectId: string,
    decisionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ decisionId: string; decisionVersion: number; optionKey: string }> {
    const client = tx ?? this.prisma;
    const d = await client.decision.findFirst({
      where: { id: decisionId, projectId },
      include: { options: { orderBy: { order: 'asc' } }, events: { where: { type: { in: ['approved', 'reapproved'] } }, select: { id: true } } },
    });
    if (!d) throw new BadRequestException('decisionId does not belong to this project');
    if (d.publishedAt === null) throw new BadRequestException('A draft decision cannot anchor requirement provenance');
    if (d.status !== 'approved') {
      throw new BadRequestException(`Only an approved decision can anchor requirement provenance (status is '${d.status}')`);
    }
    if (!d.approvedOption) throw new BadRequestException('The approved decision records no selected option');
    const selected = d.options.find((o) => o.label === d.approvedOption);
    return {
      decisionId: d.id,
      decisionVersion: Math.max(1, d.events.length),
      optionKey: selected ? selected.optionKey : d.approvedOption,
    };
  }

}
