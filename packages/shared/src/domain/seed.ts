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
    id: 'DL-014',
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

export const SEED_ACTIVITIES: Activity[] = [
  { id: 'ACT-22', name: 'Electrical Rough-In', zone: 'Second Floor', decisionId: null, ps: 9, pe: 19, as: 9, ae: 18, status: 'done', gm: 'ok', gt: 'ok', gi: 'ok' },
  { id: 'ACT-25', name: 'Master Bath CP Fittings', zone: 'Second Floor · Master Bath', decisionId: 'DL-009', ps: 19, pe: 27, as: 20, ae: 26, status: 'done', gm: 'ok', gt: 'ok', gi: 'ok' },
  { id: 'ACT-28', name: 'Waterproofing — Terrace', zone: 'Terrace', decisionId: null, ps: 23, pe: 30, as: 24, ae: null, status: 'blocked', gm: 'ok', gt: 'ok', gi: 'fail', block: 'Ponding test failed — drain slope' },
  { id: 'ACT-31', name: 'Living Room Flooring', zone: 'Ground Floor · Living', decisionId: 'DL-014', ps: 34, pe: 41, as: null, ae: null, status: 'not-started', gm: 'wait', gt: 'wait', gi: 'wait' },
  { id: 'ACT-35', name: 'Staircase Railing', zone: 'Staircase · G to 2', decisionId: 'DL-006', ps: 37, pe: 44, as: null, ae: null, status: 'not-started', gm: 'wait', gt: 'na', gi: 'wait' },
  { id: 'ACT-33', name: 'Main Door Veneer', zone: 'Ground Floor · Entrance', decisionId: 'DL-011', ps: 43, pe: 47, as: null, ae: null, status: 'not-started', gm: 'wait', gt: 'na', gi: 'na' },
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
};

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
