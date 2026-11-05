import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { consultationOpen } from './consultation-open';
import { tallyOpenWork, type OpenWorkCounts } from '../common/open-work';

/**
 * Phase 6 task 4b (§A.1) — the DECISIONS-owned workflow-participant answers the orgs membership
 * commands consult before a standing write: does any PUBLISHED OPEN decision (`pending`/`change`,
 * `publishedAt` set — and from 4d, `awaiting_countersign`) name this holder? Both designations:
 * the NAMED membership, and the ROLE the decision holds (whose "last active holder" judgement
 * the orgs side composes with its own effective-standing facts — standing is orgs' to compute,
 * open-holder facts are decisions' to answer). The DB re-judgement of the same predicate is the
 * decisions-owned `phase6_decisions_name_membership`/`phase6_decisions_hold_role` primitive pair
 * (§B.2), called by the orgs-owned membership seal — mirroring this bidirectional TS channel.
 */
export interface OpenHolderAnswer {
  /** a published open (`pending`/`change`) decision NAMES this membership as its decider */
  named: boolean;
  /** the roles (`client` | `pmc` | `architect`) any published open (`pending`/`change`) decision
   *  currently holds as decider */
  heldRoles: string[];
  /** Phase 6 task 4d (P39) — a decision AWAITING COUNTERSIGN names this membership as its holder */
  namedAwaiting: boolean;
  /** Phase 6 task 4d (P39) — the roles any decision awaiting countersign is designated to */
  awaitingRoles: string[];
}

@Injectable()
export class DecisionsParticipant {
  /**
   * Redbracket ID A4b-2 — consultations still waiting on these accounts, per project: each consultation asked of the
   * account, not yet answered, while the consultee membership is ACTIVE (the answer command and the push claim both
   * need it; a consultation left with a removed seat can never be answered and is settled at the decision itself), on
   * a published decision whose question is still open (`consultationOpen`) and in the same approval cycle the
   * consultation was asked in (`openCycle` against FINALIZED approvals, the rule the answer command checks). Read by the
   * operator door's list of retired accounts.
   */
  async openWorkOf(db: Prisma.TransactionClient, userIds: string[]): Promise<OpenWorkCounts> {
    const counts: OpenWorkCounts = new Map();
    if (userIds.length === 0) return counts;
    const asked = await db.decisionConsultation.findMany({
      where: { consulteeUserId: { in: userIds }, response: null, consulteeMembership: { status: 'active' } },
      select: { projectId: true, consulteeUserId: true, decisionId: true, openCycle: true, decision: { select: { status: true, publishedAt: true } } },
    });
    const live = asked.filter((c) => c.decision.publishedAt !== null && consultationOpen(c.decision.status));
    if (live.length === 0) return counts;
    const cycles = await db.decisionApprovalRevision.groupBy({
      by: ['decisionId'],
      where: { decisionId: { in: [...new Set(live.map((c) => c.decisionId))] }, finalized: true },
      _count: { _all: true },
    });
    const cycleOf = new Map(cycles.map((c) => [c.decisionId, c._count._all] as const));
    for (const c of live) if ((cycleOf.get(c.decisionId) ?? 0) === c.openCycle) tallyOpenWork(counts, c.consulteeUserId, c.projectId);
    return counts;
  }

  /**
   * Redbracket ID A4b-2 (Stage 1) — open decisions still waiting on these accounts as their NAMED decider, per project:
   * each published decision `pending`, `change` or `awaiting_countersign` whose `deciderMembershipId` is one of the
   * account's memberships (the open set `holdsOpenDecisions` answers for the membership guards). A role-held decision
   * names no account, so it is never counted here; its live holders are judged by the seals and A4b-s. Read by the
   * operator door's list of retired accounts.
   */
  async openDecisionsOf(db: Prisma.TransactionClient, userIds: string[]): Promise<OpenWorkCounts> {
    const counts: OpenWorkCounts = new Map();
    if (userIds.length === 0) return counts;
    const named = await db.decision.findMany({
      where: {
        publishedAt: { not: null },
        status: { in: ['pending', 'change', 'awaiting_countersign'] },
        deciderMembership: { userId: { in: userIds } },
      },
      select: { projectId: true, deciderMembership: { select: { userId: true } } },
    });
    for (const d of named) if (d.deciderMembership) tallyOpenWork(counts, d.deciderMembership.userId, d.projectId);
    return counts;
  }

  /**
   * Answer on the CALLER's transaction so the refusal and the write it guards are one unit.
   *
   * Two open sets, because two guards judge them: `pending`/`change` is the delivered one (the
   * 4b guard, `phase6_decisions_hold_role` / `phase6_decisions_name_membership`), and
   * `awaiting_countersign` is 4d-i's widened arm (`phase6_t4d_membership_guard`), which carries the
   * one named exemption for the last architect. The caller composes them with standing; the two
   * are answered apart so the exemption can apply to the second and never the first.
   */
  async holdsOpenDecisions(
    tx: Prisma.TransactionClient,
    args: { projectId: string; membershipId?: string },
  ): Promise<OpenHolderAnswer> {
    const published = { projectId: args.projectId, publishedAt: { not: null } };
    const open = { ...published, status: { in: ['pending', 'change'] as ('pending' | 'change')[] } };
    const awaiting = { ...published, status: 'awaiting_countersign' as const };
    const roleKinds = { in: ['client', 'pmc', 'architect'] as ('client' | 'pmc' | 'architect')[] };
    const [named, kinds, namedAwaiting, awaitingKinds] = await Promise.all([
      args.membershipId
        ? tx.decision.count({ where: { ...open, deciderMembershipId: args.membershipId } }).then((n) => n > 0)
        : Promise.resolve(false),
      tx.decision.findMany({ where: { ...open, deciderKind: roleKinds }, select: { deciderKind: true }, distinct: ['deciderKind'] }),
      args.membershipId
        ? tx.decision.count({ where: { ...awaiting, deciderMembershipId: args.membershipId } }).then((n) => n > 0)
        : Promise.resolve(false),
      tx.decision.findMany({ where: { ...awaiting, deciderKind: roleKinds }, select: { deciderKind: true }, distinct: ['deciderKind'] }),
    ]);
    return {
      named,
      heldRoles: kinds.map((k) => k.deciderKind as string),
      namedAwaiting,
      awaitingRoles: awaitingKinds.map((k) => k.deciderKind as string),
    };
  }
}
