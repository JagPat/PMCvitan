import { normalizedBillNumber } from '@vitan/shared';

/**
 * Phase 5 Task 7B-iii-a (§M) — the COMMERCIAL twin of `labourKeys.ts`, born carrying the
 * PR-#208 two-key split and the eleven rounds of corrections labour paid for it:
 *
 *  - `idempotencyKey` — a fresh COMMAND-ATTEMPT identity (`newIdempotencyKey()`), minted once
 *    per deliberate user action, persisted on the outbox op, reused unchanged on retry so a
 *    lost response replays exactly once, and DIFFERENT for the next legitimate action.
 *  - `coalesceKey` — a deterministic EQUIVALENT-ACTION identity used only to dedupe an
 *    identical action WHILE one is pending (button disabled, second click ignored).
 *
 * Conflating the two was #208's finding 1: a permanent target-derived key blocked a legitimate
 * SECOND action on the same target and collided two distinct actions from one source.
 *
 * WHY THIS UNIT IS THE SMALLEST ONE. It carries three low-stakes writes and the whole lifecycle
 * every later §M unit reuses. Phase-3 Task 7 shipped that lifecycle beside its readiness reads
 * and then needed four corrections for it; establishing it here, on budget and attribution,
 * gets it independently reviewed BEFORE it carries certification or payment.
 */

/**
 * The budget key carries the AMOUNT; the pending TEST below does not.
 *
 * Labour round 7 is the reason both halves are needed and why neither alone is right. A key that
 * omits the value (`com:budget:<code>`) coalesces away a legitimate second set at a DIFFERENT
 * amount — the user deliberately changed the figure and the command is silently dropped. A
 * pending check that INCLUDES the value re-enables the button the moment the user edits the
 * input while the first command is still in flight, and the same head gets two revisions.
 *
 * So: the value is part of the identity (two different amounts are two different actions), and
 * the disable-while-pending test is prefix-matched on the stable part.
 */
export const budgetCoalesceKey = (input: { costHeadCode: string; amount: string; reason: string }): string =>
  payloadCoalesceKey('budget', input.costHeadCode, input);

/**
 * ── 7B-vi (§H) — DERIVE the coalesce identity, do not enumerate it ───────────────────────────
 *
 * `pr-317-convergence.md` records this lineage failing FOUR times at hand-listing the facts that
 * define a row: round 2 listed three preconditions and called it the rule, round 3 found three
 * more, round 4 widened the advance key by listing amount and reason, round 5 found the two that
 * list omitted (`method`, `reference`). A hand-picked subset always looks complete from the inside
 * — that is the property that makes this root recur, and why the fix cannot be a longer list.
 *
 * So: for a command whose identity IS its payload, two dispatches are the same action only if they
 * are the same INPUT. The tail is a deterministic, injective serialisation of the WHOLE object, so
 * **a field added to the command joins the identity automatically** — the property every
 * enumeration here lacked.
 *
 * The SCOPE prefix is kept and is not decoration. Several conflict predicates prefix-match these
 * keys (`isBudgetPendingForHead` asks "any budget set for this head, at any amount"), and an
 * opaque hash would silently break every one of them. Stable prefix for the predicates, derived
 * tail for the identity — neither half can be dropped without losing something real.
 *
 * Applied to BOTH commands that have this shape, not only the one a finding named. `setBudget`
 * carries `reason` and `budgetCoalesceKey` omitted it, so two corrections of one head at the same
 * amount coalesced and the second was dropped: the same defect, found by asking the question the
 * parked ledger told the next unit to ask rather than by another round of review.
 */
export const payloadCoalesceKey = (action: string, scope: string, input: unknown): string =>
  `com:${action}:${scope}:${canonicalPayload(input)}`;

/**
 * A stable, INJECTIVE serialisation: object keys sorted so field order cannot change the identity,
 * and every string JSON-escaped so no value can impersonate a separator. Joining raw values with
 * `:` would make `{a:'x:y',b:'z'}` and `{a:'x',b:'y:z'}` the same key — a collision that would
 * silently drop a legitimate second command, which is the exact failure this helper exists to end.
 *
 * `undefined` is dropped rather than encoded, so an optional field left unset and one absent from
 * the object are the same action. `null` is KEPT: an explicitly cleared reference is a different
 * input from one never given.
 */
export const canonicalPayload = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalPayload(v)}`).join(',')}}`;
};

/**
 * §H — an advance is APPEND-ONLY with no server ceiling, so two advances to one counterparty are
 * two FACTS, not a retry. Its identity is therefore its whole payload: `method` and `reference`
 * join automatically, and so would a sixth field. Settled by the `commercial.advances` read, which
 * is why that read lands in this unit BEFORE the control it settles.
 */
export const advanceCoalesceKey = (input: {
  vendorId: string; amount: string; reason: string; method: string; reference?: string | null;
}): string => payloadCoalesceKey('advance', input.vendorId, input);

/**
 * 7B-vi — the op → PERMISSION map, moved HERE to sit beside `COMMERCIAL_OUTBOX_OP_TYPES`.
 *
 * These are two registries that must agree about the same set, and they lived in two files. That
 * is how this unit shipped `payAdvance` in neither of them: the op dispatched with a valid key,
 * hydration did not recognise it, the flush did not count it as a settled commercial write, and
 * the durable dispatcher treated an unmapped op as needing NO client authority — so an engineer
 * session offline would have had a cash advance queued and reported saved, then 403'd and dropped.
 *
 * Four findings from one omission, and moving the lists together is the part that stops the next
 * one: `commercial-keys.test.ts` now asserts the two sets are IDENTICAL, so an op registered in
 * one and forgotten in the other fails rather than shipping half-wired. The unit's own root — a
 * hand-kept list that looks complete from the inside — one layer up from the keys it was written
 * to fix, and I had already noted this shape here once (the project-scope teardown), fixed that
 * instance, and not gone looking for the others.
 */
export const COMMERCIAL_OP_PERMISSION = {
  setCommercialBudget: 'commercial.budget.manage',
  defineCostHead: 'commercial.manage',
  reattributeCommitment: 'commercial.attribute',
  // 7B-iii-b — `commercial.measure` and `commercial.bill` are the ONLY two commercial
  // permissions admitting `engineer`, so this map is doing real work here rather than
  // restating "pmc": an engineer may measure and lodge, and may not certify or pay.
  takeMeasurement: 'commercial.measure',
  correctMeasurement: 'commercial.measure',
  recordVendorBill: 'commercial.bill',
  submitVendorBill: 'commercial.bill',
  amendVendorBill: 'commercial.bill',
  rejectVendorBill: 'commercial.bill',
  // 7B-iii-c-i — `commercial.verify` is pmc-only, and that separation is the point: the
  // engineer who lodged the claim may not be the one who verifies it. The map is what makes
  // the durable dispatcher refuse it, not just the screen that hides the button.
  beginVerification: 'commercial.verify',
  verifyVendorBill: 'commercial.verify',
  // 7B-iii-f — `commercial.certify` is DELIBERATELY separate from `commercial.verify` even
  // though both resolve to pmc today: certifying decides what is OWED, and the policy is the
  // source rather than a copy of its current answer. `commercial.sod.grant` is separate again —
  // it is the authority to EXCUSE the rule, which is a stronger thing than performing the act.
  certifyBill: 'commercial.certify',
  supersedeCertificate: 'commercial.certify',
  // 7B-iii-g — and the authorisation itself takes the stronger permission the comment above
  // already names. Mapped here rather than left out, because this map is what makes the DURABLE
  // dispatcher refuse it: the screen hiding a form is not a guarantee (Codex J1).
  grantSodException: 'commercial.sod.grant',
  // 7B-iii-d — SIX distinct permissions. They all resolve to pmc today and are named
  // separately anyway, exactly as `certify` and `sod.grant` are: the policy is the source, not
  // a copy of its current answer, and a later widening of one must not silently widen five.
  recordDeduction: 'commercial.deduct',
  releaseDeduction: 'commercial.deduct.release',
  approvePayment: 'commercial.approve-payment',
  recordPayment: 'commercial.record-payment',
  reversePayment: 'commercial.reverse-payment',
  // 7B-vi — the SEVENTH. Named separately for the same reason as the six above, and its
  // absence was a real hole rather than a tidiness gap: `dispatchCommercial` treats an
  // unmapped op as needing NO client authority, so an engineer session offline would have had
  // the advance queued and reported saved, then 403'd and discarded by the server.
  payAdvance: 'commercial.pay-advance',
} as const;

/** Whether ANY budget set for this cost head is still pending, at any amount (labour r7). */
export const isBudgetPendingForHead = (key: string, costHeadCode: string): boolean =>
  key.startsWith(`com:budget:${costHeadCode}:`);

/** Defining a cost head is idempotent on its CODE — the name is not a second identity. */
export const costHeadCoalesceKey = (code: string): string => `com:head:${code}`;

/**
 * The attribution key names the PO LINE and nothing else, because the line is the constrained
 * resource — §C says a re-attribution SUPERSEDES the active row rather than adding a second, so
 * exactly one attribution per line can be live.
 *
 * Labour round 5 is the lesson: a per-(worker, slice) key let two different workers each queue an
 * allocation against a one-slot slice, because neither matched the other's key. Keying on
 * (line, costHead) here would do the same thing — pick head A, then change your mind to head B
 * while A is in flight, and both are queued for one line. Keyed on the LINE, the second is
 * coalesced away and the button stays disabled until the first resolves.
 *
 * A genuine change of mind is still available: the key is released once the command resolves AND
 * the fresh bundle is on screen, so the next attribution dispatches under a new idempotency key.
 */
export const attributionCoalesceKey = (lineId: string): string => `com:attr:${lineId}`;

/** The §M commercial outbox op types shipped by this unit. */
export const COMMERCIAL_OUTBOX_OP_TYPES = [
  'setCommercialBudget', 'defineCostHead', 'reattributeCommitment',
  // 7B-iii-b — the engineer's writes join the SAME op-type set, so the hydration guard, the
  // pending rebuild and the flush reconcile cover them without a second registry to keep in sync.
  'takeMeasurement', 'correctMeasurement', 'recordVendorBill',
  'submitVendorBill', 'amendVendorBill', 'rejectVendorBill',
  // 7B-iii-c-i — the verification chain. Two more transitions on the SAME claim, so they join the
  // same op-type set and the same `com:billtx:` key shape: hydration, the pending rebuild, the
  // flush reconcile and the transition-conflict rule all cover them without a second registry.
  'beginVerification', 'verifyVendorBill',
  // 7B-iii-f — the certification authority chain.
  'certifyBill', 'supersedeCertificate',
  // 7B-iii-g — the §I authorisation itself. It joins the same op-type set for the same reason as
  // the others: one registry, so hydration, the pending rebuild and the flush reconcile cover it
  // without a second list to keep in step.
  'grantSodException',
  // 7B-iii-d — the payer's chain. Same registry, same reason.
  'recordDeduction', 'releaseDeduction', 'recordPayment', 'reversePayment',
  'approvePayment',
  // 7B-vi (§H) — the advance. Its absence broke the whole outbox lifecycle for this op: hydration
  // would not recognise it, the pending rebuild would not carry it, and the flush would not count
  // it as a settled commercial write — so an advances read already in flight could clear the key
  // over rows that predate the payment.
  'payAdvance',
] as const;

export const isCommercialOpType = (t: unknown): boolean =>
  typeof t === 'string' && (COMMERCIAL_OUTBOX_OP_TYPES as readonly string[]).includes(t);

type OutboxOpShape = { t?: unknown; idempotencyKey?: unknown; coalesceKey?: unknown };

/**
 * Hydration GUARD, not a migration — and the distinction is worth stating rather than copying
 * `materialsKeys.ts` wholesale.
 *
 * Materials needed `normalizeMaterialsOutbox` to DERIVE a missing `coalesceKey` because PR #207
 * had already persisted ops carrying only an `idempotencyKey`, and PR #208's hydration would
 * otherwise have put `undefined` into the pending set and let an equivalent click execute twice
 * (#209). No commercial queue has ever been persisted, so there is no earlier format to migrate
 * FROM: an op missing either key was never written by any released build and can only be
 * corruption. It is dropped rather than repaired, because repairing it would mean inventing an
 * identity for a command whose exactly-once guarantee depends on that identity being real.
 *
 * Non-commercial ops pass through untouched.
 */
export function normalizeCommercialOutbox<T extends OutboxOpShape>(ops: readonly T[]): { ops: T[]; changed: boolean } {
  const out: T[] = [];
  let changed = false;
  for (const op of ops) {
    if (op === null || typeof op !== 'object') {
      changed = true;
      continue;
    }
    if (!isCommercialOpType(op.t)) {
      out.push(op);
      continue;
    }
    const idem = op.idempotencyKey;
    const ck = op.coalesceKey;
    if (typeof idem === 'string' && idem.length > 0 && typeof ck === 'string' && ck.length > 0) {
      out.push(op);
      continue;
    }
    changed = true; // malformed — dropped, never replayed with a broken identity
  }
  return { ops: out, changed };
}

// ── Phase 5 Task 7B-iii-b (§D/§F) — the engineer's six writes ────────────────────────────────

/** §D — one measurement per (labour PO line, activity) in flight. The pair IS the target. */
export const measureCoalesceKey = (labourPoLineId: string, activityId: string): string =>
  `com:meas:${labourPoLineId}:${activityId}`;

/**
 * §D — a correction is a SIGNED delta, so the value is part of the identity: −50 and +20 against
 * the same measurement are two different corrections, not a retry of one. The pending TEST below
 * is prefix-matched, so editing the delta mid-flight does not re-arm the button (labour r7).
 */
export const correctionCoalesceKey = (measurementId: string, quantity: string): string =>
  `com:mcorr:${measurementId}:${quantity}`;

/** Whether ANY measurement on this LINE is pending, whichever activity it names. */
export const isMeasurePendingForLine = (key: string, labourPoLineId: string): boolean =>
  key.startsWith(`com:meas:${labourPoLineId}:`);

/** Whether ANY correction of this measurement is pending, at any delta. */
export const isCorrectionPendingFor = (key: string, measurementId: string): boolean =>
  key.startsWith(`com:mcorr:${measurementId}:`);

/** §F — the duplicate-claim key the SERVER freezes: one claim per (vendor, their bill number). */
export const billCoalesceKey = (vendorId: string, vendorBillNumber: string): string =>
  // Normalized the way the SERVER's live-duplicate index keys it, not merely trimmed: `V-1` and
  // `v 1` are ONE live claim there, so coalescing on the raw string let both enter the durable
  // outbox and promised to sync a claim the server would refuse (Codex M6).
  `com:bill:${vendorId}:${normalizedBillNumber(vendorBillNumber)}`;

/**
 * §F — submit, amend and reject are three TRANSITIONS on one claim, and the claim is the
 * constrained resource, not the verb.
 *
 * Keying per verb would let a pending submit sit beside a queued reject for the same bill: the
 * server would apply whichever arrived first and terminally 4xx the other, after the user had been
 * told both were saved. Labour round 5 is the same lesson about a one-slot demand slice, and J2 is
 * the same lesson about one live attribution per PO line — this is its third instance, so the key
 * names the BILL and `isBillTransitionPending` disables all three together.
 */
export type BillTransitionVerb =
  | 'submit' | 'amend' | 'reject' | 'begin-verification' | 'verify'
  // 7B-iii-f — certify and supersede are transitions on the CLAIM, so they share the key shape and
  // the conflict rule. A SoD grant is deliberately NOT one: it names a PERSON, two approvers may
  // authorise two different actors on one claim concurrently, and coalescing them onto the claim
  // would silently drop the second authorisation.
  | 'certify' | 'supersede';

export const billTransitionCoalesceKey = (billId: string, verb: BillTransitionVerb): string =>
  `com:billtx:${billId}:${verb}`;

/** Whether ANY lifecycle transition is pending for this claim, whichever verb it is. */
export const isBillTransitionPending = (key: string, billId: string): boolean =>
  key.startsWith(`com:billtx:${billId}:`);

/**
 * §I — an authorisation names a PERSON, so its key does too.
 *
 * Two approvers may authorise two different actors on one claim at the same time, and those are
 * independent facts: coalescing them onto the claim would report both saved and write one. That
 * much the transition-verb comment above already got right.
 *
 * What it got wrong is treating that independence as independence from the CLAIM — see
 * `commercialWriteBlocked`.
 */
/** …and by RULE, because §I has two and authorising a person to certify is a DIFFERENT act from
 *  authorising them to approve. Keying both the same would coalesce the second away while the
 *  first is pending, silently dropping an authorisation the approver believes they issued. */
export const sodGrantCoalesceKey = (billId: string, actorId: string, rule: string): string =>
  `com:sodgrant:${billId}:${actorId}:${rule}`;

/**
 * ── 7B-iii-d — the payer's chain, and the ONE fact that shapes all six keys ──────────────────
 *
 * Every one of these six commands is a §F FOLD SOURCE. Recording or releasing a withholding moves
 * `NET_PAYABLE`; approving moves `APPROVED`; paying and reversing move `PAID`. §F derives the
 * claim's status from those three folds, and 7B-iii-h made the claim's monotonic revision advance
 * on every write that touches any of them.
 *
 * That is not a detail about status labels. It means **any of these six invalidates a queued
 * `approve`**, because an approval PINS `lifecycleVersion` and the server refuses it if the claim
 * has moved. R5-1 was the same shape one unit ago, for §I grants and claim transitions; here it is
 * the general case, so the conflict rule is written from the FOLD rather than from a verb list.
 *
 * Each key names its ACTION and the conflict rule names its RESOURCE — this repository's rule, now
 * at its fifth instance. The resources differ, and getting them right is the whole design:
 *
 *   record deduction   the CLAIM — a withholding draws on certified headroom (§G bound 3)
 *   release deduction  the WITHHOLDING — two releases race one unreleased balance; releases
 *                      against DIFFERENT withholdings are independent and must not coalesce
 *   record payment     the APPROVAL — payments race one authorised amount (§G bound 5)
 *   reverse            the PAYMENT — two reversals race one paid amount
 */
/**
 * Round 4 — every child key carries the CLAIM it settles under, following `com:sodgrant:`.
 *
 * The first three rounds keyed these on the child row alone and released them by asking the fresh
 * claim read for the ids it returned. That works while the row survives, and a row does not always
 * survive: a full release followed by a supersede is a legal FIFO sequence in which the release
 * commits, the supersede commits because nothing is retained, and the next claim read carries no
 * live certificate — so the withholding is simply gone, no id comes back, and the key is held for
 * ever. The op settled and the button never re-enables.
 *
 * A key whose settling read cannot NAME it is stuck by construction, which is 7B-iii-g's F2 for
 * the third time. Carrying the bill fixes it at the root: the read that covers the claim clears
 * every key scoped to that claim, whether or not the row it named is still there — because ABSENCE
 * is the effect when the parent is gone. `<billId>:<rowId>` keeps two withholdings on one claim
 * independent, so nothing coalesces that should not.
 */
export const deductionCoalesceKey = (billId: string): string => `com:deduct:${billId}`;
/** claim-scoped already: an approval races the ONE net payable (§G bound 4) */
export const approveCoalesceKey = (billId: string): string => `com:approve:${billId}`;
export const deductionReleaseCoalesceKey = (billId: string, deductionId: string): string =>
  `com:release:${billId}:${deductionId}`;
export const payCoalesceKey = (billId: string, approvalId: string): string =>
  `com:pay:${billId}:${approvalId}`;
export const reverseCoalesceKey = (billId: string, paymentId: string): string =>
  `com:payrev:${billId}:${paymentId}`;


/**
 * Whether a pending key moves money on THIS claim — the predicate the approve conflict is written
 * from, so a fold-moving action added later is covered by naming it here once.
 *
 * Every §F fold source advances the claim's monotonic revision, and an approval PINS that revision.
 * Queued behind any of them, an approval is written against a revision that is already gone.
 *
 * All four settlement keys are claim-scoped (round 4), so unlike the first three rounds this
 * predicate can see every one of them from the key alone — there is no half left for the screen to
 * close, which is what scoping the keys bought.
 */
export const isClaimMoneyPending = (key: string, billId: string): boolean =>
  key === deductionCoalesceKey(billId)
  || key === approveCoalesceKey(billId)
  || isBillTransitionPending(key, billId)
  || key.startsWith(`com:release:${billId}:`)
  || key.startsWith(`com:pay:${billId}:`)
  || key.startsWith(`com:payrev:${billId}:`);

/**
 * Whether a commercial write must be refused because an EQUIVALENT or CONFLICTING one is pending.
 *
 * `dispatchCommercial` used exact key equality, which is right for most actions and wrong for the
 * §F lifecycle: submit / amend / reject carry different keys, so a reject queued behind a pending
 * submit for the SAME claim passed the check even though the screen's button was disabled. The
 * screen hiding a control is not a guarantee — that is Codex J1's lesson from PR #302, and the
 * durable outbox is the layer that has to hold, because an op it accepts has already been
 * persisted and reported to the user as saved.
 *
 * So conflict, not just equality: exact match for everything, plus "any transition on this claim"
 * for the §F verbs. One function, used by the store to REFUSE and by the screen to DISABLE, so the
 * two cannot answer differently.
 */
export function commercialWriteBlocked(coalesceKey: string, pending: readonly string[]): boolean {
  if (pending.includes(coalesceKey)) return true;
  // the verb list is derived from the KEY SHAPE, not restated: a new transition that forgot to
  // appear here would be a transition the dispatcher does not treat as conflicting, which is M7
  const tx = /^com:billtx:(.+):[a-z-]+$/u.exec(coalesceKey);
  if (tx) return pending.some((k) => isBillTransitionPending(k, tx[1]!));
  // Codex M7 — the SAME conflict rule for corrections. The key deliberately carries the delta, so
  // −1 and −2 against one measurement are different keys; without this the screen disabled the
  // second and the dispatcher accepted it, and two deltas double-withdrew the same evidence.
  const corr = /^com:mcorr:(.+):[^:]*$/u.exec(coalesceKey);
  if (corr) return pending.some((k) => isCorrectionPendingFor(k, corr[1]!));
  // Round 2 — the LINE is the constrained resource for a measurement, not the (line, activity)
  // pair the key names. Measure the whole remainder against ACT-1, retarget the form to ACT-2
  // before the reconcile lands, and the exact-key check sees nothing: both are queued against one
  // remaining authority and the server terminally refuses the loser. This is labour round 5 and J2
  // a third time — the key identifies the ACTION, the conflict rule names the RESOURCE.
  const meas = /^com:meas:(.+):[^:]*$/u.exec(coalesceKey);
  if (meas) return pending.some((k) => isMeasurePendingForLine(k, meas[1]!));
  // ── §I, round 5 finding R5-1 — the grant's independence is from other GRANTS, not from the claim
  //
  // The per-PERSON key is right and stays: two approvers authorising two different actors on one
  // claim are independent facts, and coalescing them would report both saved and write one. What
  // was carried one step too far is concluding that a grant therefore conflicts with nothing.
  //
  // An authorisation is not a free-standing note. It PINS the claim it was given against — version,
  // status, and (since 7B-iii-h) the monotonic revision — and the server refuses it if any of the
  // three has moved. A queued transition is precisely a command that moves them. So queueing an
  // authorisation behind a pending certify/amend/verify writes a grant whose pinned facts that
  // transition is about to invalidate: the user is told it is saved, and the server refuses it when
  // it lands.
  //
  // This is the same shape as the §F verbs above and as M7's corrections — the key identifies the
  // ACTION, the conflict rule names the RESOURCE, and the resource here is the claim. The block is
  // ONE-DIRECTIONAL by design: a pending grant does not block a transition, because a certify that
  // arrives before its authorisation is refused by the server for a reason that is true and
  // legible ("no authorisation stands"), not silently mis-pinned.
  // `com:sodgrant:<bill>:<actor>:<rule>` — anchored on the FIRST segment rather than a greedy
  // prefix, because the key gained a third part (7B-iv) and a greedy `(.+)` silently captured
  // `<bill>:<actor>` as the bill, so no transition ever matched and the guard went quiet. Ids
  // carry no colons, which is what makes the narrow class correct rather than merely tighter.
  // 7B-iv round 2 — a TRANSITION is not the whole set of things that move what a grant pins.
  // `resolveGrantForRule` pins `(status, lifecycleVersion)` and the revision advances on every
  // FOLD write too, so a grant queued behind one is refused `stale-version` after the outbox
  // reported it saved. Widened for BOTH rules: the pinning is `asOf`, not the rule.
  const grant = /^com:sodgrant:([^:]+):/u.exec(coalesceKey);
  if (grant) return pending.some((k) => isClaimMoneyPending(k, grant[1]!));
  // ── 7B-iii-d — a WITHHOLDING moves a fold, so a lifecycle transition on its claim blocks it ──
  //
  // `com:pay:` and `com:payrev:` name an APPROVAL and a PAYMENT rather than the claim, so this
  // predicate cannot map them back to a bill from the key alone. The SCREEN closes that half,
  // because it holds the claim's own ids — stated here rather than left to be discovered.
  const deduct = /^com:deduct:(.+)$/u.exec(coalesceKey);
  if (deduct) {
    return pending.some((k) => isBillTransitionPending(k, deduct[1]!)
      // …and behind a pending APPROVAL on the same claim. Round 4 established that a conflict
      // between two commands is not one-directional unless the BOUNDS make it so, and closed
      // supersede/pay both ways; this pair was left half-closed. The seal is real: a withholding
      // LOWERS `NET_PAYABLE`, the derived-status seal re-runs requiring `APPROVED <= NET_PAYABLE`,
      // and the FIFO outbox sends the approval first — so a withholding queued behind an approval
      // of the full payable is rejected AT COMMIT, after the outbox reported it saved.
      || k === approveCoalesceKey(deduct[1]!));
  }
  // …and an APPROVAL yields to every fold write on its claim, because it pins the revision they move
  const approve = /^com:approve:(.+)$/u.exec(coalesceKey);
  if (approve) return pending.some((k) => isClaimMoneyPending(k, approve[1]!));
  return false;
}

/**
 * WHICH READ makes a write visible — and therefore the only read allowed to release its key.
 *
 * N1 established the principle (a key must clear WITH the truth on screen, not before) and split
 * the pending set two ways: money keys on the money read, "claim-affecting" keys on any claim
 * read. Two claim reads is one too few, because "a claim read" is not one thing:
 *
 *  - a LODGE (`com:bill:`) becomes visible in the claim LIST — which is also the list the lodge
 *    form's duplicate guard reads. Clearing it on a claim BUNDLE re-enabled the button while the
 *    guard was still blind, so a second lodge entered the durable outbox for the server's
 *    duplicate-document 409 to drop.
 *  - a MEASUREMENT becomes visible in the register of the LINE it names — not in whichever claim
 *    happened to reload first. With two claims open, the unrelated one clearing the key is N1
 *    exactly, one resource over.
 *
 * So ownership is stated per read rather than per family, and the read carries what it actually
 * landed. `com:billtx:` is deliberately owned by BOTH the list and that claim's own bundle: each
 * carries the claim's status, and the screen already arbitrates between them by stamp.
 */
export type CommercialRead = {
  /**
   * Codex Q-a — whether this read could have OBSERVED the writes that have settled. A per-resource
   * token orders reads against EACH OTHER and says nothing about causality: refresh a resource,
   * queue a write against it, let the write commit, and the older refresh can still land first and
   * release the key over pre-write truth. False for any read that STARTED before a commercial write
   * settled; such a read applies its value and releases nothing, and the reconcile starts a fresh
   * read that does. Holding a key too long is recoverable (Retry); releasing it early re-enables a
   * control over truth the user cannot see, and the write-ahead outbox turns that second click into
   * a command reported saved and then dropped on a terminal 409.
   *
   * 7B-iii-c-i — this was a FIELD OF ONE VARIANT when Q-a found it on the register. That made it a
   * property of one read rather than of reading, and the other three cleared keys with no causality
   * term at all: a stale claim bundle landing after a `submit` settled cleared the key while still
   * showing `draft`, so Submit re-enabled itself. The verification chain adds two more transitions
   * released by exactly those reads, so the term is hoisted to where every variant must carry it —
   * the compiler is what makes forgetting it impossible, which is the only enforcement that holds.
   */
  observedWrite: boolean;
} & (
  | { read: 'money' }
  | { read: 'bills' }
  | { read: 'claim'; billId: string }
  | { read: 'lineRegister'; labourPoLineId: string; rowIds: readonly string[] }
  /** 7B-vi (§H) — the advances read. It exists FOR this: an advance names a counterparty and no
   *  claim, so no other commercial read can settle its key. That is why the read lands with the
   *  control rather than after it. */
  | { read: 'advances' }
);

export function readClearsKey(coalesceKey: string, r: CommercialRead): boolean {
  if (!r.observedWrite) return false;
  switch (r.read) {
    case 'money':
      return coalesceKey.startsWith('com:budget:') || coalesceKey.startsWith('com:head:')
        || coalesceKey.startsWith('com:attr:');
    case 'bills':
      return coalesceKey.startsWith('com:bill:') || coalesceKey.startsWith('com:billtx:');
    case 'claim':
      // …and the §I authorisation (7B-iii-g), on THIS claim only. It settles here rather than on
      // the bills list because that is where its effect is visible: the grant changes the claim's
      // own `certifyPreflight`, and nothing about the list row moves.
      //
      // A key with no release path is not "pending" — it is STUCK. The op settles, the read lands,
      // and the button stays disabled until a hydration or a scope change rebuilds the pending set
      // from an outbox that no longer holds it.
      return isBillTransitionPending(coalesceKey, r.billId)
        || coalesceKey.startsWith(`com:sodgrant:${r.billId}:`)
        // 7B-iii-d — the payer's chain settles here too: the claim bundle carries the deduction
        // ledger AND the payment ledger, so a fresh claim read is exactly when these become
        // visible. Every one of them is scoped to the bill (round 4), so this read clears them
        // whether or not the row each named survived the write — see the key comment above.
        || coalesceKey === deductionCoalesceKey(r.billId)
        || coalesceKey.startsWith(`com:release:${r.billId}:`)
        || coalesceKey.startsWith(`com:pay:${r.billId}:`)
        || coalesceKey.startsWith(`com:payrev:${r.billId}:`)
        || coalesceKey === approveCoalesceKey(r.billId);
    case 'advances':
      // every advance key, whatever counterparty it names — the read carries the whole project's
      // advances, so it settles them all rather than the one row a caller happened to pass
      return coalesceKey.startsWith('com:advance:');
    case 'lineRegister': {
      const meas = /^com:meas:(.+):[^:]*$/u.exec(coalesceKey);
      if (meas) return meas[1] === r.labourPoLineId;
      const corr = /^com:mcorr:(.+):[^:]*$/u.exec(coalesceKey);
      // a correction is visible once the register it adjusts carries the row it names
      if (corr) return r.rowIds.includes(corr[1]!);
      return false;
    }
  }
}
