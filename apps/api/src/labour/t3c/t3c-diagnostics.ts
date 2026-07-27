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
 * The ONE canonical rendering of a `timestamptz` for before-image comparison — explicit UTC, fixed
 * format, so the comparison is pure TEXT on both sides.
 *
 * This exists because the obvious alternatives both fail. Comparing PostgreSQL's own JSON rendering
 * compares two session-dependent strings for the same instant. Casting the stored text back to
 * `timestamptz` RAISES on anything malformed — and the stored text is attacker-supplied, so a cast
 * turns a forged before-image into an opaque aborted deploy instead of a diagnosed finding, breaking
 * the quarantine that uses this same predicate. Rendering both sides identically is total: it cannot
 * raise, and it cannot be defeated by a timezone.
 *
 * NULL renders as NULL (never the string "null"), so `IS NOT DISTINCT FROM` compares an absent
 * revocation correctly. Duplicated verbatim in `20270225000000`'s SQL — a migration must be
 * auditable on sight without importing TypeScript.
 */
export function t3cRenderTs(expr: string): string {
  return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
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
  /** Every bit that MUST be set. Extra events are harmless; a missing one is the hole. */
  requireBits: number;
  /** Every bit that must NOT be set (a TRUNCATE trigger is STATEMENT-level, never `FOR EACH ROW`). */
  forbidBits: number;
  what: string;
}

const { ROW, BEFORE, INSERT, DELETE, UPDATE, TRUNCATE } = T3C_TGTYPE;

/** The two triggers `20270225000000` itself installs, on tables that always exist by then. */
export const T3C_CORRECTION3_TRIGGER_SEALS: readonly T3CTriggerSeal[] = [
  {
    name: 'LabourAttendance_reserved_marker',
    table: 'LabourAttendance',
    fn: 'phase4_t3c3_attendance_reserved_marker',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
    what: 'the reserved invalid-legacy marker is unwritable by an ordinary INSERT',
  },
  {
    name: 'WorkerAllocation_00_project_lock',
    table: 'WorkerAllocation',
    fn: 'phase4_t3c3_allocation_project_lock',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
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
    requireBits: ROW | BEFORE | UPDATE | DELETE,
    forbidBits: 0,
    what: 'a recorded muster is never edited or deleted',
  },
  {
    name: 'WorkerAllocation_frozen',
    table: 'WorkerAllocation',
    fn: 'phase4_t3_allocation_frozen',
    requireBits: ROW | BEFORE | UPDATE | DELETE,
    forbidBits: 0,
    what: 'an allocation is a frozen identity',
  },
  {
    name: 'LabourWorkFact_append_only',
    table: 'LabourWorkFact',
    fn: 'phase3_immutable_row',
    requireBits: ROW | BEFORE | UPDATE | DELETE,
    forbidBits: 0,
    what: 'a recorded work fact is immutable',
  },
  {
    name: 'ApprovedSkillSubstitution_append_only',
    table: 'ApprovedSkillSubstitution',
    fn: 'phase4_t3_skill_substitution_append_only',
    requireBits: ROW | BEFORE | UPDATE | DELETE,
    forbidBits: 0,
    what: 'a skill substitution is revoked by stamp, never rewritten',
  },
  {
    name: 'LabourWorkFact_matches_allocation',
    table: 'LabourWorkFact',
    fn: 'phase4_t3_work_matches_allocation',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
    what: 'effort is recorded only against a real allocation',
  },
  {
    name: 'WorkerAllocation_worker_active',
    table: 'WorkerAllocation',
    fn: 'phase4_t3_allocation_worker_active',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
    what: 'only an active worker can be allocated',
  },
  {
    name: 'LabourAttendance_device_bound',
    table: 'LabourAttendance',
    fn: 'phase4_t3_attendance_device_bound',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
    what: 'a cited device is bound to that same worker',
  },
  {
    name: 'WorkerAllocation_within_commitment',
    table: 'WorkerAllocation',
    fn: 'phase4_t3_allocation_within_commitment',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
    what: '§F bound 3 — allocated never exceeds committed, under the commitment row lock',
  },
  {
    name: 'WorkerAllocation_head_live',
    table: 'WorkerAllocation',
    fn: 'phase4_t3c_allocation_head_live',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
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
    requireBits: ROW | BEFORE | UPDATE | DELETE,
    forbidBits: 0,
    what: 'repair evidence is never updated or deleted',
  },
  {
    name: 'T3CRepairAction_no_truncate',
    table: 'T3CRepairAction',
    fn: 'phase4_t3c_repair_action_no_truncate',
    requireBits: BEFORE | TRUNCATE,
    forbidBits: ROW,
    what: 'repair evidence is never truncated',
  },
  {
    name: 'T3CRepairAction_repair_path_only',
    table: 'T3CRepairAction',
    fn: 'phase4_t3c_repair_action_path',
    requireBits: ROW | BEFORE | INSERT,
    forbidBits: 0,
    what: 'repair evidence can only be written by the controlled repair path',
  },
];

/**
 * Is one trigger seal really installed? Parameters: `$1` name, `$2` quoted relation, `$3` function,
 * `$4` required bits, `$5` forbidden bits. Returns a single `{ n }` — `1` when sealed.
 */
export const T3C_TRIGGER_SEAL_SQL = `SELECT count(*)::int AS n FROM pg_trigger t
   WHERE t.tgname = $1
     AND NOT t.tgisinternal
     AND t.tgrelid = to_regclass($2)
     AND t.tgenabled = 'O'
     AND t.tgfoid::regproc::text = $3
     AND (t.tgtype & $4::int) = $4::int
     AND (t.tgtype & $5::int) = 0`;

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

/**
 * The marker CHECK's TRUTH TABLE — what `LabourAttendance_marker_is_revoked` must actually DECIDE.
 *
 * Accepting the constraint because its definition text mentions the prefix and `revokedAt` tests
 * spelling, not meaning: `CHECK ("manualReason" LIKE '[invalid-legacy:blank-manual-reason]%' OR
 * "revokedAt" IS NULL)` contains both tokens, is a validated check constraint, and permits every
 * live marked row — the precise state the seal exists to forbid. So the constraint's own expression
 * is EVALUATED over these four rows instead, which is a claim about behaviour rather than syntax.
 */
export const T3C_MARKER_CHECK_PROBES: ReadonlyArray<{
  manualReason: string | null;
  revoked: boolean;
  /** `false` ⇒ the CHECK must REJECT this row. */
  mustPass: boolean;
  what: string;
}> = [
  {
    manualReason: `${T3C_INVALID_LEGACY_PREFIX} repair=00000000-0000-0000-0000-000000000000`,
    revoked: false,
    mustPass: false,
    what: 'a LIVE row wearing the reserved marker is the forgery this CHECK exists to forbid',
  },
  {
    manualReason: `${T3C_INVALID_LEGACY_PREFIX} repair=00000000-0000-0000-0000-000000000000`,
    revoked: true,
    mustPass: true,
    what: 'a revoked marked row is exactly what the sanctioned repair leaves behind',
  },
  {
    manualReason: null,
    revoked: false,
    mustPass: true,
    what: 'a device-evidenced muster carries no manual reason and is untouched',
  },
  {
    manualReason: 'dead battery on the site tablet — muster taken on paper',
    revoked: false,
    mustPass: true,
    what: 'a genuine pmc-authored manual exception is untouched',
  },
];

/**
 * The attribution CHECK's TRUTH TABLE — what `T3CRepairAction_attribution_non_blank` must DECIDE.
 *
 * Same reasoning as {@link T3C_MARKER_CHECK_PROBES}, and the same hole if skipped: a same-named
 * `CHECK (TRUE)`, or one covering only `operator`, is a validated check constraint that the
 * create-if-absent guards would accept, and whitespace-only attribution would then be storable
 * FOREVER — permanently, because the table is append-only. Evaluating the expression is the only
 * test that distinguishes those from the real rule.
 *
 * The whitespace probes use the repository's complete ASCII trim set (space, tab, newline, vertical
 * tab, form feed, carriage return), so a constraint trimming only `' '` is caught too.
 */
export const T3C_ATTRIBUTION_CHECK_PROBES: ReadonlyArray<{
  operator: string;
  reason: string;
  mustPass: boolean;
  what: string;
}> = [
  { operator: 'ops@vitan.in', reason: 'retiring a legacy blank muster', mustPass: true, what: 'real attribution is accepted' },
  { operator: ' \t\n\v\f\r', reason: 'retiring a legacy blank muster', mustPass: false, what: 'a whitespace-only operator names nobody' },
  { operator: 'ops@vitan.in', reason: ' \t\n\v\f\r', mustPass: false, what: 'a whitespace-only reason states nothing' },
  { operator: '', reason: '', mustPass: false, what: 'empty attribution is the degenerate case of both' },
];

function sqlText(value: string | null): string {
  return value === null ? 'NULL::text' : `'${value.replace(/'/g, "''")}'::text`;
}

/**
 * Evaluate a candidate CHECK expression over {@link T3C_MARKER_CHECK_PROBES}. Returns `{ ok }`.
 *
 * `COALESCE(expr, true)` models PostgreSQL's own CHECK semantics exactly: an expression evaluating
 * to NULL passes. The expression is rendered by `pg_get_expr(conbin, conrelid)` and so refers to
 * bare column names, which the VALUES alias supplies; a decoy referencing any OTHER column makes
 * this query ERROR, which every caller treats as "not sealed" — fail-closed, not fail-open.
 */
export function t3cMarkerCheckTruthTableSql(expr: string): string {
  const rows = T3C_MARKER_CHECK_PROBES.map(
    (p) =>
      `(${sqlText(p.manualReason)}, ${p.revoked ? 'now()::timestamptz' : 'NULL::timestamptz'}, ${p.mustPass}::boolean)`,
  ).join(', ');
  return `SELECT bool_and(COALESCE((${expr}), true) = t."expected") AS ok
            FROM (VALUES ${rows}) AS t("manualReason", "revokedAt", "expected")`;
}

/**
 * Evaluate a candidate attribution CHECK expression over {@link T3C_ATTRIBUTION_CHECK_PROBES}.
 * Same semantics, same fail-closed contract as {@link t3cMarkerCheckTruthTableSql}.
 */
export function t3cAttributionCheckTruthTableSql(expr: string): string {
  const rows = T3C_ATTRIBUTION_CHECK_PROBES.map(
    (p) => `(${sqlText(p.operator)}, ${sqlText(p.reason)}, ${p.mustPass}::boolean)`,
  ).join(', ');
  return `SELECT bool_and(COALESCE((${expr}), true) = t."expected") AS ok
            FROM (VALUES ${rows}) AS t("operator", "reason", "expected")`;
}
