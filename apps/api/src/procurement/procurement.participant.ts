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

  /**
   * Phase 4 Task 2 (the `labour → procurement` workflow-participant edge). The labour commercial
   * chain reuses the procurement-owned `Vendor`/`ProjectVendor` party (plan §F, F7 — no
   * `LabourSupplier`). Recording a labour quote / issuing a labour PO names a vendor that MUST be
   * bound to this project. Labour validates that binding THROUGH this participant (procurement-owned
   * code reading procurement's own `ProjectVendor`) rather than reading `ProjectVendor` directly —
   * so Labour stays a LEAF (no `labour → procurement` graph dependency; the composite FK on the
   * labour tables is the database backstop). Called INSIDE the labour command transaction.
   */
  async assertVendorBound(tx: Prisma.TransactionClient, projectId: string, vendorId: string): Promise<void> {
    const binding = await tx.projectVendor.findUnique({
      where: { projectId_vendorId: { projectId, vendorId } },
      select: { vendorId: true },
    });
    if (!binding) {
      throw new BadRequestException('vendorId is not bound to this project — bind the vendor first (§H/§F)');
    }
  }

  /**
   * Phase 5 Task 6C (the `commercial → procurement` workflow-participant edge) — the same binding,
   * LOCKED, and returned so the caller can fold against it.
   *
   * §H's advance pool is VENDOR-scoped: `RECOVERABLE = Σ advances − Σ advance-recovery` over one
   * counterparty. §0b's bill-first lock is not enough to serialize it, because two recoveries on two
   * DIFFERENT bills of the same vendor take two different bill locks and never meet — both would
   * read the same recoverable balance and both commit. The `ProjectVendor` row is the one row both
   * transactions must touch, so it is the serialization point, and commercial takes it THROUGH this
   * participant rather than reading `ProjectVendor` directly (read-encapsulation — the boundary
   * analyzer flagged the direct read, and this is the routed fix).
   *
   * Called INSIDE the commercial command transaction, AFTER the bill lock, so the order stays total
   * (bill → vendor). `phase5_t6c_recoverable_check` takes the same row at COMMIT for the same
   * reason: a seal that measured a different row from the service would serialize nothing.
   */
  async lockVendorBinding(
    tx: Prisma.TransactionClient, projectId: string, vendorId: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ vendorId: string }>>`
      SELECT "vendorId" FROM "ProjectVendor"
       WHERE "projectId" = ${projectId} AND "vendorId" = ${vendorId}
       FOR UPDATE`;
    const bound = rows[0];
    if (!bound) {
      throw new BadRequestException('vendorId is not bound to this project — bind the vendor first (§H/§F)');
    }
    return bound.vendorId;
  }

  /**
   * Phase 4 Task 2 — resolve a procurement-owned `Vendor` of an ORG (its identity + display name),
   * through this participant so Labour never reads `Vendor` directly (read-encapsulation; Labour stays
   * a LEAF). Used by the labour `VendorLabourProfile` surface. `db` may be the request tx OR the
   * PrismaService (a full client is assignable to TransactionClient) — the org profile reads run
   * outside a command tx.
   */
  async resolveOrgVendor(db: Prisma.TransactionClient, orgId: string, vendorId: string): Promise<{ id: string; name: string } | null> {
    return db.vendor.findFirst({ where: { id: vendorId, orgId }, select: { id: true, name: true } });
  }

  /** The display names of an org's vendors, keyed by vendor id (through the participant, own-module read). */
  async orgVendorNames(db: Prisma.TransactionClient, orgId: string, vendorIds: readonly string[]): Promise<Map<string, string>> {
    if (vendorIds.length === 0) return new Map();
    const rows = await db.vendor.findMany({ where: { orgId, id: { in: [...vendorIds] } }, select: { id: true, name: true } });
    return new Map(rows.map((v) => [v.id, v.name]));
  }

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

  /**
   * Phase 5 Task 4 (§G bounds 1–2) — FOR-UPDATE-lock a material PO line and return the ORDERED
   * side a vendor claim is bounded by. Called INSIDE the commercial bill transaction, through the
   * declared `commercial → procurement` participant edge.
   *
   * The lock is the point (§G, the Phase-4 Task-3 F3 lesson): "a trigger that counts without
   * serializing is not an invariant". Two concurrent submissions against a line with capacity for
   * one would each read the same billed fold, each pass bound 1, and both commit. Reading through
   * `ProcurementQuery` instead would give the same numbers with none of the serialization, and
   * would additionally let `pos.closeShort`/amend move the ordered authority underneath a claim
   * mid-flight.
   *
   * `live` is the version-status set the attribution lifecycle already maintains: a `cancelled`
   * or superseded (`amended`) version orders nothing, so a claim against it has no ordered
   * authority to be bounded by at all. A `closed_short` version stays live — it keeps its
   * received portion, which is a real obligation someone still owes and may still bill for.
   */
  async lockOrderedLineForClaim(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
  ): Promise<{
    vendorId: string; uom: string; ordered: Prisma.Decimal; live: boolean; status: string;
    /** Phase 5 Task 5 (§E) — the FROZEN commercial terms the three-way check compares a claim
     *  against. They are returned from the same locked read rather than fetched separately: a
     *  second read is a second snapshot, and §E's whole point is that every side of the triple is
     *  taken under one lock. `orderedQty` is the frozen quantity WITHOUT overage, because §E's
     *  pro-rata tax and freight cap scales by `min(BILLED_QTY, qty) / qty` — overage is authorised
     *  as QUANTITY and freezes no additional tax or freight. */
    rate: Prisma.Decimal; taxAmount: Prisma.Decimal; freightAmount: Prisma.Decimal; orderedQty: Prisma.Decimal;
  } | null> {
    const rows = await tx.$queryRaw<
      Array<{
        vendorId: string; uom: string; qty: Prisma.Decimal; approvedOverage: Prisma.Decimal; poVersionId: string;
        rate: Prisma.Decimal; taxAmount: Prisma.Decimal; freightAmount: Prisma.Decimal;
      }>
    >`
      SELECT "vendorId", "uom", "qty", "approvedOverage", "poVersionId", "rate", "taxAmount", "freightAmount"
        FROM "PurchaseOrderLine"
       WHERE "projectId" = ${projectId} AND "id" = ${poLineId}
       FOR UPDATE`;
    const line = rows[0];
    if (!line) return null;
    const version = await tx.purchaseOrderVersion.findFirstOrThrow({
      where: { projectId, id: line.poVersionId },
      select: { status: true },
    });
    return {
      vendorId: line.vendorId,
      uom: line.uom,
      // §G bound 1 for a MATERIAL line is `qty + approvedOverage`: overage is quantity the
      // practice explicitly authorised receiving, so it is quantity a vendor may legitimately
      // bill for. (Its VALUE is another matter — §J prices overage at rate only, because the PO
      // froze tax and freight for `qty` alone.)
      ordered: line.qty.add(line.approvedOverage),
      live: ['issued', 'partially_received', 'completed', 'closed_short'].includes(version.status),
      status: version.status,
      rate: line.rate,
      taxAmount: line.taxAmount,
      freightAmount: line.freightAmount,
      orderedQty: line.qty,
    };
  }

  /**
   * Phase 6 unit 6.1b (§A) — repoint this org's vendor party copies from one canonical party to
   * another, as part of the operator merge. Parties are orgs-owned, `Vendor` is procurement-owned,
   * so the merge reaches its OWN module's rows through here rather than writing them directly.
   *
   * ONE statement moves three tables. `ProjectVendor.vendorParty` is
   * `(orgId, vendorId, partyId) → Vendor(orgId, id, partyId) ON UPDATE CASCADE`, and
   * `ProjectPartyVendorSource.origin` is `(orgId, projectId, partyId, projectVendorId) →
   * ProjectVendor(...) ON UPDATE CASCADE`, so updating `Vendor.partyId` carries the binding's mirror
   * and the source row with it. Writing those tables separately would fight the cascade: the FKs are
   * NOT deferrable, so any intermediate state where the copy disagrees with its source is rejected
   * mid-transaction rather than at commit.
   *
   * Scoped by `orgId` as well as party because a party is org-scoped and the caller's org is the
   * smaller scope — the merge already refuses across orgs, and this makes a mistake there
   * unreachable rather than merely refused.
   */
  async repointVendorParty(
    tx: Prisma.TransactionClient,
    input: { orgId: string; fromPartyId: string; toPartyId: string },
  ): Promise<{ vendors: number }> {
    const { orgId, fromPartyId, toPartyId } = input;
    const { count } = await tx.vendor.updateMany({
      where: { orgId, partyId: fromPartyId },
      data: { partyId: toPartyId },
    });
    return { vendors: count };
  }

  /**
   * The projects this org's vendor bindings reach for a party — the merge needs them BEFORE it moves
   * anything, to decide whether the survivor would end up with two associations on one project.
   */
  async projectsBoundToParty(
    tx: Prisma.TransactionClient,
    orgId: string,
    partyId: string,
  ): Promise<string[]> {
    const rows = await tx.projectVendor.findMany({
      where: { orgId, partyId },
      select: { projectId: true },
    });
    return [...new Set(rows.map((r) => r.projectId))];
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
