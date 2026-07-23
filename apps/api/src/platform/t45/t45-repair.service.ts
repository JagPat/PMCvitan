import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';
import {
  runT45Diagnostics,
  summarizeT45,
  type T45DiagnosticsReport,
  type T45TxClient,
} from './t45-diagnostics';

/**
 * Phase 3 Tasks 4–5 integrity correction — the CONTROLLED operator repair engine.
 *
 * The §C/§E records that violate migration `20261231000000`'s diagnostics live in append-only
 * tables (`StockLot`, `StockTransaction`, `MaterialIssue`, `MismatchResolution`), so an operator
 * CANNOT repair them with an ordinary UPDATE/DELETE (`phase3_immutable_row` forbids it) and CANNOT
 * fix an F2/F3 shape by reversing it (the corrupt row stays and the diagnostic counts it again).
 * This engine is the ONE sanctioned repair path. Every repair:
 *
 *   1. Runs against explicit, operator-authored decisions (`RepairPlan`) — it NEVER guesses
 *      provenance; a `set-source-command` names the exact reconciliation command, and a
 *      duplicate-issue repair (F3.1) names exactly which transaction to delete (the operator
 *      chooses the canonical row — the engine never auto-selects it).
 *   2. Opens ONE bounded maintenance transaction and, inside it: records a complete before-image +
 *      operator/reason/timestamp/row-id for every action in the durable `T45RepairAction` evidence
 *      table (created idempotently, because a later Prisma migration cannot run until 20261231 is
 *      resolved), disables ONLY the four §C/§E append-only triggers by name, applies the decisions,
 *      then RE-ENABLES and VERIFIES every immutability trigger and RE-RUNS every T45 diagnostic.
 *   3. Commits ONLY if every diagnostic reads zero AND every trigger is back in `enabled` state;
 *      otherwise the whole transaction rolls back — data changes, evidence rows, trigger-disable
 *      and all — leaving the database byte-for-byte as it was, triggers firing.
 *
 * After a successful repair the operator resolves the migration record and redeploys (see
 * `docs/RUNBOOK.md §T45`): `prisma migrate resolve --rolled-back 20261231… && prisma migrate deploy`.
 */

/** The four §C/§E append-only triggers the repair disables (and MUST restore) — nothing else. */
const APPEND_ONLY_TRIGGERS: ReadonlyArray<{ table: string; trigger: string }> = [
  { table: 'StockLot', trigger: 'StockLot_append_only' },
  { table: 'StockTransaction', trigger: 'StockTransaction_append_only' },
  { table: 'MaterialIssue', trigger: 'MaterialIssue_append_only' },
  { table: 'MismatchResolution', trigger: 'MismatchResolution_append_only' },
];

/** Immutability triggers whose ENABLED state the repair verifies before commit. The reversal-inverse
 *  trigger is never disabled (it is BEFORE INSERT; the repair only UPDATE/DELETEs) but is verified so
 *  the check is a complete statement of the §C/§E seal being intact. */
const IMMUTABILITY_TRIGGERS: ReadonlyArray<string> = [
  ...APPEND_ONLY_TRIGGERS.map((t) => t.trigger),
  'StockTransaction_reversal_inverse',
];

export type RepairAction =
  /** F1 — repoint a stock row's source command to an explicit, SAME-PROJECT CommandExecution. */
  | { finding: string; op: 'set-source-command'; id: string; commandId: string }
  /** F1/F2.3/F3.1/F3.3 — delete an explicit stock transaction (a mis-scoped, orphan-provenance,
   *  or duplicate-canonical row the operator has decided is not the keeper). */
  | { finding: string; op: 'delete-stock-transaction'; id: string }
  /** F2.1/F2.2 — delete a structurally corrupt stock lot (its receipt rows must be deleted first). */
  | { finding: string; op: 'delete-stock-lot'; id: string }
  /** F3.2 — delete an orphan MaterialIssue (no canonical issue movement). */
  | { finding: string; op: 'delete-material-issue'; id: string }
  /** F4 — remove an erroneous resolution attached to a matched observation. */
  | { finding: string; op: 'delete-mismatch-resolution'; id: string }
  /** F4 — restore an observation's historical truth (it was re-matched after resolution). */
  | { finding: string; op: 'set-site-material-unmatched'; id: string };

export interface RepairPlan {
  operator: string;
  reason: string;
  actions: RepairAction[];
}

export interface RepairOutcome {
  repairId: string;
  applied: number;
  /** The clean diagnostics report captured inside the transaction, immediately before commit. */
  verified: T45DiagnosticsReport;
  triggersRestored: string[];
}

/** Thrown when the repair rolls back — carries the diagnostics that were still dirty (if any). */
export class RepairAbortedError extends Error {
  constructor(message: string, readonly report?: T45DiagnosticsReport) {
    super(message);
    this.name = 'RepairAbortedError';
  }
}

const TABLE_OF: Record<RepairAction['op'], string> = {
  'set-source-command': 'StockTransaction',
  'delete-stock-transaction': 'StockTransaction',
  'delete-stock-lot': 'StockLot',
  'delete-material-issue': 'MaterialIssue',
  'delete-mismatch-resolution': 'MismatchResolution',
  'set-site-material-unmatched': 'SiteMaterial',
};

export class T45RepairService {
  constructor(private readonly prisma: PrismaService) {}

  /** Read-only diagnostics over the top-level client (the `t45:preflight` body). */
  async preflight(): Promise<T45DiagnosticsReport> {
    return runT45Diagnostics(this.prisma);
  }

  /** Inspect the `_prisma_migrations` record for the correction migration (three-state classify). */
  async migrationState(): Promise<{ state: 'applied' | 'failed-pending' | 'not-applied'; row: Record<string, unknown> | null }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>(
      `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = '20261231000000_phase3_t45_integrity_correction' ORDER BY started_at DESC LIMIT 1`,
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
    const repairId = randomUUID();

    return this.prisma.$transaction(
      async (tx: T45TxClient) => {
        // 0. Durable evidence table (idempotent — a later Prisma migration cannot create it while
        //    20261231 is unresolved). On rollback this CREATE is undone too, exactly as intended.
        await tx.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "T45RepairAction" (
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

        // 1. Disable ONLY the four append-only triggers, by name, inside this transaction.
        for (const { table, trigger } of APPEND_ONLY_TRIGGERS) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        }

        // 2. Apply each decision, capturing a complete before-image into the evidence table first.
        let applied = 0;
        for (const action of plan.actions) {
          await this.applyAction(tx, repairId, plan, action);
          applied++;
        }

        // 3. Re-enable every append-only trigger, then VERIFY the full immutability set is enabled.
        for (const { table, trigger } of APPEND_ONLY_TRIGGERS) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
        }
        const triggersRestored = await this.assertTriggersEnabled(tx);

        // 4. Re-run EVERY T45 diagnostic inside the transaction — a repair is valid only if it left
        //    the database clean. A still-dirty finding aborts (rolls back) with its report.
        const verified = await runT45Diagnostics(tx);
        if (!verified.clean) {
          throw new RepairAbortedError(
            `repair did not clear every finding — rolling back:\n${summarizeT45(verified)}`,
            verified,
          );
        }

        return { repairId, applied, verified, triggersRestored };
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  }

  /** Record the before-image, then apply exactly one decision. Validates the target exists (and, for
   *  a source repoint, that the new command is in the same project) so provenance is never invented. */
  private async applyAction(tx: T45TxClient, repairId: string, plan: RepairPlan, action: RepairAction): Promise<void> {
    const table = TABLE_OF[action.op];
    const before = await this.captureBefore(tx, table, action.id);
    if (!before) {
      throw new RepairAbortedError(`${action.op}: no ${table} row with id ${JSON.stringify(action.id)} (nothing to repair)`);
    }

    let detail: Record<string, unknown> | null = null;
    switch (action.op) {
      case 'set-source-command': {
        const projectId = String(before['projectId']);
        const ok = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM "CommandExecution" WHERE "id" = $1 AND "projectId" = $2`,
          action.commandId,
          projectId,
        );
        if (Number(ok[0]?.n ?? 0) === 0) {
          throw new RepairAbortedError(
            `set-source-command: CommandExecution ${JSON.stringify(action.commandId)} does not exist in project ${JSON.stringify(projectId)} — provide a real same-project command`,
          );
        }
        detail = { commandId: action.commandId };
        await this.recordEvidence(tx, repairId, plan, action, table, before, detail);
        await tx.$executeRawUnsafe(
          `UPDATE "StockTransaction" SET "sourceCommandId" = $1 WHERE "id" = $2`,
          action.commandId,
          action.id,
        );
        return;
      }
      case 'set-site-material-unmatched': {
        await this.recordEvidence(tx, repairId, plan, action, table, before, detail);
        await tx.$executeRawUnsafe(`UPDATE "SiteMaterial" SET "matched" = FALSE WHERE "id" = $1`, action.id);
        return;
      }
      case 'delete-stock-transaction':
      case 'delete-stock-lot':
      case 'delete-material-issue':
      case 'delete-mismatch-resolution': {
        await this.recordEvidence(tx, repairId, plan, action, table, before, detail);
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, action.id);
        return;
      }
      default: {
        const exhaustive: never = action;
        throw new RepairAbortedError(`unknown repair op ${JSON.stringify((exhaustive as RepairAction).op)}`);
      }
    }
  }

  private async captureBefore(tx: T45TxClient, table: string, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT row_to_json(t) AS row FROM "${table}" t WHERE t."id" = $1`,
      id,
    );
    return rows[0]?.row ?? null;
  }

  private async recordEvidence(
    tx: T45TxClient,
    repairId: string,
    plan: RepairPlan,
    action: RepairAction,
    table: string,
    before: Record<string, unknown>,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "T45RepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage","detail")
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

  /** Assert every immutability trigger is enabled (`tgenabled='O'`); throw (roll back) otherwise. */
  private async assertTriggersEnabled(tx: T45TxClient): Promise<string[]> {
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
