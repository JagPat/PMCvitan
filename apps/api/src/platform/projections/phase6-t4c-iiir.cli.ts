import { PrismaService } from '../../prisma.service';
import { registerConsumer, getConsumer } from '../outbox/registry';
import { ProjectionRebuilder } from './rebuilder.service';
import { ProjectionRebuildOperations } from './rebuild-operations';
import { makeDecisionsProjectionConsumer, DECISIONS_PROJECTION } from '../../decisions/decisions.projection';
import {
  Phase6T4cIiirRefusal,
  PHASE6_T4C_IIIR_OPERATOR,
  PHASE6_T4C_IIIR_REASON,
  readPhase6T4cIiirEnv,
  runPhase6T4cIiirStep,
} from './phase6-t4c-iiir';

/**
 * Phase 6 unit 4c-iii-r — the compiled deploy-time entrypoint `scripts/migrate.sh` runs AFTER Prisma
 * and the seal verifiers and BEFORE the server starts (never tsx; a missing artifact fails the deploy
 * closed, like every other compiled runner artifact).
 *
 * Exit codes: 0 completed / already-completed / not-applicable (fresh-install allowance);
 *             1 a named refusal (printed as JSON on stdout — the deploy must not start the server);
 *             2 an unexpected error.
 */
async function main(): Promise<void> {
  const prisma = new PrismaService();
  const log = (line: string): void => { process.stderr.write(`[phase6-t4c-iiir] ${line}\n`); };
  try {
    // Standalone, outside the server boot that normally registers consumers — only the one this
    // step rebuilds. The rebuilder finds it by name; nothing else is needed for decisions.inbox.
    if (!getConsumer(DECISIONS_PROJECTION)) registerConsumer(makeDecisionsProjectionConsumer());
    const ops = new ProjectionRebuildOperations(prisma, new ProjectionRebuilder(prisma));
    const outcome = await runPhase6T4cIiirStep(prisma, {
      env: readPhase6T4cIiirEnv(process.env),
      rebuild: () => ops.run({ operatorIdentity: PHASE6_T4C_IIIR_OPERATOR, reason: PHASE6_T4C_IIIR_REASON, consumers: [DECISIONS_PROJECTION] }),
      log,
    });
    process.stdout.write(JSON.stringify(outcome) + '\n');
  } catch (e) {
    if (e instanceof Phase6T4cIiirRefusal) {
      process.stdout.write(JSON.stringify({ outcome: 'refused', code: e.code, message: e.message, details: e.details }) + '\n');
      process.exitCode = 1;
    } else {
      process.stderr.write(`phase6-t4c-iiir: ${(e as Error).message}\n`);
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
