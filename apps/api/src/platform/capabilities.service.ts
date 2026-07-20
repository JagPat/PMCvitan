import { Injectable, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class CapabilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(projectId: string, capability: string): Promise<boolean> {
    const row = await this.prisma.projectCapability.findUnique({
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
