import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';
import {
  runT2CDiagnostics,
  summarizeT2C,
  T2C_MARKER_COLUMN,
  T2C_REFERENCED_TABLES,
  type T2CDiagnosticsReport,
  type T2CTxClient,
} from './t2c-diagnostics';

/**
 * Phase 4 Task 2 correction (round 2) — the CONTROLLED operator repair engine for the labour
 * commercial chain.
 *
 * The rows that violate migration `20270205000000`'s F2/F3/F4/F5 diagnostics live behind the Task-2
 * frozen/lifecycle triggers (`LabourPurchaseOrderLine_frozen`, `CapacityCommitment_lifecycle_only`,
 * …) installed by `20270201000000`. An operator therefore CANNOT repair a drifted slice/rate with an
 * ordinary UPDATE, and CANNOT "cancel" or "default" the row to clear the diagnostic (the diagnostics
 * count every row regardless of status, so a cancelled/defaulted row with a bad identity still
 * fails). This engine is the ONE sanctioned repair path, modelled exactly on the T45 engine. Every
 * repair:
 *
 *   1. Runs against an EXPLICIT, operator-authored plan (`RepairPlan`). It NEVER fabricates
 *      provenance: an F2/F4 repair to the pinned-spec / selected-quote identity is VALIDATED against
 *      the canonical tables before it is applied, and the "align" repairs copy an EXISTING upstream
 *      truth (a PO line's slice from its requisition line; a commitment's slice from its PO line).
 *   2. Opens ONE bounded maintenance transaction and, inside it: creates the durable
 *      `T2CRepairAction` evidence table idempotently (a later Prisma migration cannot run while
 *      `20270205` is unresolved), records a complete before-image + operator/reason/timestamp/row-id
 *      for every action, disables ONLY the named triggers the plan's ops actually require, applies
 *      the decisions, then RE-ENABLES and VERIFIES the full labour-commercial immutability trigger
 *      set and RE-RUNS every diagnostic.
 *   3. Commits ONLY if every diagnostic reads zero AND every immutability trigger is back in
 *      `enabled` state; otherwise the whole transaction rolls back — data changes, evidence rows,
 *      trigger toggles and all — leaving the database byte-for-byte as it was, triggers firing.
 *
 * After a successful repair the operator resolves the migration record and redeploys (see
 * `docs/RUNBOOK.md §P4T2C`):
 * `prisma migrate resolve --rolled-back 20270205… && prisma migrate deploy`.
 */

/** The Task-2 frozen/lifecycle triggers a repair MAY disable, by table — nothing else is touched. */
const DISABLEABLE_TRIGGERS: Readonly<Record<string, string>> = {
  LabourPurchaseOrderLine_frozen: 'LabourPurchaseOrderLine',
  CapacityCommitment_lifecycle_only: 'CapacityCommitment',
};

/** Every labour-commercial immutability trigger whose ENABLED state the repair verifies before
 *  commit. (All were installed by `20270201000000`; `20270205` has NOT applied at repair time, so
 *  its `LabourRequisitionLine_frozen` is deliberately absent from this set.) */
const IMMUTABILITY_TRIGGERS: ReadonlyArray<string> = [
  'LabourPurchaseOrder_append_only',
  'CapacityPromise_append_only',
  'SupplierLabourQuoteLine_append_only',
  'SupplierLabourQuote_lifecycle_only',
  'LabourQuoteComparison_lifecycle_only',
  'LabourPurchaseOrderVersion_lifecycle_only',
  'LabourPurchaseOrderLine_frozen',
  'CapacityCommitment_lifecycle_only',
];

export type RepairAction =
  /** F5 — set a PO line's committedQty to the operator-supplied real value (0 ≤ q ≤ personShiftQty).
   *  The ledger truth is the live CapacityCommitment; the operator asserts it. No trigger disable. */
  | { finding: string; op: 'f5-set-committed-qty'; id: string; committedQty: number }
  /** F2.spec/F2.slice — restore a requisition line's FROZEN identity to its pinned spec fingerprint +
   *  shift and a real demand-slice civil date (all validated against the canonical tables). */
  | { finding: string; op: 'f2-restore-reqline-identity'; id: string; labourSpecFingerprint: string; shift: string; civilDate: string }
  /** F2.poline — align a PO line's copied slice (civilDate/shift/fingerprint) to its requisition line
   *  (the requisition line is canonical — the PO line copied it at freeze). Disables the PO-line freeze. */
  | { finding: string; op: 'f2c-align-poline-slice'; id: string }
  /** F3 — align a commitment's slice identity to its PO line (the PO line is canonical — the
   *  commitment copied it at commit). Disables the commitment lifecycle-only trigger. */
  | { finding: string; op: 'f3-align-commitment'; id: string }
  /** F4 — set a PO line's rate/premium to the operator-supplied terms of the comparison-selected
   *  quote line (VALIDATED to match a real quote line); committedAmountBase is re-derived. Disables
   *  the PO-line freeze. */
  | { finding: string; op: 'f4-align-poline-terms'; id: string; ratePerPersonShift: string; shiftPremium: string };

export interface RepairPlan {
  operator: string;
  reason: string;
  actions: RepairAction[];
}

export interface RepairOutcome {
  repairId: string;
  applied: number;
  /** The clean diagnostics report captured inside the transaction, immediately before commit. */
  verified: T2CDiagnosticsReport;
  triggersDisabled: string[];
  triggersRestored: string[];
}

/** Thrown when the repair rolls back — carries the diagnostics that were still dirty (if any). */
export class RepairAbortedError extends Error {
  constructor(message: string, readonly report?: T2CDiagnosticsReport) {
    super(message);
    this.name = 'RepairAbortedError';
  }
}

const TABLE_OF: Record<RepairAction['op'], string> = {
  'f5-set-committed-qty': 'LabourPurchaseOrderLine',
  'f2-restore-reqline-identity': 'LabourRequisitionLine',
  'f2c-align-poline-slice': 'LabourPurchaseOrderLine',
  'f3-align-commitment': 'CapacityCommitment',
  'f4-align-poline-terms': 'LabourPurchaseOrderLine',
};

/** The named trigger each op requires disabled — empty means the op needs NO trigger disabled. */
const TRIGGERS_FOR_OP: Record<RepairAction['op'], string[]> = {
  'f5-set-committed-qty': [],
  'f2-restore-reqline-identity': [],
  'f2c-align-poline-slice': ['LabourPurchaseOrderLine_frozen'],
  'f3-align-commitment': ['CapacityCommitment_lifecycle_only'],
  'f4-align-poline-terms': ['LabourPurchaseOrderLine_frozen'],
};

export class T2CRepairService {
  constructor(private readonly prisma: PrismaService) {}

  /** Read-only diagnostics over the top-level client (the `t2c:preflight` body). */
  async preflight(): Promise<T2CDiagnosticsReport> {
    return runT2CDiagnostics(this.prisma);
  }

  /**
   * Is the labour-commercial schema the diagnostics read even present? A fresh/empty or pre-Task-2
   * database is NOT eligible — the preflight reports "not applicable" and lets normal migrations run.
   * All checks are over `information_schema`, so this is safe on a database with no tables at all.
   */
  async schemaEligible(): Promise<{ applicable: boolean; reason: string; missing: string[] }> {
    const present = await this.prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      T2C_REFERENCED_TABLES as unknown as string[],
    );
    const have = new Set(present.map((r) => r.table_name));
    const missing = T2C_REFERENCED_TABLES.filter((t) => !have.has(t));
    const col = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      T2C_MARKER_COLUMN.table,
      T2C_MARKER_COLUMN.column,
    );
    if (Number(col[0]?.n ?? 0) === 0) missing.push(`${T2C_MARKER_COLUMN.table}.${T2C_MARKER_COLUMN.column}`);
    if (missing.length > 0) {
      return {
        applicable: false,
        reason: `labour commercial schema not present (missing: ${missing.join(', ')}) — T2C diagnostics not applicable`,
        missing,
      };
    }
    return { applicable: true, reason: 'labour commercial schema present', missing: [] };
  }

  /** Inspect the `_prisma_migrations` record for the correction migration (three-state classify).
   *  Robust to a pre-baseline database where `_prisma_migrations` does not exist yet. */
  async migrationState(): Promise<{ state: 'applied' | 'failed-pending' | 'not-applied'; row: Record<string, unknown> | null }> {
    const ledger = await this.prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`,
    );
    if (!ledger[0]?.present) return { state: 'not-applied', row: null };
    const rows = await this.prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>(
      `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = '20270205000000_phase4_t2_correction' ORDER BY started_at DESC LIMIT 1`,
    );
    const row = rows[0] ?? null;
    if (!row) return { state: 'not-applied', row: null };
    if (row.finished_at) return { state: 'applied', row: { ...row } };
    if (!row.rolled_back_at) return { state: 'failed-pending', row: { ...row } };
    return { state: 'not-applied', row: { ...row } };
  }

  /**
   * Apply an explicit repair plan under the full disable → apply → verify → re-diagnose → commit
   * protocol. Throws `RepairAbortedError` (rolling the transaction back) if anything is off; the CLI
   * surfaces it as a non-zero exit with the offending diagnostics still intact.
   */
  async repair(plan: RepairPlan): Promise<RepairOutcome> {
    if (!plan.operator?.trim()) throw new RepairAbortedError('a repair requires --operator <identity>');
    if (!plan.reason?.trim()) throw new RepairAbortedError('a repair requires --reason <text>');
    if (!Array.isArray(plan.actions) || plan.actions.length === 0) {
      throw new RepairAbortedError('the repair plan lists no actions');
    }
    // the MINIMAL trigger set (union over the plan's ops) — "only where unavoidable".
    const toDisable = new Set<string>();
    for (const action of plan.actions) {
      const ops = TRIGGERS_FOR_OP[action.op];
      if (!ops) throw new RepairAbortedError(`unknown repair op ${JSON.stringify((action as RepairAction).op)}`);
      for (const t of ops) toDisable.add(t);
    }
    const disableList = [...toDisable];
    const repairId = randomUUID();

    return this.prisma.$transaction(
      async (tx: T2CTxClient) => {
        // 0. Durable evidence table (idempotent — a later Prisma migration cannot create it while
        //    20270205 is unresolved). On rollback this CREATE is undone too, exactly as intended.
        await tx.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "T2CRepairAction" (
            "id"          bigserial PRIMARY KEY,
            "repairId"    text        NOT NULL,
            "operator"    text        NOT NULL,
            "reason"      text        NOT NULL,
            "at"          timestamptz NOT NULL DEFAULT now(),
            "finding"     text        NOT NULL,
            "op"          text        NOT NULL,
            "table"       text        NOT NULL,
            "rowId"       text        NOT NULL,
            "beforeImage" jsonb       NOT NULL,
            "detail"      jsonb
          )`);

        // 1. Disable ONLY the named triggers the plan's ops require, by name, inside this transaction.
        for (const trigger of disableList) {
          const table = DISABLEABLE_TRIGGERS[trigger];
          if (!table) throw new RepairAbortedError(`refuse to disable unknown trigger ${JSON.stringify(trigger)}`);
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        }

        // 2. Apply each decision, capturing a complete before-image into the evidence table first.
        let applied = 0;
        for (const action of plan.actions) {
          await this.applyAction(tx, repairId, plan, action);
          applied++;
        }

        // 3. Re-enable every disabled trigger, then VERIFY the FULL immutability set is enabled.
        for (const trigger of disableList) {
          const table = DISABLEABLE_TRIGGERS[trigger];
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
        }
        const triggersRestored = await this.assertTriggersEnabled(tx);

        // 4. Re-run EVERY diagnostic inside the transaction — a repair is valid only if it left the
        //    database clean. A still-dirty finding aborts (rolls back) with its report.
        const verified = await runT2CDiagnostics(tx);
        if (!verified.clean) {
          throw new RepairAbortedError(
            `repair did not clear every finding — rolling back:\n${summarizeT2C(verified)}`,
            verified,
          );
        }

        return { repairId, applied, verified, triggersDisabled: disableList, triggersRestored };
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  }

  /** Record the before-image, then apply exactly one decision. Validates the target exists and (for
   *  the identity/terms repairs) that the operator-supplied values resolve to canonical truth, so
   *  provenance is never invented. */
  private async applyAction(tx: T2CTxClient, repairId: string, plan: RepairPlan, action: RepairAction): Promise<void> {
    const table = TABLE_OF[action.op];
    const before = await this.captureBefore(tx, table, action.id);
    if (!before) {
      throw new RepairAbortedError(`${action.op}: no ${table} row with id ${JSON.stringify(action.id)} (nothing to repair)`);
    }
    const projectId = String(before['projectId']);

    switch (action.op) {
      case 'f5-set-committed-qty': {
        const personShiftQty = Number(before['personShiftQty']);
        if (!Number.isInteger(action.committedQty) || action.committedQty < 0 || action.committedQty > personShiftQty) {
          throw new RepairAbortedError(
            `f5-set-committed-qty: committedQty ${action.committedQty} must be an integer in [0, ${personShiftQty}] (the ordered personShiftQty)`,
          );
        }
        await this.recordEvidence(tx, repairId, plan, action, table, before, { committedQty: action.committedQty });
        await tx.$executeRawUnsafe(
          `UPDATE "LabourPurchaseOrderLine" SET "committedQty" = $1 WHERE "id" = $2`,
          action.committedQty,
          action.id,
        );
        return;
      }
      case 'f2-restore-reqline-identity': {
        const requirementId = String(before['requirementId']);
        const revision = Number(before['revision']);
        const spec = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM "LabourRequirementSpec" WHERE "projectId" = $1 AND "requirementId" = $2 AND "revision" = $3 AND "labourSpecFingerprint" = $4 AND "shift" = $5`,
          projectId, requirementId, revision, action.labourSpecFingerprint, action.shift,
        );
        if (Number(spec[0]?.n ?? 0) === 0) {
          throw new RepairAbortedError(
            `f2-restore-reqline-identity: (${action.labourSpecFingerprint}, ${action.shift}) is not the pinned spec for requirement ${requirementId} rev ${revision} — supply the real frozen identity`,
          );
        }
        const slice = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM "LabourDemandSlice" WHERE "projectId" = $1 AND "requirementId" = $2 AND "revision" = $3 AND "civilDate" = $4::date`,
          projectId, requirementId, revision, action.civilDate,
        );
        if (Number(slice[0]?.n ?? 0) === 0) {
          throw new RepairAbortedError(
            `f2-restore-reqline-identity: ${action.civilDate} names no demand slice for requirement ${requirementId} rev ${revision} — supply a real slice date`,
          );
        }
        await this.recordEvidence(tx, repairId, plan, action, table, before, {
          labourSpecFingerprint: action.labourSpecFingerprint, shift: action.shift, civilDate: action.civilDate,
        });
        await tx.$executeRawUnsafe(
          `UPDATE "LabourRequisitionLine" SET "labourSpecFingerprint" = $1, "shift" = $2, "civilDate" = $3::date WHERE "id" = $4`,
          action.labourSpecFingerprint, action.shift, action.civilDate, action.id,
        );
        return;
      }
      case 'f2c-align-poline-slice': {
        // copy the slice identity from the PO line's OWN requisition line (canonical).
        const requisitionLineId = String(before['requisitionLineId']);
        const rl = await tx.$queryRawUnsafe<Array<{ civilDate: Date; shift: string; labourSpecFingerprint: string }>>(
          `SELECT "civilDate", "shift", "labourSpecFingerprint" FROM "LabourRequisitionLine" WHERE "projectId" = $1 AND "id" = $2`,
          projectId, requisitionLineId,
        );
        if (!rl[0]) throw new RepairAbortedError(`f2c-align-poline-slice: PO line ${action.id} references missing requisition line ${requisitionLineId}`);
        await this.recordEvidence(tx, repairId, plan, action, table, before, { alignedTo: 'requisitionLine', requisitionLineId });
        await tx.$executeRawUnsafe(
          `UPDATE "LabourPurchaseOrderLine" pol SET "civilDate" = rl."civilDate", "shift" = rl."shift", "labourSpecFingerprint" = rl."labourSpecFingerprint"
           FROM "LabourRequisitionLine" rl WHERE rl."projectId" = pol."projectId" AND rl."id" = pol."requisitionLineId" AND pol."id" = $1`,
          action.id,
        );
        return;
      }
      case 'f3-align-commitment': {
        // copy the slice identity from the commitment's OWN PO line (canonical).
        const poLineId = String(before['poLineId']);
        const pl = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM "LabourPurchaseOrderLine" WHERE "projectId" = $1 AND "id" = $2`,
          projectId, poLineId,
        );
        if (Number(pl[0]?.n ?? 0) === 0) throw new RepairAbortedError(`f3-align-commitment: commitment ${action.id} references missing PO line ${poLineId}`);
        await this.recordEvidence(tx, repairId, plan, action, table, before, { alignedTo: 'poLine', poLineId });
        await tx.$executeRawUnsafe(
          `UPDATE "CapacityCommitment" c SET "labourSpecFingerprint" = l."labourSpecFingerprint", "civilDate" = l."civilDate", "shift" = l."shift", "personShiftQty" = l."personShiftQty"
           FROM "LabourPurchaseOrderLine" l WHERE l."projectId" = c."projectId" AND l."id" = c."poLineId" AND c."id" = $1`,
          action.id,
        );
        return;
      }
      case 'f4-align-poline-terms': {
        const requisitionLineId = String(before['requisitionLineId']);
        const poVersionId = String(before['poVersionId']);
        const personShiftQty = Number(before['personShiftQty']);
        // the operator-supplied terms MUST match a quote line of this PO's approved comparison (never
        // fabricate). Validate resolvability exactly as the migration's backfill does.
        const match = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n
           FROM "LabourPurchaseOrderVersion" v
           JOIN "LabourPurchaseOrder" po ON po."projectId" = v."projectId" AND po."id" = v."poId"
           JOIN "LabourQuoteComparison" cmp ON cmp."projectId" = po."projectId" AND cmp."id" = po."comparisonId"
           JOIN "SupplierLabourQuoteLine" ql ON ql."projectId" = cmp."projectId" AND ql."quoteId" = cmp."selectedQuoteId"
           WHERE v."projectId" = $1 AND v."id" = $2 AND ql."requisitionLineId" = $3
             AND ql."ratePerPersonShift" = $4::numeric AND ql."shiftPremium" = $5::numeric`,
          projectId, poVersionId, requisitionLineId, action.ratePerPersonShift, action.shiftPremium,
        );
        if (Number(match[0]?.n ?? 0) === 0) {
          throw new RepairAbortedError(
            `f4-align-poline-terms: (rate ${action.ratePerPersonShift}, premium ${action.shiftPremium}) match no selected-quote line of PO line ${action.id}'s approved comparison — supply the real quoted terms`,
          );
        }
        await this.recordEvidence(tx, repairId, plan, action, table, before, {
          ratePerPersonShift: action.ratePerPersonShift, shiftPremium: action.shiftPremium,
        });
        // committedAmountBase is a derived accounting field (CHECK: = round((rate+premium)*qty, 2)).
        await tx.$executeRawUnsafe(
          `UPDATE "LabourPurchaseOrderLine"
           SET "ratePerPersonShift" = $1::numeric, "shiftPremium" = $2::numeric,
               "committedAmountBase" = round(($1::numeric + $2::numeric) * $3, 2)
           WHERE "id" = $4`,
          action.ratePerPersonShift, action.shiftPremium, personShiftQty, action.id,
        );
        return;
      }
      default: {
        const exhaustive: never = action;
        throw new RepairAbortedError(`unknown repair op ${JSON.stringify((exhaustive as RepairAction).op)}`);
      }
    }
  }

  private async captureBefore(tx: T2CTxClient, table: string, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT row_to_json(t) AS row FROM "${table}" t WHERE t."id" = $1`,
      id,
    );
    return rows[0]?.row ?? null;
  }

  private async recordEvidence(
    tx: T2CTxClient,
    repairId: string,
    plan: RepairPlan,
    action: RepairAction,
    table: string,
    before: Record<string, unknown>,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "T2CRepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage","detail")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      repairId,
      plan.operator,
      plan.reason,
      action.finding,
      action.op,
      table,
      action.id,
      JSON.stringify(before),
      detail ? JSON.stringify(detail) : null,
    );
  }

  /** Assert every labour-commercial immutability trigger is enabled (`tgenabled='O'`); throw
   *  (roll back) otherwise — a repair that leaves any seal off is not a valid repair. */
  private async assertTriggersEnabled(tx: T2CTxClient): Promise<string[]> {
    const rows = await tx.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string }>>(
      `SELECT t.tgname, t.tgenabled FROM pg_trigger t WHERE t.tgname = ANY($1::text[])`,
      IMMUTABILITY_TRIGGERS as unknown as string[],
    );
    const byName = new Map(rows.map((r) => [r.tgname, r.tgenabled]));
    const notEnabled: string[] = [];
    for (const name of IMMUTABILITY_TRIGGERS) {
      const state = byName.get(name);
      if (state !== 'O') notEnabled.push(`${name}=${state ?? 'MISSING'}`);
    }
    if (notEnabled.length > 0) {
      throw new RepairAbortedError(`trigger verification failed — not re-enabled: ${notEnabled.join(', ')}`);
    }
    return [...IMMUTABILITY_TRIGGERS];
  }
}
