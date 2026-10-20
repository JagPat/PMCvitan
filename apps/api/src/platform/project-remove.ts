import { closeSync, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { diffSnapshots, rowKeySql, snapshotTables, type TableChange, type TableSnapshot, type Tx } from './db-snapshot';
import { collectInventory, readCatalog, type ProjectInventory, type SnapshotIdentity, type StoredFile } from './project-inventory';

/**
 * #482 — step 3 of Option B: remove one project, row by row, from the list Board reviewed (B2,
 * `project:inventory`), and prove it (comments 6239955975, 6240007524, 6240658704).
 *
 * Everything happens in ONE `SERIALIZABLE` transaction on one connection:
 *   1. refuse, before any write, unless the target is archived, the list rebuilt now matches the
 *      reviewed file key for key, every user whose home project is the target is a QA account
 *      (`QA_EMAIL`) and already holds an active membership on the project they move to, and no
 *      delivery of the project is leased or was touched in `OUTBOX_QUIET_MINUTES` (it may be mid-send);
 *   2. snapshot every table (`snapshotTables`) and the protected projects' inventories;
 *   3. move those users' home project, clear `lastProjectId` where it names the target, switch off
 *      the DELETE triggers of the tables being emptied, delete exactly the listed keys child-first,
 *      switch the triggers back on as they were, and fire every deferred constraint now;
 *   4. snapshot again and check (`checkRemoval`): removed keys equal the list, the only changed
 *      rows are those users, nothing was added, no protected project lost or changed a row, and
 *      every trigger in the schema is as it was;
 *   5. commit only with `commit` set and every check passed; otherwise roll back.
 *
 * A dry run (the default) does all of it and always rolls back, so its record shows exactly what
 * a commit would do. Nothing is decided by row contents: every key is the one `db:snapshot`
 * records. Object-storage files are listed in the record and left alone.
 *
 * It writes every module's tables, so it is an operator tool, never module code: only
 * `project-remove.cli.ts` imports it, and `project-remove.boundary.test.ts` fails if the server
 * ever loads it.
 */

/** How long every outbox delivery of the target must have been untouched: far past any send. */
export const OUTBOX_QUIET_MINUTES = 15;

/** The only accounts the run may touch: Board's ruling on #482, 6240658704. */
export const QA_EMAIL = /^qa\.[a-z]+@vitan\.in$/;

export interface RemovalOptions {
  projectId: string;
  /** the B2 inventory Board reviewed (`project:inventory --out`) */
  inventory: ProjectInventory;
  /** projects that must lose and change nothing */
  protect: string[];
  /** where users whose home project is the target move; one of `protect` */
  rehomeTo: string | null;
  commit: boolean;
}

export interface TriggerState { table: string; name: string; enabled: string; definition: string; onDelete: boolean }

export interface RemovalRecord {
  ok: boolean;
  mode: 'dry-run' | 'commit';
  outcome: 'committed' | 'rolled back' | 'refused' | 'failed';
  /** why the run refused or failed, when it did */
  reason?: string;
  /** every check that did not hold; empty when all did */
  failures: string[];
  projectId: string;
  project?: ProjectInventory['project'];
  database?: string;
  schema?: string;
  /** PostgreSQL's clock at the start of the transaction */
  startedAt?: string;
  /** the reviewed file's own snapshot time; the run refuses unless its list matches the database's now */
  inventoryTakenAt?: string;
  /** every listed `User` row, by the path that links it: users are pointed at the project, never removed */
  users: Array<{ key: string; id: string; email: string; projectId: string; lastProjectId: string | null; linkedBy: string }>;
  rehomed: Array<{ id: string; email: string; fromProjectId: string; toProjectId: string; lastProjectId: string | null }>;
  lastProjectCleared: Array<{ id: string; email: string }>;
  counts: Record<string, { before: number; after: number }>;
  deleted: Record<string, number>;
  removed: Record<string, string[]>;
  changed: Record<string, string[]>;
  added: Record<string, string[]>;
  protected: Array<{ projectId: string; removed: string[]; changed: string[]; keysUnchanged: boolean }>;
  /** every table no project path reaches (global tables: Org, OrgMembership, UserIdentity, …): none may change */
  unlinked: Array<{ table: string; before: number; after: number; unchanged: boolean }>;
  triggers: { disabled: Array<{ table: string; name: string; enabled: string }>; compared: number; restored: boolean };
  /** the target's stored files: object storage is not touched */
  files: StoredFile[];
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort(byCodeUnit);

class Refusal extends Error {}
/** Thrown to roll the transaction back with the record it built. */
class Rollback extends Error {
  constructor(readonly record: RemovalRecord) { super('rolled back'); }
}

function emptyRecord(opts: RemovalOptions): RemovalRecord {
  return {
    ok: false, mode: opts.commit ? 'commit' : 'dry-run', outcome: 'failed', failures: [], projectId: opts.projectId,
    users: [], rehomed: [], lastProjectCleared: [], unlinked: [], counts: Object.create(null), deleted: Object.create(null),
    removed: Object.create(null), changed: Object.create(null), added: Object.create(null), protected: [],
    triggers: { disabled: [], compared: 0, restored: false }, files: [],
  };
}

/** The keys of two lists, table by table, that only one of them has. */
function keyDifferences(a: Record<string, string[]>, b: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const table of sorted(new Set([...Object.keys(a), ...Object.keys(b)]))) {
    const sa = new Set(Object.hasOwn(a, table) ? a[table] : []);
    const sb = new Set(Object.hasOwn(b, table) ? b[table] : []);
    const onlyA = [...sa].filter((k) => !sb.has(k));
    const onlyB = [...sb].filter((k) => !sa.has(k));
    if (onlyA.length || onlyB.length) out.push(`${table}: ${onlyA.length} only in the first, ${onlyB.length} only in the second`);
  }
  return out;
}

export interface RemovalCheckInput {
  changes: TableChange[];
  /** the listed keys the run deletes, per table */
  listed: Record<string, string[]>;
  /** the `User` keys the run updated */
  updatedUsers: string[];
  /** the `User` keys whose home project moved to `rehomeTo` */
  rehomedUsers: string[];
  rehomeTo: string | null;
  protectedBefore: ProjectInventory[];
  protectedAfter: ProjectInventory[];
  /** tables no project path reaches: any change in them fails */
  unlinked: string[];
  triggersBefore: TriggerState[];
  triggersAfter: TriggerState[];
}

/** Listed `User` keys that are not one of the users pointing at the project. */
export function strayUsers(listedUsers: string[], pointers: Array<{ key: string }>): string[] {
  const known = new Set(pointers.map((u) => u.key));
  return listedUsers.filter((k) => !known.has(k));
}

/** Every way the database after the run differs from what the reviewed list allows; empty means none. */
export function checkRemoval(c: RemovalCheckInput): string[] {
  const failures: string[] = [];
  const byTable = new Map(c.changes.map((ch) => [ch.table, ch]));
  for (const ch of c.changes) {
    if (ch.onlyIn) failures.push(`${ch.table}: the table exists only ${ch.onlyIn} the run`);
    if (ch.added.length) failures.push(`${ch.table}: ${ch.added.length} row(s) added`);
  }
  for (const table of sorted(new Set([...Object.keys(c.listed), ...c.changes.map((ch) => ch.table)]))) {
    const want = Object.hasOwn(c.listed, table) ? sorted(c.listed[table]) : [];
    const got = byTable.get(table)?.removed ?? [];
    const wantSet = new Set(want);
    const off = got.filter((k) => !wantSet.has(k));
    // a repeat means identical rows of a table without a primary key: more removed than listed
    const gotSet = new Set(got);
    const repeats = got.length - gotSet.size;
    const missing = want.filter((k) => !gotSet.has(k));
    if (off.length) failures.push(`${table}: ${off.length} removed row(s) are not on the list: ${off.slice(0, 5).join(' ')}`);
    if (repeats) failures.push(`${table}: ${repeats} identical row(s) removed beyond the list`);
    if (missing.length) failures.push(`${table}: ${missing.length} listed row(s) were not removed: ${missing.slice(0, 5).join(' ')}`);
  }
  const updated = new Set(c.updatedUsers);
  for (const ch of c.changes) {
    const off = ch.table === 'User' ? ch.changed.filter((k) => !updated.has(k)) : ch.changed;
    if (off.length) failures.push(`${ch.table}: ${off.length} row(s) changed that the run may not change: ${off.slice(0, 5).join(' ')}`);
  }
  for (const table of c.unlinked) if (byTable.has(table)) failures.push(`unlinked ${table}: changed by the run`);
  const userChanged = new Set(byTable.get('User')?.changed ?? []);
  const unchangedUsers = c.updatedUsers.filter((k) => !userChanged.has(k));
  if (unchangedUsers.length) failures.push(`User: ${unchangedUsers.length} updated user row(s) show no change`);

  const removedAll = new Set(c.changes.flatMap((ch) => ch.removed.map((k) => `${ch.table}\u0000${k}`)));
  const changedAll = new Set(c.changes.flatMap((ch) => ch.changed.map((k) => `${ch.table}\u0000${k}`)));
  for (const before of c.protectedBefore) {
    const after = c.protectedAfter.find((p) => p.projectId === before.projectId);
    if (!after?.project) { failures.push(`protected ${before.projectId}: missing after the run`); continue; }
    for (const [table, keys] of Object.entries(before.keys)) {
      const lost = keys.filter((k) => removedAll.has(`${table}\u0000${k}`));
      const touched = keys.filter((k) => changedAll.has(`${table}\u0000${k}`) && !(table === 'User' && updated.has(k)));
      if (lost.length) failures.push(`protected ${before.projectId}: ${table} lost ${lost.length} row(s)`);
      if (touched.length) failures.push(`protected ${before.projectId}: ${table} has ${touched.length} changed row(s)`);
    }
    // the move adds its users to the project they move to, and nothing else may differ
    const expected: Record<string, string[]> = { ...before.keys };
    if (before.projectId === c.rehomeTo && c.rehomedUsers.length) expected.User = sorted(new Set([...(before.keys.User ?? []), ...c.rehomedUsers]));
    for (const d of keyDifferences(expected, after.keys)) failures.push(`protected ${before.projectId}: keys differ, ${d}`);
  }

  const id = (t: TriggerState): string => `${t.table}\u0000${t.name}`;
  const was = new Map(c.triggersBefore.map((t) => [id(t), t]));
  const now = new Map(c.triggersAfter.map((t) => [id(t), t]));
  for (const [k, t] of was) {
    const n = now.get(k);
    if (!n) failures.push(`trigger ${t.table}.${t.name}: missing after the run`);
    else if (n.enabled !== t.enabled) failures.push(`trigger ${t.table}.${t.name}: enabled ${t.enabled} before, ${n.enabled} after`);
    else if (n.definition !== t.definition) failures.push(`trigger ${t.table}.${t.name}: definition changed`);
  }
  for (const [k, t] of now) if (!was.has(k)) failures.push(`trigger ${t.table}.${t.name}: new after the run`);
  return failures;
}

/**
 * The order to empty `tables` in: a table goes once no other table still pending references it
 * (child before parent). Tables left in a cycle follow in name order; the delete loop retries them.
 */
export function deleteOrder(tables: string[], edges: Array<{ child: string; parent: string }>): string[] {
  const left = new Set(tables);
  const out: string[] = [];
  while (left.size) {
    const free = sorted(left).filter((t) => !edges.some((e) => e.parent === t && e.child !== t && left.has(e.child)));
    const next = free.length ? free : sorted(left);
    for (const t of next) { out.push(t); left.delete(t); }
  }
  return out;
}

async function readTriggers(tx: Tx): Promise<TriggerState[]> {
  return tx.$queryRawUnsafe<TriggerState[]>(`
    SELECT c.relname::text AS "table", t.tgname::text AS name, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS definition,
           (t.tgtype & 8) <> 0 AS "onDelete"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
     WHERE NOT t.tgisinternal
     ORDER BY 1, 2`);
}

/** The ALTER TABLE clause that puts a trigger back in `enabled` mode, as pg_trigger records it. */
function enableClause(enabled: string): string {
  if (enabled === 'O') return 'ENABLE TRIGGER';
  if (enabled === 'A') return 'ENABLE ALWAYS TRIGGER';
  if (enabled === 'R') return 'ENABLE REPLICA TRIGGER';
  throw new Error(`unexpected trigger mode ${enabled}`);
}

function sameInventory(file: ProjectInventory, live: ProjectInventory): string[] {
  const out = keyDifferences(file.keys, live.keys).map((d) => `keys differ from the reviewed file: ${d}`);
  const pointer = (u: ProjectInventory['userPointers'][number]): string => JSON.stringify([u.key, u.id, u.email, u.projectId, u.lastProjectId]);
  const a = sorted(file.userPointers.map(pointer));
  const b = sorted(live.userPointers.map(pointer));
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push('userPointers differ from the reviewed file');
  return out;
}

/** Run the removal; never throws for a refusal, a failed check or a database error: the record says. */
export async function removeProject(prisma: PrismaClient, opts: RemovalOptions): Promise<RemovalRecord> {
  const record = emptyRecord(opts);
  try {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const [s] = await tx.$queryRawUnsafe<Array<{ ro: string; iso: string } & SnapshotIdentity>>(
        `SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso,
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "takenAt",
                current_database() AS database, current_schema() AS schema`);
      if (s.iso !== 'serializable' || s.ro !== 'off') throw new Refusal(`the transaction is not a serializable read-write one (${s.iso}, read_only=${s.ro})`);
      // a lock the application holds makes the run give up rather than queue behind it
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
      Object.assign(record, { database: s.database, schema: s.schema, startedAt: s.takenAt, inventoryTakenAt: opts.inventory.takenAt });
      const id: SnapshotIdentity = { takenAt: s.takenAt, database: s.database, schema: s.schema };

      // 1. refusals, before any write
      const file = opts.inventory;
      if (file.projectId !== opts.projectId) throw new Refusal(`the inventory file is for ${file.projectId}, not ${opts.projectId}`);
      if (file.database !== s.database || file.schema !== s.schema) throw new Refusal(`the inventory file is from ${file.database}.${file.schema}, this is ${s.database}.${s.schema}`);
      if (opts.protect.includes(opts.projectId)) throw new Refusal('the target is also listed as protected');
      if (opts.rehomeTo && !opts.protect.includes(opts.rehomeTo)) throw new Refusal(`the home-project target ${opts.rehomeTo} must be one of the protected projects`);
      const live = await collectInventory(tx, id, opts.projectId);
      if (!live.project) throw new Refusal(`project ${opts.projectId} does not exist in this database`);
      record.project = live.project;
      record.files = live.files;
      // the command purges an archived project; a live one is never removed
      if (!live.project.archivedAt) throw new Refusal(`project ${opts.projectId} is not archived`);
      const drift = sameInventory(file, live);
      if (drift.length) throw new Refusal(`the database no longer matches the reviewed list; take a fresh inventory. ${drift.join('; ')}`);
      // a user is pointed at the project, never removed with it: every listed `User` row must be one of them
      const stray = strayUsers(live.keys.User ?? [], live.userPointers);
      if (stray.length) throw new Refusal(`listed User rows that are not home or last-project pointers; they go to the coordinator: ${stray.join(' ')}`);
      record.users = live.userPointers.map((u) => ({
        key: u.key, id: u.id, email: u.email, projectId: u.projectId, lastProjectId: u.lastProjectId,
        linkedBy: [u.projectId === opts.projectId && 'User.projectId', u.lastProjectId === opts.projectId && 'User.lastProjectId'].filter(Boolean).join(' + '),
      }));
      // only a home project moves (6240992923): a user whose last project alone is the target just has it cleared
      const home = live.userPointers.filter((u) => u.projectId === opts.projectId);
      const nonQa = home.filter((u) => !QA_EMAIL.test(u.email));
      if (nonQa.length) throw new Refusal(`users that are not QA accounts have the project as their home project; they go to Board: ${nonQa.map((u) => u.email).join(', ')}`);
      if (home.length) {
        if (!opts.rehomeTo) throw new Refusal(`${home.length} user(s) have the project as their home project and no --rehome-to was given`);
        const [to] = await tx.$queryRawUnsafe<Array<{ id: string; archivedAt: string | null }>>(
          `SELECT id, "archivedAt"::text AS "archivedAt" FROM "Project" WHERE id = $1`, opts.rehomeTo);
        if (!to) throw new Refusal(`the home-project target ${opts.rehomeTo} does not exist`);
        if (to.archivedAt) throw new Refusal(`the home-project target ${opts.rehomeTo} is archived`);
        // moving the home project must need no membership change: each user already belongs there
        const members = new Set((await tx.membership.findMany({
          where: { projectId: opts.rehomeTo, status: 'active', userId: { in: home.map((u) => u.id) } }, select: { userId: true },
        })).map((r) => r.userId));
        const outside = home.filter((u) => !members.has(u.id));
        if (outside.length) throw new Refusal(`moving these users' home project would need a membership on ${opts.rehomeTo}: ${outside.map((u) => u.email).join(', ')}`);
      }
      // a send happens outside the relay's lease transaction, so a delivery that is leased, or was
      // touched lately (a lease that ran out may have been reclaimed and settled by another relay
      // while the first still sends), may be mid-send: deleting it cannot recall the send. A row
      // quiet for OUTBOX_QUIET_MINUTES is settled. A pending one is safe: the relay's lease is an
      // UPDATE that this transaction's delete conflicts with.
      const [busy] = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "OutboxDelivery"
          WHERE "projectId" = $1 AND ("status" = 'leased' OR "updatedAt" > now() - make_interval(mins => $2::int))`,
        opts.projectId, OUTBOX_QUIET_MINUTES);
      if (busy.n) throw new Refusal(`${busy.n} outbox delivery(ies) of the project are leased or changed in the last ${OUTBOX_QUIET_MINUTES} minutes and may be mid-send; run again once they settle`);
      const protectedBefore: ProjectInventory[] = [];
      for (const p of opts.protect) {
        const inv = await collectInventory(tx, id, p);
        if (!inv.project) throw new Refusal(`protected project ${p} does not exist`);
        protectedBefore.push(inv);
      }

      // 2. before
      const before = await snapshotTables(tx);
      const triggersBefore = await readTriggers(tx);

      // 3. the writes
      for (const u of home) {
        const n = await tx.$executeRawUnsafe(`UPDATE "User" SET "projectId" = $1 WHERE id = $2 AND "projectId" = $3`, opts.rehomeTo, u.id, opts.projectId);
        if (n !== 1) throw new Error(`user ${u.email}: expected to move 1 home project, moved ${n}`);
        record.rehomed.push({ id: u.id, email: u.email, fromProjectId: opts.projectId, toProjectId: opts.rehomeTo!, lastProjectId: u.lastProjectId === opts.projectId ? null : u.lastProjectId });
      }
      for (const u of live.userPointers.filter((x) => x.lastProjectId === opts.projectId)) {
        const n = await tx.$executeRawUnsafe(`UPDATE "User" SET "lastProjectId" = NULL WHERE id = $1 AND "lastProjectId" = $2`, u.id, opts.projectId);
        if (n !== 1) throw new Error(`user ${u.email}: expected to clear 1 last project, cleared ${n}`);
        record.lastProjectCleared.push({ id: u.id, email: u.email });
      }
      // a user is pointed at the project, never removed with it
      const listed: Record<string, string[]> = Object.create(null);
      for (const [table, keys] of Object.entries(live.keys)) if (table !== 'User') listed[table] = keys;
      const tables = Object.keys(listed);

      const cat = await readCatalog(tx);
      const disabled = triggersBefore.filter((t) => tables.includes(t.table) && t.enabled !== 'D' && t.onDelete);
      // Every table whose triggers are switched off is locked here, all in one statement and without waiting. Taken one
      // by one in the loop below, the locks went in name order ("DomainEvent" before "Media"), while a photo write takes
      // them in another order, so the two could deadlock (#482 site photos). By now the run already holds the rehomed
      // "User" rows and a read lock on every table it snapshotted; it stays out of any cycle because this statement is
      // NOWAIT and never waits, and app routes refuse an archived project. A writer holding any of these tables makes
      // the run refuse at once and change nothing.
      const locked = sorted(new Set(disabled.map((t) => t.table)));
      if (locked.length) {
        try {
          await tx.$executeRawUnsafe(`LOCK TABLE ${locked.map(q).join(', ')} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        } catch (e) {
          if (!/55P03|could not obtain lock/i.test(String((e as Error).message))) throw e;
          throw new Refusal(`another transaction is writing one of ${locked.join(', ')}; nothing was changed, run it again`);
        }
      }
      for (const t of disabled) await tx.$executeRawUnsafe(`ALTER TABLE ${q(t.table)} DISABLE TRIGGER ${q(t.name)}`);
      record.triggers.disabled = disabled.map(({ table, name, enabled }) => ({ table, name, enabled }));

      // child tables first; a cycle, or an order the catalog can't settle, is retried pass by pass
      let pending = deleteOrder(tables, cat.edges);
      while (pending.length) {
        const blocked: string[] = [];
        let lastError = '';
        for (const table of pending) {
          await tx.$executeRawUnsafe('SAVEPOINT remove_table');
          try {
            const key = cat.primaryKeys.get(table) ?? null;
            const n = await tx.$executeRawUnsafe(`DELETE FROM ${q(table)} t WHERE ${rowKeySql(key, 't')} = ANY($1::text[])`, listed[table]);
            record.deleted[table] = (record.deleted[table] ?? 0) + n;
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT remove_table');
          } catch (e) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT remove_table');
            // a row still references this one: try again once the rest of this pass has gone
            if (!/23503|foreign key/i.test(String((e as Error).message))) throw e;
            blocked.push(table);
            lastError = (e as Error).message;
          }
        }
        if (blocked.length === pending.length) throw new Error(`no table could be emptied, rows outside the list still reference them: ${blocked.join(', ')}. ${lastError}`);
        pending = blocked;
      }
      for (const t of disabled) await tx.$executeRawUnsafe(`ALTER TABLE ${q(t.table)} ${enableClause(t.enabled)} ${q(t.name)}`);
      // deferred constraints check now, inside the run, so a dry run meets them too
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');

      // 4. after, and the checks
      const after = await snapshotTables(tx);
      const triggersAfter = await readTriggers(tx);
      const protectedAfter: ProjectInventory[] = [];
      for (const p of opts.protect) protectedAfter.push(await collectInventory(tx, id, p));
      const changes = diffSnapshots({ tables: before }, { tables: after });
      const userKeys = new Map(live.userPointers.map((u) => [u.id, u.key]));
      const updatedUsers = sorted(new Set([...record.rehomed, ...record.lastProjectCleared].map((u) => userKeys.get(u.id)!)));
      record.failures = checkRemoval({
        changes, listed, updatedUsers, rehomedUsers: record.rehomed.map((u) => userKeys.get(u.id)!), rehomeTo: opts.rehomeTo,
        protectedBefore, protectedAfter, unlinked: live.unlinked.map((u) => u.table), triggersBefore, triggersAfter,
      });
      const changedTables = new Set(changes.map((ch) => ch.table));
      record.unlinked = live.unlinked.map(({ table }) => ({
        table, before: before[table]?.rows ?? 0, after: after[table]?.rows ?? 0, unchanged: !changedTables.has(table),
      }));
      fillDiff(record, before, after, changes, protectedBefore, updatedUsers);
      record.triggers.compared = triggersBefore.length;
      record.triggers.restored = !record.failures.some((f) => f.startsWith('trigger '));

      // 5. commit only a run that asked to and passed every check
      if (record.failures.length) {
        record.outcome = 'rolled back';
        record.reason = 'a check did not hold; nothing was changed';
        throw new Rollback(record);
      }
      if (!opts.commit) {
        record.outcome = 'rolled back';
        record.reason = 'dry run: every check held; nothing was changed';
        record.ok = true;
        throw new Rollback(record);
      }
      return record;
    }, { timeout: 1_800_000, maxWait: 30_000 });
    done.outcome = 'committed';
    done.ok = true;
    return done;
  } catch (e) {
    if (e instanceof Rollback) return e.record;
    record.ok = false;
    record.outcome = e instanceof Refusal ? 'refused' : 'failed';
    record.reason = (e as Error).message;
    // a run that failed was rolled back whole, whatever the record had gathered before it did
    if (record.outcome === 'failed') record.reason = `rolled back, nothing was changed: ${record.reason}`;
    return record;
  }
}

function fillDiff(
  record: RemovalRecord,
  before: Record<string, TableSnapshot>,
  after: Record<string, TableSnapshot>,
  changes: TableChange[],
  protectedBefore: ProjectInventory[],
  updatedUsers: string[],
): void {
  for (const table of sorted(new Set([...Object.keys(before), ...Object.keys(after)]))) {
    record.counts[table] = { before: Object.hasOwn(before, table) ? before[table].rows : 0, after: Object.hasOwn(after, table) ? after[table].rows : 0 };
  }
  for (const ch of changes) {
    if (ch.removed.length) record.removed[ch.table] = ch.removed;
    if (ch.changed.length) record.changed[ch.table] = ch.changed;
    if (ch.added.length) record.added[ch.table] = ch.added;
  }
  const updated = new Set(updatedUsers);
  for (const p of protectedBefore) {
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [table, keys] of Object.entries(p.keys)) {
      const set = new Set(keys);
      for (const k of record.removed[table] ?? []) if (set.has(k)) removed.push(`${table} ${k}`);
      for (const k of record.changed[table] ?? []) if (set.has(k)) changed.push(`${table} ${k}${table === 'User' && updated.has(k) ? ' (home project moved here)' : ''}`);
    }
    record.protected.push({
      projectId: p.projectId, removed, changed,
      keysUnchanged: !record.failures.some((f) => f.startsWith(`protected ${p.projectId}:`)),
    });
  }
}

/**
 * Claim the record's file before the run: created owner-only, never over an existing file, so a
 * committed removal always has a place for its record. Throws, before anything runs, if it can't.
 */
export function reserveRecordPath(path: string): number {
  return openSync(path, 'wx', 0o600);
}

/**
 * Write the record whole into the file `reserveRecordPath` claimed. The record is the deletion
 * record: Board pastes it back for the coordinator to check.
 */
export function writeRemovalRecord(record: RemovalRecord, fd: number): void {
  try {
    const data = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    ftruncateSync(fd, 0);
    // a write may take only part of the buffer (a full disk does this without throwing)
    for (let off = 0; off < data.length;) off += writeSync(fd, data, off, data.length - off, off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
