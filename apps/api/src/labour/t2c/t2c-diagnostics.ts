import type { Prisma } from '@prisma/client';

/**
 * Phase 4 Task 2 correction (round 2) — the labour COMMERCIAL-integrity diagnostic set.
 *
 * These read-only queries mirror the ABORT diagnostics of migration
 * `20270205000000_phase4_t2_correction` (findings F2/F3/F4/F5) and ADD the two the migration could
 * only surface OPAQUELY as a raw foreign-key violation at the `ALTER TABLE … ADD CONSTRAINT` step:
 *   - **F2.poline** — a PO line whose COPIED slice (civilDate/shift/fingerprint) differs from the
 *     requisition line it executes (fails `LabourPurchaseOrderLine_reqline_slice_fkey`);
 *   - **F4** — a PO line whose rate/premium are not traceable to a quote line of its PO's approved
 *     comparison (the migration diagnoses this via a post-backfill NULL check; here we diagnose the
 *     UNDERLYING resolvability, since the provenance columns do not exist until the migration runs).
 *
 * Every query references ONLY columns that already exist after Task 2 (`20270201000000`) — the
 * correction adds the provenance columns/constraints, so this set runs identically on a database
 * that has NOT yet applied `20270205` (the repair target), on one where it FAILED and rolled back,
 * and on one where it succeeded (all counts zero). Running it as a preflight BEFORE
 * `prisma migrate deploy` turns the two opaque FK failures into an explicit per-finding report, and
 * re-running it INSIDE the repair transaction is what gates a commit (every finding must read zero).
 */

const SAMPLE_LIMIT = 10;

export interface T2CFindingReport {
  /** Stable finding code — `F5`, `F3`, `F2.spec`, `F2.slice`, `F2.poline`, `F4`. */
  code: string;
  description: string;
  count: number;
  /** Up to SAMPLE_LIMIT identifying rows — never the whole set, so the report stays bounded. */
  samples: Array<Record<string, unknown>>;
}

export interface T2CDiagnosticsReport {
  findings: T2CFindingReport[];
  /** Sum of every finding's count. `0` ⇒ the database satisfies every commercial-truth invariant. */
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

/**
 * The six diagnostics, in report order. Predicates are duplicated between the count and sample
 * queries deliberately — this file is repair-critical and every predicate must be auditable against
 * migration `20270205000000` on sight, so no clever abstraction hides what is being counted.
 */
const DIAGS: Diag[] = [
  {
    code: 'F5',
    description: 'PO lines with committedQty > personShiftQty',
    count: `SELECT count(*)::bigint AS n FROM "LabourPurchaseOrderLine" WHERE "committedQty" > "personShiftQty"`,
    sample: `SELECT "id", "projectId", "committedQty", "personShiftQty" FROM "LabourPurchaseOrderLine" WHERE "committedQty" > "personShiftQty" ORDER BY "id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F3',
    description: 'capacity commitments whose slice identity differs from their PO line',
    count: `SELECT count(*)::bigint AS n FROM "CapacityCommitment" c JOIN "LabourPurchaseOrderLine" l ON l."projectId" = c."projectId" AND l."id" = c."poLineId" WHERE c."labourSpecFingerprint" <> l."labourSpecFingerprint" OR c."civilDate" <> l."civilDate" OR c."shift" <> l."shift" OR c."personShiftQty" <> l."personShiftQty"`,
    sample: `SELECT c."id", c."projectId", c."poLineId" FROM "CapacityCommitment" c JOIN "LabourPurchaseOrderLine" l ON l."projectId" = c."projectId" AND l."id" = c."poLineId" WHERE c."labourSpecFingerprint" <> l."labourSpecFingerprint" OR c."civilDate" <> l."civilDate" OR c."shift" <> l."shift" OR c."personShiftQty" <> l."personShiftQty" ORDER BY c."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F2.spec',
    description: 'requisition lines whose fingerprint/shift is not the pinned spec\'s',
    count: `SELECT count(*)::bigint AS n FROM "LabourRequisitionLine" l LEFT JOIN "LabourRequirementSpec" s ON s."projectId" = l."projectId" AND s."requirementId" = l."requirementId" AND s."revision" = l."revision" AND s."labourSpecFingerprint" = l."labourSpecFingerprint" AND s."shift" = l."shift" WHERE s."id" IS NULL`,
    sample: `SELECT l."id", l."projectId", l."requirementId", l."revision", l."labourSpecFingerprint", l."shift" FROM "LabourRequisitionLine" l LEFT JOIN "LabourRequirementSpec" s ON s."projectId" = l."projectId" AND s."requirementId" = l."requirementId" AND s."revision" = l."revision" AND s."labourSpecFingerprint" = l."labourSpecFingerprint" AND s."shift" = l."shift" WHERE s."id" IS NULL ORDER BY l."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F2.slice',
    description: 'requisition lines naming a civil date with no demand slice',
    count: `SELECT count(*)::bigint AS n FROM "LabourRequisitionLine" l LEFT JOIN "LabourDemandSlice" d ON d."projectId" = l."projectId" AND d."requirementId" = l."requirementId" AND d."revision" = l."revision" AND d."civilDate" = l."civilDate" WHERE d."id" IS NULL`,
    sample: `SELECT l."id", l."projectId", l."requirementId", l."revision", l."civilDate" FROM "LabourRequisitionLine" l LEFT JOIN "LabourDemandSlice" d ON d."projectId" = l."projectId" AND d."requirementId" = l."requirementId" AND d."revision" = l."revision" AND d."civilDate" = l."civilDate" WHERE d."id" IS NULL ORDER BY l."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F2.poline',
    description: 'PO lines whose copied slice differs from their requisition line (fails the reqline-slice FK)',
    count: `SELECT count(*)::bigint AS n FROM "LabourPurchaseOrderLine" pol JOIN "LabourRequisitionLine" rl ON rl."projectId" = pol."projectId" AND rl."id" = pol."requisitionLineId" WHERE pol."civilDate" <> rl."civilDate" OR pol."shift" <> rl."shift" OR pol."labourSpecFingerprint" <> rl."labourSpecFingerprint"`,
    sample: `SELECT pol."id", pol."projectId", pol."requisitionLineId" FROM "LabourPurchaseOrderLine" pol JOIN "LabourRequisitionLine" rl ON rl."projectId" = pol."projectId" AND rl."id" = pol."requisitionLineId" WHERE pol."civilDate" <> rl."civilDate" OR pol."shift" <> rl."shift" OR pol."labourSpecFingerprint" <> rl."labourSpecFingerprint" ORDER BY pol."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F4',
    description: 'PO lines whose rate/premium are not traceable to a quote line of the PO\'s approved comparison',
    count: `SELECT count(*)::bigint AS n FROM "LabourPurchaseOrderLine" l WHERE NOT EXISTS (SELECT 1 FROM "LabourPurchaseOrderVersion" v JOIN "LabourPurchaseOrder" po ON po."projectId" = v."projectId" AND po."id" = v."poId" JOIN "LabourQuoteComparison" cmp ON cmp."projectId" = po."projectId" AND cmp."id" = po."comparisonId" JOIN "SupplierLabourQuoteLine" ql ON ql."projectId" = cmp."projectId" AND ql."quoteId" = cmp."selectedQuoteId" WHERE v."projectId" = l."projectId" AND v."id" = l."poVersionId" AND ql."requisitionLineId" = l."requisitionLineId" AND ql."ratePerPersonShift" = l."ratePerPersonShift" AND ql."shiftPremium" = l."shiftPremium")`,
    sample: `SELECT l."id", l."projectId", l."requisitionLineId", l."ratePerPersonShift", l."shiftPremium" FROM "LabourPurchaseOrderLine" l WHERE NOT EXISTS (SELECT 1 FROM "LabourPurchaseOrderVersion" v JOIN "LabourPurchaseOrder" po ON po."projectId" = v."projectId" AND po."id" = v."poId" JOIN "LabourQuoteComparison" cmp ON cmp."projectId" = po."projectId" AND cmp."id" = po."comparisonId" JOIN "SupplierLabourQuoteLine" ql ON ql."projectId" = cmp."projectId" AND ql."quoteId" = cmp."selectedQuoteId" WHERE v."projectId" = l."projectId" AND v."id" = l."poVersionId" AND ql."requisitionLineId" = l."requisitionLineId" AND ql."ratePerPersonShift" = l."ratePerPersonShift" AND ql."shiftPremium" = l."shiftPremium") ORDER BY l."id" LIMIT ${SAMPLE_LIMIT}`,
  },
];

/** All finding codes this correction diagnoses, for callers that want to enumerate them. */
export const T2C_FINDING_CODES: string[] = DIAGS.map((d) => d.code);

/**
 * Every table the diagnostics READ. The preflight checks these exist before running any diagnostic,
 * so a fresh/empty or pre-Task-2 database reports "not applicable" instead of erroring on a missing
 * relation.
 */
export const T2C_REFERENCED_TABLES: readonly string[] = [
  'LabourPurchaseOrderLine',
  'CapacityCommitment',
  'LabourRequisitionLine',
  'LabourRequirementSpec',
  'LabourDemandSlice',
  'LabourPurchaseOrderVersion',
  'LabourPurchaseOrder',
  'LabourQuoteComparison',
  'SupplierLabourQuoteLine',
];

/** The Task-2 column the diagnostics need — its presence marks a labour-commercial-capable database. */
export const T2C_MARKER_COLUMN = { table: 'LabourPurchaseOrderLine', column: 'committedQty' } as const;

/**
 * Run every diagnostic READ-ONLY over `client` (a top-level Prisma client or a transaction). Returns
 * a per-finding count + bounded samples and a `clean` flag. Never writes; safe to run on production.
 */
export async function runT2CDiagnostics(client: RawQueryClient): Promise<T2CDiagnosticsReport> {
  const findings: T2CFindingReport[] = [];
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

/** BigInt/Decimal values are not JSON-serializable — coerce to Number/String for the report. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (v !== null && typeof v === 'object' && 'toString' in v && v.constructor?.name === 'Decimal') out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

/** Human-readable multi-line summary of the non-zero findings, for CLI output + throw messages. */
export function summarizeT2C(report: T2CDiagnosticsReport): string {
  const nonZero = report.findings.filter((f) => f.count > 0);
  if (nonZero.length === 0) return 'clean — every labour commercial-truth invariant is satisfied.';
  return nonZero
    .map((f) => `  ${f.code}: ${f.count} — ${f.description}\n    samples: ${JSON.stringify(f.samples)}`)
    .join('\n');
}

/** The transaction client type the repair engine uses for the in-transaction re-diagnose. */
export type T2CTxClient = Prisma.TransactionClient;
