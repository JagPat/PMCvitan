import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Phase 3 Task 1 — project-scoped capability activation (plan §D).
 *
 * A Phase-3 surface exists for a project ONLY when its `ProjectCapability` row exists. The
 * gate REFUSES with 404 — to a non-pilot project the feature does not exist: no route, no
 * navigation, no event, no behavioral difference from today (the two-projects-one-org
 * inertness proof pins this byte-for-byte). Enabling is an attributable operator/administrator
 * action (`capability:enable` CLI) recorded with identity — never a deploy-wide default.
 */
export const MATERIALS_CAPABILITY = 'materials';
// Phase 4 Task 1 — the labour pilot capability (plan §D). Same mechanism as materials: a
// per-project `ProjectCapability` row (enabled by the SAME `capability:enable` CLI), gating the
// labour surface. A `type='labour'` requirement asserts THIS capability; a non-pilot project is
// byte-for-byte unchanged (no labour route, no labour rows, the Team gate stays the stored stub).
export const LABOUR_CAPABILITY = 'labour';
// Phase 5 Task 1 — the commercial pilot capability (plan §L). Same mechanism again, with ONE
// difference that is the whole point of §L: enabling `commercial` is NOT a no-op on a project
// that already holds live purchase orders. See `CommercialActivationService`.
export const COMMERCIAL_CAPABILITY = 'commercial';
// Phase 6 unit 4c-ii (§D) — the consultation ROLLOUT LATCH. Same per-project row and the same
// `capability:enable` CLI, but this one is NOT a product pilot: consultation is a core decision
// workflow, and the gate exists only so an operator can turn emission on AFTER confirming the
// drain-first cutover is complete. The outbox has ONE ordered delivery per consumer, so an old
// projection or push worker claiming a `decision.consultation_*` event would fold the row through
// its old serializer or fall through to an unguarded send; nothing shipped IN this unit can change
// the behaviour of a process that is already running, so the deploy-then-enable ORDER is the
// protection and this row is its machine-checkable predicate. The write surface, the emitter and
// the client all read it, and it RETIRES in 4c-iv — a latch, not a permanent pilot.
export const CONSULTATION_CAPABILITY = 'consultation';

@Injectable()
export class CapabilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client to read the capability under the caller's lock (Task 6: the
   *  start command evaluates material coverage in-tx and needs the gate on the same client). */
  async isEnabled(projectId: string, capability: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? this.prisma;
    const row = await db.projectCapability.findUnique({
      where: { projectId_capability: { projectId, capability } },
      select: { projectId: true },
    });
    return row !== null;
  }

  /** Route/service gate: behave as if the feature does not exist for a non-pilot project. */
  async assertEnabled(projectId: string, capability: string): Promise<void> {
    if (!(await this.isEnabled(projectId, capability))) throw new NotFoundException('Not found');
  }

  /** Idempotently enable a capability for ONE project, attributably. */
  async enable(projectId: string, capability: string, enabledById: string): Promise<void> {
    await this.prisma.projectCapability.upsert({
      where: { projectId_capability: { projectId, capability } },
      create: { projectId, capability, enabledById },
      update: {},
    });
  }
}
