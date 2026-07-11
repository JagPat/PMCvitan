import { describe, it, expect } from 'vitest';
import type { Decision, Drawing, Photo, ProjectNode } from '@vitan/shared';
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

  it('groups by object (element) — the deepest segment', () => {
    const g = groupDecisions(decisions, nodes, 'element');
    expect(g.map((x) => x.label).sort()).toEqual(['Guest Bath', 'Main Door', 'Master Bedroom', 'Terrace']);
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

  it('a room shows its subtree decisions/photos, inherits ancestor drawings, and surfaces child details', () => {
    const c = placeContents('r1', nodes, decisions, drawings, photos);
    expect(c.counts).toEqual({ decisions: 2, drawings: 2, photos: 1 });
    // A-100 (filed on the zone above) is inherited; A-201 (on the door below) is a detail
    const byNum = Object.fromEntries(c.drawings.map((d) => [d.drawing.number, d.relation]));
    expect(byNum).toEqual({ 'A-100': 'inherited', 'A-201': 'detail' });
    // details sort before inherited
    expect(c.drawings.map((d) => d.drawing.number)).toEqual(['A-201', 'A-100']);
  });

  it('an object shows a drawing filed on it as "here" and the ancestor plan as inherited', () => {
    const c = placeContents('e1', nodes, decisions, drawings, photos);
    const byNum = Object.fromEntries(c.drawings.map((d) => [d.drawing.number, d.relation]));
    expect(byNum).toEqual({ 'A-201': 'here', 'A-100': 'inherited' });
    expect(c.counts).toEqual({ decisions: 1, drawings: 2, photos: 1 });
  });

  it('whole project (null) returns everything, unfiled items included', () => {
    const c = placeContents(null, nodes, decisions, drawings, photos);
    expect(c.counts).toEqual({ decisions: 2, drawings: 3, photos: 3 });
    expect(c.drawings.every((d) => d.relation === 'here')).toBe(true);
  });
});
