/**
 * Phase 3 Task 2 — the PROCUREMENT module contract (shared, runtime-importable on both sides).
 *
 * Procurement owns vendors, project-vendor bindings, requisitions, RFQs, vendor quotes and
 * quote comparisons (§G ownership; POs + delivery commitments arrive in Task 3). It is reached
 * ONLY through this contract (commands + queries) and the published `requisition.*` /
 * `comparison.*` events. Every project surface is CAPABILITY-GATED (§D): a non-pilot project
 * gets 404 — the surface does not exist for it.
 *
 * TENANCY (§H): `Vendor` is org-scoped — the ONE exception to the every-table-carries-projectId
 * rule, because a vendor is an organization-level party. Project reach is the explicit additive
 * `ProjectVendor` binding whose org provably matches BOTH sides; every procurement row
 * references the vendor THROUGH the binding, so cross-org vendor use is unrepresentable.
 *
 * ALLOCATION (§F bound 1): a requisition line pins `(requirementId, revision)` and allocates
 * base-UOM quantity against that revision's required qty — Σ active line allocations may never
 * exceed it, enforced in-transaction with the revision row locked FOR UPDATE.
 */

/** The procurement module's state-changing commands (must equal the manifest `commands`). */
export const PROCUREMENT_COMMANDS = [
  'vendors.create',
  'vendors.bind',
  'requisitions.create',
  'requisitions.submit',
  'requisitions.approve',
  'requisitions.reject',
  'requisitions.cancelLine',
  'requisitions.close',
  'rfqs.create',
  'rfqs.close',
  'quotes.record',
  'comparisons.create',
  'comparisons.approve',
] as const;
export type ProcurementCommand = (typeof PROCUREMENT_COMMANDS)[number];

/** The procurement module's read queries (must equal the manifest `queries`). */
export const PROCUREMENT_QUERIES = [
  'vendors.listForOrg',
  'vendors.listForProject',
  'requisitions.list',
  'rfqs.get',
] as const;
export type ProcurementQuery = (typeof PROCUREMENT_QUERIES)[number];

/** An org-scoped vendor party record (§H — the durable party, no project reach by itself). */
export interface VendorDto {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly contact: string | null;
  readonly gstin: string | null;
  readonly createdAt: string;
  readonly createdById: string;
}

/** A vendor's explicit reach into ONE project (the §H additive binding). */
export interface ProjectVendorDto {
  readonly id: string;
  readonly projectId: string;
  readonly vendorId: string;
  readonly name: string; // the bound vendor's party name
  readonly boundAt: string;
  readonly boundById: string;
}

/** One requisition line: an allocation of base-UOM qty against a pinned requirement revision. */
export interface RequisitionLineDto {
  readonly id: string;
  readonly requirementId: string;
  readonly revision: number;
  readonly qty: string; // decimal string, numeric(18,6)-exact, in the revision's base UOM
  readonly status: string; // 'open' | 'cancelled'
}

export interface RequisitionDto {
  readonly id: string;
  readonly title: string;
  readonly status: string; // 'draft' | 'submitted' | 'approved' | 'rejected' | 'closed'
  readonly notes: string | null;
  readonly lines: readonly RequisitionLineDto[];
  readonly createdAt: string;
  readonly createdById: string;
  readonly submittedById: string | null;
  readonly approvedById: string | null;
  readonly rejectedReason: string | null;
}

/** One quoted requisition line with the §F normalization fields (comparison inputs). */
export interface VendorQuoteLineDto {
  readonly id: string;
  readonly requisitionLineId: string;
  readonly baseRate: string; // Decimal money strings, project base currency (INR, Stage 1)
  readonly taxAmount: string;
  readonly freightAmount: string;
  readonly landedCost: string; // the comparison metric
  readonly quotedMake: string;
  readonly matchesSpecification: boolean;
  readonly sampleCompliant: boolean | null;
  readonly vendorStockQty: string | null;
  readonly deliveryPromise: string | null; // ISO civil date
}

export interface VendorQuoteDto {
  readonly id: string;
  readonly vendorId: string;
  readonly status: string; // 'recorded' | 'superseded' | 'expired'
  readonly validUntil: string; // ISO civil date
  readonly leadTimeDays: number | null;
  readonly paymentTerms: string | null;
  readonly warrantyTerms: string | null;
  readonly historicalScore: string | null;
  readonly recordedAt: string;
  readonly recordedById: string;
  readonly lines: readonly VendorQuoteLineDto[];
}

export interface QuoteComparisonDto {
  readonly id: string;
  readonly status: string; // 'draft' | 'approved'
  readonly selectedQuoteId: string | null;
  readonly selectedVendorId: string | null;
  readonly reason: string | null;
  readonly justification: string | null; // REQUIRED when the selection is not the lowest landed total
  readonly approvedById: string | null;
  readonly approvedAt: string | null;
}

export interface RfqDto {
  readonly id: string;
  readonly requisitionId: string;
  readonly status: string; // 'issued' | 'closed'
  readonly issuedAt: string;
  readonly issuedById: string;
  readonly quotes: readonly VendorQuoteDto[];
  readonly comparison: QuoteComparisonDto | null;
}

/** The `requisition.submitted|approved` event payload (§G catalog). */
export interface RequisitionEventPayload {
  readonly requisitionId: string;
  readonly lines: readonly { readonly requirementId: string; readonly revision: number; readonly qty: string }[];
}

/** The `comparison.approved` event payload (§G catalog). */
export interface ComparisonEventPayload {
  readonly comparisonId: string;
  readonly selectedVendorId: string;
  readonly authority: string; // the approving user's id — real attribution
  readonly reason: string;
}
