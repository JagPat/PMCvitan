import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * #482 — a READ-ONLY snapshot of every table's row keys, the record and the proof around Board's
 * removal of the archived `qa-test-356a` (Option B on #482, 6235196331).
 *
 * For every table in the schema it records the row count, the full sorted list of row keys (the
 * primary key as a JSON array of PostgreSQL's own text for each column, or, for a table without
 * one, the md5 of the whole row) and, beside each key, the md5 of the whole row. It records no row
 * contents. Two snapshots of the same database, taken before and after a removal, are compared
 * with `diffSnapshots`: the keys that disappeared are exactly what the removal deleted, and any
 * other change, in any table, shows: a row added, removed, or kept with different contents.
 * Nothing here decides which project a row belongs to, so a reference the schema keeps without a
 * foreign key cannot hide a row from the comparison.
 *
 * The comparison is only for two snapshots one process took on one connection, before and after
 * its own removal: then both come from the same database, in that order. Nothing compares files.
 *
 * Every key is text produced by PostgreSQL; nothing is parsed as a number, so nothing can be
 * rounded. The time is PostgreSQL's, read in the statement that takes the snapshot.
 *
 * Read-only is enforced by PostgreSQL: the whole run is one `REPEATABLE READ, READ ONLY`
 * transaction, and it refuses to continue unless the server confirms both. It reads every module's
 * tables, so it is an operator tool, never module code: only operator CLIs import it, and
 * `db-snapshot.boundary.test.ts` fails if the server ever loads it.
 */

export interface TableSnapshot {
  rows: number;
  /** the primary-key columns, or null when the table has none and rows are keyed by content */
  key: string[] | null;
  /** every row's key, sorted; a key repeats when rows without a primary key are identical */
  keys: string[];
  /** the md5 of each row's contents, in the order of `keys` */
  digests: string[];
}

export interface DatabaseSnapshot {
  readOnlyVerified: true;
  snapshot: 'repeatable read';
  /** PostgreSQL's clock when the snapshot was taken */
  takenAt: string;
  database: string;
  schema: string;
  tables: Record<string, TableSnapshot>;
}

export interface TableChange {
  table: string;
  /** keys in `before` and not in `after` (each repeat counted) */
  removed: string[];
  /** keys in `after` and not in `before` */
  added: string[];
  /** keys in both whose row contents differ (tables with a primary key) */
  changed: string[];
  /** the table exists in only one of the two snapshots */
  onlyIn?: 'before' | 'after';
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export async function snapshotDatabase(prisma: PrismaClient): Promise<DatabaseSnapshot> {
  return prisma.$transaction(
    async (tx: Tx) => {
      // Must come before any query of the transaction; PostgreSQL then refuses every write.
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      // the first query takes the snapshot, so its clock is the snapshot's time
      const [{ ro, iso, takenAt, database, schema }] = await tx.$queryRawUnsafe<Array<{ ro: string; iso: string; takenAt: string; database: string; schema: string }>>(
        `SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso,
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "takenAt",
                current_database() AS database, current_schema() AS schema`);
      if (ro !== 'on' || iso !== 'repeatable read') {
        throw new Error(`refusing to run: the transaction is not a repeatable-read, read-only one (${iso}, read_only=${ro})`);
      }
      const tables = await tx.$queryRawUnsafe<Array<{ table: string; key: string[] | null }>>(`
        SELECT c.relname::text AS "table",
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM pg_index i
                  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                 WHERE i.indrelid = c.oid AND i.indisprimary) AS key
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
         WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
         ORDER BY 1`);
      // keyed by table name with no prototype, so no table name can resolve to an inherited property
      const out: Record<string, TableSnapshot> = Object.create(null);
      for (const { table, key } of tables) {
        // a JSON array of each column's text, so no key value can run into the next one
        const rid = key ? `jsonb_build_array(${key.map((c) => `t.${q(c)}::text`).join(', ')})::text` : 'md5(to_jsonb(t)::text)';
        // the digest beside each key shows a row kept under its key with different contents
        const [{ keys, digests }] = await tx.$queryRawUnsafe<Array<{ keys: string[] | null; digests: string[] | null }>>(
          `SELECT array_agg(rid ORDER BY rid COLLATE "C", dig COLLATE "C") AS keys, array_agg(dig ORDER BY rid COLLATE "C", dig COLLATE "C") AS digests
             FROM (SELECT ${rid} AS rid, md5(to_jsonb(t)::text) AS dig FROM ${q(table)} t) s`);
        out[table] = { rows: keys?.length ?? 0, key, keys: keys ?? [], digests: digests ?? [] };
      }
      return { readOnlyVerified: true as const, snapshot: 'repeatable read' as const, takenAt, database, schema, tables: out };
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
}

/** Count each key, so identical rows of a table without a primary key are compared as a multiset. */
function tally(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** Keys in `a` beyond their count in `b`, each repeat listed. */
function beyond(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) for (let i = b.get(k) ?? 0; i < n; i++) out.push(k);
  return out.sort();
}

/** Each key's digest, for a table whose keys are unique (a primary key); null otherwise. */
function digestsByKey(s: TableSnapshot | undefined): Map<string, string> | null {
  if (!s?.key) return null;
  const m = new Map<string, string>();
  s.keys.forEach((k, i) => m.set(k, s.digests[i]));
  return m;
}

/**
 * Every table whose rows differ between two snapshots, with the exact keys removed, added, and
 * kept with different contents.
 */
export function diffSnapshots(before: Pick<DatabaseSnapshot, 'tables'>, after: Pick<DatabaseSnapshot, 'tables'>): TableChange[] {
  const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort();
  const changes: TableChange[] = [];
  for (const table of names) {
    const b = Object.hasOwn(before.tables, table) ? before.tables[table] : undefined;
    const a = Object.hasOwn(after.tables, table) ? after.tables[table] : undefined;
    const tb = tally(b?.keys ?? []);
    const ta = tally(a?.keys ?? []);
    const db = digestsByKey(b);
    const da = digestsByKey(a);
    const changed: string[] = [];
    if (db && da) for (const [k, d] of db) if (da.has(k) && da.get(k) !== d) changed.push(k);
    const change: TableChange = { table, removed: beyond(tb, ta), added: beyond(ta, tb), changed: changed.sort() };
    if (!b || !a) change.onlyIn = b ? 'before' : 'after';
    if (change.removed.length || change.added.length || change.changed.length || change.onlyIn) changes.push(change);
  }
  return changes;
}

/**
 * Write `value` as JSON to `path`, whole or not at all: a private temporary file beside `path`,
 * every byte written, flushed to disk, and only then linked in at `path` — a link never replaces an
 * existing file — so an interrupted run leaves no partial file at `path`.
 */
export function writeJsonAtomically(value: unknown, path: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      const data = Buffer.from(JSON.stringify(value, null, 2) + '\n');
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
