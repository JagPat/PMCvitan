import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readinessLockKey } from '../common/readiness-lock';

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
   * Everyone on this project who WOULD satisfy `hasProjectRoleStanding` for `roles`.
   *
   * §I's authorisation form needs to offer candidates, and the alternative was a client-side
   * filter over the team roster — which is a SECOND implementation of the standing rule, and a
   * worse one: it silently excluded org owners/admins, who this rule admits as pmc when they hold
   * no active membership here. A picker built from an approximation of an authority rule is an
   * authority rule.
   *
   * So the enumeration lives beside the predicate, in the module that owns `Membership`,
   * `Project` and `OrgMembership`, and its two arms are the predicate's two arms — the active
   * membership, and the org fallback that applies ONLY where no active membership exists. A
   * candidate this returns is one `hasProjectRoleStanding` says yes to; that is the point of
   * putting them in the same file.
   *
   * It answers WHO COULD, never WHO MAY: the command re-checks the person it is given, because a
   * picker is not the only way in and standing can change between the read and the write.
   */
  async projectRoleCandidates(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    roles: readonly string[],
  ): Promise<Array<{ userId: string; name: string }>> {
    if (roles.length === 0) return [];
    const rolePlaceholders = roles.map((_, i) => `$${i + 2}`).join(', ');
    // the org arm mirrors `hasProjectRoleStanding` exactly, including the precedence rule: an
    // active membership DECIDES, so someone holding one is judged on its role alone and never
    // upgraded through the org
    const orgArm = roles.includes('pmc')
      ? `UNION
         SELECT u."id" AS "userId", u."name" AS "name"
           FROM "Project" p
           JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."role" IN ('owner', 'admin')
           JOIN "User" u ON u."id" = om."userId"
          WHERE p."id" = $1
            AND NOT EXISTS (
              SELECT 1 FROM "Membership" m
               WHERE m."projectId" = $1 AND m."userId" = om."userId" AND m."status" = 'active'
            )`
      : '';
    return (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ userId: string; name: string }>>(
      `SELECT u."id" AS "userId", u."name" AS "name"
         FROM "Membership" m
         JOIN "User" u ON u."id" = m."userId"
        WHERE m."projectId" = $1 AND m."status" = 'active'
          AND m."role" IN (${rolePlaceholders})
       ${orgArm}
       ORDER BY 2, 1`,
      projectId,
      ...roles,
    );
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
   * Phase 5 Task 6A (§I) — may `userId` approve on `projectId` at all, and up to what CEILING?
   *
   * Approval limits are authority/standing data and `Membership` is orgs-owned, so commercial does
   * not read the table directly: an orgs-side change to how active membership or a limit downgrade
   * is interpreted would otherwise leave payment approval and project access disagreeing about the
   * same actor.
   *
   * **Standing and ceiling are ONE answer, not two.** Codex round 2 found both halves of the split:
   * an earlier spelling selected `approvalLimit` from the active membership and locked THAT, which
   *
   *   - never looked at the ROLE, so a request authorised as pmc at the guard could still approve
   *     after a concurrent downgrade to engineer committed — the lock protected the number and not
   *     the authority the number qualifies (P1); and
   *   - treated an ABSENT membership as a zero ceiling, which refuses the ordinary org-owner/admin
   *     fallback: that user switches into the project as pmc with no `Membership` row at all, holds
   *     live authority everywhere else, and could approve nothing (P2).
   *
   * Both are the same mistake — a fragment of the standing predicate re-stated here instead of
   * asked of the one place that states it. So the predicate is not re-stated: this asks
   * `hasProjectRoleStanding` with `forUpdate`, which is the rule `ProjectAccessService.authorize`
   * applies, org arm included, under the lock that makes a concurrent downgrade wait.
   *
   * The ceiling then comes from the ACTIVE membership row that decision already locked. When
   * standing came from the ORG arm there is no membership row and therefore no project-recorded
   * ceiling: that path is reported as unlimited, which is what it already is for every other
   * authority on the project. `null` is UNLIMITED — the state every existing membership is in —
   * and a ceiling of zero is a real ceiling that refuses everything, because "may not approve" is a
   * thing a practice may legitimately want to say about a role.
   */
  async approvalAuthorityFor(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    userId: string,
    roles: readonly string[],
  ): Promise<{ standing: false } | { standing: true; ceiling: Prisma.Decimal | null }> {
    // ONE statement of the rule, under the lock. `forUpdate` is what makes this an authority
    // decision rather than a reading of one: the downgrade waits for this transaction.
    const entitled = await this.hasProjectRoleStanding(tx, projectId, userId, roles, { forUpdate: true });
    if (!entitled) return { standing: false };

    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ approvalLimit: Prisma.Decimal | null }>>(
      `SELECT "approvalLimit" FROM "Membership"
        WHERE "projectId" = $1 AND "userId" = $2 AND "status" = 'active'`,
      projectId, userId,
    );
    if (rows.length > 0) return { standing: true, ceiling: rows[0]!.approvalLimit ?? null };

    // No active membership, yet standing held — the ORG owner/admin arm. There is no project row
    // to carry a ceiling, and inventing zero here is exactly the refusal round 2 named.
    //
    // But this arm needs a lock the row-level one cannot give it (Codex round 3). `FOR UPDATE`
    // locks rows that EXIST, and the whole premise here is that none does. So a membership INSERT
    // races: this transaction reads "org admin, unlimited", a concurrent insert makes the same user
    // an active contractor — or a pmc with a zero ceiling — and `authorize` gives that membership
    // PRECEDENCE over the org arm, so the authority this arm relied on is gone before the approval
    // it authorised commits.
    //
    // `hasProjectRoleStanding` documents the insert direction as safe on the grounds that it "only
    // ever grants authority the operator did not have at decision time". That is true of its
    // original callers and FALSE here: for the org arm an insert REVOKES. A rationale is only as
    // good as the caller it was written for.
    //
    // The serializing primitive is the project readiness lock — the same one `MembersService` takes
    // on activation and removal, so the insert either waits for this decision or lands before it.
    // Advisory locks are re-entrant, so a caller already holding it (every command path does) pays
    // nothing, and a caller that is not holding it is made correct rather than left to a
    // coincidence. Taken only on THIS arm: the row-lock above already settles the ordinary case.
    // the lock function returns `void`, which Prisma's row deserializer refuses, and this client
    // interface offers no `$executeRaw` — so the call is wrapped in a subquery that yields a row
    await (tx as OrgsParticipantClient).$queryRawUnsafe(
      'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l',
      readinessLockKey(projectId),
    );
    // …and the question is asked AGAIN behind the lock, because the answer before it was taken is
    // exactly the one that could be stale. An insert that committed while this transaction waited
    // is visible now, and it decides.
    const settled = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ approvalLimit: Prisma.Decimal | null }>>(
      `SELECT "approvalLimit" FROM "Membership"
        WHERE "projectId" = $1 AND "userId" = $2 AND "status" = 'active'`,
      projectId, userId,
    );
    if (settled.length === 0) return { standing: true, ceiling: null };
    // a membership appeared: it takes precedence, so the whole standing question is re-asked
    // through the one method that states it
    const stillEntitled = await this.hasProjectRoleStanding(tx, projectId, userId, roles, { forUpdate: true });
    if (!stillEntitled) return { standing: false };
    return { standing: true, ceiling: settled[0]!.approvalLimit ?? null };
  }

  // ── Phase 6 unit 6.1a (§A) — the canonical external party ─────────────────────────────────
  //
  // `ExternalParty`, `ProjectParty` and the two source tables are ORGS-owned. Procurement
  // creates vendors and binds them to projects, so it needs a party and an association written
  // in ITS OWN transaction — and must not write orgs tables directly. These three methods are
  // that channel, and `procurement.workflowParticipants` declares the edge.
  //
  // Orgs owns them precisely because the collaborator resolver reads the association: putting a
  // procurement table inside the authority predicate is the inversion §A rejects `Vendor` for.

  /** Mint the canonical party for a firm this org has just started dealing with. */
  async createParty(
    tx: Prisma.TransactionClient,
    input: { orgId: string; name: string; createdById: string | null },
  ): Promise<{ id: string }> {
    const created = await tx.externalParty.create({
      data: { orgId: input.orgId, name: input.name, createdById: input.createdById },
      select: { id: true },
    });
    return { id: created.id };
  }

  /**
   * Record that `partyId` is associated with `projectId` BECAUSE of a specific origin row.
   *
   * The association is created if absent and reused if present — one party can reach a project
   * through both a company and a vendor binding, and the second must not fail or duplicate. The
   * SOURCE row is what differs, and it is FK-bound to the origin through the origin's own
   * project and party, so it cannot justify an association it does not belong to.
   */
  async attachPartySource(
    tx: Prisma.TransactionClient,
    input: {
      orgId: string;
      projectId: string;
      partyId: string;
      origin: { kind: 'company'; projectCompanyId: string } | { kind: 'vendor'; projectVendorId: string };
    },
  ): Promise<void> {
    const { orgId, projectId, partyId } = input;
    await tx.projectParty.upsert({
      where: { projectId_partyId: { projectId, partyId } },
      create: { orgId, projectId, partyId },
      update: {},
    });
    if (input.origin.kind === 'company') {
      await tx.projectPartyCompanySource.create({
        data: { orgId, projectId, partyId, projectCompanyId: input.origin.projectCompanyId },
      });
    } else {
      await tx.projectPartyVendorSource.create({
        data: { orgId, projectId, partyId, projectVendorId: input.origin.projectVendorId },
      });
    }
  }

  /**
   * Drop the association if the origin just removed was its LAST justification.
   *
   * The source row itself is removed by the origin's ON DELETE CASCADE; what cascades cannot do
   * is decide whether the association still has a reason to exist. Without this, deleting the
   * only company on a project would leave `ProjectParty` alive with nothing supporting it — and
   * the deferred constraint trigger would refuse the whole transaction at COMMIT, so the delete
   * a user asked for would fail rather than the association tidying itself up.
   *
   * Call AFTER the origin delete, in the same transaction.
   */
  async releasePartyAssociationIfUnsourced(
    tx: Prisma.TransactionClient,
    input: { projectId: string; partyId: string },
  ): Promise<void> {
    const { projectId, partyId } = input;
    const [companies, vendors] = await Promise.all([
      tx.projectPartyCompanySource.count({ where: { projectId, partyId } }),
      tx.projectPartyVendorSource.count({ where: { projectId, partyId } }),
    ]);
    if (companies + vendors > 0) return;
    await tx.projectParty.deleteMany({ where: { projectId, partyId } });
  }

}
