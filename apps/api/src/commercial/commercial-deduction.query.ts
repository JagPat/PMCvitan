import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { attributeByLineShare } from './certificate-share';
import { CommercialBillQuery } from './commercial-bill.query';

const ZERO = new Prisma.Decimal(0);

/** One live certificate's withholding position — the pair every §H rule is stated over. */
export interface WithholdingPosition {
  certificateId: string;
  /** the certificate's frozen amount — what there is to withhold FROM */
  certifiedAmount: Prisma.Decimal;
  /** Σ deductions − Σ releases, over THIS certificate. A fold, never a stored column (§H). */
  withheld: Prisma.Decimal;
  /** §G bound 4 — `CERTIFIED` less unreleased deductions. The floor is enforced on the deduction
   *  WRITE, so this is never negative and no reader has to clamp it. */
  netPayable: Prisma.Decimal;
}

/**
 * Phase 5 Task 5C (§H) — the DEDUCTION folds, in ONE owned place.
 *
 * §0's opening finding was that each fold described *where to look* and re-derived *which rows
 * count* locally, so each got it wrong in its own way. Every withheld and net-payable number in
 * this module — the §H bounds, the §F status derivation, the §J `certified-payable` bucket, the
 * read surface, and the DB seals' SQL twins — comes from here.
 *
 * **The live rule is the CERTIFICATE's, not the bill's.** A deduction is a row against a
 * certification (§H), so superseding that certificate takes its deductions out of every fold with
 * it. That is what makes supersession the correction path §F says it is: the corrected certificate
 * starts from a clean ledger rather than inheriting withholdings taken against an amount nobody
 * certifies any more.
 */
@Injectable()
export class CommercialDeductionQuery {
  constructor(private readonly bills: CommercialBillQuery) {}

  /**
   * The withholding position of a bill's LIVE certificate, or null when none stands — and null is
   * not zero: a bill with no certificate has nothing to withhold from, which is a different
   * statement from one that has been certified and withheld nothing.
   */
  async positionFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
  ): Promise<WithholdingPosition | null> {
    const certificate = await tx.billCertificate.findFirst({
      where: { projectId, billId, supersededAt: null },
      select: { id: true, certifiedAmount: true },
    });
    if (!certificate) return null;
    const withheld = await this.withheldFor(tx, projectId, [certificate.id]);
    const held = withheld.get(certificate.id) ?? ZERO;
    return {
      certificateId: certificate.id,
      certifiedAmount: certificate.certifiedAmount,
      withheld: held,
      netPayable: certificate.certifiedAmount.sub(held),
    };
  }

  /**
   * `WITHHELD(certificate)` for a set of certificates — Σ deductions less Σ releases.
   *
   * Batched because §J folds a whole project's cost heads at once and a per-certificate round trip
   * inside that loop is the shape that makes a budget page slow enough to be worked around.
   * Absent certificates map to ZERO rather than being missing: a caller reading `?? undefined` and
   * skipping the subtraction would report the gross certificate as payable.
   */
  async withheldFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    certificateIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    for (const id of certificateIds) out.set(id, ZERO);
    if (certificateIds.length === 0) return out;

    const deductions = await tx.billDeduction.findMany({
      where: { projectId, certificateId: { in: [...certificateIds] } },
      select: { id: true, certificateId: true, amount: true },
    });
    if (deductions.length === 0) return out;
    for (const d of deductions) {
      out.set(d.certificateId, (out.get(d.certificateId) ?? ZERO).add(d.amount));
    }

    const certificateOfDeduction = new Map(deductions.map((d) => [d.id, d.certificateId]));
    const releases = await tx.billDeductionRelease.findMany({
      where: { projectId, deductionId: { in: deductions.map((d) => d.id) } },
      select: { deductionId: true, amount: true },
    });
    for (const r of releases) {
      const certificateId = certificateOfDeduction.get(r.deductionId);
      if (!certificateId) continue;
      out.set(certificateId, (out.get(certificateId) ?? ZERO).sub(r.amount));
    }
    return out;
  }

  /**
   * `WITHHELD(poLine)` (§J) — unreleased withholdings attributable to each purchase-order line.
   *
   * The §J twin of `CERTIFIED`, and attributed by the SAME rule through the same function: a
   * deduction is taken against a bill-scoped certificate while the buckets are per cost head, so
   * each line takes its share of the version. Two copies of that rule would disagree the first time
   * either changed, which is why the attribution lives at one site.
   *
   * A superseded certificate's deductions do not appear, for the same reason its certified amount
   * does not: the live-version filter is applied to the claim lines, and only certificates naming
   * a live version contribute.
   */
  async withheldAmountFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    for (const id of poLineIds) out.set(id, ZERO);
    if (poLineIds.length === 0) return out;

    const lines = await this.bills.liveLineSharesFor(tx, projectId, kind, poLineIds);
    if (lines.length === 0) return out;

    const certificates = await tx.billCertificate.findMany({
      where: { projectId, supersededAt: null, versionId: { in: [...new Set(lines.map((l) => l.versionId))] } },
      select: { id: true, versionId: true },
    });
    if (certificates.length === 0) return out;

    const withheld = await this.withheldFor(tx, projectId, certificates.map((c) => c.id));
    const withheldByVersion = new Map(
      certificates.map((c) => [c.versionId, withheld.get(c.id) ?? ZERO]),
    );
    return attributeByLineShare(
      lines,
      withheldByVersion,
      await this.bills.versionTotals(tx, projectId, [...withheldByVersion.keys()]),
      out,
    );
  }

  /**
   * The attribution rule itself, with the certificate-scoped total left to the caller.
   *
   * `withheldAmountFor` above and Task 6A's `approvedAmountFor` are the same walk — live claim
   * lines, the live certificates naming their versions, a total per certificate, then each line's
   * share of its version — differing only in WHICH total they fold. Task 6A needed the second one,
   * and copying the walk would have put the attribution rule at two sites, which is precisely what
   * the comment above says must not happen. So the walk is stated once and the total is a
   * parameter.
   */
  async attributeCertificateScopedTotal(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
    totalPerCertificate: (certificateIds: string[]) => Promise<Map<string, Prisma.Decimal>>,
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    for (const id of poLineIds) out.set(id, ZERO);
    if (poLineIds.length === 0) return out;

    const lines = await this.bills.liveLineSharesFor(tx, projectId, kind, poLineIds);
    if (lines.length === 0) return out;

    const certificates = await tx.billCertificate.findMany({
      where: { projectId, supersededAt: null, versionId: { in: [...new Set(lines.map((l) => l.versionId))] } },
      select: { id: true, versionId: true },
    });
    if (certificates.length === 0) return out;

    const totals = await totalPerCertificate(certificates.map((c) => c.id));
    const byVersion = new Map(certificates.map((c) => [c.versionId, totals.get(c.id) ?? ZERO]));
    return attributeByLineShare(
      lines,
      byVersion,
      await this.bills.versionTotals(tx, projectId, [...byVersion.keys()]),
      out,
    );
  }

  /**
   * The withholdings on one certificate that still have money held against them (§H).
   *
   * This is what makes a certificate uncorrectable in place: superseding it would drop a retained
   * balance with no release behind it. Stated here, beside the folds it is derived from, so the
   * service refusal and `phase5_t5c_supersede_needs_release` are two enforcements of ONE rule
   * rather than two implementations of it.
   *
   * The rows are ordered by id so the refusal names them in a stable order — a message that
   * reshuffles between reads is a message a practice cannot act on.
   */
  async outstandingFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    certificateId: string,
  ): Promise<Array<{ id: string; outstanding: Prisma.Decimal }>> {
    const rows = await tx.billDeduction.findMany({
      where: { projectId, certificateId },
      orderBy: { id: 'asc' },
      select: { id: true, amount: true, releases: { select: { amount: true } } },
    });
    return rows
      .map((d) => ({ id: d.id, outstanding: d.releases.reduce((a, r) => a.sub(r.amount), d.amount) }))
      .filter((d) => d.outstanding.greaterThan(ZERO));
  }

  /** `RELEASED(deduction)` — what a release is bounded by, over its OWN deduction (§H bound 2). */
  async releasedFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    deductionId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.billDeductionRelease.findMany({
      where: { projectId, deductionId },
      select: { amount: true },
    });
    return rows.reduce((a, r) => a.add(r.amount), ZERO);
  }

  /**
   * `APPROVED(bill)` (§0) — Σ approvals against the bill's LIVE certificate.
   *
   * Task 5C declared this beside `NET_PAYABLE` and returned a structural zero, with the reason
   * written down: so the §F derivation reads all three folds from ONE owner, and Task 6 fills these
   * in rather than teaching the derivation a second source of truth. 6B-i is that fill.
   *
   * **Live-certificate scoped, not every approval the bill ever collected.** A certificate is
   * superseded, not edited (§F), and its approvals authorised THAT amount: certify ₹100, approve
   * ₹100, supersede to ₹50, and a bill-wide set reports ₹100 approved against a ₹50 payable — a
   * breach of §G bound 4 the moment the correction lands, with the approval append-only so nothing
   * walks it back. Scoping to the live certificate makes supersession lower this fold
   * automatically and forces the reduced amount to be re-approved by someone with the authority.
   */
  async approvedFor(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(a."amount"), 0) AS total
        FROM "PaymentApproval" a
        JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
       WHERE a."projectId" = ${projectId} AND a."billId" = ${billId}
         AND c."supersededAt" IS NULL`;
    return new Prisma.Decimal(rows[0]?.total ?? 0);
  }

  /**
   * `PAID(bill)` AT THIS TREE — Σ payments. §0 defines the fold as Σ payments MINUS Σ payment
   * REVERSALS, and **the reversal term arrives in 6B-ii, with the table it reads.**
   *
   * An earlier revision of this comment claimed the subtraction was already written here "at zero
   * rows". It was not, and could not be: 6B-ii owns `PaymentReversal`, so the term would have named
   * schema that does not exist. Stating an intent the SQL does not carry is worse than stating the
   * gap — a reader checking whether `PAID` can fall would have been told yes by prose and no by the
   * query. So this says plainly what is true here, and 6B-ii widens the fold together with its own
   * §F probes for a falling `PAID`.
   *
   * **Bill-scoped, NOT live-certificate scoped, and the asymmetry with `approvedFor` is the point.**
   * An approval is an AUTHORISATION of a particular certified amount, so it dies with the
   * certificate that carried it. A payment is CASH THAT LEFT THE PRACTICE. §0 is explicit that
   * supersession never appends a payment reversal, because a fold that dropped when a certificate
   * was corrected would hide a real outflow behind a lower payable. Money already gone is recovered
   * by a separate attributable act, never as a side effect of correcting a document.
   */
  async paidFor(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(p."amount"), 0) AS total
        FROM "Payment" p
       WHERE p."projectId" = ${projectId} AND p."billId" = ${billId}`;
    return new Prisma.Decimal(rows[0]?.total ?? 0);
  }

  /**
   * All three §F folds for one bill, read together. `netPayable` is ZERO when no live certificate
   * stands — `positionFor` returns null there, and a bill with nothing certified has nothing
   * payable, which is the value the derivation's first arm needs.
   */
  async foldsFor(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ netPayable: Prisma.Decimal; approved: Prisma.Decimal; paid: Prisma.Decimal }> {
    const position = await this.positionFor(tx, projectId, billId);
    const [approved, paid] = await Promise.all([
      this.approvedFor(tx, projectId, billId),
      this.paidFor(tx, projectId, billId),
    ]);
    return { netPayable: position?.netPayable ?? ZERO, approved, paid };
  }
}
