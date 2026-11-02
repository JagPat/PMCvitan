import type { Prisma } from '@prisma/client';
import type { OrgsParticipant, OrgsParticipantClient } from '../orgs/orgs.participant';

/**
 * #482 proof photos, "Who fixes this?" (Jagrut, 14 Oct 2026) — WHO fixes an inspection's failed work.
 *
 * `Inspection.responsibleMemberId` names a contractor or consultant member. It is not `assigneeId` (the engineer whose
 * re-inspection it is, `assignment-eligibility.ts`). A name is written only while its member stands in one of these
 * roles, and it is SERVED only while they still do: a removed or re-roled member is no one responsible, while the
 * stored name stays as the record of who was asked. Both questions go to the owner of `Membership` (`OrgsParticipant`),
 * never to the table, exactly as the assignee rule does.
 */
export const RESPONSIBLE_ROLES: readonly string[] = ['contractor', 'consultant'];

/** Does this user stand, now, as a member who may be named? Under `forUpdate` the standing rows are locked, so a
 *  removal or re-role of the member waits for the writer that asked (`hasProjectRoleStanding`). */
export function standsAsResponsible(
  orgs: Pick<OrgsParticipant, 'hasProjectRoleStanding'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  userId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<boolean> {
  return orgs.hasProjectRoleStanding(client, projectId, userId, RESPONSIBLE_ROLES, opts);
}

/** Of these named members, which still stand? One owner query per role, asked only when someone is named. */
export async function standingResponsibleIds(
  orgs: Pick<OrgsParticipant, 'effectiveRoleHolderUserIds'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const candidates = new Set(candidateIds);
  const standing = new Set<string>();
  if (candidates.size === 0) return standing;
  for (const role of RESPONSIBLE_ROLES) {
    for (const userId of await orgs.effectiveRoleHolderUserIds(client, projectId, role)) {
      if (candidates.has(userId)) standing.add(userId);
    }
  }
  return standing;
}
