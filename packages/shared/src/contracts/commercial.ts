/**
 * Phase 5 Task 1 — the COMMERCIAL module contract (shared, runtime-importable on both sides).
 *
 * Commercial is a SINK (plan §K): it READS procurement, inventory, labour and activities, and
 * NOTHING reads it. No readiness gate consults it — an unpaid bill, a breached budget and a
 * disputed certification must never stop an activity from starting or a receipt from being
 * accepted. Money follows the site; it does not command it.
 *
 * Task 1 scope (plan §C/§L): the per-project `commercial` capability, the cost-head catalog, and
 * the `CommitmentAttribution` — the ONLY new fact §C admits. The attribution carries NO amount:
 * the committed amount already exists, frozen with provenance, on the PO-line snapshot, and the
 * `COMMITTED` fold that reads it through each line's OWNING module lands with the budget it is
 * measured against (Task 2).
 */

/** The per-project pilot capability (the same mechanism as `materials` and `labour`). */
export const COMMERCIAL_CAPABILITY = 'commercial';

/** The commercial module's state-changing commands (must equal the manifest `commands`).
 *  Task 1 ships the catalog write and the standalone RE-ATTRIBUTION. The INITIAL attribution is
 *  not a command here: §C requires it to be written inside the transaction that makes a PO
 *  version live, through `CommercialParticipant.attribute`, or a newly issued order is a live
 *  unattributed obligation until someone runs a separate command. */
export const COMMERCIAL_COMMANDS = [
  'commercial.costHead.define',
  'commercial.attribution.reattribute',
  // Phase 5 Task 2 (§B) — one command for v1 and every revision; the chain is immutable.
  'commercial.budget.set',
  // Phase 5 Task 3 (§D) — take a measurement, and CORRECT one with a signed delta. Two commands
  // rather than one: an original and a correction carry different authority questions and a
  // correction must name the row it walks back, so one command would have to branch on a nullable
  // field to decide which rules apply.
  'commercial.measurement.take',
  'commercial.measurement.correct',
  // Phase 5 Task 4 (§F) — the vendor's CLAIM and the lifecycle up to `under-verification`.
  // `record` creates the bill at `draft` with its immutable v1 lines; `submit` is where §G
  // bounds 1–2 are evaluated and the claim becomes live OR disputed; `beginVerification` opens
  // the §E check that lands in Task 5; `amend` issues a NEW version (and RESOLVES a disputed
  // one); `reject` is the attributable judgement that a claim is not owed. There is no
  // `dispute` command: a dispute is never something a person decides about a claim, it is what
  // happens when the EVIDENCE under one moves, so it is written from the withdrawal guards
  // inside the transaction that withdrew it.
  'commercial.bill.record',
  'commercial.bill.submit',
  'commercial.bill.beginVerification',
  'commercial.bill.amend',
  'commercial.bill.reject',
  // Phase 5 Task 5A (§E) — the verdict is a COMMAND rather than a read because it has a
  // consequence: a matched claim moves to `verified`, an exception moves it to `disputed` naming
  // itself. Certification is 5B's, with the evidence that makes it safe.
  'commercial.bill.verify',
  // Phase 5 Task 5B (§E/§F/§I) — CERTIFY a verified claim, and SUPERSEDE a certificate. Two
  // commands rather than one reversible act: past certification §F's correction path IS a
  // superseding certificate, because a status flip would leave the certificate — and everything
  // that will hang off it in Task 6 — orphaned. They also carry different authority questions:
  // certifying asks §I's segregation rule, superseding asks only whether one stands.
  'commercial.bill.certify',
  'commercial.certificate.supersede',
  // Phase 5 Task 5B (§I) — the APPROVER's own act. Separate from `certify` because it is a
  // different person doing a different thing: certification is the certifier's, the grant that
  // excuses it is the authority's. One command taking an `approverId` cannot tell them apart, and
  // that is exactly how an override becomes a name the certifier typed.
  'commercial.sod.grant',
] as const;
export type CommercialCommand = (typeof COMMERCIAL_COMMANDS)[number];

/** The commercial module's read queries (must equal the manifest `queries`). */
export const COMMERCIAL_QUERIES = [
  'commercial.costHeads',
  'commercial.attributions',
  // Phase 5 Task 2 — BUDGET/COMMITTED per head plus any OPEN over-budget exception.
  'commercial.budget',
  // Phase 5 Task 3 — the §D measurement register for a labour PO line, with its folded total.
  'commercial.measurements',
  // Phase 5 Task 4 — the vendor claims of a project, and ONE claim with its version history.
  'commercial.bills',
  'commercial.bill',
  // Phase 5 Task 5A — the §E triple as a READ, so a reviewer can see the verdict without moving
  // the claim. Derived on every call: a stored verdict is stale the moment a receipt is reversed.
  'commercial.verification',
  // Phase 5 Task 5B — the LIVE certificate on a claim, with its frozen evidence. Unlike the
  // verification triple this is NOT derived: a certificate is a FACT that was written, and
  // recomputing it would be recomputing a decision.
  'commercial.certificate',
] as const;
export type CommercialQuery = (typeof COMMERCIAL_QUERIES)[number];

/** A cost head, as the read surface reports it. */
export interface CostHeadDto {
  code: string;
  name: string;
  definedAt: string;
  definedById: string;
}

/** An attribution row. There is no `amount` — §C forbids the column and probe 5bi asserts it. */
export interface CommitmentAttributionDto {
  id: string;
  poLineId: string | null;
  labourPoLineId: string | null;
  costHeadCode: string;
  reason: string;
  createdAt: string;
  createdById: string;
  supersededAt: string | null;
  supersededById: string | null;
  supersedeReason: string | null;
}

/**
 * Phase 5 Task 2 (§B/§J) — one cost head's money picture.
 *
 * Every amount is a decimal STRING, never a JS number: §A requires exact `Decimal(18,2)` end to
 * end, and serializing through float64 would corrupt the very figures the exception is raised on.
 *
 * `budget` and `headroom` are NULL together, and that pair is not "zero": an unbudgeted head has
 * no authority to breach. Reporting it as ₹0 would flag every commitment on a project that has
 * not budgeted yet, which is the normal state of a project mid-setup.
 */
export interface CostHeadPositionDto {
  costHeadCode: string;
  costHeadName: string;
  /** the LIVE budget version's amount, or null when the head is unbudgeted */
  budget: string | null;
  /** the version number of that live budget line, or null when unbudgeted */
  budgetVersion: number | null;
  /** OUTSTANDING obligation — gross committed less the consumed and released parts (§0) */
  committed: string;
  /** received-but-unbilled value — the received side LESS whatever has been claimed against it */
  receivedNotBilled: string;
  /** §J `awaiting-certification` — live `BILLED_AMOUNT`: claimed, not yet certified. Together with
   *  `receivedNotBilled` this PARTITIONS the received money, so a claim arriving changes WHERE the
   *  exposure sits and not how much there is (Phase 5 Task 4). */
  awaitingCertification: string;
  /** §J `certified-payable` — money a certifier has turned into an obligation anyone may approve.
   *  §J defines it as `NET_PAYABLE − APPROVED`; deductions (5C) and approvals (Task 6) each
   *  subtract into it when their facts arrive. Certification MOVES money here out of
   *  `awaitingCertification` rather than adding to the total, so a surface still reporting a
   *  certified claim as awaiting certification is saying the act has not happened after it has. */
  certifiedPayable: string;
  /** `BUDGET − Σ exposure`, NEGATIVE when over-committed; null when unbudgeted */
  headroom: string | null;
  /** the OPEN over-budget exception on this head, if one stands right now */
  exception: BudgetExceptionDto | null;
}

/** An over-budget exception. It flags; it never gates (§B) — no PO is blocked by one. */
export interface BudgetExceptionDto {
  id: string;
  costHeadCode: string;
  headroom: string;
  budget: string;
  exposure: string;
  /** which of §B's five headroom-moving writes raised it. `acceptance` is the accepted-overage
   *  case (§G authorises more than the ordered quantity and no commitment releases against the
   *  extra units); `receipt_progress` is a receipt recorded, rejected or reversed, which re-prices
   *  a CLOSED-SHORT line's released remainder with nothing accepted at all. */
  raisedBy: 'commitment' | 'budget_revision' | 'reattribution' | 'acceptance' | 'receipt_progress' | 'measurement' | 'claim';
  raisedAt: string;
  raisedById: string;
  clearedAt: string | null;
}

/** The `commercial.budget` read: every cost head's position, worst headroom first. */
export interface CommercialBudgetDto {
  positions: CostHeadPositionDto[];
  /** how many heads currently stand over budget — the Inbox action count (§B) */
  openExceptions: number;
}

/**
 * §L: enabling `commercial` on a project that already holds live POs must ATTRIBUTE them in the
 * enabling transaction — a capability-on project whose forecast silently omits every commitment
 * predating enablement is the "observational not operational" defect Phase 3 Task 7 was blocked
 * for. And the enable path must be able to SUCCEED, not only refuse: while the capability is off
 * there are no commercial routes, so an operator told to "go and choose a cost head" has no
 * surface on which to choose. The mapping is therefore INPUT.
 */
export interface CommercialActivationPlan {
  /** The cost heads to create in the enabling transaction. */
  costHeads: { code: string; name: string }[];
  /** Every live material PO line, mapped to the head that carries it. */
  materialLines: { poLineId: string; costHeadCode: string }[];
  /** Every live labour PO line, mapped to the head that carries it. */
  labourLines: { labourPoLineId: string; costHeadCode: string }[];
  /** Attributable justification, recorded on every backfilled row. */
  reason: string;
}

/**
 * Phase 5 Task 3 (§D) — one measurement row. Quantities are decimal STRINGS at `Decimal(18,6)`:
 * person-shifts are divisible (a half shift is real) and §A forbids a float64 round trip.
 *
 * `quantity` is SIGNED — a correction is a negative row, never an edit — so a reader that sums
 * this column gets `MEASURED(poLine)` with no stored balance to drift.
 */
export interface MeasurementDto {
  id: string;
  labourPoLineId: string;
  activityId: string;
  /** person-shifts; negative on a correction */
  quantity: string;
  /** the measurement this row adjusts, or null for an original */
  correctsId: string | null;
  reason: string | null;
  measuredOn: string;
  /** the `ActivityWorkOutput` cited as progress EVIDENCE (§0 — a predicate, never drawn down) */
  citedOutputId: string;
  evidenceMediaId: string | null;
  takenAt: string;
  takenById: string;
}

/** The `commercial.measurements` read for ONE labour PO line: the rows and what they fold to. */
export interface MeasurementRegisterDto {
  labourPoLineId: string;
  rows: MeasurementDto[];
  /** `MEASURED(poLine)` — the fold, never a stored total */
  measured: string;
  /** `EFFORT(poLine)` — worked minutes normalised to person-shifts; the quantity cap */
  effort: string;
  /**
   * the quantity ORDERED on this line, frozen at issue. Historical fact, NOT the current cap —
   * see `liveAuthorityPersonShiftQty`.
   */
  orderedPersonShiftQty: number;
  /**
   * what the line authorises NOW, and the cap the write path actually enforces (Codex round-4 P2).
   * `0` once the supplier commitment is DEFAULTED — the source reneged and the line can never be
   * re-committed — and the committed quantity once the version is CLOSED SHORT. Reporting only the
   * frozen order made the register state a cap that was not real: a 10-shift line closed short to 4
   * showed 10 while every measurement above 4 was refused.
   */
  liveAuthorityPersonShiftQty: number;
  /** whether this line's supplier commitment was defaulted (why the live authority can be `0`) */
  defaulted: boolean;
}

/**
 * Phase 5 Task 4 (§F) — the vendor bill LIFECYCLE.
 *
 * Task 4 can only REACH the first six. `verified` and everything past it belong to the task that
 * produces their evidence: `verified` is the state whose safety IS the §E three-way verdict, so
 * shipping the transition here while §E lands in Task 5 would let a bill reach it before the
 * ordered/accepted/billed comparison exists — and pulling §E forward would bypass the Task-5
 * review stop that guards it. They are named here because §0's LIVE rule is defined over the
 * WHOLE set, and the billed folds must keep meaning the same thing when Task 5 adds the arrows.
 */
export const VENDOR_BILL_STATUSES = [
  'draft',
  'submitted',
  'under-verification',
  'disputed',
  'resolved',
  'rejected',
  // ── not reachable at the Task-4 tree ──
  'verified',
  'certified',
  'approved-for-payment',
  'part-paid',
  'paid',
] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

/**
 * §0's LIVE rule for the billed sets, in ONE place: the bill version is not superseded AND the
 * status is none of `draft`, `rejected`, an unresolved `disputed`, or a terminal `resolved`.
 *
 * `resolved` is a RELEASED terminal state — the claim it recorded has been settled by a corrected
 * version — so counting it would fold the old claim alongside the new one. `disputed` is excluded
 * because §E's own exception path is what creates it: a 120-unit claim against 100 accepted that
 * stayed live would violate bound 2 on the spot and reserve 120 of 100 units, so the honest
 * corrected 100-unit claim could never be submitted — the dispute would block its own resolution.
 * NOT "`submitted` only": a first claim advancing to `verified` would drop out of the fold and a
 * second claim for the same quantity would pass.
 */
export const BILL_STATUSES_NOT_LIVE = ['draft', 'rejected', 'disputed', 'resolved'] as const;
export function isLiveBillStatus(status: string): boolean {
  return !(BILL_STATUSES_NOT_LIVE as readonly string[]).includes(status);
}

/** One immutable claim line. Every amount is a decimal STRING — §A forbids a float64 round trip. */
export interface VendorBillLineDto {
  id: string;
  type: 'material' | 'labour';
  /** EXACTLY ONE of the two is set — a PG XOR CHECK, plus a `type` discriminator that must agree */
  poLineId: string | null;
  labourPoLineId: string | null;
  /** base units for material, person-shifts for labour — the PO line's own unit */
  quantity: string;
  rate: string;
  taxAmount: string;
  freightAmount: string;
  /** DERIVED = round(rate × quantity, 2) + tax + freight, re-derived by a DB CHECK */
  amount: string;
}

/** One immutable claim VERSION. An amendment issues a new one retaining this verbatim. */
export interface VendorBillVersionDto {
  id: string;
  version: number;
  supersedesVersion: number | null;
  claimedAmount: string;
  lines: VendorBillLineDto[];
  createdAt: string;
  createdById: string;
  supersededAt: string | null;
  supersededById: string | null;
  supersedeReason: string | null;
  /** whether this version's lines are in the billed folds right now (§0 LIVE) */
  live: boolean;
}

/** One vendor claim: its frozen identity, its lifecycle state and its whole version history. */
export interface VendorBillDto {
  id: string;
  vendorId: string;
  /** the duplicate-claim key, frozen after write (§0b) */
  vendorBillNumber: string;
  documentDate: string;
  status: VendorBillStatus;
  statusChangedAt: string;
  /** why the claim left the live set — always present on `disputed` and `rejected` */
  statusReason: string | null;
  /**
   * §F — WHY the claim was DISPUTED, if it ever was. Separate from `statusReason` because the two
   * are different facts: the breach is the EVIDENCE that took the claim out of the live fold, and a
   * later rejection is a JUDGEMENT about the claim. Captured by the database at the moment of the
   * dispute and unwritable thereafter, so a rejection cannot erase it.
   */
  disputeReason: string | null;
  createdAt: string;
  createdById: string;
  versions: VendorBillVersionDto[];
}

/** The `commercial.bills` read: every claim on the project, newest first. */
export interface VendorBillListDto {
  bills: VendorBillDto[];
}

/**
 * The §G bound picture for ONE purchase-order line — what a claim on it may still draw.
 *
 * Every field is a §0 set by name, so a reader never re-derives a filter: `billed` is
 * `BILLED_QTY(poLine)` over LIVE claim lines, `ordered` is bound 1's right-hand side
 * (`qty + approvedOverage` for material, `personShiftQty` for labour — a labour line has no
 * overage column), and `evidence` is bound 2's (`ACCEPTED` for material, `MEASURED` for labour).
 */
export interface BillableLineDto {
  type: 'material' | 'labour';
  poLineId: string;
  vendorId: string;
  /** the PO line's own unit — base units for material, person-shifts for labour */
  uom: string;
  ordered: string;
  evidence: string;
  billed: string;
  /** `min(ordered, evidence) − billed`, floored at zero: what a further claim may still cover */
  billable: string;
}


/**
 * Phase 5 Task 5A (§E) — the exception kinds a three-way verification can return. Each names its
 * own defect: a name with no check behind it is a label, and §E is explicit that `duplicate-claim`
 * in particular needed an identity before it meant anything (the frozen vendor document reference
 * Task 4 shipped).
 */
export const VERIFICATION_EXCEPTION_KINDS = [
  'qty-over-ordered',
  'qty-over-accepted',
  'rate-mismatch',
  'tax-mismatch',
  'freight-mismatch',
  'duplicate-claim',
] as const;
export type VerificationExceptionKind = (typeof VERIFICATION_EXCEPTION_KINDS)[number];

/** §E — the triple for ONE claim line, derived and never stored. */
export interface VerificationLineDto {
  billLineId: string;
  kind: 'material' | 'labour';
  poLineId: string;
  /** ORDERED — frozen quantity and money from the PO-line snapshot */
  orderedQty: string;
  orderedRate: string;
  orderedTax: string;
  orderedFreight: string;
  /** ACCEPTED (material) or MEASURED (labour), the §0 set by name */
  evidenceQty: string;
  /** BILLED — this line, plus the rest of the live fold on the same PO line */
  billedQty: string;
  billedAmount: string;
  /** the pro-rata cap: frozen tax/freight scaled by `min(BILLED_QTY, qty) / qty` (§E) */
  taxCap: string;
  freightCap: string;
  exceptions: VerificationExceptionKind[];
}

/** §E — `matched` or the exceptions that stopped it. Derived at every transition that depends on it. */
export interface VerificationDto {
  billId: string;
  versionId: string;
  verdict: 'matched' | 'exception';
  lines: VerificationLineDto[];
  /** every exception across every line, deduplicated — what the dispute reason is built from */
  exceptions: VerificationExceptionKind[];
  /**
   * Where the CLAIM stands, alongside what the TRIPLE says (Codex round-4). These answer different
   * questions and the payload carries both so neither can be mistaken for the other: the verdict
   * is §E's arithmetic over ordered/accepted/billed, while the status is the claim's disposition,
   * which a §G bound at submission or a withdrawal guard can move without any §E verdict existing.
   * A claim disputed for its evidence and then re-evidenced reads `matched` with a `disputed`
   * status — true on both counts, and §E is explicit that an exception "does not auto-reject": it
   * takes an attributable amendment to move the claim, not a recomputation that now agrees.
   */
  billStatus: VendorBillStatus;
}

/** §I — the approver's OWN act: permission for one otherwise-forbidden certification. */
export interface SodGrantDto {
  id: string;
  billId: string;
  versionId: string;
  rule: string;
  /** the person being excused */
  actorId: string;
  /** the authority — and the authenticated author of the grant */
  approverId: string;
  reason: string;
  grantedAt: string;
  consumedAt: string | null;
  consumedByCertificateId: string | null;
}

/** §I — the attributable record that made an otherwise-forbidden act valid. */
export interface SodExceptionDto {
  /** which rule was overridden, e.g. `evidence-recorder-may-not-certify` */
  rule: string;
  /** the actor the rule would have refused */
  actorId: string;
  /** the stronger authority that authorized it */
  approverId: string;
  reason: string;
  recordedAt: string;
  /** the grant this override rests on — the approver's own authenticated act */
  grantId: string | null;
}

/** §E — one row of a certificate's FROZEN evidence: WHICH row, and HOW MUCH of it. */
export interface CertifiedConsumptionDto {
  /** the `acceptance` StockTransaction id, or the `Measurement` id */
  rowId: string;
  consumedQty: string;
}

/**
 * Phase 5 Task 5B (§E/§F/§G/§I) — a CERTIFICATE: the act that turns a verified claim into money
 * anyone may approve.
 *
 * Every amount is a decimal STRING (§A `Decimal(18,2)`, half-up), never a JS number.
 *
 * **There is no `netPayable` field here, and its absence is deliberate.** §G bound 4 defines it as
 * `CERTIFIED − unreleased deductions`, and the §H deduction ledger is Task 5C's. Reporting the
 * gross amount under that name would be an answer rather than a question: every consumer would
 * read a computed net that is silently wrong the moment the first deduction row exists. It lands
 * with the ledger that makes it true.
 */
export interface CertificateDto {
  id: string;
  billId: string;
  /** the claim VERSION this certificate was computed against — a later amendment supersedes it */
  versionId: string;
  certifiedAmount: string;
  certifiedAt: string;
  certifiedById: string;
  /** the ONE permitted transition. A superseded certificate is retained history, and §G bounds
   *  read the LIVE one only. */
  supersededAt: string | null;
  supersededById: string | null;
  supersedeReason: string | null;
  /** §I — the override that authorised this act, when the certifier recorded evidence it rests on.
   *  Null on the ordinary path, and the database enforces the biconditional both ways. */
  sodException: SodExceptionDto | null;
  /** the frozen material evidence — what the acceptance-reversal guard refuses against */
  acceptanceConsumption: CertifiedConsumptionDto[];
  /** the frozen labour evidence — what the measurement-correction floor refuses against */
  measurementConsumption: CertifiedConsumptionDto[];
}
