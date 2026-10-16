import type { PrismaClient } from '@prisma/client';
import { recordAudit } from './audit';
import { assertServerGenerationAdmitted } from './server-generation';
import { systemActor } from '../common/actor';
import { SWITCHABLE_CAPABILITIES } from './capabilities.service';

export interface CapabilitySwitchInput {
  projectId: string;
  capability: string;
  operator: string;
  reason: string;
}

/**
 * Stage 1 redesign (#482) — turn a presentation-only capability OFF for one project, attributably.
 *
 * The mirror of `enableCapability` below: the same server-generation fence, the same
 * existence check, and an audit row on the project's trail, here carrying the operator's reason. Only
 * `SWITCHABLE_CAPABILITIES` are accepted, so a pilot hub with live records can never be switched off
 * from under them. Idempotent: disabling a capability that is already off writes nothing and reports
 * `changed: false`, so a retried command leaves one audit row, not two.
 */
export async function disableCapability(prisma: PrismaClient, input: CapabilitySwitchInput): Promise<{ changed: boolean }> {
  if (!SWITCHABLE_CAPABILITIES.includes(input.capability)) {
    throw new Error(`\`${input.capability}\` cannot be disabled: only ${SWITCHABLE_CAPABILITIES.join(', ')} can`);
  }
  if (!input.operator.trim() || !input.reason.trim()) throw new Error('an operator and a reason are required');
  return prisma.$transaction(async (tx) => {
    await assertServerGenerationAdmitted(tx);
    await tx.project.findUniqueOrThrow({ where: { id: input.projectId }, select: { id: true } });
    const removed = await tx.projectCapability.deleteMany({ where: { projectId: input.projectId, capability: input.capability } });
    if (removed.count === 0) return { changed: false };
    await recordAudit(tx, {
      projectId: input.projectId,
      actor: systemActor(input.operator, input.operator, 'operator'),
      action: 'capability.disable',
      entity: 'ProjectCapability',
      entityId: `${input.projectId}:${input.capability}`,
      payload: { reason: input.reason },
    });
    return { changed: true };
  });
}

/**
 * Stage 1 redesign (#482) — the `capability:enable` CLI's generic arm (every capability except
 * `commercial`, which has its own activation plan): turn a capability ON for one project, behind the
 * server-generation fence and the existence check, with an audit row carrying the operator's reason,
 * so the trail records who turned a switch on and why, as it does for off. Idempotent: enabling a
 * capability that is already on writes nothing and reports `changed: false`.
 */
export async function enableCapability(prisma: PrismaClient, input: CapabilitySwitchInput): Promise<{ changed: boolean }> {
  if (!input.operator.trim() || !input.reason.trim()) throw new Error('an operator and a reason are required');
  return prisma.$transaction(async (tx) => {
    await assertServerGenerationAdmitted(tx);
    await tx.project.findUniqueOrThrow({ where: { id: input.projectId }, select: { id: true } });
    const added = await tx.projectCapability.createMany({
      data: [{ projectId: input.projectId, capability: input.capability, enabledById: input.operator }],
      skipDuplicates: true,
    });
    if (added.count === 0) return { changed: false };
    await recordAudit(tx, {
      projectId: input.projectId,
      actor: systemActor(input.operator, input.operator, 'operator'),
      action: 'capability.enable',
      entity: 'ProjectCapability',
      entityId: `${input.projectId}:${input.capability}`,
      payload: { reason: input.reason },
    });
    return { changed: true };
  });
}
