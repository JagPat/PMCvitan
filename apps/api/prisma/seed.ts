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

const prisma = new PrismaClient();

const PROJECT_ID = 'ambli';

async function main(): Promise<void> {
  // wipe (children first) for an idempotent seed
  await prisma.membership.deleteMany();
  await prisma.orgMembership.deleteMany();
  await prisma.workerDevice.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.user.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.decisionEvent.deleteMany();
  await prisma.changeRequest.deleteMany();
  await prisma.inspectionItem.deleteMany();
  await prisma.inspection.deleteMany();
  await prisma.crewRow.deleteMany();
  await prisma.siteMaterial.deleteMany();
  await prisma.dailyLog.deleteMany();
  await prisma.drawingAck.deleteMany();
  await prisma.drawingRevision.deleteMany();
  await prisma.drawing.deleteMany();
  await prisma.media.deleteMany();
  await prisma.decisionOption.deleteMany();
  await prisma.activity.deleteMany();
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

  // Project phases group activities for phase-level monitoring (planned windows as
  // day-offsets from 1 Jun 2026). Created before activities so the FK resolves.
  for (const p of SEED_PHASES) {
    await prisma.phase.create({ data: { ...p, projectId: PROJECT_ID } });
  }

  for (const a of SEED_ACTIVITIES) {
    await prisma.activity.create({ data: { ...a, projectId: PROJECT_ID } });
  }

  for (const i of SEED_INSPECTIONS) {
    const { items, ...rest } = i;
    await prisma.inspection.create({ data: { ...rest, projectId: PROJECT_ID, items: { create: items } } });
  }

  await prisma.dailyLog.create({
    data: {
      projectId: PROJECT_ID, date: '03 Jul 2026', checkedIn: false, checkinTime: null, submitted: false, progress: 2,
      crew: {
        create: [
          { trade: 'Flooring mason', count: 2, order: 0 },
          { trade: 'Plumber', count: 1, order: 1 },
          { trade: 'Electrician', count: 0, order: 2 },
          { trade: 'Waterproofing', count: 2, order: 3 },
          { trade: 'Helper / Beldar', count: 5, order: 4 },
        ],
      },
      materials: { create: SEED_LOG_MATERIALS },
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
