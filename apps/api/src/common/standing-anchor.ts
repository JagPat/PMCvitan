import { Prisma } from '@prisma/client';

/**
 * #1061 — ONE lock per person, taken before any of that person's standing rows.
 *
 * A person's standing lives in rows a writer deletes and re-creates: an org loss deletes the
 * `"OrgUserAuthority"` row, and a project re-role deletes the old-role `"ProjectUserStanding"` row and
 * inserts the new one (the role is in its key). A reader that waits on such a row and finds it deleted
 * locks nothing, goes on to the project row, and deadlocks with the next writer. So every reader of a
 * person's standing takes this anchor SHARED and every writer of it takes it EXCLUSIVE, before any row:
 * the anchor is a transaction advisory lock and is never deleted. The decision forward, which locks its
 * holders' standing `FOR UPDATE`, is not a taker yet: it joins in a later unit, once the standing
 * projection is serialized for direct writers (#1100); it stays reserved until 4d-iii.
 *
 * Order: after the transaction's ORG, readiness and tree keys (never a key after an anchor), and before
 * the named people's `"OrgUserAuthority"` / `"ProjectUserStanding"` rows and the `"Project"` row. Every
 * EXCLUSIVE taker (members add / re-role / remove / discipline, the org roster's standing arm) takes its
 * people in ONE call, ascending by user id, one mode per person
 * (exclusive if it writes them at all), before any row lock: two transactions naming the same two people
 * in opposite roles, on different projects, cannot deadlock on the anchors, and a self-act never asks
 * shared and then exclusive. Nothing checks this at run time: a new exclusive caller must keep it.
 *
 * A SHARED taker whose only call is an emit's envelope (`lockActorStanding`) may already hold other rows
 * by then (a `Membership` / `OrgMembership` row FOR UPDATE, a `Decision` row FOR SHARE). That is safe only
 * because every exclusive taker of a person on a project holds that project's readiness key (the org
 * roster's arm: the ORG key and every project's readiness key), which those commands hold too. A shared
 * call after a row lock in a path WITHOUT the readiness key, or any late exclusive call, needs its own
 * proof or must move up front.
 *
 * A later call for a person the transaction already holds in the same or a stronger mode (an emit's
 * envelope after the command took its people up front) never waits: a backend's own advisory locks do not
 * conflict with each other. A later EXCLUSIVE call for a person held SHARED is an upgrade, and two
 * transactions upgrading the same person deadlock: take that person exclusive in the up-front call.
 */
export async function lockStandingAnchors(
  tx: Prisma.TransactionClient,
  people: { read?: readonly string[]; write?: readonly string[] },
): Promise<void> {
  const mode = new Map<string, 'shared' | 'exclusive'>();
  for (const id of people.read ?? []) mode.set(id, 'shared');
  for (const id of people.write ?? []) mode.set(id, 'exclusive');
  for (const id of [...mode.keys()].sort()) {
    const fn = mode.get(id) === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
    // $executeRaw: the functions return void, which Prisma's row deserializer refuses
    await tx.$executeRaw(Prisma.sql`SELECT ${Prisma.raw(fn)}(hashtextextended(${standingAnchorKey(id)}, 0))`);
  }
}

/** The anchor's KEY, exported so a test or a raw caller takes the same lock. */
export function standingAnchorKey(userId: string): string {
  return 'standing:' + userId;
}
