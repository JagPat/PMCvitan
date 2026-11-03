import type { Prisma } from '@prisma/client';
import { isRetired } from '../platform/identity-retirement.query';
import { RoleStandingQuery } from '../platform/role-standing.query';
import type { OrgsParticipant } from './orgs.participant';

/**
 * The refusal a team add gives when the address or phone it names finds a retired account (Redbracket ID A4b): the
 * person now signs in with a new account, which holds their address (an add by phone would otherwise land on the
 * retired row, which keeps its number).
 */
export const RETIRED_ADD = 'This person now signs in with a new account. Add them by email.';

/**
 * Redbracket ID A4b — the effective standing of `role` on a project that someone can still act on: the effective
 * holders less any account a first Redbracket ID sign-in retired (nobody signs in as it again; it keeps its seats only
 * until the re-seat). The last-holder guards of the team and roster commands count with this, so those commands never
 * remove or demote a live holder leaving a role-held open decision to a retired row alone. The database holder seals stay
 * the raw-count backstop for every other writer (A4b r2, Codex 4452016264: a writer outside the commands, which only the
 * operator's SQL is, is held to the raw count; see the PR's residuals), and a later retirement is ended by the re-seat.
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

/**
 * Redbracket ID A4b r1 (Codex 4451627333) — the architect's live standing: the KERNEL register's count and holders (the
 * orgs derivation knows nothing of the role), less any retired holder, by the same rule as `liveRoleStanding`.
 */
export async function liveArchitectStanding(tx: Prisma.TransactionClient, projectId: string): Promise<number> {
  const n = await RoleStandingQuery.activeCount(tx, projectId, 'architect');
  if (n === 0) return 0;
  let retired = 0;
  let live = 0;
  for (const userId of await RoleStandingQuery.holderUserIds(tx, projectId, 'architect')) {
    if (await isRetired(tx, userId)) retired += 1;
    else live += 1;
  }
  return Math.max(0, Math.min(n - retired, live));
}
