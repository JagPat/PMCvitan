import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequirementsQueryService } from '../activities/requirements.query';

/**
 * Phase 3 Tasks 2/4 — the procurement WORKFLOW PARTICIPANT (plan §§F/G).
 *
 * Task 2 (`assertRequirementDisposable`): cancelling a requirement that has OPEN downstream
 * requisition lines demands an explicit disposition — the lines must be cancelled (or, in
 * later tasks, re-pointed) first. The requirements cancel command invokes this
 * procurement-owned method INSIDE its transaction (the Module-3/4 owner-aligned participant
 * pattern), so the guard reads procurement's own tables from procurement-owned code, and the
 * readiness lock both commands hold serializes the check against concurrent line creation.
 *
 * Task 4 (§G `inventory → procurement` edge): the inventory receipt command runs INSIDE its
 * transaction:
 *   • `lockPoLineForReceipt` — validates the PO line + delivery commitment, FOR-UPDATE-locks
 *     the line row, enforces §F bound 3 (`Σ (accepted + quarantined) ≤ ordered +
 *     approvedOverage`) for the qty being added, and returns the line's FROZEN facts (the
 *     purchase-UOM conversion + the pinned requirement revision's full §B spec ref) so the
 *     receipt freezes them onto the StockLot. The spec read goes through the activities
 *     query contract — procurement's own declared `procurement → activities` edge.
 *   • `applyReceiptProgress` — appends the PROCUREMENT-OWNED received-progress fact
 *     (`PurchaseOrderLine.receivedQty`, the one column the frozen-line trigger admits) and
 *     recomputes the version's issued ↔ partially_received ↔ completed status. The delta is
 *     positive at receipt, negative at rejection (a rejected delivery frees bound-3 headroom
 *     for the vendor's replacement), and inverted by reversals; a POSITIVE delta re-checks
 *     bound 3 under the same FOR UPDATE lock.
 */
@Injectable()
export class ProcurementParticipant {
  constructor(private readonly requirementsQuery: RequirementsQueryService) {}

  async assertRequirementDisposable(tx: Prisma.TransactionClient, projectId: string, requirementId: string): Promise<void> {
    // Task 3: an 'ordered' line is bound even harder downstream (live PO lines) — it
    // demands disposition exactly like an open one; only 'cancelled' lines are settled.
    const open = await tx.requisitionLine.count({
      where: {
        projectId,
        requirementId,
        status: { in: ['open', 'ordered'] },
        requisition: { status: { notIn: ['rejected', 'closed'] } },
      },
    });
    if (open > 0) {
      throw new ConflictException(
        `Requirement has ${open} open requisition line(s) — cancel or re-point them before cancelling the requirement (explicit disposition, plan §F)`,
      );
    }
  }

  /**
   * §G lock protocol — called INSIDE the inventory receipt transaction. FOR-UPDATE-locks the
   * PO line, validates receivability (issued version + commitment pairing), and returns the
   * frozen facts the receipt needs. The caller MUST follow with `applyReceiptProgress` in the
   * same transaction — that is where §F bound 3 is enforced, under this same row lock.
   */
  async lockPoLineForReceipt(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
    commitmentId: string,
  ): Promise<{
    poLineId: string;
    requirementId: string;
    revision: number;
    purchaseUom: string;
    conversionToBase: Prisma.Decimal;
    spec: {
      materialCategory: string;
      make: string;
      grade: string;
      normalizedAttributes: string;
      baseUom: string;
      specFingerprint: string;
      decisionId: string | null;
      decisionVersion: number | null;
      optionKey: string | null;
    };
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string; poVersionId: string; requirementId: string; revision: number; uom: string;
        purchaseUom: string; conversionToBase: Prisma.Decimal; qty: Prisma.Decimal;
        approvedOverage: Prisma.Decimal; receivedQty: Prisma.Decimal; specFingerprint: string;
      }>
    >`
      SELECT "id", "poVersionId", "requirementId", "revision", "uom", "purchaseUom",
             "conversionToBase", "qty", "approvedOverage", "receivedQty", "specFingerprint"
      FROM "PurchaseOrderLine"
      WHERE "projectId" = ${projectId} AND "id" = ${poLineId}
      FOR UPDATE`;
    const line = rows[0];
    if (!line) throw new NotFoundException('Purchase order line not found in this project');
    const version = await tx.purchaseOrderVersion.findFirstOrThrow({
      where: { projectId, id: line.poVersionId },
      select: { status: true },
    });
    if (version.status !== 'issued' && version.status !== 'partially_received') {
      throw new ConflictException(
        `Material is received against an ISSUED purchase order version (this one is '${version.status}')`,
      );
    }
    const commitment = await tx.deliveryCommitment.findFirst({
      where: { projectId, id: commitmentId, poLineId: line.id },
      select: { id: true },
    });
    if (!commitment) {
      throw new ConflictException('The delivery commitment does not belong to this PO line');
    }
    const spec = await this.requirementsQuery.materialSpecForRevision(tx, projectId, line.requirementId, line.revision);
    if (spec.specFingerprint !== line.specFingerprint) {
      // The PO line froze the demanded fingerprint at issuance and both rows are immutable —
      // a mismatch means tampered data, never a business state. Refuse loudly.
      throw new ConflictException('PO line spec fingerprint does not match its pinned requirement revision');
    }
    return {
      poLineId: line.id,
      requirementId: line.requirementId,
      revision: line.revision,
      purchaseUom: line.purchaseUom,
      conversionToBase: line.conversionToBase,
      spec,
    };
  }

  /**
   * Append the procurement-owned received-progress fact and recompute the version status —
   * called INSIDE the same transaction, after `lockPoLineForReceipt` (receipt) or with the
   * line freshly FOR-UPDATE-locked (rejection / reversal — negative or corrective deltas).
   * A POSITIVE delta re-checks §F bound 3; the result can never go below zero because a
   * negative delta only ever undoes quantity this same ledger accounted for (the §C bucket
   * fold refuses the underlying movement first).
   */
  async applyReceiptProgress(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
    delta: Prisma.Decimal,
  ): Promise<void> {
    if (delta.isZero()) return;
    const rows = await tx.$queryRaw<
      Array<{ id: string; poVersionId: string; qty: Prisma.Decimal; approvedOverage: Prisma.Decimal; receivedQty: Prisma.Decimal }>
    >`
      SELECT "id", "poVersionId", "qty", "approvedOverage", "receivedQty"
      FROM "PurchaseOrderLine"
      WHERE "projectId" = ${projectId} AND "id" = ${poLineId}
      FOR UPDATE`;
    const line = rows[0];
    if (!line) throw new NotFoundException('Purchase order line not found in this project');
    if (delta.greaterThan(0)) {
      this.assertReceiptFits(line.qty, line.approvedOverage, line.receivedQty, delta);
    }
    const next = line.receivedQty.add(delta);
    if (next.lessThan(0)) {
      throw new ConflictException('Received progress cannot go negative — the correction exceeds what was received');
    }
    await tx.purchaseOrderLine.updateMany({ where: { projectId, id: poLineId }, data: { receivedQty: next } });

    // Version status from the version's WHOLE line set: any progress → partially_received;
    // every line at/above its ordered qty → completed; none → back to issued. CAS-free —
    // the readiness lock + this line's FOR UPDATE serialize receipt-side transitions, and
    // the version-lifecycle trigger admits only legal status changes.
    const lines = await tx.purchaseOrderLine.findMany({
      where: { projectId, poVersionId: line.poVersionId },
      select: { qty: true, receivedQty: true, id: true },
    });
    const withThis = lines.map((l) => (l.id === poLineId ? { ...l, receivedQty: next } : l));
    const anyReceived = withThis.some((l) => l.receivedQty.greaterThan(0));
    const allComplete = withThis.every((l) => l.receivedQty.greaterThanOrEqualTo(l.qty));
    const want = allComplete ? 'completed' : anyReceived ? 'partially_received' : 'issued';
    await tx.purchaseOrderVersion.updateMany({
      where: { projectId, id: line.poVersionId, status: { in: ['issued', 'partially_received', 'completed'] }, NOT: { status: want } },
      data: { status: want },
    });
  }

  /**
   * Phase 3 Task 6 (§A at-risk, §G `inventory → procurement` edge) — for each requirement pin
   * `(requirementId, revision)`, the QUANTITATIVE confirmed-inbound covering delivery commitments.
   * A commitment covers a pin when it sits on a PO line executing THAT pinned revision, on a LIVE
   * issued version (`issued|partially_received|completed` — a draft is not announced, an
   * amended/cancelled/closed-short version has released its allocation), and is still OPEN
   * (`committed|revised` — a fulfilled commitment's stock is already received; a defaulted one is
   * not inbound).
   *
   * F3 correction: returns per pin the LIST of `{ promisedDate, outstanding }` for each covering
   * commitment, where `outstanding = ordered − received` (the still-inbound quantity, positive
   * only). The caller (`coverageFor`) accumulates these against the ACTUAL shortfall — a
   * commitment for less than the shortfall does NOT make the pin at-risk. Called INSIDE the
   * readiness transaction, so the answer is canonical, not a projection.
   */
  async coveringCommitments(
    tx: Prisma.TransactionClient,
    projectId: string,
    pins: ReadonlyArray<{ requirementId: string; revision: number }>,
  ): Promise<Map<string, Array<{ promisedDate: string; outstanding: Prisma.Decimal }>>> {
    const result = new Map<string, Array<{ promisedDate: string; outstanding: Prisma.Decimal }>>();
    if (pins.length === 0) return result;
    const pairs = Prisma.join(pins.map((p) => Prisma.sql`(${p.requirementId}, ${p.revision})`));
    const rows = await tx.$queryRaw<Array<{ requirementId: string; revision: number; promisedDate: Date | null; outstanding: Prisma.Decimal | string }>>(Prisma.sql`
      SELECT pol."requirementId" AS "requirementId", pol."revision" AS "revision",
             dp."promisedDate" AS "promisedDate",
             (pol."qty" - pol."receivedQty") AS "outstanding"
      FROM "PurchaseOrderLine" pol
      JOIN "PurchaseOrderVersion" pov
        ON pov."projectId" = pol."projectId" AND pov."id" = pol."poVersionId"
      JOIN "DeliveryCommitment" dc
        ON dc."projectId" = pol."projectId" AND dc."poLineId" = pol."id"
      JOIN LATERAL (
        SELECT dp2."promisedDate"
        FROM "DeliveryPromise" dp2
        WHERE dp2."projectId" = dc."projectId" AND dp2."commitmentId" = dc."id"
        ORDER BY dp2."seq" DESC
        LIMIT 1
      ) dp ON TRUE
      WHERE pol."projectId" = ${projectId}
        AND pov."status" IN ('issued', 'partially_received', 'completed')
        AND dc."status" IN ('committed', 'revised')
        AND (pol."qty" - pol."receivedQty") > 0
        AND (pol."requirementId", pol."revision") IN (${pairs})
    `);
    for (const r of rows) {
      if (!r.promisedDate) continue;
      // `promisedDate` is a DATE column — format as a civil YYYY-MM-DD without a timezone shift.
      const iso = r.promisedDate.toISOString().slice(0, 10);
      const key = `${r.requirementId}#${r.revision}`;
      const list = result.get(key) ?? [];
      list.push({ promisedDate: iso, outstanding: new Prisma.Decimal(r.outstanding) });
      result.set(key, list);
    }
    return result;
  }

  /** §F bound 3: Σ (accepted + quarantined) per PO line ≤ ordered + approvedOverage. */
  private assertReceiptFits(
    ordered: Prisma.Decimal,
    approvedOverage: Prisma.Decimal,
    received: Prisma.Decimal,
    addQty: Prisma.Decimal,
  ): void {
    if (addQty.lessThanOrEqualTo(0)) throw new BadRequestException('Receipt quantity must be positive');
    const bound = ordered.add(approvedOverage);
    if (received.add(addQty).greaterThan(bound)) {
      throw new ConflictException(
        `Receipt exceeds the purchase order line: ordered ${ordered.toString()} + approved overage ${approvedOverage.toString()}, already received ${received.toString()}, attempted ${addQty.toString()} (§F bound 3)`,
      );
    }
  }
}
