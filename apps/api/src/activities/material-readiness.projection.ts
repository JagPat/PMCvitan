import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import type { InventoryService } from '../inventory/inventory.service';
import type { SubstitutionsService } from './substitutions.service';
import type { RequirementCoverage } from '../inventory/coverage';
import { loadCoverageRequirements } from './coverage-requirements';
import { deriveMaterialReading } from './material-readiness';

/**
 * Phase 3 Task 6 — the SIXTH rebuildable projection: per-project UI material readiness
 * (`activities.material-readiness`, plan §A/§G).
 *
 * RECOMPUTE-ONLY. On each canonical event that can move material coverage
 * (`requirement.*`, `substitution.*`, `po.*`, `delivery.*`, `stock.transacted`,
 * `issue.recorded`, `mismatch.resolved`, and the activity-owned mismatch signals), this ordered
 * `db` consumer RE-DERIVES every requirement-bearing activity's material verdict from CANONICAL
 * facts (inventory `coverageFor` + the §A truth — the SAME authority `activities.start` reads)
 * and stores it in the project's generation-scoped row. Storing a derived verdict produces NO
 * domain event and NO notification (a rebuild replay therefore emits neither — §G).
 *
 * The projection feeds UI/Inbox/Dashboard/forecast ONLY. Command authority never reads it: a
 * lagging projection can never change a start verdict, because start evaluates coverage in its
 * own transaction under the readiness lock.
 *
 * DEPENDENCY BINDING. The verdict recompute needs inventory (`coverageFor`) and the substitution
 * targets — both cross-module reads that MUST route through their owning services (never a
 * direct foreign-table read). Boot binds those service instances here once, so both the consumer
 * and the operator rebuild diagnostic share the one canonical computation.
 */

export const MATERIAL_READINESS_PROJECTION = 'activities.material-readiness';

export interface MaterialReadingsDto {
  /** activityId → the §A material gate, activityId-sorted; only activities WITH a material requirement */
  readings: Record<string, { v: string; reason: string }>;
}

let boundDeps: { inventory: InventoryService; substitutions: SubstitutionsService } | null = null;

/** Boot binds the cross-module services the recompute routes through (idempotent). */
export function bindMaterialReadinessDeps(deps: { inventory: InventoryService; substitutions: SubstitutionsService }): void {
  boundDeps = deps;
}
function deps(): { inventory: InventoryService; substitutions: SubstitutionsService } {
  if (!boundDeps) throw new Error('material-readiness projection deps not bound — call bindMaterialReadinessDeps at boot');
  return boundDeps;
}

/**
 * The CANONICAL per-project material-readiness dto (§A), recomputed on the given transaction. The
 * single source shared by the consumer refresh and the operator rebuild diagnostic — so
 * live == projection == rebuild by construction.
 */
export async function computeMaterialReadingsDto(tx: Prisma.TransactionClient, projectId: string): Promise<MaterialReadingsDto> {
  const { inventory, substitutions } = deps();
  const requirements = await loadCoverageRequirements(tx, projectId, substitutions);
  const coverage = await inventory.coverageFor(tx, projectId, requirements);
  const byActivity = new Map<string, RequirementCoverage[]>();
  for (const c of coverage) {
    const list = byActivity.get(c.activityId) ?? [];
    list.push(c);
    byActivity.set(c.activityId, list);
  }
  const ids = [...byActivity.keys()].sort();
  const acts = ids.length
    ? await tx.activity.findMany({ where: { projectId, id: { in: ids } }, select: { id: true, gateMaterial: true } })
    : [];
  const gate = new Map(acts.map((a) => [a.id, a.gateMaterial]));
  const readings: MaterialReadingsDto['readings'] = {};
  for (const id of ids) {
    const reading = deriveMaterialReading(byActivity.get(id)!, gate.get(id) === 'fail');
    readings[id] = { v: reading.v, reason: reading.reason };
  }
  return { readings };
}

const READINESS_EVENTS = new Set([
  'requirement.created', 'requirement.revised', 'requirement.cancelled',
  'substitution.approved', 'substitution.revoked',
  'po.issued', 'po.amended', 'po.cancelled',
  'delivery.committed', 'delivery.revised', 'delivery.defaulted',
  'stock.transacted', 'issue.recorded', 'mismatch.resolved',
  'activity.material_blocked', 'activity.material_unblocked',
]);

/** Any coverage-affecting canonical event refreshes the whole project row; everything else is a
 *  no-op that still advances the ordered cursor contiguously. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return READINESS_EVENTS.has(meta.eventType) ? { action: 'dispatch' } : { action: 'noop' };
}

async function refreshRow(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<void> {
  const dto = (await computeMaterialReadingsDto(tx, projectId)) as unknown as Prisma.InputJsonValue;
  await tx.materialReadinessProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/** Build the `activities.material-readiness` projection consumer. */
export function makeMaterialReadinessProjectionConsumer(): OutboxConsumer {
  return {
    name: MATERIAL_READINESS_PROJECTION,
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
        await tx.materialReadinessProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('material-readiness projection needs a transaction');
      if (!ctx.projection) throw new Error('material-readiness projection needs a target generation');
      await refreshRow(ctx.tx, ctx.projection.generationId, ctx.meta.projectId);
    },
  };
}
