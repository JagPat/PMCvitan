/**
 * Anything that can run a raw query — the Prisma client OR an interactive-transaction client.
 *
 * Typed structurally so a caller can run this INSIDE a transaction and roll back. That is what lets
 * the integration test tamper with the catalog safely: PostgreSQL's DDL is transactional, so
 * `ALTER TABLE … DISABLE TRIGGER` inside a rolled-back transaction never becomes visible to anyone
 * and cannot survive the test process being killed. A shared-database suite that repairs itself
 * only in a `finally` block leaves a disabled seal behind on SIGKILL, which would then look exactly
 * like the production defect this file exists to report.
 */
export type RawQueryable = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

/**
 * ARMED SEALS — is every enforcement object in THIS database actually switched on?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A LINTER. Four review units (#423, #430, #431, #432) tried to
 * answer "is a migration's guard as wide as the object it judges?" by READING the migration's SQL.
 * Sixteen findings across them, every one reducing to the same thing: a check narrower than the
 * object it judges — the defect those rules existed to detect, restated as their implementation.
 * That is not bad luck. Any static reader must MODEL the objects it reasons about, and a model is
 * narrower than the thing it models, so the method returns its own reflection however well it is
 * written. `docs/MIGRATION_INVARIANTS.md` records the lineage and its retirement.
 *
 * It also protected the wrong thing. A migration's source being well-shaped is not the property
 * anyone needs. The property is THIS DATABASE IS GUARDED RIGHT NOW, and what breaks it is a bad
 * restore, a `prisma db push`, or an `ALTER TABLE … DISABLE TRIGGER ALL` — none of which touch the
 * source a linter reads.
 *
 * SO THE QUESTION IS ASKED OF THE CATALOG, NOT OF THE FILES. PostgreSQL is asked what enforcement
 * objects exist and whether each is armed. That is TOTAL BY CONSTRUCTION: you cannot be narrower
 * than the object you judge when the object IS the catalog and you asked it. There is no inventory
 * to maintain, no snapshot to regenerate, no site attribution and no coverage accounting — the
 * three surfaces that drew the findings that closed #431 and #432.
 *
 * MEASURED on a ledger-complete database at `36215d37`: 1,051 enforcement objects — 387 foreign
 * keys, 187 user triggers, 180 CHECKs, 132 primary keys, 165 plpgsql bodies — and ZERO of them
 * disabled, unvalidated or bypassed. That zero is what makes this checkable without an expectation
 * model: a deployed database has no legitimate reason to hold a disabled enforcement object, so
 * ANY is a finding, and the check needs to know nothing about which objects ought to exist.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It does not verify that an object's DEFINITION is the one
 * the migration installed — a body hollowed by `CREATE OR REPLACE` keeps its name, OID, volatility
 * and search_path pin, and this check cannot see it. That question needs a canonical expectation to
 * compare against and is a separate unit; `t3c seals` and `b1 seals` already answer it for their
 * own migrations. Claiming otherwise here would be the very thing this file refuses.
 */

/**
 * WHICH SCHEMAS ARE JUDGED — every one that is not PostgreSQL's own.
 *
 * Written once and interpolated, rather than repeated in each query below. An earlier draft of this
 * file hard-coded `nspname = 'public'` in nine places. Today that is not narrow — this database has
 * exactly one application schema, measured — but it is narrow BY CONSTRUCTION: a migration that
 * adds a schema would leave every enforcement object in it silently unjudged, which is precisely the
 * defect this file exists to report, committed inside this file. Nine copies of a predicate is also
 * how the copies come to disagree.
 *
 * The catalog's own schemas are excluded because their constraints are PostgreSQL's, not this
 * repository's — verified: `information_schema` carries two domain CHECKs and 48 unique constraints
 * that no deploy should ever be judged on.
 */
const APP_SCHEMA = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";

export type ArmedSealFinding = {
  /** `trigger` | `foreign_key` | `constraint` | `table` — what kind of object is unarmed. */
  kind: string;
  /** `Table.object_name`, the name an operator repairs by. */
  identity: string;
  /** Why it is not enforcing, in the catalog's own terms. */
  reason: string;
};

export type ArmedSealReport = {
  /** `false` only when the schema is absent — never a success for this question. */
  applicable: boolean;
  /** Every enforcement object considered, so a silently-empty scan is visible as 0. */
  considered: number;
  armed: boolean;
  findings: ArmedSealFinding[];
};

/**
 * Four ways an enforcement object can be present in the catalog and not enforce. Each is a real
 * mechanism, not a hypothetical: (1) and (2) are what `ALTER TABLE … DISABLE TRIGGER [ALL]` leaves
 * — reproduced against a live PG16 on both a constraint trigger and a foreign key; (3) is a
 * constraint added `NOT VALID` and never validated, which enforces nothing for rows already there;
 * (4) is `relhastriggers = false`, which makes PostgreSQL skip a table's triggers wholesale while
 * every trigger row survives intact.
 *
 * (2) is the one the linter lineage was written for and never shipped. A foreign key is implemented
 * as internal `RI_ConstraintTrigger` rows — four per key on PG16 — and disabling them leaves
 * `conname`, `contype`, `conrelid`, `confrelid` AND `convalidated` byte-for-byte unchanged. A guard
 * that reads those columns passes over a key that enforces nothing. Verified by execution: with
 * `LabourWorkFact` under `DISABLE TRIGGER ALL`, `convalidated` still read `t` while 2 of the key's
 * 4 RI triggers read `tgenabled = 'D'`.
 */
const UNARMED_SQL = `
  SELECT 'trigger' AS kind,
         (c.relname || '.' || t.tgname) AS identity,
         'trigger is DISABLED (pg_trigger.tgenabled = ''D'') — it exists and does not fire' AS reason
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE NOT t.tgisinternal AND ${APP_SCHEMA} AND t.tgenabled = 'D'
  UNION ALL
  SELECT 'foreign_key',
         (c.relname || '.' || k.conname),
         'foreign key has DISABLED internal RI triggers — pg_constraint still reports contype=''f'' and convalidated=''t'', and the key enforces nothing'
    FROM pg_constraint k
    JOIN pg_class c ON k.conrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE k.contype = 'f' AND ${APP_SCHEMA}
     AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgconstraint = k.oid AND g.tgenabled = 'D')
  UNION ALL
  SELECT 'constraint',
         (c.relname || '.' || k.conname),
         'constraint is NOT VALID — it was never validated, so rows already present are unchecked'
    FROM pg_constraint k
    JOIN pg_class c ON k.conrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE ${APP_SCHEMA} AND k.contype IN ('f', 'c') AND NOT k.convalidated
  UNION ALL
  -- The same question for a DOMAIN constraint. Its conrelid is 0, so the relation join above
  -- silently drops it; ALTER DOMAIN ... ADD CONSTRAINT ... NOT VALID is a real statement, and this
  -- repository having no domains TODAY is not the same as never.
  SELECT 'domain_constraint',
         (t.typname || '.' || k.conname),
         'domain constraint is NOT VALID — it was never validated, so values already stored are unchecked'
    FROM pg_constraint k
    JOIN pg_type t ON k.contypid = t.oid
    JOIN pg_namespace n ON t.typnamespace = n.oid
   WHERE k.contypid <> 0 AND ${APP_SCHEMA} AND NOT k.convalidated
  UNION ALL
  SELECT 'table',
         c.relname,
         'relhastriggers is FALSE while the table carries triggers — PostgreSQL skips all of them'
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE ${APP_SCHEMA} AND NOT c.relhastriggers
     AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid)
  ORDER BY 1, 2
`;

/**
 * How many enforcement objects this database holds. Reported so that a scan which finds nothing
 * because it LOOKED at nothing is distinguishable from one that found nothing because all is well
 * — the failure `upgrade-proof.sh` guards against with its own command-not-found trap.
 */
const CONSIDERED_SQL = `
  SELECT (
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE NOT t.tgisinternal AND ${APP_SCHEMA})
  + (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON k.conrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE ${APP_SCHEMA} AND k.contype IN ('f','c','u','x','p'))
  + (SELECT count(*) FROM pg_proc p JOIN pg_language l ON p.prolang = l.oid
       JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE l.lanname = 'plpgsql' AND ${APP_SCHEMA})
  )::int AS n
`;

/**
 * TOTALITY, ASSERTED RATHER THAN ASSUMED. The one idea worth keeping from the retired MI-000: a
 * constraint kind nobody has reasoned about is exactly how a check ends up narrower than its
 * object. If PostgreSQL grows a `contype` this file has never classified, that is a finding here
 * rather than a row silently skipped.
 */
const UNCLASSIFIED_SQL = `
  SELECT DISTINCT k.contype::text AS contype
    FROM pg_constraint k
    LEFT JOIN pg_class c ON k.conrelid = c.oid
    LEFT JOIN pg_namespace rn ON c.relnamespace = rn.oid
    LEFT JOIN pg_type t ON k.contypid = t.oid
    LEFT JOIN pg_namespace tn ON t.typnamespace = tn.oid
   WHERE COALESCE(rn.nspname, tn.nspname) IS NOT NULL
     AND COALESCE(rn.nspname, tn.nspname) NOT LIKE 'pg\\_%'
     AND COALESCE(rn.nspname, tn.nspname) <> 'information_schema'
     AND k.contype NOT IN ('f','c','u','x','p','t')
`;

export async function verifyArmedSeals(prisma: RawQueryable): Promise<ArmedSealReport> {
  const present = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE ${APP_SCHEMA} AND c.relkind = 'r'`,
  );
  if ((present[0]?.n ?? 0) === 0) {
    return { applicable: false, considered: 0, armed: false, findings: [] };
  }

  const [{ n: considered }] = await prisma.$queryRawUnsafe<{ n: number }[]>(CONSIDERED_SQL);
  const findings = await prisma.$queryRawUnsafe<ArmedSealFinding[]>(UNARMED_SQL);
  const unclassified = await prisma.$queryRawUnsafe<{ contype: string }[]>(UNCLASSIFIED_SQL);

  const all: ArmedSealFinding[] = [
    ...findings,
    ...unclassified.map((u) => ({
      kind: 'unclassified',
      identity: `pg_constraint.contype = '${u.contype}'`,
      reason: 'a constraint kind this check has never classified — it is not being judged at all, '
        + 'which is the shape this check exists to refuse. Classify it in armed-seals.ts.',
    })),
  ];

  return { applicable: true, considered, armed: all.length === 0, findings: all };
}

export function summarizeArmedSeals(report: ArmedSealReport): string {
  if (!report.applicable) return 'the public schema holds no tables, so nothing can be said about its seals';
  if (report.armed) return `all ${report.considered} enforcement objects are armed`;
  return report.findings.map((f) => `  ${f.kind} ${f.identity}\n    ${f.reason}`).join('\n');
}
