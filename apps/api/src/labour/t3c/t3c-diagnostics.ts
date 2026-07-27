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
 */
export function t3cGenuineEvidenceSql(alias: string): string {
  return `EXISTS (
            SELECT 1 FROM "T3CRepairAction" r
             WHERE r."table" = 'LabourAttendance'
               AND r."rowId" = ${alias}."id"
               AND r."repairId" = substring(${alias}."manualReason" from '${T3C_MARKER_REPAIR_ID_REGEX}')
               AND r."beforeImage"->>'id' = ${alias}."id"
               AND btrim(r."operator", ${T3C_BLANK_TRIM_SET}) <> ''
               AND btrim(r."reason", ${T3C_BLANK_TRIM_SET}) <> ''
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
      sample: `SELECT a."id", a."projectId", a."workerId", a."civilDate", a."shift", a."recordedById", a."revokedAt" FROM "LabourAttendance" a WHERE ${marker} ORDER BY a."projectId", a."civilDate", a."id" LIMIT ${SAMPLE_LIMIT}`,
    },
  ];
}

/** All finding codes this correction diagnoses, for callers that want to enumerate them. */
export const T3C_FINDING_CODES: string[] = diagsFor(true).map((d) => d.code);

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
