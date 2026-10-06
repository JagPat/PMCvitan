import { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { EventActor } from '../common/actor';

/**
 * Phase 6 task 4d unit 4d-ii-a / A1 — the actor ENVELOPE a human event records.
 *
 * `DomainEvent.actorRole`/`actorName` (4d-i, §A.3 obligation 7) freeze WHO acted and in which role.
 * 4d-i's `DomainEvent_t4d_envelope` seal judges a written pair with `phase6_t4d_actor_pair_true`:
 * the role must be one the actor holds on the project (`platform_user_holds_role_windowed`, the
 * register answer with the drain window's race-free `pmc` arm), and the name must equal the
 * account's `UserIdentity.displayName`, read under `FOR UPDATE`. A NULL pair is admitted.
 *
 * This resolves the pair INSIDE the emitting transaction (§A.3 obligation 3), never from the
 * `Actor` a service read before the transaction opened:
 *
 * - **The role** is the actor's token role, per the window disposition, and is written only when
 *   it passes the SAME predicate the seal asks: this calls `platform_user_holds_role_windowed`
 *   itself, so the two cannot drift. A stale token role (a re-role that committed after
 *   `resolveActor`) is not replaced by another role the actor now holds, which would attribute
 *   the act to a standing it was not performed in; the envelope is left NULL instead.
 * - **The name** is read from `UserIdentity` with the identity row locked `FOR UPDATE`, exactly
 *   as the seal reads it. A concurrent rename therefore either committed first (the event freezes
 *   the new name) or waits behind this transaction (it freezes the old one); both are true at the
 *   act.
 *
 * Before the answer is read, the rows it depends on are locked `FOR SHARE`: the actor's
 * `OrgUserAuthority` row for the project's organisation, then their `ProjectUserStanding` rows on
 * the project. A concurrent removal, re-role or demotion then waits for this transaction rather
 * than changing the answer between this read and the event's INSERT.
 *
 * **The lock order is the projection writers' order**, and it is load-bearing (#641 Codex finding
 * 4111429421). An `OrgMembership` write fires `OrgMembership_t4d_org_authority` and then
 * `OrgMembership_t4d_user_standing` (AFTER triggers run in name order), so it holds
 * `OrgUserAuthority` before it reaches `ProjectUserStanding`. Locking the two the other way round
 * let an owner's emit hold PUS while waiting on OUA as that owner's demotion held OUA while
 * waiting on PUS, and PostgreSQL aborted one of two valid requests as a deadlock. No other
 * register writer takes both. `UserIdentity` comes last: only `User_t4d_identity` writes it, and
 * that writer takes no standing register.
 *
 * One interleaving no read order can remove: a transaction that ITSELF writes a standing register
 * (a membership change) and then emits already holds that row, so it can still meet a concurrent
 * writer that took the other register first. That is the ordinary cost of writing two registers in
 * one transaction, is not introduced by the envelope, and aborts a single retryable command.
 *
 * **Known limit.** An ABSENT row cannot be locked. A membership-less org owner/admin whose
 * `pmc` claim rests on the window's race-free arm ("no membership-granted row") can see a
 * membership granted to them commit between this read and the INSERT. The seal then refuses the
 * pair, and that one command rolls back and may be retried. Nothing is recorded wrongly.
 *
 * Returns NULL, and so writes no pair, for a `system` actor (the seal refuses a pair on one), a
 * blank role, a role the actor does not hold, or a missing or blank account name. NULL is never a
 * refusal: the seal admits it on every event type through the drain.
 */
export interface ActorEnvelope {
  readonly actorRole: string;
  readonly actorName: string;
}

/** The seal's own blank test: `btrim(value, E' \t\n\x0B\f\r') = ''`. */
const ASCII_BLANK = /^[ \t\n\v\f\r]*$/;

export async function resolveActorEnvelope(
  tx: Prisma.TransactionClient,
  projectId: string,
  actor: EventActor,
): Promise<ActorEnvelope | null> {
  if (actor.actorKind !== 'human') return null;
  const role = actor.actorRole;
  if (typeof role !== 'string' || ASCII_BLANK.test(role)) return null;

  // `Prisma.sql` objects rather than tagged-template calls, as the kernel's other raw reads are, so
  // every bind value is carried on the one argument.
  // OrgUserAuthority BEFORE ProjectUserStanding: the OrgMembership projection writers' order.
  await tx.$queryRaw(Prisma.sql`
    SELECT 1 FROM "OrgUserAuthority" a
      JOIN "ProjectOrg" po ON po."orgId" = a."orgId"
     WHERE po."projectId" = ${projectId} AND a."userId" = ${actor.actorId}
       FOR SHARE OF a`);
  await tx.$queryRaw(Prisma.sql`
    SELECT 1 FROM "ProjectUserStanding"
     WHERE "projectId" = ${projectId} AND "userId" = ${actor.actorId}
       FOR SHARE`);
  const standing = await tx.$queryRaw<Array<{ holds: boolean }>>(Prisma.sql`
    SELECT platform_user_holds_role_windowed(${projectId}, ${actor.actorId}, ${role}) AS "holds"`);
  if (!Array.isArray(standing) || standing[0]?.holds !== true) return null;

  const identity = await tx.$queryRaw<Array<{ displayName: string | null }>>(Prisma.sql`
    SELECT "displayName" FROM "UserIdentity" WHERE "userId" = ${actor.actorId} FOR UPDATE`);
  const name = Array.isArray(identity) ? identity[0]?.displayName : undefined;
  if (typeof name !== 'string' || ASCII_BLANK.test(name)) return null;

  return { actorRole: role, actorName: name };
}

/**
 * Phase 6 task 4d-iii / R0a — the Board's Decision 2 (2026-10-05): a human act whose token role no
 * longer stands on the project is REFUSED with a re-sign-in, never recorded with an empty or false
 * attribution. One message for every writer that owes the pair, so the client can treat it as one
 * condition.
 */
export const STALE_ROLE_MESSAGE = 'Your role on this project changed — sign in again';

/** {@link resolveActorEnvelope}, refusing (403) when the pair does not resolve. */
export async function requireActorEnvelope(
  tx: Prisma.TransactionClient,
  projectId: string,
  actor: EventActor,
): Promise<ActorEnvelope> {
  const envelope = await resolveActorEnvelope(tx, projectId, actor);
  if (!envelope) throw new ForbiddenException(STALE_ROLE_MESSAGE);
  return envelope;
}

/**
 * Phase 6 task 4d-iii / R0a-2 — the Board's Decision 1 (2026-10-05): an org owner/admin acting on a
 * project records the `pmc` role, the project role the org authority grants and the windowed arm of
 * `platform_user_holds_role_windowed` already admits. `ProjectUserStanding` never holds `owner` or
 * `admin`, so the org role itself would resolve no pair. An owner/admin who also holds a membership-granted
 * standing row on the project records that membership's role instead: with a membership-granted row the
 * register is the answer, and the windowed `pmc` arm is withheld. Any other actor is returned as given.
 */
export async function orgAuthorityActor<A extends EventActor>(
  tx: Prisma.TransactionClient,
  projectId: string,
  actor: A,
): Promise<A> {
  if (actor.actorKind !== 'human' || (actor.actorRole !== 'owner' && actor.actorRole !== 'admin')) return actor;
  // the platform's own register, never the orgs-owned `Membership` table: a membership-granted row is
  // the answer the seal itself reads (`platform_user_holds_role_windowed`)
  const granted = await tx.projectUserStanding.findFirst({
    where: { projectId, userId: actor.actorId, membershipId: { not: null } },
    select: { role: true },
  });
  return { ...actor, actorRole: granted?.role ?? 'pmc' };
}
