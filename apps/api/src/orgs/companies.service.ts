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
    const updated = await this.prisma.$transaction(async (tx) => {
      // Phase 6 unit 6.1b — the PARTY ROOT is locked FIRST, before this row, whenever the edit can
      // reach the party. The global order is party → origin (see `lockPartyRoot`), because the
      // operator merge holds the party roots and then repoints `ProjectCompany`; locking this row
      // first and the party second gave the two paths opposite orders and made a deadlock the
      // expected outcome rather than a rare one.
      //
      // The party id comes from the pre-transaction read, which is exactly the value E3 warned is
      // not authoritative — so it is used ONLY to choose a lock, never to decide anything. The
      // authoritative value is still the locked re-read below, and the two are compared.
      if (input.name !== undefined) await this.party.lockPartyRoot(tx, existing.partyId);

      // RE-READ the row inside the transaction, locked. `existing` was read before it began, and
      // a 6.1b repoint can move this company onto a different party in between — after which the
      // update lands on the row (now on party B) while the rename would fire on party A: B's name
      // left stale, A's name changed for a row that no longer belongs to it. The party renamed
      // must be the party of the row actually being updated.
      const current = await tx.$queryRaw<Array<{ partyId: string; name: string }>>`
        SELECT "partyId", "name" FROM "ProjectCompany"
         WHERE "id" = ${companyId} AND "projectId" = ${projectId}
         FOR UPDATE`;
      if (current.length === 0) throw new NotFoundException('Company not found on this project');
      const pinned = current[0]!;

      // The pre-read chose which party to lock; the locked re-read says which party this row
      // ACTUALLY belongs to. If a merge moved it in between, the lock in hand is the wrong one, and
      // reaching for the right one now — while holding the first — is how the deadlock this
      // ordering exists to prevent gets reintroduced. Refuse instead, and say so: the operator's
      // edit was written against an identity that has since been reconciled, and a retry against
      // the surviving firm is the correct next act, not a silently redirected rename.
      if (input.name !== undefined && pinned.partyId !== existing.partyId) {
        throw new ConflictException(
          'This firm’s canonical identity was reconciled while you were editing, so the change was '
            + 'not applied. Reload and try again.',
        );
      }

      const row = await tx.projectCompany.update({ where: { id: companyId }, data });
      if (input.name !== undefined && input.name !== pinned.name) {
        const outcome = await this.party.renamePartyForSoleSource(tx, {
          partyId: pinned.partyId, name: input.name, callerCompanyId: companyId,
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
