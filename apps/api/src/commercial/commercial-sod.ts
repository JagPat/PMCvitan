import type { Prisma } from '@prisma/client';
import type { SodGrantState as GrantStateName } from '@vitan/shared';
import type { OrgsParticipant } from '../orgs/orgs.participant';

/**
 * §I — WHICH authorisation, if any, stands for one actor on one claim version, under one rule.
 *
 * ONE implementation, read by BOTH halves of §I.
 *
 * The certification half (`evidence-recorder-may-not-certify`) and the payment half
 * (`certifier-may-not-approve`) are the same question asked of different rows, and until this file
 * existed they were two near-identical private methods in two services. That is not a stylistic
 * observation: it is the defect Codex found on the first head of 7B-iii-h. The certification
 * resolver learned that a grant records the claim STATE its approver reviewed, and the payment
 * resolver — thirty lines of the same logic in the next file over — did not, so an authorisation
 * written over a claim nobody had approved anything on could still release money after someone had.
 *
 * The service's own §I comments had already recorded this exact shape twice ("two implementations
 * of one question, and only the one a finding named ever got fixed"). Both callers now read one
 * predicate, so the next fact added to a grant cannot reach one half and miss the other.
 *
 * TWO parameters carry the callers' genuine differences, and nothing else does:
 *
 *   - `rule` — an authority issued so a store user could CERTIFY is not permission for anyone to
 *     approve that claim's payment. §I has two halves and one row must never satisfy the other.
 *   - `forUpdate` — the CALLER'S INTENT, not a second rule. An act is an authority DECISION and
 *     reads standing under a lock, because a concurrent downgrade must not commit behind an
 *     authority it granted; a screen is asking what is true now and locks nothing. The predicate is
 *     identical either way — only whether the answer is held differs.
 *
 * The SHAPE is deliberate and was itself bought with three Codex rounds (Task 5's 8, 9 and 10):
 * "select an arbitrary candidate, then check it" answers a different question from "select a
 * candidate that is VALID" whenever more than one can exist, and the live-grant scope is
 * deliberately wide enough for more than one — a downgraded approver's inert row beside a valid
 * replacement. So every filter is INSIDE the selection and stale rows are simply not candidates.
 */
export type SodGrantResolution =
  | { state: 'live'; grant: { id: string; approverId: string; reason: string } }
  | { state: Exclude<GrantStateName, 'live'> };

export async function resolveSodGrant(
  tx: Prisma.TransactionClient,
  orgs: OrgsParticipant,
  projectId: string,
  billId: string,
  versionId: string,
  rule: string,
  actorId: string,
  forUpdate: boolean,
): Promise<SodGrantResolution> {
  const live = await tx.sodGrant.findMany({
    where: { projectId, billId, versionId, rule, actorId, consumedAt: null },
    select: {
      id: true, approverId: true, reason: true, reviewedStatus: true, reviewedLifecycleVersion: true,
    },
    orderBy: { grantedAt: 'asc' },
  });

  // 7B-iii-h — the reviewed state must still HOLD, checked where the authority is SPENT.
  //
  // Checking it only at issue proves nothing here: the claim version does NOT change as a claim
  // moves through its lifecycle, so an authorisation given over a `submitted` claim would otherwise
  // be spent on a `verified` one, and one given while nothing was approved would be spent after
  // somebody had approved ₹10. A grant whose reviewed evidence is NULL predates these columns and
  // records nothing about what was reviewed — unusable rather than guessed, because guessing here
  // puts words in an approver's mouth.
  //
  // The identity is the STATUS **and** the monotonic `lifecycleVersion`, and the second term is the
  // load-bearing one (Codex round 2). A status label is a description, not an identity: §F derives
  // the payment status from the folds and the derivation genuinely RETURNS to a label it has left —
  // `certified → paid → certified`, when a release raises the payable again. Comparing the label
  // alone would bring an authorisation given when nothing was approved back to life after ₹90 had
  // been authorised and paid. A counter that only moves forward cannot be re-entered.
  const bill = await tx.vendorBill.findFirst({
    where: { projectId, id: billId }, select: { status: true, lifecycleVersion: true },
  });
  const currentStatus = bill?.status ?? null;
  const currentVersion = bill?.lifecycleVersion ?? null;
  const reviewHolds = (c: { reviewedStatus: string | null; reviewedLifecycleVersion: number | null }): boolean =>
    c.reviewedStatus !== null && c.reviewedStatus === currentStatus
    && c.reviewedLifecycleVersion !== null && c.reviewedLifecycleVersion === currentVersion;

  for (const candidate of live) {
    if (!reviewHolds(candidate)) continue;
    // standing is the ORGS module's question, asked through the owner rather than re-derived here
    if (await orgs.hasProjectRoleStanding(tx, projectId, candidate.approverId, ['pmc'], { forUpdate })) {
      return { state: 'live', grant: candidate };
    }
  }

  // the two non-live reasons are distinguished because they need different remedies: a stale review
  // needs re-authorising against what is true now, a lost approver needs a different pmc
  if (live.length > 0) {
    return { state: live.some(reviewHolds) ? 'approver-lost-standing' : 'stale-review' };
  }

  // version-pinned: an amendment is a DIFFERENT claim, and permission over the one the approver
  // looked at should not silently carry over to one they never saw
  const stale = await tx.sodGrant.count({
    where: { projectId, billId, rule, actorId, consumedAt: null },
  });
  return { state: stale > 0 ? 'stale-version' : 'none' };
}
