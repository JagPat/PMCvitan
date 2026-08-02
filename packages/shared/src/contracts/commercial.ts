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
] as const;
export type CommercialCommand = (typeof COMMERCIAL_COMMANDS)[number];

/** The commercial module's read queries (must equal the manifest `queries`). */
export const COMMERCIAL_QUERIES = [
  'commercial.costHeads',
  'commercial.attributions',
  // Phase 5 Task 2 — BUDGET/COMMITTED per head plus any OPEN over-budget exception.
  'commercial.budget',
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
