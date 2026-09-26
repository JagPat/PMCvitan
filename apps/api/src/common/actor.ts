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

/** Whether the attributed actor is a real person or a named system process (Phase 2 Task 3).
 *  Persisted on the DomainEvent envelope in Task 4; carried here so every audit + event
 *  writer resolves attribution the same way. */
export type ActorKind = 'human' | 'system';

export interface Actor {
  actorId: string;
  actorName: string;
  actorRole: string;
  actorKind: ActorKind;
}

/**
 * The attribution a DomainEvent envelope records: who, whether they are a person, and the role
 * they acted in.
 *
 * Phase 6 task 4d unit 4d-ii-a / A1 widens this from `actorId`/`actorKind` by the ROLE, because
 * `emitEvent` now writes the envelope's frozen `actorRole`/`actorName` pair
 * (`platform/actor-envelope.ts`). It deliberately stops short of the full {@link Actor}: the
 * envelope's NAME must not come from here. `resolveActor` reads `User.name` BEFORE the emitting
 * transaction opens, and §A.3 obligation 3 requires the frozen name to be read inside that
 * transaction from `UserIdentity`, with the identity row locked, or a rename committing in
 * between would freeze a stale name. The role is the token role the window disposition names,
 * re-checked in the transaction before it is written. An `Actor` satisfies this structurally.
 */
export type EventActor = Pick<Actor, 'actorId' | 'actorKind' | 'actorRole'>;

/** The caller's REAL identity for attribution (Phase 1): id + display name + role, plus the
 *  actor KIND (Phase 2 Task 3) — a human sign-in always resolves `actorKind: 'human'` with a
 *  real user id. A role label alone is not attribution — every lifecycle write carries all four. */
export async function resolveActor(prisma: PrismaService, user: AuthUser): Promise<Actor> {
  const dbUser = await prisma.user.findUnique({ where: { id: user.sub }, select: { name: true } });
  return {
    actorId: user.sub,
    actorName: dbUser?.name ?? ROLE_LABEL[user.role] ?? 'Team member',
    actorRole: user.role,
    actorKind: 'human',
  };
}

/** A NAMED system actor (Phase 2 Task 3) — a stable, non-human identity for state changes not
 *  initiated by a signed-in user (migrations, scheduled clock ticks, relayers). It still carries
 *  a real `actorId` (the constant's id) so no audit/event row is ever left unattributed; the
 *  `actorKind: 'system'` distinguishes it from a person. */
export function systemActor(actorId: string, actorName: string, actorRole = 'system'): Actor {
  return { actorId, actorName, actorRole, actorKind: 'system' };
}
