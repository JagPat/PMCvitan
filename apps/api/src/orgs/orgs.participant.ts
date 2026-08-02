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
   * Is `projectId` a project that may be OPERATED ON at all — it exists and is not archived?
   *
   * Phase 5 Task 1, Codex round 3 (P2). `ProjectAccessService.authorize` refuses an archived
   * project BEFORE it looks at membership, so no request path can author anything there. An
   * operator-driven path that only proves the row EXISTS therefore admits work the application
   * itself would refuse: an active PMC membership left on an archived project could run commercial
   * activation and commit cost heads, attributions and the capability row.
   *
   * `hasProjectRoleStanding` deliberately does NOT fold this in. That method answers a question
   * about a PERSON, it is already relied on by the cleared Phase-4 T3 repair engine, and widening
   * it would silently change that caller's behaviour. Two questions, two methods; a caller that
   * needs both asks both.
   */
  async isProjectOperable(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
  ): Promise<boolean> {
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ operable: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM "Project" WHERE "id" = $1 AND "archivedAt" IS NULL) AS operable`,
      projectId,
    );
    return rows[0]?.operable === true;
  }

  /**
   * Resolve an OPERATOR STRING — a user id or an email — to the orgs-owned `User` row it names.
   * Returns `null` when it names nobody.
   *
   * Phase 5 Task 1, Codex round 2 (P2). The commercial activation CLI takes `--operator` as free
   * text, and its first spelling resolved it with `tx.user.findFirst` from the commercial module.
   * `User` is orgs-owned and merely not read-encapsulated, and this file's own header says why
   * that is not permission: **a read being representable is not the same as it being legitimate —
   * the OWNER states the rule.** Identity and tenancy semantics (which column is the identity key,
   * whether email is unique, whether a disabled or merged account still resolves) belong here, so
   * they can change once rather than in every module that happens to accept an operator string.
   *
   * Evaluated against the CALLER'S transaction, exactly like `hasProjectRoleStanding`, so the
   * identity and the standing decision see the same snapshot.
   */
  async resolveUserIdentity(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    identifier: string,
  ): Promise<{ id: string } | null> {
    if (!identifier) return null;
    // Both values bind as parameters; nothing user-controlled is interpolated into the SQL text.
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "User" WHERE "id" = $1 OR "email" = $1 ORDER BY ("id" = $1) DESC LIMIT 1`,
      identifier,
    );
    return rows[0] ?? null;
  }

  /**
   * Does `userId` have ROLE-QUALIFIED standing on `projectId` — an ACTIVE project membership whose
   * role is one of `roles`, or (when `roles` admits `pmc` AND the user holds NO active membership
   * on this project) owner/admin of the project's org? Same rule, same PRECEDENCE as
   * `ProjectAccessService.authorize`: an active membership decides — `authorize` returns on it and
   * never reaches the org arm — so an org admin who is also an active contractor on the site
   * operates AS contractor and is refused here when `roles` does not admit that role. The
   * super-admin path operates a project AS PMC (see `authorize` — it grants that path only to a
   * pmc-role token), so it satisfies this check only when `roles` includes `'pmc'`.
   *
   * The caller supplies `roles` from the policy it is enforcing (e.g.
   * `ROLE_POLICY['attendance.revoke']`) — the POLICY stays with its shared owner, the MEMBERSHIP
   * facts stay here. Bare project standing is deliberately not offered: an earlier revision
   * exposed exactly that, and a repair could then attribute an immutable attendance revocation to
   * an active contractor — someone the application itself would refuse. Mere standing is not
   * authority.
   *
   * A boolean, deliberately: orgs owns the RULE; what refusing means (an HTTP 403, an aborted
   * repair transaction) belongs to the caller.
   */
  async hasProjectRoleStanding(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    userId: string,
    roles: readonly string[],
  ): Promise<boolean> {
    if (roles.length === 0) return false;
    // placeholders are derived from the ARITY of `roles` only — every value still binds as a
    // parameter, nothing user-controlled is interpolated into the SQL text
    const rolePlaceholders = roles.map((_, i) => `$${i + 3}`).join(', ');
    // An ACTIVE project membership DECIDES, exactly as `authorize` does: it returns on the active
    // membership (role and all) and never reaches the org arm. So the super-admin fallback applies
    // ONLY when the user holds NO active membership on this project — an org admin who is also an
    // active contractor on the site operates AS contractor, and if `roles` does not admit that
    // role the answer is NO, never silently upgraded to pmc through the org.
    const orgArm = roles.includes('pmc')
      ? `OR (NOT EXISTS (
                SELECT 1 FROM "Membership" m
                 WHERE m."projectId" = $1 AND m."userId" = $2 AND m."status" = 'active'
              )
              AND EXISTS (
                SELECT 1 FROM "Project" p
                  JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."userId" = $2
                 WHERE p."id" = $1 AND om."role" IN ('owner', 'admin')
              ))`
      : '';
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ entitled: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM "Membership" m
                 WHERE m."projectId" = $1 AND m."userId" = $2 AND m."status" = 'active'
                   AND m."role" IN (${rolePlaceholders})
              )
           ${orgArm} AS entitled`,
      projectId,
      userId,
      ...roles,
    );
    return rows[0]?.entitled === true;
  }
}
