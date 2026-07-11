import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import type { AddMemberInput, UpdateMemberInput } from '../contracts';

export interface MemberDto {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  /** for a `consultant` member: the discipline they cover */
  discipline?: string;
  status: string;
}

/**
 * Project team management (Orgs Slice 2). List/add/change-role/remove members.
 * Adding a member also provisions the account (invited), so with invite-only auth
 * they can then sign in by email-OTP / password / phone-OTP. Gated to the project's
 * PMC or an owner/admin of the owning org.
 */
@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  /** True if the requester may manage this project's team (project PMC or org owner/admin). */
  private async canManage(projectId: string, user: AuthUser): Promise<boolean> {
    if (user.role === 'pmc') return true; // token is already scoped to this project
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.orgId) return false;
    const om = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: project.orgId, userId: user.sub } } });
    return om?.role === 'owner' || om?.role === 'admin';
  }

  private async assertCanManage(projectId: string, user: AuthUser): Promise<void> {
    if (!(await this.canManage(projectId, user))) {
      throw new ForbiddenException('Only the project PMC or an org admin can manage the team');
    }
  }

  async list(projectId: string): Promise<MemberDto[]> {
    const rows = await this.prisma.membership.findMany({
      where: { projectId, status: { not: 'removed' } },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, phone: m.user.phone, role: m.role, discipline: m.discipline ?? undefined, status: m.status }));
  }

  /** A discipline is only meaningful for a consultant — clear it for any other role. */
  private disciplineFor(role: string, discipline?: string): string | null {
    return role === 'consultant' ? (discipline ?? null) : null;
  }

  async add(projectId: string, requester: AuthUser, input: AddMemberInput): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const email = input.email?.toLowerCase();
    const phone = input.phone;
    const discipline = this.disciplineFor(input.role, input.discipline);

    let user =
      (email && (await this.prisma.user.findUnique({ where: { email } }))) ||
      (phone && (await this.prisma.user.findUnique({ where: { phone } }))) ||
      null;
    if (!user) {
      // provision the invited identity (they set a credential on first sign-in)
      user = await this.prisma.user.create({ data: { projectId, role: input.role, name: input.name, email, phone } });
    }

    const membership = await this.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: user.id } },
      update: { role: input.role, discipline, status: 'active' },
      create: { projectId, userId: user.id, role: input.role, discipline, status: 'active' },
    });
    return { userId: user.id, name: user.name, email: user.email, phone: user.phone, role: membership.role, discipline: membership.discipline ?? undefined, status: membership.status };
  }

  async updateRole(projectId: string, requester: AuthUser, userId: string, input: UpdateMemberInput): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { user: true } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    const membership = await this.prisma.membership.update({
      where: { projectId_userId: { projectId, userId } },
      data: { role: input.role, discipline: this.disciplineFor(input.role, input.discipline) },
    });
    return { userId, name: existing.user.name, email: existing.user.email, phone: existing.user.phone, role: membership.role, discipline: membership.discipline ?? undefined, status: membership.status };
  }

  async remove(projectId: string, requester: AuthUser, userId: string): Promise<{ ok: boolean }> {
    await this.assertCanManage(projectId, requester);
    if (userId === requester.sub) throw new BadRequestException('You cannot remove yourself');
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    await this.prisma.membership.update({ where: { projectId_userId: { projectId, userId } }, data: { status: 'removed' } });
    return { ok: true };
  }
}
