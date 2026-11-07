import { describe, expect, it } from 'vitest';
import { bakeInspections, type InspectionBaseEntry, type InspectionsBase } from './inspections-serialize';
import { lineageRoots } from './inspection-lineage';

/**
 * #482 "Who fixes this?" (#1365 H5, 4490108387) — one name per inspection lineage, held on its ROOT. Every served
 * checklist and review row says the root of its lineage (`lineageRootId`), so each picker (the open re-inspection,
 * its review) reaches the one name in effect at any depth. Derived at bake from `reinspectionOfId`; nothing stored.
 */

const entry = (over: Partial<InspectionBaseEntry> & { id: string }): InspectionBaseEntry => ({
  kind: 'checklist', title: `Checklist ${over.id}`, zone: 'GF', nodeId: null, by: null, date: 'today',
  submitted: false, decided: false, closing: false, activityId: null, activityName: null, reinspectionOfId: null,
  assigneeId: null, dueDate: null, workType: null,
  items: [{ id: `${over.id}-i1`, name: 'Verify', guide: null, order: 0, state: null, photos: 0, note: '', result: null, swatch: null, rejected: false, mediaIds: [] }],
  ...over,
});
const bake = (inspections: InspectionBaseEntry[], role = 'pmc') =>
  bakeInspections({ inspections } as InspectionsBase, {
    role, evidencePath: (id) => `/evidence/${id}`, viewerId: 'u-pmc', bindingAssignees: new Set(), hiddenEvidence: new Set(),
    evidenceKinds: new Map(), evidenceOwnKeys: new Map(),
  });

describe('lineageRoots', () => {
  it('an inspection that re-checks nothing is its own root; every re-inspection names the first of its lineage', () => {
    const rootOf = lineageRoots([
      { id: 'A', reinspectionOfId: null }, { id: 'B', reinspectionOfId: 'A' }, { id: 'C', reinspectionOfId: 'B' }, { id: 'D', reinspectionOfId: 'C' },
    ]);
    expect(['A', 'B', 'C', 'D'].map(rootOf)).toEqual(['A', 'A', 'A', 'A']);
  });

  it('a parent with no row stops at that parent id; a malformed cycle stops where it would repeat', () => {
    expect(lineageRoots([{ id: 'B', reinspectionOfId: 'A' }])('B')).toBe('A');
    const cyc = lineageRoots([{ id: 'X', reinspectionOfId: 'Y' }, { id: 'Y', reinspectionOfId: 'X' }]);
    expect(cyc('X')).toBe('Y');
    expect(cyc('Y')).toBe('X');
    expect(lineageRoots([{ id: 'S', reinspectionOfId: 'S' }])('S')).toBe('S');
  });
});

describe('bakeInspections — every served checklist and review row carries its lineage root', () => {
  // A (decided, rejected) → B (decided, rejected) → C (the tip)
  const a = entry({ id: 'INSP-1', submitted: true, decided: true });
  const b = entry({ id: 'INSP-2', reinspectionOfId: 'INSP-1', submitted: true, decided: true });

  it('an open re-inspection at depth 3 names the root on openChecklists and the field checklist', () => {
    const slices = bake([a, b, entry({ id: 'INSP-3', reinspectionOfId: 'INSP-2' }), entry({ id: 'INSP-4' })]);
    const byId = Object.fromEntries(slices.openChecklists.map((c) => [c.id, c]));
    expect(byId['INSP-3']).toMatchObject({ reinspectionOfId: 'INSP-2', lineageRootId: 'INSP-1' });
    expect(byId['INSP-4']).toMatchObject({ reinspectionOfId: null, lineageRootId: 'INSP-4' });
    expect(slices.checklist).toHaveProperty('lineageRootId');
  });

  it('a submitted re-inspection at depth 3 names the root on reviews and review', () => {
    const slices = bake([a, b, entry({ id: 'INSP-3', reinspectionOfId: 'INSP-2', submitted: true })]);
    expect(slices.reviews.map((r) => [r.id, r.lineageRootId])).toEqual([['INSP-3', 'INSP-1']]);
    expect(slices.review).toMatchObject({ id: 'INSP-3', lineageRootId: 'INSP-1' });
  });

  it('a first inspection in review names itself', () => {
    const slices = bake([entry({ id: 'INSP-5', submitted: true })]);
    expect(slices.reviews[0]).toMatchObject({ id: 'INSP-5', lineageRootId: 'INSP-5' });
  });
});
