import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { OrgsParticipant } from './orgs.participant';
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
  constructor(private readonly prisma: PrismaService, private readonly party: OrgsParticipant) {}

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
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
    // Phase 6 unit 6.1a (§A) — a directory entry is now also a SOURCE that justifies a party's
    // association with this project, so the party, the row and the association commit together.
    // A company without a canonical identity is not a representable state.
    const created = await this.prisma.$transaction(async (tx) => {
      const party = await this.party.createParty(tx, {
        orgId: project.orgId,
        name: input.name,
        createdById: requester.sub,
      });
      const row = await tx.projectCompany.create({
        data: {
          projectId,
          orgId: project.orgId,
          partyId: party.id,
          name: input.name,
          kind: input.kind,
          contactName: input.contactName || null,
          contactEmail: input.contactEmail || null,
          contactPhone: input.contactPhone || null,
          notes: input.notes || null,
        },
      });
      await this.party.attachPartySource(tx, {
        orgId: project.orgId,
        projectId,
        partyId: party.id,
        origin: { kind: 'company', projectCompanyId: row.id },
      });
      return row;
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

    // Phase 6 unit 6.1a (§A) — this row is now the evidence for a canonical party, so a rename is
    // an IDENTITY change, not a display edit. Left alone it would desynchronise the two: the
    // party a resolver keys on would still say ACME while the only row describing it says Beta.
    // Contact details are not identity and stay freely editable.
    const renaming = input.name !== undefined && input.name !== existing.name;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.projectCompany.update({ where: { id: companyId }, data });
      if (renaming) {
        const outcome = await this.party.renamePartyForSoleSource(tx, {
          partyId: existing.partyId, name: input.name!,
        });
        if (!outcome.renamed) {
          throw new ConflictException(
            'This firm’s identity is shared with another record, so it cannot be renamed here. Reconcile the party first.',
          );
        }
      }
      return row;
    });
    return this.toDto(updated);
  }

  async remove(projectId: string, requester: AuthUser, companyId: string): Promise<{ ok: boolean }> {
    await this.assertCanManage(projectId, requester);
    const existing = await this.prisma.projectCompany.findUnique({ where: { id: companyId } });
    if (!existing || existing.projectId !== projectId) throw new NotFoundException('Company not found on this project');
    // The source row goes with the company by ON DELETE CASCADE, but a cascade cannot decide
    // whether the ASSOCIATION still has a reason to exist. Without the release, removing the only
    // company would leave `ProjectParty` alive with nothing supporting it and the deferred
    // constraint trigger would refuse the whole transaction at COMMIT — so the delete the user
    // asked for would fail rather than the association tidying itself up.
    await this.prisma.$transaction(async (tx) => {
      await tx.projectCompany.delete({ where: { id: companyId } });
      await this.party.releasePartyAssociationIfUnsourced(tx, { projectId, partyId: existing.partyId });
    });
    return { ok: true };
  }
}
