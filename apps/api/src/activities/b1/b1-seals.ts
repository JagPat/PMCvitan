import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '../../prisma.service';

/**
 * Schedule B1 — the PHYSICAL-SEAL verifier for `public."ActivityDependency"`, run on every
 * production deploy rather than only when the migration runs.
 *
 * WHY THIS EXISTS AT ALL. `20270930000000_schedule_dependency_graph` proves its whole install
 * before it lifts the write barrier, and that proof is thorough. It is also a ONE-TIME event.
 * `prisma migrate deploy` proves the LEDGER is complete, not that the physical guards enforce: once
 * the migration is recorded, nothing re-reads the file, so a database that has since been through a
 * failed restore — `ALTER TABLE ... DISABLE TRIGGER ALL`, a `CREATE OR REPLACE FUNCTION` that
 * hollowed a body while keeping its identity, a lost internal foreign-key trigger — deploys green
 * with `ActivityDependency_frozen` and `ActivityDependency_no_delete` switched off and its
 * immutable evidence rewritable and deletable. MEASURED at the previous head: seals disabled,
 * `scripts/migrate.sh` exited 0, and an UPDATE and then a DELETE against the evidence row both
 * committed. This is the same reasoning that already puts `t3c seals` on the ordinary success path.
 *
 * THERE IS ONE INVENTORY, NOT TWO. The question asked here is not a second list maintained
 * alongside the migration's: it is the migration's OWN section-9 inventory, extracted verbatim from
 * the file between the `B1-SEAL-INVENTORY` markers and re-executed. A hand-kept copy would drift,
 * and a drifted verifier that reports "sealed" is worse than none. The same file supplies the
 * canonical function BODIES, which are the `$body$ ... $body$` literals the migration installs FROM
 * and compares against, so those cannot drift either. The file is part of the deployed image (the
 * Dockerfile copies the repository and `prisma migrate deploy` needs `prisma/migrations` in any
 * case), so it is the same trust root as this code.
 *
 * WHAT IS ASKED BEYOND THE MIGRATION'S OWN INVENTORY, and why each is here rather than there:
 *
 *   the BARRIER IS GONE.  `ActivityDependency_install_incomplete_check` is dropped by section 9 as
 *                         the last act of a proven install, so at the moment the inventory runs
 *                         inside the migration the barrier is still present and cannot be part of
 *                         it. Afterwards its presence means the install never finished.
 *   the FUNCTION BODIES.  Section 9 re-asks the `pg_proc` properties that decide what a seal DOES
 *                         (volatile, invoker, the search_path pin) but not the body, because
 *                         sections 4 to 7 compared the body minutes earlier. Post-install that
 *                         gap is live: `CREATE OR REPLACE FUNCTION` preserves a function's OID,
 *                         name, signature and every one of those properties while replacing what
 *                         it does, so a no-op `activity_dependency_frozen` passes the whole
 *                         inventory. This is the hazard `scripts/migrate.sh` already documents for
 *                         T3C, one table over.
 *   the FUNCTION OWNERS.  Ownership is the right to `CREATE OR REPLACE` the body at any moment, so
 *                         a seal owned by a role the table's owner does not control is not a seal.
 *                         `pg_restore` sets ownership, which is exactly the event this verifier is
 *                         for. Compared RELATIVELY to the table's owner, as the migration does.
 *
 * WHAT IS DELIBERATELY NOT ASKED HERE. `proisstrict`, `proparallel`, `prokind` and `proretset` are
 * pinned by the migration at install and are not reachable by `CREATE OR REPLACE` (they are part of
 * the identity PostgreSQL refuses to change that way) nor by a restore; re-asking them would add
 * rows to this report that no operator action can produce. Nothing about ROWS is asked: this is a
 * verifier for the guards, and the guards' whole job is that the rows are already what they say.
 */

export const B1_MIGRATION = '20270930000000_schedule_dependency_graph';
export const B1_TABLE = 'public."ActivityDependency"';
export const B1_BARRIER = 'ActivityDependency_install_incomplete_check';

/** `dist/activities/b1` and `src/activities/b1` are both three levels under `apps/api`. */
function migrationSqlPath(): string {
  return join(__dirname, '..', '..', '..', 'prisma', 'migrations', B1_MIGRATION, 'migration.sql');
}

export function readMigrationSql(): string {
  return readFileSync(migrationSqlPath(), 'utf8');
}

const INVENTORY_BEGIN = 'B1-SEAL-INVENTORY BEGIN';
const INVENTORY_END = 'B1-SEAL-INVENTORY END';

/**
 * The migration's own section-9 inventory, as a standalone query.
 *
 * Extraction is deliberately unforgiving: a missing marker, a second pair, or an inventory that no
 * longer carries the `INTO v_missing` assignment this strips is a REFUSAL, not a silently empty
 * check. A verifier that quietly asks nothing reports every database as sealed.
 */
export function extractSealInventorySql(migrationSql: string): string {
  const begin = migrationSql.indexOf(INVENTORY_BEGIN);
  const end = migrationSql.indexOf(INVENTORY_END);
  if (begin < 0 || end < 0) {
    throw new Error(
      `schedule B1: ${B1_MIGRATION}/migration.sql carries no ${INVENTORY_BEGIN}/${INVENTORY_END} pair, so the seal inventory cannot be read. The deployed image is not the reviewed one.`,
    );
  }
  if (migrationSql.indexOf(INVENTORY_BEGIN, begin + 1) >= 0 || migrationSql.indexOf(INVENTORY_END, end + 1) >= 0) {
    throw new Error(`schedule B1: ${B1_MIGRATION}/migration.sql carries more than one ${INVENTORY_BEGIN} marker pair.`);
  }
  if (end < begin) throw new Error(`schedule B1: the ${INVENTORY_END} marker precedes ${INVENTORY_BEGIN}.`);
  // From the line after BEGIN's comment block to the line before END.
  const body = migrationSql.slice(migrationSql.indexOf('\n', begin) + 1, migrationSql.lastIndexOf('\n', end) + 1);
  const assignment = ' INTO v_missing';
  const occurrences = body.split(assignment).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `schedule B1: the extracted seal inventory contains the plpgsql assignment ${occurrences} time(s), expected exactly one. A second occurrence — a comment repeating it, say — would leave the real assignment in place and make this query unrunnable, and a zero means this is not the statement this verifier knows how to run.`,
    );
  }
  const query = body.replace(assignment, '').trimEnd();
  if (!query.endsWith(';')) throw new Error('schedule B1: the extracted seal inventory does not end in a statement terminator.');
  return query;
}

/** The five `$body$ … $body$` literals the migration installs its trigger functions FROM. */
export function extractCanonicalFunctionBodies(migrationSql: string): Map<string, string> {
  const out = new Map<string, string>();
  const opener = '  v_body TEXT := $body$';
  let at = migrationSql.indexOf(opener);
  while (at >= 0) {
    const bodyStart = at + opener.length;
    // `$body$ … END $body$;` — the terminator is not on a line of its own, so the body is
    // everything up to the closing delimiter, which is exactly what `prosrc` stores.
    const bodyEnd = migrationSql.indexOf('$body$;', bodyStart);
    if (bodyEnd < 0) throw new Error('schedule B1: an unterminated $body$ literal in the migration file.');
    const body = migrationSql.slice(bodyStart, bodyEnd);
    const rest = migrationSql.slice(bodyEnd);
    const named = /AND p\.proname = '(activity_dependency_[a-z_]+)'/.exec(rest);
    if (!named) throw new Error('schedule B1: a $body$ literal in the migration file names no function.');
    out.set(named[1], body);
    at = migrationSql.indexOf(opener, bodyEnd);
  }
  if (out.size !== 5) {
    throw new Error(`schedule B1: expected five canonical trigger-function bodies in the migration file, read ${out.size}.`);
  }
  return out;
}

export type B1SealReport = {
  /** `false` only when the table does not exist — never a success for this question. */
  applicable: boolean;
  sealed: boolean;
  /** The migration's own inventory verdict: `null` is clean. */
  inventory: string | null;
  /** Objects this verifier asks about that the migration's install-time inventory cannot. */
  extra: string[];
};

type Row = { answer: string | null };

export async function verifyB1Seals(prisma: PrismaService, migrationSql = readMigrationSql()): Promise<B1SealReport> {
  const present = await prisma.$queryRawUnsafe<Array<{ there: boolean }>>(
    `SELECT (to_regclass('${B1_TABLE}') IS NOT NULL) AS there`,
  );
  if (!present[0]?.there) return { applicable: false, sealed: false, inventory: null, extra: [] };

  const inventorySql = extractSealInventorySql(migrationSql);
  const bodies = extractCanonicalFunctionBodies(migrationSql);

  // The same `pg_catalog` pin sections 1, 8 and 9 take, for the same reason: nothing judged below
  // may depend on how a name happens to render under the caller's path. `SET LOCAL` needs a
  // transaction, so the whole verification runs in one — which also means it sees one world.
  const [inventoryRows, extraRows] = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path = pg_catalog`);
    // Wrapped rather than rewritten: the inventory is a `SELECT string_agg(...) FROM (...) x;`,
    // so the one column is named here without touching a character of the extracted text.
    const inv = await tx.$queryRawUnsafe<Row[]>(
      `SELECT q.answer FROM (\n${inventorySql.replace(/;\s*$/, '')}\n) AS q(answer)`,
    );
    // The five bodies are passed as PARAMETERS, not interpolated. They are this repository's own
    // text, but a body is exactly the kind of string that acquires a quote or a backslash later,
    // and the correctness of a hand-rolled escape then depends on `standard_conforming_strings` —
    // a session GUC. A parameter has no such dependency. The NAMES are literals of this file's own.
    const entries = [...bodies.entries()];
    const values = entries
      .map(([name], i) => `('${name}', $${i + 1}::text)`)
      .join(',\n        ');
    const extra = await tx.$queryRawUnsafe<Array<{ what: string }>>(`
      SELECT 'the install barrier "${B1_BARRIER}" is still in place, so the install this database '
             || 'recorded as applied never finished and the table is unwritable' AS what
        FROM pg_constraint
       WHERE conrelid = to_regclass('${B1_TABLE}') AND conname = '${B1_BARRIER}'
      UNION ALL
      SELECT 'function public.' || f.name || '() '
             || CASE WHEN p.oid IS NULL THEN 'is absent'
                     WHEN p.prosrc <> f.body THEN 'does not have the body this migration installed '
                          || '(CREATE OR REPLACE keeps the identity and replaces what it does)'
                     ELSE 'is not owned by the owner of ' || '${B1_TABLE}'
                END
        FROM (VALUES
        ${values}
        ) AS f(name, body)
        LEFT JOIN pg_proc p ON p.proname = f.name AND p.pronargs = 0
                           AND p.pronamespace = (SELECT n.oid FROM pg_namespace n WHERE n.nspname = 'public')
       WHERE p.oid IS NULL OR p.prosrc <> f.body
          OR p.proowner <> (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass('${B1_TABLE}'))
    `, ...entries.map(([, body]) => body));
    return [inv, extra] as const;
  });

  const inventory = inventoryRows[0]?.answer ?? null;
  const extra = extraRows.map((r) => r.what).sort();
  return { applicable: true, sealed: inventory === null && extra.length === 0, inventory, extra };
}

export function summarizeB1(report: B1SealReport): string {
  if (!report.applicable) return `${B1_TABLE} does not exist, so nothing can be said about its seals.`;
  if (report.sealed) return `${B1_TABLE} is sealed: the migration's own inventory is clean, the install barrier is lifted, and all five trigger functions carry the installed body.`;
  const lines: string[] = [];
  if (report.inventory) lines.push(`  wrong, missing or not bound to public: ${report.inventory}`);
  for (const e of report.extra) lines.push(`  ${e}`);
  return lines.join('\n');
}
