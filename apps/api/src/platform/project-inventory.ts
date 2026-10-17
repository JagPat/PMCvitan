import { writeFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

/**
 * #482 — a READ-ONLY inventory of everything one project owns or is pointed at by, the first step
 * of Board's plan to remove the archived `qa-test-356a` (#482 comment 6231979169).
 *
 * The tables come from the database catalog, not from a hand-kept list, so a table added later
 * can't be missed:
 *   - direct: every column named `projectId`, every other foreign key into `Project(id)`, and
 *     `User.lastProjectId` (a plain stamp with no key);
 *   - contained: any table whose foreign key reaches a table already found (an `InspectionItem`
 *     through its `Inspection`, a `CrewRow` through its `DailyLog`), followed until nothing new
 *     appears. `User` is never followed: a user is pointed at a project, it is not owned by one.
 *
 * For the target it exports every row (byte columns as their length; exact numbers — bigint and
 * numeric — as strings, so no value is rounded), every user whose home or last project it is, and
 * every stored file (any table with a `storageKey` column). For every project it records, per
 * table, the row count and a hash of the sorted primary keys, so a later run proves no other
 * project lost or swapped a row.
 *
 * Read-only is enforced by PostgreSQL, not by care: the whole run is one `REPEATABLE READ, READ
 * ONLY` transaction — one snapshot for every query, and any INSERT, UPDATE, DELETE or DDL fails —
 * and it refuses to continue unless the server confirms both.
 */

/** How a table reaches a project: directly through `column`, or through `via`'s row. */
export interface ProjectPath {
  /** `table.column` for a direct path, `table.(cols)->parent` for a contained one */
  key: string;
  table: string;
  column?: string;
  via?: { parent: string; columns: string[]; parentColumns: string[] };
}

export interface RowIdentity {
  rows: number;
  /** md5 of the sorted primary keys (or of the sorted row contents, for a table without one) */
  identity: string;
}

export interface StoredFile {
  table: string;
  id: string;
  storageKey: string | null;
  url: string | null;
  bytesInDatabase: boolean;
}

export interface ProjectInventory {
  projectId: string;
  readOnlyVerified: true;
  snapshot: 'repeatable read';
  takenAt: string;
  project: Record<string, unknown> | null;
  /** every path by which a table can reach a project, from the catalog */
  paths: ProjectPath[];
  /** the target's rows per path key; paths with none are left out */
  rows: Record<string, Array<Record<string, unknown>>>;
  /** the target's row count per path key (non-zero only) */
  counts: Record<string, number>;
  /** every project's row count and identity hash per path key, for the before/after comparison */
  byProject: Record<string, Record<string, RowIdentity>>;
  /** users whose home project (`User.projectId`) or last-used project (`User.lastProjectId`) is the target */
  userPointers: Array<{ id: string; email: string; name: string; projectId: string; lastProjectId: string | null }>;
  /** the target's stored files: every row with a `storageKey` column, and where its bytes live */
  files: StoredFile[];
  /** user triggers that fire on DELETE, per table holding target rows (what a delete would meet) */
  deleteTriggers: Record<string, string[]>;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
/** Tables that are pointed at a project but own nothing of it: never followed to their children. */
const NOT_OWNERS = new Set(['User', 'Project', 'Org']);
const MAX_DEPTH = 8;

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Run `fn` in one transaction PostgreSQL itself holds read-only on one snapshot: any write fails. */
export async function readOnlyTransaction<T>(prisma: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // Must come before any query of the transaction; PostgreSQL then refuses every write.
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const [{ ro, iso }] = await tx.$queryRawUnsafe<Array<{ ro: string; iso: string }>>(
        "SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso");
      if (ro !== 'on' || iso !== 'repeatable read') {
        throw new Error(`refusing to run: the transaction is not a repeatable-read, read-only one (${iso}, read_only=${ro})`);
      }
      return fn(tx);
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
}

interface Catalog {
  direct: Array<{ table: string; column: string }>;
  edges: Array<{ child: string; columns: string[]; parent: string; parentColumns: string[] }>;
  primaryKeys: Map<string, string[]>;
  byteColumns: Map<string, string[]>;
  exactColumns: Map<string, string[]>;
  columnsOf: Map<string, Set<string>>;
}

async function readCatalog(tx: Tx): Promise<Catalog> {
  const direct = await tx.$queryRawUnsafe<Array<{ table: string; column: string }>>(`
    SELECT table_name AS "table", column_name AS "column"
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'projectId' AND table_name <> 'Project'
    UNION
    SELECT src.relname, a.attname
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = current_schema()
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(s, d)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.s
      JOIN pg_attribute b ON b.attrelid = c.confrelid AND b.attnum = k.d
     WHERE c.contype = 'f' AND c.confrelid = '"Project"'::regclass AND b.attname = 'id'
    UNION
    SELECT 'User', 'lastProjectId'
     ORDER BY 1, 2`);
  const edges = await tx.$queryRawUnsafe<Catalog['edges']>(`
    SELECT ch.relname::text AS child, pa.relname::text AS parent,
           array_agg(a.attname::text ORDER BY k.ord) AS columns, array_agg(b.attname::text ORDER BY k.ord) AS "parentColumns"
      FROM pg_constraint c
      JOIN pg_class ch ON ch.oid = c.conrelid
      JOIN pg_class pa ON pa.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace AND n.nspname = current_schema()
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(s, d, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.s
      JOIN pg_attribute b ON b.attrelid = c.confrelid AND b.attnum = k.d
     WHERE c.contype = 'f'
     GROUP BY c.oid, ch.relname, pa.relname
     ORDER BY 1, 2, 3`);
  const primaryKeys = new Map<string, string[]>();
  for (const r of await tx.$queryRawUnsafe<Array<{ table: string; columns: string[] }>>(`
    SELECT c.relname::text AS "table", array_agg(a.attname::text ORDER BY k.ord) AS columns
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE i.indisprimary
     GROUP BY c.relname`)) primaryKeys.set(r.table, r.columns);
  const byteColumns = new Map<string, string[]>();
  const exactColumns = new Map<string, string[]>();
  const columnsOf = new Map<string, Set<string>>();
  for (const r of await tx.$queryRawUnsafe<Array<{ table: string; column: string; type: string }>>(`
    SELECT table_name AS "table", column_name AS "column", data_type AS type
      FROM information_schema.columns WHERE table_schema = current_schema()`)) {
    (columnsOf.get(r.table) ?? columnsOf.set(r.table, new Set()).get(r.table)!).add(r.column);
    if (r.type === 'bytea') byteColumns.set(r.table, [...(byteColumns.get(r.table) ?? []), r.column]);
    if (r.type === 'bigint' || r.type === 'numeric') exactColumns.set(r.table, [...(exactColumns.get(r.table) ?? []), r.column]);
  }
  return { direct, edges, primaryKeys, byteColumns, exactColumns, columnsOf };
}

/** Every path to a project: the direct columns, then contained tables, breadth first. */
function buildPaths(cat: Catalog): ProjectPath[] {
  const paths: ProjectPath[] = cat.direct.map((d) => ({ key: `${d.table}.${d.column}`, table: d.table, column: d.column }));
  const reached = new Set(paths.map((p) => p.table));
  let frontier = [...new Set(paths.map((p) => p.table))].filter((t) => !NOT_OWNERS.has(t));
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const e of cat.edges) {
      if (!frontier.includes(e.parent) || reached.has(e.child) || e.child === e.parent) continue;
      paths.push({ key: `${e.child}.(${e.columns.join(',')})->${e.parent}`, table: e.child, via: { parent: e.parent, columns: e.columns, parentColumns: e.parentColumns } });
      next.push(e.child);
    }
    for (const t of next) reached.add(t);
    frontier = [...new Set(next)].filter((t) => !NOT_OWNERS.has(t));
  }
  return paths;
}

/** SQL for the project id of row `alias` of `path.table`, following contained paths up to a direct one. */
function projectOf(path: ProjectPath, alias: string, paths: ProjectPath[], depth = 0): string {
  if (path.column) return `${alias}.${q(path.column)}`;
  const via = path.via!;
  // the parent's own path: its first direct path, else its first contained one (built in BFS order)
  const parent = paths.find((p) => p.table === via.parent && p.column && p.column === 'projectId')
    ?? paths.find((p) => p.table === via.parent && p.column)
    ?? paths.find((p) => p.table === via.parent)!;
  const pa = `p${depth}`;
  const join = via.columns.map((c, i) => `${pa}.${q(via.parentColumns[i])} = ${alias}.${q(c)}`).join(' AND ');
  return `(SELECT ${projectOf(parent, pa, paths, depth + 1)} FROM ${q(via.parent)} ${pa} WHERE ${join} LIMIT 1)`;
}

export async function inventoryProject(prisma: PrismaClient, projectId: string): Promise<ProjectInventory> {
  if (!projectId.trim()) throw new Error('a project id is required');
  return readOnlyTransaction(prisma, async (tx) => {
    const cat = await readCatalog(tx);
    const paths = buildPaths(cat);

    // byte columns become their length; exact numbers become strings (no JavaScript rounding)
    const rowJson = (table: string, alias: string): string => {
      const bytes = cat.byteColumns.get(table) ?? [];
      const exact = cat.exactColumns.get(table) ?? [];
      const strip = [...bytes, ...exact].map((b) => ` - ${lit(b)}`).join('');
      const extra = [
        `${lit('_table')}, ${lit(table)}`,
        ...bytes.map((b) => `${lit(`${b}Bytes`)}, octet_length(${alias}.${q(b)})`),
        ...exact.map((x) => `${lit(x)}, ${alias}.${q(x)}::text`),
      ].join(', ');
      return `(to_jsonb(${alias})${strip}) || jsonb_build_object(${extra})`;
    };
    const identityOf = (table: string, alias: string): string => {
      const pk = cat.primaryKeys.get(table);
      return pk ? pk.map((c) => `${alias}.${q(c)}::text`).join(` || '|' || `) : `md5((${rowJson(table, alias)})::text)`;
    };

    const [project] = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT ${rowJson('Project', 'p')} AS row FROM "Project" p WHERE p.id = $1`, projectId);

    const rows: ProjectInventory['rows'] = {};
    const counts: ProjectInventory['counts'] = {};
    const byProject: ProjectInventory['byProject'] = {};
    for (const path of paths) {
      const owner = projectOf(path, 't', paths);
      const found = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
        `SELECT ${rowJson(path.table, 't')} AS row FROM ${q(path.table)} t WHERE ${owner} = $1`, projectId);
      if (found.length) {
        rows[path.key] = found.map((f) => f.row);
        counts[path.key] = found.length;
      }
      const id = identityOf(path.table, 't');
      for (const g of await tx.$queryRawUnsafe<Array<{ projectId: string; n: number; identity: string }>>(
        `SELECT owner AS "projectId", count(*)::int AS n, md5(string_agg(rid, ',' ORDER BY rid)) AS identity
           FROM (SELECT ${owner} AS owner, ${id} AS rid FROM ${q(path.table)} t) s
          WHERE owner IS NOT NULL GROUP BY owner`)) {
        (byProject[g.projectId] ??= {})[path.key] = { rows: g.n, identity: g.identity };
      }
    }

    const userPointers = await tx.$queryRawUnsafe<ProjectInventory['userPointers']>(
      `SELECT id, email, name, "projectId", "lastProjectId" FROM "User"
        WHERE "projectId" = $1 OR "lastProjectId" = $1 ORDER BY email`, projectId);

    const files: StoredFile[] = [];
    for (const path of paths.filter((p) => cat.columnsOf.get(p.table)?.has('storageKey') && p.key in counts)) {
      const cols = cat.columnsOf.get(path.table)!;
      const bytes = cat.byteColumns.get(path.table) ?? [];
      const url = cols.has('url') ? 't."url"' : 'NULL';
      const inDb = bytes.length ? bytes.map((b) => `t.${q(b)} IS NOT NULL`).join(' OR ') : 'false';
      files.push(...await tx.$queryRawUnsafe<StoredFile[]>(
        `SELECT ${lit(path.table)} AS "table", t.id::text AS id, t."storageKey", ${url} AS url, (${inDb}) AS "bytesInDatabase"
           FROM ${q(path.table)} t WHERE ${projectOf(path, 't', paths)} = $1 ORDER BY t.id`, projectId));
    }

    const deleteTriggers: ProjectInventory['deleteTriggers'] = {};
    const held = [...new Set(paths.filter((p) => p.key in counts).map((p) => p.table))];
    if (project) held.push('Project');
    for (const r of await tx.$queryRawUnsafe<Array<{ table: string; trigger: string }>>(`
      SELECT c.relname::text AS "table", t.tgname::text AS "trigger"
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
       WHERE NOT t.tgisinternal AND (t.tgtype & 8) <> 0 AND c.relname = ANY($1::text[])
       ORDER BY 1, 2`, held)) {
      (deleteTriggers[r.table] ??= []).push(r.trigger);
    }

    return {
      projectId,
      readOnlyVerified: true as const,
      snapshot: 'repeatable read' as const,
      takenAt: new Date().toISOString(),
      project: project?.row ?? null,
      paths,
      rows,
      counts,
      byProject,
      userPointers,
      files,
      deleteTriggers,
    };
  });
}

/**
 * Save the full export. A missing project is refused before anything is written, so a mistyped id
 * or the wrong database never leaves a file that looks like evidence. The file is created new
 * (never overwritten) and readable by its owner only: it holds whole rows, credential hashes included.
 */
export function writeInventoryExport(inv: ProjectInventory, path: string): void {
  if (!inv.project) throw new Error(`project ${inv.projectId} does not exist in this database; nothing written`);
  writeFileSync(path, JSON.stringify(inv, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
