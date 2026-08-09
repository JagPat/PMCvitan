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
  // Phase 5 Task 5C (§H) — WITHHOLD money from a certified payable, and GIVE PART OF IT BACK.
  // Two commands, and a release is not an "undo": the deduction stays as history and the release
  // is its own attributable row, because a withholding that could be retracted in place is a
  // withholding nobody can audit. Their authorities are declared separately for the same reason
  // `certify` and `sod.grant` are — withholding a vendor's money and returning it are different
  // acts, and a later widening of one must not silently widen the other.
  'commercial.deduction.record',
  'commercial.deduction.release',
  // Phase 5 Task 6A (§F/§G/§I) — AUTHORISE money for payment, and RECORD it leaving. Two commands
  // because they are two acts by two authorities: an approval says the payable may be paid, a
  // payment says it was. §I keeps approval apart from certification for the same reason — the
  // actor who certified may not approve — and a single command would make that rule unstateable.
  'commercial.payment.approve',
  'commercial.payment.record',
  // Phase 5 Task 6B unit ii (§0/§H) — money coming BACK. A third act by the payer's authority, and
  // a third command rather than a signed `record`: §H makes every append-only money row strictly
  // positive with the row TYPE carrying direction, so a reversal cannot be a payment with a minus
  // sign. It is also the first step of §0's correction ORDERING — reverse the cash in full, then
  // supersede the certificate, then re-approve the reduced amount — which is why it stands alone.
  'commercial.payment.reverse',
  // Phase 5 Task 6C (§H) — cash paid to a counterparty AHEAD of any certified claim. Its own
  // command because it is its own act: an advance is not a payment of a bill (it has no approval
  // and no certificate), and the `advance-recovery` deduction that draws it down is bounded by
  // this row rather than by the certificate.
  'commercial.advance.pay',
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
  // Phase 5 Task 5C — the §H ledger for one claim, with the `NET_PAYABLE` it produces. The
  // withheld and net figures are FOLDS computed on every call: §H forbids a stored balance column,
  // so there is nothing else they could be.
  'commercial.deductions',
  // Phase 5 Task 6A — one claim's approvals and payments, with the folded approved and paid
  // totals. FOLDS on every call: §G bounds 4–5 are computed from the rows, so a stored total
  // would be a second answer to a question the ledger already answers.
  'commercial.payments',
  // Phase 5 Task 7A — §J's cash forecast, served from the EIGHTH rebuildable projection. This is
  // the only commercial read that is PROJECTED rather than folded on call, and the reason is the
  // shape of the question: `commercial.budget` answers "what is this head's position right now"
  // for a page a user is looking at, while the forecast answers "what does this project owe" for
  // the Inbox, the dashboard and the portfolio roll-up — surfaces that ask on every load, for
  // every project, and can tolerate one commit of lag. What they cannot tolerate is a fold across
  // four modules per project per page-load.
  'commercial.cash-forecast',
  // Phase 5 Task 7B-i (§M) — the money POSITION: budget, forecast, heads and the attribution
  // register from ONE repeatable-read transaction. It exists because a page assembled from four
  // separate reads can contradict itself (a re-attribution committing between two of them), which
  // is the rule `readBudget` already applies one level down. The four narrower reads above stay:
  // they answer narrower questions, and other surfaces ask them one at a time.
  'commercial.money-position',
  // Phase 5 Task 7B-ii (§M) — ONE claim's whole lifecycle from one repeatable-read transaction.
  // Same reason as `money-position` one page over: five separate reads of one claim can contradict
  // each other, and each of those reads already takes a snapshot for that reason internally.
  'commercial.claim',
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
  /** §J `approved` — `APPROVED − PAID`, authorised and not yet gone. Task 7A. */
  approved: string;
  /** §J `paid` — `PAID`, the only raw fold, because paid cash is where the money stops. Task 7A. */
  paid: string;
  /** §J — `Σ` of the SIX exposure buckets. Reported so a reader can check the partition without
   *  re-adding them, and so `headroom = budget − exposure` is visibly one subtraction rather than
   *  six the caller has to trust. `budget` is authority and is NEVER an addend here. */
  exposure: string;
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
  /** Task 6A — `payment_approval` joins the union because the DB CHECK now admits it. A label a
   *  client is told is impossible, and which the server can still return, is a client that
   *  mishandles the first real one it sees. */
  /** Task 7A — `fold_correction` joins the union: completing §J's partition RAISED exposure on
   *  every head carrying an approval, so the operator re-evaluation sweep that repairs the register
   *  after that upgrade needs a label describing what actually moved. A label a client is told is
   *  impossible, and which the server can still return, is a client that mishandles the first one. */
  raisedBy: 'commitment' | 'budget_revision' | 'reattribution' | 'acceptance' | 'receipt_progress' | 'measurement' | 'claim' | 'deduction' | 'deduction_release' | 'payment_approval' | 'fold_correction';
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
  /**
   * Whether the purchase-order version this line belongs to is LIVE.
   *
   * `append` refuses every POSITIVE row when it is not — a cancelled or superseded version orders
   * nothing — and no quantity on this DTO expresses that, so a reader could only guess. Carried
   * because a surface that offers a measurement the write path will refuse is a promise the
   * write-ahead outbox has to break.
   */
  lineLive: boolean;
  /**
   * What LIVE certificates have frozen against this line's measurement rows, GLOBALLY.
   *
   * The row-level floor `assertNoCertifiedMeasurement` enforces: an original row may not be taken
   * below what a live certificate consumes from it. It is global — any live certificate, on any
   * claim — so a reader holding one claim cannot compute it, and one holding none cannot see it at
   * all. Carried here so the floor is exact rather than a lower bound.
   */
  certifiedConsumption: CertifiedConsumptionDto[];
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

/**
 * The statuses that mean a claim is PAST CERTIFICATION — a live certificate stands behind it.
 *
 * §F derives the payment status from three folds, so `certified` is one of four post-certification
 * statuses rather than a terminal one. Stated ONCE here because three places ask the question and
 * a fourth asks it in SQL: the certificate↔status biconditional, the `supersede` guard, the read
 * surface, and `phase5_t5c_past_certification()`. Codex found the first spelling of this where the
 * database arrow was widened and the service guard was not, so a fully-withheld claim could not be
 * corrected — the rule reached the artifact it created and not the sibling already there.
 */
// (Task 6 will need this set when §F's derivation lands.)
export const BILL_STATUSES_PAST_CERTIFICATION = ['certified', 'approved-for-payment', 'part-paid', 'paid'] as const;
export function isPastCertification(status: string): boolean {
  return (BILL_STATUSES_PAST_CERTIFICATION as readonly string[]).includes(status);
}
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

/**
 * §I — the two segregation-of-duties rules, named ONCE.
 *
 * Both halves of §I are overridable by the same two-act mechanism (a grant the approver issues,
 * consumed by the act it excuses), so the rule string is part of the shared contract rather than a
 * constant each service spells for itself: a grant issued for one rule must never be spendable on
 * the other, and that is only checkable if both sides read the same name.
 */
export const SOD_RULES = {
  /** Task 5 — the actor who recorded the evidence under a claim may not certify it. */
  evidenceRecorderMayNotCertify: 'evidence-recorder-may-not-certify',
  /** Task 6A — the actor who certified a claim may not approve its payment. */
  certifierMayNotApprove: 'certifier-may-not-approve',
} as const;

export type SodRule = (typeof SOD_RULES)[keyof typeof SOD_RULES];

/** §I — the approver's OWN act: permission for one otherwise-forbidden certification or approval. */
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
  /** Task 6A — the payment half. A grant is consumed by exactly one act, of exactly one kind. */
  consumedByApprovalId: string | null;
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

// ── Phase 5 Task 5C (§H) — the DEDUCTION ledger ─────────────────────────────────────────────

/**
 * The §H deduction types.
 *
 * `advance-recovery` arrived in Task 6C, WITH the `VendorAdvance` row that caps it — 5C left it out
 * on purpose and said why: it "folds against an `advance` row created when the advance is PAID, so
 * the enum member arrives in Task 6 with the row that caps it. §0b's 'every declared member is in
 * the fold' rule then holds at BOTH stages, rather than being briefly false while a declared type
 * had nothing to fold against." Shipping the member alone would have been a withholding bounded by
 * nothing; shipping the advance alone would have been cash with no way home.
 */
export const DEDUCTION_TYPES = ['retention', 'advance-recovery', 'penalty', 'other'] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

/**
 * The types that must carry a reason. A `retention` is a contract term; these are judgements.
 *
 * `advance-recovery` is NOT here, and that is the same distinction rather than an omission: it
 * recovers a specific advance the practice already recorded with its own required reason, so the
 * justification lives on the `VendorAdvance` row. Demanding a second one here would ask the
 * operator to restate a fact the ledger already holds.
 */
export const DEDUCTION_TYPES_REQUIRING_REASON: readonly DeductionType[] = ['penalty', 'other'];

/** One withholding against a certified payable. Append-only: corrected by a release, never edited. */
export interface BillDeductionDto {
  id: string;
  certificateId: string;
  billId: string;
  type: DeductionType;
  /** decimal STRING — §A forbids a float64 round trip */
  amount: string;
  reason: string | null;
  recordedAt: string;
  recordedById: string;
  /** `amount` less everything released against it — a FOLD, never a stored column */
  unreleased: string;
  releases: BillDeductionReleaseDto[];
}

/** Giving back part of a withholding. Its own row, its own authority, its own attribution. */
export interface BillDeductionReleaseDto {
  id: string;
  deductionId: string;
  amount: string;
  reason: string;
  releasedAt: string;
  releasedById: string;
}

/** The `commercial.deductions` read: one bill's ledger and the payable it produces. */
export interface BillDeductionLedgerDto {
  billId: string;
  /** null when no certificate stands — there is nothing to withhold from */
  certificateId: string | null;
  certifiedAmount: string | null;
  deductions: BillDeductionDto[];
  /** Σ unreleased withholdings against the live certificate */
  withheld: string;
  /** §G bound 4 — `CERTIFIED` less unreleased deductions. Never negative: the floor is enforced on
   *  the deduction write, so no fold ever has to clamp it. */
  netPayable: string | null;
  /** the DERIVED bill status (§F). Task 6B made it a function of the three folds, so this and the
   *  numbers above are read from one snapshot and cannot contradict each other. */
  billStatus: VendorBillStatus;
  /** Task 6C (§H) — what this claim's counterparty still owes back, and what it was advanced.
   *  A FOLD over the vendor's advances less every advance-recovery taken across its claims, so an
   *  operator can see the ceiling BEFORE a recovery is refused by it rather than only in the
   *  refusal. Vendor-scoped, not bill-scoped: an advance is paid to a counterparty, not to a bill. */
  advance: VendorAdvancePositionDto;
}

/** Phase 5 Task 6C (§H) — one counterparty's advance position on this project. */
export interface VendorAdvancePositionDto {
  vendorId: string;
  /** Σ advances paid to this counterparty — decimal STRINGs throughout (§A) */
  advanced: string;
  /** Σ `advance-recovery` deductions across this counterparty's claims, live certificate or
   *  superseded: supersession never refunds an advance, so a recovered balance stays recovered */
  recovered: string;
  /** `advanced − recovered`, the ceiling a further recovery is bounded by. Never negative — the
   *  bound is enforced on the deduction WRITE, so no reader has to clamp it. */
  recoverable: string;
}

/** Phase 5 Task 6C (§H) — cash paid to a counterparty ahead of any certified claim. */
export interface VendorAdvanceDto {
  id: string;
  vendorId: string;
  /** decimal STRING — §A forbids a float64 round trip. Strictly positive (§H). */
  amount: string;
  /** what the advance is FOR. Required: an advance is recovered over later bills, and one nobody
   *  can explain is a payment with no story attached to it. */
  reason: string;
  method: string;
  reference: string | null;
  paidAt: string;
  paidById: string;
}

/** Phase 5 Task 6A — one authorisation that a certified payable may be paid. */
export interface PaymentApprovalDto {
  id: string;
  billId: string;
  certificateId: string;
  /** decimal STRING — §A forbids a float64 round trip */
  amount: string;
  approvedAt: string;
  approvedById: string;
  /** Σ payments drawn against THIS approval — a FOLD, never a stored column */
  paid: string;
  payments: PaymentDto[];
  /**
   * §I — the override this approval rests on, when the approver is the actor who certified. Null
   * on the ordinary two-person path. It is READABLE for the same reason the certificate's own
   * exception is: an authority nobody can see is an authority nobody can review.
   */
  sodException: SodExceptionDto | null;
}

/** Money that actually left, against an approval that covered it. */
export interface PaymentDto {
  id: string;
  approvalId: string;
  billId: string;
  amount: string;
  /** how it moved, so the practice can reconcile against a bank statement */
  method: string;
  reference: string | null;
  paidAt: string;
  paidById: string;
  /** Task 6B-ii — Σ reversals against THIS payment. A FOLD, never a stored column, and what a
   *  further reversal is bounded by. */
  reversed: string;
  /** the reversals themselves. An append-only fact that lowers `PAID` and is invisible on the
   *  ledger is money movement nobody can review, which is the opposite of what these rows are for. */
  reversals: PaymentReversalDto[];
}

/** Phase 5 Task 6B unit ii — cash coming back, against the payment that moved it. */
export interface PaymentReversalDto {
  id: string;
  paymentId: string;
  billId: string;
  /** decimal STRING — §A forbids a float64 round trip. Strictly positive: the row TYPE carries the
   *  direction, so `PAID` subtracts this rather than adding a negative. */
  amount: string;
  /** why the money came back. Required: recovering cash is its own attributable act (§0), never a
   *  side effect of correcting a document. */
  reason: string;
  reversedAt: string;
  reversedById: string;
}

/** The `commercial.payments` read: one bill's authorisations and what has been paid against them. */
export interface BillPaymentLedgerDto {
  billId: string;
  /** null when no certificate stands — there is nothing to approve against */
  certificateId: string | null;
  approvals: PaymentApprovalDto[];
  /** §G bound 4's left side — Σ approvals against the LIVE certificate */
  approved: string;
  /** §G bound 5's left side — `PAID(bill)`, which is Σ payments MINUS Σ payment reversals (§0).
   *  Task 6B-ii supplies the reversal term, so this number can now FALL. */
  paid: string;
  /** `NET_PAYABLE` less what is already approved: what a further approval may still authorise.
   *  Never negative — bound 4 refuses the write that would take it there. */
  approvable: string | null;
  /** the STORED bill status. §F's derivation reads three folds and lands in Task 6B with the
   *  reversal rows that make it correct, so this reports what IS rather than what a partial
   *  derivation would guess — exactly as the deduction ledger does. */
  billStatus: VendorBillStatus;
}

/**
 * §J — the project-wide cash forecast, the EIGHTH rebuildable projection's stored shape.
 *
 * `heads` is the SAME `CostHeadPositionDto` the live `commercial.budget` read serves, produced by
 * the same serializer. That is deliberate and load-bearing: §J's seven bucket definitions are
 * subtle enough that two of them were corrected in opposite directions across plan revisions, so
 * there must be exactly ONE place a bucket is defined. A parallel row shape here would be a second
 * place for a definition to drift to, and the drift would be invisible — both surfaces would keep
 * returning plausible money.
 */
export interface CashForecastDto {
  /** every cost head's position, worst headroom first — identical to `commercial.budget` */
  heads: CostHeadPositionDto[];
  /** the project roll-up */
  totals: CashForecastTotalsDto;
}

/**
 * Project totals. The SIX exposure buckets sum; `budget` sums SEPARATELY.
 *
 * §J is explicit that budget is the CEILING the six are measured against and never a seventh
 * addend, so `exposure` here is the sum of the six and `headroom` is `budget − exposure` — one
 * subtraction, visibly, rather than seven terms a reader has to trust.
 *
 * A head with NO budget contributes nothing to `budget` and its exposure still counts. That is the
 * honest reading rather than a convenience: unbudgeted spend is exposure nobody authorised, not
 * exposure that does not exist, and netting it away would make a project that has budgeted nothing
 * report perfect headroom.
 */
export interface CashForecastTotalsDto {
  /** Σ `BUDGET` over BUDGETED heads — authority, never an addend of `exposure` */
  budget: string;
  committed: string;
  receivedNotBilled: string;
  awaitingCertification: string;
  certifiedPayable: string;
  approved: string;
  paid: string;
  /** Σ of the six above — the money the project is exposed to */
  exposure: string;
  /** `budget − exposure`, NEGATIVE when the project is over-committed in aggregate */
  headroom: string;
}

/** The `commercial.cash-forecast` read: the projected forecast plus how stale it is. */
/**
 * Phase 5 Task 7B-i (§M) — the MONEY POSITION, from ONE server snapshot.
 *
 * The §M hub's *where do we stand* tabs read this single DTO rather than four endpoints, because a
 * page assembled from four database moments can contradict itself: a re-attribution committing
 * between two requests shows a line's obligation under one head in the budget while the attribution
 * register still names the other. The server folds all four in ONE repeatable-read transaction —
 * the same rule `readBudget` already applies one level down.
 */
export interface CommercialMoneyPositionDto {
  budget: CommercialBudgetDto;
  cashForecast: CashForecastReadDto;
  costHeads: CostHeadDto[];
  /** The WHOLE register, superseded history included — a re-attribution supersedes and inserts
   *  rather than editing in place. A *current commitments* surface filters `supersededAt === null`;
   *  the history is carried so a reader can explain how a line got where it is. */
  attributions: CommitmentAttributionDto[];
}

/**
 * Phase 5 Task 7B-ii (§M) — ONE CLAIM'S WHOLE LIFECYCLE, from one repeatable-read transaction.
 *
 * An accountant processing a vendor claim reads five things about it: the claim and its version
 * history (§D/§F), the §E verification triple, the live §E certificate, the §H deduction ledger
 * with its `NET_PAYABLE`, and the §G approvals and payments. Assembled from five HTTP reads, that
 * page contradicts itself the moment anything commits between two of them — a payment landing
 * between the deduction ledger and the payment ledger shows a net payable that disagrees with the
 * paid total, and every number on screen was true once.
 *
 * Each of those reads ALREADY takes a repeatable-read snapshot for exactly this reason, one level
 * down: `commercial.deductions` and `commercial.payments` both carry the comment explaining why
 * their own folds must share one instant. This is that rule applied one layer up, the same move
 * `commercial.money-position` made for the §B/§C/§J page.
 *
 * The narrower per-bill reads stay. They answer narrower questions and other surfaces ask them one
 * at a time; this one exists because a LIFECYCLE page asks all of them at once.
 */
export interface CommercialClaimDto {
  bill: VendorBillDto;
  /** The §E triple, DERIVED on every call — a stored verdict is stale the moment a receipt is
   *  reversed, which is why the standalone read derives it too. */
  verification: VerificationDto;
  /** The LIVE certificate, or null when none stands. Null rather than a 404: a claim before
   *  certification is an ordinary state of this page, not a missing resource. */
  certificate: CertificateDto | null;
  deductions: BillDeductionLedgerDto;
  payments: BillPaymentLedgerDto;
  /** §D — the measurement register behind each LABOUR line this claim bills, keyed by the labour
   *  PO line. Material lines carry no measurement (their evidence is accepted stock), so the map is
   *  empty for a material-only claim rather than carrying empty registers. */
  measurements: Record<string, MeasurementRegisterDto>;
  /** §I — what authorisation stands for THE CALLER on this claim's live version. */
  certifyPreflight: CertifyPreflightDto;
  /** §I — every LIVE authorisation on this claim's live version, whoever it names.
   *
   *  Codex F3. `certifyPreflight` answers only for the caller, so an APPROVER who has just
   *  authorised someone else reloads this bundle and sees nothing about the grant they issued —
   *  which made the claim read clear that grant's pending key while showing no trace of it, and
   *  re-armed the form for a duplicate. §I's own rule is that the exception is NAMED rather than
   *  silent, so the honest fix is for the read to actually carry it rather than for the key to be
   *  held against a read that can never show it.
   *
   *  `commercial.read` is a pmc/engineer surface and a grant is an attributable authority decision,
   *  so listing it here tells the same people the register already tells. */
  sodGrants: SodGrantSummaryDto[];
}

/** §I — one live, unconsumed authorisation on a claim's live version. */
export interface SodGrantSummaryDto {
  id: string;
  /** the person being EXCUSED */
  actorId: string;
  /** the pmc who authorised it — never the excused actor; the server refuses a self-grant */
  approverId: string;
  rule: string;
  reason: string;
  grantedAt: string;
  /** Whether THIS grant would actually authorise a certification (Codex round 3).
   *
   *  A live row is not the same as a usable authority: it may name a DIFFERENT §I rule (the
   *  payment half, `certifier-may-not-approve`), or its approver may have lost pmc standing since
   *  granting it. The certification resolver filters on both, so a screen that blocked a
   *  replacement grant merely because a row existed would leave the named actor refused and no pmc
   *  able to fix it from the page where the refusal happens.
   *
   *  Computed server-side by the same standing rule the command uses, because standing is the orgs
   *  module's question and a client cannot answer it at all. */
  usableForCertification: boolean;
}

/**
 * §I — the part of "may I certify this claim?" that a READ can answer exactly.
 *
 * What it carries is the CALLER'S OWN grant state, resolved by the same `resolveGrant` the
 * certification command uses, so the screen and the server cannot disagree about it. It closes the
 * two outcomes that are otherwise invisible: an exception that was granted and is live, and one
 * granted against an EARLIER version — the claim was amended since, so it needs authorising again,
 * which a certifier has no way to discover except by being refused.
 *
 * What it deliberately does NOT carry is whether the caller is one of this claim's EVIDENCE ACTORS
 * — that is, whether a grant is needed at all. The reason is worth stating rather than leaving as
 * an omission, because the missing term looks like an oversight and is not:
 *
 *   §I asks about the rows the certificate FREEZES, and that set is decided by the draw
 *   (`drawMeasurements`/`drawAcceptances`) over rows locked in a total order inside the
 *   certification transaction. `phase5_t5_evidence_actors` reads the frozen rows, so it cannot be
 *   asked before they exist. Three ways to answer it here were considered and all are worse than
 *   silence: a prospective SQL twin would be a SECOND implementation of a rule whose whole history
 *   is two implementations drifting apart; a rolled-back dry run is a heavy side-effecting write
 *   dressed as a read; and "every actor on the line" OVER-refuses, because an actor whose evidence
 *   an earlier live certificate already consumed is not in this certificate's evidence at all —
 *   and blocking a certification the server would accept is as wrong as offering one it refuses.
 *
 * So a screen may say "you hold a live authorisation" or "yours was granted against an earlier
 * version" with certainty, and may NOT say "you will need one". That outcome stays a server
 * refusal, and the answer to an unpredictable refusal is to make it legible and its remedy
 * reachable — not to guess it.
 */
export interface CertifyPreflightDto {
  /** `live` — an authorisation stands for this caller on this version, and certification would
   *  consume it. `stale-version` — one stands, but against a version this claim has amended past.
   *  `approver-lost-standing` — one stands, but no granting approver still holds pmc standing.
   *  `none` — no unconsumed authorisation names this caller on this claim. NONE of these four says
   *  whether one is NEEDED; see above. */
  grantState: 'live' | 'stale-version' | 'approver-lost-standing' | 'none';
  /** The authorisation that would be consumed, when `grantState` is `live`; null otherwise. */
  grantId: string | null;
  /** WHO this caller may authorise on this project (Codex round 3).
   *
   *  Enumerated by the ORGS module's own standing rule, not derived from the project member list:
   *  an org owner/admin operating this project through the documented pmc fallback holds no
   *  `Membership` row at all, so a picker built from members could never offer them even though
   *  the server would accept a grant naming them — and they are exactly the person a two-person
   *  site is likely to need authorised. Excludes this caller: §I refuses a self-grant.
   *
   *  Ids only. Display names come from the project team where it has them, and an id with no
   *  member row is shown as itself rather than hidden — hiding it would recreate the omission. */
  authorisableActorIds: string[];
  /** The actor id the SERVER resolved for this caller (Codex F1).
   *
   *  Returned because §I forbids a self-grant and the client otherwise has no way to honour that:
   *  the session carries a role and a name, never an actor id, so an authorisation form could not
   *  tell the approver apart from the people they may authorise. It is the caller's own identity
   *  handed back to the caller — no one else's — and it lets the picker exclude the one choice the
   *  server is certain to refuse, instead of queueing it into the write-ahead outbox and reporting
   *  it saved. */
  callerActorId: string;
}

export interface CashForecastReadDto extends CashForecastDto {
  /** when the serving generation last recomputed this project's row, or null if it never has.
   *  Reported because §J's consumer is ordered and asynchronous for foreign facts: a surface that
   *  cannot say how old its money figure is cannot be argued with. */
  refreshedAt: string | null;
}

// §F's `deriveBillStatus` is NOT here. It reads three folds and two of them — `APPROVED` and
// `PAID` — arrive with Task 6's approval and payment rows, so the function lands beside them
// rather than being written against two structural zeroes. Task 5C moves the money a deduction
// withholds; Task 6 moves the status that money implies.
