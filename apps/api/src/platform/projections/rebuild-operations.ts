import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { ProjectionRebuilder } from './rebuilder.service';
import { DECISIONS_PROJECTION, computeDecisionRows, storedDecisionRows } from '../../decisions/decisions.projection';
import { DRAWINGS_PROJECTION } from '../../drawings/drawings.projection';
import { DAILY_LOG_PROJECTION } from '../../daily-log/daily-log.projection';
import { INSPECTIONS_PROJECTION } from '../../inspections/inspections.projection';
import { ACTIVITIES_PROJECTION } from '../../activities/activities.projection';
import { computeDrawingsBase } from '../../drawings/drawings-serialize';
import { computeDailyLogSlice } from '../../daily-log/daily-log-serialize';
import { computeInspectionsBase } from '../../inspections/inspections-serialize';
import { computeActivitiesBase } from '../../activities/activities-serialize';

/**
 * Phase 2 Task 10 finalization — the OPERATOR projection-rebuild operations, extracted from the CLI
 * so the diagnosis + partial-run semantics are directly testable against live PostgreSQL.
 *
 * DIAGNOSIS IS CHECKPOINT-AWARE (finalization hardening). A projection generation whose checkpoint
 * lags the committed stream head is ORDINARY LAG, not corruption: the module read path refuses to
 * serve it ({@link readServableGeneration} semantics) and falls back to the canonical live read, so
 * no user ever observes the lagging rows. Only a generation the read path WOULD serve — cursor
 * healthy AND checkpoint at the stream head — whose stored base differs from the base recomputed
 * from canonical is CORRUPT. To make that distinction race-free under concurrent writes, each
 * diagnosis runs in ONE transaction that first locks the project's `ProjectEventStream` row FOR
 * UPDATE — the same row every event allocation locks — so the stream head cannot advance between
 * the currency check and the canonical recompute: a mismatch inside the frozen window is a real
 * mismatch, never a torn read.
 *
 * PARTIAL RUNS STAY ATTRIBUTABLE. The invocation is audited as an `OutboxOperatorAction`
 * (`projection.rebuild`) BEFORE any work begins, and every (project, consumer) attempt records its
 * own outcome row (`projection.rebuild.result`) — success with the resulting generation + state, or
 * the failure message — so an interrupted or partially-failed run leaves a complete, ordered audit
 * trail of exactly which projections were repaired.
 *
 * THE DEFAULT RUN COVERS ALL FIVE PRODUCTION PROJECTIONS (final-review P1 correction). A production
 * upgrade carries legacy generations for EVERY consumer — most dangerously a `decisions.inbox`
 * generation the pre-#183 per-event consumer left holding a non-empty SUBSET of the canonical
 * register, which the merged read path serves as authoritative until the next decision event. An
 * operator rebuild that only knew two consumers would report `ok: true` while leaving that defect
 * in place, so `run()` with no `--consumer` now rebuilds {@link REBUILDABLE_PROJECTIONS} in full.
 */

/** How a (project, consumer) projection presents to the read path at diagnosis time. */
export type DiagnosisState =
  | 'none' // no active generation — never initialised; reads serve live
  | 'blocked' // cursor dead-lettered on an earlier position — operator attention; reads serve live
  | 'lagging' // checkpoint behind the committed stream head — ordinary lag; reads serve live
  | 'current-match' // servable AND the stored comparable equals the canonical recompute
  | 'corrupt'; // servable BUT the stored comparable differs from canonical — the defect class

export interface ConsumerDiagnosis {
  state: DiagnosisState;
  generation: number | null;
  /** The generation's applied checkpoint and the committed stream head, for the lag states. */
  appliedPosition: string | null;
  streamHead: string | null;
}

export interface RebuildAttempt {
  projectId: string;
  consumer: string;
  before: ConsumerDiagnosis;
  rebuilt: boolean;
  /** present when the rebuild attempt itself threw — the run continues to the next pair */
  error?: string;
  after?: ConsumerDiagnosis;
}

export interface RebuildRunReport {
  ok: boolean;
  action: 'projection.rebuild';
  projects: number;
  consumers: string[];
  /** pairs whose SERVED state contradicted canonical before the rebuild (state 'corrupt') */
  corruptBefore: number;
  /** pairs merely lagging/uninitialised before the rebuild (reads were already falling back to live) */
  laggingBefore: number;
  /** pairs that remained 'corrupt' AFTER their rebuild — must be 0 for ok */
  corruptAfter: number;
  /** pairs whose rebuild attempt threw — must be 0 for ok */
  failures: number;
  results: RebuildAttempt[];
}

interface Rebuildable {
  /** The generation's STORED comparable — the single composite dto (or null), or the complete
   *  normalized row set for a per-entity projection. */
  stored(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<unknown>;
  /** The comparable recomputed from CANONICAL state through the owning module's own serializer. */
  canonical(tx: Prisma.TransactionClient, projectId: string): Promise<unknown>;
}

/**
 * The projections this operator command can rebuild — ALL FIVE production projection consumers,
 * each judged by its module's OWN serializer. The registry is EXPLICIT (no reflection over the
 * consumer registry): adding a projection consumer without teaching the operator command how to
 * diagnose it must be a visible, reviewed change here, never a silent default.
 *
 * Four modules store a per-PROJECT composite row, so their comparable is the single stored dto vs
 * the module's `compute*Base`/slice recompute. `decisions.inbox` stores a per-DECISION row set, so
 * its comparable is the COMPLETE normalized row set (decisionId, status, publishedAt as ISO,
 * authorId, dto — ordered by decisionId) on both sides — a legacy generation holding a non-empty
 * SUBSET of the canonical register (the pre-#183 per-event consumer's upgrade residue) therefore
 * diagnoses as 'corrupt' and is repaired, where an emptiness-only probe would call it healthy.
 * Both decisions readers live in the decisions module (`decisions.projection.ts`), so every read
 * of decision persistence stays inside the owning module.
 */
export const REBUILDABLE_PROJECTIONS: Record<string, Rebuildable> = {
  [DECISIONS_PROJECTION]: {
    stored: (tx, generationId) => storedDecisionRows(tx, generationId),
    canonical: (tx, projectId) => computeDecisionRows(tx, projectId),
  },
  [DAILY_LOG_PROJECTION]: {
    stored: async (tx, generationId, projectId) =>
      (await tx.dailyLogProjection.findUnique({ where: { generationId_projectId: { generationId, projectId } }, select: { dto: true } }))?.dto ?? null,
    canonical: (tx, projectId) => computeDailyLogSlice(tx, projectId),
  },
  [DRAWINGS_PROJECTION]: {
    stored: async (tx, generationId, projectId) =>
      (await tx.drawingsProjection.findUnique({ where: { generationId_projectId: { generationId, projectId } }, select: { dto: true } }))?.dto ?? null,
    canonical: (tx, projectId) => computeDrawingsBase(tx, projectId),
  },
  [INSPECTIONS_PROJECTION]: {
    stored: async (tx, generationId, projectId) =>
      (await tx.inspectionsProjection.findUnique({ where: { generationId_projectId: { generationId, projectId } }, select: { dto: true } }))?.dto ?? null,
    canonical: (tx, projectId) => computeInspectionsBase(tx, projectId),
  },
  [ACTIVITIES_PROJECTION]: {
    stored: async (tx, generationId, projectId) =>
      (await tx.activitiesProjection.findUnique({ where: { generationId_projectId: { generationId, projectId } }, select: { dto: true } }))?.dto ?? null,
    canonical: (tx, projectId) => computeActivitiesBase(tx, projectId),
  },
};

/** Key-order-independent deep equality (the dto round-trips through jsonb, which keeps no order). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export class ProjectionRebuildOperations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rebuilder: ProjectionRebuilder,
  ) {}

  /**
   * Diagnose one (consumer, project) pair, race-free: the whole read runs in one transaction that
   * holds the project's stream-allocation lock, so the head is FROZEN while the stored base is
   * compared against the canonical recompute. Lag is reported as lag — only a generation the read
   * path would actually serve can be 'corrupt'.
   */
  async diagnose(consumer: string, projectId: string): Promise<ConsumerDiagnosis> {
    const spec = REBUILDABLE_PROJECTIONS[consumer];
    if (!spec) throw new Error(`${consumer} is not an operator-rebuildable projection`);
    return this.prisma.$transaction(async (tx) => {
      // Freeze event allocation for this project (emitEvent locks this row FOR UPDATE to assign
      // stream positions). A project with no stream row has no events — nothing can race either.
      await tx.$queryRaw`SELECT "projectId" FROM "ProjectEventStream" WHERE "projectId" = ${projectId} FOR UPDATE`;
      const stream = await tx.projectEventStream.findUnique({ where: { projectId }, select: { nextPosition: true } });
      const head = stream ? stream.nextPosition - 1n : -1n;
      const gen = await tx.projectionGeneration.findFirst({
        where: { consumer, projectId, status: 'active' },
        select: { id: true, generation: true, appliedPosition: true, cursorStatus: true },
      });
      const positions = { appliedPosition: gen?.appliedPosition?.toString() ?? null, streamHead: head >= 0n ? head.toString() : null };
      if (!gen) return { state: 'none' as const, generation: null, ...positions };
      if (gen.cursorStatus !== 'live') return { state: 'blocked' as const, generation: gen.generation, ...positions };
      // Checkpoint-aware currency, aligned with readServableGeneration: an event-less project
      // (head -1) is trivially caught up; a null checkpoint with events pending is lag.
      const applied = gen.appliedPosition ?? -1n;
      if (applied < head) return { state: 'lagging' as const, generation: gen.generation, ...positions };
      const stored = await spec.stored(tx, gen.id, projectId);
      const expected = await spec.canonical(tx, projectId);
      const match = stableJson(stored) === stableJson(expected);
      return { state: match ? ('current-match' as const) : ('corrupt' as const), generation: gen.generation, ...positions };
    });
  }

  /**
   * Rebuild the given consumers for the given projects (all projects when none named), with
   * before/after diagnosis per pair. The invocation is audited BEFORE work begins; every pair
   * records its own success/failure outcome, and one pair's failure never aborts the rest.
   */
  async run(params: {
    operatorIdentity: string;
    reason: string;
    projectId?: string;
    consumers?: string[];
  }): Promise<RebuildRunReport> {
    const consumers = params.consumers ?? Object.keys(REBUILDABLE_PROJECTIONS);
    for (const c of consumers) {
      if (!(c in REBUILDABLE_PROJECTIONS)) {
        throw new Error(`unknown consumer ${c} (rebuildable: ${Object.keys(REBUILDABLE_PROJECTIONS).join(', ')})`);
      }
    }
    const projects = params.projectId
      ? await this.prisma.project.findMany({ where: { id: params.projectId }, select: { id: true } })
      : await this.prisma.project.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    if (params.projectId && projects.length === 0) throw new Error(`unknown project ${params.projectId}`);

    // The invocation record — BEFORE any rebuild work, so an interrupted run is still attributable.
    await this.prisma.outboxOperatorAction.create({
      data: {
        action: 'projection.rebuild',
        consumer: consumers.join(','),
        projectId: params.projectId || null,
        operatorIdentity: params.operatorIdentity,
        reason: params.reason,
      },
    });

    const results: RebuildAttempt[] = [];
    for (const { id: projectId } of projects) {
      for (const consumer of consumers) {
        const attempt: RebuildAttempt = { projectId, consumer, before: await this.diagnose(consumer, projectId), rebuilt: false };
        try {
          await this.rebuilder.rebuild(consumer, projectId);
          attempt.rebuilt = true;
          attempt.after = await this.diagnose(consumer, projectId);
        } catch (e) {
          attempt.error = (e as Error).message;
        }
        results.push(attempt);
        // The per-pair outcome record — partial runs stay attributable pair by pair.
        await this.prisma.outboxOperatorAction.create({
          data: {
            action: 'projection.rebuild.result',
            consumer,
            projectId,
            operatorIdentity: params.operatorIdentity,
            reason: attempt.rebuilt
              ? `ok: generation ${attempt.after?.generation ?? '?'} ${attempt.after?.state ?? ''} (before: ${attempt.before.state})`
              : `failed (before: ${attempt.before.state})`,
            priorError: attempt.error ?? null,
          },
        });
      }
    }

    const corruptAfter = results.filter((r) => r.after?.state === 'corrupt').length;
    const failures = results.filter((r) => r.error !== undefined).length;
    return {
      ok: corruptAfter === 0 && failures === 0,
      action: 'projection.rebuild',
      projects: projects.length,
      consumers,
      corruptBefore: results.filter((r) => r.before.state === 'corrupt').length,
      laggingBefore: results.filter((r) => r.before.state === 'lagging' || r.before.state === 'none').length,
      corruptAfter,
      failures,
      results,
    };
  }
}
