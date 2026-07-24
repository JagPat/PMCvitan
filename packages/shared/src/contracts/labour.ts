/**
 * Phase 4 Task 1 — the LABOUR module contract (shared, runtime-importable on both sides).
 *
 * Labour owns TRUSTED WORKFORCE IDENTITY (plan §H) and the LABOUR REQUIREMENT DETAIL (plan §B).
 * It is a LEAF module (plan §G, round-3): `dependsOn: []`. The ONLY graph edge into it is
 * `activities → labour` (the Activities requirement command writes the `LabourRequirementSpec`
 * through the cycle-exempt `LabourParticipant.writeRequirementSpec`, and — from Task 4 — the
 * coverage read). Labour never reads Activities persistence.
 *
 * Task 1 scope: the labour capability + type-routed demand (a `type='labour'` revision of the
 * SAME type-neutral `ActivityRequirement`, whose detail is the Labour-owned
 * `LabourRequirementSpec` + its explicit per-`(civilDate, shift)` demand slices), and the
 * first-class `Worker`/`Crew`/`CrewMembership` identity with a `WorkerDevice`→`Worker` FK
 * binding. Every operational row is project-contained; a cross-project reference is
 * unrepresentable in PostgreSQL (same-project composite FKs).
 */

/** The labour module's state-changing commands (must equal the manifest `commands`).
 *  Task 1 = trusted-identity onboarding (the labour requirement demand is authored through the
 *  Activities-owned `requirements.*` command, routed by `type` — it is NOT a labour command). */
export const LABOUR_COMMANDS = [
  'labour.trade.define',
  'labour.skill.define',
  'labour.worker.onboard',
  'labour.worker.revoke',
  'labour.crew.form',
  'labour.crew.revoke',
  'labour.crew.addMember',
  'labour.crew.removeMember',
  // Phase 4 Task 2 — the labour COMMERCIAL chain (§F). Supplier profile + the separate labour
  // commitment documents (their lines differ from material: person-shift slices + rate-per-person-shift).
  'labour.vendorProfile.set',
  'labour.requisition.create',
  'labour.requisition.submit',
  'labour.requisition.approve',
  'labour.requisition.reject',
  'labour.requisition.cancelLine',
  'labour.requisition.close',
  'labour.rfq.create',
  'labour.rfq.close',
  'labour.quote.record',
  'labour.comparison.create',
  'labour.comparison.approve',
  'labour.po.create',
  'labour.po.issue',
  'labour.po.amend',
  'labour.po.cancel',
  'labour.po.closeShort',
  'labour.commitment.commit',
  'labour.commitment.revise',
  'labour.commitment.default',
] as const;
// Note: the WorkerDevice->Worker binding is a Task-1 STRUCTURAL foundation (the composite
// (projectId, workerId) FK + containment; proven by the cross-project forgery probe). The
// binding COMMAND — which sets `WorkerDevice.workerId` on the orgs-owned device row — lands with
// attendance in Task 3 through the owning module, so labour writes only labour-owned tables here.
export type LabourCommand = (typeof LABOUR_COMMANDS)[number];

/** The labour module's read queries (must equal the manifest `queries`). */
export const LABOUR_QUERIES = [
  'labour.workforce',
  'labour.catalog',
  // Phase 4 Task 2 — the labour commercial-chain reads.
  'labour.vendorProfiles',
  'labour.requisitions',
  'labour.rfqs',
  'labour.pos',
  'labour.commitments',
] as const;
export type LabourQuery = (typeof LABOUR_QUERIES)[number];

/**
 * The complete labour specification reference carried by a `type='labour'` requirement revision:
 * TECHNICAL identity (fingerprinted over `(tradeCode, skillCode, shift)`, §B) + AUTHORITATIVE
 * decision provenance (server-resolved approved version + option, or all-null for a manual
 * specification). Provenance is stored, NEVER hashed — the material-spec rule verbatim.
 */
export interface LabourSpecRef {
  readonly tradeCode: string;
  readonly skillCode: string | null;
  readonly shift: string; // 'day' | 'night' — part of the fingerprinted identity
  readonly labourSpecFingerprint: string;
  readonly decisionId: string | null;
  readonly decisionVersion: number | null;
  readonly optionKey: string | null;
  /** The explicit per-`(civilDate, shift)` demand slices (§B). `shift` is the spec's shift on
   *  every slice, so the slice triple `(civilDate, shift, personShiftQty)` is complete here even
   *  though storage normalizes the shared shift onto the spec. */
  readonly demandSlices: readonly LabourDemandSliceDto[];
}

/** One explicit `(civilDate, shift, personShiftQty)` demand slice (§B). */
export interface LabourDemandSliceDto {
  readonly civilDate: string; // ISO civil date (DATE column)
  readonly shift: string; // 'day' | 'night'
  readonly personShiftQty: number; // integer person-shifts, > 0
}

/** A labour trade catalog entry (project-contained). */
export interface LabourTradeDto {
  readonly code: string;
  readonly name: string;
}

/** A labour skill catalog entry (project-contained). */
export interface LabourSkillDto {
  readonly code: string;
  readonly name: string;
}

/** A trusted, project-contained worker identity (§H) — the atomic capacity source (round-1). */
export interface WorkerDto {
  readonly id: string;
  readonly name: string;
  readonly tradeCode: string;
  readonly skillCodes: readonly string[];
  readonly activeFrom: string; // ISO civil date
  readonly activeTo: string | null; // ISO civil date, null = open-ended
  readonly revokedAt: string | null; // ISO timestamp, null = active
  readonly revokedById: string | null;
  readonly createdAt: string;
  readonly createdById: string;
  // NOTE (Task-1 correction F1): the workforce register does NOT hydrate `WorkerDevice` rows here.
  // `WorkerDevice` is an ORGS-owned model; Labour must not read it directly (read-encapsulation).
  // Device binding + its display land in Task 3 through the owning module's read contract, so no
  // `devices` field is served in Task 1 (no bind command exists yet — the field would be empty).
}

/** A named set of workers under an in-charge (`mistri`) — ORGANIZATIONAL only, NOT an atomic
 *  capacity source (round-2 finding 1; the atomic source is the `Worker`). */
export interface CrewDto {
  readonly id: string;
  readonly name: string;
  readonly inchargeWorkerId: string | null;
  readonly activeFrom: string;
  readonly activeTo: string | null;
  readonly revokedAt: string | null;
  readonly members: readonly CrewMemberDto[];
}

/** One worker's membership in a crew (project-contained; a member can never cross projects). */
export interface CrewMemberDto {
  readonly workerId: string;
  readonly addedAt: string;
  readonly removedAt: string | null;
}

/** The `labour.workforce` query result — the project's trusted workforce register. */
export interface LabourWorkforceDto {
  readonly workers: readonly WorkerDto[];
  readonly crews: readonly CrewDto[];
}

/** The `labour.catalog` query result — the project's trade/skill catalog. */
export interface LabourCatalogDto {
  readonly trades: readonly LabourTradeDto[];
  readonly skills: readonly LabourSkillDto[];
}

// ── Phase 4 Task 2 — the labour COMMERCIAL chain (§F) ────────────────────────────────────────
//
// The labour supplier IS the existing procurement-owned `Vendor(orgId,id)` bound per project by
// `ProjectVendor` (F7 — no `LabourSupplier`). Phase 4 adds only a labour-specific
// `VendorLabourProfile` (org-admin authority, like vendor CRUD) and SEPARATE labour commercial
// documents whose lines carry the SAME explicit per-`(civilDate, shift)` `personShiftQty` demand
// slices as the requirement — never a bare headcount. Labour stays a LEAF: the requirement→
// requisition bound reads the labour-owned `LabourRequirementSpec`/`LabourDemandSlice` (never
// `ActivityRequirement`), and the vendor binding is validated through `ProcurementParticipant`.

/** The labour capability a `Vendor` declares (org-admin authority). */
export interface VendorLabourProfileDto {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly trades: readonly string[]; // trade codes the vendor supplies
  readonly skills: readonly string[]; // skill codes the vendor supplies
  readonly createdAt: string;
  readonly createdById: string;
}

/** One per-`(requirementId, revision, civilDate)` demand slice a labour requisition line allocates
 *  (the spec's shift is carried on the line's fingerprint). Unit: person-shift. */
export interface LabourRequisitionLineDto {
  readonly id: string;
  readonly requirementId: string;
  readonly revision: number;
  readonly civilDate: string; // ISO civil date
  readonly shift: string;
  readonly labourSpecFingerprint: string;
  readonly personShiftQty: number; // integer person-shifts, > 0
  readonly status: string; // open | ordered | cancelled
}

export interface LabourRequisitionDto {
  readonly id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly status: string; // draft | submitted | approved | rejected | closed
  readonly createdAt: string;
  readonly createdById: string;
  readonly lines: readonly LabourRequisitionLineDto[];
}

/** One quoted rate for a requisition line (one demand slice). Unit: INR per person-shift. */
export interface SupplierLabourQuoteLineDto {
  readonly id: string;
  readonly requisitionLineId: string;
  readonly ratePerPersonShift: string; // decimal string, INR paise-safe
  readonly shiftPremium: string;
  readonly landedPerPersonShift: string; // the landed rate the comparison ranks by
  readonly matchesSpecification: boolean;
}

/** A supplier's labour quote against an RFQ. */
export interface SupplierLabourQuoteDto {
  readonly id: string;
  readonly vendorId: string;
  readonly status: string; // recorded | superseded | expired
  readonly validUntil: string; // ISO civil date
  readonly leadTimeDays: number | null;
  readonly notes: string | null;
  readonly recordedAt: string;
  readonly recordedById: string;
  readonly lines: readonly SupplierLabourQuoteLineDto[];
}

/** The labour quote comparison (draft → approved). */
export interface LabourQuoteComparisonDto {
  readonly id: string;
  readonly status: string; // draft | approved
  readonly selectedQuoteId: string | null;
  readonly selectedVendorId: string | null;
  readonly reason: string | null;
  readonly justification: string | null;
  readonly approvedById: string | null;
  readonly approvedAt: string | null;
}

/** A labour RFQ with its recorded quotes and (optional) comparison. */
export interface LabourRfqDto {
  readonly id: string;
  readonly requisitionId: string;
  readonly status: string; // issued | closed
  readonly issuedAt: string;
  readonly issuedById: string;
  readonly quotes: readonly SupplierLabourQuoteDto[];
  readonly comparison: LabourQuoteComparisonDto | null;
}

/** A frozen labour PO line — the rate snapshot for ONE demand slice. Unit: person-shift. */
export interface LabourPurchaseOrderLineDto {
  readonly id: string;
  readonly requisitionLineId: string;
  readonly requirementId: string;
  readonly revision: number;
  readonly civilDate: string;
  readonly shift: string;
  readonly labourSpecFingerprint: string;
  readonly personShiftQty: number;
  readonly ratePerPersonShift: string; // decimal string, INR paise-safe
  readonly shiftPremium: string;
  readonly committedAmountBase: string;
  readonly committedQty: number; // person-shifts committed against this line (progress)
}

export interface LabourPurchaseOrderVersionDto {
  readonly id: string;
  readonly version: number;
  readonly status: string; // draft|issued|partially_committed|completed|amended|cancelled|closed_short
  readonly supersedesVersion: number | null;
  readonly lines: readonly LabourPurchaseOrderLineDto[];
}

export interface LabourPurchaseOrderDto {
  readonly id: string;
  readonly vendorId: string;
  readonly requisitionId: string;
  readonly comparisonId: string;
  readonly currentVersion: LabourPurchaseOrderVersionDto;
  readonly versions: readonly LabourPurchaseOrderVersionDto[];
}

/** One dated arrival/rate promise in the append-only register (§F). */
export interface CapacityPromiseDto {
  readonly seq: number;
  readonly promisedDate: string; // ISO civil date
  readonly reason: string | null;
  readonly recordedAt: string;
  readonly recordedById: string;
}

/** Inbound forecast capacity a source commits per `(civilDate, shift)` slice (§C.1). Unit: person-shift. */
export interface CapacityCommitmentDto {
  readonly id: string;
  readonly poLineId: string;
  readonly labourSpecFingerprint: string;
  readonly civilDate: string;
  readonly shift: string;
  readonly personShiftQty: number;
  readonly status: string; // committed | revised | defaulted
  readonly latestPromise: CapacityPromiseDto | null;
  readonly promises: readonly CapacityPromiseDto[];
}

export interface LabourVendorProfilesDto {
  readonly profiles: readonly VendorLabourProfileDto[];
}
export interface LabourRequisitionsDto {
  readonly requisitions: readonly LabourRequisitionDto[];
}
export interface LabourPurchaseOrdersDto {
  readonly purchaseOrders: readonly LabourPurchaseOrderDto[];
}
export interface LabourCommitmentsDto {
  readonly commitments: readonly CapacityCommitmentDto[];
}
