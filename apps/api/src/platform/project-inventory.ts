import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
 *     A reference the schema keeps without a foreign key is listed by hand in `LOGICAL_REFS`.
 *   - coverage: every other table is named in `unlinked` with its row count, so a table that holds
 *     a project's data by some reference the catalog cannot see is shown for review, never missed.
 *
 * It is the itemised list and the before/after proof, not a row export (that is a separate unit).
 * For the target: its row count per table, every user whose home or last project it is and every
 * stored file (any table with a `storageKey` column). For every project, its own `Project` row and,
 * per table, the row count and a hash of the sorted primary keys, so a later run proves no other
 * project lost or swapped a row, including a project that owns nothing else. Every value is
 * computed by PostgreSQL and comes back as a count, a hash, an id, a name or a flag: no row is read
 * into JavaScript, so nothing can be rounded. What a delete would meet (triggers, cascades) belongs
 * to the delete design, not to this list.
 *
 * Read-only is enforced by PostgreSQL, not by care: the whole run is one `REPEATABLE READ, READ
 * ONLY` transaction — one snapshot for every query, and any INSERT, UPDATE, DELETE or DDL fails —
 * and it refuses to continue unless the server confirms both.
 *
 * It reads every module's tables, so it is an operator tool, never module code: only
 * `project-inventory.cli.ts` imports it, and the server never loads either file. The module
 * boundary (no synchronous read of another module's tables) covers the files the server loads,
 * the same set `boundary-analyzer.ts` checks, which leaves out the CLI entrypoints (like
 * `outbox.cli.ts`). `project-inventory.boundary.test.ts` fails if the server ever imports it.
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
  project: { id: string; name: string; orgId: string; archivedAt: string | null } | null;
  /** every path by which a table can reach a project, from the catalog */
  paths: ProjectPath[];
  /** the target's row count per path key (non-zero only) */
  counts: Record<string, number>;
  /** every project's row count and identity hash per path key (its own row under `Project.id`), for the before/after comparison */
  byProject: Record<string, Record<string, RowIdentity>>;
  /** users whose home project (`User.projectId`) or last-used project (`User.lastProjectId`) is the target */
  userPointers: Array<{ id: string; email: string; name: string; projectId: string; lastProjectId: string | null }>;
  /** the target's stored files: every row with a `storageKey` column, and where its bytes live */
  files: StoredFile[];
  /** every table no path reaches, with its row count: not counted for any project, so reviewed by hand */
  unlinked: Array<{ table: string; rows: number }>;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
/** Tables that are pointed at a project but own nothing of it: never followed to their children. */
const NOT_OWNERS = new Set(['User', 'Project', 'Org']);
/**
 * References the schema keeps without a foreign key, followed like one. `_t4d_tx_transition` names a
 * `Decision` by `decisionId` and nothing else (migration 20271221000000_phase6_t4d_i_decision_facts).
 */
const LOGICAL_REFS: Catalog['edges'] = [
  { child: '_t4d_tx_transition', columns: ['decisionId'], parent: 'Decision', parentColumns: ['id'] },
];

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

export interface Catalog {
  direct: Array<{ table: string; column: string }>;
  edges: Array<{ child: string; columns: string[]; parent: string; parentColumns: string[] }>;
  primaryKeys: Map<string, string[]>;
  byteColumns: Map<string, string[]>;
  columnsOf: Map<string, Set<string>>;
  tables: string[];
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

export async function inventoryProject(prisma: PrismaClient, projectId: string): Promise<ProjectInventory> {
  if (!projectId.trim()) throw new Error('a project id is required');
  return readOnlyTransaction(prisma, async (tx) => {
    const cat = await readCatalog(tx);
    const paths = buildPaths(cat);

    const identityOf = (table: string, alias: string): string => {
      const pk = cat.primaryKeys.get(table);
      // a JSON array, so no key value can run into the next one; hashed whole when there is no key
      return pk ? `jsonb_build_array(${pk.map((c) => `${alias}.${q(c)}::text`).join(', ')})::text` : `md5(to_jsonb(${alias})::text)`;
    };

    const [project] = await tx.$queryRawUnsafe<Array<NonNullable<ProjectInventory['project']>>>(
      `SELECT id, name, "orgId", "archivedAt"::text AS "archivedAt" FROM "Project" WHERE id = $1`, projectId);

    // database ids are keys here: no prototype, so an id like `__proto__` is an entry like any other
    const byProject: ProjectInventory['byProject'] = Object.create(null);
    const entryOf = (id: string): Record<string, RowIdentity> => (byProject[id] ??= Object.create(null));
    // each project's own row, so a project that owns nothing else is still in the proof
    for (const g of await tx.$queryRawUnsafe<Array<{ projectId: string; identity: string }>>(
      `SELECT p.id AS "projectId", md5(jsonb_agg(${identityOf('Project', 'p')})::text) AS identity FROM "Project" p GROUP BY p.id`)) {
      entryOf(g.projectId)['Project.id'] = { rows: 1, identity: g.identity };
    }
    for (const path of paths) {
      const owner = projectOf(path, 't', paths);
      const id = identityOf(path.table, 't');
      for (const g of await tx.$queryRawUnsafe<Array<{ projectId: string; n: number; identity: string }>>(
        `SELECT owner AS "projectId", count(*)::int AS n, md5(jsonb_agg(rid ORDER BY rid)::text) AS identity
           FROM (SELECT ${owner} AS owner, ${id} AS rid FROM ${q(path.table)} t) s
          WHERE owner IS NOT NULL GROUP BY owner`)) {
        entryOf(g.projectId)[path.key] = { rows: g.n, identity: g.identity };
      }
    }
    const counts: ProjectInventory['counts'] = Object.fromEntries(
      Object.entries(byProject[projectId] ?? {}).filter(([key]) => key !== 'Project.id').map(([key, r]) => [key, r.rows]));

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
      takenAt: new Date().toISOString(),
      project: project ?? null,
      paths,
      counts,
      byProject,
      userPointers,
      files,
      unlinked,
    };
  });
}

/**
 * Save the inventory. A missing project is refused before anything is written, so a mistyped id or
 * the wrong database never leaves a file that looks like evidence. The file is written whole to a
 * private temporary file beside `path`, flushed to disk, and only then linked in at `path` — a link
 * never replaces an existing file — so an interrupted run leaves no partial file at `path`.
 */
export function writeInventoryExport(inv: ProjectInventory, path: string): void {
  if (!inv.project) throw new Error(`project ${inv.projectId} does not exist in this database; nothing written`);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      const data = Buffer.from(JSON.stringify(inv, null, 2) + '\n');
      // a write may take only part of the buffer (a full disk does this without throwing)
      for (let off = 0; off < data.length;) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, path);
  } finally {
    unlinkSync(tmp);
  }
}
