/**
 * Decimal-safe arithmetic for the `numeric(18,6)` quantity strings the inventory §C ledger emits.
 *
 * The ledger's quantities can carry up to 18 significant digits; JavaScript `Number` only holds ~15,
 * so folding buckets with `Number(...)` silently loses precision (correction finding 5). These helpers
 * parse each quantity to a 6-decimal-place fixed-point `bigint`, do exact integer arithmetic, and format
 * back (trailing zeros trimmed) — no float ever touches a stock quantity.
 */

const SCALE = 6;
const POW = 10n ** BigInt(SCALE);

/** Parse a decimal string to a 6-dp-scaled bigint (exact). Blank/undefined → 0n. */
export function toScaled(s: string | null | undefined): bigint {
  const str = (s ?? '0').trim();
  if (str === '' || str === '-') return 0n;
  const neg = str.startsWith('-');
  const body = neg ? str.slice(1) : str;
  const [intPart = '0', fracRaw = ''] = body.split('.');
  const frac = (fracRaw + '000000').slice(0, SCALE);
  const scaled = BigInt(intPart || '0') * POW + BigInt(frac || '0');
  return neg ? -scaled : scaled;
}

/** Format a 6-dp-scaled bigint back to a decimal string (trailing zeros trimmed). */
export function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const intPart = abs / POW;
  const frac = (abs % POW).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const s = frac ? `${intPart}.${frac}` : `${intPart}`;
  return neg ? `-${s}` : s;
}

/** Sum decimal strings exactly. */
export function decSum(values: Iterable<string>): string {
  let acc = 0n;
  for (const v of values) acc += toScaled(v);
  return fromScaled(acc);
}
export function decAdd(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}
export function decSub(a: string, b: string): string {
  return fromScaled(toScaled(a) - toScaled(b));
}
/** a > b (exact). */
export function decGt(a: string, b: string): boolean {
  return toScaled(a) > toScaled(b);
}
/** a > 0 (exact). */
export function decIsPositive(a: string): boolean {
  return toScaled(a) > 0n;
}
/** The smaller of a and b, normalized. */
export function decMin(a: string, b: string): string {
  return fromScaled(toScaled(a) <= toScaled(b) ? toScaled(a) : toScaled(b));
}
/** Re-format a decimal string canonically (trailing zeros trimmed). */
export function decNormalize(s: string): string {
  return fromScaled(toScaled(s));
}
