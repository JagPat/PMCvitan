/**
 * Phase 1 Task 6 — the stored-vs-derived DELTA REPORT.
 *
 * Lists every activity whose stored (deprecated) gateInspection column disagrees
 * with the Task 6 derivation, using the CANONICAL TypeScript truth table in
 * src/domain/transitions.ts — never a parallel SQL re-implementation. Run it
 * against a copy of the target database before deploying:
 *
 *   DATABASE_URL=postgres://… pnpm --filter api exec tsx scripts/readiness-delta-report.ts
 *
 * The report is EVIDENCE, not a migration guard: nothing is written. Its output
 * ships with the Task 6 PR. STOP rule (plan §Task 6 Step 2): if a discrepancy
 * CLASS appears that the truth tables do not cover, stop and bring it back to
 * review — do not invent a new derivation rule mid-implementation.
 */
import { PrismaClient } from '@prisma/client';
import { deriveInspectionGate } from '../src/domain/transitions';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const projects = await prisma.project.findMany({ select: { id: true, name: true } });
  let total = 0;
  let deltas = 0;
  const classes = new Map<string, number>();

  for (const p of projects) {
    const [activities, inspections] = await Promise.all([
      prisma.activity.findMany({ where: { projectId: p.id }, select: { id: true, name: true, status: true, gateInspection: true } }),
      prisma.inspection.findMany({
        where: { projectId: p.id },
        select: { id: true, activityId: true, closing: true, submitted: true, decided: true, reinspectionOfId: true, items: { select: { rejected: true, result: true } } },
      }),
    ]);
    for (const a of activities) {
      total += 1;
      const derived = deriveInspectionGate(a.id, inspections);
      if (derived.v !== a.gateInspection) {
        deltas += 1;
        const cls = `stored=${a.gateInspection} derived=${derived.v}`;
        classes.set(cls, (classes.get(cls) ?? 0) + 1);
        console.log(`DELTA  ${p.id}/${a.id} (${a.name}, ${a.status}): stored gateInspection=${a.gateInspection} → derived=${derived.v} — ${derived.reason}`);
      }
    }
  }

  console.log(`\n${total} activities checked across ${projects.length} project(s); ${deltas} delta(s).`);
  for (const [cls, n] of classes) console.log(`  class ${cls}: ${n}`);
  if (deltas === 0) console.log('Stored and derived agree everywhere.');
  console.log(
    '\nEvery class above must be explainable by the truth tables (a stored flag that was never linked derives na; a linked chain derives its real state). An unexplainable CLASS is the plan’s STOP condition.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
