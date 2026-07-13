import type { PrismaService } from '../prisma.service';
import type { AuthUser } from './auth';

export const ROLE_LABEL: Record<string, string> = {
  pmc: 'PMC',
  client: 'Client',
  engineer: 'Site Engineer',
  contractor: 'Contractor',
  consultant: 'Consultant',
  worker: 'Worker',
};

export interface Actor {
  actorId: string;
  actorName: string;
  actorRole: string;
}

/** The caller's REAL identity for attribution (Phase 1): id + display name + role.
 *  A role label alone is not attribution — every lifecycle write carries all three. */
export async function resolveActor(prisma: PrismaService, user: AuthUser): Promise<Actor> {
  const dbUser = await prisma.user.findUnique({ where: { id: user.sub }, select: { name: true } });
  return {
    actorId: user.sub,
    actorName: dbUser?.name ?? ROLE_LABEL[user.role] ?? 'Team member',
    actorRole: user.role,
  };
}
