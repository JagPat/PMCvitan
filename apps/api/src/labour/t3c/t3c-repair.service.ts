import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import {
  runT3CDiagnostics,
  runT3CPlanRows,
  summarizeT3C,
  t3cCheckIdentitySql,
  t3cForeignKeyIdentitySql,
  t3cGenuineEvidenceSql,
  t3cInvalidLegacyMarker,
  t3cProbeCheckSql,
  t3cProbeTableSql,
  t3cProbeUniqueSql,
  t3cQuarantinedMarker,
  t3cRenderTs,
  t3cUniqueIdentitySql,
  T3C_ATTRIBUTION_CHECK_SEAL,
  T3C_BLANK_TRIM_SET,
  T3C_CORRECTION2_CHECK_SEAL,
  T3C_CORRECTION2_FN_REQUIREMENTS,
  T3C_CORRECTION3_FN_REQUIREMENTS,
  T3C_CORRECTION3_TRIGGER_SEALS,
  T3C_EVIDENCE_TRIGGER_SEALS,
  T3C_FN_LAYERS,
  T3C_FN_PROSRC_SQL,
  T3C_INVALID_LEGACY_PREFIX,
  T3C_MARKER_CHECK_SEAL,
  T3C_MARKER_COLUMN,
  T3C_PREREQUISITE_CHECK_SEALS,
  T3C_PREREQUISITE_FK_SEALS,
  T3C_PREREQUISITE_TRIGGER_SEALS,
  T3C_PREREQUISITE_UNIQUE_SEALS,
  T3C_REFERENCED_TABLES,
  T3C_REPAIR_GUC,
  T3C_TRIGGER_SEAL_SQL,
  type RawQueryClient,
  type T3CCheckSeal,
  type T3CDiagnosticsReport,
  type T3CFnLayerRequirement,
  type T3CTriggerSeal,
  type T3CTxClient,
} from './t3c-diagnostics';
import { t3cFnBodyAt } from './t3c-canonical-fn-bodies.generated';

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
 * Every §C seal the repair verifies — in full — before it is allowed to commit.
 *
 * The repair DISABLES `LabourAttendance_append_only` and puts it back, and "puts it back" has to
 * mean the trigger that actually freezes the row. An earlier version checked only name + enabled for
 * the `20270210000000`/`20270215000000` set, on the reasoning that this file does not own their
 * definitions and a guessed function name would be a claim it could not back. That was the wrong
 * conclusion from a correct premise: the definitions are not guesses, they are in the deployed
 * migrations, and reading them is what makes the check real. On a legacy or partially-managed
 * database an enabled same-named no-op — or one attached to the wrong events — passed verification,
 * the repair committed, and the repaired row could then be edited or deleted while its marker went
 * on claiming the original was preserved.
 *
 * The evidence seals are created HERE (see {@link EVIDENCE_SEAL_SQL}) because the evidence table is.
 * Without them the audit rows are an ordinary mutable table: a later direct write could rewrite or
 * erase the operator, reason, timestamp or the complete before-image — the only surviving copy of
 * the original blank bytes. The marker's promise has to be enforced, not merely printed.
 */
const EXPECTED_TRIGGER_SEAL: Readonly<Record<string, T3CTriggerSeal>> = Object.fromEntries(
  [...T3C_PREREQUISITE_TRIGGER_SEALS, ...T3C_EVIDENCE_TRIGGER_SEALS].map((s) => [s.name, s]),
);

const IMMUTABILITY_TRIGGERS: ReadonlyArray<string> = Object.keys(EXPECTED_TRIGGER_SEAL);

/**
 * One evidence-seal guard: create the trigger if it is absent, ABORT if a same-named object exists
 * that does not actually enforce the rule.
 *
 * "Absent" is decided by VALIDITY, not by name — the same rule the migration applies. A disabled
 * trigger, one bound to another function, or one declared for the wrong EVENTS (an enabled
 * `BEFORE UPDATE`-only `T3CRepairAction_append_only` bound to the right function leaves DELETE wide
 * open) would otherwise make this guard skip creation and let a repair commit while its freshly
 * written before-image stays erasable. A decoy is an ABORT, not something to replace silently:
 * replacing it would erase the evidence that someone put it there.
 */
function evidenceSealGuard(seal: T3CTriggerSeal, create: string): string {
  return `DO $do$
     DECLARE tg pg_trigger%ROWTYPE;
   BEGIN
     SELECT * INTO tg FROM pg_trigger WHERE tgname = '${seal.name}'
       AND tgrelid = '"${seal.table}"'::regclass AND NOT tgisinternal;
     IF NOT FOUND THEN
       ${create};
     ELSIF tg.tgenabled <> 'O'
        OR tg.tgfoid::regproc::text <> '${seal.fn}'
        OR tg.tgtype <> ${seal.tgtype} THEN
       RAISE EXCEPTION '${seal.name} exists but does not seal the evidence — ${seal.what} (enabled=%, function=%, tgtype=% expected ${seal.tgtype}). See docs/RUNBOOK.md §P4T3C3.',
         tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
     END IF;
   END $do$`;
}

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
// The evidence function BODIES are composed from the SAME canonical texts migration `20270225000000`
// writes (machine-extracted into `t3c-canonical-fn-bodies.generated.ts`), so `pg_proc.prosrc` is
// byte-identical whichever writer installed a function last. Round 3i made the body part of every
// seal's identity; two writers with whitespace-divergent bodies would otherwise flip the seals
// answer depending on whether a repair or a deploy ran most recently.
const EVIDENCE_SEAL_SQL = [
  `CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_append_only() RETURNS trigger AS $fn$${t3cFnBodyAt('phase4_t3c_repair_action_append_only', T3C_FN_LAYERS.correction3)}$fn$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_no_truncate() RETURNS trigger AS $fn$${t3cFnBodyAt('phase4_t3c_repair_action_no_truncate', T3C_FN_LAYERS.correction3)}$fn$ LANGUAGE plpgsql`,
  // The evidence may only be written BY A REPAIR. Until this existed, `T3CRepairAction` accepted
  // ordinary inserts, so a direct writer could compose a complete, correctly-shaped action naming a
  // repair id of their choosing and then a pre-revoked marker citing it — and both the preflight and
  // the migration accepted the pair, because correspondence was all they could ask for. Shape is not
  // provenance. The transaction-local GUC {@link T3C_REPAIR_GUC} is set only by `repair()`, so every
  // other path — a maintenance script, an ORM, a psql session, a restore tool, a forger — is refused
  // at insert time.
  //
  // What this does NOT claim, stated plainly because the alternative is a false security claim:
  // an actor with direct write access can read this source and call `set_config` themselves, and an
  // actor who can disable triggers needs even less. Nothing enforced inside a database is
  // unforgeable to someone who owns it. What it buys is that shaping a row correctly is no longer
  // enough — writing evidence now requires deliberately impersonating the repair protocol, and every
  // ordinary path is closed. Rows written before the seal existed remain indistinguishable, which is
  // exactly what the `f1-quarantine-forged-marker` exit is for.
  //
  // `repairId` is checked non-blank HERE rather than folded into
  // `T3CRepairAction_attribution_non_blank`: that constraint already exists on deployed databases,
  // and widening its definition in place would leave old and new databases silently enforcing
  // different rules under one name. A BEFORE INSERT trigger is forward-only by nature, so it adds
  // the rule for every future row without ever making an existing row un-migratable.
  `CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_path() RETURNS trigger AS $fn$${t3cFnBodyAt('phase4_t3c_repair_action_path', T3C_FN_LAYERS.correction3)}$fn$ LANGUAGE plpgsql`,
  evidenceSealGuard(
    EXPECTED_TRIGGER_SEAL.T3CRepairAction_append_only!,
    `CREATE TRIGGER "T3CRepairAction_append_only" BEFORE UPDATE OR DELETE ON "T3CRepairAction"
         FOR EACH ROW EXECUTE FUNCTION phase4_t3c_repair_action_append_only()`,
  ),
  evidenceSealGuard(
    EXPECTED_TRIGGER_SEAL.T3CRepairAction_no_truncate!,
    `CREATE TRIGGER "T3CRepairAction_no_truncate" BEFORE TRUNCATE ON "T3CRepairAction"
         FOR EACH STATEMENT EXECUTE FUNCTION phase4_t3c_repair_action_no_truncate()`,
  ),
  evidenceSealGuard(
    EXPECTED_TRIGGER_SEAL.T3CRepairAction_repair_path_only!,
    `CREATE TRIGGER "T3CRepairAction_repair_path_only" BEFORE INSERT ON "T3CRepairAction"
         FOR EACH ROW EXECUTE FUNCTION phase4_t3c_repair_action_path()`,
  ),
  // DROP TABLE fires NO table trigger — not the row-level append-only pair, not the statement-level
  // TRUNCATE seal. Without this, the same role that writes attendance could erase every before-image
  // in one DDL statement while the markers go on claiming their originals are preserved. Only an
  // EVENT trigger sees a drop, so one guards the evidence table by name. Creating an event trigger
  // requires superuser; if this role cannot, the repair ABORTS rather than committing evidence it
  // cannot seal — the runbook documents running the repair as a role that can.
  //
  // Stated honestly, as for every seal here: a role able to DROP TABLE at will can typically also
  // DROP EVENT TRIGGER first. What this closes is the ONE-STATEMENT erasure and every ordinary
  // tooling path; removing the guard is a separate, loud, auditable DDL act — and `t3c seals`
  // reports its absence, so a database whose guard was removed is not "sealed".
  // The guard covers the whole table AND its columns: `ALTER TABLE … DROP COLUMN "beforeImage"`
  // fires `sql_drop` with object_type 'table column', not 'table', so a type-equality test let the
  // same role erase every preserved original in one statement while the markers went on claiming
  // their before-images existed. `address_names` carries the owning table's name for both shapes.
  `DO $do$
     DECLARE ev pg_event_trigger%ROWTYPE;
   BEGIN
     CREATE OR REPLACE FUNCTION phase4_t3c_evidence_drop_guard() RETURNS event_trigger AS $fn$${t3cFnBodyAt('phase4_t3c_evidence_drop_guard', T3C_FN_LAYERS.correction3)}$fn$ LANGUAGE plpgsql;

     SELECT * INTO ev FROM pg_event_trigger WHERE evtname = 'phase4_t3c_evidence_drop_guard';
     IF NOT FOUND THEN
       CREATE EVENT TRIGGER phase4_t3c_evidence_drop_guard ON sql_drop
         EXECUTE FUNCTION phase4_t3c_evidence_drop_guard();
     ELSIF ev.evtenabled <> 'O'
        OR ev.evtfoid::regproc::text <> 'phase4_t3c_evidence_drop_guard'
        OR ev.evtevent <> 'sql_drop' THEN
       RAISE EXCEPTION 'phase4_t3c_evidence_drop_guard exists but does not guard the evidence table against DROP (enabled=%, function=%, event=%). See docs/RUNBOOK.md §P4T3C3.',
         ev.evtenabled, ev.evtfoid::regproc::text, ev.evtevent;
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
  //
  // And when one already exists, its IDENTITY is verified rather than its name — the stored parse
  // tree's deparse must equal the canonical expression's, obtained on a session-local TEMP probe
  // table. Round 3g evaluated the expression over a finite truth table instead, and that accepts
  // weaker same-named constraints (the canonical rule plus an `OR` arm the four probes never
  // exercise); no finite row set decides an infinite string domain. A same-named `CHECK (TRUE)`, a
  // token decoy, or a widened rule would each let the engine write evidence under a constraint that
  // permits what it forbids — permanently, because the table is append-only. A decoy is an ABORT,
  // never something to replace silently.
  //
  // This block runs BEFORE the ALTER guard below is created, deliberately: the first seal
  // application on a table without the constraint must still be able to ADD it.
  `DO $do$
     DECLARE blank BIGINT; expr TEXT; canonical TEXT; guard_present BOOLEAN;
   BEGIN
     SELECT pg_get_expr(conbin, conrelid) INTO expr FROM pg_constraint
      WHERE conname = '${T3C_ATTRIBUTION_CHECK_SEAL.name}'
        AND conrelid = '"T3CRepairAction"'::regclass AND contype = 'c';
     IF expr IS NOT NULL THEN
       ${t3cProbeTableSql('T3CRepairAction')};
       ${t3cProbeCheckSql(T3C_ATTRIBUTION_CHECK_SEAL)};
       SELECT pg_get_expr(conbin, conrelid) INTO canonical FROM pg_constraint
        WHERE conname = 'probe_${T3C_ATTRIBUTION_CHECK_SEAL.name}'
          AND conrelid = to_regclass('pg_temp."t3c_seal_probe_t3crepairaction"');
       IF expr IS DISTINCT FROM canonical THEN
         RAISE EXCEPTION 'T3CRepairAction_attribution_non_blank exists but is not the canonical attribution rule (found %, canonical %) — refusing to write evidence under a rule that permits what it forbids. See docs/RUNBOOK.md §P4T3C3.', expr, canonical;
       END IF;
       RETURN;
     END IF;
     IF EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = '${T3C_ATTRIBUTION_CHECK_SEAL.name}'
                   AND conrelid = '"T3CRepairAction"'::regclass) THEN
       RAISE EXCEPTION 'T3CRepairAction_attribution_non_blank exists but is not a CHECK constraint — refusing to proceed. See docs/RUNBOOK.md §P4T3C3.';
     END IF;
     -- The ALTER guard below is DATABASE-scoped while the table it guards can be dropped (that
     -- deliberate act removes the drop guard but not this one), so on a re-created evidence table
     -- the guard would refuse the very ADD CONSTRAINT that re-seals it — a state that could be
     -- diagnosed but never exited. The audited sealing path is the ONE place allowed to add the
     -- canonical constraint, so it scopes the guard down for exactly that statement and puts it
     -- back; the re-enable plus the seals verification make any failure here loud, never silent.
     SELECT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'phase4_t3c_evidence_alter_guard')
       INTO guard_present;
     IF guard_present THEN ALTER EVENT TRIGGER phase4_t3c_evidence_alter_guard DISABLE; END IF;
     SELECT count(*) INTO blank FROM "T3CRepairAction"
      WHERE btrim("operator", ${T3C_BLANK_TRIM_SET}) = '' OR btrim("reason", ${T3C_BLANK_TRIM_SET}) = '';
     IF blank > 0 THEN
       RAISE WARNING 'T3CRepairAction holds % legacy row(s) whose operator or reason is blank; the non-blank rule is installed NOT VALID so new evidence is constrained and the existing rows are preserved. See docs/RUNBOOK.md §P4T3C3.', blank;
       ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "${T3C_ATTRIBUTION_CHECK_SEAL.name}"
         CHECK (${T3C_ATTRIBUTION_CHECK_SEAL.canonicalExpr}) NOT VALID;
     ELSE
       ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "${T3C_ATTRIBUTION_CHECK_SEAL.name}"
         CHECK (${T3C_ATTRIBUTION_CHECK_SEAL.canonicalExpr});
     END IF;
     IF guard_present THEN ALTER EVENT TRIGGER phase4_t3c_evidence_alter_guard ENABLE; END IF;
   END $do$`,
  // Destructive ALTERation is guarded as well as outright DROP. The sql_drop guard above sees a
  // dropped column, but a RENAME drops nothing — `ALTER TABLE "T3CRepairAction" RENAME COLUMN
  // "beforeImage" TO x` orphans every reader of the before-images without firing sql_drop at all.
  // A ddl_command_end trigger sees every ALTER TABLE against the evidence table and refuses it.
  // Removing this guard first is the same separate, loud, auditable DDL act as for the drop guard,
  // and `t3c seals` reports its absence. Created LAST in this list, so the legitimate
  // ADD CONSTRAINT above is never blocked by our own seal on first application.
  `DO $do$
     DECLARE ev pg_event_trigger%ROWTYPE;
   BEGIN
     CREATE OR REPLACE FUNCTION phase4_t3c_evidence_alter_guard() RETURNS event_trigger AS $fn$${t3cFnBodyAt('phase4_t3c_evidence_alter_guard', T3C_FN_LAYERS.correction3)}$fn$ LANGUAGE plpgsql;

     SELECT * INTO ev FROM pg_event_trigger WHERE evtname = 'phase4_t3c_evidence_alter_guard';
     IF NOT FOUND THEN
       CREATE EVENT TRIGGER phase4_t3c_evidence_alter_guard ON ddl_command_end
         EXECUTE FUNCTION phase4_t3c_evidence_alter_guard();
     ELSIF ev.evtenabled <> 'O'
        OR ev.evtfoid::regproc::text <> 'phase4_t3c_evidence_alter_guard'
        OR ev.evtevent <> 'ddl_command_end' THEN
       RAISE EXCEPTION 'phase4_t3c_evidence_alter_guard exists but does not guard the evidence table against ALTER (enabled=%, function=%, event=%). See docs/RUNBOOK.md §P4T3C3.',
         ev.evtenabled, ev.evtfoid::regproc::text, ev.evtevent;
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
  /** The orgs-owned standing rule, reached through its participant — never by querying orgs tables
   *  here. Constructed directly (the participant is stateless) because this service runs from the
   *  operator CLI without Nest DI, exactly like the service itself. */
  private readonly orgs = new OrgsParticipant();

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
   *
   * The answer covers the CONDITIONAL evidence seals too, whenever `T3CRepairAction` exists. That
   * table is created by the repair rather than by any migration, so on a database where no repair
   * has ever run there is nothing to seal and nothing to report; but on a pre-baseline or restored
   * database that DOES carry it with a disabled, UPDATE-only or decoy-bound append-only trigger,
   * answering "sealed" would resolve correction 3 as applied without ever executing the block that
   * seals the evidence — leaving every before-image a marked attendance row points at freely
   * updateable, deletable or truncatable. The trusted record would be the one object nobody checked.
   */
  async correctionSeals(): Promise<{
    installed: boolean;
    present: string[];
    missing: string[];
    /**
     * Raw-SQL objects from `20270210000000`/`20270215000000` that are absent — the nine triggers,
     * the twelve CHECK constraints, the six unique/candidate keys and the ten composite FKs that
     * `prisma db push` does not reproduce. NON-EMPTY means this database has the §C TABLES without
     * the §C GUARDS — the `db push` signature — and it is reported separately because the answer is
     * different: those migrations `CREATE TABLE` and so cannot simply be left pending to re-run.
     * `migrate.sh` refuses to baseline on this. Triggers alone were checked once, and a database
     * carrying the triggers but not `LabourAttendance_revoke_attribution_check` baselined cleanly —
     * after which a raw update could set `revokedAt` alone, a permanently unattributed correction.
     */
    prerequisitesMissing: string[];
    /**
     * Are `20270220000000`'s physical objects installed — its CHECK **and** the function BODIES it
     * `CREATE OR REPLACE`s ({@link T3C_CORRECTION2_FN_REQUIREMENTS})? A trigger bound to the
     * pre-correction-2 append-only body passes every name/tgtype test while `manualReason` stays
     * rewritable, so the body is part of this layer's answer. When not installed, that migration
     * joins the pending set — re-running it heals the body (`CREATE OR REPLACE` is its own repair).
     */
    correction2Installed: boolean;
    /** Exactly which correction-2 objects are absent (for the operator-facing message). */
    correction2Missing: string[];
    /**
     * Migration directories `migrate.sh` must NOT resolve as applied on the P3005 baseline path —
     * each is a re-runnable, diagnostic-first correction whose physical seals are absent, so it is
     * left pending and `migrate deploy` executes it for real.
     */
    pendingMigrations: string[];
  }> {
    // ONE transaction: the CHECK/unique identity tests deparse canonical expressions on
    // session-local TEMP probe tables, and a pooled client may hand consecutive queries to
    // different connections. Everything here is read-only with respect to every REAL relation.
    return this.prisma.$transaction(async (tx: T3CTxClient) => {
      const present: string[] = [];
      const missing: string[] = [];
      const prerequisitesMissing: string[] = [];

      // Probe tables for every real table a CHECK/unique identity test needs, created once.
      const probeTables = new Set<string>([
        ...T3C_PREREQUISITE_CHECK_SEALS.map((s) => s.table),
        ...T3C_PREREQUISITE_UNIQUE_SEALS.map((s) => s.table),
        T3C_MARKER_CHECK_SEAL.table,
        T3C_CORRECTION2_CHECK_SEAL.table,
      ]);
      for (const table of probeTables) await tx.$executeRawUnsafe(t3cProbeTableSql(table));

      // ── prerequisites: EVERY raw-SQL object of 20270210/20270215, not only the triggers ──
      for (const seal of T3C_PREREQUISITE_TRIGGER_SEALS) {
        if (!(await this.triggerSealed(tx, seal))) prerequisitesMissing.push(seal.name);
      }
      for (const seal of T3C_PREREQUISITE_CHECK_SEALS) {
        if (!(await this.checkSealed(tx, seal))) prerequisitesMissing.push(seal.name);
      }
      for (const seal of T3C_PREREQUISITE_UNIQUE_SEALS) {
        await tx.$executeRawUnsafe(t3cProbeUniqueSql(seal));
        const rows = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(t3cUniqueIdentitySql(seal));
        if (rows[0]?.ok !== true) prerequisitesMissing.push(seal.name);
      }
      for (const seal of T3C_PREREQUISITE_FK_SEALS) {
        const rows = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(t3cForeignKeyIdentitySql(seal));
        if (rows[0]?.ok !== true) prerequisitesMissing.push(seal.name);
      }

      // ── correction 2 — its own PENDING layer, never a refusal (the migration is re-runnable) ──
      // The layer is its CHECK plus the function BODIES it CREATE OR REPLACEs. A restored database
      // can hold the constraint while the append-only function still carries the 20270210 body that
      // does not freeze `manualReason` — or vice versa; either half absent means the migration must
      // really run, and running it heals both.
      const correction2Missing: string[] = [];
      if (!(await this.checkSealed(tx, T3C_CORRECTION2_CHECK_SEAL))) {
        correction2Missing.push(T3C_CORRECTION2_CHECK_SEAL.name);
      }
      for (const req of T3C_CORRECTION2_FN_REQUIREMENTS) {
        if (!(await this.fnBodyIsOneOf(tx, req.fn, req.bodies))) {
          correction2Missing.push(`${req.fn}@${req.layer}`);
        }
      }
      const correction2Installed = correction2Missing.length === 0;

      // A seal is only installed if it is present, ENABLED, wired to the function that actually
      // enforces it, AND declared for EXACTLY the events the deployed DDL declares. A name alone
      // proves nothing: `ALTER TABLE … DISABLE TRIGGER` leaves `tgenabled='D'`, a same-named
      // trigger bound to some other function is a decoy, a `BEFORE UPDATE`-only variant lets every
      // INSERT sail past — and EXTRA events are just as disqualifying as missing ones, because a
      // `BEFORE INSERT OR UPDATE OR DELETE` binding of the unconditionally-raising append-only
      // function rejects every legitimate evidence INSERT while a bitmask test calls it sealed.
      // See {@link T3CTriggerSeal.tgtype}.
      const haveEvidence = await this.evidenceTablePresent(tx);
      const triggerSeals = [
        ...T3C_CORRECTION3_TRIGGER_SEALS,
        ...(haveEvidence ? T3C_EVIDENCE_TRIGGER_SEALS : []),
      ];
      for (const seal of triggerSeals) {
        if (await this.triggerSealed(tx, seal)) present.push(seal.name);
        else missing.push(seal.name);
      }

      // Correction 3 also CREATE OR REPLACEs the head-live FUNCTION without recreating its trigger
      // (the trigger itself is a prerequisite seal, which accepts every deployed layer's body). A
      // database whose head-live body predates 20270225 has NOT installed this correction, however
      // present its own two triggers are — leaving it pending makes the deploy write the body.
      for (const req of T3C_CORRECTION3_FN_REQUIREMENTS) {
        const label = `${req.fn}@${req.layer}`;
        if (await this.fnBodyIsOneOf(tx, req.fn, req.bodies)) present.push(label);
        else missing.push(label);
      }

      if (await this.checkSealed(tx, T3C_MARKER_CHECK_SEAL)) present.push(T3C_MARKER_CHECK_SEAL.name);
      else missing.push(T3C_MARKER_CHECK_SEAL.name);

      // The evidence attribution rule. Unlike the seals above it may legitimately be NOT VALID — a
      // database whose repair predates it can hold blank-attributed legacy rows, and the whole
      // point of installing it unvalidated is that those rows are preserved rather than becoming a
      // deploy that can never succeed. So `convalidated` is deliberately NOT required
      // ({@link T3C_ATTRIBUTION_CHECK_SEAL}); its IDENTITY is required all the same.
      if (haveEvidence) {
        // The evidence probe is created HERE, not in the loop above — `LIKE "T3CRepairAction"`
        // needs the real table, which exists only once a repair has run.
        await tx.$executeRawUnsafe(t3cProbeTableSql(T3C_ATTRIBUTION_CHECK_SEAL.table));
        if (await this.checkSealed(tx, T3C_ATTRIBUTION_CHECK_SEAL)) present.push(T3C_ATTRIBUTION_CHECK_SEAL.name);
        else missing.push(T3C_ATTRIBUTION_CHECK_SEAL.name);

        // The DROP and ALTER guards are EVENT triggers — `pg_trigger` never sees them — verified
        // with the same whole-seal discipline: enabled, bound to their function, declared for their
        // event, AND carrying the canonical function BODY (`CREATE OR REPLACE` preserves identity
        // for event-trigger functions exactly as for table-trigger ones — a same-named guard whose
        // body excludes the evidence table reads sealed while guarding nothing). A database whose
        // guard was removed or hollowed is not "sealed", however intact the rest looks.
        for (const guard of [
          { name: 'phase4_t3c_evidence_drop_guard', event: 'sql_drop' },
          { name: 'phase4_t3c_evidence_alter_guard', event: 'ddl_command_end' },
        ]) {
          const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_event_trigger e
              WHERE e.evtname = $1
                AND e.evtenabled = 'O'
                AND e.evtfoid::regproc::text = $1
                AND e.evtevent = $2
                AND (SELECT p.prosrc FROM pg_proc p WHERE p.oid = e.evtfoid) = $3`,
            guard.name,
            guard.event,
            t3cFnBodyAt(guard.name, T3C_FN_LAYERS.correction3),
          );
          if (Number(rows[0]?.n ?? 0) > 0) present.push(guard.name);
          else missing.push(guard.name);
        }
      }

      // WHICH migration each absence leaves pending is decided by what re-running it actually does.
      // `20270220000000` is deployed and its `ALTER TABLE … ADD CONSTRAINT` is UNCONDITIONAL, so it
      // may be left pending ONLY when its CHECK is genuinely absent — replaying it over an existing
      // constraint fails the whole deploy. A correction-2 function BODY that is stale while the
      // CHECK exists is healed by `20270225000000` instead, which re-asserts the canonical
      // `phase4_t3_attendance_append_only` body precisely because the older migration cannot
      // re-run. And whenever `20270220000000` IS pending, `20270225000000` is left pending WITH it:
      // the older replay rewrites `phase4_t3c_allocation_head_live` back to its 20270220 body, and
      // only the newer migration's re-run restores the 20270225 version the correction-3 layer
      // requires.
      const correction2CheckMissing = correction2Missing.includes(T3C_CORRECTION2_CHECK_SEAL.name);
      const correction2BodyStale = correction2Missing.some((m) => m !== T3C_CORRECTION2_CHECK_SEAL.name);
      const pendingMigrations: string[] = [];
      if (correction2CheckMissing) pendingMigrations.push('20270220000000_phase4_t3_correction2');
      if (missing.length > 0 || correction2BodyStale || correction2CheckMissing) {
        pendingMigrations.push('20270225000000_phase4_t3_correction3');
      }

      return {
        installed: missing.length === 0 && prerequisitesMissing.length === 0 && correction2Installed,
        present,
        missing,
        prerequisitesMissing,
        correction2Installed,
        correction2Missing,
        pendingMigrations,
      };
    });
  }

  /**
   * A COMPLETE plan skeleton covering EVERY finding row — not just the bounded report samples.
   *
   * The repair is all-or-nothing (it commits only when the in-transaction re-diagnose reads clean),
   * so the plan must be able to NAME every row. The report's twenty-row samples could not, and on a
   * database with more findings than that the supported recovery was a loop: repair the visible
   * twenty, roll back over the rest, see the same twenty again. `t3c plan` writes this skeleton to a
   * file; the operator fills in `revokedById`/`revokeReason` per action (the engine refuses blanks,
   * out-of-project revokers, and mismatched pre-revoked attributions exactly as for a hand-written
   * plan) and submits it whole. `manual` lists the rows the engine must NOT touch — real audited
   * repairs left live — with their application exit.
   */
  async planSkeleton(): Promise<{
    operator: string;
    reason: string;
    actions: RepairAction[];
    manual: Array<{ id: string; exit: string }>;
  }> {
    const rows = await runT3CPlanRows(this.prisma);
    return {
      operator: '',
      reason: '',
      actions: [
        ...rows.blanks.map((id) => ({
          finding: 'F1.blank',
          op: 'f1-mark-invalid-legacy' as const,
          id,
          revokedById: '',
          revokeReason: '',
        })),
        ...rows.quarantine.map((id) => ({
          finding: 'F1.marker',
          op: 'f1-quarantine-forged-marker' as const,
          id,
          revokedById: '',
          revokeReason: '',
        })),
      ] as RepairAction[],
      manual: rows.manual.map((id) => ({ id, exit: 'revoke-through-the-application' })),
    };
  }

  /** Is one trigger present, ENABLED, bound to the function that enforces the rule, declared for
   *  EXACTLY the events its DDL declares, AND carrying a canonical function BODY? tgtype is
   *  equality, not a bitmask ({@link T3CTriggerSeal.tgtype}); the body is byte equality with a
   *  deployed layer's `prosrc` ({@link T3CTriggerSeal.fnBodies}) — `CREATE OR REPLACE FUNCTION`
   *  preserves the function's identity, so name + tgtype alone accepted a trigger still enforcing
   *  a pre-correction body. One query per accepted layer body; sealed when any matches. */
  private async triggerSealed(client: RawQueryClient, seal: T3CTriggerSeal): Promise<boolean> {
    for (const body of seal.fnBodies) {
      const rows = await client.$queryRawUnsafe<Array<{ n: number }>>(
        T3C_TRIGGER_SEAL_SQL,
        seal.name,
        `"${seal.table}"`,
        seal.fn,
        seal.tgtype,
        body,
      );
      if (Number(rows[0]?.n ?? 0) > 0) return true;
    }
    return false;
  }

  /** Does the named function exist with one of the pinned canonical bodies? */
  private async fnBodyIsOneOf(client: RawQueryClient, fn: string, bodies: readonly string[]): Promise<boolean> {
    const rows = await client.$queryRawUnsafe<Array<{ src: string }>>(T3C_FN_PROSRC_SQL, fn);
    const src = rows[0]?.src;
    return typeof src === 'string' && bodies.includes(src);
  }

  /** Does the repair-evidence table exist here? Its absence means no repair has ever run. */
  private async evidenceTablePresent(client: RawQueryClient = this.prisma): Promise<boolean> {
    const rows = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('"T3CRepairAction"') IS NOT NULL AS present`,
    );
    return rows[0]?.present === true;
  }

  /**
   * IS a named CHECK constraint the canonical one — same parse tree, verified by deparse identity?
   *
   * The name is not the rule, and neither is a finite behavioural test. Round 3f accepted a
   * constraint whose text mentioned the right tokens; round 3g evaluated its expression over a
   * truth table, and that still accepts weaker same-named constraints (the canonical expression
   * plus an `OR` arm the probes never exercise — `OR "manualReason" LIKE '%permit'` passes all four
   * marker probes while admitting a live marked row). No finite row set decides an infinite string
   * domain. So the constraint's stored parse tree, rendered by `pg_get_expr`, must EQUAL the
   * deparse of the canonical expression the owning migration writes — obtained on a session-local
   * TEMP probe table in the same database, so both sides render identically. String equality is
   * total: it cannot raise on a hostile expression and cannot be approximated into.
   *
   * MUST run inside the transaction that created the probe tables ({@link t3cProbeTableSql}).
   * `requireValidated` distinguishes the marker CHECK (installed over a proven-clean table, so
   * VALIDATED) from the evidence attribution CHECK (legitimately NOT VALID over preserved legacy
   * rows — see {@link T3C_ATTRIBUTION_CHECK_SEAL}).
   */
  private async checkSealed(tx: T3CTxClient, seal: T3CCheckSeal): Promise<boolean> {
    // The probe ALTER runs under a SAVEPOINT: a plain try/catch is not enough inside a PostgreSQL
    // transaction — after any errored statement the tx is aborted and EVERY later seal check would
    // answer 25P02, turning one defect into a wall of noise. Rolling back to the savepoint keeps
    // the transaction usable while this one seal fails closed.
    await tx.$executeRawUnsafe('SAVEPOINT t3c_seal_probe');
    try {
      await tx.$executeRawUnsafe(t3cProbeCheckSql(seal));
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT t3c_seal_probe');
    } catch {
      // The canonical expression failed to parse against the probe's columns — that is a defect in
      // THIS file, not the database; fail closed and let the seals report name it missing.
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT t3c_seal_probe');
      return false;
    }
    const rows = await tx.$queryRawUnsafe<Array<{ canonical: string | null; actual: string | null }>>(
      t3cCheckIdentitySql(seal),
    );
    const row = rows[0];
    return row?.canonical != null && row.actual != null && row.canonical === row.actual;
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
        // 0. Declare this transaction to BE the repair, so the evidence table's repair-path seal
        //    admits the rows written below and refuses every other writer. Transaction-local
        //    (`is_local = true`), so it is gone at COMMIT or ROLLBACK and never leaks to the next
        //    user of this pooled connection.
        await tx.$executeRawUnsafe(`SELECT set_config('${T3C_REPAIR_GUC}', $1, true)`, repairId);

        // 0a. Durable evidence table (idempotent — a later Prisma migration cannot create it while
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

        // 0c. The CANONICAL revocation CHECK must stand before any history is written. The repair
        //     preserves a pre-existing revocation triple and writes new ones; on a restored or
        //     partially managed database where `LabourAttendance_revoke_attribution_check` is
        //     missing, weakened or NOT VALID, "revoked" rows can be malformed and the triples this
        //     engine writes would commit into a table whose attribution rule is unenforced. Same
        //     identity discipline as every other seal: the deparse of the live constraint must
        //     equal the canonical expression's, probed on a session-local TEMP clone. (The
        //     row-level coherence guard in `applyAction` is the second half — it refuses the
        //     specific malformed triple even if a decoy CHECK were somehow accepted.)
        const revocationSeal = T3C_PREREQUISITE_CHECK_SEALS.find(
          (s) => s.name === 'LabourAttendance_revoke_attribution_check',
        )!;
        await tx.$executeRawUnsafe(t3cProbeTableSql(revocationSeal.table));
        if (!(await this.checkSealed(tx, revocationSeal))) {
          throw new RepairAbortedError(
            'LabourAttendance_revoke_attribution_check is not the canonical validated revocation rule — a repair will not write new history into a table whose revocation attribution is unenforced; reconcile the schema first (docs/RUNBOOK.md §P4T3C3)',
          );
        }

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
    // A PRE-EXISTING revocation is preserved only if it is COHERENT. `revokedAt` alone is not a
    // revocation: on a restored or partially managed database where
    // `LabourAttendance_revoke_attribution_check` was missing or weakened, a row can carry a
    // timestamp with no revoker and no reason — and treating that as "already revoked" would
    // preserve the malformed triple, write a marker over it, and commit a permanently
    // UNATTRIBUTED correction under an engine whose whole purpose is attribution. The state is a
    // schema-integrity finding for the operator, not history to preserve.
    if (
      before['revokedAt'] != null &&
      (before['revokedById'] == null || before['revokeReason'] == null)
    ) {
      throw new RepairAbortedError(
        `${action.op}: LabourAttendance ${action.id} carries an INCOHERENT revocation (revokedAt is set but revokedById=${JSON.stringify(before['revokedById'])}, revokeReason=${JSON.stringify(before['revokeReason'])}) — this violates LabourAttendance_revoke_attribution_check, so the database's guards were bypassed or are missing; reconcile the schema and this row's provenance first (docs/RUNBOOK.md §P4T3C3). The engine never preserves a malformed triple as history`,
      );
    }
    // STANDING is asserted only where the revocation is being WRITTEN (the still-live paths below).
    // On the preserved path the plan's `revokedById` is never written — it must merely NAME the
    // revoker already on the row, and that person's standing is history, not a new claim: requiring
    // a live membership there would make a row whose original revoker has since left the project
    // permanently unrepairable, the exact no-exit trap this engine keeps having to remove.
    const revocationWillBeWritten = before['revokedAt'] == null;
    if (revocationWillBeWritten) {
      await this.assertRevokerEntitled(tx, String(before['projectId']), action.revokedById, action.op);
    }
    // ONE timestamp for a still-live row's revocation, captured BEFORE the evidence is written and
    // used verbatim in BOTH the evidence detail and the row update. Recording `null` in the detail
    // while the update wrote `now()` left the append-only evidence permanently contradicting the
    // attendance row it describes — and the detail's contract is "the triple actually written".
    // Rendered canonically (`t3cRenderTs` over `now()::timestamp(3)` — ms precision first, exactly
    // what the naive column stores) so the detail string equals what a later `captureBefore` of the
    // same row renders; the update parses the SAME string back, so correspondence is by
    // construction, not by two calls to now() happening to agree.
    const stamped = await tx.$queryRawUnsafe<Array<{ render: string }>>(
      `SELECT ${t3cRenderTs('now()::timestamp(3)')} AS render`,
    );
    const revocationStamp = stamped[0]!.render;

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
          // evidence cannot claim an attribution the database does not hold. On the live path the
          // timestamp is the ONE captured above, which the update below writes verbatim.
          revokedById: preRevoked ? before['revokedById'] : action.revokedById,
          revokedAt: preRevoked ? before['revokedAt'] : revocationStamp,
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
                    "revokedAt"    = COALESCE("revokedAt", $5::timestamp),
                    "revokedById"  = COALESCE("revokedById", $2),
                    "revokeReason" = COALESCE("revokeReason", $3)
              WHERE "id" = $4`,
            marker,
            action.revokedById,
            action.revokeReason,
            action.id,
            revocationStamp,
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

        // THE REVOCATION TRIPLE IS COHERENT OR IT IS UNTOUCHED. A marked row is usually ALREADY
        // revoked — the marker CHECK requires it, and a forger writing a pre-revoked row is the very
        // case this op exists for. Stamping the quarantine's `revokedById`/`revokeReason` onto it
        // while `COALESCE` preserved the original `revokedAt` produced a triple that never happened:
        // "B revoked this at T1, for reason Q", where T1 is someone else's timestamp. Consumers read
        // the revocation attribution straight off `LabourAttendance`, so that is not a cosmetic
        // inconsistency — it is a false statement about who did what and when, written by the tool
        // whose entire purpose is to keep the record honest. The same rule already governs
        // `f1-mark-invalid-legacy`.
        //
        // So: a pre-revoked row keeps ALL THREE fields verbatim and the quarantine is recorded in the
        // append-only evidence (which is where an operator action belongs anyway); a still-live row
        // takes the operator's complete, self-consistent triple. Either way the row ends revoked —
        // the marker CHECK is satisfied — and its marker finally names evidence that exists.
        const preRevoked = before['revokedAt'] != null;
        // On the preserved path `revokedById` is NOT written, so the FK never validates it.
        // Recording the plan's value in append-only evidence would permanently store an id nothing
        // ever checked; the operator must instead NAME the revoker actually on the row, which is a
        // statement they can make truthfully after reading it. Same rule as the retirement op.
        if (preRevoked && action.revokedById !== before['revokedById']) {
          throw new RepairAbortedError(
            `f1-quarantine-forged-marker: LabourAttendance ${action.id} was already revoked by ${JSON.stringify(before['revokedById'])}; that attribution is preserved, so the plan must name the same revokedById rather than one that will be ignored`,
          );
        }
        // The forged row is its own before-image. It is NOT blank and is not recorded as though it
        // were; what is preserved is exactly what the forger wrote, so the incident stays readable.
        const marker = t3cQuarantinedMarker(repairId, plan.operator);
        await this.recordEvidence(tx, repairId, plan, action, table, before, {
          markerPrefix: T3C_INVALID_LEGACY_PREFIX,
          forgedManualReason: raw,
          // What the row will actually carry after this repair, so the evidence records reality
          // rather than the plan's intent. On the live path the timestamp is the ONE captured in
          // `revocationStamp`, which the update below writes verbatim.
          revocationPreserved: preRevoked,
          revokedById: preRevoked ? before['revokedById'] : action.revokedById,
          revokedAt: preRevoked ? before['revokedAt'] : revocationStamp,
          revokeReason: preRevoked ? before['revokeReason'] : action.revokeReason,
          // What the OPERATOR said when quarantining — recorded here without overwriting what the
          // original revoker said on the row.
          quarantineNote: action.revokeReason,
        });
        try {
          if (preRevoked) {
            await tx.$executeRawUnsafe(
              `UPDATE "LabourAttendance" SET "manualReason" = $1 WHERE "id" = $2`,
              marker,
              action.id,
            );
          } else {
            await tx.$executeRawUnsafe(
              `UPDATE "LabourAttendance"
                  SET "manualReason" = $1,
                      "revokedAt"    = $5::timestamp,
                      "revokedById"  = $2,
                      "revokeReason" = $3
                WHERE "id" = $4`,
              marker,
              action.revokedById,
              action.revokeReason,
              action.id,
              revocationStamp,
            );
          }
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

  /**
   * The named revoker must be entitled ON THE ATTENDANCE ROW'S PROJECT.
   *
   * `LabourAttendance_revokedBy_fkey` proves the id names SOME user, and that is all it proves.
   * Every normal revoke path is scoped because the request was authorized for that project before it
   * reached a service; this maintenance path has no request, so a plan naming any existing user from
   * any other tenant committed — and permanently attributed one project's revocation to a person
   * with no standing there. An immutable, append-only misattribution is exactly the kind of record
   * this engine exists to prevent.
   *
   * The QUESTION is answered by its OWNER. `Membership`/`OrgMembership`/`Project` are orgs-owned;
   * an earlier draft queried them directly from here on the reasoning that they are not
   * read-encapsulated, and that reasoning was rejected on review — not being read-encapsulated
   * makes the read representable, not legitimate. So the rule lives in
   * {@link OrgsParticipant.hasProjectStanding} (the same cycle-exempt participant channel every
   * other cross-module interaction uses; `labour.workflowParticipants` lists `orgs`), evaluated
   * against THIS transaction so the answer is consistent with what the repair sees.
   */
  private async assertRevokerEntitled(
    tx: T3CTxClient,
    projectId: string,
    revokedById: string,
    op: string,
  ): Promise<void> {
    const entitled = await this.orgs.hasProjectStanding(tx, projectId, revokedById);
    if (!entitled) {
      throw new RepairAbortedError(
        `${op}: revokedById ${JSON.stringify(revokedById)} has no standing on project ${JSON.stringify(projectId)} — a revocation is attributed to someone accountable FOR THAT PROJECT (an active membership, or owner/admin of its org), not merely to a user that exists`,
      );
    }
  }

  /**
   * The COMPLETE row as JSON, with its two `timestamptz` columns rendered in ONE canonical form.
   *
   * `to_jsonb(t)` keeps every column — including any added later — so the before-image cannot drift
   * out of completeness. But PostgreSQL renders a `timestamptz` into JSON using the WRITER's session
   * `TimeZone`, which makes the stored text unequal to the same instant rendered by a reader in
   * another zone. A checker therefore could not compare the timestamp by VALUE at all: casting
   * attacker-supplied text RAISES rather than returning false, so the earlier predicate settled for
   * "the key is present", and evidence carrying a null or fabricated `recordedAt` authenticated a
   * marker while preserving none of the timestamp it claimed.
   *
   * Rendering both sides with the same explicit UTC `to_char` makes the comparison pure TEXT: total,
   * session-independent, and impossible to make raise. {@link T3C_TS_RENDER} is the one definition,
   * shared with the diagnostic predicate and duplicated verbatim in `20270225000000`.
   */
  private async captureBefore(tx: T3CTxClient, table: string, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT to_jsonb(t) || jsonb_build_object(
                'recordedAt', ${t3cRenderTs('t."recordedAt"')},
                'revokedAt',  ${t3cRenderTs('t."revokedAt"')}
              ) AS row
         FROM "${table}" t WHERE t."id" = $1`,
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
    // The rows are keyed by TABLE + name, never by name alone. Trigger names are only unique per
    // table in PostgreSQL, so a name-keyed Map collapsed globally duplicated names into one
    // arbitrary winner: a fully canonical `LabourAttendance_append_only` riding an UNRELATED table
    // could stand in for the attendance table's own trigger — the repair then committed after
    // restoring a no-op (or nothing at all), leaving the repaired marker and row freely rewritable.
    // Only current-schema rows are considered, so a same-named decoy in another schema cannot
    // collide with the key either.
    const rows = await tx.$queryRawUnsafe<
      Array<{ tgname: string; tbl: string; tgenabled: string; fn: string; tgtype: number; prosrc: string | null }>
    >(
      `SELECT t.tgname, c.relname AS tbl, t.tgenabled, t.tgfoid::regproc::text AS fn, t.tgtype::int AS tgtype,
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = t.tgfoid) AS prosrc
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE t.tgname = ANY($1::text[]) AND NOT t.tgisinternal AND ns.nspname = current_schema()`,
      IMMUTABILITY_TRIGGERS as unknown as string[],
    );
    const byTableAndName = new Map(rows.map((r) => [`${r.tbl}.${r.tgname}`, r]));
    const bad: string[] = [];
    for (const name of IMMUTABILITY_TRIGGERS) {
      const seal = EXPECTED_TRIGGER_SEAL[name]!;
      const row = byTableAndName.get(`${seal.table}.${name}`);
      if (!row) { bad.push(`${name} on "${seal.table}"=MISSING`); continue; }
      if (row.tgenabled !== 'O') { bad.push(`${name}=${row.tgenabled}`); continue; }
      // A NAME is not enforcement, and neither is a name plus a function. For the triggers this
      // engine creates itself the whole seal is known and checked — an enabled same-named no-op, or
      // one bound to the right function but declared for the wrong EVENTS (a `BEFORE UPDATE`-only
      // append-only trigger leaves DELETE open), would otherwise pass this verification and let the
      // repair commit while its own before-image stayed erasable.
      if (row.fn !== seal.fn) { bad.push(`${name}=bound to ${row.fn}, expected ${seal.fn}`); continue; }
      const bits = Number(row.tgtype);
      if (bits !== seal.tgtype) {
        bad.push(`${name}=tgtype ${bits}, expected exactly ${seal.tgtype} (${seal.what})`);
        continue;
      }
      // …and the function's BODY is a deployed canonical version. `CREATE OR REPLACE` preserves a
      // function's identity, so a hollowed body under the right name/tgtype would otherwise let the
      // repair commit while "put the trigger back" restored something that enforces nothing. The
      // prerequisite seals accept EVERY deployed layer's body — at repair time the corrections may
      // legitimately not have run yet, and their `CREATE OR REPLACE` heals the body at deploy.
      if (row.prosrc == null || !seal.fnBodies.includes(row.prosrc)) {
        bad.push(`${name}=${seal.fn} body is not any deployed canonical version (${seal.what})`);
      }
    }
    if (bad.length > 0) {
      throw new RepairAbortedError(`trigger verification failed — not re-enabled or not enforcing: ${bad.join(', ')}`);
    }
    return [...IMMUTABILITY_TRIGGERS];
  }
}
