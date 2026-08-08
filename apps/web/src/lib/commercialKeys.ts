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
export const budgetCoalesceKey = (costHeadCode: string, amount: string): string =>
  `com:budget:${costHeadCode}:${amount}`;

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
 * is prefix-matched, so editing the delta mid-flight does not re-arm the button (labour r7 — the
 * same split `budgetCoalesceKey` uses).
 */
export const correctionCoalesceKey = (measurementId: string, quantity: string): string =>
  `com:mcorr:${measurementId}:${quantity}`;

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
export const billTransitionCoalesceKey = (billId: string, verb: 'submit' | 'amend' | 'reject'): string =>
  `com:billtx:${billId}:${verb}`;

/** Whether ANY lifecycle transition is pending for this claim, whichever verb it is. */
export const isBillTransitionPending = (key: string, billId: string): boolean =>
  key.startsWith(`com:billtx:${billId}:`);

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
  const tx = /^com:billtx:(.+):(?:submit|amend|reject)$/u.exec(coalesceKey);
  if (tx) return pending.some((k) => isBillTransitionPending(k, tx[1]!));
  // Codex M7 — the SAME conflict rule for corrections. `correctionCoalesceKey` deliberately carries
  // the delta, so −1 and −2 against one measurement are different keys; the screen already treated
  // any pending correction for that measurement as blocking, and the dispatcher did not. Two deltas
  // could therefore both enter the outbox and double-withdraw the same evidence. A screen guard the
  // durable layer does not share is J1's lesson unlearned.
  const corr = /^com:mcorr:(.+):[^:]*$/u.exec(coalesceKey);
  if (corr) return pending.some((k) => isCorrectionPendingFor(k, corr[1]!));
  return false;
}
