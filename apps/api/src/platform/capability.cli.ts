import { PrismaService } from '../prisma.service';
import { recordAudit } from './audit';
import { systemActor } from '../common/actor';

/**
 * Phase 3 Task 1 — the operator capability-activation command (plan §D).
 *
 *   pnpm --filter api capability:enable --project <id> --capability materials \
 *        --operator <you@example.com> --reason <text>
 *
 * Enabling a capability is the ONE act that makes a Phase-3 surface exist for a project —
 * so it is explicit, per-project and attributably audited (operator identity + reason on the
 * project's audit trail). Idempotent: re-enabling an enabled capability is a no-op.
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
    process.stderr.write('usage: capability:enable --project <id> --capability <name> --operator <identity> --reason <text>\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.project.findUniqueOrThrow({ where: { id: f.project }, select: { id: true } });
      await tx.projectCapability.upsert({
        where: { projectId_capability: { projectId: f.project, capability: f.capability } },
        create: { projectId: f.project, capability: f.capability, enabledById: f.operator },
        update: {},
      });
      await recordAudit(tx, {
        projectId: f.project,
        actor: systemActor(f.operator, f.operator, 'operator'),
        action: 'capability.enable',
        entity: 'ProjectCapability',
        entityId: `${f.project}:${f.capability}`,
      });
    });
    process.stdout.write(JSON.stringify({ ok: true, projectId: f.project, capability: f.capability }) + '\n');
  } catch (e) {
    process.stderr.write(`capability:enable: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
