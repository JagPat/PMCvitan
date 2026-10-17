import { PrismaService } from '../prisma.service';
import { snapshotDatabase, writeJsonAtomically } from './db-snapshot';

/**
 * #482 — the read-only snapshot of every table's row keys and row digests (see `db-snapshot.ts`).
 *
 *   pnpm --filter api db:snapshot --out <file.json>
 *
 * Writes the snapshot to `--out` (owner-only, never over an existing file, never left
 * half-written) and prints each table's row count. It changes nothing in the database: the run is
 * one repeatable-read, read-only transaction. There is deliberately no command that compares two
 * files: a file cannot prove which server it came from or when it was taken, so the comparison
 * (`diffSnapshots`) runs only inside the removal itself, on snapshots it takes on one connection.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (!f.out) {
    process.stderr.write('usage: db:snapshot --out <file.json>\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const snap = await snapshotDatabase(prisma);
    writeJsonAtomically(snap, f.out);
    const rows = Object.fromEntries(Object.entries(snap.tables).map(([t, s]) => [t, s.rows]));
    process.stdout.write(JSON.stringify({ ok: true, export: f.out, takenAt: snap.takenAt, database: snap.database, schema: snap.schema, tables: Object.keys(rows).length, rows }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`db:snapshot: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
