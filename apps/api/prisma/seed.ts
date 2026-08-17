import { PrismaClient, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  SEED_NODES,
  SEED_DECISIONS,
  SEED_PHASES,
  SEED_ACTIVITIES,
  SEED_INSPECTIONS,
  SEED_LOG_MATERIALS,
  STARTER_MODULES,
  createStarterLibraryInTransaction,
} from '../src/domain/seed-data';
import { addCivilDays, fromIsoCivilDate } from '../src/common/civil-date';
import { ddMmmYyyy } from '../src/domain/dates';

const prisma = new PrismaClient();

const PROJECT_ID = 'ambli';
const SEED_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('vitan-pmc-destructive-seed'))";
const SEED_NOTIFICATIONS = [
  { text: 'Client approved Master Bath CP Fittings — Kohler', time: '2h ago', color: '#3F7A54' },
  { text: 'Re-inspection due: Waterproofing, Terrace', time: '1d ago', color: '#B23A34' },
  { text: 'New decision issued for approval: Living Room Flooring', time: '2d ago', color: '#C08A2D' },
];
const SEED_USER_IDENTITIES: Prisma.UserWhereInput[] = [
  { email: { in: ['pmc@vitan.in', 'client@vitan.in', 'contractor@vitan.in', 'test-pmc@vitan.in', 'test-client-b@vitan.in', 'test-eng@vitan.in', 'test-removed@vitan.in'] } },
  { phone: '9876543210' },
];
const sameStrings = (actual: string[], expected: string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

// Real civil dates are canonical (Phase 0 Task 6 / Codex round 2 finding 3): the
// seed must write them alongside the legacy day-offsets, never leave them null.
// SCHEDULE_ANCHOR is ambli's DAY0 — offset 0 IS this day, so todayDay 32 lands on
// 2026-07-03, the seeded daily log's civil day.
const SCHEDULE_ANCHOR = '2026-06-01';
const atDay = (offset: number): Date => fromIsoCivilDate(addCivilDays(SCHEDULE_ANCHOR, offset))!;

function skipCompleteFixture(): boolean {
  return /^(1|true|yes)$/iu.test(process.env.CLOUD_AGENT_SEED_IF_COMPLETE ?? '');
}

async function fixtureIsComplete(tx: Prisma.TransactionClient): Promise<boolean> {
  const expectedDecisionIds = SEED_DECISIONS.map(({ id }) => id);
  const expectedInspectionIds = SEED_INSPECTIONS.map(({ id }) => id);
  const expectedModuleNames = STARTER_MODULES.map(({ name }) => name).sort();
  const expectedNotificationTexts = SEED_NOTIFICATIONS.map(({ text }) => text).sort();
  const expectedMaterialNames = SEED_LOG_MATERIALS.map(({ name }) => name).sort();
  const [
    orgs, projects, users, memberships, orgMemberships, nodes, decisions, decisionOptions,
    changeRequests, phases, activities, inspections, inspectionItems, dailyLogs, crewRows,
    materials, drawings, revisions, media, notifications, modules, templates,
  ] = await Promise.all([
    tx.org.count({ where: { slug: 'vitan' } }),
    tx.project.count({ where: { id: { in: [PROJECT_ID, 'test-empty-site'] }, org: { slug: 'vitan' } } }),
    tx.user.count({ where: { OR: SEED_USER_IDENTITIES } }),
    tx.membership.count({ where: { projectId: { in: [PROJECT_ID, 'test-empty-site'] }, status: 'active', user: { OR: SEED_USER_IDENTITIES } } }),
    tx.orgMembership.count({ where: { org: { slug: 'vitan' }, user: { OR: SEED_USER_IDENTITIES } } }),
    tx.projectNode.count({ where: { projectId: PROJECT_ID, id: { in: SEED_NODES.map(({ id }) => id) } } }),
    tx.decision.count({ where: { projectId: PROJECT_ID, id: { in: expectedDecisionIds } } }),
    tx.decisionOption.count({ where: { decisionId: { in: expectedDecisionIds } } }),
    tx.changeRequest.count({ where: { decisionId: 'DL-003', status: 'open' } }),
    tx.phase.count({ where: { projectId: PROJECT_ID, id: { in: SEED_PHASES.map(({ id }) => id) } } }),
    tx.activity.count({ where: { projectId: PROJECT_ID, id: { in: SEED_ACTIVITIES.map(({ id }) => id) } } }),
    tx.inspection.count({ where: { projectId: PROJECT_ID, id: { in: expectedInspectionIds } } }),
    tx.inspectionItem.count({ where: { inspectionId: { in: expectedInspectionIds } } }),
    tx.dailyLog.count({ where: { projectId: PROJECT_ID, logDate: atDay(32) } }),
    tx.crewRow.count({ where: { dailyLog: { projectId: PROJECT_ID, logDate: atDay(32) } } }),
    tx.siteMaterial.findMany({ where: { projectId: PROJECT_ID, name: { in: expectedMaterialNames } }, select: { name: true }, orderBy: { name: 'asc' } }),
    tx.drawing.count({ where: { id: 'test-drawing-a', projectId: PROJECT_ID } }),
    tx.drawingRevision.count({ where: { id: 'test-drawing-a-rev1', drawingId: 'test-drawing-a' } }),
    tx.media.count({ where: { id: 'test-photo-a', projectId: PROJECT_ID } }),
    tx.notification.findMany({ where: { projectId: PROJECT_ID, text: { in: expectedNotificationTexts } }, select: { text: true }, orderBy: { text: 'asc' } }),
    tx.templateModule.findMany({ where: { org: { slug: 'vitan' }, name: { in: expectedModuleNames } }, select: { name: true }, orderBy: { name: 'asc' } }),
    tx.projectTemplate.count({ where: { org: { slug: 'vitan' }, name: 'G+2 Residence' } }),
  ]);

  return orgs === 1
    && projects === 2
    && users === 8
    && memberships === 9
    && orgMemberships === 8
    && nodes === SEED_NODES.length
    && decisions === SEED_DECISIONS.length
    && decisionOptions === SEED_DECISIONS.reduce((total, decision) => total + decision.options.length, 0)
    && changeRequests === 1
    && phases === SEED_PHASES.length
    && activities === SEED_ACTIVITIES.length
    && inspections === SEED_INSPECTIONS.length
    && inspectionItems === SEED_INSPECTIONS.reduce((total, inspection) => total + inspection.items.length, 0)
    && dailyLogs === 1
    && crewRows === 5
    && sameStrings(materials.map(({ name }) => name), expectedMaterialNames)
    && drawings === 1
    && revisions === 1
    && media === 1
    && sameStrings(notifications.map(({ text }) => text), expectedNotificationTexts)
    && sameStrings(modules.map(({ name }) => name), expectedModuleNames)
    && templates === 1;
}

async function main(): Promise<void> {
  const seeded = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(SEED_LOCK_SQL);
    if (skipCompleteFixture() && await fixtureIsComplete(tx)) return false;
    await seedBody(tx);
    return true;
  }, { timeout: 180_000, maxWait: 180_000 });

  if (!seeded) {
    // eslint-disable-next-line no-console
    console.log('Seed fixture already complete; skipping destructive rebuild');
  } else {
    // eslint-disable-next-line no-console
    console.log('Seeded org Vitan Architecture + project', PROJECT_ID, '+ location spine + demo accounts & memberships + starter template library');
  }
}

async function seedBody(tx: Prisma.TransactionClient): Promise<void> {
  // wipe (children first) for an idempotent seed. A previous suite run can
  // leave rows in every NO ACTION child table, so the order must hold for a
  // FULLY populated database, not just the fixture this seed creates:
  // GateOverride → {Activity, Media}; DrawingRecipient → Membership;
  // Media → {DailyLog, Decision, Inspection, InspectionItem};
  // Inspection.assignee / Activity.completionRequestedBy → Membership;
  // credential challenges and security events → User.
  // The append-only DomainEvent store (Phase 2 Task 4) has a BEFORE DELETE trigger that
  // blocks row deletes and an ON DELETE RESTRICT tenant FK, so a normal deleteMany fails and
  // its rows would block the Project wipe below. TRUNCATE fires no row trigger — the sanctioned
  // reset for a disposable database (this seed is destructive by contract). CommandExecution
  // (Task 5) and ProjectEventStream cascade with the Project delete, but clearing the events
  // here is what lets that Project delete run at all when a prior run left events behind.
  // Task 10 (Module 3) correction — the rebuildable READ MODELS reset with the event store. A destructive
  // reseed restarts every project's stream at 0, so a surviving ProjectionGeneration (whose appliedPosition
  // can exceed the fresh, shorter stream head) would claim to be CURRENT while its projection rows still
  // hold the PREVIOUS run's state — a stale-served projection by construction. Truncate the generations and
  // every projection table alongside the events/cursors so each run rebuilds its read models from ITS data.
  await tx.$executeRawUnsafe(
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBillRevision", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection"',
  );
  // Phase 3 append-only tables (BEFORE UPDATE/DELETE triggers block deleteMany): the requirement
  // spec/revision/root chain and the immutable decision approval register — TRUNCATEd together
  // because the spec FKs onto the register. Approvals recorded through the API in a prior run
  // would otherwise block the DecisionOption/Decision wipes below. The Task-2 procurement chain
  // (RequisitionLine FKs the ActivityRequirement revision row) joins the same statement: PG
  // refuses to truncate a referenced table unless every referencing table truncates with it.
  // Phase 3 Task 6 — ApprovedSubstitution FKs onto ActivityRequirementRoot (projectId,id), so it
  // truncates in the same statement for exactly that reason.
  await tx.$executeRawUnsafe(
    // Phase 4 Task 2 labour commercial chain (deepest children of ProjectVendor/Vendor/
    // LabourRequirementSpec/LabourRequisition) — truncated in the SAME statement so their FKs
    // never block the ProjectVendor/Vendor wipe below (PostgreSQL truncates a multi-table set
    // atomically, so explicit listing is preferred here over CASCADE).
    // Phase 4 Task 3 §C time-capacity facts — LabourWorkFact FKs WorkerAllocation, which FKs
    // CapacityCommitment (§F bound 3) and LabourRequirementSpec, so they lead the same statement.
    // Phase 4 Task 5 §E/§I — the append-only mismatch register (resolution FKs the observation)
    // and the measured-output facts FK Worker/Activity/Media/CommandExecution, so they lead the
    // statement for the same reason (deleteMany is blocked by their append-only triggers).
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBillRevision", "VendorBill", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "Vendor", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision"',
  );
  await tx.projectCapability.deleteMany();
  await tx.gateOverride.deleteMany();
  await tx.drawingRecipient.deleteMany();
  await tx.passwordCredentialChallenge.deleteMany();
  await tx.securityAuditEvent.deleteMany();
  await tx.auditLog.deleteMany();
  await tx.notification.deleteMany();
  await tx.changeRequest.deleteMany();
  await tx.media.deleteMany();
  await tx.inspectionItem.deleteMany();
  await tx.inspection.deleteMany();
  await tx.crewRow.deleteMany();
  await tx.siteMaterial.deleteMany();
  await tx.dailyLog.deleteMany();
  await tx.drawingAck.deleteMany();
  await tx.drawingRevision.deleteMany();
  await tx.drawing.deleteMany();
  await tx.activity.deleteMany();
  // Phase 6 task 4a — the decision wipe runs BEFORE the membership wipe (round 5, Codex):
  // `Decision.withdrawnById` FKs `Membership(projectId, userId)` ON DELETE NO ACTION, so a
  // database holding a withdrawn decision refuses membership deletion until the decision rows
  // are gone. Every OTHER Decision child (change requests, media, notifications, activities)
  // is already cleared above; the OPTION and EVENT wipes join the guarded transaction below
  // (rounds 11–12, Codex) because a withdrawn decision's options are frozen
  // (`DecisionOption_t4a_frozen`) and approval events are undeletable evidence
  // (`DecisionEvent_no_withdrawn_approval`) — the sanctioned reset disables those named seals
  // for exactly this wipe, atomically with the delete seal. The delete seal (`Decision_t4a_d_no_delete`) refuses
  // withdrawn-row deletes — in a LIVE database the register entry is permanent — and this seed
  // is the sanctioned destructive reset (the same contract that lets the TRUNCATE above bypass
  // the DomainEvent append-only trigger), so the named seal is disabled for exactly this wipe.
  // Guarded: a pre-4a database has no such trigger. ONE transaction (round 6, Codex): PG DDL is
  // transactional, so a wipe that throws rolls the DISABLE back with it — no failure path can
  // leave the seal off; a bare disable/delete/enable sequence could.
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4a_d_no_delete') THEN EXECUTE 'ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'; END IF; END $$;`,
  );
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionOption_t4a_frozen') THEN EXECUTE 'ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'; END IF; END $$;`,
  );
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionEvent_no_withdrawn_approval') THEN EXECUTE 'ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'; END IF; END $$;`,
  );
  await tx.decisionEvent.deleteMany();
  await tx.decisionOption.deleteMany();
  await tx.decision.deleteMany();
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionEvent_no_withdrawn_approval') THEN EXECUTE 'ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'; END IF; END $$;`,
  );
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionOption_t4a_frozen') THEN EXECUTE 'ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'; END IF; END $$;`,
  );
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4a_d_no_delete') THEN EXECUTE 'ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'; END IF; END $$;`,
  );
  // every Membership child (recipients, assignees, completion claims) is gone now
  await tx.membership.deleteMany();
  await tx.orgMembership.deleteMany();
  await tx.workerDevice.deleteMany();
  // Phase 4 Task 1 — the labour identity tables (child → parent; each FKs the project with
  // ON DELETE RESTRICT, so they must clear before project.deleteMany below). The append-only
  // labour requirement DETAIL (LabourRequirementSpec/LabourDemandSlice) is truncated above with
  // ActivityRequirement (deleteMany is blocked by the append-only trigger).
  await tx.crewMembership.deleteMany();
  await tx.crew.deleteMany();
  await tx.worker.deleteMany();
  await tx.labourTrade.deleteMany();
  await tx.labourSkill.deleteMany();
  await tx.pushSubscription.deleteMany();
  // Phase 6 unit 6.1a — the canonical party records WHO created it through a NO ACTION key,
  // because attribution for an external firm is not something a user delete may silently drop.
  // Every reset that wipes users therefore has to clear the identity rows first: this one and
  // `test/integration/fixtures.ts` are the two, and this is the second of the pair.
  // `ProjectCompany` moves up from below `user.deleteMany()` for the same reason — it holds the
  // party reference, so it can no longer be cleared after the party's creator is gone.
  // (`ProjectParty`, its two source tables and `Vendor` are already in the TRUNCATE above.)
  await tx.projectCompany.deleteMany();
  await tx.externalParty.deleteMany();
  await tx.user.deleteMany();
  await tx.phase.deleteMany();
  // (the guarded decision wipe moved ABOVE membership.deleteMany — round 5, Codex)
  await tx.projectNode.deleteMany();
  await tx.project.deleteMany();
  await tx.projectTemplate.deleteMany();
  await tx.templateModule.deleteMany();
  await tx.org.deleteMany();

  // The practice that owns the project (multi-tenant foundation).
  const org = await tx.org.create({ data: { name: 'Vitan Architecture', slug: 'vitan' } });

  await tx.project.create({
    data: {
      id: PROJECT_ID,
      orgId: org.id,
      name: 'Residence at Ambli, Ahmedabad',
      short: 'Residence at Ambli',
      descriptor: 'G+2 Private Residence',
      stage: 'Finishing Stage',
      siteCode: 'AMB-24',
      projStart: '12 Jan 2026',
      projEnd: '30 Sep 2026',
      elapsedPct: 58,
      todayDay: 32,
      milestonePct: 72,
      // the schedule anchor + window (project end matches the projEnd display)
      scheduleStartDate: fromIsoCivilDate(SCHEDULE_ANCHOR),
      scheduleEndDate: fromIsoCivilDate('2026-09-30'),
    },
  });

  // Demo accounts (Phase 7c-auth) — created BEFORE the content so the PMC can author the
  // seeded drafts (draft rows carry authorId; the snapshot delivers them only to their author).
  const demoPassword = process.env.SEED_DEMO_PASSWORD || 'vitan123';
  const hash = bcrypt.hashSync(demoPassword, 10);
  const accounts = [
    { projectId: PROJECT_ID, role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in', passwordHash: hash },
    { projectId: PROJECT_ID, role: 'client', name: 'Mr. Shah', email: 'client@vitan.in', passwordHash: hash },
    { projectId: PROJECT_ID, role: 'contractor', name: 'Rajesh (Contractor)', email: 'contractor@vitan.in', passwordHash: hash },
    { projectId: PROJECT_ID, role: 'engineer', name: 'Site Engineer', phone: '9876543210' },
  ];
  let pmcId = '';
  for (const a of accounts) {
    const user = await tx.user.create({ data: a });
    if (a.role === 'pmc') pmcId = user.id;
    // project membership (the access grant tokens scope to)
    await tx.membership.create({ data: { projectId: PROJECT_ID, userId: user.id, role: a.role, status: 'active' } });
    // the architect administers the org; everyone else is a plain org member
    await tx.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: a.role === 'pmc' ? 'owner' : 'member' } });
  }

  // ── Phase 0 Task 8: deterministic two-project acceptance fixtures ──────────
  // Stable `test-` ids so the API-backed Playwright suite (tests/e2e-api) can
  // authenticate and assert without depending on generated ids or seed order.
  // Project B is DELIBERATELY empty of operational records: it proves that a
  // live project shows only its own facts (never Ambli sample content).
  const PROJECT_B = 'test-empty-site';
  await tx.project.create({
    data: {
      id: PROJECT_B,
      orgId: org.id,
      name: 'Test Empty Site, Bodakdev',
      short: 'Test Empty Site',
      descriptor: 'Acceptance fixture — no records',
      stage: 'Mobilisation',
      siteCode: 'TES-01',
      location: 'Bodakdev, Ahmedabad',
      projStart: '',
      projEnd: '',
      elapsedPct: 0,
      todayDay: 0,
      milestonePct: 0,
      // the anchor is project CONFIG, not an operational record — B stays empty
      // of records but its date derivations must work; no planned end yet is a
      // truthful absence for a mobilisation-stage fixture
      scheduleStartDate: fromIsoCivilDate('2026-07-01'),
    },
  });
  const testUsers: Array<{ id: string; home: string; role: string; name: string; email: string; grants: Array<[string, string]> }> = [
    // home = Project B: login must land on the SERVER-resolved project even when the URL claims A
    { id: 'test-user-pmc-both', home: PROJECT_B, role: 'pmc', name: 'Test PMC (Both Sites)', email: 'test-pmc@vitan.in', grants: [[PROJECT_ID, 'pmc'], [PROJECT_B, 'pmc']] },
    { id: 'test-user-client-b', home: PROJECT_B, role: 'client', name: 'Test Client (Empty Site)', email: 'test-client-b@vitan.in', grants: [[PROJECT_B, 'client']] },
    { id: 'test-user-eng-a', home: PROJECT_ID, role: 'engineer', name: 'Test Engineer (Ambli Only)', email: 'test-eng@vitan.in', grants: [[PROJECT_ID, 'engineer']] },
    // starts as an ACTIVE member of A; the acceptance suite removes the membership live
    { id: 'test-user-removed', home: PROJECT_ID, role: 'engineer', name: 'Test Former Member', email: 'test-removed@vitan.in', grants: [[PROJECT_ID, 'engineer']] },
  ];
  for (const u of testUsers) {
    await tx.user.create({ data: { id: u.id, projectId: u.home, role: u.role, name: u.name, email: u.email, passwordHash: hash } });
    for (const [projectId, role] of u.grants) {
      await tx.membership.create({ data: { projectId, userId: u.id, role, status: 'active' } });
    }
    // plain org members — NEVER owner/admin, so the org super-admin path can't
    // mask a missing membership in the non-member/removed-member scenarios
    await tx.orgMembership.create({ data: { orgId: org.id, userId: u.id, role: 'member' } });
  }

  const publishedAt = new Date();

  // The location spine (zones → rooms → objects), mirroring the demo's tree — including
  // the PMC's private draft Basement branch. Parents before children so the FK resolves.
  for (const n of SEED_NODES) {
    await tx.projectNode.create({
      data: {
        id: n.id,
        projectId: PROJECT_ID,
        parentId: n.parentId,
        name: n.name,
        kind: n.kind,
        order: n.order,
        publishedAt: n.draft ? null : publishedAt,
        authorId: n.draft ? pmcId : null,
      },
    });
  }

  // Decisions, placed on the spine. Published rows get publishedAt (a null publishedAt is
  // an author-private DRAFT — the seeded DL-015, authored by the PMC).
  for (const d of SEED_DECISIONS) {
    const { options, draft, ...rest } = d;
    await tx.decision.create({
      data: {
        ...rest,
        projectId: PROJECT_ID,
        publishedAt: draft ? null : publishedAt,
        authorId: draft ? pmcId : null,
        options: { create: options },
      },
    });
  }

  // The reopened decision (DL-003, status 'change') carries its OPEN change request —
  // a 'change' decision with ZERO open requests is exactly the inconsistent state the
  // change-control diagnostic aborts on and re-approval now refuses (gate finding 1).
  await tx.changeRequest.create({
    data: {
      decisionId: 'DL-003',
      reason: 'Quartz slab size unavailable — vendor proposes 2-piece joint',
      costImpact: 0,
      timeImpactDays: 4,
      status: 'open',
      requestedById: pmcId,
    },
  });

  // Project phases group activities for phase-level monitoring. The legacy
  // day-offsets stay for display geometry; the canonical civil dates derive from
  // the anchor exactly as the services derive them. Created before activities so
  // the FK resolves.
  for (const p of SEED_PHASES) {
    await tx.phase.create({
      data: { ...p, projectId: PROJECT_ID, plannedStartDate: atDay(p.plannedStart), plannedEndDate: atDay(p.plannedEnd) },
    });
  }

  for (const a of SEED_ACTIVITIES) {
    await tx.activity.create({
      data: {
        ...a,
        projectId: PROJECT_ID,
        plannedStartDate: atDay(a.plannedStart),
        plannedEndDate: atDay(a.plannedEnd),
        actualStartDate: a.actualStart === null ? null : atDay(a.actualStart),
        actualEndDate: a.actualEnd === null ? null : atDay(a.actualEnd),
      },
    });
  }

  for (const i of SEED_INSPECTIONS) {
    const { items, dateIso, ...rest } = i;
    await tx.inspection.create({
      data: {
        ...rest,
        projectId: PROJECT_ID,
        inspectionDate: fromIsoCivilDate(dateIso),
        date: ddMmmYyyy(fromIsoCivilDate(dateIso)!),
        items: { create: items },
      },
    });
  }

  const seededLog = await tx.dailyLog.create({
    data: {
      // todayDay 32 from the anchor = 2026-07-03; the display string derives
      projectId: PROJECT_ID, logDate: atDay(32), date: ddMmmYyyy(atDay(32)), checkedIn: false, checkinTime: null, submitted: false, progress: 2,
      crew: {
        create: [
          { trade: 'Flooring mason', count: 2, order: 0 },
          { trade: 'Plumber', count: 1, order: 1 },
          { trade: 'Electrician', count: 0, order: 2 },
          { trade: 'Waterproofing', count: 2, order: 3 },
          { trade: 'Helper / Beldar', count: 5, order: 4 },
        ],
      },
    },
  });
  // materials carry canonical project ownership (composite same-project FKs)
  await tx.siteMaterial.createMany({
    data: SEED_LOG_MATERIALS.map((m) => ({ ...m, projectId: PROJECT_ID, dailyLogId: seededLog.id })),
  });

  // Project A carries at least one record of every kind the acceptance suite
  // checks (decision/activity/checklist/daily log above; drawing + photo here),
  // so "populated A vs empty B" is meaningful on every surface.
  await tx.drawing.create({
    data: {
      id: 'test-drawing-a',
      projectId: PROJECT_ID,
      number: 'A-201',
      title: 'Ground Floor Plan',
      discipline: 'architectural',
      zone: 'Ground Floor',
      publishedAt,
      revisions: {
        create: {
          id: 'test-drawing-a-rev1',
          rev: 'A',
          status: 'for_construction',
          mime: 'application/pdf',
          data: Buffer.from('%PDF-1.4 seed fixture'),
          sizeBytes: 21,
          issuedBy: 'pmc',
          issuedAt: '03 Jul 2026',
        },
      },
    },
  });
  await tx.media.create({
    data: {
      id: 'test-photo-a',
      projectId: PROJECT_ID,
      kind: 'progress',
      mime: 'image/png',
      // 1×1 transparent PNG — a real decodable image for the dev-stub serve path
      data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
      sizeBytes: 68,
      takenAt: '03 Jul 2026 · 9:12 AM',
      uploadedBy: 'engineer',
      nodeId: 'r-living',
    },
  });

  const base = Date.now();
  for (let i = 0; i < SEED_NOTIFICATIONS.length; i++) {
    await tx.notification.create({ data: { ...SEED_NOTIFICATIONS[i], projectId: PROJECT_ID, at: new Date(base - i * 3_600_000) } });
  }

  // The Vitan starter template library (Templates Slice 4) — modules + the
  // "G+2 Residence" preset, so New project opens to a ready menu.
  await createStarterLibraryInTransaction(tx, org.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
