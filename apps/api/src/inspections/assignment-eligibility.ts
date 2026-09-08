import { Prisma } from '@prisma/client';

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
 *  explicitly audited case about who may be written, not about whether the write binds.) */
export function holdsCorrectiveRole(membership: { status: string; role: string } | null | undefined): boolean {
  return membership?.status === 'active' && CORRECTIVE_ROLES.includes(membership.role);
}

/**
 * Of these candidate assignees, which ones' assignments still BIND? One query, one predicate, for
 * every caller — the submit guard, the read boundary, and anything that follows them.
 *
 * Takes any Prisma client so the answer can be read INSIDE a transaction that already holds the
 * project's readiness key: `MembersService.add`/`updateRole`/`remove` take that same key before they
 * write, so a caller that reads this under the lock cannot have the answer changed underneath it
 * before it commits (#571 round 7, finding 2). A read outside a transaction is still correct for a
 * read-only caller, which is what the snapshot and module reads are.
 *
 * `Membership` is orgs-owned but NOT read-encapsulated (`orgs.manifest.ts` declares no
 * `readEncapsulated`), the same direct read `activities.query.ts` and `drawings.service.ts` already
 * make.
 */
export async function bindingAssigneeIds(
  client: Prisma.TransactionClient | { membership: { findMany: (args: unknown) => Promise<{ userId: string }[]> } },
  projectId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return new Set();
  const rows = await (client as Prisma.TransactionClient).membership.findMany({
    where: { projectId, userId: { in: ids }, status: 'active', role: { in: CORRECTIVE_ROLES } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}
