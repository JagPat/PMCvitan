import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
    // Codex round 4 (P2) — the guard depends on the project ROOT ROW's status, and archiving
    // updates that row without taking the readiness lock. A plain `SELECT EXISTS` therefore lets
    // activation read `operable = true`, an org admin archive and commit, and activation then
    // write onto a project no request path can operate. Locking the row makes the archive wait
    // for this transaction (or this read wait for the archive) — the decision cannot go stale
    // between the check and the writes it authorises.
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ archived: boolean }>>(
      `SELECT ("archivedAt" IS NOT NULL) AS archived FROM "Project" WHERE "id" = $1 FOR UPDATE`,
      projectId,
    );
    return rows.length > 0 && rows[0]!.archived === false;
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
    opts: { forUpdate?: boolean } = {},
  ): Promise<boolean> {
    if (roles.length === 0) return false;
    // Codex round 4 (P2) — `forUpdate` locks the standing rows before the decision is read.
    // `MembersService.updateRole` writes `Membership.role` WITHOUT the readiness lock, so a plain
    // read lets activation see an active `pmc`, a concurrent downgrade to `engineer` commit, and
    // activation then write rows the operator's live authority no longer permits. Locking the row
    // makes the downgrade wait for this transaction.
    //
    // OPT-IN, defaulted OFF: the cleared Phase-4 T3 repair engine already relies on this method,
    // and silently changing its locking would change behaviour nobody asked to change.
    //
    // Stated honestly: `FOR UPDATE` locks rows that EXIST, so this closes the downgrade race (an
    // UPDATE of a present row) — the shape that actually threatens an authority decision. It does
    // not serialize a membership that is INSERTED after this read; that direction only ever grants
    // authority the operator did not have at decision time, and the decision has already been made.
    if (opts.forUpdate) {
      await (tx as OrgsParticipantClient).$queryRawUnsafe(
        `SELECT 1 FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE`,
        projectId, userId,
      );
      if (roles.includes('pmc')) {
        await (tx as OrgsParticipantClient).$queryRawUnsafe(
          `SELECT 1 FROM "OrgMembership" om
             JOIN "Project" p ON p."orgId" = om."orgId"
            WHERE p."id" = $1 AND om."userId" = $2
              FOR UPDATE OF om`,
          projectId, userId,
        );
      }
    }
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

  /**
   * Phase 5 Task 6A (§I) — this member's payment-approval CEILING, read through the owner.
   *
   * Approval limits are authority/standing data and `Membership` is orgs-owned, so commercial does
   * not read the table directly: an orgs-side change to how active membership or a limit downgrade
   * is interpreted would otherwise leave payment approval and project access disagreeing about the
   * same actor.
   *
   * `null` is UNLIMITED — the state every existing membership is in — and a ceiling of zero is a
   * real ceiling that refuses everything, because "may not approve" is a thing a practice may
   * legitimately want to say about a role. A member with no ACTIVE standing has no ceiling to
   * report and no authority either; the caller's own authorization check is what refuses them, and
   * returning `null` here would read as unlimited, so an absent membership is reported as a zero
   * ceiling instead. Locked with the decision, for the same reason `hasProjectRoleStanding` locks:
   * a concurrent downgrade must wait rather than land after the limit is read.
   */
  async approvalCeilingFor(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<Prisma.Decimal | null> {
    const rows = await (tx as Prisma.TransactionClient).$queryRaw<Array<{ approvalLimit: Prisma.Decimal | null }>>`
      SELECT "approvalLimit" FROM "Membership"
       WHERE "projectId" = ${projectId} AND "userId" = ${userId} AND "status" = 'active'
       FOR UPDATE`;
    // an absent ACTIVE membership has no authority at all; reporting `null` here would read as
    // UNLIMITED, so it is reported as a zero ceiling and the caller's own check does the refusing
    if (rows.length === 0) return new Prisma.Decimal(0);
    return rows[0]!.approvalLimit ?? null;
  }

}
