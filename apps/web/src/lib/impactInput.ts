/**
 * The countersign chain's optional impact inputs — cost (whole rupees) and schedule (whole days) — read
 * from what a person types, with NO silent repair (#482 comment 5923291892).
 *
 * The API takes both as integers (`z.number().int()`), stored in `ChangeRequest.costImpact` (rupees) and
 * `timeImpactDays`, both Postgres `integer`. The old reader stripped every character except digits and an
 * ASCII minus, then fell back to 0: "12.50" became 1250, "1.5" became 15, "abc" became 0, and a Unicode
 * minus "−5" lost its sign and became 5. This reader admits only an unambiguous whole number and refuses
 * everything else with a reason the form shows, so nothing altered is ever sent:
 *
 * - blank → 0, the agreed default for an optional impact;
 * - digits, optionally grouped with commas in the Western (`5,000`, `1,000,000`) or Indian
 *   (`1,00,000`) pattern — a comma anywhere else (`12,50`) is refused, never read as a separator;
 * - one optional sign, `+`, `-` or the Unicode minus `−` (U+2212), which is kept;
 * - cost: an optional `₹`, `Rs`, `Rs.` or `INR` before the number, and an optional `/-` after it;
 * - days: an optional `d`, `day` or `days` after the number;
 * - within the Postgres `integer` range.
 *
 * A decimal point, letters, a second number, or any other character is refused.
 */
export type ImpactKind = 'cost' | 'days';
export type ImpactReading = { ok: true; value: number } | { ok: false; reason: string };

const INT4_MAX = 2_147_483_647;
const INT4_MIN = -2_147_483_648;
// plain digits, Western grouping, or Indian grouping (the last group is always three digits)
const NUMBER = String.raw`(\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})`;
const SIGN = String.raw`([+\-−])?`;
const COST = new RegExp(String.raw`^${SIGN}\s*(?:(?:₹|rs\.?|inr)\s*)?${SIGN}\s*${NUMBER}\s*(?:\/-)?$`, 'iu');
const DAYS = new RegExp(String.raw`^${SIGN}\s*${NUMBER}\s*(?:d|days?)?$`, 'iu');

const HELP: Record<ImpactKind, string> = {
  cost: 'Enter whole rupees, like 5,000 or ₹ 5,000 — no paise or decimals.',
  days: 'Enter whole days, like 2.',
};

export function readImpact(raw: string, kind: ImpactKind): ImpactReading {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: true, value: 0 };
  let sign: string | undefined;
  let digits: string | undefined;
  if (kind === 'cost') {
    const m = COST.exec(text);
    if (!m) return refuse(text, kind);
    if (m[1] && m[2]) return refuse(text, kind); // two signs: ambiguous, never guessed
    sign = m[1] ?? m[2];
    digits = m[3];
  } else {
    const m = DAYS.exec(text);
    if (!m) return refuse(text, kind);
    sign = m[1];
    digits = m[2];
  }
  const magnitude = Number(digits.replace(/,/g, ''));
  const value = sign === '-' || sign === '−' ? -magnitude : magnitude;
  if (!Number.isSafeInteger(magnitude) || value > INT4_MAX || value < INT4_MIN) {
    return { ok: false, reason: kind === 'cost' ? 'That amount is too large to record.' : 'That number of days is too large to record.' };
  }
  return { ok: true, value: value === 0 ? 0 : value }; // never -0
}

function refuse(text: string, kind: ImpactKind): ImpactReading {
  if (/\d[.,]\d/u.test(text) && /\./u.test(text)) {
    return { ok: false, reason: kind === 'cost' ? 'Whole rupees only — paise and decimals are not recorded.' : 'Whole days only — no decimals.' };
  }
  return { ok: false, reason: HELP[kind] };
}
