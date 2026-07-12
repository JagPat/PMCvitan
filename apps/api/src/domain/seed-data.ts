/**
 * Demo-project seed data + the Vitan starter template library — the single source both
 * `prisma/seed.ts` (wipe + reload) and `prisma/ensure-accounts.ts` (create-only, live-safe)
 * draw from.
 *
 * MIRRORS `packages/shared/src/domain/seed.ts` (the demo's fixtures). That package is
 * source-only — the Node runtime can't import it — so the values are pinned here and
 * `seed-data.test.ts` guards the alignment (same convention as the `EXPECTED_ROLES`
 * mirror in route-policy.test.ts). This closes the data-flow audit's #1 finding: the API
 * seed used to be a hand-copy with an EMPTY location spine, so a freshly seeded API
 * rendered a blank Site Map while the demo showed a rich tree.
 */
import type { PrismaClient } from '@prisma/client';
import type { ModulePayload } from '../contracts';

// ── The location spine (zones → rooms → objects) — mirrors shared SEED_NODES ──

export interface SeedNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'zone' | 'room' | 'element';
  order: number;
  /** a private draft branch (the PMC's work-in-progress Basement) */
  draft?: boolean;
}

export const SEED_NODES: SeedNode[] = [
  { id: 'z-gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'r-living', parentId: 'z-gf', name: 'Living Room', kind: 'room', order: 0 },
  { id: 'r-entrance', parentId: 'z-gf', name: 'Entrance', kind: 'room', order: 1 },
  { id: 'e-maindoor', parentId: 'r-entrance', name: 'Main Door', kind: 'element', order: 0 },
  { id: 'r-kitchen', parentId: 'z-gf', name: 'Kitchen', kind: 'room', order: 2 },
  { id: 'z-sf', parentId: null, name: 'Second Floor', kind: 'zone', order: 1 },
  { id: 'r-mbath', parentId: 'z-sf', name: 'Master Bath', kind: 'room', order: 0 },
  { id: 'z-terrace', parentId: null, name: 'Terrace', kind: 'zone', order: 2 },
  { id: 'z-basement', parentId: null, name: 'Basement', kind: 'zone', order: 3, draft: true },
  { id: 'r-cellar', parentId: 'z-basement', name: 'Wine Cellar', kind: 'room', order: 0, draft: true },
];

// ── Decisions (placed on the spine; DL-015 is the seeded private draft) ──

export interface SeedDecisionOption {
  label: string;
  optionKey: string;
  material: string;
  delta: number;
  swatch: string;
  recommended: boolean;
  order: number;
}

export interface SeedDecision {
  id: string;
  title: string;
  room: string;
  nodeId: string | null;
  status: 'pending' | 'approved' | 'change';
  /** a private draft — seeded with publishedAt null + the PMC as author */
  draft?: boolean;
  ageDays?: number;
  photoSwatch: string;
  approvedOption?: string;
  material?: string;
  approver?: string;
  date?: string;
  cost?: number;
  options: SeedDecisionOption[];
}

export const SEED_DECISIONS: SeedDecision[] = [
  {
    id: 'DL-015', title: 'Living Room Feature Wall', room: 'Ground Floor · Living', nodeId: 'r-living', status: 'pending', draft: true, ageDays: 0, photoSwatch: 'walnut',
    options: [
      { label: 'Option A', optionKey: 'A', material: 'Fluted Walnut', delta: 0, swatch: 'walnut', recommended: true, order: 0 },
      { label: 'Option B', optionKey: 'B', material: 'Textured Stone', delta: 48000, swatch: 'marble', recommended: false, order: 1 },
    ],
  },
  {
    id: 'DL-014', title: 'Living Room Flooring', room: 'Ground Floor · Living', nodeId: 'r-living', status: 'pending', ageDays: 3, photoSwatch: 'marble',
    options: [
      { label: 'Option A', optionKey: 'A', material: 'Large-format Vitrified', delta: 0, swatch: 'vitrified', recommended: false, order: 0 },
      { label: 'Option B', optionKey: 'B', material: 'Italian Marble (Botticino)', delta: 140000, swatch: 'marble', recommended: true, order: 1 },
    ],
  },
  {
    id: 'DL-011', title: 'Main Door Veneer', room: 'Ground Floor · Entrance', nodeId: 'e-maindoor', status: 'pending', ageDays: 6, photoSwatch: 'walnut',
    options: [
      { label: 'Option A', optionKey: 'A', material: 'Teak Veneer', delta: 0, swatch: 'teak', recommended: false, order: 0 },
      { label: 'Option B', optionKey: 'B', material: 'Walnut Veneer (Matt)', delta: 32000, swatch: 'walnut', recommended: true, order: 1 },
    ],
  },
  {
    id: 'DL-009', title: 'Master Bath CP Fittings', room: 'Second Floor · Master Bath', nodeId: 'r-mbath', status: 'approved', photoSwatch: 'chrome',
    approvedOption: 'Option B', material: 'Kohler', approver: 'Mr. Shah', date: '12 Jun 2026', cost: 86000,
    options: [
      { label: 'Option A', optionKey: 'A', material: 'Jaquar', delta: 0, swatch: 'chrome', recommended: false, order: 0 },
      { label: 'Option B', optionKey: 'B', material: 'Kohler', delta: 86000, swatch: 'chrome', recommended: true, order: 1 },
    ],
  },
  {
    id: 'DL-006', title: 'Staircase Railing', room: 'Staircase · G to 2', nodeId: null, status: 'approved', photoSwatch: 'glass',
    approvedOption: 'Option B', material: 'Glass + Wood', approver: 'Mrs. Shah', date: '04 Jun 2026', cost: 210000,
    options: [
      { label: 'Option A', optionKey: 'A', material: 'MS Powder-coated', delta: 0, swatch: 'chrome', recommended: false, order: 0 },
      { label: 'Option B', optionKey: 'B', material: 'Glass + Wood', delta: 210000, swatch: 'glass', recommended: true, order: 1 },
    ],
  },
  {
    id: 'DL-003', title: 'Kitchen Counter Top', room: 'Ground Floor · Kitchen', nodeId: 'r-kitchen', status: 'change', photoSwatch: 'quartz',
    approvedOption: 'Option A', material: 'Quartz (Statuario)', approver: 'Mr. Shah', date: '28 May 2026', cost: 118000,
    options: [],
  },
];

// ── Phases + activities (placed on the spine) ──

export const SEED_PHASES = [
  { id: 'PH-services', name: 'Services & Waterproofing', order: 0, plannedStart: 9, plannedEnd: 30 },
  { id: 'PH-wetareas', name: 'Wet Areas & Fittings', order: 1, plannedStart: 19, plannedEnd: 27 },
  { id: 'PH-finishing', name: 'Finishing', order: 2, plannedStart: 34, plannedEnd: 47 },
];

export const SEED_ACTIVITIES = [
  { id: 'ACT-22', name: 'Electrical Rough-In', zone: 'Second Floor', nodeId: null as string | null, decisionId: null as string | null, phaseId: 'PH-services', plannedStart: 9, plannedEnd: 19, actualStart: 9 as number | null, actualEnd: 18 as number | null, status: 'done' as const, gateMaterial: 'ok' as const, gateTeam: 'ok' as const, gateInspection: 'ok' as const, block: undefined as string | undefined, order: 0 },
  { id: 'ACT-25', name: 'Master Bath CP Fittings', zone: 'Second Floor · Master Bath', nodeId: 'r-mbath' as string | null, decisionId: 'DL-009' as string | null, phaseId: 'PH-wetareas', plannedStart: 19, plannedEnd: 27, actualStart: 20 as number | null, actualEnd: 26 as number | null, status: 'done' as const, gateMaterial: 'ok' as const, gateTeam: 'ok' as const, gateInspection: 'ok' as const, block: undefined as string | undefined, order: 1 },
  { id: 'ACT-28', name: 'Waterproofing — Terrace', zone: 'Terrace', nodeId: 'z-terrace' as string | null, decisionId: null as string | null, phaseId: 'PH-services', plannedStart: 23, plannedEnd: 30, actualStart: 24 as number | null, actualEnd: null as number | null, status: 'blocked' as const, gateMaterial: 'ok' as const, gateTeam: 'ok' as const, gateInspection: 'fail' as const, block: 'Ponding test failed — drain slope' as string | undefined, order: 2 },
  { id: 'ACT-31', name: 'Living Room Flooring', zone: 'Ground Floor · Living', nodeId: 'r-living' as string | null, decisionId: 'DL-014' as string | null, phaseId: 'PH-finishing', plannedStart: 34, plannedEnd: 41, actualStart: null as number | null, actualEnd: null as number | null, status: 'not_started' as const, gateMaterial: 'wait' as const, gateTeam: 'wait' as const, gateInspection: 'wait' as const, block: undefined as string | undefined, order: 3 },
  { id: 'ACT-35', name: 'Staircase Railing', zone: 'Staircase · G to 2', nodeId: null as string | null, decisionId: 'DL-006' as string | null, phaseId: 'PH-finishing', plannedStart: 37, plannedEnd: 44, actualStart: null as number | null, actualEnd: null as number | null, status: 'not_started' as const, gateMaterial: 'wait' as const, gateTeam: 'na' as const, gateInspection: 'wait' as const, block: undefined as string | undefined, order: 4 },
  { id: 'ACT-33', name: 'Main Door Veneer', zone: 'Ground Floor · Entrance', nodeId: 'e-maindoor' as string | null, decisionId: 'DL-011' as string | null, phaseId: 'PH-finishing', plannedStart: 43, plannedEnd: 47, actualStart: null as number | null, actualEnd: null as number | null, status: 'not_started' as const, gateMaterial: 'wait' as const, gateTeam: 'na' as const, gateInspection: 'na' as const, block: undefined as string | undefined, order: 5 },
];

// ── Inspections (placed; INSP-18 mirrors the demo's decided placed review) ──

export interface SeedInspectionItem { name: string; order: number; result?: 'PASS' | 'FAIL'; swatch?: string; note?: string }
export interface SeedInspection {
  id: string;
  kind: 'checklist' | 'review';
  title: string;
  zone: string;
  nodeId: string | null;
  by?: string;
  date: string;
  submitted: boolean;
  decided: boolean;
  items: SeedInspectionItem[];
}

export const SEED_INSPECTIONS: SeedInspection[] = [
  {
    id: 'INSP-22', kind: 'checklist', title: 'Pre-Tiling Inspection', zone: 'Bathroom 2 · 3rd Floor', nodeId: null, date: '03 Jul 2026', submitted: false, decided: false,
    items: [
      { name: 'Surface level & slope checked', order: 0 },
      { name: 'Waterproofing coat cured (7 days)', order: 1 },
      { name: 'Tile layout dry-run marked', order: 2 },
      { name: 'Skirting height reference marked', order: 3 },
      { name: 'Plumbing points & levels verified', order: 4 },
    ],
  },
  {
    id: 'INSP-21', kind: 'review', title: 'Waterproofing Ponding Test', zone: 'Terrace', nodeId: 'z-terrace', by: 'Site Engineer (Ramesh)', date: '02 Jul 2026', submitted: true, decided: false,
    items: [
      { name: 'Ponding water level maintained 48h', result: 'PASS', swatch: 'water', note: 'Level held for 48 hours, no visible drop.', order: 0 },
      { name: 'No seepage at slab soffit below', result: 'PASS', swatch: 'concrete', note: 'Soffit inspected, dry.', order: 1 },
      { name: 'Drain outlets & slope to gully', result: 'FAIL', swatch: 'water', note: 'Water pooling at NE corner — slope insufficient.', order: 2 },
      { name: 'Parapet-junction coving intact', result: 'PASS', swatch: 'concrete', note: 'Coving continuous, no cracks.', order: 3 },
    ],
  },
  {
    id: 'INSP-18', kind: 'review', title: 'CP Fittings & Pressure Test', zone: 'Second Floor · Master Bath', nodeId: 'r-mbath', by: 'Site Engineer (Ramesh)', date: '26 Jun 2026', submitted: true, decided: true,
    items: [
      { name: 'Pressure test held at 7 bar for 30 min', result: 'PASS', swatch: 'chrome', note: 'No drop on the gauge.', order: 0 },
      { name: 'Fittings match approved Kohler set', result: 'PASS', swatch: 'chrome', note: 'Verified against DL-009.', order: 1 },
    ],
  },
];

// ── Daily-log materials (placed) — mirrors shared SEED_MATERIALS ──

export const SEED_LOG_MATERIALS = [
  { name: 'Italian Marble (Botticino)', decisionId: 'DL-014', qty: '42 boxes', zone: 'Zone B · covered, on pallets', matched: true, swatch: 'marble', photo: true, nodeId: 'r-living' as string | null, order: 0 },
  { name: 'CP Fittings — Kohler', decisionId: 'DL-009', qty: 'Set of 6', zone: 'Store room · locked', matched: true, swatch: 'chrome', photo: true, nodeId: 'r-mbath' as string | null, order: 1 },
];

// ── The Vitan starter library (Templates Slice 4) ─────────────────────────────
// A ready menu for a residence practice: space/zone modules, a QA set, and a
// schedule shape, wrapped in one "G+2 Residence" preset. All payloads satisfy
// contracts.modulePayloadSchema (guarded by seed-data.test.ts).

export interface StarterModule {
  name: string;
  category: 'space' | 'zone' | 'element' | 'discipline' | 'schedule';
  anchorKind: 'zone' | 'room' | 'element' | null;
  description: string;
  payload: ModulePayload;
}

const p = (payload: Partial<ModulePayload>): ModulePayload => ({ nodes: [], phases: [], activities: [], inspections: [], ...payload });

export const STARTER_MODULES: StarterModule[] = [
  {
    name: 'Ground Floor (residence)',
    category: 'zone',
    anchorKind: null,
    description: 'A residential ground floor: living, entrance with main door, kitchen.',
    payload: p({
      nodes: [
        { key: 'gf', parentKey: null, name: 'Ground Floor', kind: 'zone', order: 0 },
        { key: 'living', parentKey: 'gf', name: 'Living Room', kind: 'room', order: 0 },
        { key: 'entrance', parentKey: 'gf', name: 'Entrance', kind: 'room', order: 1 },
        { key: 'maindoor', parentKey: 'entrance', name: 'Main Door', kind: 'element', order: 0 },
        { key: 'kitchen', parentKey: 'gf', name: 'Kitchen', kind: 'room', order: 2 },
      ],
    }),
  },
  {
    name: 'Upper Floor (residence)',
    category: 'zone',
    anchorKind: null,
    description: 'An upper floor: two bedrooms and a master bath.',
    payload: p({
      nodes: [
        { key: 'uf', parentKey: null, name: 'Upper Floor', kind: 'zone', order: 0 },
        { key: 'bed1', parentKey: 'uf', name: 'Bedroom 1', kind: 'room', order: 0 },
        { key: 'bed2', parentKey: 'uf', name: 'Bedroom 2', kind: 'room', order: 1 },
        { key: 'mbath', parentKey: 'uf', name: 'Master Bath', kind: 'room', order: 2 },
      ],
      inspections: [
        { title: 'Pre-Tiling Inspection — Master Bath', zone: 'Master Bath', nodeKey: 'mbath', items: ['Surface level & slope checked', 'Waterproofing coat cured (7 days)', 'Tile layout dry-run marked', 'Plumbing points & levels verified'] },
      ],
    }),
  },
  {
    name: 'Terrace (residence)',
    category: 'zone',
    anchorKind: null,
    description: 'A terrace with its waterproofing sign-off ready to run.',
    payload: p({
      nodes: [{ key: 'terrace', parentKey: null, name: 'Terrace', kind: 'zone', order: 0 }],
      inspections: [
        { title: 'Waterproofing Ponding Test', zone: 'Terrace', nodeKey: 'terrace', items: ['Ponding water level maintained 48h', 'No seepage at slab soffit below', 'Drain outlets & slope to gully', 'Parapet-junction coving intact'] },
      ],
    }),
  },
  {
    name: 'Kitchen',
    category: 'space',
    anchorKind: 'zone',
    description: 'A kitchen with its counter and sink, plus the pre-tiling check.',
    payload: p({
      nodes: [
        { key: 'k', parentKey: null, name: 'Kitchen', kind: 'room', order: 0 },
        { key: 'counter', parentKey: 'k', name: 'Counter', kind: 'element', order: 0 },
        { key: 'sink', parentKey: 'k', name: 'Sink', kind: 'element', order: 1 },
      ],
      inspections: [{ title: 'Kitchen Pre-Tiling Inspection', zone: 'Kitchen', nodeKey: 'k', items: ['Surface level & slope checked', 'Counter support levels verified', 'Plumbing points & levels verified'] }],
    }),
  },
  {
    name: 'Bedroom',
    category: 'space',
    anchorKind: 'zone',
    description: 'A bedroom shell — pick ×N and the copies suffix themselves.',
    payload: p({
      nodes: [
        { key: 'bed', parentKey: null, name: 'Bedroom', kind: 'room', order: 0 },
        { key: 'wardrobe', parentKey: 'bed', name: 'Wardrobe', kind: 'element', order: 0 },
      ],
    }),
  },
  {
    name: 'Standard Residential Phases',
    category: 'schedule',
    anchorKind: null,
    description: 'The four-phase residential schedule shape (planned day-offsets).',
    payload: p({
      phases: [
        { name: 'Structure', order: 0, plannedStart: 0, plannedEnd: 20 },
        { name: 'Services & Waterproofing', order: 1, plannedStart: 9, plannedEnd: 30 },
        { name: 'Wet Areas & Fittings', order: 2, plannedStart: 19, plannedEnd: 27 },
        { name: 'Finishing', order: 3, plannedStart: 34, plannedEnd: 47 },
      ],
      activities: [
        { name: 'Electrical Rough-In', zone: '', plannedStart: 9, plannedEnd: 19, phaseName: 'Services & Waterproofing', order: 0 },
        { name: 'Waterproofing — Terrace', zone: 'Terrace', plannedStart: 23, plannedEnd: 30, phaseName: 'Services & Waterproofing', order: 1 },
        { name: 'Flooring', zone: '', plannedStart: 34, plannedEnd: 41, phaseName: 'Finishing', order: 2 },
      ],
    }),
  },
  {
    name: 'Standard QA (residence)',
    category: 'discipline',
    anchorKind: null,
    description: 'The stage-wise quality checks every residence runs.',
    payload: p({
      inspections: [
        { title: 'Electrical Rough-In Check', zone: '', items: ['Conduit routing per drawing', 'Box heights verified', 'Earthing continuity checked'] },
        { title: 'Plumbing Pressure Test', zone: '', items: ['Lines held at 7 bar for 30 min', 'No visible seepage at joints'] },
        { title: 'Pre-Handover Snag Walk', zone: '', items: ['Doors/windows operate freely', 'Paint finish uniform', 'Fittings match approved decisions'] },
      ],
    }),
  },
];

export const STARTER_TEMPLATE = {
  name: 'G+2 Residence',
  description: 'Vitan starter: ground + upper floors, terrace, standard phases and QA.',
  /** items reference modules by NAME — the creator resolves them to ids at insert time */
  items: [
    { moduleName: 'Ground Floor (residence)', count: 1 },
    { moduleName: 'Upper Floor (residence)', count: 1 },
    { moduleName: 'Terrace (residence)', count: 1 },
    { moduleName: 'Standard Residential Phases', count: 1 },
    { moduleName: 'Standard QA (residence)', count: 1 },
  ],
};

/**
 * Create the starter library for an org — modules + the "G+2 Residence" preset.
 * STRICTLY create-only and all-or-nothing: runs only when the org has NO modules at all
 * (never fights a curated library), and commits in one transaction. Used by both the
 * demo seed (fresh DB) and ensure-accounts (live-safe boot provisioning).
 */
export async function createStarterLibrary(prisma: PrismaClient, orgId: string): Promise<boolean> {
  const existing = await prisma.templateModule.count({ where: { orgId } });
  if (existing > 0) return false;
  await prisma.$transaction(async (tx) => {
    const idByName = new Map<string, string>();
    for (const m of STARTER_MODULES) {
      const created = await tx.templateModule.create({
        data: { orgId, name: m.name, category: m.category, anchorKind: m.anchorKind, description: m.description, payload: m.payload },
      });
      idByName.set(m.name, created.id);
    }
    await tx.projectTemplate.create({
      data: {
        orgId,
        name: STARTER_TEMPLATE.name,
        description: STARTER_TEMPLATE.description,
        items: STARTER_TEMPLATE.items.map((i) => ({ moduleId: idByName.get(i.moduleName)!, count: i.count })),
      },
    });
  });
  return true;
}
