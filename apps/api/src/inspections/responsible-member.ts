import type { Prisma } from '@prisma/client';
import type { OrgsParticipant, OrgsParticipantClient } from '../orgs/orgs.participant';

/**
 * #482 proof photos, "Who fixes this?" (Jagrut, 14 Oct 2026) — WHO fixes an inspection's failed work.
 *
 * `Inspection.responsibleMemberId` names a contractor or consultant member. It is not `assigneeId` (the engineer whose
 * re-inspection it is, `assignment-eligibility.ts`). A name is written only while its member stands in one of these
 * roles, and it is SERVED only while they have stood WITHOUT A BREAK since: a removed or re-roled member is no one
 * responsible, and stays no one after they come back, until someone names them again. The stored name stays as the
 * record of who was asked. "Without a break" is the member's standing mark (`standingMark`), stored with the name. Both questions go to the owner of `Membership` (`OrgsParticipant`),
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

/** The member's standing mark now: their count of standing changes in the responsible roles (orgs' answer). Taken at
 *  naming under the readiness key and stored with the name; the name is served only while it is unchanged. */
export async function standingMark(
  orgs: Pick<OrgsParticipant, 'standingChangeCounts'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<number> {
  return (await orgs.standingChangeCounts(client, projectId, [userId], RESPONSIBLE_ROLES)).get(userId) ?? 0;
}

/** Of these namings, which still hold: the member stands now AND their standing mark is the one stored with the name. */
export async function heldNamings<T extends { memberId: string; mark: number }>(
  orgs: Pick<OrgsParticipant, 'effectiveRoleHolderUserIds' | 'standingChangeCounts'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  namings: readonly T[],
): Promise<T[]> {
  if (namings.length === 0) return [];
  const ids = namings.map((n) => n.memberId);
  // two reads, in this order: a break that commits before the second read shows in at least one of them
  const standing = await standingResponsibleIds(orgs, client, projectId, ids);
  const marks = await orgs.standingChangeCounts(client, projectId, ids, RESPONSIBLE_ROLES);
  return namings.filter((n) => standing.has(n.memberId) && marks.get(n.memberId) === n.mark);
}
