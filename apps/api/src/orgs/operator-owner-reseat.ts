import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockOrgStanding } from '../common/readiness-lock';
import { lockStandingAnchors } from '../common/standing-anchor';
import { isRetired, madeAtRetirement, retirementOf } from '../platform/identity-retirement.query';
import { lockOrgStandingWriters } from './org-standing';

export const RESEAT_NOT_RETIRED = 'That account is not one a Redbracket ID sign-in set aside';
export const RESEAT_NOT_OWNER = 'That account holds no owner seat in this company';
export const RESEAT_NO_SUCCESSOR =
  'No account made at that retirement holds its address now: the person has no new account to seat. Check the person (an operator repair of their account comes first)';
export const RESEAT_OWNER_CAN_ACT = 'This company has an owner who can sign in; that owner re-seats the person (RUNBOOK, Redbracket ID re-seat)';

export interface OwnerReseat {
  /** the person's new account, now owner (or already owner: `changed` false) */
  userId: string;
  changed: boolean;
  /** the company's live projects, for the caller's audit rows */
  projectIds: string[];
}

/**
 * Redbracket ID A4c — the operator door's company owner re-seat, for when no owner of the company can act: every owner
 * seat is held by an account a first Redbracket ID sign-in set aside, so nobody can re-seat anyone through the team
 * commands. It puts back ONE owner the company already had: the new account made for the person whose retired account
 * holds an owner seat here. It never chooses a new owner, never removes the retired seat (the restored owner does
 * that through the normal commands, RUNBOOK "Redbracket ID re-seat"), and writes only the company owner seat: project
 * seats need a person with authority (the MembershipTransition seal), `OrgMembership` carries no actor seal.
 *
 * Runs in the caller's transaction. The org key comes first, as for every owner/admin roster writer, so the
 * "no owner can act" read is ordered against every other owner add, promotion or step-down; then, for the grant, the
 * org-row marker and every project key ascending, and the new account's standing anchor (`guardedOrgStandingWrite`'s
 * order). A first sign-in that retires someone takes the issuer-person and credential locks, never the org key: a
 * retirement only ever turns an owner from live to retired, so a read that raced one sees an owner as live at worst,
 * and refuses (409); it can never seat a second owner beside one who can act. The new account is linked, and a linked
 * account is never retired, so the account seated cannot be retired after this read.
 */
export async function operatorOwnerReseat(
  tx: Prisma.TransactionClient,
  orgId: string,
  retiredUserId: string,
  // the QA company lock's refusal, passed in by `OrgsParticipant` (which owns it) so this file imports no participant
  rethrowQaLock: (e: unknown) => never,
): Promise<OwnerReseat> {
  await lockOrgStanding(tx, orgId);
  const org = await tx.org.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) throw new NotFoundException('no such company');
  const retirement = await retirementOf(tx, retiredUserId);
  if (!retirement) throw new BadRequestException(RESEAT_NOT_RETIRED);
  const seat = await tx.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId: retiredUserId } }, select: { role: true } });
  if (seat?.role !== 'owner') throw new BadRequestException(RESEAT_NOT_OWNER);
  const successor = await tx.user.findUnique({ where: { email: retirement.email }, select: { id: true, createdAt: true } });
  if (!successor || !(await madeAtRetirement(tx, successor, retirement)) || (await isRetired(tx, successor.id))) {
    throw new ConflictException(RESEAT_NO_SUCCESSOR);
  }
  const projects = async () =>
    (await tx.project.findMany({ where: { orgId, archivedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })).map((p) => p.id);
  const current = await tx.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId: successor.id } }, select: { role: true } });
  if (current?.role === 'owner') return { userId: successor.id, changed: false, projectIds: await projects() };
  const owners = await tx.orgMembership.findMany({ where: { orgId, role: 'owner' }, select: { userId: true } });
  for (const o of owners) if (!(await isRetired(tx, o.userId))) throw new ConflictException(RESEAT_OWNER_CAN_ACT);
  await lockOrgStandingWriters(tx, orgId);
  await lockStandingAnchors(tx, { write: [successor.id] });
  await tx.orgMembership
    .upsert({
      where: { orgId_userId: { orgId, userId: successor.id } },
      update: { role: 'owner' },
      create: { orgId, userId: successor.id, role: 'owner' },
    })
    .catch(rethrowQaLock);
  return { userId: successor.id, changed: true, projectIds: await projects() };
}
