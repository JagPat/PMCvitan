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
 *     must ALSO be revoked, so a repaired muster can never contribute active presence. Migration
 *     `20270225000000` installs that as a CHECK; diagnosing it here means the preflight reports it
 *     by name rather than letting the CHECK fail opaquely.
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
/** Rows carrying the reserved repair marker that are NOT revoked — a repaired muster that could
 *  still be read as live presence. Only a broken/partial repair (or a forged write) creates this. */
const MARKER_PREDICATE = `"manualReason" LIKE '${T3C_INVALID_LEGACY_PREFIX}%' AND "revokedAt" IS NULL`;

/**
 * The two diagnostics, in report order. Predicates are duplicated between the count and sample
 * queries deliberately — this file is repair-critical and every predicate must be auditable against
 * migrations `20270220000000` / `20270225000000` on sight, so no clever abstraction hides what is
 * being counted.
 */
const DIAGS: Diag[] = [
  {
    code: 'F1.blank',
    description: 'LabourAttendance rows whose manualReason is blank (an unevidenced presence claim with nothing behind it)',
    count: `SELECT count(*)::bigint AS n FROM "LabourAttendance" WHERE ${BLANK_PREDICATE}`,
    sample: `SELECT "id", "projectId", "workerId", "civilDate", "shift", "recordedById", "recordedAt", "revokedAt" FROM "LabourAttendance" WHERE ${BLANK_PREDICATE} ORDER BY "projectId", "civilDate", "id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F1.marker',
    description: 'LabourAttendance rows carrying the reserved invalid-legacy marker that are NOT revoked (a repaired muster must never contribute active presence)',
    count: `SELECT count(*)::bigint AS n FROM "LabourAttendance" WHERE ${MARKER_PREDICATE}`,
    sample: `SELECT "id", "projectId", "workerId", "civilDate", "shift", "recordedById" FROM "LabourAttendance" WHERE ${MARKER_PREDICATE} ORDER BY "projectId", "civilDate", "id" LIMIT ${SAMPLE_LIMIT}`,
  },
];

/** All finding codes this correction diagnoses, for callers that want to enumerate them. */
export const T3C_FINDING_CODES: string[] = DIAGS.map((d) => d.code);

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
  const findings: T3CFindingReport[] = [];
  for (const d of DIAGS) {
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
