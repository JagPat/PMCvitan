import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
/**
 * Phase 6 unit 6.1b (§A) — RESERVED, not yet a capability.
 *
 * The boundary plan gates the collaborator resolver behind this flag, and that resolver does not
 * exist yet. A flag that can be switched on before the thing it governs means nothing when it is
 * on, so the name is reserved in the unit that creates the identity it will later govern; 6.2
 * lifts the reservation in the same migration that installs the resolver.
 *
 * The refusal below is the FRIENDLY error. The seal is the
 * `ProjectCapability_collaboration_reserved` CHECK, because a service check is scoped to the
 * caller — the operator CLI, a repair script and a raw insert all walk past it — and scoping a
 * check to the caller rather than to the data it protects is Root A of the 6.1a audit.
 */
export const COLLABORATION_CAPABILITY = 'collaboration';

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
    if (capability === COLLABORATION_CAPABILITY) {
      throw new BadRequestException(
        'The `collaboration` capability name is reserved: the collaborator resolver it gates does '
          + 'not exist yet, so enabling it would record a flag with no behaviour. It becomes '
          + 'enableable in the unit that installs the resolver.',
      );
    }
    await this.prisma.projectCapability.upsert({
      where: { projectId_capability: { projectId, capability } },
      create: { projectId, capability, enabledById },
      update: {},
    });
  }
}
