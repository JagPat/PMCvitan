import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  SEED_NODES,
  SEED_DECISIONS,
  SEED_PHASES,
  SEED_ACTIVITIES,
  SEED_INSPECTIONS,
  SEED_LOG_MATERIALS,
  createStarterLibrary,
} from '../src/domain/seed-data';
import { addCivilDays, fromIsoCivilDate } from '../src/common/civil-date';
import { ddMmmYyyy } from '../src/domain/dates';

const prisma = new PrismaClient();

const PROJECT_ID = 'ambli';

// Real civil dates are canonical (Phase 0 Task 6 / Codex round 2 finding 3): the
// seed must write them alongside the legacy day-offsets, never leave them null.
// SCHEDULE_ANCHOR is ambli's DAY0 — offset 0 IS this day, so todayDay 32 lands on
// 2026-07-03, the seeded daily log's civil day.
const SCHEDULE_ANCHOR = '2026-06-01';
const atDay = (offset: number): Date => fromIsoCivilDate(addCivilDays(SCHEDULE_ANCHOR, offset))!;

async function main(): Promise<void> {
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
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection"',
  );
  // Phase 3 append-only tables (BEFORE UPDATE/DELETE triggers block deleteMany): the requirement
  // spec/revision/root chain and the immutable decision approval register — TRUNCATEd together
  // because the spec FKs onto the register. Approvals recorded through the API in a prior run
  // would otherwise block the DecisionOption/Decision wipes below. The Task-2 procurement chain
  // (RequisitionLine FKs the ActivityRequirement revision row) joins the same statement: PG
  // refuses to truncate a referenced table unless every referencing table truncates with it.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "Vendor", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision"',
  );
  await prisma.projectCapability.deleteMany();
  await prisma.gateOverride.deleteMany();
  await prisma.drawingRecipient.deleteMany();
  await prisma.passwordCredentialChallenge.deleteMany();
  await prisma.securityAuditEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.decisionEvent.deleteMany();
  await prisma.changeRequest.deleteMany();
  await prisma.media.deleteMany();
  await prisma.inspectionItem.deleteMany();
  await prisma.inspection.deleteMany();
  await prisma.crewRow.deleteMany();
  await prisma.siteMaterial.deleteMany();
  await prisma.dailyLog.deleteMany();
  await prisma.drawingAck.deleteMany();
  await prisma.drawingRevision.deleteMany();
  await prisma.drawing.deleteMany();
  await prisma.decisionOption.deleteMany();
  await prisma.activity.deleteMany();
  // every Membership child (recipients, assignees, completion claims) is gone now
  await prisma.membership.deleteMany();
  await prisma.orgMembership.deleteMany();
  await prisma.workerDevice.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.user.deleteMany();
  await prisma.phase.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.projectNode.deleteMany();
  await prisma.projectCompany.deleteMany();
  await prisma.project.deleteMany();
  await prisma.projectTemplate.deleteMany();
  await prisma.templateModule.deleteMany();
  await prisma.org.deleteMany();

  // The practice that owns the project (multi-tenant foundation).
  const org = await prisma.org.create({ data: { name: 'Vitan Architecture', slug: 'vitan' } });

  await prisma.project.create({
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
    const user = await prisma.user.create({ data: a });
    if (a.role === 'pmc') pmcId = user.id;
    // project membership (the access grant tokens scope to)
    await prisma.membership.create({ data: { projectId: PROJECT_ID, userId: user.id, role: a.role, status: 'active' } });
    // the architect administers the org; everyone else is a plain org member
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: a.role === 'pmc' ? 'owner' : 'member' } });
  }

  // ── Phase 0 Task 8: deterministic two-project acceptance fixtures ──────────
  // Stable `test-` ids so the API-backed Playwright suite (tests/e2e-api) can
  // authenticate and assert without depending on generated ids or seed order.
  // Project B is DELIBERATELY empty of operational records: it proves that a
  // live project shows only its own facts (never Ambli sample content).
  const PROJECT_B = 'test-empty-site';
  await prisma.project.create({
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
    await prisma.user.create({ data: { id: u.id, projectId: u.home, role: u.role, name: u.name, email: u.email, passwordHash: hash } });
    for (const [projectId, role] of u.grants) {
      await prisma.membership.create({ data: { projectId, userId: u.id, role, status: 'active' } });
    }
    // plain org members — NEVER owner/admin, so the org super-admin path can't
    // mask a missing membership in the non-member/removed-member scenarios
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: u.id, role: 'member' } });
  }

  const publishedAt = new Date();

  // The location spine (zones → rooms → objects), mirroring the demo's tree — including
  // the PMC's private draft Basement branch. Parents before children so the FK resolves.
  for (const n of SEED_NODES) {
    await prisma.projectNode.create({
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
    await prisma.decision.create({
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
  await prisma.changeRequest.create({
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
    await prisma.phase.create({
      data: { ...p, projectId: PROJECT_ID, plannedStartDate: atDay(p.plannedStart), plannedEndDate: atDay(p.plannedEnd) },
    });
  }

  for (const a of SEED_ACTIVITIES) {
    await prisma.activity.create({
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
    await prisma.inspection.create({
      data: {
        ...rest,
        projectId: PROJECT_ID,
        inspectionDate: fromIsoCivilDate(dateIso),
        date: ddMmmYyyy(fromIsoCivilDate(dateIso)!),
        items: { create: items },
      },
    });
  }

  const seededLog = await prisma.dailyLog.create({
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
  await prisma.siteMaterial.createMany({
    data: SEED_LOG_MATERIALS.map((m) => ({ ...m, projectId: PROJECT_ID, dailyLogId: seededLog.id })),
  });

  // Project A carries at least one record of every kind the acceptance suite
  // checks (decision/activity/checklist/daily log above; drawing + photo here),
  // so "populated A vs empty B" is meaningful on every surface.
  await prisma.drawing.create({
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
  await prisma.media.create({
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

  const notifs = [
    { text: 'Client approved Master Bath CP Fittings — Kohler', time: '2h ago', color: '#3F7A54' },
    { text: 'Re-inspection due: Waterproofing, Terrace', time: '1d ago', color: '#B23A34' },
    { text: 'New decision issued for approval: Living Room Flooring', time: '2d ago', color: '#C08A2D' },
  ];
  const base = Date.now();
  for (let i = 0; i < notifs.length; i++) {
    await prisma.notification.create({ data: { ...notifs[i], projectId: PROJECT_ID, at: new Date(base - i * 3_600_000) } });
  }

  // The Vitan starter template library (Templates Slice 4) — modules + the
  // "G+2 Residence" preset, so New project opens to a ready menu.
  const seededLibrary = await createStarterLibrary(prisma, org.id);

  // eslint-disable-next-line no-console
  console.log(
    'Seeded org Vitan Architecture + project', PROJECT_ID,
    '+ location spine + demo accounts & memberships' + (seededLibrary ? ' + starter template library' : ''),
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
