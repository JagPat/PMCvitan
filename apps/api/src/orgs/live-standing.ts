import type { Prisma } from '@prisma/client';
import { isRetired } from '../auth/identity/identity-accounts';
import type { OrgsParticipant } from './orgs.participant';

/**
 * Redbracket ID A4b — the effective standing of `role` on a project that someone can still act on: the effective
 * holders less any account a first Redbracket ID sign-in retired (nobody signs in as it again; it keeps its seats only
 * until the re-seat). The last-holder guards of the team and roster writes count with this, so a live holder can never
 * be removed or demoted leaving a role-held open decision (or a company) to a retired row alone.
 */
export async function liveRoleStanding(
  tx: Prisma.TransactionClient,
  standing: OrgsParticipant,
  projectId: string,
  role: string,
): Promise<number> {
  const n = await standing.effectiveRoleStanding(tx, projectId, role);
  if (n === 0) return 0;
  let retired = 0;
  let live = 0;
  for (const userId of await standing.effectiveRoleHolderUserIds(tx, projectId, role)) {
    if (await isRetired(tx, userId)) retired += 1;
    else live += 1;
  }
  // the count less the retired holders, and never more than the live holders named: if the two reads ever disagree
  // about who holds the role, the smaller answer wins and the guard refuses (fails closed)
  return Math.max(0, Math.min(n - retired, live));
}
