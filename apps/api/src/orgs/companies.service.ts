import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import type { AddCompanyInput, UpdateCompanyInput } from '../contracts';

export interface CompanyDto {
  id: string;
  name: string;
  kind: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
}

/**
 * Companies & consultants attached to a project — the client firm, main contractor,
 * structural/MEP consultants, etc. A company is an organisation + contact, distinct from
 * a Membership (a person with a login role). Same authority as team management: the
 * project's PMC, or an owner/admin of the owning org.
 */
@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  private async canManage(projectId: string, user: AuthUser): Promise<boolean> {
    if (user.role === 'pmc') return true; // token is already scoped to this project
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.orgId) return false;
    const om = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: project.orgId, userId: user.sub } } });
    return om?.role === 'owner' || om?.role === 'admin';
  }

  private async assertCanManage(projectId: string, user: AuthUser): Promise<void> {
    if (!(await this.canManage(projectId, user))) {
      throw new ForbiddenException('Only the project PMC or an org admin can manage companies');
    }
  }

  private toDto(c: {
    id: string;
    name: string;
    kind: string;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
  }): CompanyDto {
    return { id: c.id, name: c.name, kind: c.kind, contactName: c.contactName, contactEmail: c.contactEmail, contactPhone: c.contactPhone, notes: c.notes };
  }

  async list(projectId: string): Promise<CompanyDto[]> {
    const rows = await this.prisma.projectCompany.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
    return rows.map((c) => this.toDto(c));
  }

  async add(projectId: string, requester: AuthUser, input: AddCompanyInput): Promise<CompanyDto> {
    await this.assertCanManage(projectId, requester);
    const created = await this.prisma.projectCompany.create({
      data: {
        projectId,
        name: input.name,
        kind: input.kind,
        contactName: input.contactName || null,
        contactEmail: input.contactEmail || null,
        contactPhone: input.contactPhone || null,
        notes: input.notes || null,
      },
    });
    return this.toDto(created);
  }

  async update(projectId: string, requester: AuthUser, companyId: string, input: UpdateCompanyInput): Promise<CompanyDto> {
    await this.assertCanManage(projectId, requester);
    const existing = await this.prisma.projectCompany.findUnique({ where: { id: companyId } });
    if (!existing || existing.projectId !== projectId) throw new NotFoundException('Company not found on this project');
    // Only overwrite provided keys; empty-string contact fields clear to null.
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.contactName !== undefined) data.contactName = input.contactName || null;
    if (input.contactEmail !== undefined) data.contactEmail = input.contactEmail || null;
    if (input.contactPhone !== undefined) data.contactPhone = input.contactPhone || null;
    if (input.notes !== undefined) data.notes = input.notes || null;
    const updated = await this.prisma.projectCompany.update({ where: { id: companyId }, data });
    return this.toDto(updated);
  }

  async remove(projectId: string, requester: AuthUser, companyId: string): Promise<{ ok: boolean }> {
    await this.assertCanManage(projectId, requester);
    const existing = await this.prisma.projectCompany.findUnique({ where: { id: companyId } });
    if (!existing || existing.projectId !== projectId) throw new NotFoundException('Company not found on this project');
    await this.prisma.projectCompany.delete({ where: { id: companyId } });
    return { ok: true };
  }
}
