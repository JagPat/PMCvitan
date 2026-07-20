import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProjectVendorDto, VendorDto } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { recordAudit } from '../platform/audit';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { CreateVendorInput, BindVendorInput } from '../contracts';
import type { Vendor, ProjectVendor } from '@prisma/client';

/**
 * Phase 3 Task 2 — vendors (§H). `Vendor` is the ORG-scoped durable party record; creating or
 * listing vendors is ORG-ADMIN authority (org membership owner/admin — a project role grants
 * nothing here, and org-admin authority grants no project-level procurement access: the
 * separation the §H probe demands). Project reach is ONLY the additive `ProjectVendor`
 * binding — a pmc project command, capability-gated (§D), whose composite FKs make a
 * cross-org binding unrepresentable.
 */

function serializeVendor(v: Vendor): VendorDto {
  return {
    id: v.id, orgId: v.orgId, name: v.name, contact: v.contact, gstin: v.gstin,
    createdAt: v.createdAt.toISOString(), createdById: v.createdById,
  };
}

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
  ) {}

  /** Org-admin authority: an ACTIVE org membership with role owner|admin. */
  private async assertOrgAdmin(orgId: string, userId: string): Promise<void> {
    const m = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw new ForbiddenException('Only an org owner or admin can manage the vendor registry');
    }
  }

  async create(orgId: string, input: CreateVendorInput, user: AuthUser, idempotencyKey?: string): Promise<VendorDto> {
    await this.assertOrgAdmin(orgId, user.sub);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'org', organizationId: orgId };
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'vendors.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        const created = await tx.vendor.create({
          data: { orgId, name: input.name, contact: input.contact ?? null, gstin: input.gstin ?? null, createdById: actor.actorId },
        });
        return { resultRef: created.id, events: [] };
      },
    });
    const row = await this.prisma.vendor.findFirstOrThrow({ where: { orgId, id: outcome.resultRef } });
    return serializeVendor(row);
  }

  async listForOrg(orgId: string, user: AuthUser): Promise<{ vendors: VendorDto[] }> {
    await this.assertOrgAdmin(orgId, user.sub);
    const rows = await this.prisma.vendor.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    return { vendors: rows.map(serializeVendor) };
  }

  /** Bind an org vendor into THIS project (§H) — pmc authority, capability-gated. */
  async bind(projectId: string, input: BindVendorInput, user: AuthUser, idempotencyKey?: string): Promise<ProjectVendorDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
    // the vendor must belong to the PROJECT'S org — validated here, unrepresentable at the DB
    const vendor = await this.prisma.vendor.findFirst({ where: { id: input.vendorId, orgId: project.orgId } });
    if (!vendor) throw new BadRequestException('vendorId does not name a vendor of this project’s org');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'vendors.bind', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        const existing = await tx.projectVendor.findUnique({ where: { projectId_vendorId: { projectId, vendorId: vendor.id } } });
        if (existing) throw new BadRequestException('Vendor is already bound to this project');
        const created = await tx.projectVendor.create({
          data: { projectId, orgId: project.orgId, vendorId: vendor.id, boundById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'vendor.bind', entity: 'ProjectVendor', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    const row = await this.prisma.projectVendor.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: { vendor: true } });
    return this.serializeBinding(row);
  }

  private serializeBinding(b: ProjectVendor & { vendor: Vendor }): ProjectVendorDto {
    return {
      id: b.id, projectId: b.projectId, vendorId: b.vendorId, name: b.vendor.name,
      boundAt: b.boundAt.toISOString(), boundById: b.boundById,
    };
  }

  async listForProject(projectId: string, _user: AuthUser): Promise<{ vendors: ProjectVendorDto[] }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const rows = await this.prisma.projectVendor.findMany({ where: { projectId }, include: { vendor: true }, orderBy: { boundAt: 'asc' } });
    return { vendors: rows.map((b) => this.serializeBinding(b)) };
  }
}
