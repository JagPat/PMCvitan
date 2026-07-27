import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** The narrow client surface the standing check needs — satisfied by both a `$transaction` client
 *  and a top-level Prisma client, so non-DI callers (operator CLIs) can construct this directly. */
export interface OrgsParticipantClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * The ORGS workflow participant — the cycle-exempt channel through which another module asks an
 * orgs-owned question inside its OWN transaction.
 *
 * `Membership`, `Project` and `OrgMembership` are orgs-owned. A foreign module that needs to know
 * whether a user is accountable on a project must not query those tables itself — not being
 * read-encapsulated makes a read representable, not legitimate; the OWNER states the rule. This
 * participant is that statement: one method, the exact standing rule
 * `ProjectAccessService.authorize` applies, evaluated against the caller's transaction so the
 * answer is consistent with everything else that transaction sees.
 *
 * The caller lists `orgs` in its manifest `workflowParticipants` (the same cycle-exempt edge shape
 * as `activities → labour`), so the module graph records the interaction without creating a
 * `dependsOn` cycle.
 */
@Injectable()
export class OrgsParticipant {
  /**
   * Does `userId` have STANDING on `projectId` — an ACTIVE project membership, or owner/admin of
   * the project's org (the documented super-admin path: an owner legitimately operates every
   * project in their org without an explicit membership)? Same rule, same order as
   * `ProjectAccessService.authorize`.
   *
   * A boolean, deliberately: orgs owns the RULE; what refusing means (an HTTP 403, an aborted
   * repair transaction) belongs to the caller.
   */
  async hasProjectStanding(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ entitled: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM "Membership" m
                 WHERE m."projectId" = $1 AND m."userId" = $2 AND m."status" = 'active'
              )
           OR EXISTS (
                SELECT 1 FROM "Project" p
                  JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."userId" = $2
                 WHERE p."id" = $1 AND om."role" IN ('owner', 'admin')
              ) AS entitled`,
      projectId,
      userId,
    );
    return rows[0]?.entitled === true;
  }
}
