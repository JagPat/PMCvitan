import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

/** One live claim line, as both certificate-scoped folds see it. */
export interface ClaimLineShare {
  /** the PO line this claim line draws on — the key the §J buckets are folded by */
  key: string;
  /** this line's claimed money, the numerator of its share of the version */
  amount: Prisma.Decimal;
  /** the claim version it belongs to, which is what a certificate is issued against */
  versionId: string;
}

/**
 * Attribute a BILL-scoped amount to the PO lines its claim draws on, by each line's share of the
 * version.
 *
 * A certificate and its deductions are issued against a whole claim; §J's buckets are per cost
 * head, which is per PO line. Something has to bridge the two, and it is written ONCE here rather
 * than beside each fold: `CERTIFIED` and `WITHHELD` are attributed by the SAME rule, and two copies
 * of it would disagree the first time either changed — §0's opening finding, which is that each
 * fold described where to look and re-derived which rows count locally.
 *
 * The DENOMINATOR is the whole version, not just the lines being folded: the amount was issued
 * against the complete claim, so a line's share must be measured against the complete claim or two
 * cost heads would each take the full amount.
 */
export function attributeByLineShare(
  lines: readonly ClaimLineShare[],
  amountByVersion: ReadonlyMap<string, Prisma.Decimal>,
  totalByVersion: ReadonlyMap<string, Prisma.Decimal>,
  into: Map<string, Prisma.Decimal>,
): Map<string, Prisma.Decimal> {
  for (const line of lines) {
    const amount = amountByVersion.get(line.versionId);
    if (!amount) continue;
    const total = totalByVersion.get(line.versionId) ?? ZERO;
    if (total.isZero()) continue;
    into.set(line.key, (into.get(line.key) ?? ZERO).add(amount.mul(line.amount).div(total)));
  }
  return into;
}
