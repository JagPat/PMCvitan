import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';
import {
  runT3CDiagnostics,
  summarizeT3C,
  t3cGenuineEvidenceSql,
  t3cInvalidLegacyMarker,
  t3cQuarantinedMarker,
  T3C_BLANK_TRIM_SET,
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
 * Every §C immutability trigger whose ENABLED state the repair verifies before commit. The first
 * four are installed by `20270210000000`, which is deployed before any repair can be needed.
 * Triggers added by `20270225000000` are deliberately absent: that migration has not applied at
 * repair time.
 *
 * `T3CRepairAction_append_only` is the exception that is created HERE (see {@link EVIDENCE_SEAL_SQL})
 * because the evidence table itself is created here. Without it the audit rows are an ordinary
 * mutable table: a later direct write could rewrite or erase the operator, reason, timestamp or the
 * complete before-image — the only surviving copy of the original blank bytes — while every marked
 * attendance row goes on claiming "Original row preserved in T3CRepairAction". The marker's promise
 * has to be enforced, not merely printed.
 */
const IMMUTABILITY_TRIGGERS: ReadonlyArray<string> = [
  'LabourAttendance_append_only',
  'WorkerAllocation_frozen',
  'LabourWorkFact_append_only',
  'ApprovedSkillSubstitution_append_only',
  'T3CRepairAction_append_only',
  'T3CRepairAction_no_truncate',
];

/**
 * The function each verified trigger MUST be bound to, where this engine is the authority on it.
 *
 * Only the two evidence triggers appear: they are created here, so their correct binding is known
 * here. The four `20270210000000` triggers are deliberately absent — this file does not own their
 * definitions and asserting a guessed function name would be a claim it cannot back. For those,
 * name + enabled remains the check, which is what it has always been.
 */
const EXPECTED_TRIGGER_FUNCTION: Readonly<Record<string, string>> = {
  T3CRepairAction_append_only: 'phase4_t3c_repair_action_append_only',
  T3CRepairAction_no_truncate: 'phase4_t3c_repair_action_no_truncate',
};

/**
 * The evidence table's own seal. INSERT is the only permitted operation: an audit row is never
 * corrected, superseded or tidied away — a mistaken repair is answered by another repair, which
 * writes another row. Deliberately NOT in {@link DISABLEABLE_TRIGGERS}, so no repair plan can ever
 * name it: the repair engine is not permitted to unseal its own evidence.
 *
 * TWO triggers are required, because PostgreSQL row-level `BEFORE UPDATE OR DELETE` does not fire
 * for `TRUNCATE` — truncate triggers are a separate, STATEMENT-level event. Without the second one
 * the very role that creates this table could erase every before-image in one statement while the
 * attendance rows go on claiming their originals are preserved here. A seal with a hole that size
 * is decoration.
 *
 * Written idempotently (`CREATE OR REPLACE` + a create-if-absent guard) because the repair
 * transaction re-runs it on every invocation, and re-asserted by `20270225000000` so a database
 * whose repair predates these seals gains them at deploy time.
 */
const EVIDENCE_SEAL_SQL = [
  `CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_append_only() RETURNS trigger AS $fn$
     BEGIN
       RAISE EXCEPTION 'T3CRepairAction is append-only — repair evidence is never updated or deleted (attempted % on row %)', TG_OP, COALESCE(OLD."id"::text, '<none>');
     END;
   $fn$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_no_truncate() RETURNS trigger AS $fn$
     BEGIN
       RAISE EXCEPTION 'T3CRepairAction is append-only — repair evidence is never truncated';
     END;
   $fn$ LANGUAGE plpgsql`,
  // "Absent" is decided by VALIDITY, not by name — the same rule the migration applies. A legacy
  // table carrying an ENABLED same-named no-op trigger would otherwise make this guard skip
  // creation, and `assertTriggersEnabled` (which also checks the bound function) is the only thing
  // left standing between that and a repair committing while its freshly written before-image stays
  // freely updateable. A decoy is an ABORT, not something to replace silently: replacing it would
  // erase the evidence that someone put it there.
  `DO $do$
     DECLARE tg pg_trigger%ROWTYPE;
   BEGIN
     SELECT * INTO tg FROM pg_trigger WHERE tgname = 'T3CRepairAction_append_only'
       AND tgrelid = '"T3CRepairAction"'::regclass AND NOT tgisinternal;
     IF NOT FOUND THEN
       CREATE TRIGGER "T3CRepairAction_append_only" BEFORE UPDATE OR DELETE ON "T3CRepairAction"
         FOR EACH ROW EXECUTE FUNCTION phase4_t3c_repair_action_append_only();
     ELSIF tg.tgenabled <> 'O'
        OR tg.tgfoid::regproc::text <> 'phase4_t3c_repair_action_append_only'
        OR (tg.tgtype & 8) = 0     -- fires on UPDATE
        OR (tg.tgtype & 16) = 0 THEN -- …and on DELETE
       RAISE EXCEPTION 'T3CRepairAction_append_only exists but does not seal the evidence (enabled=%, function=%, tgtype=%) — refusing to write repair evidence a later write could rewrite. See docs/RUNBOOK.md §P4T3C3.',
         tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
     END IF;

     SELECT * INTO tg FROM pg_trigger WHERE tgname = 'T3CRepairAction_no_truncate'
       AND tgrelid = '"T3CRepairAction"'::regclass AND NOT tgisinternal;
     IF NOT FOUND THEN
       CREATE TRIGGER "T3CRepairAction_no_truncate" BEFORE TRUNCATE ON "T3CRepairAction"
         FOR EACH STATEMENT EXECUTE FUNCTION phase4_t3c_repair_action_no_truncate();
     ELSIF tg.tgenabled <> 'O'
        OR tg.tgfoid::regproc::text <> 'phase4_t3c_repair_action_no_truncate'
        OR (tg.tgtype & 32) = 0 THEN -- fires on TRUNCATE
       RAISE EXCEPTION 'T3CRepairAction_no_truncate exists but does not seal the evidence against TRUNCATE (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P4T3C3.',
         tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
     END IF;
   END $do$`,
  // The attribution must SAY something. `operator` and `reason` are NOT NULL, but NOT NULL is
  // satisfied by a space: a raw or maintenance insert could store whitespace-only attribution, and
  // because the rows above make the table append-only that emptiness is then permanent — a marked
  // attendance row pointing at evidence that names nobody and states no reason. The CLI's `.trim()`
  // is a courtesy to the operator, not an enforcement boundary; this is. It uses the repository's
  // complete ASCII-whitespace trim set, so a tab-only operator is exactly as blank as a space-only
  // one.
  //
  // NEVER a hard abort over pre-existing rows. An earlier draft raised here when a legacy blank-
  // attribution action was found, and that was a trap of exactly the kind this engine exists to
  // remove: the evidence table is append-only, so the malformed row cannot be edited away; the
  // quarantine appends good evidence but preserves the bad action, so the raise would fire forever;
  // and an ORPHAN malformed action (one no marker cites) blocked every repair and every deploy
  // without even producing an `F1.marker` to explain itself.
  //
  // So the constraint is added NOT VALID when such rows exist. That is the honest state and it is
  // the useful one: every FUTURE insert is rejected, the legacy rows stay exactly as they were
  // written (they are the record that they were written), and nothing is blocked. On a clean table
  // it is added VALIDATED, which is the stronger claim and the one `R4-C` pins. Either way the
  // marker predicate treats blank-attributed evidence as invalid, so a marker relying on one is an
  // `F1.marker` with the quarantine as its exit.
  `DO $do$
     DECLARE blank BIGINT;
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'T3CRepairAction_attribution_non_blank'
                   AND conrelid = '"T3CRepairAction"'::regclass) THEN RETURN; END IF;
     SELECT count(*) INTO blank FROM "T3CRepairAction"
      WHERE btrim("operator", ${T3C_BLANK_TRIM_SET}) = '' OR btrim("reason", ${T3C_BLANK_TRIM_SET}) = '';
     IF blank > 0 THEN
       RAISE WARNING 'T3CRepairAction holds % legacy row(s) whose operator or reason is blank; the non-blank rule is installed NOT VALID so new evidence is constrained and the existing rows are preserved. See docs/RUNBOOK.md §P4T3C3.', blank;
       ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "T3CRepairAction_attribution_non_blank"
         CHECK (btrim("operator", ${T3C_BLANK_TRIM_SET}) <> '' AND btrim("reason", ${T3C_BLANK_TRIM_SET}) <> '') NOT VALID;
     ELSE
       ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "T3CRepairAction_attribution_non_blank"
         CHECK (btrim("operator", ${T3C_BLANK_TRIM_SET}) <> '' AND btrim("reason", ${T3C_BLANK_TRIM_SET}) <> '');
     END IF;
   END $do$`,
];

export type RepairAction =
  /**
   * F1.blank — mark ONE blank-`manualReason` muster as an invalid legacy record and revoke it.
   * `revokedById` is the accountable human the operator names; it must resolve to a real `User`
   * (never fabricated) because `LabourAttendance_revoke_attribution_check` demands the full
   * revocation triple. `revokeReason` is the operator's own words about the REPAIR.
   *
   * `finding` is OPTIONAL and documentary: the recorded classification comes from {@link FINDING_OF_OP}.
   * When present it must match, so a mis-stated plan is refused rather than quietly reinterpreted.
   */
  | {
      finding?: string;
      op: 'f1-mark-invalid-legacy';
      id: string;
      revokedById: string;
      revokeReason: string;
    }
  /**
   * F1.marker — quarantine a muster that CARRIES the reserved marker without being a real audited
   * repair (the pre-`20270225` forgery: a direct writer typed the marker and filled in the
   * revocation triple, so it reads as operator provenance while no before-image has ever existed).
   *
   * That state had no exit. `docs/RUNBOOK.md §P4T3C3` told the operator to revoke the row, but it
   * is already revoked and a revoked muster is terminal; the only repair op accepted blank LIVE
   * rows, not marked ones; and the row cannot be deleted. So `F1.marker` could never be cleared and
   * correction 3 could never deploy — a dead end of the runbook's own making.
   *
   * The exit preserves everything and invents nothing. The forged row is recorded VERBATIM as its
   * own before-image (it is not blank, and is not pretended to be), the operator states what they
   * found, and `manualReason` is rewritten to a quarantine marker embedding THIS repair id — so the
   * row now points at evidence that genuinely exists, which is the whole thing the original marker
   * falsely claimed. The forgery is not erased; it is filed.
   */
  | {
      finding?: string;
      op: 'f1-quarantine-forged-marker';
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
  'f1-quarantine-forged-marker': 'LabourAttendance',
};

/**
 * The finding each op repairs. The op — not the plan's `finding` string — is what the evidence
 * records: the CLI parses an operator-authored JSON file, so a typo or a copy-paste from another
 * finding would otherwise write a false classification into `T3CRepairAction`, where it is now
 * permanent (the evidence is append-only). A plan that names a finding is still checked against
 * this, so a mismatch is a refusal rather than a silent correction — an operator who believes they
 * are repairing `F1.marker` should be told they are not.
 */
const FINDING_OF_OP: Record<RepairAction['op'], string> = {
  'f1-mark-invalid-legacy': 'F1.blank',
  'f1-quarantine-forged-marker': 'F1.marker',
};

/** PostgreSQL's foreign-key-violation SQLSTATE. */
const FK_VIOLATION_SQLSTATE = '23503';

/**
 * True when `error` is the named foreign key rejecting a write. Prisma reports a failed raw
 * statement as `P2010` and carries the driver's SQLSTATE and message in `meta`, so both the error
 * message and the meta payload are inspected rather than assuming one shape. The constraint name
 * alone is not treated as sufficient: the error must also read as a foreign-key failure, so an
 * unrelated error that merely mentions the constraint is re-thrown untouched.
 */
function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  const text = [
    (error as { message?: unknown }).message,
    meta?.['code'],
    meta?.['message'],
    meta?.['constraint'],
    meta?.['field_name'],
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  if (!text.includes(constraint)) return false;
  return text.includes(FK_VIOLATION_SQLSTATE) || /foreign key/i.test(text);
}

/** The named trigger each op requires disabled — empty means the op needs NO trigger disabled. */
const TRIGGERS_FOR_OP: Record<RepairAction['op'], string[]> = {
  // `manualReason` is frozen by the append-only trigger (20270220 added it to the frozen set), and
  // that same trigger is what permits the revocation stamp. Both changes land in ONE update, so the
  // trigger is disabled for the duration of the maintenance transaction and verified back on.
  'f1-mark-invalid-legacy': ['LabourAttendance_append_only'],
  // Same trigger, same reason: the quarantine rewrites `manualReason` on an already-revoked row.
  'f1-quarantine-forged-marker': ['LabourAttendance_append_only'],
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

  /**
   * Are `20270225000000`'s PHYSICAL objects actually installed?
   *
   * Every object that migration creates is raw SQL — two functions, two triggers and a CHECK
   * constraint. `prisma db push` reproduces only what `schema.prisma` models, so a database created
   * that way carries `LabourAttendance.manualReason` (and therefore looks eligible and row-clean)
   * while carrying NONE of these seals. `migrate deploy` answers such a database with P3005, and the
   * runner's baseline branch would otherwise mark every migration — this one included — as applied
   * without ever executing it: Prisma would then consider the correction installed forever while the
   * reserved-marker trigger and the allocation project lock simply do not exist.
   *
   * So the runner asks this question BEFORE resolving, and lets `migrate deploy` really run the
   * migration when the answer is "missing". Checked over the catalogs rather than by parsing SQL,
   * so it reflects the database as it actually is.
   */
  async correctionSeals(): Promise<{ installed: boolean; present: string[]; missing: string[] }> {
    // A seal is only installed if it is present, ENABLED, and wired to the function that actually
    // enforces it. A name alone proves nothing: `ALTER TABLE … DISABLE TRIGGER` leaves the row in
    // `pg_trigger` with `tgenabled='D'`, and a same-named trigger bound to some other function is a
    // decoy. Either would let the baseline resolve `20270225000000` as applied over a database with
    // no working backstop, permanently.
    const expected = [
      {
        name: 'LabourAttendance_reserved_marker',
        kind: 'trigger' as const,
        table: 'LabourAttendance',
        fn: 'phase4_t3c3_attendance_reserved_marker',
      },
      {
        name: 'WorkerAllocation_00_project_lock',
        kind: 'trigger' as const,
        table: 'WorkerAllocation',
        fn: 'phase4_t3c3_allocation_project_lock',
      },
      { name: 'LabourAttendance_marker_is_revoked', kind: 'constraint' as const, table: 'LabourAttendance' },
    ];
    const present: string[] = [];
    const missing: string[] = [];
    for (const item of expected) {
      const rows =
        item.kind === 'trigger'
          ? await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
              `SELECT count(*)::int AS n FROM pg_trigger t
                WHERE t.tgname = $1
                  AND NOT t.tgisinternal
                  AND t.tgrelid = to_regclass($2)
                  AND t.tgenabled = 'O'
                  AND t.tgfoid::regproc::text = $3`,
              item.name,
              `"${item.table}"`,
              item.fn,
            )
          : // `convalidated` matters as much as existence: a CHECK added NOT VALID does not constrain
            // the rows already in the table, so a database carrying it unvalidated is not sealed.
            //
            // And the DEFINITION matters as much as the name. A same-named `CHECK (TRUE)` is
            // validated, is a check constraint, and enforces nothing — accepting it would report a
            // database as fully sealed, and on the P3005 baseline path `migrate.sh` would then
            // resolve correction 3 as applied without ever executing its real guard, leaving live
            // reserved-marker rows permitted forever. The definition must mention both halves of the
            // rule it is supposed to be: the reserved prefix, and the revocation that must accompany
            // it. This is the same test the migration's own guard applies.
            await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
              `SELECT count(*)::int AS n FROM pg_constraint c
                WHERE c.conname = $1 AND c.conrelid = to_regclass($2)
                  AND c.contype = 'c' AND c.convalidated
                  AND pg_get_constraintdef(c.oid) LIKE $3
                  AND pg_get_constraintdef(c.oid) LIKE $4`,
              item.name,
              `"${item.table}"`,
              `%${T3C_INVALID_LEGACY_PREFIX}%`,
              '%revokedAt%',
            );
      if (Number(rows[0]?.n ?? 0) > 0) present.push(item.name);
      else missing.push(item.name);
    }
    return { installed: missing.length === 0, present, missing };
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
      // Checked BEFORE any trigger is disabled: the plan is operator-authored JSON, and a mis-stated
      // finding means the operator thinks they are fixing something else. Refuse, do not reinterpret.
      const expected = FINDING_OF_OP[action.op];
      if (action.finding !== undefined && action.finding !== expected) {
        throw new RepairAbortedError(
          `${action.op} repairs ${expected}, not ${JSON.stringify(action.finding)} — correct the plan rather than let the evidence record a classification that is not true`,
        );
      }
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
        // 0b. Seal it in the same breath. The evidence table exists to be the durable record of what
        //     the repair overwrote; an evidence table that can be quietly rewritten is not evidence.
        for (const statement of EVIDENCE_SEAL_SQL) await tx.$executeRawUnsafe(statement);

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
        // An ALREADY-REVOKED blank muster is repairable, and must be. `F1.blank` counts every blank
        // `manualReason` regardless of revocation — correctly, since `20270220`'s CHECK does too — so
        // a legacy row whose blank reason was revoked before correction 2 shipped is still a row the
        // constraint cannot be installed over. Refusing it as "terminal" left the only two ops unable
        // to clear the finding, and no path but an undocumented trigger bypass to unblock the deploy.
        //
        // What must NOT happen is restamping its revocation: that revocation is real history, made by
        // a named person at a known time for a stated reason. So the marker is written and the
        // EXISTING triple is preserved verbatim (the COALESCEs below); only a still-live row takes
        // the operator's attribution. `revokeReason` is required either way — on a pre-revoked row it
        // records what the OPERATOR did, in the evidence, without overwriting what the original
        // revoker said.
        const preRevoked = before['revokedAt'] != null;
        // On the preserved path `revokedById` is NOT written (the COALESCE below keeps the original),
        // so the FK never validates it. Recording the plan's value in append-only evidence would
        // therefore permanently store an id nothing ever checked, under a contract that says it is
        // validated — a nonexistent user would sail through because the row's own valid key covered
        // for it. The operator must instead NAME the revoker who is actually on the row, which is a
        // statement they can make truthfully after reading it, and which the evidence can then
        // record as true.
        if (preRevoked && action.revokedById !== before['revokedById']) {
          throw new RepairAbortedError(
            `f1-mark-invalid-legacy: LabourAttendance ${action.id} was already revoked by ${JSON.stringify(before['revokedById'])}; that attribution is preserved, so the plan must name the same revokedById rather than one that will be ignored`,
          );
        }
        if (!action.revokeReason?.trim()) {
          throw new RepairAbortedError('f1-mark-invalid-legacy: revokeReason is required — say why this record is being retired');
        }
        // The accountable human is validated by `LabourAttendance_revokedBy_fkey`, NOT by reading
        // `User` here: that table is Orgs-owned and Labour is a leaf, and this file being outside
        // the runtime boundary scan does not make the crossing legitimate. The FK is already the
        // authority; the update below is wrapped so its violation surfaces as the same named error
        // instead of an opaque constraint message. Nothing is fabricated either way — a
        // `revokedById` that names no user simply cannot be written.
        // The marker is a truthful statement about the RECORD. It never claims to know why the
        // worker was present; the original bytes are already in the evidence row written below, and
        // the embedded `repair=<id>` is what lets the diagnostic demand THAT row rather than settling
        // for "some repair once ran here".
        const marker = t3cInvalidLegacyMarker(repairId, plan.operator);
        await this.recordEvidence(tx, repairId, plan, action, table, before, {
          markerPrefix: T3C_INVALID_LEGACY_PREFIX,
          originalManualReason: raw,
          // Stated in the evidence so a reader can tell which of the two shapes this repair took,
          // without having to compare timestamps to work out whose revocation is recorded on the row.
          revocationPreserved: preRevoked,
          // What was actually WRITTEN to the row. On the preserved path that is the original
          // revocation, read back from the before-image — never the plan's copy of it, so the
          // evidence cannot claim an attribution the database does not hold.
          revokedById: preRevoked ? before['revokedById'] : action.revokedById,
          revokedAt: preRevoked ? before['revokedAt'] : null,
          revokeReason: preRevoked ? before['revokeReason'] : action.revokeReason,
          // The operator's own account of the RETIREMENT, which on the preserved path is a separate
          // act from the revocation and must not be mistaken for it.
          repairNote: action.revokeReason,
        });
        // ONE statement: the row is marked AND revoked together, so it can never be observed marked
        // but live. The revocation triple satisfies `LabourAttendance_revoke_attribution_check`.
        // COALESCE is what preserves an EXISTING revocation: for a live row every column is written
        // from the plan exactly as before; for a pre-revoked row the original who/when/why survive
        // untouched and only the marker is added.
        try {
          await tx.$executeRawUnsafe(
            `UPDATE "LabourAttendance"
                SET "manualReason" = $1,
                    "revokedAt"    = COALESCE("revokedAt", now()),
                    "revokedById"  = COALESCE("revokedById", $2),
                    "revokeReason" = COALESCE("revokeReason", $3)
              WHERE "id" = $4`,
            marker,
            action.revokedById,
            action.revokeReason,
            action.id,
          );
        } catch (error) {
          if (isForeignKeyViolation(error, 'LabourAttendance_revokedBy_fkey')) {
            throw new RepairAbortedError(
              `f1-mark-invalid-legacy: revokedById ${JSON.stringify(action.revokedById)} names no User — a revocation must be attributable to a real person`,
            );
          }
          throw error;
        }
        return;
      }
      case 'f1-quarantine-forged-marker': {
        // Only the diagnosed forgery may be quarantined. A row that IS a real audited repair is
        // never touched — re-quarantining one would replace a truthful marker with a false accusation.
        const raw = before['manualReason'];
        if (typeof raw !== 'string' || !raw.startsWith(T3C_INVALID_LEGACY_PREFIX)) {
          throw new RepairAbortedError(
            `f1-quarantine-forged-marker: LabourAttendance ${action.id} does not carry the reserved marker (it is ${JSON.stringify(raw)}) — this op exists only for the forged-marker state`,
          );
        }
        // The SAME predicate the diagnostic uses, not a metadata-only count. Counting `(rowId,
        // repairId)` alone treats an evidence row whose before-image is malformed — the exact thing
        // `markerPredicate` rejects — as genuine, so the preflight would report this row while the
        // repair refused to touch it. With the evidence append-only and the attendance row already
        // revoked, that combination has no exit at all: the finding could never clear and the deploy
        // would stay blocked. Asking the one question keeps report and repair in agreement by
        // construction.
        const genuine = await tx.$queryRawUnsafe<Array<{ genuine: boolean }>>(
          `SELECT ${t3cGenuineEvidenceSql('a')} AS genuine FROM "LabourAttendance" a WHERE a."id" = $1`,
          action.id,
        );
        if (genuine[0]?.genuine === true) {
          throw new RepairAbortedError(
            `f1-quarantine-forged-marker: LabourAttendance ${action.id} already has repair evidence for the id its marker embeds — it is a real audited repair, not a forgery`,
          );
        }
        if (!action.revokeReason?.trim()) {
          throw new RepairAbortedError('f1-quarantine-forged-marker: revokeReason is required — say what you found');
        }

        // The forged row is its own before-image. It is NOT blank and is not recorded as though it
        // were; what is preserved is exactly what the forger wrote, so the incident stays readable.
        const marker = t3cQuarantinedMarker(repairId, plan.operator);
        await this.recordEvidence(tx, repairId, plan, action, table, before, {
          markerPrefix: T3C_INVALID_LEGACY_PREFIX,
          forgedManualReason: raw,
          revokedById: action.revokedById,
          revokeReason: action.revokeReason,
        });
        // The row may already carry a revocation the forger wrote. Either way it ends revoked and
        // attributed to the operator who quarantined it, and its marker now names evidence that
        // exists. `revokedAt` is only stamped if it was absent, so a genuine earlier timestamp is
        // never overwritten.
        try {
          await tx.$executeRawUnsafe(
            `UPDATE "LabourAttendance"
                SET "manualReason" = $1,
                    "revokedAt"    = COALESCE("revokedAt", now()),
                    "revokedById"  = $2,
                    "revokeReason" = $3
              WHERE "id" = $4`,
            marker,
            action.revokedById,
            action.revokeReason,
            action.id,
          );
        } catch (error) {
          if (isForeignKeyViolation(error, 'LabourAttendance_revokedBy_fkey')) {
            throw new RepairAbortedError(
              `f1-quarantine-forged-marker: revokedById ${JSON.stringify(action.revokedById)} names no User — a quarantine must be attributable to a real person`,
            );
          }
          throw error;
        }
        return;
      }
      default: {
        const exhaustive: never = action;
        throw new RepairAbortedError(`unknown repair op ${JSON.stringify((exhaustive as RepairAction).op)}`);
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
      // The OP decides the finding, never the plan text — see FINDING_OF_OP.
      FINDING_OF_OP[action.op],
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
    const rows = await tx.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string; fn: string }>>(
      `SELECT t.tgname, t.tgenabled, t.tgfoid::regproc::text AS fn
         FROM pg_trigger t WHERE t.tgname = ANY($1::text[]) AND NOT t.tgisinternal`,
      IMMUTABILITY_TRIGGERS as unknown as string[],
    );
    const byName = new Map(rows.map((r) => [r.tgname, r]));
    const bad: string[] = [];
    for (const name of IMMUTABILITY_TRIGGERS) {
      const row = byName.get(name);
      if (!row) { bad.push(`${name}=MISSING`); continue; }
      if (row.tgenabled !== 'O') { bad.push(`${name}=${row.tgenabled}`); continue; }
      // A NAME is not enforcement. For the two triggers this engine creates itself, the bound
      // function is known and checked — an enabled same-named no-op would otherwise pass this
      // verification and let the repair commit while its own before-image stayed rewritable.
      const expected = EXPECTED_TRIGGER_FUNCTION[name];
      if (expected && row.fn !== expected) bad.push(`${name}=bound to ${row.fn}, expected ${expected}`);
    }
    if (bad.length > 0) {
      throw new RepairAbortedError(`trigger verification failed — not re-enabled or not enforcing: ${bad.join(', ')}`);
    }
    return [...IMMUTABILITY_TRIGGERS];
  }
}
