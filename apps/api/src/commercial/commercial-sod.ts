import { Prisma as PrismaRuntime, type Prisma } from '@prisma/client';
import type { SodGrantState as GrantStateName } from '@vitan/shared';
import { ConflictException } from '@nestjs/common';
import type { OrgsParticipant } from '../orgs/orgs.participant';

/**
 * The claim REVISION a caller says they read, checked against what is true under the bill lock.
 *
 * One function for the grant, the certification and the approval, because it is one rule and this
 * PR's audit is largely the story of the same rule being spelled once per call site. Optional
 * in-process (no rendered fact to pin, not attacker-reachable); REQUIRED at every HTTP boundary,
 * which is where a posted or replayed body can carry a revision nobody read.
 */
export function assertReviewedRevision(pinned: number | undefined, actual: number): void {
  if (pinned !== undefined && pinned !== actual) {
    throw new ConflictException(
      'This claim has moved on since you read it — money on it has changed, so this act would be recorded against a claim you have not seen. Reload and try again.',
    );
  }
}

/**
 * §I (7B-v) — everything `approve()` reads BEFORE it decides, in one place.
 *
 * Extracted rather than copied, and the distinction is the whole point of this unit. A
 * `certifier-may-not-approve` grant exists to excuse ONE act: an approval `approve()` would
 * otherwise refuse. So "may this grant be ISSUED?" and "could this grant be SPENT?" are the same
 * question, and a second answer to it is a second implementation that will drift — which is
 * exactly what happened to §I's two halves before `resolveSodGrant` unified them.
 *
 * `approve()` composes its decision from this context. The grant command asks the SAME function
 * whether an approval could consume what it is about to write. Neither restates the other's
 * preconditions, because restating them is the root this surface has paid five findings for:
 * every enumeration of them looked complete from the inside and was not.
 */
export interface ApprovalContext {
  certificateId: string;
  /** the version the grant must pin, because that is the one `approve()` resolves against */
  certificateVersionId: string;
  /** the ONLY actor `certifier-may-not-approve` blocks, and so the only one it can excuse */
  certifiedById: string;
  netPayable: Prisma.Decimal;
  approvedSoFar: Prisma.Decimal;
  /** §G bound 4's headroom. At zero no positive approval can ever be accepted. */
  remaining: Prisma.Decimal;
}

/**
 * The §H folds this needs, taken structurally rather than by importing the query service, so the
 * shared predicate does not create a cycle between the two services that read it.
 */
export interface ApprovalContextFolds {
  positionFor(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ certificateId: string; netPayable: Prisma.Decimal } | null>;
  approvedFor(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<Prisma.Decimal>;
}

/** `null` when the claim carries no live certification — there is nothing to approve, so nothing
 *  to authorise either. Read under whatever lock the caller already holds. */
export async function resolveApprovalContext(
  tx: Prisma.TransactionClient,
  folds: ApprovalContextFolds,
  projectId: string,
  billId: string,
): Promise<ApprovalContext | null> {
  const position = await folds.positionFor(tx, projectId, billId);
  if (!position) return null;
  const certificate = await tx.billCertificate.findFirstOrThrow({
    where: { projectId, id: position.certificateId },
    select: { certifiedById: true, versionId: true },
  });
  const approvedSoFar = await folds.approvedFor(tx, projectId, billId);
  const netPayable = new PrismaRuntime.Decimal(position.netPayable);
  return {
    certificateId: position.certificateId,
    certificateVersionId: certificate.versionId,
    certifiedById: certificate.certifiedById,
    netPayable,
    approvedSoFar,
    remaining: netPayable.sub(approvedSoFar),
  };
}

/**
 * §I (7B-v) — the ONE actor a `certifier-may-not-approve` grant may name right now, or `null`.
 *
 * There is at most one, and that is a fact about the rule rather than a simplification:
 * `approve()` consults a grant only when `certificate.certifiedById === actor`, so an
 * authorisation naming anybody else is never even looked at. Before this existed the command
 * checked that the named actor held approve STANDING — true of every pmc on the project — and
 * wrote a row nobody could spend.
 *
 * `null` therefore covers every reason at once, without any of them being a listed condition:
 * no live certification (nothing to approve), no headroom left (§G bound 4 admits no positive
 * amount), or the certifier is the caller (§I forbids a self-grant). A precondition added to
 * `approve()` lands here once and reaches the command and the read together.
 *
 * The COMMAND requires the actor it is given to equal this; the READ offers it, or offers nobody.
 * If the command would refuse, the form cannot have offered it.
 */
export function payableGrantActor(
  context: ApprovalContext | null,
  callerActorId: string,
  authority: { standing: false } | { standing: true; ceiling: Prisma.Decimal | null } | null,
  /** whether an authorisation for the certifier ALREADY stands on this claim — see
   *  `payableGrantOffer`, which is the only thing that should be computing this argument */
  liveGrantStands: boolean,
): string | null {
  if (!context) return null;
  if (context.certifiedById === callerActorId) return null;
  if (!authority?.standing) return null;
  if (liveGrantStands) return null;
  return payableHeadroom(context, authority).greaterThan(0) ? context.certifiedById : null;
}

/**
 * §I (7B-v) — the WHOLE issuability question, resolved once for every consumer.
 *
 * Codex round 2 (P2) is why this exists rather than the bare predicate above. Round 1 added an
 * `already stands` refusal to the COMMAND — a second authorisation can never be the one an approval
 * selects — and did not teach the READ the same rule, so the form kept offering a candidate the
 * command had just started rejecting. That is precisely the drift this unit was written to end,
 * introduced by one of its own corrections: a shared predicate stops being shared the moment a
 * caller adds a condition beside it instead of inside it.
 *
 * So the resolution — the folds, the certifier's approval authority, and whether an authorisation
 * already stands — lives HERE, and both the command and the claim read call this one function. A
 * condition added inside it reaches every consumer; a condition added beside it in a caller is the
 * bug this signature exists to make awkward.
 */
export async function payableGrantOffer(
  tx: Prisma.TransactionClient,
  deps: { folds: ApprovalContextFolds; orgs: OrgsParticipant },
  projectId: string,
  billId: string,
  callerActorId: string,
  rule: string,
  approveRoles: readonly string[],
  asOf: { status: string; lifecycleVersion: number },
): Promise<{
  actorId: string | null;
  context: ApprovalContext | null;
  authority: { standing: false } | { standing: true; ceiling: Prisma.Decimal | null } | null;
  liveGrantStands: boolean;
}> {
  const context = await resolveApprovalContext(tx, deps.folds, projectId, billId);
  if (context === null) {
    return { actorId: null, context: null, authority: null, liveGrantStands: false };
  }
  // the CERTIFIER's own authority — standing AND ceiling — because they are the only actor this
  // rule can excuse and `approve()` applies both to them
  const authority = await deps.orgs.approvalAuthorityFor(
    tx, projectId, context.certifiedById, approveRoles,
  );
  // …and whether one already stands. Resolved through the SAME function the spend path consumes
  // with, against the certificate's version, so "an approval would select it" is not re-derived.
  const existing = await resolveSodGrant(
    tx, deps.orgs, projectId, billId, context.certificateVersionId, rule,
    context.certifiedById, false, asOf,
  );
  const liveGrantStands = existing.state === 'live';
  return {
    actorId: payableGrantActor(context, callerActorId, authority, liveGrantStands),
    context, authority, liveGrantStands,
  };
}

/**
 * The largest approval this actor could get accepted right now — **the** number, not two bounds
 * kept side by side.
 *
 * Codex round 1 (P1) found the ceiling missing here, and the finding is the unit's own root
 * committed inside the fix for it: this predicate was written to be "derived from what `approve()`
 * does", and it was derived from the first three things `approve()` checks. §G bound 4 is not the
 * only thing standing between an actor and an accepted approval — `assertApprovalAuthority`
 * compares the actor's CUMULATIVE approved total against their ceiling, so a certifier with a zero
 * or exhausted limit can never have any positive amount accepted, and a grant naming them is
 * exactly the unspendable authorisation this unit exists to refuse.
 *
 * Folding the two into one quantity is the difference between a derivation and a longer list.
 * `approve()` accepts an amount `a > 0` iff `a <= remaining` AND `approvedSoFar + a <= ceiling`,
 * so a positive amount exists iff `min(remaining, ceiling - approvedSoFar) > 0`. One number, and a
 * third money bound added to `approve()` narrows it here rather than needing a fourth clause.
 */
function payableHeadroom(
  context: ApprovalContext, authority: { standing: true; ceiling: Prisma.Decimal | null },
): Prisma.Decimal {
  if (authority.ceiling === null) return context.remaining;
  const byCeiling = new PrismaRuntime.Decimal(authority.ceiling).sub(context.approvedSoFar);
  return byCeiling.lessThan(context.remaining) ? byCeiling : context.remaining;
}

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
  /**
   * The claim state this caller is resolving AGAINST — read under its own lock, or read by the
   * screen that is about to display the answer.
   *
   * Passed in rather than read here, and that is not plumbing: `certify` inserts its certificate
   * BEFORE it asks this question, and a certificate is a payment-fold source, so the act had
   * already advanced the claim's revision by the time the resolver looked. Reading "now" made
   * every certification refuse its own valid authorisation. An authority is judged against the
   * claim the ACT is being performed on, which only the caller knows.
   */
  asOf: { status: string; lifecycleVersion: number },
): Promise<SodGrantResolution> {
  const live = await tx.sodGrant.findMany({
    // a RETIRED grant is history: this release cannot judge what its approver reviewed, so it
    // authorises nothing and must not be a candidate — nor block the replacement that replaces it
    where: { projectId, billId, versionId, rule, actorId, consumedAt: null, retiredAt: null },
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
  const currentStatus = asOf.status;
  const currentVersion = asOf.lifecycleVersion;
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
    where: { projectId, billId, rule, actorId, consumedAt: null, retiredAt: null },
  });
  return { state: stale > 0 ? 'stale-version' : 'none' };
}
