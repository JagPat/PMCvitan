import { readFileSync } from 'node:fs';
import { PrismaService } from '../prisma.service';
import { bootstrapOrg, bootstrapSpecSchema } from './org-bootstrap';

/**
 * Fresh start — make one company, its first project and its people on a database that has none
 * (see `org-bootstrap.ts`):
 *
 *   pnpm --filter api org:bootstrap --spec <spec.json> [--commit]
 *
 * Without `--commit` it is a dry run: it writes and checks everything, then rolls back. It prints
 * what it made (ids, names, roles; never a secret). Exit 0 means a dry run that would succeed or a
 * committed bootstrap; 1 means nothing was changed; 2 means the command line or the spec is wrong.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const specAt = args.indexOf('--spec');
  const specPath = specAt >= 0 ? args[specAt + 1] : undefined;
  if (!specPath) {
    process.stderr.write('usage: org:bootstrap --spec <spec.json> [--commit]\n');
    process.exitCode = 2;
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`org:bootstrap: cannot read the spec ${specPath}, nothing was run: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const parsed = bootstrapSpecSchema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(`org:bootstrap: the spec is not valid, nothing was run:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}\n`);
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const record = await bootstrapOrg(prisma, parsed.data, { commit: args.includes('--commit') });
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    if (!record.ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`org:bootstrap: nothing was changed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
