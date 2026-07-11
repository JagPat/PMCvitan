import { describe, it, expect } from 'vitest';
import type { Decision, ProjectNode } from '@vitan/shared';
import { pathOf, locationSegments, groupDecisions } from '@/lib/locationTree';

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
