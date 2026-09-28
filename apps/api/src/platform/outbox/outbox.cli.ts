import { PrismaService } from '../../prisma.service';
import { OutboxOperationsService } from './outbox-operations.service';
import { OutboxConsumerActivationService } from './consumer-activation.service';

/**
 * Phase 2 fix-forward PR B Task 4 — the operator CLI.
 *
 *   pnpm --filter api outbox:status
 *   pnpm --filter api outbox:retry --delivery <uuid> --operator <identity> --reason <text>
 *   pnpm --filter api outbox:consumer --consumer <name> --active true|false --operator <identity> --reason <text> --token <request token>
 *
 * Phase 6 task 4d-ii-a / A6b — `consumer` is the activation protocol: the ONLY supported way to flip a
 * consumer's `active` (the catalog mirror is sealed). `--token` is the retry identity the caller mints
 * once and resends on every retry; the same token with the same request replays its own fact, with a
 * different request it is refused.
 *
 * The operations are pure database queries, so the CLI constructs the service directly over a
 * Prisma client (no HTTP/WebSocket platform, and no dependency on Nest's reflective DI, which esbuild
 * does not emit metadata for). `status` prints JSON WITHOUT event payloads or push secrets; `retry`
 * validates against the durable active catalog. Exits non-zero on a validation or database failure.
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
  const cmd = process.argv[2];
  const prisma = new PrismaService();
  const ops = new OutboxOperationsService(prisma);
  try {
    if (cmd === 'status') {
      process.stdout.write(JSON.stringify(await ops.status(), null, 2) + '\n');
    } else if (cmd === 'retry') {
      const f = parseFlags(process.argv.slice(3));
      const { auditId } = await ops.retry({ deliveryId: f.delivery ?? '', operatorIdentity: f.operator ?? '', reason: f.reason ?? '' });
      process.stdout.write(JSON.stringify({ ok: true, action: 'retry', delivery: f.delivery, auditId }) + '\n');
    } else if (cmd === 'consumer') {
      const f = parseFlags(process.argv.slice(3));
      const activation = new OutboxConsumerActivationService(prisma);
      const active = f.active === 'true' ? true : f.active === 'false' ? false : f.active;
      const { fact, replayed } = await activation.request({ consumer: f.consumer ?? '', active, reason: f.reason ?? '', actorId: f.operator ?? '', requestToken: f.token ?? '' });
      process.stdout.write(JSON.stringify({ ok: true, action: 'consumer', replayed, fact: { ...fact, at: fact.at.toISOString() } }) + '\n');
    } else if (cmd === 'seal-external') {
      // PR C Task 3 — the audited external-effect cutover. Run in legacy/shadow BEFORE switching a
      // process to OUTBOX_SENDER_MODE=outbox (whose startup then requires this exact coverage seal).
      const f = parseFlags(process.argv.slice(3));
      const { coverageVersion, auditId, neutralized } = await ops.sealExternal({ operatorIdentity: f.operator ?? '', reason: f.reason ?? '' });
      process.stdout.write(JSON.stringify({ ok: true, action: 'seal-external', coverageVersion, neutralized, auditId }) + '\n');
    } else {
      process.stderr.write('usage: outbox <status | retry --delivery <uuid> --operator <identity> --reason <text> | consumer --consumer <name> --active true|false --operator <identity> --reason <text> --token <request token> | seal-external --operator <identity> --reason <text>>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`outbox: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
