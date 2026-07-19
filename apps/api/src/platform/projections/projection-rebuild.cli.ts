import { PrismaService } from '../../prisma.service';
import { registerConsumer, getConsumer } from '../outbox/registry';
import { ProjectionRebuilder } from './rebuilder.service';
import { makeDrawingsProjectionConsumer, DRAWINGS_PROJECTION } from '../../drawings/drawings.projection';
import { makeDailyLogProjectionConsumer, DAILY_LOG_PROJECTION } from '../../daily-log/daily-log.projection';
import { computeDrawingsBase } from '../../drawings/drawings-serialize';
import { computeDailyLogSlice } from '../../daily-log/daily-log-serialize';

/**
 * Module-4 correction — the operator projection-rebuild command.
 *
 *   pnpm --filter api projection:rebuild --operator <identity> --reason <text> \
 *        [--project <id>] [--consumer <drawings.inbox | daily-log.inbox>]
 *
 * WHY: the owner-aligned SET NULL signals fix silent staleness going FORWARD, but a delivery that
 * already recorded a noop is history — the ordered cursor advanced past it, so no replay will
 * recompute the base a past `ON DELETE SET NULL` action mutated. Any generation built before the
 * correction may therefore serve a stale `Drawing.activityId` / `Drawing.nodeId` /
 * `SiteMaterial.nodeId`. This command rebuilds `drawings.inbox` and `daily-log.inbox` from CANONICAL
 * state for every project (or one), through the standard generation-swap + final-activation-barrier
 * protocol ({@link ProjectionRebuilder.rebuild}) — reads keep serving the old generation until the
 * new one activates, and re-running is IDEMPOTENT: each run just builds a fresh generation from
 * canonical and swaps.
 *
 * DIAGNOSTICS: for each (project, consumer) it records BEFORE and AFTER states — the serving
 * generation and whether its stored base EQUALS the base recomputed from canonical right now
 * (`match`) — and prints them as JSON. The command exits non-zero if any AFTER row mismatches
 * (it never should: the barrier seeds the new generation from canonical under the stream lock).
 * Each invocation is recorded as an `OutboxOperatorAction` (`projection.rebuild`) with the
 * operator identity + reason, like the other audited operator commands.
 *
 * Like outbox.cli.ts, this constructs its services directly over a Prisma client — pure database
 * work, no Nest reflective DI. The comparison reuses each module's OWN canonical serializer
 * (`computeDrawingsBase` / `computeDailyLogSlice`) — the same functions the consumers store — so
 * "projection == live" is judged by the module's one canonical read path, not a reimplementation.
 */

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

/** Key-order-independent deep equality (the dto round-trips through jsonb, which keeps no order). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

interface ConsumerDiag {
  generation: number | null;
  /** stored base == base recomputed from canonical now (null when no generation serves yet) */
  match: boolean | null;
}

const REBUILDABLE = {
  [DRAWINGS_PROJECTION]: {
    row: (prisma: PrismaService, generationId: string, projectId: string) =>
      prisma.drawingsProjection.findUnique({ where: { generationId_projectId: { generationId, projectId } } }),
    compute: (prisma: PrismaService, projectId: string) => computeDrawingsBase(prisma, projectId),
  },
  [DAILY_LOG_PROJECTION]: {
    row: (prisma: PrismaService, generationId: string, projectId: string) =>
      prisma.dailyLogProjection.findUnique({ where: { generationId_projectId: { generationId, projectId } } }),
    compute: (prisma: PrismaService, projectId: string) => computeDailyLogSlice(prisma, projectId),
  },
} as const;

type RebuildableName = keyof typeof REBUILDABLE;

async function diagnose(prisma: PrismaService, rebuilder: ProjectionRebuilder, consumer: RebuildableName, projectId: string): Promise<ConsumerDiag> {
  const active = await rebuilder.activeGeneration(consumer, projectId);
  if (!active) return { generation: null, match: null };
  const stored = await REBUILDABLE[consumer].row(prisma, active.id, projectId);
  const expected = await REBUILDABLE[consumer].compute(prisma, projectId);
  return { generation: active.generation, match: stable(stored?.dto ?? null) === stable(expected) };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (!f.operator || !f.reason) {
    process.stderr.write('usage: projection:rebuild --operator <identity> --reason <text> [--project <id>] [--consumer <name>]\n');
    process.exitCode = 2;
    return;
  }
  const consumers = (f.consumer ? [f.consumer] : Object.keys(REBUILDABLE)) as RebuildableName[];
  for (const c of consumers) {
    if (!(c in REBUILDABLE)) {
      process.stderr.write(`projection:rebuild: unknown consumer ${c} (rebuildable: ${Object.keys(REBUILDABLE).join(', ')})\n`);
      process.exitCode = 2;
      return;
    }
  }

  const prisma = new PrismaService();
  const rebuilder = new ProjectionRebuilder(prisma);
  if (!getConsumer(DRAWINGS_PROJECTION)) registerConsumer(makeDrawingsProjectionConsumer());
  if (!getConsumer(DAILY_LOG_PROJECTION)) registerConsumer(makeDailyLogProjectionConsumer());

  try {
    const projects = f.project
      ? await prisma.project.findMany({ where: { id: f.project }, select: { id: true } })
      : await prisma.project.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    if (f.project && projects.length === 0) throw new Error(`unknown project ${f.project}`);

    const results: Array<{ projectId: string; consumer: string; before: ConsumerDiag; after: ConsumerDiag }> = [];
    for (const { id: projectId } of projects) {
      for (const consumer of consumers) {
        const before = await diagnose(prisma, rebuilder, consumer, projectId);
        await rebuilder.rebuild(consumer, projectId);
        const after = await diagnose(prisma, rebuilder, consumer, projectId);
        results.push({ projectId, consumer, before, after });
      }
    }

    await prisma.outboxOperatorAction.create({
      data: {
        action: 'projection.rebuild',
        consumer: consumers.join(','),
        projectId: f.project || null,
        operatorIdentity: f.operator,
        reason: f.reason,
      },
    });

    const mismatchesAfter = results.filter((r) => r.after.match !== true);
    process.stdout.write(
      JSON.stringify(
        {
          ok: mismatchesAfter.length === 0,
          action: 'projection.rebuild',
          projects: projects.length,
          consumers,
          staleBefore: results.filter((r) => r.before.match === false).length,
          mismatchesAfter: mismatchesAfter.length,
          results,
        },
        null,
        2,
      ) + '\n',
    );
    if (mismatchesAfter.length > 0) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`projection:rebuild: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
