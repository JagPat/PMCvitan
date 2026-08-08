import { parseCivilDate } from '../lib/dates';

/**
 * Phase 5 (§A) — the ONE money-string rule, shared by the server contract and every client form.
 *
 * §A forbids a float64 round trip, so money crosses the wire as a STRING and is parsed to Decimal
 * server-side. That means the *shape* of an acceptable string is a real rule, and Codex's finding
 * on PR #302 is what happens when only one side knows it: the browser accepted `100.123`, `abc`
 * and negatives, wrote them to the DURABLE outbox, told an offline user "saved, will sync", and
 * then discarded the op on reconnect with a 400. The user was told a budget was set that never
 * could be.
 *
 * The obvious fix — copy the regex into the form — would put one fact in two places, which is the
 * recurrence this phase has now named six times. So the pattern lives here, `setBudgetSchema`
 * uses it, the form uses it, and a change to what money looks like cannot make them disagree.
 */
export const MONEY_STRING = /^\d+(\.\d{1,2})?$/u;

/** Whether `value` is a non-negative money amount with at most two decimals, trimmed. */
export function isMoneyString(value: string): boolean {
  return MONEY_STRING.test(value.trim());
}

/**
 * Phase 5 §D/§F — a QUANTITY: strictly positive, at most six decimal places.
 *
 * Extracted alongside `MONEY_STRING` and for the same reason, one round later. Codex's J3 finding
 * on PR #302 named `setBudgetSchema`, I extracted the money rule for that ONE call site, and wrote
 * "the rule now lives ONCE" in the commit message while four copies of it sat in the same file I
 * was editing — three more money fields (`rate`, `taxAmount`, `freightAmount`) and two quantity
 * fields. Fixing the instance a finding names and not its class is the convergence audits' root F,
 * and it matters concretely here: 7B-iii-b's forms need every one of those five fields, so leaving
 * the copies would have the browser agreeing with the server by luck.
 *
 * The positivity rule is SEPARATE from the shape, because the two differ by field: a measurement
 * or claim line of zero is refused, while a money amount of zero is ordinary.
 */
export const QUANTITY_STRING = /^\d+(\.\d{1,6})?$/u;

/** Whether `value` is a non-negative quantity with at most six decimals, trimmed. */
export function isQuantityString(value: string): boolean {
  return QUANTITY_STRING.test(value.trim());
}

/** Whether `value` is a quantity AND strictly positive — "a claim line for zero claims nothing". */
export function isPositiveQuantity(value: string): boolean {
  return isQuantityString(value) && Number(value.trim()) > 0;
}

/**
 * Phase 5 §D — a signed CORRECTION delta: nonzero, at most six decimals, sign permitted.
 *
 * `correctMeasurementSchema` accepts exactly this, and the form must too. Codex's finding on
 * PR #304: `abc`, `0` and `1.1234567` all passed a non-blank check into the DURABLE outbox, so an
 * offline user was told the correction was saved and reconnect dropped it as a terminal 400.
 */
export const CORRECTION_DELTA = /^-?\d+(\.\d{1,6})?$/u;

export function isCorrectionDelta(value: string): boolean {
  const v = value.trim();
  return CORRECTION_DELTA.test(v) && Number(v) !== 0;
}

/**
 * §F — the claim statuses each lifecycle transition ADMITS, mirroring the server's `from` lists.
 *
 * A control offered for a status the server refuses is not a cosmetic problem: the write-ahead
 * outbox persists the op and reports it saved, then reconnect drops it with a terminal 409. These
 * live here so the screen and `commercial-bill.service.ts` cannot disagree about what is possible.
 */
export const BILL_SUBMITTABLE_FROM = ['draft'] as const;
export const BILL_REJECTABLE_FROM = ['draft', 'submitted', 'under-verification', 'disputed', 'verified'] as const;

/**
 * §F — the duplicate-claim key as the SERVER computes it: case- and whitespace-normalized.
 *
 * The stored text keeps the vendor's verbatim number (trimmed), but the live-duplicate index keys
 * this normalized form — so `V-1` and `v 1` are ONE live claim. A client coalescing on the raw
 * string lets both enter the outbox and promises to sync a claim the server will refuse.
 */
export function normalizedBillNumber(value: string): string {
  return value.replace(/\s+/gu, '').toLowerCase();
}

/**
 * §0b — a real ISO civil date, by the SAME authority `isoCivilDateSchema` uses.
 *
 * Codex N4: the lodge form treated any non-blank string as a date, so `2026-02-31` and `abc`
 * enabled the button, entered the durable outbox, and were reported as saved before reconnect
 * dropped them with a terminal 400. A shape regex is not enough — `2026-02-31` is well-shaped and
 * impossible — so this defers to `parseCivilDate`, exactly as the contract does.
 */
export function isRealCivilDate(value: string): boolean {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(v)) return false;
  try {
    parseCivilDate(v);
    return true;
  } catch {
    return false;
  }
}
