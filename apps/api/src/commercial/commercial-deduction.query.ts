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
   * `APPROVED(bill)` and `PAID(bill)` (§0) — the two folds §F's derivation needs beside
   * `NET_PAYABLE`.
   *
   * **At the Task-5C tree both are structurally zero, and that is a property of the tree rather
   * than a stub.** No approval or payment row exists to fold: Task 6 ships them. They are stated
   * here, beside the fold that DOES exist, so the derivation reads all three from one owner and
   * Task 6 fills these in rather than teaching `deriveBillStatus` a second source of truth — which
   * is exactly the second-site drift §0 exists to prevent.
   */
  async approvedFor(_tx: Prisma.TransactionClient, _projectId: string, _billId: string): Promise<Prisma.Decimal> {
    return ZERO;
  }

  async paidFor(_tx: Prisma.TransactionClient, _projectId: string, _billId: string): Promise<Prisma.Decimal> {
    return ZERO;
  }
}
