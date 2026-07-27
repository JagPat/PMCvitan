import type { Prisma } from '@prisma/client';

/**
 * Phase 4 Task 3 correction (round 3) — the §C ATTENDANCE-integrity diagnostic set.
 *
 * Migration `20270220000000_phase4_t3_correction2` refuses to install
 * `LabourAttendance_manual_reason_non_blank` over a database that already holds a muster whose
 * `manualReason` is blank. That abort was correct; the documented REPAIR was not — `docs/RUNBOOK.md
 * §P4T3C2` told the operator to disable `LabourAttendance_append_only` and DELETE the row, erasing
 * the original observation, its recorder, its timestamps and its correction chain while the very
 * trigger being disabled states that attendance rows are never deleted.
 *
 * This diagnostic set is the read-only half of the sanctioned replacement. It runs identically on a
 * database that has NOT yet applied `20270220` (the repair target), on one where it FAILED and
 * rolled back, and on one where it succeeded (all counts zero) — every query references only columns
 * that exist from `20270215000000` onward.
 *
 *   - **F1.blank** mirrors the `20270220` abort exactly (the same explicit ASCII-whitespace trim
 *     set), so the preflight names it BEFORE Prisma starts instead of after a failed migration.
 *   - **F1.marker** is its post-repair companion: a row carrying the reserved invalid-legacy marker
 *     must ALSO be revoked AND be backed by the matching `T3CRepairAction` before-image naming the
 *     repair id the marker itself embeds. Revocation alone is not enough — until
 *     `20270225000000`'s reserving trigger exists, a direct writer can insert a marked row with the
 *     revocation triple already filled in, and a revoked-only test would bless it forever as an
 *     audited repair while no record of the "original bytes" it claims to preserve has ever
 *     existed. Migration `20270225000000` installs the revocation half as a CHECK; diagnosing the
 *     whole rule here means the preflight reports it by name rather than letting the CHECK fail
 *     opaquely or, worse, pass on a forgery.
 */

const SAMPLE_LIMIT = 20;

/**
 * The RESERVED marker the repair writes into `manualReason`.
 *
 * It is deliberately a statement about the RECORD, not about the worker: the repair does not know
 * why the worker was present and must never pretend to. The original bytes survive verbatim in the
 * `T3CRepairAction` before-image, and migration `20270225000000` makes the prefix unwritable by an
 * ordinary INSERT (a `LabourAttendance_reserved_marker` BEFORE INSERT trigger), so it can only ever
 * mean "an operator repaired a legacy blank", never "a pmc typed this".
 *
 * The literal is duplicated in `20270225000000`'s SQL on purpose — a migration must be auditable on
 * sight without importing TypeScript. Changing it here without changing it there is caught by
 * `phase4-t3-correction3.test.ts`.
 */
export const T3C_INVALID_LEGACY_PREFIX = '[invalid-legacy:blank-manual-reason]';

/** The ASCII whitespace class `20270220000000` trims — space, tab, newline, vertical tab, form feed,
 *  carriage return. Written as a SQL escape-string literal so the two predicates are identical. */
export const T3C_BLANK_TRIM_SET = String.raw`E' \t\n\x0B\f\r'`;

/**
 * The machine-readable half of the marker: the repair id, written immediately after the prefix so it
 * survives however the human-readable remainder is worded. This is what ties a marked attendance row
 * to ONE specific `T3CRepairAction` before-image; without it "some repair once touched this row"
 * would be all a checker could establish.
 *
 * The regex is a POSIX pattern usable directly in `substring(x from '…')`, and is duplicated verbatim
 * in `20270225000000`'s SQL (a migration must be auditable without importing TypeScript).
 */
export const T3C_MARKER_REPAIR_ID_REGEX = String.raw`repair=([0-9a-fA-F-]{36})`;

/**
 * The ONE canonical rendering of an attendance timestamp for before-image comparison — the NAIVE
 * stored value, fixed format, so the comparison is pure TEXT on both sides.
 *
 * `recordedAt`/`revokedAt` are `TIMESTAMP(3)` WITHOUT time zone (every Prisma `DateTime` is), and
 * for that type `to_char` consults NO session setting: the stored value renders to the same string
 * in every session. The earlier form appended `AT TIME ZONE 'UTC'`, which on a NAIVE timestamp
 * CONVERTS it to `timestamptz` — and `to_char(timestamptz, …)` renders in the session's own
 * `TimeZone`, so evidence captured by an Asia/Kolkata session compared by a UTC deploy session
 * produced two different strings for the same stored value, and genuine evidence was diagnosed as
 * forged. No zone arithmetic may appear here at all.
 *
 * This exists because the obvious alternatives all fail. Comparing PostgreSQL's own JSON rendering
 * compares session-dependent strings. Casting the stored text back to a timestamp RAISES on
 * anything malformed — and the stored text is attacker-supplied, so a cast turns a forged
 * before-image into an opaque aborted deploy instead of a diagnosed finding. Rendering both sides
 * identically is total: it cannot raise, and it consults nothing session-local.
 *
 * NULL renders as NULL (never the string "null"), so `IS NOT DISTINCT FROM` compares an absent
 * revocation correctly. Duplicated verbatim in `20270225000000`'s SQL — a migration must be
 * auditable on sight without importing TypeScript.
 */
export function t3cRenderTs(expr: string): string {
  return `to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/** Build the reserved marker for one repair. The text states only what is KNOWN about the record. */
export function t3cInvalidLegacyMarker(repairId: string, operator: string): string {
  return (
    `${T3C_INVALID_LEGACY_PREFIX} repair=${repairId}; the original manualReason was blank; the real ` +
    `justification was never recorded and is not knowable from the data. Retired by operator ${operator}. ` +
    `Original row preserved in T3CRepairAction.`
  );
}

/**
 * The marker a QUARANTINED forgery carries: a row that arrived wearing the invalid-legacy marker
 * without any repair ever having produced it.
 *
 * It shares the reserved prefix — so it is equally unwritable by an ordinary INSERT and equally
 * bound to the revoked-only CHECK — and embeds the quarantine's own repair id, so the row finally
 * points at evidence that exists. The text says exactly what is true: the previous text CLAIMED to
 * be an audited repair and was not.
 */
export function t3cQuarantinedMarker(repairId: string, operator: string): string {
  return (
    `${T3C_INVALID_LEGACY_PREFIX} repair=${repairId}; QUARANTINED FORGERY — this row's manualReason ` +
    `claimed to be an audited operator repair, but no repair evidence for it existed. Quarantined by ` +
    `operator ${operator}. The original row, including the text it claimed, is preserved verbatim in ` +
    `T3CRepairAction.`
  );
}

export interface T3CFindingReport {
  /** Stable finding code — `F1.blank`, `F1.marker`. */
  code: string;
  description: string;
  count: number;
  /** Up to SAMPLE_LIMIT identifying rows — never the whole set, so the report stays bounded. */
  samples: Array<Record<string, unknown>>;
}

export interface T3CDiagnosticsReport {
  findings: T3CFindingReport[];
  /** Sum of every finding's count. `0` ⇒ the attendance register satisfies every §C invariant. */
  total: number;
  clean: boolean;
}

/** A minimal query surface both `PrismaService` and a `$transaction` client satisfy. */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface Diag {
  code: string;
  description: string;
  /** Returns a single row `{ n: bigint }`. */
  count: string;
  /** Returns up to SAMPLE_LIMIT identifying rows. */
  sample: string;
}

/** Rows whose `manualReason` says nothing — the `20270220000000` abort predicate, verbatim. */
const BLANK_PREDICATE = `"manualReason" IS NOT NULL AND btrim("manualReason", ${T3C_BLANK_TRIM_SET}) = ''`;

/**
 * Rows carrying the reserved repair marker that are NOT a real audited repair: either not revoked
 * (a repaired muster that could still be read as live presence), or with no `T3CRepairAction`
 * before-image for that exact row and the repair id the marker embeds.
 *
 * `haveEvidence=false` means the evidence table does not exist, so NO repair has ever run in this
 * database and every marker present is therefore a forgery or a torn write — the absence is
 * decisive, not inconvenient, so the predicate reduces to "carries the marker".
 */
function markerPredicate(haveEvidence: boolean): string {
  const carries = `a."manualReason" LIKE '${T3C_INVALID_LEGACY_PREFIX}%'`;
  if (!haveEvidence) return carries;
  return `${carries} AND (a."revokedAt" IS NULL OR NOT ${t3cGenuineEvidenceSql('a')})`;
}

/**
 * `EXISTS (…)`: does `<alias>` — a `LabourAttendance` row carrying the reserved marker — have the
 * GENUINE repair evidence its marker claims?
 *
 * Exported because two callers must ask the identical question. The diagnostic asks it to decide
 * whether a marked row is a finding; `T3CRepairService` asks it to decide whether a quarantine is
 * refused. When those two diverge the operator is trapped: the preflight reports a row the repair
 * declines to touch, and since the evidence is append-only and the attendance row is already
 * revoked, nothing can clear the finding and the deploy is blocked permanently. One predicate, one
 * answer.
 *
 * The evidence must be the RIGHT SHAPE, not merely present. Matching on metadata alone (row id, op,
 * repair id) accepts an appended action carrying `{}` as its before-image, which is exactly the
 * forgery this rule exists to catch: a writer who can insert into the evidence table could otherwise
 * mint provenance for any marker they like.
 *
 * Two before-image shapes are legitimate, told apart by the op that produced them:
 *
 *   f1-mark-invalid-legacy      the before-image is the BLANK pre-repair row — the state the repair
 *                               exists to retire — so the recorded original must itself be blank.
 *                               It may already have been revoked: a legacy muster whose blank reason
 *                               was revoked before correction 2 shipped is still a blank-reason row
 *                               the repair must be able to retire, and requiring an unrevoked
 *                               before-image here would make that row unrepairable.
 *   f1-quarantine-forged-marker the before-image is the FORGERY VERBATIM, so the recorded original
 *                               carries the marker. Nothing is pretended to be blank.
 *
 * `beforeImage->>'id'` must be the row itself: evidence about some other row proves nothing about
 * this one. And the attribution must actually say something — an evidence row whose operator or
 * reason is whitespace names nobody, and the append-only seal would make that emptiness permanent.
 *
 * The before-image must also be COMPLETE and CORRESPOND. A two-field `{"id": …, "manualReason": " "}`
 * satisfies every rule above while recording none of the observation it claims to preserve — so a
 * direct writer could mint an action of that shape, insert a pre-revoked marker citing its repair id,
 * and have both the preflight and the migration bless fabricated provenance. Every immutable
 * `LabourAttendance` column is therefore required to be PRESENT (`jsonb_exists`, so an explicit
 * `null` for a nullable column still counts and an absent key does not) and to EQUAL the marked row.
 *
 * Correspondence is meaningful precisely because `LabourAttendance_append_only` freezes these columns:
 * they cannot have drifted since the before-image was taken, so a mismatch means the evidence is not
 * about this row's actual history. `manualReason` is deliberately excluded from the equality check —
 * rewriting it is the one thing the repair does — but its SHAPE is checked per op, which is what
 * distinguishes a retirement's before-image from a quarantine's.
 *
 * EVERY comparison here is TOTAL: it returns true or false for any JSON value and can never raise.
 * That is a correctness requirement, not a style preference. A `::date` or `::timestamptz` cast of an
 * attacker-supplied string raises a conversion error instead of evaluating false, and this predicate
 * is used by BOTH the preflight and the quarantine — so a single `"civilDate": "not-a-date"` would
 * make the preflight exit with an opaque PostgreSQL error AND make the quarantine that is supposed to
 * file that very row fail the same way, leaving the deploy blocked with no exit at all. `civilDate` is
 * therefore compared as text against `to_char(…, 'YYYY-MM-DD')`, which is exactly how `row_to_json`
 * renders a DATE.
 *
 * `recordedAt` is checked for PRESENCE only, and deliberately not for value. `row_to_json` renders a
 * timestamptz using the session's own DateStyle/TimeZone, so a text comparison would be a false
 * negative whenever the capture and the check ran under different settings — and no cast of it can be
 * made total. Its value adds little: the row's identity is already pinned by eight exact string
 * comparisons including `id`, `sourceCommandId` and `recordedById`. Requiring the key to exist still
 * rejects the truncated before-image this rule exists to catch.
 */
export function t3cGenuineEvidenceSql(alias: string): string {
  /**
   * EVERY field the before-image claims to preserve must be THERE. `manualReason` is the only
   * exclusion from value-equality (rewriting it is what the repair does), and its shape is checked
   * per op below.
   *
   * The revocation triple is required as loudly as the immutable columns. Round 6 required only the
   * immutable set, so an action carrying those, a fabricated `recordedAt` and NO revocation history
   * authenticated a pre-revoked marker — and the marker's whole claim is that the original row,
   * including whatever revocation it already carried, survives in the evidence. Evidence that
   * preserves everything except the part under dispute preserves nothing.
   */
  const present = [
    'id', 'projectId', 'workerId', 'civilDate', 'shift', 'deviceId', 'evidenceMediaId',
    'recordedAt', 'recordedById', 'sourceCommandId', 'revokedAt', 'revokedById', 'revokeReason',
  ]
    .map((k) => `jsonb_exists(r."beforeImage", '${k}')`)
    .join(' AND ');
  return `EXISTS (
            SELECT 1 FROM "T3CRepairAction" r
             WHERE r."table" = 'LabourAttendance'
               AND r."rowId" = ${alias}."id"
               AND r."repairId" = substring(${alias}."manualReason" from '${T3C_MARKER_REPAIR_ID_REGEX}')
               AND btrim(r."operator", ${T3C_BLANK_TRIM_SET}) <> ''
               AND btrim(r."reason", ${T3C_BLANK_TRIM_SET}) <> ''
               AND ${present}
               AND r."beforeImage"->>'id'              = ${alias}."id"
               AND r."beforeImage"->>'projectId'       = ${alias}."projectId"
               AND r."beforeImage"->>'workerId'        = ${alias}."workerId"
               AND r."beforeImage"->>'civilDate'       = to_char(${alias}."civilDate", 'YYYY-MM-DD')
               AND r."beforeImage"->>'shift'           = ${alias}."shift"
               AND r."beforeImage"->>'deviceId'        IS NOT DISTINCT FROM ${alias}."deviceId"
               AND r."beforeImage"->>'evidenceMediaId' IS NOT DISTINCT FROM ${alias}."evidenceMediaId"
               AND r."beforeImage"->>'recordedById'    = ${alias}."recordedById"
               AND r."beforeImage"->>'sourceCommandId' = ${alias}."sourceCommandId"
               -- recordedAt by VALUE, not by presence. Both sides are rendered by the SAME
               -- canonical UTC to_char, so the comparison is pure text: it cannot raise on a
               -- forged string and cannot be defeated by a session timezone.
               AND r."beforeImage"->>'recordedAt'      = ${t3cRenderTs(`${alias}."recordedAt"`)}
               -- THE REVOCATION HISTORY IS PRESERVED, NEVER REWRITTEN. If the before-image records a
               -- revocation, the row must still carry exactly that one — this is the invariant both
               -- ops promise for an already-revoked row. If it records none, the row was live when
               -- the repair found it and the repair's own revocation is what is on it now, which the
               -- evidence detail attributes; there is nothing here to compare it against.
               AND (r."beforeImage"->>'revokedAt' IS NULL
                    OR (r."beforeImage"->>'revokedAt'    = ${t3cRenderTs(`${alias}."revokedAt"`)}
                    AND r."beforeImage"->>'revokedById'  IS NOT DISTINCT FROM ${alias}."revokedById"
                    AND r."beforeImage"->>'revokeReason' IS NOT DISTINCT FROM ${alias}."revokeReason"))
               AND (
                 (r."op" = 'f1-mark-invalid-legacy'
                   AND r."beforeImage"->>'manualReason' IS NOT NULL
                   AND btrim(r."beforeImage"->>'manualReason', ${T3C_BLANK_TRIM_SET}) = '')
                 OR
                 (r."op" = 'f1-quarantine-forged-marker'
                   AND r."beforeImage"->>'manualReason' LIKE '${T3C_INVALID_LEGACY_PREFIX}%')
               ))`;
}

/**
 * The two diagnostics, in report order. Predicates are duplicated between the count and sample
 * queries deliberately — this file is repair-critical and every predicate must be auditable against
 * migrations `20270220000000` / `20270225000000` on sight, so no clever abstraction hides what is
 * being counted.
 */
function diagsFor(haveEvidence: boolean): Diag[] {
  const marker = markerPredicate(haveEvidence);
  return [
    {
      code: 'F1.blank',
      description: 'LabourAttendance rows whose manualReason is blank (an unevidenced presence claim with nothing behind it)',
      count: `SELECT count(*)::bigint AS n FROM "LabourAttendance" WHERE ${BLANK_PREDICATE}`,
      sample: `SELECT "id", "projectId", "workerId", "civilDate", "shift", "recordedById", "recordedAt", "revokedAt" FROM "LabourAttendance" WHERE ${BLANK_PREDICATE} ORDER BY "projectId", "civilDate", "id" LIMIT ${SAMPLE_LIMIT}`,
    },
    {
      code: 'F1.marker',
      description:
        'LabourAttendance rows carrying the reserved invalid-legacy marker that are not a real audited repair — not revoked, or with no matching T3CRepairAction before-image for the repair id the marker embeds',
      count: `SELECT count(*)::bigint AS n FROM "LabourAttendance" a WHERE ${marker}`,
      // `exit` is what the operator acts on, and it is derived from the SAME predicate the finding
      // is, so the runbook never has to restate the rule in hand-written SQL. It used to, and the
      // two disagreed: a metadata-only query called a row with a malformed before-image "evidenced"
      // and sent the operator to revoke it, after which the finding was still there and the same
      // query gave the same unusable instruction. There is exactly one classifier now.
      sample: `SELECT a."id", a."projectId", a."workerId", a."civilDate", a."shift", a."recordedById", a."revokedAt",
                      CASE WHEN ${haveEvidence ? t3cGenuineEvidenceSql('a') : 'FALSE'}
                           THEN 'revoke-through-the-application'
                           ELSE 'quarantine' END AS "exit"
                 FROM "LabourAttendance" a WHERE ${marker} ORDER BY a."projectId", a."civilDate", a."id" LIMIT ${SAMPLE_LIMIT}`,
    },
  ];
}

/** All finding codes this correction diagnoses, for callers that want to enumerate them. */
export const T3C_FINDING_CODES: string[] = diagsFor(true).map((d) => d.code);

/**
 * EVERY finding row, unbounded, classified by the same predicates the findings use — the input to
 * `t3c plan`.
 *
 * The report's samples are bounded to {@link SAMPLE_LIMIT} deliberately (a diagnostic that prints a
 * million rows is not a report), but the REPAIR is all-or-nothing: it commits only when its
 * in-transaction re-diagnose reads clean. Bounded visibility plus an all-or-nothing repair was a
 * trap on any database with more than {@link SAMPLE_LIMIT} rows in one finding — the operator could
 * only name the visible twenty, the batch rolled back over the undisclosed rest, and the next
 * preflight showed the same twenty forever. The supported recovery could never unblock the deploy.
 *
 * So the FULL row set is exported here — ids and the derived exit only, never whole rows, so even a
 * large export stays proportionate — and the CLI turns it into a complete plan skeleton.
 */
export async function runT3CPlanRows(client: RawQueryClient): Promise<{
  /** Every `F1.blank` row id — each becomes an `f1-mark-invalid-legacy` action. */
  blanks: string[];
  /** Every `F1.marker` row with `exit: quarantine` — each becomes an `f1-quarantine-forged-marker` action. */
  quarantine: string[];
  /** Every `F1.marker` row with `exit: revoke-through-the-application` — NOT repairable by the
   *  engine; the operator revokes these through the API (see docs/RUNBOOK.md §P4T3C3). */
  manual: string[];
}> {
  const evidence = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('"T3CRepairAction"') IS NOT NULL AS present`,
  );
  const haveEvidence = evidence[0]?.present === true;
  const blanks = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "LabourAttendance" WHERE ${BLANK_PREDICATE} ORDER BY "projectId", "civilDate", "id"`,
  );
  const markers = await client.$queryRawUnsafe<Array<{ id: string; exit: string }>>(
    `SELECT a."id",
            CASE WHEN ${haveEvidence ? t3cGenuineEvidenceSql('a') : 'FALSE'}
                 THEN 'revoke-through-the-application'
                 ELSE 'quarantine' END AS "exit"
       FROM "LabourAttendance" a WHERE ${markerPredicate(haveEvidence)}
      ORDER BY a."projectId", a."civilDate", a."id"`,
  );
  return {
    blanks: blanks.map((r) => r.id),
    quarantine: markers.filter((r) => r.exit === 'quarantine').map((r) => r.id),
    manual: markers.filter((r) => r.exit === 'revoke-through-the-application').map((r) => r.id),
  };
}

/**
 * Every table the diagnostics READ. The preflight checks these exist before running any diagnostic,
 * so a fresh/empty or pre-Task-3 database reports "not applicable" instead of erroring on a missing
 * relation.
 */
export const T3C_REFERENCED_TABLES: readonly string[] = ['LabourAttendance'];

/** The `20270215000000` column the diagnostics need — its presence marks a repairable database. */
export const T3C_MARKER_COLUMN = { table: 'LabourAttendance', column: 'manualReason' } as const;

/**
 * Run every diagnostic READ-ONLY over `client` (a top-level Prisma client or a transaction). Returns
 * a per-finding count + bounded samples and a `clean` flag. Never writes; safe to run on production.
 */
export async function runT3CDiagnostics(client: RawQueryClient): Promise<T3CDiagnosticsReport> {
  // The evidence table is created BY the repair transaction, so its presence is what decides which
  // shape F1.marker takes. Asked before any diagnostic runs, over `to_regclass` so a database
  // without it never has the missing relation parsed into a query.
  const evidence = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('"T3CRepairAction"') IS NOT NULL AS present`,
  );
  const findings: T3CFindingReport[] = [];
  for (const d of diagsFor(evidence[0]?.present === true)) {
    const countRows = await client.$queryRawUnsafe<Array<{ n: bigint | number }>>(d.count);
    const count = Number(countRows[0]?.n ?? 0);
    let samples: Array<Record<string, unknown>> = [];
    if (count > 0) {
      const raw = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(d.sample);
      samples = raw.map(normalizeRow);
    }
    findings.push({ code: d.code, description: d.description, count, samples });
  }
  const nonZero = findings.filter((f) => f.count > 0);
  const total = nonZero.reduce((s, f) => s + f.count, 0);
  return { findings, total, clean: total === 0 };
}

/** BigInt/Date values are not JSON-serializable as-is — coerce for the report. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

/** Human-readable multi-line summary of the non-zero findings, for CLI output + throw messages. */
export function summarizeT3C(report: T3CDiagnosticsReport): string {
  const nonZero = report.findings.filter((f) => f.count > 0);
  if (nonZero.length === 0) return 'clean — every §C attendance invariant is satisfied.';
  return nonZero
    .map((f) => `  ${f.code}: ${f.count} — ${f.description}\n    samples: ${JSON.stringify(f.samples)}`)
    .join('\n');
}

/** The transaction client type the repair engine uses for the in-transaction re-diagnose. */
export type T3CTxClient = Prisma.TransactionClient;

// ══ SEAL SPECIFICATION ════════════════════════════════════════════════════════════════════════
// What it MEANS for one of this correction's physical objects to be installed. `migrate.sh` decides
// whether to execute `20270225000000` or resolve it as applied from this answer, so a predicate that
// is satisfied by an object which does not actually enforce anything is not a weak test — it is a
// permanent, silent hole: Prisma records the correction installed and it is never run again.

/**
 * `pg_trigger.tgtype` bits (`src/include/catalog/pg_trigger.h`). A trigger's NAME, its ENABLED flag
 * and its bound FUNCTION together still say nothing about WHEN it fires: an enabled
 * `LabourAttendance_reserved_marker` declared `BEFORE UPDATE` and bound to the correct function
 * satisfies all three while every INSERT sails past it. The events are part of the seal.
 */
export const T3C_TGTYPE = {
  ROW: 1,
  BEFORE: 2,
  INSERT: 4,
  DELETE: 8,
  UPDATE: 16,
  TRUNCATE: 32,
} as const;

export interface T3CTriggerSeal {
  name: string;
  table: string;
  /** The function that actually enforces the rule — a same-named trigger on anything else is a decoy. */
  fn: string;
  /**
   * The EXACT `pg_trigger.tgtype` the deployed DDL produces — equality, not a bitmask. A
   * require-these-bits test called extra events harmless, and they are not: a
   * `T3CRepairAction_append_only` declared `BEFORE INSERT OR UPDATE OR DELETE` (tgtype 31) carries
   * every required bit and is bound to a function that raises UNCONDITIONALLY — so the seal
   * reported valid while every legitimate evidence INSERT was rejected, leaving diagnosed rows
   * with no usable repair path. Each trigger's DDL is fixed in a deployed migration (or in this
   * correction), so its exact tgtype is known; anything else — missing events OR extra ones — is
   * not that trigger.
   */
  tgtype: number;
  what: string;
}

const { ROW, BEFORE, INSERT, DELETE, UPDATE, TRUNCATE } = T3C_TGTYPE;

/** `BEFORE INSERT … FOR EACH ROW` */
const TG_ROW_BEFORE_INSERT = ROW | BEFORE | INSERT; // 7
/** `BEFORE UPDATE OR DELETE … FOR EACH ROW` */
const TG_ROW_BEFORE_UPDATE_DELETE = ROW | BEFORE | UPDATE | DELETE; // 27
/** `BEFORE TRUNCATE … FOR EACH STATEMENT` */
const TG_STMT_BEFORE_TRUNCATE = BEFORE | TRUNCATE; // 34

/** The two triggers `20270225000000` itself installs, on tables that always exist by then. */
export const T3C_CORRECTION3_TRIGGER_SEALS: readonly T3CTriggerSeal[] = [
  {
    name: 'LabourAttendance_reserved_marker',
    table: 'LabourAttendance',
    fn: 'phase4_t3c3_attendance_reserved_marker',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'the reserved invalid-legacy marker is unwritable by an ordinary INSERT',
  },
  {
    name: 'WorkerAllocation_00_project_lock',
    table: 'WorkerAllocation',
    fn: 'phase4_t3c3_allocation_project_lock',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'a raw allocation batch takes the project readiness lock before any row lock',
  },
];

/**
 * The §C triggers `20270210000000` and `20270215000000` install — the PREREQUISITES this correction
 * builds on. Every one is raw SQL, so `prisma db push` (which reproduces only what `schema.prisma`
 * models) creates none of them while creating all the tables.
 *
 * That combination is exactly the P3005 shape, and it is why these belong in the baseline answer.
 * Resolving those migrations as applied over a `db push` database records them installed forever
 * while `WorkerAllocation_head_live` — the guard that refuses an allocation against a CANCELLED
 * requirement, under the root lock — simply does not exist. Correction 3 `CREATE OR REPLACE`s that
 * trigger's FUNCTION (to add the project lock) but never creates the TRIGGER, so nothing downstream
 * would ever notice. Unlike correction 3, these migrations are NOT re-runnable over a populated
 * schema (they `CREATE TABLE`), so the answer when they are missing is to refuse to baseline, not to
 * leave them pending.
 *
 * They are also what {@link T3CRepairService.repair} verifies before committing: the repair disables
 * `LabourAttendance_append_only` and puts it back, and "put it back" has to mean the trigger that
 * actually freezes the row, not merely something wearing its name.
 */
export const T3C_PREREQUISITE_TRIGGER_SEALS: readonly T3CTriggerSeal[] = [
  {
    name: 'LabourAttendance_append_only',
    table: 'LabourAttendance',
    fn: 'phase4_t3_attendance_append_only',
    tgtype: TG_ROW_BEFORE_UPDATE_DELETE,
    what: 'a recorded muster is never edited or deleted',
  },
  {
    name: 'WorkerAllocation_frozen',
    table: 'WorkerAllocation',
    fn: 'phase4_t3_allocation_frozen',
    tgtype: TG_ROW_BEFORE_UPDATE_DELETE,
    what: 'an allocation is a frozen identity',
  },
  {
    name: 'LabourWorkFact_append_only',
    table: 'LabourWorkFact',
    fn: 'phase3_immutable_row',
    tgtype: TG_ROW_BEFORE_UPDATE_DELETE,
    what: 'a recorded work fact is immutable',
  },
  {
    name: 'ApprovedSkillSubstitution_append_only',
    table: 'ApprovedSkillSubstitution',
    fn: 'phase4_t3_skill_substitution_append_only',
    tgtype: TG_ROW_BEFORE_UPDATE_DELETE,
    what: 'a skill substitution is revoked by stamp, never rewritten',
  },
  {
    name: 'LabourWorkFact_matches_allocation',
    table: 'LabourWorkFact',
    fn: 'phase4_t3_work_matches_allocation',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'effort is recorded only against a real allocation',
  },
  {
    name: 'WorkerAllocation_worker_active',
    table: 'WorkerAllocation',
    fn: 'phase4_t3_allocation_worker_active',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'only an active worker can be allocated',
  },
  {
    name: 'LabourAttendance_device_bound',
    table: 'LabourAttendance',
    fn: 'phase4_t3_attendance_device_bound',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'a cited device is bound to that same worker',
  },
  {
    name: 'WorkerAllocation_within_commitment',
    table: 'WorkerAllocation',
    fn: 'phase4_t3_allocation_within_commitment',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: '§F bound 3 — allocated never exceeds committed, under the commitment row lock',
  },
  {
    name: 'WorkerAllocation_head_live',
    table: 'WorkerAllocation',
    fn: 'phase4_t3c_allocation_head_live',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'dead demand cannot be allocated against, under the requirement-root lock',
  },
];

/**
 * The evidence table's seals. `T3CRepairAction` is created by the REPAIR, never by a migration, so
 * these are CONDITIONAL: on a database where no repair has ever run there is nothing to seal, and on
 * one where a repair ran before these seals existed they are installed at deploy time.
 *
 * They belong in the baseline answer all the same. A pre-baseline (P3005) database that carries
 * `T3CRepairAction` with a disabled — or UPDATE-only, or decoy-bound — append-only trigger would
 * otherwise be resolved as "correction 3 applied" while the before-images every marked attendance
 * row points at stay freely updateable, deletable or truncatable. The trusted record would be the
 * one thing in this correction nobody had checked.
 */
export const T3C_EVIDENCE_TRIGGER_SEALS: readonly T3CTriggerSeal[] = [
  {
    name: 'T3CRepairAction_append_only',
    table: 'T3CRepairAction',
    fn: 'phase4_t3c_repair_action_append_only',
    tgtype: TG_ROW_BEFORE_UPDATE_DELETE,
    what: 'repair evidence is never updated or deleted',
  },
  {
    name: 'T3CRepairAction_no_truncate',
    table: 'T3CRepairAction',
    fn: 'phase4_t3c_repair_action_no_truncate',
    tgtype: TG_STMT_BEFORE_TRUNCATE,
    what: 'repair evidence is never truncated',
  },
  {
    name: 'T3CRepairAction_repair_path_only',
    table: 'T3CRepairAction',
    fn: 'phase4_t3c_repair_action_path',
    tgtype: TG_ROW_BEFORE_INSERT,
    what: 'repair evidence can only be written by the controlled repair path',
  },
];

/**
 * Is one trigger seal really installed? Parameters: `$1` name, `$2` quoted relation, `$3` function,
 * `$4` the EXACT tgtype. Returns a single `{ n }` — `1` when sealed. Equality, not a bitmask: see
 * {@link T3CTriggerSeal.tgtype}.
 */
export const T3C_TRIGGER_SEAL_SQL = `SELECT count(*)::int AS n FROM pg_trigger t
   WHERE t.tgname = $1
     AND NOT t.tgisinternal
     AND t.tgrelid = to_regclass($2)
     AND t.tgenabled = 'O'
     AND t.tgfoid::regproc::text = $3
     AND t.tgtype = $4::int`;

/**
 * The transaction-local GUC the repair sets to its own repair id. The
 * `T3CRepairAction_repair_path_only` trigger requires `NEW."repairId"` to equal it, so evidence
 * cannot be written by an ordinary INSERT — a maintenance script, an ORM, a psql session, a restore
 * tool or a forger shaping a row to look like a repair.
 *
 * STATED HONESTLY, because the alternative is a security claim this cannot back: an actor with
 * direct write access to this database can read this source, call `set_config` and insert whatever
 * they like — and an actor who can disable triggers needs even less. Nothing enforced INSIDE a
 * database is unforgeable to someone who owns it. What this buys is that shaping a row correctly is
 * no longer enough: writing evidence now requires deliberately impersonating the repair protocol,
 * every ordinary path is refused, and the diagnostic stops accepting mere correspondence from any
 * writer who never went through it.
 *
 * RESIDUAL, equally plainly: rows written BEFORE this seal existed cannot be distinguished from
 * genuine ones by the database, because nothing recorded how they arrived. That is exactly what the
 * `f1-quarantine-forged-marker` exit is for, and why the `F1.marker` sample carries its `exit`
 * column — an operator who determines a legacy marker is not backed by a real repair quarantines it.
 */
export const T3C_REPAIR_GUC = 'phase4.t3c_repair_id';

// ══ CHECK / UNIQUE / FK SEALS — verified by CANONICAL-EXPRESSION IDENTITY ═════════════════════
// A CHECK constraint used to be verified by evaluating its expression over a finite truth table.
// That is stronger than reading its text, but a finite table still accepts weaker same-named
// constraints: the intended marker expression with an appended `OR "manualReason" LIKE '%permit'`
// passes all four probes while admitting a live reserved marker ending in `permit` — and the seals
// answer then baselines correction 3 as applied without the real guard. No finite row set can
// establish Boolean semantics over an infinite string domain.
//
// So a constraint is now accepted only when it IS the canonical constraint: its stored parse tree,
// rendered by `pg_get_expr`, must equal the deparse of the exact expression the owning migration
// writes, obtained by creating that expression on a session-local TEMP probe table cloned from the
// real table's columns (`CREATE TEMP TABLE … (LIKE …)`) in the same database, so both sides render
// under identical rules. String equality is total — it cannot raise on a hostile expression and it
// cannot be satisfied by anything but the same parse tree. Stated honestly: this is IDENTITY, not
// semantic equivalence — a differently-written but logically equivalent constraint is refused too.
// That is the intended trade: the seal accepts exactly the constraint our migrations write, and
// anything else is a finding for a human, not something to bless by approximation.

export interface T3CCheckSeal {
  name: string;
  table: string;
  /** The constraint expression EXACTLY as the owning migration writes it (auditable on sight). */
  canonicalExpr: string;
  /** Whether `convalidated` is required — the attribution CHECK may legitimately be NOT VALID. */
  requireValidated: boolean;
  what: string;
}

/** `20270225000000`'s own CHECK — a marked row can never be live. VALIDATED required. */
export const T3C_MARKER_CHECK_SEAL: T3CCheckSeal = {
  name: 'LabourAttendance_marker_is_revoked',
  table: 'LabourAttendance',
  canonicalExpr: `"manualReason" IS NULL
      OR "manualReason" NOT LIKE '${T3C_INVALID_LEGACY_PREFIX}%'
      OR "revokedAt" IS NOT NULL`,
  requireValidated: true,
  what: 'a row wearing the reserved invalid-legacy marker is always revoked',
};

/** The evidence attribution rule — may be NOT VALID over legacy blank-attributed rows. */
export const T3C_ATTRIBUTION_CHECK_SEAL: T3CCheckSeal = {
  name: 'T3CRepairAction_attribution_non_blank',
  table: 'T3CRepairAction',
  canonicalExpr: `btrim("operator", ${T3C_BLANK_TRIM_SET}) <> '' AND btrim("reason", ${T3C_BLANK_TRIM_SET}) <> ''`,
  requireValidated: false,
  what: 'repair evidence names a real operator and states a reason',
};

/**
 * `20270220000000`'s CHECK — its OWN pending layer, not a refuse-to-baseline prerequisite. That
 * migration is a re-runnable diagnostic-first `ALTER TABLE ADD CONSTRAINT`, so on a pre-baseline
 * database where this constraint is absent the honest answer is the same as for correction 3:
 * leave `20270220000000` PENDING and let `migrate deploy` really execute it. Resolving it as
 * applied while the constraint does not exist records an enforcement that is not there — and a raw
 * write could then store a blank `manualReason` forever on a database Prisma swears is corrected.
 */
export const T3C_CORRECTION2_CHECK_SEAL: T3CCheckSeal = {
  name: 'LabourAttendance_manual_reason_non_blank',
  table: 'LabourAttendance',
  canonicalExpr: `"manualReason" IS NULL OR btrim("manualReason", ${T3C_BLANK_TRIM_SET}) <> ''`,
  requireValidated: true,
  what: 'a manual muster states a reason — blank presence claims are unrepresentable',
};

/**
 * The raw-SQL CHECK constraints `20270210000000`/`20270215000000` install. `prisma db push`
 * reproduces NONE of them (Prisma cannot model a CHECK), so a database restored or pushed into the
 * P3005 shape can carry every §C TABLE — and even every §C trigger, if someone replayed those — while
 * a raw update can still set `revokedAt` with a NULL `revokedById`, creating a permanently
 * unattributed correction. The triggers alone were never the whole prerequisite set; these are the
 * rest of it, and like the triggers they refuse the baseline when absent (those migrations
 * `CREATE TABLE` and cannot be left pending).
 */
export const T3C_PREREQUISITE_CHECK_SEALS: readonly T3CCheckSeal[] = [
  {
    name: 'WorkerAllocation_status_check',
    table: 'WorkerAllocation',
    canonicalExpr: `"status" IN ('active','released')`,
    requireValidated: true,
    what: 'an allocation status is one of the two modelled states',
  },
  {
    name: 'WorkerAllocation_shift_check',
    table: 'WorkerAllocation',
    canonicalExpr: `"shift" IN ('day','night')`,
    requireValidated: true,
    what: 'an allocation shift is day or night',
  },
  {
    name: 'WorkerAllocation_revision_check',
    table: 'WorkerAllocation',
    canonicalExpr: `"originRevision" >= 1`,
    requireValidated: true,
    what: 'an allocation pins a real requirement revision',
  },
  {
    name: 'WorkerAllocation_release_attribution_check',
    table: 'WorkerAllocation',
    canonicalExpr: `("status" = 'active'   AND "releasedAt" IS NULL AND "releasedById" IS NULL)
 OR ("status" = 'released' AND "releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL)`,
    requireValidated: true,
    what: 'a released allocation is fully attributed; an active one carries no release stamp',
  },
  {
    name: 'LabourAttendance_shift_check',
    table: 'LabourAttendance',
    canonicalExpr: `"shift" IN ('day','night')`,
    requireValidated: true,
    what: 'a muster shift is day or night',
  },
  {
    name: 'LabourAttendance_revoke_attribution_check',
    table: 'LabourAttendance',
    canonicalExpr: `("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
 OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL)`,
    requireValidated: true,
    what: 'a revocation is fully attributed with its reason — an unattributed correction is unrepresentable',
  },
  {
    name: 'LabourAttendance_trusted_evidence',
    table: 'LabourAttendance',
    canonicalExpr: `"deviceId" IS NOT NULL OR "manualReason" IS NOT NULL`,
    requireValidated: true,
    what: 'presence is device-evidenced or an explicit attributable exception — never a bare claim',
  },
  {
    name: 'LabourAttendance_one_evidence_path',
    table: 'LabourAttendance',
    canonicalExpr: `NOT ("deviceId" IS NOT NULL AND "manualReason" IS NOT NULL)`,
    requireValidated: true,
    what: 'a muster is one evidence path or the other, never both',
  },
  {
    name: 'LabourWorkFact_shift_check',
    table: 'LabourWorkFact',
    canonicalExpr: `"shift" IN ('day','night')`,
    requireValidated: true,
    what: 'a work fact shift is day or night',
  },
  {
    name: 'LabourWorkFact_minutes_check',
    table: 'LabourWorkFact',
    canonicalExpr: `"workedMinutes" > 0 AND "workedMinutes" <= 720`,
    requireValidated: true,
    what: 'worked minutes are positive and bounded by one 12h shift',
  },
  {
    name: 'ApprovedSkillSubstitution_distinct_check',
    table: 'ApprovedSkillSubstitution',
    canonicalExpr: `"fromFingerprint" <> "toFingerprint"`,
    requireValidated: true,
    what: 'a substitution maps between two DIFFERENT spec fingerprints',
  },
  {
    name: 'ApprovedSkillSubstitution_revoke_attribution_check',
    table: 'ApprovedSkillSubstitution',
    canonicalExpr: `("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
 OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL)`,
    requireValidated: true,
    what: 'a substitution revocation is fully attributed with its reason',
  },
];

export interface T3CUniqueIndexSeal {
  name: string;
  table: string;
  /** Plain column names, in index order (none of these six uses an expression column). */
  columns: readonly string[];
  /** Partial-index predicate EXACTLY as the migration writes it; `null` = not partial. */
  canonicalPredicate: string | null;
  what: string;
}

/**
 * The raw-SQL UNIQUE indexes those migrations install that `schema.prisma` cannot model — the three
 * partial "live/active" conservation keys and the three widened candidate keys the composite FKs
 * below reference. `prisma db push` creates none of them: without
 * `WorkerAllocation_live_slice_key` two ACTIVE allocations of the same worker-shift coexist, which
 * is the §C conservation invariant itself.
 */
export const T3C_PREREQUISITE_UNIQUE_SEALS: readonly T3CUniqueIndexSeal[] = [
  {
    name: 'WorkerAllocation_live_slice_key',
    table: 'WorkerAllocation',
    columns: ['projectId', 'workerId', 'civilDate', 'shift'],
    canonicalPredicate: `"status" = 'active'`,
    what: 'one ACTIVE allocation per (project, worker, civilDate, shift) — worker-level conservation',
  },
  {
    name: 'LabourAttendance_live_slice_key',
    table: 'LabourAttendance',
    columns: ['projectId', 'workerId', 'civilDate', 'shift'],
    canonicalPredicate: `"revokedAt" IS NULL`,
    what: 'one LIVE attendance per (project, worker, civilDate, shift)',
  },
  {
    name: 'ApprovedSkillSubstitution_active_key',
    table: 'ApprovedSkillSubstitution',
    columns: ['projectId', 'requirementId', 'fromFingerprint', 'toFingerprint'],
    canonicalPredicate: `"revokedAt" IS NULL`,
    what: 'one ACTIVE substitution per (requirement, from, to)',
  },
  {
    name: 'LabourRequirementSpec_allocation_identity_key',
    table: 'LabourRequirementSpec',
    columns: ['projectId', 'requirementId', 'revision', 'labourSpecFingerprint'],
    canonicalPredicate: null,
    what: "the candidate key WorkerAllocation_spec_fkey references — the spec's whole frozen identity",
  },
  {
    name: 'CapacityCommitment_slice_identity_key',
    table: 'CapacityCommitment',
    columns: ['projectId', 'id', 'labourSpecFingerprint', 'civilDate', 'shift'],
    canonicalPredicate: null,
    what: 'the candidate key WorkerAllocation_commitment_fkey references — §F bound 3 per slice',
  },
  {
    name: 'ActivityRequirement_demand_identity_key',
    table: 'ActivityRequirement',
    columns: ['projectId', 'requirementId', 'revision', 'activityId'],
    canonicalPredicate: null,
    what: 'the candidate key WorkerAllocation_demand_identity_fkey references — requirement↔activity as ONE key',
  },
];

export interface T3CForeignKeySeal {
  name: string;
  table: string;
  columns: readonly string[];
  refTable: string;
  refColumns: readonly string[];
  what: string;
}

/**
 * The raw-SQL composite FKs those migrations install whose SEMANTICS `prisma db push` does not
 * reproduce — verified against the catalogs by (table, columns) → (refTable, refColumns), never by
 * name alone. Most §C FKs ARE Prisma-modelled and survive a push under Prisma's own names; these
 * ten are the ones that do not, because they reference the raw-SQL candidate keys above or bind
 * more columns than the modelled relation (`WorkerAllocation_commitment_fkey` binds the
 * commitment's own (fingerprint, civilDate, shift) slice; a push leaves only the two-column id
 * reference, and capacity committed for one slice becomes drawable for another).
 */
export const T3C_PREREQUISITE_FK_SEALS: readonly T3CForeignKeySeal[] = [
  {
    name: 'WorkerAllocation_activity_fkey',
    table: 'WorkerAllocation',
    columns: ['projectId', 'activityId'],
    refTable: 'Activity',
    refColumns: ['projectId', 'id'],
    what: 'an allocation targets a same-project activity',
  },
  {
    name: 'WorkerAllocation_spec_fkey',
    table: 'WorkerAllocation',
    columns: ['projectId', 'requirementId', 'originRevision', 'labourSpecFingerprint'],
    refTable: 'LabourRequirementSpec',
    refColumns: ['projectId', 'requirementId', 'revision', 'labourSpecFingerprint'],
    what: "an allocation pins the spec's WHOLE frozen identity, fingerprint included",
  },
  {
    name: 'WorkerAllocation_crew_fkey',
    table: 'WorkerAllocation',
    columns: ['projectId', 'crewId'],
    refTable: 'Crew',
    refColumns: ['projectId', 'id'],
    what: 'a crew-expanded allocation names a same-project crew',
  },
  {
    name: 'WorkerAllocation_commitment_fkey',
    table: 'WorkerAllocation',
    columns: ['projectId', 'capacityCommitmentId', 'labourSpecFingerprint', 'civilDate', 'shift'],
    refTable: 'CapacityCommitment',
    refColumns: ['projectId', 'id', 'labourSpecFingerprint', 'civilDate', 'shift'],
    what: "§F bound 3 — a drawdown binds to the commitment's OWN slice, never just its id",
  },
  {
    name: 'WorkerAllocation_command_fkey',
    table: 'WorkerAllocation',
    columns: ['projectId', 'sourceCommandId'],
    refTable: 'CommandExecution',
    refColumns: ['projectId', 'id'],
    what: 'every allocation records its source command (§C rule ii)',
  },
  {
    name: 'WorkerAllocation_demand_identity_fkey',
    table: 'WorkerAllocation',
    columns: ['projectId', 'requirementId', 'originRevision', 'activityId'],
    refTable: 'ActivityRequirement',
    refColumns: ['projectId', 'requirementId', 'revision', 'activityId'],
    what: 'requirement and owning activity are referenced as ONE key — a mismatched pair is unrepresentable',
  },
  {
    name: 'LabourAttendance_command_fkey',
    table: 'LabourAttendance',
    columns: ['projectId', 'sourceCommandId'],
    refTable: 'CommandExecution',
    refColumns: ['projectId', 'id'],
    what: 'every muster records its source command',
  },
  {
    name: 'LabourWorkFact_activity_fkey',
    table: 'LabourWorkFact',
    columns: ['projectId', 'activityId'],
    refTable: 'Activity',
    refColumns: ['projectId', 'id'],
    what: 'effort is recorded against a same-project activity',
  },
  {
    name: 'LabourWorkFact_command_fkey',
    table: 'LabourWorkFact',
    columns: ['projectId', 'sourceCommandId'],
    refTable: 'CommandExecution',
    refColumns: ['projectId', 'id'],
    what: 'every work fact records its source command',
  },
  {
    name: 'ApprovedSkillSubstitution_command_fkey',
    table: 'ApprovedSkillSubstitution',
    columns: ['projectId', 'sourceCommandId'],
    refTable: 'CommandExecution',
    refColumns: ['projectId', 'id'],
    what: 'every substitution records its source command',
  },
];

/** The session-local probe table for one real table (created `LIKE` it, so column types match). */
export function t3cProbeTableName(table: string): string {
  return `t3c_seal_probe_${table.toLowerCase()}`;
}

/** DDL for the probe table. TEMP + ON COMMIT DROP: session-local, gone at transaction end, and it
 *  never touches a real relation — the seals check stays read-only with respect to real data. */
export function t3cProbeTableSql(table: string): string {
  return `CREATE TEMP TABLE IF NOT EXISTS "${t3cProbeTableName(table)}" (LIKE "${table}") ON COMMIT DROP`;
}

/** DDL adding one canonical CHECK to the probe table, under a probe-scoped name. */
export function t3cProbeCheckSql(seal: T3CCheckSeal): string {
  return `ALTER TABLE "${t3cProbeTableName(seal.table)}" ADD CONSTRAINT "probe_${seal.name}" CHECK (${seal.canonicalExpr})`;
}

/**
 * One row `{ canonical, actual }` — the deparse of the canonical probe constraint next to the
 * deparse of the real one (NULL when absent / not a CHECK / not validated where required). Sealed
 * ⇔ both non-NULL and equal. Both renderings come from the SAME `pg_get_expr` in the SAME database,
 * so the comparison is exact.
 */
export function t3cCheckIdentitySql(seal: T3CCheckSeal): string {
  return `SELECT
      (SELECT pg_get_expr(conbin, conrelid) FROM pg_constraint
        WHERE conname = 'probe_${seal.name}'
          AND conrelid = to_regclass('pg_temp."${t3cProbeTableName(seal.table)}"')) AS canonical,
      (SELECT pg_get_expr(c.conbin, c.conrelid) FROM pg_constraint c
        WHERE c.conname = '${seal.name}'
          AND c.conrelid = to_regclass('"${seal.table}"')
          AND c.contype = 'c'
          AND (${seal.requireValidated ? 'c.convalidated' : 'TRUE'})) AS actual`;
}

/** DDL adding the canonical (possibly partial) unique probe index for one unique seal. */
export function t3cProbeUniqueSql(seal: T3CUniqueIndexSeal): string {
  const cols = seal.columns.map((c) => `"${c}"`).join(', ');
  const where = seal.canonicalPredicate ? ` WHERE ${seal.canonicalPredicate}` : '';
  return `CREATE UNIQUE INDEX "probe_${seal.name}" ON "${t3cProbeTableName(seal.table)}"(${cols})${where}`;
}

/**
 * One row `{ ok }` for a unique-index seal: the real index must exist ON the real table, be UNIQUE,
 * cover exactly the pinned columns in order, and carry a predicate whose deparse equals the probe
 * index's (both NULL for a non-partial key).
 */
export function t3cUniqueIdentitySql(seal: T3CUniqueIndexSeal): string {
  const colsArray = `ARRAY[${seal.columns.map((c) => `'${c}'`).join(', ')}]::name[]`;
  return `SELECT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = to_regclass('"${seal.name}"')
         AND i.indrelid = to_regclass('"${seal.table}"')
         AND i.indisunique
         AND (SELECT array_agg(a.attname ORDER BY k.ord)
                FROM unnest(i.indkey::int[]) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ${colsArray}
         AND pg_get_expr(i.indpred, i.indrelid) IS NOT DISTINCT FROM
             (SELECT pg_get_expr(p.indpred, p.indrelid) FROM pg_index p
               WHERE p.indexrelid = to_regclass('pg_temp."probe_${seal.name}"'))
    ) AS ok`;
}

/** One row `{ ok }` for a composite-FK seal — table, ordered columns, referenced table and ordered
 *  referenced columns, validated. Catalog-only; no probe needed. */
export function t3cForeignKeyIdentitySql(seal: T3CForeignKeySeal): string {
  const cols = `ARRAY[${seal.columns.map((c) => `'${c}'`).join(', ')}]::name[]`;
  const refCols = `ARRAY[${seal.refColumns.map((c) => `'${c}'`).join(', ')}]::name[]`;
  return `SELECT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = '${seal.name}'
         AND c.contype = 'f'
         AND c.convalidated
         AND c.conrelid = to_regclass('"${seal.table}"')
         AND c.confrelid = to_regclass('"${seal.refTable}"')
         AND (SELECT array_agg(a.attname ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ${cols}
         AND (SELECT array_agg(a.attname ORDER BY k.ord)
                FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) = ${refCols}
    ) AS ok`;
}
