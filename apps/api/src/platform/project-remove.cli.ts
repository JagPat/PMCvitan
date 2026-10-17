import { readFileSync } from 'node:fs';
import { PrismaService } from '../prisma.service';
import type { ProjectInventory } from './project-inventory';
import { removeProject, writeRemovalRecord } from './project-remove';

/**
 * #482 — step 3: remove one project by the list Board reviewed (see `project-remove.ts`).
 *
 *   pnpm --filter api project:remove --project <id> --inventory <b2.json> --protect <id,id,...>
 *     [--rehome-to <id>] --out <record.json> [--commit]
 *
 * Without `--commit` it is a dry run: it does everything, checks everything, and rolls back. The
 * record is written to `--out` (owner-only, never over an existing file) and printed. Exit 0 means a
 * dry run whose every check held, or a committed removal; anything else exits 1 and changed nothing.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') { out.commit = 'yes'; continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (!f.project || !f.inventory || !f.protect || !f.out) {
    process.stderr.write('usage: project:remove --project <id> --inventory <b2.json> --protect <id,id,...> [--rehome-to <id>] --out <record.json> [--commit]\n');
    process.exitCode = 2;
    return;
  }
  const inventory = JSON.parse(readFileSync(f.inventory, 'utf8')) as ProjectInventory;
  const protect = f.protect.split(',').map((p) => p.trim()).filter(Boolean);
  const prisma = new PrismaService();
  try {
    const record = await removeProject(prisma, { projectId: f.project, inventory, protect, rehomeTo: f['rehome-to'] || null, commit: f.commit === 'yes' });
    writeRemovalRecord(record, f.out);
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    if (!record.ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`project:remove: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
