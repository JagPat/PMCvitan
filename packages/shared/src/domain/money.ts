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
