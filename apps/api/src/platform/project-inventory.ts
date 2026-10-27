import type { PrismaClient } from '@prisma/client';
import { rowKeySql, writeJsonAtomically } from './db-snapshot';

/**
 * #482 — B2 of Option B: a READ-ONLY, itemised list of every row one project owns or is pointed at
 * by, the list the coordinator checks Board's removal of the archived `qa-test-356a` against
 * (#482 comments 6235196331, 6237197604).
 *
 * Each row is listed by the same key `db:snapshot` records (`rowKeySql`), table by table, so the
 * removal run can check every key its before/after snapshots show removed or changed against this
 * list, and fail loudly on any key that is not on it. The list does not have to be complete for the
 * removal to be safe: a row it misses shows up in that comparison as a removal off the list.
 *
 * The tables come from the database catalog, not from a hand-kept list, so a table added later
 * can't be missed:
 *   - direct: every column named `projectId`, every other foreign key into `Project(id)`, and
 *     `User.lastProjectId` (a plain stamp with no key);
 *   - contained: any table whose foreign key reaches a table already found (an `InspectionItem`
 *     through its `Inspection`, a `CrewRow` through its `DailyLog`), followed until nothing new
 *     appears. `User` is never followed: a user is pointed at a project, it is not owned by one.
 *     A reference the schema keeps without a foreign key is listed by hand in `LOGICAL_REFS`.
 *   - coverage: every other table is named in `unlinked` with its row count, for review by hand.
 *
 * For the project it gives: its own `Project` row and, per table, the sorted keys of its rows; the
 * users whose home or last project it is; and every stored file (any column named `storageKey`, or
 * `<what>StorageKey` such as a video's still frame `posterStorageKey`, #995) with where its bytes live. Every key is text PostgreSQL produced; nothing is parsed as a
 * number. What a delete would meet (triggers, cascades) belongs to the delete design, not to this
 * list.
 *
 * Read-only is enforced by PostgreSQL, not by care: the whole run is one `REPEATABLE READ, READ
 * ONLY` transaction — one snapshot for every query, and any INSERT, UPDATE, DELETE or DDL fails —
 * and it refuses to continue unless the server confirms both.
 *
 * It reads every module's tables, so it is an operator tool, never module code: only
 * `project-inventory.cli.ts` imports it, and `project-inventory.boundary.test.ts` fails if the
 * server ever loads it.
 */

/** How a table reaches a project: directly through `column`, or through `via`'s row. */
export interface ProjectPath {
  /** `table.column` for a direct path, `table.(cols)->parent` for a contained one */
  key: string;
  table: string;
  column?: string;
  via?: { parent: string; columns: string[]; parentColumns: string[] };
}

export interface StoredFile {
  table: string;
  id: string;
  /** the column naming the file: `storageKey`, or another `*StorageKey` column such as `posterStorageKey` */
  column: string;
  storageKey: string | null;
  url: string | null;
  bytesInDatabase: boolean;
}

export interface ProjectInventory {
  projectId: string;
  readOnlyVerified: true;
  snapshot: 'repeatable read';
  /** PostgreSQL's clock when the snapshot was taken */
  takenAt: string;
  database: string;
  schema: string;
  project: { id: string; name: string; orgId: string; archivedAt: string | null } | null;
  /** every path by which a table can reach a project, from the catalog */
  paths: ProjectPath[];
  /** per table, the sorted keys (as `db:snapshot` records them) of the project's rows, its own `Project` row included */
  keys: Record<string, string[]>;
  /** per table, how many keys `keys` lists */
  counts: Record<string, number>;
  /** users whose home project (`User.projectId`) or last-used project (`User.lastProjectId`) is the target */
  userPointers: Array<{ key: string; id: string; email: string; projectId: string; lastProjectId: string | null }>;
  /** the project's stored files: every row with a `storageKey` column, every non-null `*StorageKey` (a video's
   *  still frame), and where its bytes live */
  files: StoredFile[];
  /** every table no path reaches, with its row count: listed for no project, so reviewed by hand */
  unlinked: Array<{ table: string; rows: number }>;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
/** Tables that are pointed at a project but own nothing of it: never followed to their children. */
const NOT_OWNERS = new Set(['User', 'Project', 'Org']);
/**
 * References the schema keeps without a foreign key, followed like one:
 *   - `_t4d_tx_transition` names a `Decision` by `decisionId` (migration
 *     20271221000000_phase6_t4d_i_decision_facts);
 *   - `ProcessedEvent` names the `DomainEvent` a consumer handled by `eventId` (`relay.service.ts`).
 */
const LOGICAL_REFS: Catalog['edges'] = [
  { child: '_t4d_tx_transition', columns: ['decisionId'], parent: 'Decision', parentColumns: ['id'] },
  { child: 'ProcessedEvent', columns: ['eventId'], parent: 'DomainEvent', parentColumns: ['eventId'] },
];

/** A column that names a file in object storage: `storageKey`, or `<what>StorageKey` (#995: `Media.posterStorageKey`). */
const isStorageKeyColumn = (column: string): boolean => column === 'storageKey' || column.endsWith('StorageKey');

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface SnapshotIdentity { takenAt: string; database: string; schema: string }

/** Run `fn` in one transaction PostgreSQL itself holds read-only on one snapshot: any write fails. */
export async function readOnlyTransaction<T>(prisma: PrismaClient, fn: (tx: Tx, id: SnapshotIdentity) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // Must come before any query of the transaction; PostgreSQL then refuses every write.
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      // the first query takes the snapshot, so its clock is the snapshot's time
      const [{ ro, iso, ...id }] = await tx.$queryRawUnsafe<Array<{ ro: string; iso: string } & SnapshotIdentity>>(
        `SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso,
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "takenAt",
                current_database() AS database, current_schema() AS schema`);
      if (ro !== 'on' || iso !== 'repeatable read') {
        throw new Error(`refusing to run: the transaction is not a repeatable-read, read-only one (${iso}, read_only=${ro})`);
      }
      return fn(tx, id);
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
}

export interface Catalog {
  direct: Array<{ table: string; column: string }>;
  edges: Array<{ child: string; columns: string[]; parent: string; parentColumns: string[] }>;
  primaryKeys: Map<string, string[]>;
  byteColumns: Map<string, string[]>;
  columnsOf: Map<string, Set<string>>;
  tables: string[];
}

export async function readCatalog(tx: Tx): Promise<Catalog> {
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
  const keyed = await tx.$queryRawUnsafe<Catalog['edges']>(`
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
  const tables = (await tx.$queryRawUnsafe<Array<{ table: string }>>(`
    SELECT c.relname::text AS "table" FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`)).map((r) => r.table);
  // a hand-listed reference is followed only while its table exists, and never twice
  const edges = [...keyed, ...LOGICAL_REFS.filter((l) => tables.includes(l.child) && tables.includes(l.parent)
    && !keyed.some((k) => k.child === l.child && k.parent === l.parent))];
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
  const columnsOf = new Map<string, Set<string>>();
  for (const r of await tx.$queryRawUnsafe<Array<{ table: string; column: string; type: string }>>(`
    SELECT table_name AS "table", column_name AS "column", data_type AS type
      FROM information_schema.columns WHERE table_schema = current_schema()`)) {
    (columnsOf.get(r.table) ?? columnsOf.set(r.table, new Set()).get(r.table)!).add(r.column);
    if (r.type === 'bytea') byteColumns.set(r.table, [...(byteColumns.get(r.table) ?? []), r.column]);
  }
  return { direct, edges, primaryKeys, byteColumns, columnsOf, tables };
}

/** Every path to a project: the direct columns, then contained tables, breadth first until none is left. */
export function buildPaths(cat: Pick<Catalog, 'direct' | 'edges'>): ProjectPath[] {
  const paths: ProjectPath[] = cat.direct.map((d) => ({ key: `${d.table}.${d.column}`, table: d.table, column: d.column }));
  const reached = new Set(paths.map((p) => p.table));
  let frontier = [...new Set(paths.map((p) => p.table))].filter((t) => !NOT_OWNERS.has(t));
  // `reached` holds each table once, so a cycle in the key graph ends the walk
  while (frontier.length) {
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

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function inventoryProject(prisma: PrismaClient, projectId: string): Promise<ProjectInventory> {
  if (!projectId.trim()) throw new Error('a project id is required');
  return readOnlyTransaction(prisma, (tx, id) => collectInventory(tx, id, projectId));
}

/**
 * The inventory of `projectId` as `tx` sees it. `inventoryProject` runs it read-only; the removal
 * command runs it inside its own transaction, so the list it deletes by is the one it just read.
 */
export async function collectInventory(tx: Tx, id: SnapshotIdentity, projectId: string): Promise<ProjectInventory> {
  const cat = await readCatalog(tx);
  const paths = buildPaths(cat);
  const keyOf = (table: string, alias: string): string => rowKeySql(cat.primaryKeys.get(table) ?? null, alias);

  const [project] = await tx.$queryRawUnsafe<Array<NonNullable<ProjectInventory['project']>>>(
    `SELECT id, name, "orgId", "archivedAt"::text AS "archivedAt" FROM "Project" WHERE id = $1`, projectId);

  // table names are keys here: no prototype, so no table name can resolve to an inherited property
  const sets: Record<string, Set<string>> = Object.create(null);
  const add = (table: string, ks: string[] | null): void => {
    if (!ks?.length) return;
    const s = (sets[table] ??= new Set());
    for (const k of ks) s.add(k);
  };
  add('Project', (await tx.$queryRawUnsafe<Array<{ k: string }>>(
    `SELECT ${keyOf('Project', 'p')} AS k FROM "Project" p WHERE p.id = $1`, projectId)).map((r) => r.k));
  // a table reached by several paths lists a row once, whichever path finds it
  for (const path of paths) {
    const [{ ks }] = await tx.$queryRawUnsafe<Array<{ ks: string[] | null }>>(
      `SELECT array_agg(rid) AS ks FROM (SELECT ${projectOf(path, 't', paths)} AS owner, ${keyOf(path.table, 't')} AS rid FROM ${q(path.table)} t) s
        WHERE owner = $1`, projectId);
    add(path.table, ks);
  }
  const keys: ProjectInventory['keys'] = Object.create(null);
  const counts: ProjectInventory['counts'] = Object.create(null);
  for (const table of Object.keys(sets).sort(byCodeUnit)) {
    keys[table] = [...sets[table]].sort(byCodeUnit);
    counts[table] = keys[table].length;
  }

  const userPointers = await tx.$queryRawUnsafe<ProjectInventory['userPointers']>(
    `SELECT ${keyOf('User', 'u')} AS key, u.id, u.email, u."projectId", u."lastProjectId" FROM "User" u
      WHERE u."projectId" = $1 OR u."lastProjectId" = $1 ORDER BY u.email`, projectId);

  const files: StoredFile[] = [];
  for (const path of paths) {
    const cols = cat.columnsOf.get(path.table) ?? new Set<string>();
    if (cols.has('storageKey')) {
      const bytes = cat.byteColumns.get(path.table) ?? [];
      const url = cols.has('url') ? 't."url"' : 'NULL';
      const inDb = bytes.length ? bytes.map((b) => `t.${q(b)} IS NOT NULL`).join(' OR ') : 'false';
      files.push(...await tx.$queryRawUnsafe<StoredFile[]>(
        `SELECT ${lit(path.table)} AS "table", t.id::text AS id, 'storageKey' AS "column", t."storageKey", ${url} AS url, (${inDb}) AS "bytesInDatabase"
           FROM ${q(path.table)} t WHERE ${projectOf(path, 't', paths)} = $1 ORDER BY t.id`, projectId));
    }
    // #995 — a second file a row names, such as a video's still frame: listed only where the row has one, and its bytes
    // are always in object storage
    for (const column of [...cols].filter((c) => c !== 'storageKey' && isStorageKeyColumn(c)).sort(byCodeUnit)) {
      files.push(...await tx.$queryRawUnsafe<StoredFile[]>(
        `SELECT ${lit(path.table)} AS "table", t.id::text AS id, ${lit(column)} AS "column", t.${q(column)}::text AS "storageKey", NULL AS url, false AS "bytesInDatabase"
           FROM ${q(path.table)} t WHERE ${projectOf(path, 't', paths)} = $1 AND t.${q(column)} IS NOT NULL ORDER BY t.id`, projectId));
    }
  }

  const reached = new Set(['Project', ...paths.map((p) => p.table)]);
  const unlinked: ProjectInventory['unlinked'] = [];
  for (const table of cat.tables.filter((t) => !reached.has(t))) {
    const [{ n }] = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${q(table)}`);
    unlinked.push({ table, rows: n });
  }

  return {
    projectId,
    readOnlyVerified: true as const,
    snapshot: 'repeatable read' as const,
    ...id,
    project: project ?? null,
    paths,
    keys,
    counts,
    userPointers,
    files,
    unlinked,
  };
}

/**
 * Save the inventory. A missing project is refused before anything is written, so a mistyped id or
 * the wrong database never leaves a file that looks like evidence. The file is written owner-only
 * and whole, never over an existing file (`writeJsonAtomically`).
 */
export function writeInventoryExport(inv: ProjectInventory, path: string): void {
  if (!inv.project) throw new Error(`project ${inv.projectId} does not exist in this database; nothing written`);
  writeJsonAtomically(inv, path);
}
