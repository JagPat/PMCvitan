import { PrismaService } from '../prisma.service';
import { disableCapability } from './capability-switch';

/**
 * Stage 1 redesign (#482) — the operator rollback for a presentation-only capability.
 *
 *   pnpm --filter api capability:disable --project <id> --capability home-nav \
 *        --operator <you@example.com> --reason <text>
 *
 * The counterpart of `capability:enable`. People on that project see today's screens the next time
 * the app opens or reloads; no data is touched. Refuses any capability outside
 * `SWITCHABLE_CAPABILITIES` (see `capability-switch.ts`).
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
  if (!f.project || !f.capability || !f.operator || !f.reason) {
    process.stderr.write('usage: capability:disable --project <id> --capability <name> --operator <identity> --reason <text>\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const { changed } = await disableCapability(prisma, { projectId: f.project, capability: f.capability, operator: f.operator, reason: f.reason });
    process.stdout.write(JSON.stringify({ ok: true, projectId: f.project, capability: f.capability, changed }) + '\n');
  } catch (e) {
    process.stderr.write(`capability:disable: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
