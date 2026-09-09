import { Prisma } from '@prisma/client';
import type { OrgsParticipant, OrgsParticipantClient } from '../orgs/orgs.participant';

/**
 * WHEN DOES A CORRECTIVE ASSIGNMENT BIND? — the one place that answers it.
 *
 * `Inspection.assigneeId` names whose corrective work a re-inspection is. Three different questions
 * are asked about that name, and before this module each site answered its own:
 *
 *   - `decide` asks "may I WRITE this name?" (assignment-time eligibility, with the PMC's explicit
 *     self-assignment as its own admitted case),
 *   - `submit` asks "does this name still EXCLUDE everybody else?",
 *   - the read boundary asks "whose field view does this checklist belong on?".
 *
 * The last two are the SAME question and must never disagree: a checklist `submit` will accept from
 * engineer B is a checklist B has to be able to open, and one it refuses is one B must not see as
 * theirs to fill. Round 6 of #571's review answered the `submit` half inline and left the read half
 * filtering on the stored id, so the only callers the new rule made eligible could not reach the
 * work — the rule was written where the finding was reported instead of over the set of sites that
 * carry it, which is the generator this PR's review has now produced four times. The remedy is not a
 * third copy of the predicate: it is that there is only ever one, HERE, and every site calls it.
 *
 * The rule itself: AN ASSIGNMENT BINDS ONLY WHILE ITS ASSIGNEE CAN STILL DO THE WORK. The guard
 * exists so a second engineer is not recorded as having done somebody's remedial work — a claim
 * about attribution, which is meaningless once the named person cannot act at all. A removed or
 * re-roled assignee, and a PMC who took the work by naming themselves but holds no checklist screen,
 * are both in that position: refusing everyone else does not protect their attribution, it strands
 * the work. When the assignment stops binding the row keeps the name as the record of who was asked,
 * and the checklist returns to the ordinary role gate.
 */

/** The roles a corrective assignment may name, and the roles that keep one binding.
 *
 *  Engineer only, deliberately. #571's review round 3 asked for the contractor half-state to be
 *  resolved and round 4 resolved it by NARROWING: a contractor has no checklist screen, no inbox
 *  task, a redirected route and no `media.upload` grant, so a FAILED item's mandatory photo is
 *  unattachable and the work cannot be finished. Until that surface exists as its own unit, the
 *  assignee set is the roles that can actually do the work.
 *
 *  Pinned in CI three ways (`inspections.contract.test.ts`): every role here must reach the submit
 *  route, and the SQL copy of this list inside the writer fence migration must name exactly these
 *  roles — the fence enforces the same rule at the database, where a writer this deployment does not
 *  control can still be reached, and a silently diverging list there would be the rule disagreeing
 *  with itself across the two boundaries. */
export const CORRECTIVE_ROLES = ['engineer'];

/** The assignee set as prose, DERIVED from {@link CORRECTIVE_ROLES} so a refusal can never promise a
 *  role the rule refuses. Rendering it by hand is how "engineer or contractor" outlived the set. */
export const CORRECTIVE_ROLES_PHRASE = CORRECTIVE_ROLES.length === 1
  ? `an active ${CORRECTIVE_ROLES[0]}`
  : `an active ${CORRECTIVE_ROLES.slice(0, -1).join(', ')} or ${CORRECTIVE_ROLES[CORRECTIVE_ROLES.length - 1]}`;

/** Does this membership row let its holder do corrective work on their own account? The predicate
 *  `decide` applies when it NAMES an assignee, so assignment-time and binding-time agree by
 *  construction. (`decide` additionally admits a PMC naming THEMSELVES — that is a separate,
 *  explicitly audited case about who may be written, not about whether the write binds.)
 *
 *  Judges a row `decide` has ALREADY read under its own `FOR UPDATE` — it re-states no query and
 *  reaches no orgs table itself, which is why it stays here while the QUERIES go to the owner. */
export function holdsCorrectiveRole(membership: { status: string; role: string } | null | undefined): boolean {
  return membership?.status === 'active' && CORRECTIVE_ROLES.includes(membership.role);
}

/**
 * Of these candidate assignees, which ones' assignments still BIND? One question, one predicate,
 * for every caller — the submit guard, the read boundary, and anything that follows them.
 *
 * ASKED OF THE OWNER, NOT OF THE TABLE (#571 round 8, finding 3). `Membership` is orgs-owned. An
 * earlier spelling of this module queried it directly and justified that in a comment: the model is
 * not `readEncapsulated`, and `activities.query.ts` and `drawings.service.ts` already read it. That
 * justification was wrong, and `orgs.participant.ts` says so in its own words — *"not being
 * read-encapsulated makes a read representable, not legitimate; the OWNER states the rule"* — twice,
 * once as the file's opening rule and once "without exception" for a later caller. Existing reads
 * elsewhere are precedent for the mistake, not permission for it. `OrgsParticipant` is the
 * cycle-exempt channel the repository already uses for exactly this, and inspections declares the
 * `orgs` workflow-participant edge for it (`inspections.manifest.ts`), so `dependsOn` stays empty
 * and the module graph stays acyclic.
 *
 * `effectiveRoleHolderUserIds` is the owner's own enumeration of who holds a role on the project.
 * For a non-`pmc` role its org-owner/admin arm is inert by construction (the arm is gated on the
 * role being `pmc`), so for `CORRECTIVE_ROLES` it is exactly "an ACTIVE membership in that role" —
 * the same predicate {@link assignmentStillBinds} asks per user, which is why the two can never
 * disagree. Asked once per role and unioned, so the set is derived from {@link CORRECTIVE_ROLES}
 * rather than from a hand-written query.
 *
 * Stated honestly: this enumerates every corrective-role holder on the project rather than only the
 * candidates, so it reads more rows than the direct query it replaces. That is the cost of asking
 * the owner instead of the table, it is one indexed query per role per read, and it is bounded by
 * project membership — the same human scale `readiness-lock.ts` reasons about for a far coarser
 * lock. Per-candidate calls would be narrower and unbounded in COUNT; one bounded query is the
 * better trade at this scale.
 *
 * Runs against whatever client the caller passes, so a caller inside a transaction that already
 * holds the project's readiness key gets an answer no membership change can overtake before it
 * commits (#571 round 7, finding 2). A read outside a transaction is still correct for a read-only
 * caller, which is what the snapshot and module reads are.
 */
export async function bindingAssigneeIds(
  orgs: Pick<OrgsParticipant, 'effectiveRoleHolderUserIds'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const candidates = new Set(candidateIds);
  if (candidates.size === 0) return new Set();
  const binding = new Set<string>();
  for (const role of CORRECTIVE_ROLES) {
    for (const userId of await orgs.effectiveRoleHolderUserIds(client, projectId, role)) {
      if (candidates.has(userId)) binding.add(userId);
    }
  }
  return binding;
}

/**
 * Does THIS one assignee still hold the work, judged under a row lock?
 *
 * The submit path's authoritative check. `forUpdate` locks the standing rows before the answer is
 * read, so a concurrent re-role or reactivation of an EXISTING membership waits for this
 * transaction — belt to the readiness key's braces, and the owner's own documented caveat applies:
 * `FOR UPDATE` locks rows that exist, so it closes the change-of-an-existing-row race, which is the
 * shape a stranded assignee's return actually takes (`MembersService.add` upserts onto the same
 * `(projectId, userId)` row).
 */
export function assignmentStillBinds(
  orgs: Pick<OrgsParticipant, 'hasProjectRoleStanding'>,
  client: OrgsParticipantClient | Prisma.TransactionClient,
  projectId: string,
  assigneeId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<boolean> {
  return orgs.hasProjectRoleStanding(client, projectId, assigneeId, CORRECTIVE_ROLES, opts);
}
