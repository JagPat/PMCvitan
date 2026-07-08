import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PROJECT_ID = 'ambli';

async function main(): Promise<void> {
  // wipe (children first) for an idempotent seed
  await prisma.membership.deleteMany();
  await prisma.orgMembership.deleteMany();
  await prisma.workerDevice.deleteMany();
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
  await prisma.decisionOption.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.project.deleteMany();
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

  const decisions = [
    {
      id: 'DL-014', title: 'Living Room Flooring', room: 'Ground Floor · Living', status: 'pending' as const, ageDays: 3, photoSwatch: 'marble',
      options: [
        { label: 'Option A', optionKey: 'A', material: 'Large-format Vitrified', delta: 0, swatch: 'vitrified', recommended: false, order: 0 },
        { label: 'Option B', optionKey: 'B', material: 'Italian Marble (Botticino)', delta: 140000, swatch: 'marble', recommended: true, order: 1 },
      ],
    },
    {
      id: 'DL-011', title: 'Main Door Veneer', room: 'Ground Floor · Entrance', status: 'pending' as const, ageDays: 6, photoSwatch: 'walnut',
      options: [
        { label: 'Option A', optionKey: 'A', material: 'Teak Veneer', delta: 0, swatch: 'teak', recommended: false, order: 0 },
        { label: 'Option B', optionKey: 'B', material: 'Walnut Veneer (Matt)', delta: 32000, swatch: 'walnut', recommended: true, order: 1 },
      ],
    },
    {
      id: 'DL-009', title: 'Master Bath CP Fittings', room: 'Second Floor · Master Bath', status: 'approved' as const, photoSwatch: 'chrome',
      approvedOption: 'Option B', material: 'Kohler', approver: 'Mr. Shah', date: '12 Jun 2026', cost: 86000,
      options: [
        { label: 'Option A', optionKey: 'A', material: 'Jaquar', delta: 0, swatch: 'chrome', recommended: false, order: 0 },
        { label: 'Option B', optionKey: 'B', material: 'Kohler', delta: 86000, swatch: 'chrome', recommended: true, order: 1 },
      ],
    },
    {
      id: 'DL-006', title: 'Staircase Railing', room: 'Staircase · G to 2', status: 'approved' as const, photoSwatch: 'glass',
      approvedOption: 'Option B', material: 'Glass + Wood', approver: 'Mrs. Shah', date: '04 Jun 2026', cost: 210000,
      options: [
        { label: 'Option A', optionKey: 'A', material: 'MS Powder-coated', delta: 0, swatch: 'chrome', recommended: false, order: 0 },
        { label: 'Option B', optionKey: 'B', material: 'Glass + Wood', delta: 210000, swatch: 'glass', recommended: true, order: 1 },
      ],
    },
    {
      id: 'DL-003', title: 'Kitchen Counter Top', room: 'Ground Floor · Kitchen', status: 'change' as const, photoSwatch: 'quartz',
      approvedOption: 'Option A', material: 'Quartz (Statuario)', approver: 'Mr. Shah', date: '28 May 2026', cost: 118000,
      options: [],
    },
  ];

  for (const d of decisions) {
    const { options, ...rest } = d;
    await prisma.decision.create({
      data: { ...rest, projectId: PROJECT_ID, options: { create: options } },
    });
  }

  const activities = [
    { id: 'ACT-22', name: 'Electrical Rough-In', zone: 'Second Floor', decisionId: null, plannedStart: 9, plannedEnd: 19, actualStart: 9, actualEnd: 18, status: 'done' as const, gateMaterial: 'ok' as const, gateTeam: 'ok' as const, gateInspection: 'ok' as const, order: 0 },
    { id: 'ACT-25', name: 'Master Bath CP Fittings', zone: 'Second Floor · Master Bath', decisionId: 'DL-009', plannedStart: 19, plannedEnd: 27, actualStart: 20, actualEnd: 26, status: 'done' as const, gateMaterial: 'ok' as const, gateTeam: 'ok' as const, gateInspection: 'ok' as const, order: 1 },
    { id: 'ACT-28', name: 'Waterproofing — Terrace', zone: 'Terrace', decisionId: null, plannedStart: 23, plannedEnd: 30, actualStart: 24, actualEnd: null, status: 'blocked' as const, gateMaterial: 'ok' as const, gateTeam: 'ok' as const, gateInspection: 'fail' as const, block: 'Ponding test failed — drain slope', order: 2 },
    { id: 'ACT-31', name: 'Living Room Flooring', zone: 'Ground Floor · Living', decisionId: 'DL-014', plannedStart: 34, plannedEnd: 41, actualStart: null, actualEnd: null, status: 'not_started' as const, gateMaterial: 'wait' as const, gateTeam: 'wait' as const, gateInspection: 'wait' as const, order: 3 },
    { id: 'ACT-35', name: 'Staircase Railing', zone: 'Staircase · G to 2', decisionId: 'DL-006', plannedStart: 37, plannedEnd: 44, actualStart: null, actualEnd: null, status: 'not_started' as const, gateMaterial: 'wait' as const, gateTeam: 'na' as const, gateInspection: 'wait' as const, order: 4 },
    { id: 'ACT-33', name: 'Main Door Veneer', zone: 'Ground Floor · Entrance', decisionId: 'DL-011', plannedStart: 43, plannedEnd: 47, actualStart: null, actualEnd: null, status: 'not_started' as const, gateMaterial: 'wait' as const, gateTeam: 'na' as const, gateInspection: 'na' as const, order: 5 },
  ];
  for (const a of activities) {
    await prisma.activity.create({ data: { ...a, projectId: PROJECT_ID } });
  }

  await prisma.inspection.create({
    data: {
      id: 'INSP-22', projectId: PROJECT_ID, kind: 'checklist', title: 'Pre-Tiling Inspection', zone: 'Bathroom 2 · 3rd Floor', date: '03 Jul 2026', submitted: false, decided: false,
      items: {
        create: [
          { name: 'Surface level & slope checked', order: 0 },
          { name: 'Waterproofing coat cured (7 days)', order: 1 },
          { name: 'Tile layout dry-run marked', order: 2 },
          { name: 'Skirting height reference marked', order: 3 },
          { name: 'Plumbing points & levels verified', order: 4 },
        ],
      },
    },
  });

  await prisma.inspection.create({
    data: {
      id: 'INSP-21', projectId: PROJECT_ID, kind: 'review', title: 'Waterproofing Ponding Test', zone: 'Terrace', by: 'Site Engineer (Ramesh)', date: '02 Jul 2026', submitted: true, decided: false,
      items: {
        create: [
          { name: 'Ponding water level maintained 48h', result: 'PASS', swatch: 'water', note: 'Level held for 48 hours, no visible drop.', order: 0 },
          { name: 'No seepage at slab soffit below', result: 'PASS', swatch: 'concrete', note: 'Soffit inspected, dry.', order: 1 },
          { name: 'Drain outlets & slope to gully', result: 'FAIL', swatch: 'water', note: 'Water pooling at NE corner — slope insufficient.', order: 2 },
          { name: 'Parapet-junction coving intact', result: 'PASS', swatch: 'concrete', note: 'Coving continuous, no cracks.', order: 3 },
        ],
      },
    },
  });

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
      materials: {
        create: [
          { name: 'Italian Marble (Botticino)', decisionId: 'DL-014', qty: '42 boxes', zone: 'Zone B · covered, on pallets', matched: true, swatch: 'marble', photo: true, order: 0 },
          { name: 'CP Fittings — Kohler', decisionId: 'DL-009', qty: 'Set of 6', zone: 'Store room · locked', matched: true, swatch: 'chrome', photo: true, order: 1 },
        ],
      },
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

  // Demo accounts (Phase 7c-auth). PMC / client / contractor sign in with
  // email + password; the site engineer signs in with phone + OTP (dev-stubbed
  // to any code the server logs when no MSG91 provider is configured).
  const demoPassword = process.env.SEED_DEMO_PASSWORD || 'vitan123';
  const hash = bcrypt.hashSync(demoPassword, 10);
  const accounts = [
    { projectId: PROJECT_ID, role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in', passwordHash: hash },
    { projectId: PROJECT_ID, role: 'client', name: 'Mr. Shah', email: 'client@vitan.in', passwordHash: hash },
    { projectId: PROJECT_ID, role: 'contractor', name: 'Rajesh (Contractor)', email: 'contractor@vitan.in', passwordHash: hash },
    { projectId: PROJECT_ID, role: 'engineer', name: 'Site Engineer', phone: '9876543210' },
  ];
  for (const a of accounts) {
    const user = await prisma.user.create({ data: a });
    // project membership (the access grant tokens scope to)
    await prisma.membership.create({ data: { projectId: PROJECT_ID, userId: user.id, role: a.role, status: 'active' } });
    // the architect administers the org; everyone else is a plain org member
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: a.role === 'pmc' ? 'owner' : 'member' } });
  }

  // eslint-disable-next-line no-console
  console.log('Seeded org Vitan Architecture + project', PROJECT_ID, '+ demo accounts & memberships');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
