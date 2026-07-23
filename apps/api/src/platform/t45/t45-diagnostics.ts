import type { Prisma } from '@prisma/client';

/**
 * Phase 3 Tasks 4–5 integrity correction — the UNIFIED diagnostic set.
 *
 * These read-only queries mirror the ABORT diagnostics in migration
 * `20261231000000_phase3_t45_integrity_correction`'s DO block EXACTLY, and ADD one the migration
 * could only surface opaquely: **F3.1 — more than one canonical `issue` movement per
 * MaterialIssue**, the shape that makes `CREATE UNIQUE INDEX
 * "StockTransaction_one_issue_movement_per_issue_key"` fail mid-migration with an unhelpful
 * unique-violation. Running this set as a **preflight BEFORE `prisma migrate deploy`** turns that
 * opaque failure into an explicit, per-finding report (count + bounded samples), and re-running it
 * INSIDE the repair transaction is what gates a commit (every finding must read zero).
 *
 * Every query references only columns that already exist after Tasks 4–5 (the correction adds no
 * columns, only constraints/triggers), so the set runs identically on a database that has NOT yet
 * applied 20261231 (the repair target), on one where it FAILED and rolled back, and on one where it
 * succeeded (all counts zero).
 */

const SAMPLE_LIMIT = 10;

export interface T45FindingReport {
  /** Stable finding code — `F1.null`, `F1.foreign`, `F2.1`, `F2.2`, `F2.3`, `F3.1`, `F3.2`, `F3.3`, `F4`. */
  code: string;
  description: string;
  count: number;
  /** Up to SAMPLE_LIMIT identifying rows — never the whole set, so the report stays bounded. */
  samples: Array<Record<string, unknown>>;
}

export interface T45DiagnosticsReport {
  findings: T45FindingReport[];
  /** Sum of every finding's count. `0` ⇒ the database satisfies every physical-truth invariant. */
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
 * The nine diagnostics, in report order. Predicates are duplicated between the count and sample
 * queries deliberately — this file is repair-critical and every predicate must be auditable against
 * the migration's DO block on sight, so no clever abstraction hides what is being counted.
 */
const DIAGS: Diag[] = [
  {
    code: 'F1.null',
    description: 'stock rows with a NULL sourceCommandId',
    count: `SELECT count(*)::bigint AS n FROM "StockTransaction" WHERE "sourceCommandId" IS NULL`,
    sample: `SELECT "id", "projectId", "type", "lotId", "issueId" FROM "StockTransaction" WHERE "sourceCommandId" IS NULL ORDER BY "id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F1.foreign',
    description: 'stock rows whose sourceCommandId is in another project',
    count: `SELECT count(*)::bigint AS n FROM "StockTransaction" st WHERE st."sourceCommandId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommandExecution" ce WHERE ce."id" = st."sourceCommandId" AND ce."projectId" = st."projectId")`,
    sample: `SELECT st."id", st."projectId", st."sourceCommandId" FROM "StockTransaction" st WHERE st."sourceCommandId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommandExecution" ce WHERE ce."id" = st."sourceCommandId" AND ce."projectId" = st."projectId") ORDER BY st."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F2.1',
    description: 'stock lots with a broken PO-line/commitment/requirement chain',
    count: `SELECT count(*)::bigint AS n FROM "StockLot" sl WHERE NOT EXISTS (SELECT 1 FROM "DeliveryCommitment" dc WHERE dc."projectId" = sl."projectId" AND dc."id" = sl."commitmentId" AND dc."poLineId" = sl."poLineId") OR NOT EXISTS (SELECT 1 FROM "PurchaseOrderLine" pol WHERE pol."projectId" = sl."projectId" AND pol."id" = sl."poLineId" AND pol."requirementId" = sl."requirementId" AND pol."revision" = sl."revision")`,
    sample: `SELECT sl."id", sl."projectId", sl."poLineId", sl."commitmentId", sl."requirementId", sl."revision" FROM "StockLot" sl WHERE NOT EXISTS (SELECT 1 FROM "DeliveryCommitment" dc WHERE dc."projectId" = sl."projectId" AND dc."id" = sl."commitmentId" AND dc."poLineId" = sl."poLineId") OR NOT EXISTS (SELECT 1 FROM "PurchaseOrderLine" pol WHERE pol."projectId" = sl."projectId" AND pol."id" = sl."poLineId" AND pol."requirementId" = sl."requirementId" AND pol."revision" = sl."revision") ORDER BY sl."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F2.2',
    description: 'stock lots whose frozen §B spec copy/base UOM does not match the pinned requirement revision',
    count: `SELECT count(*)::bigint AS n FROM "StockLot" sl LEFT JOIN "MaterialRequirementSpec" ms ON ms."projectId" = sl."projectId" AND ms."requirementId" = sl."requirementId" AND ms."revision" = sl."revision" LEFT JOIN "ActivityRequirement" ar ON ar."projectId" = sl."projectId" AND ar."requirementId" = sl."requirementId" AND ar."revision" = sl."revision" WHERE ms."requirementId" IS NULL OR ar."requirementId" IS NULL OR sl."materialCategory" <> ms."materialCategory" OR sl."make" <> ms."make" OR sl."grade" <> ms."grade" OR sl."normalizedAttributes" <> ms."normalizedAttributes" OR sl."specFingerprint" <> ms."specFingerprint" OR sl."baseUom" <> ar."baseUom" OR sl."decisionId" IS DISTINCT FROM ms."decisionId" OR sl."decisionVersion" IS DISTINCT FROM ms."decisionVersion" OR sl."optionKey" IS DISTINCT FROM ms."optionKey"`,
    sample: `SELECT sl."id", sl."projectId", sl."requirementId", sl."revision", sl."specFingerprint" FROM "StockLot" sl LEFT JOIN "MaterialRequirementSpec" ms ON ms."projectId" = sl."projectId" AND ms."requirementId" = sl."requirementId" AND ms."revision" = sl."revision" LEFT JOIN "ActivityRequirement" ar ON ar."projectId" = sl."projectId" AND ar."requirementId" = sl."requirementId" AND ar."revision" = sl."revision" WHERE ms."requirementId" IS NULL OR ar."requirementId" IS NULL OR sl."materialCategory" <> ms."materialCategory" OR sl."make" <> ms."make" OR sl."grade" <> ms."grade" OR sl."normalizedAttributes" <> ms."normalizedAttributes" OR sl."specFingerprint" <> ms."specFingerprint" OR sl."baseUom" <> ar."baseUom" OR sl."decisionId" IS DISTINCT FROM ms."decisionId" OR sl."decisionVersion" IS DISTINCT FROM ms."decisionVersion" OR sl."optionKey" IS DISTINCT FROM ms."optionKey" ORDER BY sl."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F2.3',
    description: 'receipt rows whose PO-line/commitment differs from their lot',
    count: `SELECT count(*)::bigint AS n FROM "StockTransaction" st JOIN "StockLot" sl ON sl."projectId" = st."projectId" AND sl."id" = st."lotId" WHERE st."type" = 'receipt' AND (st."poLineId" IS DISTINCT FROM sl."poLineId" OR st."commitmentId" IS DISTINCT FROM sl."commitmentId")`,
    sample: `SELECT st."id", st."projectId", st."lotId", st."poLineId", st."commitmentId" FROM "StockTransaction" st JOIN "StockLot" sl ON sl."projectId" = st."projectId" AND sl."id" = st."lotId" WHERE st."type" = 'receipt' AND (st."poLineId" IS DISTINCT FROM sl."poLineId" OR st."commitmentId" IS DISTINCT FROM sl."commitmentId") ORDER BY st."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F3.1',
    description: 'MaterialIssues with MORE THAN ONE canonical issue movement (fails the partial unique index)',
    count: `SELECT count(*)::bigint AS n FROM (SELECT "projectId", "issueId" FROM "StockTransaction" WHERE "type" = 'issue' AND "issueId" IS NOT NULL GROUP BY "projectId", "issueId" HAVING count(*) > 1) g`,
    sample: `SELECT "projectId", "issueId", count(*)::bigint AS movements, array_agg("id" ORDER BY "id") AS "transactionIds" FROM "StockTransaction" WHERE "type" = 'issue' AND "issueId" IS NOT NULL GROUP BY "projectId", "issueId" HAVING count(*) > 1 ORDER BY "issueId" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F3.2',
    description: 'MaterialIssue rows with no canonical issue movement',
    count: `SELECT count(*)::bigint AS n FROM "MaterialIssue" mi WHERE NOT EXISTS (SELECT 1 FROM "StockTransaction" st WHERE st."projectId" = mi."projectId" AND st."issueId" = mi."id" AND st."type" = 'issue')`,
    sample: `SELECT mi."id", mi."projectId", mi."lotId", mi."activityId" FROM "MaterialIssue" mi WHERE NOT EXISTS (SELECT 1 FROM "StockTransaction" st WHERE st."projectId" = mi."projectId" AND st."issueId" = mi."id" AND st."type" = 'issue') ORDER BY mi."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F3.3',
    description: 'issue-scoped rows mis-scoped against their MaterialIssue',
    count: `SELECT count(*)::bigint AS n FROM "StockTransaction" st JOIN "MaterialIssue" mi ON mi."projectId" = st."projectId" AND mi."id" = st."issueId" WHERE st."issueId" IS NOT NULL AND (st."lotId" <> mi."lotId" OR st."storeLocation" <> mi."storeLocation" OR st."activityId" IS DISTINCT FROM mi."activityId" OR (st."type" = 'issue' AND st."qty" <> mi."qty"))`,
    sample: `SELECT st."id", st."projectId", st."issueId", st."type", st."lotId", st."storeLocation" FROM "StockTransaction" st JOIN "MaterialIssue" mi ON mi."projectId" = st."projectId" AND mi."id" = st."issueId" WHERE st."issueId" IS NOT NULL AND (st."lotId" <> mi."lotId" OR st."storeLocation" <> mi."storeLocation" OR st."activityId" IS DISTINCT FROM mi."activityId" OR (st."type" = 'issue' AND st."qty" <> mi."qty")) ORDER BY st."id" LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: 'F4',
    description: 'resolutions attached to a matched=true observation',
    count: `SELECT count(*)::bigint AS n FROM "MismatchResolution" mr JOIN "SiteMaterial" sm ON sm."projectId" = mr."projectId" AND sm."id" = mr."siteMaterialId" WHERE sm."matched" = TRUE`,
    sample: `SELECT mr."id", mr."projectId", mr."siteMaterialId" FROM "MismatchResolution" mr JOIN "SiteMaterial" sm ON sm."projectId" = mr."projectId" AND sm."id" = mr."siteMaterialId" WHERE sm."matched" = TRUE ORDER BY mr."id" LIMIT ${SAMPLE_LIMIT}`,
  },
];

/** All finding codes this correction diagnoses, for callers that want to enumerate them. */
export const T45_FINDING_CODES: string[] = DIAGS.map((d) => d.code);

/**
 * Run every diagnostic READ-ONLY over `client` (a top-level Prisma client or a transaction). Returns
 * a per-finding count + bounded samples and a `clean` flag. Never writes; safe to run on production.
 */
export async function runT45Diagnostics(client: RawQueryClient): Promise<T45DiagnosticsReport> {
  const findings: T45FindingReport[] = [];
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

/** BigInt (from count/array_agg) is not JSON-serializable — coerce to Number/String for the report. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'bigint' ? Number(x) : x));
    else out[k] = v;
  }
  return out;
}

/** Human-readable multi-line summary of the non-zero findings, for CLI output + throw messages. */
export function summarizeT45(report: T45DiagnosticsReport): string {
  const nonZero = report.findings.filter((f) => f.count > 0);
  if (nonZero.length === 0) return 'clean — every §C/§E physical-truth invariant is satisfied.';
  return nonZero
    .map((f) => `  ${f.code}: ${f.count} — ${f.description}\n    samples: ${JSON.stringify(f.samples)}`)
    .join('\n');
}

/** The transaction client type the repair engine uses for the in-transaction re-diagnose. */
export type T45TxClient = Prisma.TransactionClient;
