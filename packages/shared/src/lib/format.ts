/**
 * Currency + number formatting for Vitan PMC.
 *
 * Ported verbatim from the design prototype's DCLogic helpers. The Indian
 * digit-grouping algorithm and the U+2212 minus sign are deliberate — do NOT
 * substitute Intl.NumberFormat / toLocaleString, which do not reproduce the
 * "No cost change" case or the exact glyphs the design specifies.
 */

/** Indian digit grouping: 140000 -> "1,40,000", 1000 -> "1,000". */
export function group(n: number): string {
  const s = String(Math.abs(Math.round(n)));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const other = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return other + ',' + last3;
}

/** Unsigned rupee amount: 140000 -> "₹1,40,000". */
export function inr(n: number): string {
  return '₹' + group(n);
}

/**
 * Signed cost delta.
 *   0        -> "No cost change"
 *   +140000  -> "+₹1,40,000"
 *   -45000   -> "−₹45,000"   (note: U+2212 MINUS SIGN, not a hyphen)
 */
export function signed(n: number): string {
  if (n === 0) return 'No cost change';
  return (n > 0 ? '+' : '−') + '₹' + group(n);
}
