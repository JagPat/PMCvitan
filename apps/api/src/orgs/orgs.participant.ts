import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import type { Role } from '../common/auth';
import { readinessLockKey } from '../common/readiness-lock';
import { readPhase6_4dRollout } from '../platform/phase6-4d-rollout';
import { RoleStandingQuery } from '../platform/role-standing.query';
import { holdProjectExchangeFence } from './project-exchange-fence';

/** #482 — the address pattern the Board fixed for the QA accounts (`qa.<lowercase letters>@vitan.in`), matched as stored. */
export const QA_ACCOUNT_EMAIL = /^qa\.[a-z]+@vitan\.in$/;

/** The 409 the QA sign-in gives when one of the rows its check locks is being changed at that moment. */
export const QA_SIGN_IN_BUSY = 'This account is being changed right now, so it cannot be signed in; try again';

/** Where a sign-in lands: a project the access rule grants, with the role it grants there. */
export interface SignInLanding {
  projectId: string;
  role: Role;
}

/** The account fields a sign-in needs to issue its session. */
export interface SignInAccount {
  id: string;
  name: string;
  projectId: string;
  role: string;
  credentialVersion: number;
  lastProjectId: string | null;
}

/** The QA sign-in's answer (`OrgsParticipant.qaSignInAccount`). `unknown`: no account holds the address. `not-qa`: the
 *  account is not a QA account in QA-only companies only. `no-access`: the access rule grants it no live project. */
export type QaSignInAccount =
  | { kind: 'unknown' }
  | { kind: 'not-qa' }
  | { kind: 'no-access' }
  | { kind: 'ok'; account: SignInAccount; landing: SignInLanding };

/** The QA sign-in's row locks: a row being changed right now (55P03 lock_not_available) is the 409, never a wait. */
async function lockedNow<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (e: unknown) {
    if (e instanceof Error && /55P03|could not obtain lock/.test(e.message)) throw new ConflictException(QA_SIGN_IN_BUSY);
    throw e;
  }
}

/** The 409 a command gives when the QA company lock (migration 20280116) refuses its membership or address write. */
export const QA_LOCK_REFUSAL = 'QA accounts and real people are kept in separate companies, so this account cannot be added here';
/** The operator's mark refused for a person here who is not a QA account; asked before the reason below. */
const QA_MARK_REAL_PERSON = 'This company still has people who are not QA accounts, so it cannot be marked QA-only';
/** The operator's mark refused for a QA account here still in a company that is not QA-only. */
const QA_MARK_QA_ELSEWHERE = 'A QA account in this company still belongs to a company that is not QA-only, so it cannot be marked QA-only yet';

/**
 * #482 QA company lock — the database refuses a real person in a QA-only company and a QA account anywhere else
 * (`check_violation`, "qa lock: ..."). Behind the command doors that refusal is the caller's 409, not a 500; any other
 * error is left as it was. Hostile direct SQL still gets the raw raise.
 */
export function refuseQaLock(e: unknown): void {
  if (e instanceof Error && /qa lock:/.test(e.message)) throw new ConflictException(QA_LOCK_REFUSAL);
}

/** {@link refuseQaLock} as a `.catch` handler: the lock's refusal becomes the 409, anything else is rethrown. */
export function rethrowQaLock(e: unknown): never {
  refuseQaLock(e);
  throw e;
}

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
    // between the check and the writes it authorises. `FOR NO KEY UPDATE`, as the seals' own
    // `phase6_project_operable` takes it (20271225000000): it conflicts with the archive's UPDATE,
    // and not with the `FOR KEY SHARE` a ledgered command's receipt holds on this row through its
    // foreign key, which `FOR UPDATE` turned into a deadlock between two commands on one project.
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ archived: boolean }>>(
      `SELECT ("archivedAt" IS NOT NULL) AS archived FROM "Project" WHERE "id" = $1 FOR NO KEY UPDATE`,
      projectId,
    );
    return rows.length > 0 && rows[0]!.archived === false;
  }

  /**
   * #1177 VT2-B — is the project operable, held so until the caller's transaction ends? Takes the shared side of the
   * project's exchange fence (`project-exchange-fence.ts`), then reads `archivedAt`. An archive takes the fence's
   * exclusive side first, so it waits (bounded) for every holder, and a holder that comes after a waiting archive
   * waits behind it and then answers false. The project's row is not locked, so no other writer of it waits on a
   * holder.
   *
   * For the caller:
   * - Call it FIRST in the transaction, holding no other lock (the fence's lock order), and make only the one bounded
   *   external exchange under it, so the archive's bounded wait (`PROJECT_EXCHANGE_FENCE_WAIT_MS`) always suffices.
   * - READ COMMITTED only (Prisma's default): the read is its own statement after the lock, so it sees an archive that
   *   committed while the holder waited. Under REPEATABLE READ or SERIALIZABLE it could not, so it refuses to run there.
   * - The fence stays held after a false answer until the transaction ends.
   * - A holder that comes while an archive waits queues behind it, for up to `PROJECT_EXCHANGE_FENCE_WAIT_MS`: size the
   *   transaction's timeout (and any lock_timeout) for that wait plus the exchange. Holders wait on each other only
   *   through such an archive, never directly.
   */
  async holdProjectOperable(tx: OrgsParticipantClient | Prisma.TransactionClient, projectId: string): Promise<boolean> {
    const [{ iso }] = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ iso: string }>>(
      `SELECT pg_catalog.current_setting('transaction_isolation') AS iso`);
    if (iso !== 'read committed') throw new Error(`holdProjectOperable needs READ COMMITTED, not ${iso}`);
    await holdProjectExchangeFence(tx as Prisma.TransactionClient, projectId);
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ archived: boolean }>>(
      `SELECT ("archivedAt" IS NOT NULL) AS archived FROM "Project" WHERE "id" = $1`,
      projectId,
    );
    return rows.length > 0 && rows[0]!.archived === false;
  }

  /**
   * Every project that may be operated on (exists, not archived), with its display name, by id.
   *
   * #482 operator door (Codex on `5ed4eab`). The `/ops` project list read `Project` from the platform
   * module; the population an operator may switch is the same population `isProjectOperable` admits,
   * so it is stated here, beside that predicate, and a later change to archival reaches both.
   * A plain read: it lists, it authorises nothing (the switch re-asks `isProjectOperable` under lock).
   */
  async operableProjects(tx: OrgsParticipantClient | Prisma.TransactionClient): Promise<Array<{ id: string; name: string }>> {
    return (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT "id", "name" FROM "Project" WHERE "archivedAt" IS NULL ORDER BY "id" ASC`,
    );
  }

  /**
   * #482 QA sign-in (Codex P1 on #1020) — the account that owns this address now, found and locked inside the
   * sign-in's own transaction, before anything else is read: `FOR UPDATE NOWAIT` on the User row the address names
   * (the strength `qaSignInAllowed` needs, taken at once, so two sign-ins of one account never both hold a share and
   * refuse each other's upgrade: the second gets the 409). A rename in flight refuses the sign-in (409, try again)
   * instead of waiting; one committed before the lock leaves the address with its new owner or with none, and
   * PostgreSQL re-reads a row changed after the statement began, so a row that no longer holds the address is not
   * returned. The lock then holds the address on that account until the sign-in commits. Null when no account holds it.
   */
  async lockQaAccountByEmail(tx: Prisma.TransactionClient, email: string): Promise<string | null> {
    const client = tx as OrgsParticipantClient;
    const rows = await lockedNow(() => client.$queryRawUnsafe<Array<{ id: string; email: string }>>(
      `SELECT "id", "email" FROM "User" WHERE "email" = $1 FOR UPDATE NOWAIT`, email));
    const row = rows[0];
    // the locked row still owns the address it was found by (it cannot change under the lock; checked, not assumed)
    return row && row.email === email ? row.id : null;
  }

  /**
   * #482 QA sign-in (Codex P2 on #1020) — is the project a sign-in chose to land on still live, held so until the
   * sign-in commits? `FOR SHARE NOWAIT` on the Project row, read again under the lock: an archive in flight refuses
   * the sign-in (409, try again), and one committed since the landing was chosen answers false.
   */
  async lockLiveProject(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
    const client = tx as OrgsParticipantClient;
    const rows = await lockedNow(() => client.$queryRawUnsafe<Array<{ archivedAt: Date | null }>>(
      `SELECT "archivedAt" FROM "Project" WHERE "id" = $1 FOR SHARE NOWAIT`, projectId));
    return rows.length === 1 && rows[0]!.archivedAt === null;
  }

  /**
   * #482 QA sign-in (Jagrut, 20 Oct 2026: "Rebuild it") — may the operator door sign in as this account? Only when its
   * email is a QA address, it reaches at least one company (a company row, or a membership that is not removed on one
   * of that company's projects), and every company it reaches is marked QA-only. The database's QA company lock keeps
   * that true afterwards: a QA account joins only QA-only companies, a QA-only company takes no real person and is never
   * unmarked while it holds a QA account, and the address cannot leave the QA pattern while the account belongs
   * anywhere. So the answer is asked once, at sign-in (inside its audit transaction, under the locks below), and needs
   * no re-check per request. A QA account still sitting in an unmarked company (a row from before the lock) is
   * refused until that company is marked.
   */
  async qaSignInAllowed(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const client = tx as OrgsParticipantClient;
    // Asked inside the sign-in's own transaction, under locks that conflict with every way the answer can flip before
    // the token is issued. First the person, FOR UPDATE (Codex P2 on #1020, "membership phantoms"): every new company
    // row or project membership, and every membership brought back from removed, takes a lock on its User row (the
    // foreign key's FOR KEY SHARE, and the QA company lock's FOR SHARE), and both conflict with FOR UPDATE. So one in
    // flight refuses the sign-in, and one that starts later waits until it commits: the rows read below are all the
    // rows there will be. The lock also blocks an email change. Then the company rows and every project membership,
    // removed ones too (FOR SHARE blocks their removal or return), and the companies they reach (blocks unmarking).
    // Project rows need no lock: a project never moves company (`Project.orgId` is frozen). Every lock is NOWAIT, so
    // the sign-in never waits on a writer and can never sit in a lock cycle with one, whatever order that writer takes
    // its rows in: a row being changed at this moment refuses the sign-in (409, try again), and a writer that comes
    // second waits for it.
    await lockedNow(async () => {
      await client.$queryRawUnsafe(`SELECT 1 FROM "User" WHERE "id" = $1 FOR UPDATE NOWAIT`, userId);
      await client.$queryRawUnsafe(`SELECT 1 FROM "OrgMembership" WHERE "userId" = $1 ORDER BY "id" FOR SHARE NOWAIT`, userId);
      await client.$queryRawUnsafe(`SELECT 1 FROM "Membership" WHERE "userId" = $1 ORDER BY "id" FOR SHARE NOWAIT`, userId);
      await client.$queryRawUnsafe(
        `SELECT 1 FROM "Org" o WHERE o."id" IN (
           SELECT om."orgId" FROM "OrgMembership" om WHERE om."userId" = $1
           UNION
           SELECT p."orgId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId" WHERE m."userId" = $1 AND m."status" <> 'removed'
         ) ORDER BY o."id" FOR SHARE OF o NOWAIT`,
        userId,
      );
    });
    const rows = await client.$queryRawUnsafe<Array<{ self: boolean; reach: number; unmarked: number }>>(
      `WITH reach AS (
         SELECT om."orgId" FROM "OrgMembership" om WHERE om."userId" = $1
         UNION
         SELECT p."orgId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId"
          WHERE m."userId" = $1 AND m."status" <> 'removed'
       )
       SELECT COALESCE((SELECT u."email" ~ $2 FROM "User" u WHERE u."id" = $1), false) AS "self",
              (SELECT COUNT(*) FROM reach)::int AS "reach",
              (SELECT COUNT(*) FROM reach r JOIN "Org" o ON o."id" = r."orgId" WHERE NOT o."qaOnly")::int AS "unmarked"`,
      userId,
      QA_ACCOUNT_EMAIL.source,
    );
    const r = rows[0];
    return !!r && r.self === true && Number(r.reach) > 0 && Number(r.unmarked) === 0;
  }

  /**
   * #482 QA sign-in (Codex P1 on #1020, round 3) — the whole account side of the operator door's sign-in, inside the
   * sign-in's transaction, so the auth module reads none of the orgs-owned rows itself. In this order, every lock
   * NOWAIT (a row being changed right now is the 409, `QA_SIGN_IN_BUSY`):
   *   1. the account the address names, `FOR UPDATE` (`lockQaAccountByEmail`);
   *   2. the QA check, which locks the account again first, then its company rows and every project membership
   *      (removed ones too), then the companies they reach (`qaSignInAllowed`);
   *   3. the landing, by the one sign-in access rule every credential sign-in uses (`signInLanding`), read only now, so
   *      it sees only rows the locks above hold;
   *   4. the landing project, `FOR SHARE`, live (`lockLiveProject`); an archive committed since step 3 is the 409.
   */
  async qaSignInAccount(tx: Prisma.TransactionClient, email: string): Promise<QaSignInAccount> {
    const userId = await this.lockQaAccountByEmail(tx, email);
    if (!userId) return { kind: 'unknown' };
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, projectId: true, role: true, credentialVersion: true, lastProjectId: true },
    });
    if (!(await this.qaSignInAllowed(tx, user.id))) return { kind: 'not-qa' };
    const landing = await this.signInLanding(tx, user);
    if (!landing) return { kind: 'no-access' };
    if (!(await this.lockLiveProject(tx, landing.projectId))) throw new ConflictException(QA_SIGN_IN_BUSY);
    return { kind: 'ok', account: user, landing };
  }

  /**
   * The one sign-in access rule (SEC-01), owned here with the rows it reads; `AuthService` asks it for every credential
   * sign-in (password, phone, email, Google, credential completion, the QA door), and the project switch asks
   * `projectRole`, so none of them lands by another copy. The dev-only role pick (`AuthService.session`, allowed only
   * with ALLOW_DEV_AUTH outside production) is the one exception: it lands where the picked account says.
   * Where a sign-in lands: the project the user last switched into (#811) when still permitted, else their home
   * project when still permitted, else their first active membership on a live project, else any live project in a
   * company they own or administer. Null when none holds: the account has lost access everywhere. `lastProjectId` is
   * a plain stamp; it only chooses among projects the rule already grants, and the role always comes from the rule.
   */
  async signInLanding(
    db: Prisma.TransactionClient,
    user: { id: string; projectId: string; lastProjectId?: string | null },
  ): Promise<SignInLanding | null> {
    const last = user.lastProjectId ? await this.landingOn(db, user.id, user.lastProjectId) : null;
    if (last) return last;
    const home = await this.landingOn(db, user.id, user.projectId);
    if (home) return home;
    const membership = await db.membership.findFirst({
      where: { userId: user.id, status: 'active', project: { archivedAt: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (membership) return { projectId: membership.projectId, role: membership.role as Role };
    const adminOrgs = await db.orgMembership.findMany({
      where: { userId: user.id, role: { in: ['owner', 'admin'] } },
      select: { orgId: true },
    });
    if (adminOrgs.length) {
      const project = await db.project.findFirst({
        where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null },
      });
      if (project) return { projectId: project.id, role: 'pmc' };
    }
    return null;
  }

  /**
   * The role a person holds on a project (SEC-01), from just two sources: an active project membership (`removed`
   * and `invited` deny), else owner/admin of the company that owns the project (operates it as PMC). The legacy
   * `User.projectId`/`User.role` fields are deliberately not consulted. Null when access is denied. An explicit
   * active membership wins over the company reach, so an owner can operate one project in a narrower role.
   */
  async projectRole(db: Prisma.TransactionClient, userId: string, projectId: string): Promise<Role | null> {
    const membership = await db.membership.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (membership?.status === 'active') return membership.role as Role;
    const project = await db.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
    if (!project?.orgId) return null;
    const om = await db.orgMembership.findUnique({ where: { orgId_userId: { orgId: project.orgId, userId } } });
    return om?.role === 'owner' || om?.role === 'admin' ? 'pmc' : null;
  }

  /** The role a sign-in may land with on this project: none when it is missing or archived, else the rule's answer. */
  private async landingOn(db: Prisma.TransactionClient, userId: string, projectId: string): Promise<SignInLanding | null> {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
    if (!project || project.archivedAt) return null;
    const role = await this.projectRole(db, userId, projectId);
    return role ? { projectId, role } : null;
  }

  /**
   * #482 auth → orgs boundary. The account reads the sign-in channels need, owned here with the `User` rows they read,
   * so the auth module asks for an account and never reads the table itself. Each one is the query auth ran before,
   * unchanged. An address lookup tries the email first, then the phone, as the passwordless sign-ins always have.
   */
  async accountByAddress(db: Prisma.TransactionClient, address: { email?: string; phone?: string }): Promise<User | null> {
    if (address.email) {
      const byEmail = await db.user.findUnique({ where: { email: address.email } });
      if (byEmail) return byEmail;
    }
    if (address.phone) return db.user.findUnique({ where: { phone: address.phone } });
    return null;
  }

  /** The account a sign-in or a redeemed code names, by id; null when it no longer exists. */
  async accountById(db: Prisma.TransactionClient, userId: string): Promise<User | null> {
    return db.user.findUnique({ where: { id: userId } });
  }

  /**
   * The dev-only role pick's account (`AuthService.session`, allowed only with ALLOW_DEV_AUTH outside production): the
   * first seeded account homed on the project in that role, or null for the synthetic persona. It lands where that
   * account says, the one path that does not use the sign-in access rule.
   */
  async devAccount(db: Prisma.TransactionClient, role: string, projectId: string): Promise<User | null> {
    return db.user.findFirst({ where: { role, projectId } });
  }

  /** Whether a project exists and is live: `missing`, `archived` or `live`. */
  async projectLive(db: Prisma.TransactionClient, projectId: string): Promise<'missing' | 'archived' | 'live'> {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
    if (!project) return 'missing';
    return project.archivedAt ? 'archived' : 'live';
  }

  /**
   * The projects a person may switch into, with the role the access rule grants on each: every active membership on a
   * live project, then every live project of a company they own or administer, as PMC, where they hold no membership.
   * This is the list form of `projectRole` (an explicit active membership wins over the company reach; `removed` and
   * `invited` grant nothing; the legacy `User.projectId`/`User.role` fields are not consulted), kept beside it so the
   * two read one precedence.
   */
  async reachableProjects(db: Prisma.TransactionClient, userId: string): Promise<
    Array<{ projectId: string; name: string; short: string; role: Role; discipline?: string; orgId: string | null; orgName: string | null }>
  > {
    const memberships = await db.membership.findMany({
      where: { userId, status: 'active' },
      include: { project: { include: { org: true } } },
    });
    const rows = memberships
      .filter((m) => !m.project.archivedAt) // hide archived projects
      .map((m) => ({
        projectId: m.projectId,
        name: m.project.name,
        short: m.project.short,
        role: m.role as Role,
        // a consultant's discipline scopes what they see by default (e.g. their drawings)
        discipline: m.discipline ?? undefined,
        orgId: m.project.orgId,
        orgName: m.project.org?.name ?? null,
      }));
    // company super-admin reach: an owner/admin can access every live project in their company (as PMC), even ones
    // they didn't create and aren't an explicit member of
    const adminOrgs = await db.orgMembership.findMany({ where: { userId, role: { in: ['owner', 'admin'] } }, select: { orgId: true } });
    if (adminOrgs.length) {
      const have = new Set(rows.map((r) => r.projectId));
      const projects = await db.project.findMany({ where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null }, include: { org: true } });
      for (const p of projects) {
        if (!have.has(p.id)) {
          rows.push({ projectId: p.id, name: p.name, short: p.short, role: 'pmc' as Role, discipline: undefined, orgId: p.orgId, orgName: p.org?.name ?? null });
          have.add(p.id);
        }
      }
    }
    return rows;
  }

  /** #811 — stamp the project a switch entered, so the next sign-in opens it (`signInLanding` reads it). */
  async rememberLastProject(db: Prisma.TransactionClient, userId: string, projectId: string): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { lastProjectId: projectId } });
  }

  /**
   * The account a password setup or reset is for, by email or id, with whether it may hold a credential at all
   * (`eligible`: an active project membership, or owner/admin of a company). Null when no account matches.
   */
  async credentialAccount(db: Prisma.TransactionClient, by: { email: string } | { id: string }): Promise<(User & { eligible: boolean }) | null> {
    const found = await db.user.findUnique({
      where: 'email' in by ? { email: by.email } : { id: by.id },
      include: {
        memberships: { select: { status: true } },
        orgMemberships: { select: { role: true } },
      },
    });
    if (!found) return null;
    const { memberships, orgMemberships, ...account } = found;
    const eligible = memberships.some((membership) => membership.status === 'active')
      || orgMemberships.some((membership) => membership.role === 'owner' || membership.role === 'admin');
    return { ...account, eligible };
  }

  /** The account whose stored number is exactly `phone`, with the fields the emailed phone code needs. */
  async accountByPhone(db: Prisma.TransactionClient, phone: string): Promise<{ id: string; email: string | null; passwordHash: string | null; emailVerifiedAt: Date | null } | null> {
    return db.user.findUnique({
      where: { phone },
      select: { id: true, email: true, passwordHash: true, emailVerifiedAt: true },
    });
  }

  /**
   * #482 operator door — mark a company QA-only, so its QA accounts can be signed in through the door. The mark is
   * refused (409, naming no one) while the company holds a real person, or else a QA account still in an unmarked
   * company; the database trigger refuses the same, as the backstop for every other writer. Marking a marked company
   * changes nothing. Returns the company's live projects so the caller can record the mark on each trail.
   */
  async markQaOnly(tx: Prisma.TransactionClient, orgId: string): Promise<{ found: boolean; changed: boolean; projectIds: string[] }> {
    const client = tx as OrgsParticipantClient;
    // a company already marked changes nothing and, as before, takes no lock: a repeated mark never holds up a QA
    // sign-in (whose company locks are NOWAIT) or a QA account joining the QA company
    const seen = await tx.org.findUnique({ where: { id: orgId }, select: { qaOnly: true } });
    if (!seen) return { found: false, changed: false, projectIds: [] };
    // an unmarked company's row, in the lock mode the mark's own update takes: a membership written meanwhile takes
    // this row FOR SHARE first (the QA company lock), so it waits for the mark, or the mark waits for it and reads it
    const org = seen.qaOnly ? [] : await client.$queryRawUnsafe<Array<{ qaOnly: boolean }>>(`SELECT "qaOnly" FROM "Org" WHERE "id" = $1 FOR NO KEY UPDATE`, orgId);
    if (org.length && !org[0].qaOnly) {
      // The database refuses the mark for either reason, in whatever order its loop meets the company's people, so
      // ask first, in one order: a real person, who keeps the company from ever being marked, then a QA account
      // still in another unmarked company (a row from before the lock). `qa_address` is the lock's own test.
      const [why] = await client.$queryRawUnsafe<Array<{ notQa: boolean; elsewhere: boolean }>>(
        `WITH people AS (
           SELECT om."userId" FROM "OrgMembership" om WHERE om."orgId" = $1
           UNION
           SELECT m."userId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId"
            WHERE p."orgId" = $1 AND m."status" <> 'removed'
         )
         SELECT EXISTS (SELECT 1 FROM people x JOIN "User" u ON u."id" = x."userId" WHERE NOT qa_address(u."email")) AS "notQa",
                EXISTS (SELECT 1 FROM people x JOIN "User" u ON u."id" = x."userId"
                         WHERE qa_address(u."email") AND EXISTS (
                           SELECT 1 FROM "Org" o
                            WHERE o."id" <> $1 AND NOT o."qaOnly"
                              AND o."id" IN (SELECT om."orgId" FROM "OrgMembership" om WHERE om."userId" = u."id"
                                             UNION
                                             SELECT p."orgId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId"
                                              WHERE m."userId" = u."id" AND m."status" <> 'removed'))) AS "elsewhere"`,
        orgId,
      );
      if (why?.notQa) throw new ConflictException(QA_MARK_REAL_PERSON);
      if (why?.elsewhere) throw new ConflictException(QA_MARK_QA_ELSEWHERE);
    }
    // one conditional write: of two marks racing on an unmarked company, the second waits on the row and then finds
    // it already marked (count 0), so exactly one of them reports the change and writes the audit rows. The trigger
    // stays the backstop for every other writer.
    const { count } = await tx.org.updateMany({ where: { id: orgId, qaOnly: false }, data: { qaOnly: true } }).catch((e: unknown) => {
      if (e instanceof Error && /qa lock:.*still belongs to company/.test(e.message)) {
        // a QA account here is still in a company that is not QA-only (a row from before the lock)
        throw new ConflictException(QA_MARK_QA_ELSEWHERE);
      }
      if (e instanceof Error && /qa lock:/.test(e.message)) {
        throw new ConflictException(QA_MARK_REAL_PERSON);
      }
      throw e;
    });
    const projects = await tx.project.findMany({ where: { orgId, archivedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
    return { found: true, changed: count === 1, projectIds: projects.map((p) => p.id) };
  }

  /**
   * #482 operator door (Jagrut's "yes door", 19 Oct 2026) — who can manage each live project: the owners and
   * admins of every company, and the active members of every live project with their role. The operator
   * otherwise answers "who is on Samumil, and is Chitrang an owner?" by pasting a Prisma block into the
   * Coolify terminal. Stated here because every table it reads is orgs-owned. A plain read: it lists, it
   * authorises nothing, and it returns names and one contact each, never a credential.
   */
  async operatorRoster(tx: OrgsParticipantClient | Prisma.TransactionClient): Promise<{
    companies: Array<{ id: string; name: string; qaOnly: boolean; managers: Array<{ name: string; contact: string | null; role: string }> }>;
    projects: Array<{ id: string; name: string; companyId: string; company: string; members: Array<{ name: string; contact: string | null; role: string; discipline: string | null }> }>;
  }> {
    const client = tx as OrgsParticipantClient;
    const managers = await client.$queryRawUnsafe<Array<{ orgId: string; orgName: string; qaOnly: boolean; name: string; contact: string | null; role: string }>>(
      `SELECT o."id" AS "orgId", o."name" AS "orgName", o."qaOnly", u."name", COALESCE(u."email", u."phone") AS "contact", om."role"
         FROM "Org" o
         LEFT JOIN "OrgMembership" om ON om."orgId" = o."id" AND om."role" IN ('owner', 'admin')
         LEFT JOIN "User" u ON u."id" = om."userId"
        ORDER BY o."name" ASC, o."id" ASC, om."role" DESC, u."name" ASC`,
    );
    const members = await client.$queryRawUnsafe<Array<{ projectId: string; projectName: string; companyId: string; company: string; name: string | null; contact: string | null; role: string | null; discipline: string | null }>>(
      `SELECT p."id" AS "projectId", p."name" AS "projectName", o."id" AS "companyId", o."name" AS "company",
              u."name", COALESCE(u."email", u."phone") AS "contact", m."role", m."discipline"
         FROM "Project" p
         JOIN "Org" o ON o."id" = p."orgId"
         LEFT JOIN "Membership" m ON m."projectId" = p."id" AND m."status" = 'active'
         LEFT JOIN "User" u ON u."id" = m."userId"
        WHERE p."archivedAt" IS NULL
        ORDER BY p."id" ASC, m."role" ASC, u."name" ASC`,
    );
    const companies = new Map<string, { id: string; name: string; qaOnly: boolean; managers: Array<{ name: string; contact: string | null; role: string }> }>();
    for (const r of managers) {
      const c = companies.get(r.orgId) ?? { id: r.orgId, name: r.orgName, qaOnly: r.qaOnly === true, managers: [] };
      if (r.role) c.managers.push({ name: r.name, contact: r.contact, role: r.role });
      companies.set(r.orgId, c);
    }
    // `companyId` ties a project to its row in `companies` (company names are not unique; Codex P2 on #981);
    // a live project with nobody on it is still listed, with no members, so an empty project shows as empty
    const projects = new Map<string, { id: string; name: string; companyId: string; company: string; members: Array<{ name: string; contact: string | null; role: string; discipline: string | null }> }>();
    for (const r of members) {
      const pr = projects.get(r.projectId) ?? { id: r.projectId, name: r.projectName, companyId: r.companyId, company: r.company, members: [] };
      if (r.role) pr.members.push({ name: r.name ?? '', contact: r.contact, role: r.role, discipline: r.discipline });
      projects.set(r.projectId, pr);
    }
    return { companies: [...companies.values()], projects: [...projects.values()] };
  }

  /**
   * The two facts a DEPLOYMENT guard needs about this database's project population: how many
   * projects it holds, and whether a named anchor project is one of them.
   *
   * Phase 6 unit 4c-iii-r, Codex round 2 (P1). The deploy-time `decisions.inbox` repair proves it
   * is connected to the database it was configured for before it trusts any repair it performs,
   * and it did that by reading `Project` directly from the platform projections module. `Project`
   * is orgs-owned, and the rule at the top of this file applies without exception: not being
   * read-encapsulated makes such a read representable, not legitimate. A future change to how this
   * module scopes or hides projects — archival, tenancy, soft-deletion — would silently stop
   * reaching a guard that decides whether a production deploy may serve.
   *
   * So the question is asked here, of the owner, in ONE round trip against the caller's own
   * connection: the repair holds a session advisory lock across its whole body, and two separate
   * reads would be two more places for that connection contract to be got wrong.
   *
   * Deliberately COUNTS EVERY project row, archived included, and asks only that the anchor EXISTS.
   * This is an identity question — "is this the database I was configured for" — not an authority
   * question, and archiving a project does not make a database a different database. The narrower
   * predicates above are for deciding what may be WRITTEN; borrowing one here would make a routine
   * archival look like a wrong-database misconfiguration and refuse the deploy.
   */
  async deploymentProjectIdentity(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    anchorProjectId: string,
  ): Promise<{ projectCount: number; anchorPresent: boolean; projectIds: string[] }> {
    // The IDS, not only the counts (Codex F3 on `bee2ed9`). The caller's next act is a projection
    // rebuild over every project, and the rebuild used to enumerate `Project` itself from the
    // platform module -- so routing only the count through this channel moved the smaller read and
    // left the larger one in place. Returning the ids lets the caller PASS them in, and the whole
    // deploy path then reads this table exactly once, here, in the module that owns it.
    //
    // Ordered by id so the caller's rebuild order is deterministic, matching what the rebuild did
    // for itself.
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "Project" ORDER BY "id" ASC`,
    );
    const projectIds = rows.map((row) => row.id);
    return {
      projectCount: projectIds.length,
      anchorPresent: projectIds.includes(anchorProjectId),
      projectIds,
    };
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
  ): Promise<{ id: string; name: string } | null> {
    if (!identifier) return null;
    // Both values bind as parameters; nothing user-controlled is interpolated into the SQL text.
    // 4d-ii-a / A1 — the display name comes back with the id, so a caller that attributes an act to
    // this identity has the owner's name for it rather than reading `User` itself.
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT "id", "name" FROM "User" WHERE "id" = $1 OR "email" = $1 ORDER BY ("id" = $1) DESC LIMIT 1`,
      identifier,
    );
    return rows[0] ?? null;
  }

  /**
   * #482 site photos — who added each photo, as the project may show it: the uploader's name and their role
   * on THIS project. Only people tied to this project are named: anyone with a membership row here (a removed
   * member keeps the role they had, since the photo was added while they held it), or an owner/admin of the
   * project's org (named, with no project role, as they reach it through the org). An id that is neither, such
   * as a stray or imported `uploadedBy`, is left out, so no one outside the project is ever named.
   */
  async projectUploaders(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    userIds: readonly string[],
  ): Promise<Map<string, { name: string; role?: string }>> {
    if (userIds.length === 0) return new Map();
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ id: string; name: string; role: string | null }>>(
      `SELECT u."id", u."name", m."role" FROM "User" u
         LEFT JOIN "Membership" m ON m."projectId" = $1 AND m."userId" = u."id"
        WHERE u."id" = ANY($2::text[])
          AND (m."userId" IS NOT NULL OR EXISTS (
            SELECT 1 FROM "Project" p
              JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."userId" = u."id" AND om."role" IN ('owner', 'admin')
             WHERE p."id" = $1))`,
      projectId, [...userIds],
    );
    return new Map(rows.map((r) => [r.id, { name: r.name, ...(r.role ? { role: r.role } : {}) }]));
  }

  /**
   * Phase 6 task 4a, round 3 (Codex P2) — does `userId` hold an ACTIVE membership on `projectId`,
   * the row read under `FOR UPDATE` in the caller's transaction?
   *
   * ATTRIBUTION, not authority — deliberately NO org owner/admin arm. The caller is about to
   * write this user as the FK-bound author of a permanent project fact (e.g.
   * `Decision.withdrawnById` → `Membership(projectId, userId)`), and the org-super-admin path
   * has no `Membership` row to bind: a caller that wants STANDING asks `hasProjectRoleStanding`
   * (org arm included); a caller that must ATTRIBUTE asks this, and refuses with its own answer
   * when the row is absent or inactive — before the FK turns the refusal into a rollback.
   *
   * The lock is the point (the `activities.complete` precedent): a concurrent member removal
   * serializes on the membership row, so the attribution the caller writes is the one that was
   * true when its transaction committed. First spelled as a raw `Membership` read inside the
   * decisions service — an undeclared decisions→orgs edge; the owner now answers, and the
   * cross-module-graph ratchet keeps raw `Membership` SQL from reappearing outside this module.
   */
  async lockActiveMembership(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status" FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE`,
      projectId, userId,
    );
    return rows[0]?.status === 'active';
  }

  /**
   * Phase 6 task 4b (§A.1) — the NAMED-DECIDER binding read: resolve a membership ID to its
   * ACTIVE row, LOCKED in the caller's transaction, returning the user identity a holder
   * designation displays and dispatches to. `Membership` is orgs-owned; the decisions service
   * asks the owner through this declared participant edge (the `lockActiveMembership` sibling),
   * never with a raw `tx.membership` read. Returns null when the id names nobody here or the
   * row is not active — the caller refuses with its own answer.
   */
  async lockActiveMembershipById(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    membershipId: string,
  ): Promise<{ userId: string; name: string; role: string } | null> {
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<
      Array<{ userId: string; name: string; role: string; status: string }>
    >(
      `SELECT m."userId" AS "userId", u."name" AS "name", m."role" AS "role", m."status" AS "status"
         FROM "Membership" m JOIN "User" u ON u."id" = m."userId"
        WHERE m."projectId" = $1 AND m."id" = $2
          FOR UPDATE OF m`,
      projectId, membershipId,
    );
    const row = rows[0];
    return row && row.status === 'active' ? { userId: row.userId, name: row.name, role: row.role } : null;
  }

  /**
   * #1061 — the user behind each of `membershipIds` on `projectId`, whatever the row's status. A plain read
   * with no lock: the decision forward calls it under the project readiness key, which every membership
   * writer also takes, to name the people whose standing anchors it must take before any row. Ids that name
   * nobody here are left out.
   */
  async membershipUserIds(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    membershipIds: readonly string[],
  ): Promise<string[]> {
    if (membershipIds.length === 0) return [];
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Membership" WHERE "projectId" = $1 AND "id" = ANY($2::text[])`,
      projectId, [...membershipIds],
    );
    return rows.map((r) => r.userId);
  }

  /**
   * Phase 6 task 4b (§B.2) — EFFECTIVE role standing for a `(projectId, role)`: active
   * memberships in the role plus, for `pmc`, membership-less owner/admin standing on the
   * project's org (the same precedence as authorization). The DB primitive
   * `phase6_effective_role_standing` states the same rule for the seal layer; this is the
   * service-path reading of it through the owner.
   */
  /**
   * Phase 6 task 4b (§A.3 rounds 14–16) — is a push-subscription LINK's recorded credential
   * version still the user's CURRENT one? `User.credentialVersion` is orgs-owned; the platform
   * push claim reads it through this declared participant edge, never the table. A missing user
   * or a bumped version (password reset, server-side session kill) makes the link STALE — the
   * claim treats it as unlinked until the next authenticated open re-attributes it.
   */
  async sessionStillValid(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    userId: string,
    recordedVersion: number,
  ): Promise<boolean> {
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ v: number }>>(
      `SELECT "credentialVersion" AS v FROM "User" WHERE "id" = $1`,
      userId,
    );
    return rows.length > 0 && Number(rows[0]!.v) === recordedVersion;
  }

  async effectiveRoleStanding(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    role: string,
  ): Promise<number> {
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT phase6_effective_role_standing($1, $2) AS n`,
      projectId, role,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Phase 6 task 4b, round-1 Codex F5 — WHO currently holds a role's effective standing on this
   * project: the user ids behind {@link effectiveRoleStanding}'s count (active memberships of
   * the role, plus — for `pmc` — the membership-less org owner/admin arm under the same
   * explicit-membership precedence). The decider push family's role claims deliver ONLY to
   * these users' currently-valid links, never to a subscription's stored role — a removed
   * member's device stops receiving role-held decision titles the moment their standing ends.
   */
  async effectiveRoleHolderUserIds(
    tx: OrgsParticipantClient | Prisma.TransactionClient,
    projectId: string,
    role: string,
  ): Promise<string[]> {
    // Phase 6 task 4d (§A.2, the WINDOW RULE) — the `architect` audience is the KERNEL register from
    // 4d-ii (no architect can exist before 4d-iii, so the two implementations never coexist for a
    // reachable set); `pmc`/`client` keep this delivered orgs-truth SQL while `rollout.phase6_4d` reads
    // `reserved`, because a racing membership-less owner may lack their fanned-out `pmc` row in the
    // window, and move to the register once it reads `open` (4d-iii flips it after the re-projection)
    const client = tx as OrgsParticipantClient;
    if (role === 'architect' || ((role === 'pmc' || role === 'client') && (await readPhase6_4dRollout(client)) === 'open')) {
      return RoleStandingQuery.holderUserIds(client, projectId, role);
    }
    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT m."userId" FROM "Membership" m
        WHERE m."projectId" = $1 AND m."status" = 'active' AND m."role" = $2
       UNION
       SELECT om."userId" FROM "Project" p
         JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."role" IN ('owner', 'admin')
        WHERE p."id" = $1 AND $2 = 'pmc'
          AND NOT EXISTS (
            SELECT 1 FROM "Membership" m2
             WHERE m2."projectId" = $1 AND m2."userId" = om."userId" AND m2."status" = 'active'
          )`,
      projectId, role,
    );
    return rows.map((r) => r.userId);
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
    /**
     * `lock: false` is a READING of the same answer, for a screen that reports what an approval
     * would be allowed (the claim bundle's payment preflight). It takes neither the row locks nor
     * the readiness lock: a read holding the standing rows sat in front of `approve()`, which locks
     * them after the readiness lock and the bill, and deadlocked against it. The command re-decides
     * under its locks, so a reading that goes stale is refused there, never acted on.
     */
    { lock = true }: { lock?: boolean } = {},
  ): Promise<{ standing: false } | { standing: true; ceiling: Prisma.Decimal | null }> {
    // ONE statement of the rule, under the lock. `forUpdate` is what makes this an authority
    // decision rather than a reading of one: the downgrade waits for this transaction.
    const entitled = await this.hasProjectRoleStanding(tx, projectId, userId, roles, { forUpdate: lock });
    if (!entitled) return { standing: false };

    const rows = await (tx as OrgsParticipantClient).$queryRawUnsafe<Array<{ approvalLimit: Prisma.Decimal | null }>>(
      `SELECT "approvalLimit" FROM "Membership"
        WHERE "projectId" = $1 AND "userId" = $2 AND "status" = 'active'`,
      projectId, userId,
    );
    if (rows.length > 0) return { standing: true, ceiling: rows[0]!.approvalLimit ?? null };
    // a reading answers from its snapshot: the org arm, unlimited, with nothing to serialize
    if (!lock) return { standing: true, ceiling: null };

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
    // The other half of the rename serialization: a source attach conflicts with a rename in
    // flight, so the two orders are the only two outcomes and "counted one, then a second
    // appeared" is not among them.
    await tx.$queryRaw`SELECT "id" FROM "ExternalParty" WHERE "id" = ${partyId} FOR UPDATE`;
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
    // LOCK the association before counting what justifies it. Counting and then deleting is a
    // read followed by a write, and between the two another transaction can add the source that
    // makes the association necessary: a vendor binding commits, this delete cascades the source
    // it just wrote, and the project ends with a bound vendor the resolver cannot see.
    //
    // The lock closes it from both sides. A source insert takes a KEY SHARE lock on its parent
    // association through the foreign key, which conflicts with this FOR UPDATE — so a competing
    // bind either happens entirely before the count (and the count sees it), or blocks until this
    // transaction commits and then fails on the parent that is no longer there. A deterministic
    // failure the caller retries, rather than a silently incoherent commit.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ProjectParty"
       WHERE "projectId" = ${projectId} AND "partyId" = ${partyId}
       FOR UPDATE`;
    if (locked.length === 0) return;

    const [companies, vendors] = await Promise.all([
      tx.projectPartyCompanySource.count({ where: { projectId, partyId } }),
      tx.projectPartyVendorSource.count({ where: { projectId, partyId } }),
    ]);
    if (companies + vendors > 0) return;
    await tx.projectParty.deleteMany({ where: { projectId, partyId } });
  }

  /**
   * Rename the canonical party a directory row represents — permitted ONLY while that row is the
   * party's single justification.
   *
   * A `ProjectCompany` is now evidence of WHO a firm is, not just a directory entry, so leaving
   * `name` freely rewritable would let an admin create "ACME", collect its party, and then PATCH
   * the row to "Beta": the party a future resolver keys on still says ACME while the only row
   * describing it says something else.
   *
   * Renaming a SHARED party is refused rather than propagated, because the other origin never
   * agreed to it — a vendor binding and a directory row on one party are one firm, and renaming
   * the firm from one of its two faces is the operator's reconciliation decision, not a
   * side effect of a directory edit. (Authority rows do not exist until 6.2; that refusal is
   * additive on top of this one, not a replacement for it.)
   *
   * **The count is ORG-WIDE, and the project scope it started with was a bug.** `ExternalParty`
   * is owner-org-scoped: one row, one name, read by every project the firm reaches. Counting
   * sources within the editing project alone means that once 6.1b repoints a project-A company
   * onto a party already bound on project B, project A sees a single local source, calls itself
   * the sole evidence, and renames the firm project B is relying on. The check has to be scoped
   * the way the DATA is, not the way the caller happens to be.
   */
  async renamePartyForSoleSource(
    tx: Prisma.TransactionClient,
    input: { partyId: string; name: string },
  ): Promise<{ renamed: boolean; sharedWith: number }> {
    const { partyId, name } = input;
    // LOCK THE PARTY ROOT before counting. Counting and then renaming is a read followed by a
    // write, and between them a bind or a repoint can attach a SECOND source: the count says
    // "sole evidence", the attach commits, and the rename lands on a firm that is now shared —
    // renamed behind the back of an origin that was written under the old identity.
    //
    // `attachPartySource` takes the same lock, which is what makes this a serialization and not
    // just a longer read. The party root is the right thing to lock because the party is what the
    // rename CHANGES; locking the sources would leave the one being created unlocked.
    await tx.$queryRaw`SELECT "id" FROM "ExternalParty" WHERE "id" = ${partyId} FOR UPDATE`;

    const [companies, vendors] = await Promise.all([
      tx.projectPartyCompanySource.count({ where: { partyId } }),
      tx.projectPartyVendorSource.count({ where: { partyId } }),
    ]);
    const others = companies + vendors - 1;
    if (others > 0) return { renamed: false, sharedWith: others };
    await tx.externalParty.update({ where: { id: partyId }, data: { name } });
    return { renamed: true, sharedWith: 0 };
  }

}
