import type { PrismaClient } from '@prisma/client';

/**
 * #482 — a READ-ONLY inventory of everything one project owns or is pointed at by, the first step
 * of Board's plan to remove the archived `qa-test-356a` (#482 comment 6231979169).
 *
 * It finds the tables from the database catalog, not from a hand-kept list, so a table added later
 * can't be missed: every column named `projectId`, every other foreign key into `Project(id)`, and
 * `User.lastProjectId` (a plain stamp with no key). For the target project it exports every matching
 * row (byte columns are replaced by their length; photo bytes stay in the database), every user
 * whose home or last project it is, and every Media storage key. For every project it counts the
 * same columns, so a later run can prove that no other project lost a row.
 *
 * Read-only is enforced by PostgreSQL, not by care: the whole run is one `READ ONLY` transaction
 * (any INSERT, UPDATE, DELETE or DDL inside it fails), and the run refuses to continue unless the
 * server confirms `transaction_read_only = on`.
 */

export interface ProjectColumn {
  table: string;
  column: string;
}

export interface ProjectInventory {
  projectId: string;
  readOnlyVerified: true;
  takenAt: string;
  project: Record<string, unknown> | null;
  /** every (table, column) that can hold a project id, from the catalog */
  columns: ProjectColumn[];
  /** rows that point at the target project, per `table.column`; tables with none are left out */
  rows: Record<string, Array<Record<string, unknown>>>;
  /** row counts per `table.column` for the target project (non-zero only) */
  counts: Record<string, number>;
  /** row counts for every project in the database, for the before/after comparison (non-zero only) */
  countsByProject: Record<string, Record<string, number>>;
  /** users whose home project (`User.projectId`) or last-used project (`User.lastProjectId`) is the target */
  userPointers: Array<{ id: string; email: string; name: string; projectId: string; lastProjectId: string | null }>;
  /** the target's photos and files: where each one's bytes live */
  media: Array<{ id: string; kind: string; storageKey: string | null; url: string | null; sizeBytes: number; bytesInDatabase: boolean }>;
  /** user triggers that fire on DELETE, per table holding target rows (what a delete would meet) */
  deleteTriggers: Record<string, string[]>;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const key = (c: ProjectColumn): string => `${c.table}.${c.column}`;

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Run `fn` in one transaction PostgreSQL itself holds read-only: any write inside it fails. */
export async function readOnlyTransaction<T>(prisma: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // Must be the first statement of the transaction; PostgreSQL then refuses every write.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const [{ transaction_read_only: ro }] = await tx.$queryRawUnsafe<Array<{ transaction_read_only: string }>>('SHOW transaction_read_only');
      if (ro !== 'on') throw new Error('refusing to run: the transaction is not read-only');
      return fn(tx);
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
}

export async function inventoryProject(prisma: PrismaClient, projectId: string): Promise<ProjectInventory> {
  if (!projectId.trim()) throw new Error('a project id is required');
  return readOnlyTransaction(prisma, async (tx) => {
    const columns = await tx.$queryRawUnsafe<ProjectColumn[]>(`
      SELECT table_name AS "table", column_name AS "column"
        FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'projectId' AND table_name <> 'Project'
      UNION
      SELECT src.relname AS "table", a.attname AS "column"
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

    const [project] = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
      'SELECT to_jsonb(p) AS row FROM "Project" p WHERE p.id = $1', projectId);

    const byteColumns = new Map<string, string[]>();
    for (const r of await tx.$queryRawUnsafe<Array<{ table: string; column: string }>>(`
      SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
       WHERE table_schema = current_schema() AND data_type = 'bytea'`)) {
      byteColumns.set(r.table, [...(byteColumns.get(r.table) ?? []), r.column]);
    }

    const rows: ProjectInventory['rows'] = {};
    const counts: ProjectInventory['counts'] = {};
    const countsByProject: ProjectInventory['countsByProject'] = {};
    for (const c of columns) {
      const bytes = byteColumns.get(c.table) ?? [];
      const strip = bytes.map((b) => ` - '${b.replace(/'/g, "''")}'`).join('');
      const lengths = bytes.map((b) => `, '${b.replace(/'/g, "''")}Bytes', octet_length(t.${q(b)})`).join('');
      const found = await tx.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
        `SELECT (to_jsonb(t)${strip}) || jsonb_build_object('_table', '${c.table.replace(/'/g, "''")}'${lengths}) AS row
           FROM ${q(c.table)} t WHERE t.${q(c.column)} = $1`, projectId);
      if (found.length) {
        rows[key(c)] = found.map((f) => f.row);
        counts[key(c)] = found.length;
      }
      for (const g of await tx.$queryRawUnsafe<Array<{ projectId: string; n: number }>>(
        `SELECT t.${q(c.column)} AS "projectId", count(*)::int AS n FROM ${q(c.table)} t
          WHERE t.${q(c.column)} IS NOT NULL GROUP BY 1`)) {
        (countsByProject[g.projectId] ??= {})[key(c)] = g.n;
      }
    }

    const userPointers = await tx.$queryRawUnsafe<ProjectInventory['userPointers']>(
      `SELECT id, email, name, "projectId", "lastProjectId" FROM "User"
        WHERE "projectId" = $1 OR "lastProjectId" = $1 ORDER BY email`, projectId);
    const media = await tx.$queryRawUnsafe<ProjectInventory['media']>(
      `SELECT id, kind, "storageKey", url, "sizeBytes", (data IS NOT NULL) AS "bytesInDatabase"
         FROM "Media" WHERE "projectId" = $1 ORDER BY id`, projectId);

    const deleteTriggers: ProjectInventory['deleteTriggers'] = {};
    const held = [...new Set(Object.keys(counts).map((k) => k.split('.')[0]))];
    if (project) held.push('Project');
    for (const r of await tx.$queryRawUnsafe<Array<{ table: string; trigger: string }>>(`
      SELECT c.relname AS "table", t.tgname AS "trigger"
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
       WHERE NOT t.tgisinternal AND (t.tgtype & 8) <> 0 AND c.relname = ANY($1::text[])
       ORDER BY 1, 2`, held)) {
      (deleteTriggers[r.table] ??= []).push(r.trigger);
    }

    return {
      projectId,
      readOnlyVerified: true as const,
      takenAt: new Date().toISOString(),
      project: project?.row ?? null,
      columns,
      rows,
      counts,
      countsByProject,
      userPointers,
      media,
      deleteTriggers,
    };
  });
}
