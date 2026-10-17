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
 *
 * It is the itemised list and the before/after proof, not a row export (that is a separate unit).
 * For the target: its row count per table, every user whose home or last project it is, every
 * stored file (any table with a `storageKey` column) and every delete trigger with its enabled
 * state. For every project, per table: the row count and a hash of the sorted primary keys, so a
 * later run proves no other project lost or swapped a row. Every value is computed by PostgreSQL
 * and comes back as a count, a hash, an id, a name or a flag: no row is read into JavaScript, so
 * nothing can be rounded.
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

/** A trigger that fires on DELETE, with `pg_trigger.tgenabled` and whether it fires in this session. */
export interface DeleteTrigger {
  trigger: string;
  /** O = fires (origin/local role), A = always, R = replica role only, D = disabled */
  enabled: 'O' | 'A' | 'R' | 'D';
  /** whether it fires under this session's `session_replication_role` */
  firesInThisSession: boolean;
}

export interface ProjectInventory {
  projectId: string;
  readOnlyVerified: true;
  snapshot: 'repeatable read';
  takenAt: string;
  sessionReplicationRole: string;
  project: { id: string; name: string; orgId: string; archivedAt: string | null } | null;
  /** every path by which a table can reach a project, from the catalog */
  paths: ProjectPath[];
  /** the target's row count per path key (non-zero only) */
  counts: Record<string, number>;
  /** every project's row count and identity hash per path key, for the before/after comparison */
  byProject: Record<string, Record<string, RowIdentity>>;
  /** users whose home project (`User.projectId`) or last-used project (`User.lastProjectId`) is the target */
  userPointers: Array<{ id: string; email: string; name: string; projectId: string; lastProjectId: string | null }>;
  /** the target's stored files: every row with a `storageKey` column, and where its bytes live */
  files: StoredFile[];
  /** triggers that fire on DELETE, per table holding target rows (what a delete would meet) */
  deleteTriggers: Record<string, DeleteTrigger[]>;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
/** Tables that are pointed at a project but own nothing of it: never followed to their children. */
const NOT_OWNERS = new Set(['User', 'Project', 'Org']);

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
  const columnsOf = new Map<string, Set<string>>();
  for (const r of await tx.$queryRawUnsafe<Array<{ table: string; column: string; type: string }>>(`
    SELECT table_name AS "table", column_name AS "column", data_type AS type
      FROM information_schema.columns WHERE table_schema = current_schema()`)) {
    (columnsOf.get(r.table) ?? columnsOf.set(r.table, new Set()).get(r.table)!).add(r.column);
    if (r.type === 'bytea') byteColumns.set(r.table, [...(byteColumns.get(r.table) ?? []), r.column]);
  }
  return { direct, edges, primaryKeys, byteColumns, columnsOf };
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

    const byProject: ProjectInventory['byProject'] = {};
    for (const path of paths) {
      const owner = projectOf(path, 't', paths);
      const id = identityOf(path.table, 't');
      for (const g of await tx.$queryRawUnsafe<Array<{ projectId: string; n: number; identity: string }>>(
        `SELECT owner AS "projectId", count(*)::int AS n, md5(jsonb_agg(rid ORDER BY rid)::text) AS identity
           FROM (SELECT ${owner} AS owner, ${id} AS rid FROM ${q(path.table)} t) s
          WHERE owner IS NOT NULL GROUP BY owner`)) {
        (byProject[g.projectId] ??= {})[path.key] = { rows: g.n, identity: g.identity };
      }
    }
    const counts: ProjectInventory['counts'] = Object.fromEntries(
      Object.entries(byProject[projectId] ?? {}).map(([key, r]) => [key, r.rows]));

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
    const [{ role }] = await tx.$queryRawUnsafe<Array<{ role: string }>>("SELECT current_setting('session_replication_role') AS role");
    for (const r of await tx.$queryRawUnsafe<Array<{ table: string } & DeleteTrigger>>(`
      SELECT c.relname::text AS "table", t.tgname::text AS "trigger", t.tgenabled::text AS enabled,
             CASE t.tgenabled WHEN 'A' THEN true WHEN 'D' THEN false
               WHEN 'R' THEN current_setting('session_replication_role') = 'replica'
               ELSE current_setting('session_replication_role') <> 'replica' END AS "firesInThisSession"
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
       WHERE NOT t.tgisinternal AND (t.tgtype & 8) <> 0 AND c.relname = ANY($1::text[])
       ORDER BY 1, 2`, held)) {
      (deleteTriggers[r.table] ??= []).push({ trigger: r.trigger, enabled: r.enabled, firesInThisSession: r.firesInThisSession });
    }

    return {
      projectId,
      readOnlyVerified: true as const,
      snapshot: 'repeatable read' as const,
      takenAt: new Date().toISOString(),
      sessionReplicationRole: role,
      project: project ?? null,
      paths,
      counts,
      byProject,
      userPointers,
      files,
      deleteTriggers,
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
      writeSync(fd, JSON.stringify(inv, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, path);
  } finally {
    unlinkSync(tmp);
  }
}
