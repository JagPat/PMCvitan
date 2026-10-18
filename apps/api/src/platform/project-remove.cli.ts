import { readFileSync } from 'node:fs';
import { PrismaService } from '../prisma.service';
import type { ProjectInventory } from './project-inventory';
import { removeProject, reserveRecordPath, writeRemovalRecord } from './project-remove';

/**
 * #482 — step 3: remove one project by the list Board reviewed (see `project-remove.ts`).
 *
 *   pnpm --filter api project:remove --project <id> --inventory <b2.json> --protect <id,id,...>
 *     [--rehome-to <id>] --out <record.json> [--commit]
 *
 * Without `--commit` it is a dry run: it does everything, checks everything, and rolls back. The
 * `--out` file is claimed before the run (owner-only, never over an existing file: a taken path exits
 * 2 and runs nothing); the record is printed, then written there. Exit 0 means a dry run whose every
 * check held, or a committed removal; 1 means it changed nothing; 3 means the removal COMMITTED but
 * the record could not be saved, and the printed record is the deletion record.
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
  let out: number;
  try {
    out = reserveRecordPath(f.out);
  } catch (e) {
    process.stderr.write(`project:remove: cannot claim --out ${f.out}, nothing was run: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const record = await removeProject(prisma, { projectId: f.project, inventory, protect, rehomeTo: f['rehome-to'] || null, commit: f.commit === 'yes' });
    // printed first: a committed removal's record is never lost to a failed save
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    try {
      writeRemovalRecord(record, out);
    } catch (e) {
      const committed = record.outcome === 'committed';
      process.stderr.write(`project:remove: ${committed ? 'the removal was COMMITTED; the record printed above is the deletion record, but ' : ''}saving it to ${f.out} failed: ${(e as Error).message}\n`);
      process.exitCode = committed ? 3 : 1;
      return;
    }
    if (!record.ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`project:remove: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
