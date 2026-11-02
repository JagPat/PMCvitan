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

/** The member's standing mark now: their count of standing changes in the responsible roles (orgs' answer). Taken at
 *  naming under the readiness key and stored with the name; the name is served only while it is unchanged. */
export async function standingMark(
  orgs: Pick<OrgsParticipant, 'roleStandingMarks'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<number> {
  return (await orgs.roleStandingMarks(client, projectId, [userId], RESPONSIBLE_ROLES)).get(userId)?.mark ?? 0;
}

/** Of these namings, which still hold: the member stands now AND their standing mark is the one stored with the name.
 *  Both come from ONE orgs statement, so one snapshot: a re-role between the two roles can never fall between reads. */
export async function heldNamings<T extends { memberId: string; mark: number }>(
  orgs: Pick<OrgsParticipant, 'roleStandingMarks'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  namings: readonly T[],
): Promise<T[]> {
  if (namings.length === 0) return [];
  const now = await orgs.roleStandingMarks(client, projectId, namings.map((n) => n.memberId), RESPONSIBLE_ROLES);
  return namings.filter((n) => { const m = now.get(n.memberId); return m !== undefined && m.stands && m.mark === n.mark; });
}
