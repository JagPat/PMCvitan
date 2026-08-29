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
  /** a published open decision NAMES this membership as its decider */
  named: boolean;
  /** the roles ('client' | 'pmc') any published open decision currently holds as decider */
  heldRoles: string[];
}

@Injectable()
export class DecisionsParticipant {
  /** Answer on the CALLER's transaction so the refusal and the write it guards are one unit. */
  async holdsOpenDecisions(
    tx: Prisma.TransactionClient,
    args: { projectId: string; membershipId?: string },
  ): Promise<OpenHolderAnswer> {
    const open = {
      publishedAt: { not: null },
      status: { in: ['pending', 'change'] as ('pending' | 'change')[] },
    };
    const [named, kinds] = await Promise.all([
      args.membershipId
        ? tx.decision
            .count({ where: { projectId: args.projectId, deciderMembershipId: args.membershipId, ...open } })
            .then((n) => n > 0)
        : Promise.resolve(false),
      tx.decision.findMany({
        where: { projectId: args.projectId, deciderKind: { in: ['client', 'pmc'] }, ...open },
        select: { deciderKind: true },
        distinct: ['deciderKind'],
      }),
    ]);
    return { named, heldRoles: kinds.map((k) => k.deciderKind as string) };
  }
}
