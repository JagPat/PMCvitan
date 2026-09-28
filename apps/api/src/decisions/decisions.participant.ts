import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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
