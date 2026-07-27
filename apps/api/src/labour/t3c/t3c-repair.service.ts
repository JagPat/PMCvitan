import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';
import {
  runT3CDiagnostics,
  summarizeT3C,
  T3C_INVALID_LEGACY_PREFIX,
  T3C_MARKER_COLUMN,
  T3C_REFERENCED_TABLES,
  type T3CDiagnosticsReport,
  type T3CTxClient,
} from './t3c-diagnostics';

/**
 * Phase 4 Task 3 correction (round 3) — the CONTROLLED operator repair engine for §C attendance.
 *
 * WHAT IT REPLACES. `docs/RUNBOOK.md §P4T3C2` previously told the operator to disable
 * `LabourAttendance_append_only` and DELETE every blank-`manualReason` muster. That destroys the
 * original observation, its recorder, its timestamps, its revocation and the whole correction chain
 * — while the disabled trigger's own message says attendance rows are never deleted. An
 * observation that turned out to be badly recorded is still an observation; the site record of who
 * claimed a worker was present, and when, is exactly what a labour audit needs.
 *
 * WHAT IT DOES INSTEAD. Nothing is deleted and nothing is invented:
 *
 *   1. The ORIGINAL ROW STAYS. Its id, project, worker, civil date, shift, device, evidence media,
 *      recorder, recorded-at and source command are all untouched.
 *   2. `manualReason` is rewritten to the RESERVED marker {@link T3C_INVALID_LEGACY_PREFIX} plus the
 *      repair id and operator. The marker is a statement about the RECORD ("the original reason was
 *      blank and the real justification was never recorded"), never a guess at why the worker was
 *      there. It exists only to satisfy the already-deployed
 *      `LabourAttendance_manual_reason_non_blank` CHECK truthfully. Migration `20270225000000`
 *      makes the prefix unwritable by an ordinary INSERT, so it can never masquerade as a real
 *      pmc-authored exception.
 *   3. The row is REVOKED in the same statement, with an accountable `revokedById` the operator
 *      names (the `LabourAttendance_revoke_attribution_check` CHECK requires the full triple). A
 *      revoked muster contributes no active presence and frees the live partial unique, so a
 *      genuine replacement muster is a SEPARATE attributable row — never an edit of this one.
 *   4. The COMPLETE before-image (the whole row as JSON, including the original blank bytes) is
 *      written to the durable `T3CRepairAction` evidence table with the operator, reason, timestamp
 *      and row id, BEFORE the update is applied.
 *
 * PROTOCOL. Exactly the cleared T45/T2C shape: ONE bounded maintenance transaction which creates the
 * evidence table idempotently, disables ONLY the named triggers the plan's ops require, applies the
 * operator's explicit plan, re-enables and VERIFIES the full §C immutability trigger set, re-runs
 * every diagnostic, and commits only if everything reads clean — otherwise the whole transaction
 * rolls back (data, evidence rows and trigger toggles alike), leaving the database byte-for-byte as
 * it was with every seal firing.
 *
 * After a successful repair the operator resolves the migration record and redeploys (see
 * `docs/RUNBOOK.md §P4T3C2`):
 * `prisma migrate resolve --rolled-back 20270220… && prisma migrate deploy`.
 */

/** The §C triggers a repair MAY disable, by table — nothing else is ever touched. */
const DISABLEABLE_TRIGGERS: Readonly<Record<string, string>> = {
  LabourAttendance_append_only: 'LabourAttendance',
};

/**
 * Every §C immutability trigger whose ENABLED state the repair verifies before commit. All four are
 * installed by `20270210000000`, which is deployed before any repair can be needed. Triggers added
 * by `20270225000000` are deliberately absent: that migration has not applied at repair time.
 */
const IMMUTABILITY_TRIGGERS: ReadonlyArray<string> = [
  'LabourAttendance_append_only',
  'WorkerAllocation_frozen',
  'LabourWorkFact_append_only',
  'ApprovedSkillSubstitution_append_only',
];

export type RepairAction =
  /**
   * F1.blank — mark ONE blank-`manualReason` muster as an invalid legacy record and revoke it.
   * `revokedById` is the accountable human the operator names; it must resolve to a real `User`
   * (never fabricated) because `LabourAttendance_revoke_attribution_check` demands the full
   * revocation triple. `revokeReason` is the operator's own words about the REPAIR.
   */
  {
    finding: string;
    op: 'f1-mark-invalid-legacy';
    id: string;
    revokedById: string;
    revokeReason: string;
  };

export interface RepairPlan {
  operator: string;
  reason: string;
  actions: RepairAction[];
}

export interface RepairOutcome {
  repairId: string;
  applied: number;
  /** The clean diagnostics report captured inside the transaction, immediately before commit. */
  verified: T3CDiagnosticsReport;
  triggersDisabled: string[];
  triggersRestored: string[];
}

/** Thrown when the repair rolls back — carries the diagnostics that were still dirty (if any). */
export class RepairAbortedError extends Error {
  constructor(message: string, readonly report?: T3CDiagnosticsReport) {
    super(message);
    this.name = 'RepairAbortedError';
  }
}

const TABLE_OF: Record<RepairAction['op'], string> = {
  'f1-mark-invalid-legacy': 'LabourAttendance',
};

/** The named trigger each op requires disabled — empty means the op needs NO trigger disabled. */
const TRIGGERS_FOR_OP: Record<RepairAction['op'], string[]> = {
  // `manualReason` is frozen by the append-only trigger (20270220 added it to the frozen set), and
  // that same trigger is what permits the revocation stamp. Both changes land in ONE update, so the
  // trigger is disabled for the duration of the maintenance transaction and verified back on.
  'f1-mark-invalid-legacy': ['LabourAttendance_append_only'],
};

export class T3CRepairService {
  constructor(private readonly prisma: PrismaService) {}

  /** Read-only diagnostics over the top-level client (the `t3c:preflight` body). */
  async preflight(): Promise<T3CDiagnosticsReport> {
    return runT3CDiagnostics(this.prisma);
  }

  /**
   * Is the §C attendance schema the diagnostics read even present? A fresh/empty or pre-Task-3
   * database is NOT eligible — the preflight reports "not applicable" and lets normal migrations run.
   * All checks are over `information_schema`, so this is safe on a database with no tables at all.
   */
  async schemaEligible(): Promise<{ applicable: boolean; reason: string; missing: string[] }> {
    const present = await this.prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      T3C_REFERENCED_TABLES as unknown as string[],
    );
    const have = new Set(present.map((r) => r.table_name));
    const missing = T3C_REFERENCED_TABLES.filter((t) => !have.has(t));
    const col = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      T3C_MARKER_COLUMN.table,
      T3C_MARKER_COLUMN.column,
    );
    if (Number(col[0]?.n ?? 0) === 0) missing.push(`${T3C_MARKER_COLUMN.table}.${T3C_MARKER_COLUMN.column}`);
    if (missing.length > 0) {
      return {
        applicable: false,
        reason: `§C attendance schema not present (missing: ${missing.join(', ')}) — T3C diagnostics not applicable`,
        missing,
      };
    }
    return { applicable: true, reason: '§C attendance schema present', missing: [] };
  }

  /** Inspect the `_prisma_migrations` records for the two attendance migrations (three-state
   *  classify each). Robust to a pre-baseline database where `_prisma_migrations` does not exist. */
  async migrationState(): Promise<Record<string, { state: 'applied' | 'failed-pending' | 'not-applied'; row: Record<string, unknown> | null }>> {
    const names = ['20270220000000_phase4_t3_correction2', '20270225000000_phase4_t3_correction3'];
    const ledger = await this.prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`,
    );
    const out: Record<string, { state: 'applied' | 'failed-pending' | 'not-applied'; row: Record<string, unknown> | null }> = {};
    for (const name of names) {
      if (!ledger[0]?.present) {
        out[name] = { state: 'not-applied', row: null };
        continue;
      }
      const rows = await this.prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>(
        `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = $1 ORDER BY started_at DESC LIMIT 1`,
        name,
      );
      const row = rows[0] ?? null;
      if (!row) out[name] = { state: 'not-applied', row: null };
      else if (row.finished_at) out[name] = { state: 'applied', row: { ...row } };
      else if (!row.rolled_back_at) out[name] = { state: 'failed-pending', row: { ...row } };
      else out[name] = { state: 'not-applied', row: { ...row } };
    }
    return out;
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
      async (tx: T3CTxClient) => {
        // 0. Durable evidence table (idempotent — a later Prisma migration cannot create it while
        //    20270220 is unresolved). On rollback this CREATE is undone too, exactly as intended.
        await tx.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "T3CRepairAction" (
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
        const verified = await runT3CDiagnostics(tx);
        if (!verified.clean) {
          throw new RepairAbortedError(
            `repair did not clear every finding — rolling back:\n${summarizeT3C(verified)}`,
            verified,
          );
        }

        return { repairId, applied, verified, triggersDisabled: disableList, triggersRestored };
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  }

  /** Record the before-image, then apply exactly one decision. Validates the target really is the
   *  invalid state being repaired and that the named accountable user exists, so the repair can
   *  neither run over a healthy row nor invent an attribution. */
  private async applyAction(tx: T3CTxClient, repairId: string, plan: RepairPlan, action: RepairAction): Promise<void> {
    const table = TABLE_OF[action.op];
    const before = await this.captureBefore(tx, table, action.id);
    if (!before) {
      throw new RepairAbortedError(`${action.op}: no ${table} row with id ${JSON.stringify(action.id)} (nothing to repair)`);
    }

    switch (action.op) {
      case 'f1-mark-invalid-legacy': {
        // Only the diagnosed state may be repaired: a row with a REAL reason is never overwritten.
        const raw = before['manualReason'];
        if (typeof raw !== 'string' || raw.replace(/[ \t\n\v\f\r]/g, '') !== '') {
          throw new RepairAbortedError(
            `f1-mark-invalid-legacy: LabourAttendance ${action.id} does not carry a blank manualReason (it is ${JSON.stringify(raw)}) — a recorded justification is never overwritten`,
          );
        }
        if (before['revokedAt'] != null) {
          throw new RepairAbortedError(
            `f1-mark-invalid-legacy: LabourAttendance ${action.id} is already revoked — a revoked muster is terminal`,
          );
        }
        if (!action.revokeReason?.trim()) {
          throw new RepairAbortedError('f1-mark-invalid-legacy: revokeReason is required — say why this record is being retired');
        }
        // NEVER fabricate the accountable human: the revocation triple is CHECK-enforced and the
        // FK would fail opaquely, so resolve it here with a named error instead.
        const user = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM "User" WHERE "id" = $1`,
          action.revokedById,
        );
        if (Number(user[0]?.n ?? 0) === 0) {
          throw new RepairAbortedError(
            `f1-mark-invalid-legacy: revokedById ${JSON.stringify(action.revokedById)} names no User — a revocation must be attributable to a real person`,
          );
        }
        // The marker is a truthful statement about the RECORD. It never claims to know why the
        // worker was present; the original bytes are already in the evidence row written below.
        const marker =
          `${T3C_INVALID_LEGACY_PREFIX} the original manualReason was blank; the real justification was ` +
          `never recorded and is not knowable from the data. Retired by operator ${plan.operator} under repair ${repairId}. ` +
          `Original row preserved in T3CRepairAction.`;
        await this.recordEvidence(tx, repairId, plan, action, table, before, {
          markerPrefix: T3C_INVALID_LEGACY_PREFIX,
          originalManualReason: raw,
          revokedById: action.revokedById,
          revokeReason: action.revokeReason,
        });
        // ONE statement: the row is marked AND revoked together, so it can never be observed marked
        // but live. The revocation triple satisfies `LabourAttendance_revoke_attribution_check`.
        await tx.$executeRawUnsafe(
          `UPDATE "LabourAttendance"
              SET "manualReason" = $1, "revokedAt" = now(), "revokedById" = $2, "revokeReason" = $3
            WHERE "id" = $4`,
          marker,
          action.revokedById,
          action.revokeReason,
          action.id,
        );
        return;
      }
      default: {
        const exhaustive: never = action.op;
        throw new RepairAbortedError(`unknown repair op ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async captureBefore(tx: T3CTxClient, table: string, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT row_to_json(t) AS row FROM "${table}" t WHERE t."id" = $1`,
      id,
    );
    return rows[0]?.row ?? null;
  }

  private async recordEvidence(
    tx: T3CTxClient,
    repairId: string,
    plan: RepairPlan,
    action: RepairAction,
    table: string,
    before: Record<string, unknown>,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "T3CRepairAction" ("repairId","operator","reason","finding","op","table","rowId","beforeImage","detail")
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

  /** Assert every §C immutability trigger is enabled (`tgenabled='O'`); throw (roll back) otherwise
   *  — a repair that leaves any seal off is not a valid repair. */
  private async assertTriggersEnabled(tx: T3CTxClient): Promise<string[]> {
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
