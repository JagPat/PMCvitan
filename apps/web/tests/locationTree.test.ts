import { describe, it, expect } from 'vitest';
import type { Activity, Decision, Drawing, Material, Photo, PlacedInspection, ProjectNode } from '@vitan/shared';
import { pathOf, locationSegments, groupDecisions, ancestorIds, subtreeIds, trailOf, placeContents } from '@/lib/locationTree';

const nodes: ProjectNode[] = [
  { id: 'z1', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'r1', parentId: 'z1', name: 'Master Bedroom', kind: 'room', order: 0 },
  { id: 'e1', parentId: 'r1', name: 'Main Door', kind: 'element', order: 0 },
  { id: 'z2', parentId: null, name: 'First Floor', kind: 'zone', order: 1 },
  { id: 'r2', parentId: 'z2', name: 'Guest Bath', kind: 'room', order: 0 },
];

const dec = (id: string, status: Decision['status'], nodeId?: string, room = ''): Decision =>
  ({ id, title: id, room, nodeId, status, photoSwatch: 'tile', options: [] }) as Decision;

describe('pathOf / locationSegments', () => {
  it('builds a root→node breadcrumb', () => {
    expect(pathOf(nodes, 'e1')).toEqual(['Ground Floor', 'Master Bedroom', 'Main Door']);
    expect(pathOf(nodes, 'r2')).toEqual(['First Floor', 'Guest Bath']);
  });
  it('falls back to the free-text room when there is no node', () => {
    expect(locationSegments(dec('DL-1', 'pending', undefined, 'Old Room'), nodes)).toEqual(['Old Room']);
    expect(locationSegments(dec('DL-2', 'pending', 'e1'), nodes)).toEqual(['Ground Floor', 'Master Bedroom', 'Main Door']);
  });
});

describe('groupDecisions', () => {
  const decisions = [
    dec('DL-1', 'pending', 'e1'), // GF › Master Bedroom › Main Door
    dec('DL-2', 'approved', 'r1'), // GF › Master Bedroom
    dec('DL-3', 'pending', 'r2'), // First Floor › Guest Bath
    dec('DL-4', 'change', undefined, 'Terrace'), // ungrouped free-text
  ];

  it('groups by location top segment with per-group rollups', () => {
    const g = groupDecisions(decisions, nodes, 'location');
    const byLabel = Object.fromEntries(g.map((x) => [x.label, x]));
    expect(byLabel['Ground Floor'].counts).toMatchObject({ total: 2, pending: 1, approved: 1 });
    expect(byLabel['First Floor'].counts.total).toBe(1);
    expect(byLabel['Terrace'].counts.change).toBe(1); // free-text fallback becomes its own group
    // the finer location shows as a per-row sub-label
    const door = byLabel['Ground Floor'].rows.find((r) => r.decision.id === 'DL-1');
    expect(door?.subLabel).toBe('Master Bedroom › Main Door');
  });

  it('groups by object (element) — kind-true: only element-filed decisions form object groups', () => {
    const g = groupDecisions(decisions, nodes, 'element');
    // DL-1 is filed on the Main Door element; DL-2/DL-3 are ROOM-filed and DL-4 is free-text —
    // none of those is an object, and presenting a room or a text as one is the positional
    // misfiling P12 removes.
    expect(g.map((x) => x.label).sort()).toEqual(['Main Door', 'No object']);
    const none = g.find((x) => x.label === 'No object')!;
    expect(none.rows.map((r) => r.decision.id).sort()).toEqual(['DL-2', 'DL-3', 'DL-4']);
  });

  it('groups by status with a fixed pending→change→approved order', () => {
    const g = groupDecisions(decisions, nodes, 'status');
    expect(g.map((x) => x.key)).toEqual(['pending', 'change', 'approved']);
  });

  it('flat mode returns a single group of everything', () => {
    const g = groupDecisions(decisions, nodes, 'flat');
    expect(g).toHaveLength(1);
    expect(g[0].counts.total).toBe(4);
  });
});

// ── P12 — kind-true grouping over the NESTED tree, presence AND absence ─────────────────
describe('groupDecisions — kind-true grouping on a nested tree (P12)', () => {
  const nested: ProjectNode[] = [
    { id: 'z1', parentId: null, name: 'Site', kind: 'zone', order: 0 },
    { id: 'w1', parentId: 'z1', name: 'West Wing', kind: 'room', order: 0 },
    { id: 'w2', parentId: 'w1', name: 'Pour 2', kind: 'room', order: 0 },
    { id: 'g1', parentId: 'z1', name: 'Site Gate', kind: 'element', order: 1 },
    { id: 'd1', parentId: 'w2', name: 'Column C4', kind: 'element', order: 0 },
  ];
  const filed = [
    dec('N-1', 'pending', 'w2'), // filed AT the nested room Pour 2
    dec('N-2', 'pending', 'g1'), // a zone-level element
    dec('N-3', 'approved', 'z1'), // filed directly on the zone
    dec('N-4', 'pending', 'w1'), // filed on the outer room
    dec('N-5', 'change', 'd1'), // an element under the nested room
  ];

  it("room mode groups a nested-room decision under the room it was FILED at, never a positional segment", () => {
    const g = groupDecisions(filed, nested, 'room');
    const byLabel = Object.fromEntries(g.map((x) => [x.label, x]));
    // N-1 was filed at Pour 2 (the 3rd segment) — positional seg[1] would misfile it under West Wing
    expect(byLabel['Pour 2']?.rows.map((r) => r.decision.id)).toContain('N-1');
    expect(byLabel['West Wing']?.rows.map((r) => r.decision.id)).toEqual(['N-4']);
    // N-5's room is the nearest room ABOVE the element it was filed on
    expect(byLabel['Pour 2']?.rows.map((r) => r.decision.id)).toContain('N-5');
    expect(byLabel['Pour 2']?.rows.find((r) => r.decision.id === 'N-5')?.subLabel).toBe('Column C4');
  });

  it('room mode absence: a zone-filed decision and a zone-level element never show AS a room', () => {
    const g = groupDecisions(filed, nested, 'room');
    const byLabel = Object.fromEntries(g.map((x) => [x.label, x]));
    // positional logic showed N-3 under a room group named "Site" and N-2 under one named "Site Gate"
    expect(byLabel['Site']).toBeUndefined();
    expect(byLabel['Site Gate']).toBeUndefined();
    expect(byLabel['No room']?.rows.map((r) => r.decision.id).sort()).toEqual(['N-2', 'N-3']);
  });

  it('element mode absence: a room-filed or zone-filed decision never shows as an object', () => {
    const g = groupDecisions(filed, nested, 'element');
    const byLabel = Object.fromEntries(g.map((x) => [x.label, x]));
    expect(byLabel['Site Gate']?.rows.map((r) => r.decision.id)).toEqual(['N-2']);
    expect(byLabel['Column C4']?.rows.map((r) => r.decision.id)).toEqual(['N-5']);
    // positional last-segment logic showed N-1 as object "Pour 2", N-4 as "West Wing", N-3 as "Site"
    expect(byLabel['Pour 2']).toBeUndefined();
    expect(byLabel['West Wing']).toBeUndefined();
    expect(byLabel['Site']).toBeUndefined();
    expect(byLabel['No object']?.rows.map((r) => r.decision.id).sort()).toEqual(['N-1', 'N-3', 'N-4']);
  });
});

describe('location spine helpers', () => {
  it('ancestorIds excludes self; subtreeIds includes self + descendants', () => {
    expect([...ancestorIds(nodes, 'e1')].sort()).toEqual(['r1', 'z1']);
    expect([...subtreeIds(nodes, 'z1')].sort()).toEqual(['e1', 'r1', 'z1']);
    expect([...subtreeIds(nodes, 'e1')]).toEqual(['e1']);
  });

  it('trailOf gives a root→node id/name breadcrumb', () => {
    expect(trailOf(nodes, 'e1')).toEqual([
      { id: 'z1', name: 'Ground Floor' },
      { id: 'r1', name: 'Master Bedroom' },
      { id: 'e1', name: 'Main Door' },
    ]);
  });
});

describe('placeContents — everything at a place', () => {
  const dw = (number: string, nodeId?: string): Drawing =>
    ({ id: number, number, title: number, discipline: 'architectural', zone: null, activityId: null, decisionId: null, nodeId, current: null, ackedByMe: false, revisions: [] }) as Drawing;
  const ph = (id: string, nodeId?: string): Photo => ({ id, url: `/media/${id}`, nodeId, kind: 'progress' });

  const decisions = [dec('DL-1', 'pending', 'e1'), dec('DL-2', 'approved', 'r1')];
  const drawings = [dw('A-100', 'z1'), dw('A-201', 'e1'), dw('S-100')]; // floor plan, door detail, unfiled
  const photos = [ph('p1', 'e1'), ph('p2', 'r2'), ph('p3')];
  const act = (id: string, nodeId?: string): Activity =>
    ({ id, name: id, zone: '', decisionId: null, phaseId: null, nodeId, ps: 0, pe: 1, as: null, ae: null, status: 'not-started', gm: 'na', gt: 'na', gi: 'na' }) as Activity;
  const mat = (id: string, nodeId?: string): Material => ({ id, name: id, qty: '1', zone: '', matched: true, swatch: 'tile', nodeId });
  const activities = [act('ACT-1', 'e1'), act('ACT-2', 'r2')]; // one under the door, one in Guest Bath
  const materials = [mat('M-1', 'r1'), mat('M-2')]; // one in Master Bedroom, one unplaced
  const insp = (id: string, nodeId?: string, failedItems = 0): PlacedInspection =>
    ({ id, title: id, zone: '', nodeId, kind: 'review', submitted: true, decided: true, failedItems });
  const inspections = [insp('INSP-1', 'e1'), insp('INSP-2', 'r2', 1)]; // one under the door, one in Guest Bath

  it('a room shows its subtree decisions/photos/work/materials, inherits ancestor drawings, and surfaces child details', () => {
    const c = placeContents('r1', nodes, decisions, drawings, photos, activities, materials);
    expect(c.counts).toEqual({ decisions: 2, drawings: 2, photos: 1, activities: 1, materials: 1, inspections: 0 });
    // A-100 (filed on the zone above) is inherited; A-201 (on the door below) is a detail
    const byNum = Object.fromEntries(c.drawings.map((d) => [d.drawing.number, d.relation]));
    expect(byNum).toEqual({ 'A-100': 'inherited', 'A-201': 'detail' });
    // details sort before inherited
    expect(c.drawings.map((d) => d.drawing.number)).toEqual(['A-201', 'A-100']);
    // ACT-1 sits under the door (a descendant of the room) → in the room's subtree
    expect(c.activities.map((a) => a.id)).toEqual(['ACT-1']);
    expect(c.materials.map((m) => m.id)).toEqual(['M-1']);
  });

  it('an object shows a drawing filed on it as "here" and the ancestor plan as inherited', () => {
    const c = placeContents('e1', nodes, decisions, drawings, photos, activities, materials);
    const byNum = Object.fromEntries(c.drawings.map((d) => [d.drawing.number, d.relation]));
    expect(byNum).toEqual({ 'A-201': 'here', 'A-100': 'inherited' });
    expect(c.counts).toEqual({ decisions: 1, drawings: 2, photos: 1, activities: 1, materials: 0, inspections: 0 });
  });

  it('whole project (null) returns everything, unfiled items included', () => {
    const c = placeContents(null, nodes, decisions, drawings, photos, activities, materials);
    expect(c.counts).toEqual({ decisions: 2, drawings: 3, photos: 3, activities: 2, materials: 2, inspections: 0 });
    expect(c.drawings.every((d) => d.relation === 'here')).toBe(true);
  });

  it('inspections aggregate by subtree, like the other placed modules', () => {
    // r1 (Master Bedroom) contains the door e1 → its inspection is in the subtree; INSP-2 (r2) is not
    const room = placeContents('r1', nodes, decisions, drawings, photos, activities, materials, inspections);
    expect(room.inspections.map((i) => i.id)).toEqual(['INSP-1']);
    expect(room.counts.inspections).toBe(1);
    // whole project returns every inspection (placed + unplaced would be included)
    const all = placeContents(null, nodes, decisions, drawings, photos, activities, materials, inspections);
    expect(all.counts.inspections).toBe(2);
  });
});
