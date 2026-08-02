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
  /** received-but-unbilled value; Tasks 4–6 subtract `BILLED_AMOUNT` from it */
  receivedNotBilled: string;
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
  raisedBy: 'commitment' | 'budget_revision' | 'reattribution' | 'acceptance' | 'receipt_progress' | 'measurement';
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
  /** the ordered authority this line carries; measurement may not exceed it either */
  orderedPersonShiftQty: number;
}
