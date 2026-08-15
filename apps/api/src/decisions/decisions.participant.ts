import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface DecisionsParticipantClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * The DECISIONS side of the orgs ⇄ decisions standing channel (Phase 6 task 4b, round 1 Codex P2).
 *
 * `Membership_t4b_holder_seal` already refuses a write that would strand a published open decision,
 * and that seal is the authority — a direct transaction must not get past it. But when the PRODUCT
 * path trips it, PostgreSQL raises and Prisma surfaces an internal error: the API answered a
 * perfectly ordinary "you cannot remove this person yet" with a 500. The caller cannot act on that.
 *
 * So the orgs commands ask this first, in their own transaction, and refuse with a 409 that says
 * what to do. The database seal stays exactly where it is; it is the backstop, not the messenger.
 * The two answer the same question because they are the same predicate — this method calls the
 * SQL function the seal calls, rather than re-deriving the rule in TypeScript where it could drift.
 */
@Injectable()
export class DecisionsParticipant {
  /**
   * Does a published OPEN decision on `projectId` name this holder — by NAMED MEMBERSHIP
   * (`membershipId`, pass null when the write leaves the membership active), or by a ROLE this
   * membership is the LAST effective holder of (`departingRole`, pass null when the write removes
   * no role standing)?
   */
  async holdsOpenDecisions(
    tx: DecisionsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    membershipId: string | null,
    departingRole: string | null,
  ): Promise<boolean> {
    const rows = await (tx as DecisionsParticipantClient).$queryRawUnsafe<Array<{ held: boolean }>>(
      `SELECT decisions_open_decision_names_holder($1, $2, $3) AS held`,
      projectId, membershipId, departingRole,
    );
    return rows[0]?.held === true;
  }
}
