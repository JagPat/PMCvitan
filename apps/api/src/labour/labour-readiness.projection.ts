import { Prisma } from '@prisma/client';
import type { LabourActivityForecastDto, LabourForecastVerdict, LabourReadinessDto, RequirementEventPayload } from '@vitan/shared';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import type { LabourCoverageService } from './labour-coverage.service';
import type { LabourCoverageRequirement, RequirementLabourForecast } from './coverage';

/**
 * Phase 4 Task 4 — the SEVENTH rebuildable projection: per-project labour-readiness FORECAST
 * (`labour.readiness`, plan §A/§G).
 *
 * RECOMPUTE-ONLY. On each canonical event that can move labour forecast coverage
 * (`requirement.*`, `skill_substitution.*`, `capacity.*`, `allocation.*`, `labour_work.recorded`),
 * this ordered `db` consumer RE-DERIVES every labour-requirement-bearing activity's forecast
 * verdict from CANONICAL facts and stores it in the project's generation-scoped row. Storing a
 * derived verdict produces NO domain event and NO notification (a rebuild replay therefore emits
 * neither — §G).
 *
 * THE LABOUR-OWNED REQUIREMENT READ-MODEL (§G, round 3). Labour is a LEAF: it must never read
 * `ActivityRequirement`/`ActivityRequirementRoot` (Activities-owned, read-encapsulated). Its
 * requirement truth is instead FOLDED from the consumed Activities-owned `requirement.*` event
 * PAYLOADS — each carries the discriminated `type`, the head `revision`, `status`, `activityId`
 * and the complete `labourSpecRef` (fingerprint + demand slices), so the fold is self-sufficient.
 * The fold reads the platform `DomainEvent` envelope (platform infrastructure, exactly like every
 * projection's `rebuildSeed`), NOT a foreign module's persistence. The latest event per
 * requirement (stream order) is its head; only OPEN labour heads produce coverage inputs.
 *
 * The projection feeds UI/Inbox/Dashboard/forecast ONLY. Command authority never reads it: a
 * lagging projection can never change a start verdict, because start evaluates EXECUTION
 * coverage in its own transaction under the readiness lock, from requirement snapshots
 * Activities itself passes in.
 */

export const LABOUR_READINESS_PROJECTION = 'labour.readiness';

const REQUIREMENT_EVENTS = ['requirement.created', 'requirement.revised', 'requirement.cancelled'] as const;

let boundDeps: { coverage: LabourCoverageService } | null = null;

/** Boot binds the labour coverage service the recompute routes through (idempotent). */
export function bindLabourReadinessDeps(deps: { coverage: LabourCoverageService }): void {
  boundDeps = deps;
}
function deps(): { coverage: LabourCoverageService } {
  if (!boundDeps) throw new Error('labour-readiness projection deps not bound — call bindLabourReadinessDeps at boot');
  return boundDeps;
}

/**
 * Fold the project's `requirement.*` event payloads into the labour-owned requirement
 * read-model: the latest event per requirement is its head. Payload-sourced by construction —
 * never an Activities persistence read.
 */
export async function foldLabourRequirementHeads(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<Map<string, RequirementEventPayload>> {
  const events = await tx.domainEvent.findMany({
    where: { projectId, eventType: { in: [...REQUIREMENT_EVENTS] } },
    orderBy: { streamPosition: 'asc' },
    select: { payload: true },
  });
  const heads = new Map<string, RequirementEventPayload>();
  for (const e of events) {
    const p = e.payload as unknown as RequirementEventPayload;
    if (!p || typeof p.requirementId !== 'string') continue;
    heads.set(p.requirementId, p);
  }
  return heads;
}

/** Open labour heads from the read-model, widened by ACTIVE substitutions (own-module read;
 *  the T6-F2 rule: an edge applies only while its `fromFingerprint` equals the head fingerprint). */
async function loadLabourForecastRequirements(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<LabourCoverageRequirement[]> {
  const heads = await foldLabourRequirementHeads(tx, projectId);
  const open = [...heads.values()].filter((p) => p.type === 'labour' && p.status === 'open' && p.labourSpecRef);
  if (open.length === 0) return [];
  const subs = await tx.approvedSkillSubstitution.findMany({
    where: { projectId, requirementId: { in: open.map((p) => p.requirementId) }, revokedAt: null },
    select: { requirementId: true, fromFingerprint: true, toFingerprint: true },
  });
  const targets = new Map<string, Array<{ fromFingerprint: string; toFingerprint: string }>>();
  for (const s of subs) {
    const bucket = targets.get(s.requirementId);
    if (bucket) bucket.push(s);
    else targets.set(s.requirementId, [s]);
  }
  return open.map((p) => {
    const spec = p.labourSpecRef!;
    const own = spec.labourSpecFingerprint;
    const substituteTargets = (targets.get(p.requirementId) ?? [])
      .filter((t) => t.fromFingerprint === own)
      .map((t) => t.toFingerprint);
    return {
      requirementId: p.requirementId,
      revision: p.revision,
      activityId: p.activityId,
      shift: spec.shift,
      acceptableFingerprints: [own, ...substituteTargets],
      slices: spec.demandSlices.map((s) => ({ civilDate: s.civilDate, personShiftQty: s.personShiftQty })),
    };
  });
}

const FORECAST_SEVERITY: Record<LabourForecastVerdict, number> = { blocked: 3, 'at-risk': 2, ready: 1 };

/**
 * The CANONICAL per-project labour forecast dto (§A), recomputed on the given transaction. The
 * single source shared by the consumer refresh, the `labour.readiness` read and the operator
 * rebuild diagnostic — so live == projection == rebuild by construction. Per activity the
 * per-requirement forecast verdicts aggregate WORST-WINS; only activities WITH an open labour
 * requirement appear, activityId-sorted.
 */
export async function computeLabourReadinessDto(tx: Prisma.TransactionClient, projectId: string): Promise<LabourReadinessDto> {
  const requirements = await loadLabourForecastRequirements(tx, projectId);
  const rows = await deps().coverage.forecastFor(tx, projectId, requirements);
  const byActivity = new Map<string, RequirementLabourForecast[]>();
  for (const r of rows) {
    const list = byActivity.get(r.activityId) ?? [];
    list.push(r);
    byActivity.set(r.activityId, list);
  }
  const forecast: Record<string, LabourActivityForecastDto> = {};
  for (const id of [...byActivity.keys()].sort()) {
    const list = byActivity.get(id)!;
    let worst = list[0];
    for (const r of list) {
      if (FORECAST_SEVERITY[r.verdict] > FORECAST_SEVERITY[worst.verdict]) worst = r;
    }
    // When the activity is at-risk overall, its covering date is the LATEST covering promise
    // across its at-risk requirements (the whole crew is only covered once the last arrives).
    let coveringDate: string | null = null;
    if (worst.verdict === 'at-risk') {
      for (const r of list) {
        if (r.verdict === 'at-risk' && r.coveringDate && (coveringDate === null || r.coveringDate > coveringDate)) {
          coveringDate = r.coveringDate;
        }
      }
    }
    forecast[id] = { verdict: worst.verdict, reason: worst.reason, coveringDate };
  }
  return { forecast };
}

const READINESS_EVENTS = new Set([
  'requirement.created', 'requirement.revised', 'requirement.cancelled',
  'skill_substitution.approved', 'skill_substitution.revoked',
  'capacity.committed', 'capacity.revised', 'capacity.defaulted',
  'allocation.made', 'allocation.released',
  'labour_work.recorded',
]);

/** Any forecast-affecting canonical event refreshes the whole project row; everything else is a
 *  no-op that still advances the ordered cursor contiguously. Attendance events are deliberately
 *  absent: the §A forecast and execution tables differ ONLY in whether presence is required, and
 *  the forecast never consults presence. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return READINESS_EVENTS.has(meta.eventType) ? { action: 'dispatch' } : { action: 'noop' };
}

async function refreshRow(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<void> {
  const dto = (await computeLabourReadinessDto(tx, projectId)) as unknown as Prisma.InputJsonValue;
  await tx.labourReadinessProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/** Build the `labour.readiness` projection consumer. */
export function makeLabourReadinessProjectionConsumer(): OutboxConsumer {
  return {
    name: LABOUR_READINESS_PROJECTION,
    kind: 'ordered',
    effect: 'db',
    catalogVersion: 1,
    deliveryFor,
    projection: {
      rebuildSeed: async (tx, target) => {
        const max = await tx.domainEvent.aggregate({ where: { projectId: target.projectId }, _max: { streamPosition: true } });
        const seededThrough = max._max.streamPosition ?? null;
        await refreshRow(tx, target.generationId, target.projectId);
        return seededThrough;
      },
      dropGeneration: async (tx, target) => {
        await tx.labourReadinessProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('labour-readiness projection needs a transaction');
      if (!ctx.projection) throw new Error('labour-readiness projection needs a target generation');
      await refreshRow(ctx.tx, ctx.projection.generationId, ctx.meta.projectId);
    },
  };
}
