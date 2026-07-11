/**
 * Seed data — the sample project "Residence at Ambli, Ahmedabad" (G+2, finishing
 * stage). Ported verbatim from the prototype state so the app is fully usable
 * offline before the backend exists. The `localGateway` loads this; the future
 * `apiGateway` (Phase 7) replaces it with server data.
 */

import type {
  Activity,
  Checklist,
  DailyLog,
  Decision,
  AppNotification,
  Review,
  Drawing,
  Phase,
  ProjectNode,
  Photo,
  Material,
  PlacedInspection,
} from './types';

export const PROJECT = {
  name: 'Residence at Ambli, Ahmedabad',
  short: 'Residence at Ambli',
  descriptor: 'G+2 Private Residence',
  stage: 'Finishing Stage',
  siteCode: 'AMB-24',
  projStart: '12 Jan 2026',
  projEnd: '30 Sep 2026',
  elapsedPct: 58,
  /** day-offset from 1 Jun 2026 = "today" (3 Jul 2026) */
  todayDay: 32,
  milestonePct: 72,
} as const;

export const SEED_DECISIONS: Decision[] = [
  {
    // A private work-in-progress DRAFT: the architect is still choosing the shortlist. It sits
    // only in the Drafts workspace (author-only) and does NOT appear on the client's screen,
    // the Decision Log, or the pending count — until it's published.
    id: 'DL-015',
    nodeId: 'r-living',
    title: 'Living Room Feature Wall',
    room: 'Ground Floor · Living',
    status: 'pending',
    draft: true,
    ageDays: 0,
    photoSwatch: 'walnut',
    options: [
      { label: 'Option A', key: 'A', material: 'Fluted Walnut', delta: 0, swatch: 'walnut', recommended: true },
      { label: 'Option B', key: 'B', material: 'Textured Stone', delta: 48000, swatch: 'marble', recommended: false },
    ],
  },
  {
    id: 'DL-014',
    nodeId: 'r-living',
    title: 'Living Room Flooring',
    room: 'Ground Floor · Living',
    status: 'pending',
    ageDays: 3,
    photoSwatch: 'marble',
    options: [
      { label: 'Option A', key: 'A', material: 'Large-format Vitrified', delta: 0, swatch: 'vitrified', recommended: false },
      { label: 'Option B', key: 'B', material: 'Italian Marble (Botticino)', delta: 140000, swatch: 'marble', recommended: true },
    ],
  },
  {
    id: 'DL-011',
    nodeId: 'e-maindoor',
    title: 'Main Door Veneer',
    room: 'Ground Floor · Entrance',
    status: 'pending',
    ageDays: 6,
    photoSwatch: 'walnut',
    options: [
      { label: 'Option A', key: 'A', material: 'Teak Veneer', delta: 0, swatch: 'teak', recommended: false },
      { label: 'Option B', key: 'B', material: 'Walnut Veneer (Matt)', delta: 32000, swatch: 'walnut', recommended: true },
    ],
  },
  {
    id: 'DL-009',
    nodeId: 'r-mbath',
    title: 'Master Bath CP Fittings',
    room: 'Second Floor · Master Bath',
    status: 'approved',
    approvedOption: 'Option B',
    material: 'Kohler',
    approver: 'Mr. Shah',
    date: '12 Jun 2026',
    cost: 86000,
    photoSwatch: 'chrome',
    options: [
      { label: 'Option A', key: 'A', material: 'Jaquar', delta: 0, swatch: 'chrome', recommended: false },
      { label: 'Option B', key: 'B', material: 'Kohler', delta: 86000, swatch: 'chrome', recommended: true },
    ],
  },
  {
    id: 'DL-006',
    title: 'Staircase Railing',
    room: 'Staircase · G to 2',
    status: 'approved',
    approvedOption: 'Option B',
    material: 'Glass + Wood',
    approver: 'Mrs. Shah',
    date: '04 Jun 2026',
    cost: 210000,
    photoSwatch: 'glass',
    options: [
      { label: 'Option A', key: 'A', material: 'MS Powder-coated', delta: 0, swatch: 'chrome', recommended: false },
      { label: 'Option B', key: 'B', material: 'Glass + Wood', delta: 210000, swatch: 'glass', recommended: true },
    ],
  },
  {
    id: 'DL-003',
    nodeId: 'r-kitchen',
    title: 'Kitchen Counter Top',
    room: 'Ground Floor · Kitchen',
    status: 'change',
    approvedOption: 'Option A',
    material: 'Quartz (Statuario)',
    approver: 'Mr. Shah',
    date: '28 May 2026',
    cost: 118000,
    photoSwatch: 'quartz',
    options: [],
  },
];

export const SEED_CHECKLIST: Checklist = {
  id: 'INSP-22',
  title: 'Pre-Tiling Inspection',
  zone: 'Bathroom 2 · 3rd Floor',
  date: '03 Jul 2026',
  submitted: false,
  items: [
    { name: 'Surface level & slope checked', state: null, photos: 0, note: '' },
    { name: 'Waterproofing coat cured (7 days)', state: null, photos: 0, note: '' },
    { name: 'Tile layout dry-run marked', state: null, photos: 0, note: '' },
    { name: 'Skirting height reference marked', state: null, photos: 0, note: '' },
    { name: 'Plumbing points & levels verified', state: null, photos: 0, note: '' },
  ],
};

export const SEED_REVIEW: Review = {
  id: 'INSP-21',
  title: 'Waterproofing Ponding Test',
  zone: 'Terrace',
  by: 'Site Engineer (Ramesh)',
  date: '02 Jul 2026',
  decided: false,
  items: [
    { name: 'Ponding water level maintained 48h', result: 'PASS', swatch: 'water', note: 'Level held for 48 hours, no visible drop.', rejected: false },
    { name: 'No seepage at slab soffit below', result: 'PASS', swatch: 'concrete', note: 'Soffit inspected, dry.', rejected: false },
    { name: 'Drain outlets & slope to gully', result: 'FAIL', swatch: 'water', note: 'Water pooling at NE corner — slope insufficient.', rejected: false },
    { name: 'Parapet-junction coving intact', result: 'PASS', swatch: 'concrete', note: 'Coving continuous, no cracks.', rejected: false },
  ],
};

/** Inspections placed on the location tree for the demo Site Map (pmc/engineer only).
 *  A passed one has failedItems 0; INSP-21 mirrors the seeded review (one failing item). */
export const SEED_PLACED_INSPECTIONS: PlacedInspection[] = [
  { id: 'INSP-21', title: 'Waterproofing Ponding Test', zone: 'Terrace', nodeId: 'z-terrace', kind: 'review', submitted: true, decided: false, failedItems: 1 },
  { id: 'INSP-18', title: 'CP Fittings & Pressure Test', zone: 'Second Floor · Master Bath', nodeId: 'r-mbath', kind: 'review', submitted: true, decided: true, failedItems: 0 },
];

/** A mock title-block sheet as an inline SVG data URL — stands in for a real
 *  drawing file in the local demo (the API serves real PDFs/DWGs). */
function sheet(num: string, title: string, rev: string, tag: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='560' viewBox='0 0 420 560'>
    <rect width='420' height='560' fill='#f4f1ea'/>
    <rect x='14' y='14' width='392' height='532' fill='none' stroke='#23211c' stroke-width='2'/>
    <line x1='14' y1='486' x2='406' y2='486' stroke='#23211c' stroke-width='1.5'/>
    <line x1='300' y1='486' x2='300' y2='546' stroke='#23211c' stroke-width='1.5'/>
    <rect x='40' y='60' width='340' height='380' fill='none' stroke='#b8b2a6' stroke-dasharray='4 4'/>
    <text x='210' y='250' font-family='monospace' font-size='15' fill='#b8b2a6' text-anchor='middle'>${tag}</text>
    <text x='26' y='512' font-family='sans-serif' font-weight='700' font-size='16' fill='#23211c'>${num}</text>
    <text x='26' y='534' font-family='sans-serif' font-size='12' fill='#5b564c'>${title}</text>
    <text x='316' y='512' font-family='monospace' font-size='11' fill='#5b564c'>REV</text>
    <text x='316' y='534' font-family='sans-serif' font-weight='700' font-size='18' fill='#B4462E'>${rev}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const SEED_DRAWINGS: Drawing[] = [
  {
    id: 'DWG-1',
    number: 'A-201',
    nodeId: 'r-living',
    title: 'Living Room — Flooring Layout',
    discipline: 'architectural',
    zone: 'Ground Floor · Living',
    activityId: 'ACT-31',
    decisionId: 'DL-014',
    ackedByMe: false,
    current: { id: 'A-201-C', rev: 'C', status: 'for_construction', mime: 'application/pdf', url: sheet('A-201', 'Living Room Flooring Layout', 'C', 'PLAN · 1:50'), sizeBytes: 184320, note: 'Italian marble setting-out; expansion joints marked.', issuedBy: 'Ar. Vitan', issuedAt: '06 Jul 2026', acks: [{ userName: 'Rajesh (Contractor)', role: 'contractor', at: '06 Jul 2026' }] },
    revisions: [
      { id: 'A-201-C', rev: 'C', status: 'for_construction', mime: 'application/pdf', url: sheet('A-201', 'Living Room Flooring Layout', 'C', 'PLAN · 1:50'), sizeBytes: 184320, note: 'Italian marble setting-out; expansion joints marked.', issuedBy: 'Ar. Vitan', issuedAt: '06 Jul 2026', acks: [{ userName: 'Rajesh (Contractor)', role: 'contractor', at: '06 Jul 2026' }] },
      { id: 'A-201-B', rev: 'B', status: 'superseded', mime: 'application/pdf', url: sheet('A-201', 'Living Room Flooring Layout', 'B', 'PLAN · 1:50'), sizeBytes: 176128, note: 'Revised border pattern per client.', issuedBy: 'Ar. Vitan', issuedAt: '21 Jun 2026', acks: [] },
      { id: 'A-201-A', rev: 'A', status: 'superseded', mime: 'application/pdf', url: sheet('A-201', 'Living Room Flooring Layout', 'A', 'PLAN · 1:50'), sizeBytes: 170000, note: 'First issue for construction.', issuedBy: 'Ar. Vitan', issuedAt: '02 Jun 2026', acks: [] },
    ],
  },
  {
    id: 'DWG-2',
    number: 'S-101',
    nodeId: 'z-terrace',
    title: 'Terrace — Slab & Waterproofing Detail',
    discipline: 'structural',
    zone: 'Terrace',
    activityId: 'ACT-28',
    decisionId: null,
    ackedByMe: false,
    current: { id: 'S-101-A', rev: 'A', status: 'for_construction', mime: 'image/vnd.dwg', url: sheet('S-101', 'Terrace Slab Detail', 'A', 'DWG · CAD source'), sizeBytes: 512000, note: 'DWG source — issue the PDF export to the field.', issuedBy: 'Ar. Vitan', issuedAt: '28 May 2026', acks: [] },
    revisions: [
      { id: 'S-101-A', rev: 'A', status: 'for_construction', mime: 'image/vnd.dwg', url: sheet('S-101', 'Terrace Slab Detail', 'A', 'DWG · CAD source'), sizeBytes: 512000, note: 'DWG source — issue the PDF export to the field.', issuedBy: 'Ar. Vitan', issuedAt: '28 May 2026', acks: [] },
    ],
  },
  {
    id: 'DWG-3',
    number: 'SK-07',
    nodeId: 'e-maindoor',
    title: 'Main Door — Veneer Grain Reference',
    discipline: 'other',
    zone: 'Ground Floor · Entrance',
    activityId: 'ACT-33',
    decisionId: 'DL-011',
    ackedByMe: false,
    current: { id: 'SK-07-A', rev: 'A', status: 'for_construction', mime: 'image/svg+xml', url: sheet('SK-07', 'Veneer Grain Reference', 'A', 'SKETCH · reference'), sizeBytes: 96000, note: 'Site sketch — walnut grain direction for the main door.', issuedBy: 'Ar. Vitan', issuedAt: '03 Jul 2026', acks: [] },
    revisions: [
      { id: 'SK-07-A', rev: 'A', status: 'for_construction', mime: 'image/svg+xml', url: sheet('SK-07', 'Veneer Grain Reference', 'A', 'SKETCH · reference'), sizeBytes: 96000, note: 'Site sketch — walnut grain direction for the main door.', issuedBy: 'Ar. Vitan', issuedAt: '03 Jul 2026', acks: [] },
    ],
  },
  {
    // A private work-in-progress DRAFT drawing — the architect is still preparing the feature
    // wall elevation. It sits only in the Drafts workspace (author-only): not in the register,
    // not on the Site Map, and the build team is not asked to acknowledge it, until published.
    id: 'DWG-4',
    number: 'A-305',
    nodeId: 'r-living',
    title: 'Living Room — Feature Wall Elevation',
    discipline: 'architectural',
    zone: 'Ground Floor · Living',
    activityId: null,
    decisionId: null,
    draft: true,
    ackedByMe: false,
    current: { id: 'A-305-A', rev: 'A', status: 'for_construction', mime: 'application/pdf', url: sheet('A-305', 'Feature Wall Elevation', 'A', 'ELEV · 1:25'), sizeBytes: 128000, note: 'Draft — fluted walnut vs stone, dimensions being finalised.', issuedBy: 'Ar. Vitan', issuedAt: 'just now', acks: [] },
    revisions: [
      { id: 'A-305-A', rev: 'A', status: 'for_construction', mime: 'application/pdf', url: sheet('A-305', 'Feature Wall Elevation', 'A', 'ELEV · 1:25'), sizeBytes: 128000, note: 'Draft — fluted walnut vs stone, dimensions being finalised.', issuedBy: 'Ar. Vitan', issuedAt: 'just now', acks: [] },
    ],
  },
];

export const SEED_ACTIVITIES: Activity[] = [
  { id: 'ACT-22', name: 'Electrical Rough-In', zone: 'Second Floor', decisionId: null, phaseId: 'PH-services', ps: 9, pe: 19, as: 9, ae: 18, status: 'done', gm: 'ok', gt: 'ok', gi: 'ok' },
  { id: 'ACT-25', nodeId: 'r-mbath', name: 'Master Bath CP Fittings', zone: 'Second Floor · Master Bath', decisionId: 'DL-009', phaseId: 'PH-wetareas', ps: 19, pe: 27, as: 20, ae: 26, status: 'done', gm: 'ok', gt: 'ok', gi: 'ok' },
  { id: 'ACT-28', nodeId: 'z-terrace', name: 'Waterproofing — Terrace', zone: 'Terrace', decisionId: null, phaseId: 'PH-services', ps: 23, pe: 30, as: 24, ae: null, status: 'blocked', gm: 'ok', gt: 'ok', gi: 'fail', block: 'Ponding test failed — drain slope' },
  { id: 'ACT-31', nodeId: 'r-living', name: 'Living Room Flooring', zone: 'Ground Floor · Living', decisionId: 'DL-014', phaseId: 'PH-finishing', ps: 34, pe: 41, as: null, ae: null, status: 'not-started', gm: 'wait', gt: 'wait', gi: 'wait' },
  { id: 'ACT-35', name: 'Staircase Railing', zone: 'Staircase · G to 2', decisionId: 'DL-006', phaseId: 'PH-finishing', ps: 37, pe: 44, as: null, ae: null, status: 'not-started', gm: 'wait', gt: 'na', gi: 'wait' },
  { id: 'ACT-33', nodeId: 'e-maindoor', name: 'Main Door Veneer', zone: 'Ground Floor · Entrance', decisionId: 'DL-011', phaseId: 'PH-finishing', ps: 43, pe: 47, as: null, ae: null, status: 'not-started', gm: 'wait', gt: 'na', gi: 'na' },
];

/** Seeded project phases with rollups pre-computed from SEED_ACTIVITIES above —
 *  the local-demo mirror of the server's snapshot `phases[]`. */
export const SEED_PHASES: Phase[] = [
  { id: 'PH-services', name: 'Services & Waterproofing', order: 0, plannedStart: 9, plannedEnd: 30, activityTotal: 2, done: 1, inProgress: 0, blocked: 1, notStarted: 0, donePct: 50 },
  { id: 'PH-wetareas', name: 'Wet Areas & Fittings', order: 1, plannedStart: 19, plannedEnd: 27, activityTotal: 1, done: 1, inProgress: 0, blocked: 0, notStarted: 0, donePct: 100 },
  { id: 'PH-finishing', name: 'Finishing', order: 2, plannedStart: 34, plannedEnd: 47, activityTotal: 3, done: 0, inProgress: 0, blocked: 0, notStarted: 3, donePct: 0 },
];

export const SEED_DAILY_LOG: DailyLog = {
  date: '03 Jul 2026',
  checkedIn: false,
  checkinTime: null,
  submitted: false,
  crew: [
    { trade: 'Flooring mason', count: 2 },
    { trade: 'Plumber', count: 1 },
    { trade: 'Electrician', count: 0 },
    { trade: 'Waterproofing', count: 2 },
    { trade: 'Helper / Beldar', count: 5 },
  ],
  materials: [
    { name: 'Italian Marble (Botticino)', decisionId: 'DL-014', qty: '42 boxes', zone: 'Zone B · covered, on pallets', matched: true, swatch: 'marble', photo: true },
    { name: 'CP Fittings — Kohler', decisionId: 'DL-009', qty: 'Set of 6', zone: 'Store room · locked', matched: true, swatch: 'chrome', photo: true },
  ],
  progress: 2,
  photos: [],
};

/**
 * The project's location tree (zones → rooms → objects) for the local demo. The API
 * serves the real tree; this lets the whole location spine — the Decision Log grouping,
 * the pickers and the Site Map — work offline. Ids are stable so the seed rows above
 * (decisions, drawings, activities) reference them.
 */
export const SEED_NODES: ProjectNode[] = [
  { id: 'z-gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'r-living', parentId: 'z-gf', name: 'Living Room', kind: 'room', order: 0 },
  { id: 'r-entrance', parentId: 'z-gf', name: 'Entrance', kind: 'room', order: 1 },
  { id: 'e-maindoor', parentId: 'r-entrance', name: 'Main Door', kind: 'element', order: 0 },
  { id: 'r-kitchen', parentId: 'z-gf', name: 'Kitchen', kind: 'room', order: 2 },
  { id: 'z-sf', parentId: null, name: 'Second Floor', kind: 'zone', order: 1 },
  { id: 'r-mbath', parentId: 'z-sf', name: 'Master Bath', kind: 'room', order: 0 },
  { id: 'z-terrace', parentId: null, name: 'Terrace', kind: 'zone', order: 2 },
];

/** A mock site photo as an inline SVG data URL — stands in for a real geo/time-stamped
 *  photo in the local demo (the API serves real images). */
function photo(label: string, tint: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>
    <rect width='400' height='400' fill='${tint}'/>
    <rect width='400' height='120' y='280' fill='rgba(0,0,0,.28)'/>
    <text x='20' y='330' font-family='sans-serif' font-weight='700' font-size='19' fill='#fff'>${label}</text>
    <text x='20' y='356' font-family='monospace' font-size='12' fill='rgba(255,255,255,.85)'>SITE PHOTO · geo + time stamped</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Placed site photos for the demo Site Map — the "reality" layer at a location. */
export const SEED_PHOTOS: Photo[] = [
  { id: 'ph-3', url: photo('Living Room — marble dry-lay', '#b7a98d'), takenAt: '03 Jul 2026', nodeId: 'r-living', kind: 'progress' },
  { id: 'ph-2', url: photo('Living Room — screed poured', '#8a8378'), takenAt: '01 Jul 2026', nodeId: 'r-living', kind: 'progress' },
  { id: 'ph-1', url: photo('Main Door — veneer applied', '#6b4a2f'), takenAt: '03 Jul 2026', nodeId: 'e-maindoor', kind: 'progress' },
];

/** All material deliveries across the project, placed on the tree — the Site Map's
 *  "materials here" (the demo mirror of the server's top-level `materials[]`). */
export const SEED_MATERIALS: Material[] = [
  { id: 'm-1', name: 'Italian Marble (Botticino)', qty: '42 boxes', zone: 'Zone B · covered, on pallets', matched: true, swatch: 'marble', decisionId: 'DL-014', nodeId: 'r-living' },
  { id: 'm-2', name: 'CP Fittings — Kohler', qty: 'Set of 6', zone: 'Store room · locked', matched: true, swatch: 'chrome', decisionId: 'DL-009', nodeId: 'r-mbath' },
];

export const SEED_NOTIFICATIONS: AppNotification[] = [
  { text: 'Client approved Master Bath CP Fittings — Kohler', time: '2h ago', color: '#3F7A54' },
  { text: 'Re-inspection due: Waterproofing, Terrace', time: '1d ago', color: '#B23A34' },
  { text: 'New decision issued for approval: Living Room Flooring', time: '2d ago', color: '#C08A2D' },
];

export const SEED_MILESTONES = [
  { label: 'Structure', done: true },
  { label: 'Masonry', done: true },
  { label: 'Services', done: true },
  { label: 'Finishing', done: false },
  { label: 'Handover', done: false },
];
