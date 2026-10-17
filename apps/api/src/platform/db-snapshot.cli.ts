import { readFileSync } from 'node:fs';
import { PrismaService } from '../prisma.service';
import { diffSnapshots, snapshotDatabase, writeJsonAtomically, type DatabaseSnapshot } from './db-snapshot';

/**
 * #482 — the read-only snapshot of every table's row keys, and the comparison of two (see
 * `db-snapshot.ts`).
 *
 *   pnpm --filter api db:snapshot --out <file.json>
 *   pnpm --filter api db:snapshot-diff --before <file.json> --after <file.json>
 *
 * `snapshot` writes the snapshot to `--out` (owner-only, never over an existing file, never left
 * half-written) and prints each table's row count. It changes nothing in the database: the run is
 * one repeatable-read, read-only transaction. `diff` reads two snapshot files, touches no database,
 * and prints every table whose rows differ with the exact keys removed and added.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

function readSnapshot(path: string): DatabaseSnapshot {
  const s = JSON.parse(readFileSync(path, 'utf8')) as DatabaseSnapshot;
  if (s?.readOnlyVerified !== true || typeof s.tables !== 'object' || s.tables === null) throw new Error(`${path} is not a db:snapshot file`);
  return s;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const f = parseFlags(rest);
  if (command === 'snapshot' && f.out) {
    const prisma = new PrismaService();
    try {
      const snap = await snapshotDatabase(prisma);
      writeJsonAtomically(snap, f.out);
      const rows = Object.fromEntries(Object.entries(snap.tables).map(([t, s]) => [t, s.rows]));
      process.stdout.write(JSON.stringify({ ok: true, export: f.out, takenAt: snap.takenAt, database: snap.database, tables: Object.keys(rows).length, rows }, null, 2) + '\n');
    } catch (e) {
      process.stderr.write(`db:snapshot: ${(e as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  if (command === 'diff' && f.before && f.after) {
    try {
      const before = readSnapshot(f.before);
      const after = readSnapshot(f.after);
      const changes = diffSnapshots(before, after);
      process.stdout.write(JSON.stringify({ ok: true, before: before.takenAt, after: after.takenAt, tablesChanged: changes.length, changes }, null, 2) + '\n');
    } catch (e) {
      process.stderr.write(`db:snapshot-diff: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write('usage: db:snapshot --out <file.json> | db:snapshot-diff --before <file.json> --after <file.json>\n');
  process.exitCode = 2;
}

void main();
