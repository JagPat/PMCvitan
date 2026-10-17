import { writeFileSync } from 'node:fs';
import { PrismaService } from '../prisma.service';
import { inventoryProject } from './project-inventory';

/**
 * #482 — the read-only inventory of one project (see `project-inventory.ts`).
 *
 *   pnpm --filter api project:inventory --project <id> --out <file.json>
 *
 * Writes the full export (every row, user pointer and storage key) to `--out` and prints a summary:
 * the target's counts per table, its user pointers and photos, the delete triggers it would meet,
 * and the row counts for every project. It changes nothing in the database: the run is one
 * read-only transaction.
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
  if (!f.project || !f.out) {
    process.stderr.write('usage: project:inventory --project <id> --out <file.json>\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const inv = await inventoryProject(prisma, f.project);
    writeFileSync(f.out, JSON.stringify(inv, null, 2) + '\n', { flag: 'wx' });
    const summary = {
      ok: true,
      projectId: inv.projectId,
      found: inv.project !== null,
      readOnlyVerified: inv.readOnlyVerified,
      takenAt: inv.takenAt,
      export: f.out,
      columnsScanned: inv.columns.length,
      counts: inv.counts,
      userPointers: inv.userPointers,
      media: inv.media,
      deleteTriggers: inv.deleteTriggers,
      countsByProject: inv.countsByProject,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`project:inventory: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
