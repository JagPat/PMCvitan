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
export const COMMERCIAL_OUTBOX_OP_TYPES = ['setCommercialBudget', 'defineCostHead', 'reattributeCommitment'] as const;

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
