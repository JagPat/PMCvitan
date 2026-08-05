import { readFileSync } from 'node:fs';
import { PrismaService } from '../prisma.service';
import { recordAudit } from './audit';
import { systemActor } from '../common/actor';
import { CommercialActivationService } from '../commercial/commercial-activation.service';
import { CommercialParticipant } from '../commercial/commercial.participant';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from './capabilities.service';
import { ProcurementQuery } from '../procurement/procurement.query';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { InventoryQuery } from '../inventory/inventory.query';
import { CommercialBudgetQuery } from '../commercial/commercial-budget.query';
import { CommercialMeasurementQuery } from '../commercial/commercial-measurement.query';
import { CommercialBudgetService } from '../commercial/commercial-budget.service';
import { LabourRequirementQuery } from '../labour/labour.query';
import { LabourRequirementParticipant } from '../labour/labour.participant';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { RequirementsQueryService } from '../activities/requirements.query';
import { CommercialBillService } from '../commercial/commercial-bill.service';
import { CommercialBillQuery } from '../commercial/commercial-bill.query';
import { CommercialDeductionQuery } from '../commercial/commercial-deduction.query';
import type { CommercialActivationPlan } from '@vitan/shared';

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
    process.stderr.write('usage: capability:enable --project <id> --capability <name> --operator <identity> --reason <text> [--plan <activation-plan.json>]\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    // Phase 5 Task 1 (§L) — `commercial` is the ONE capability whose activation is not a no-op:
    // a project can already hold live POs, and flipping the flag without attributing them leaves
    // `COMMITTED` reading ₹0 against real vendor obligations. The activation plan (cost heads +
    // a head for every live line) is INPUT, because while the capability is off there is no
    // commercial surface on which an operator could choose one.
    if (f.capability === COMMERCIAL_CAPABILITY) {
      if (!f.plan) {
        process.stderr.write(
          'capability:enable commercial requires --plan <file.json> with { costHeads, materialLines, labourLines }.\n' +
          'Enabling commercial must attribute every LIVE purchase-order line in the same transaction (§L).\n',
        );
        process.exitCode = 2;
        return;
      }
      const parsed = JSON.parse(readFileSync(f.plan, 'utf8')) as Partial<CommercialActivationPlan>;
      const plan: CommercialActivationPlan = {
        costHeads: parsed.costHeads ?? [],
        materialLines: parsed.materialLines ?? [],
        labourLines: parsed.labourLines ?? [],
        reason: parsed.reason ?? f.reason,
      };
      // the activation path constructs its own graph (no Nest container in a CLI)
      const capabilitiesService = new CapabilitiesService(prisma);
      const budgetService = new CommercialBudgetService(
        prisma,
        capabilitiesService,
        new CommercialBudgetQuery(new ProcurementQuery(prisma), new LabourRequirementQuery(prisma), new InventoryQuery(prisma), new CommercialMeasurementQuery(), new CommercialBillQuery(), new CommercialDeductionQuery(new CommercialBillQuery())),
      );
      const activation = new CommercialActivationService(
        prisma,
        // Phase 5 Task 4 — the participant now also carries the vendor-claim withdrawal guards,
        // so the CLI's hand-built graph gains the two collaborators they need. Activation itself
        // never reaches them (it attributes existing PO lines and writes no claim), but the
        // constructor is the constructor: a CLI that builds a DIFFERENT object from the one the
        // container builds is how a code path stops being the path that was tested.
        new CommercialParticipant(
          capabilitiesService,
          budgetService,
          new InventoryQuery(prisma),
          new CommercialBillService(
            prisma, capabilitiesService, new ProcurementParticipant(new RequirementsQueryService()),
            new LabourRequirementParticipant(), new InventoryQuery(prisma),
            new CommercialBillQuery(), new CommercialMeasurementQuery(), budgetService,
          ),
          // Phase 5 Task 5B — the §D/§E row-level certificate floor folds `netOf` through the
          // measurement QUERY, so the hand-built graph gains it for the same reason as above.
          new CommercialMeasurementQuery(),
        ),
        new ProcurementQuery(prisma),
        new LabourRequirementQuery(prisma),
        new OrgsParticipant(),
      );
      const result = await activation.activate(f.project, f.operator, plan);
      process.stdout.write(JSON.stringify({ ok: true, projectId: f.project, capability: f.capability, ...result }) + '\n');
      return;
    }
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
