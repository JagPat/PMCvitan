import { describe, expect, it } from 'vitest';
import { bakeInspections, type InspectionBaseEntry, type InspectionsBase } from './inspections-serialize';

/**
 * #633 — the Site Map's "open issue" count. One rule for every surface: an open issue is an item on a
 * re-inspection that is not yet decided (still with the engineer, or in review). It is the same rule as
 * the Dashboard's "failed items awaiting re-inspection", so a place and the Dashboard never disagree.
 */

const item = (id: string, over: Partial<InspectionBaseEntry['items'][number]> = {}) => ({
  id, name: 'Verify', order: 0, state: null, photos: 0, note: '', result: null, swatch: null, rejected: false, mediaIds: [], ...over,
});
const entry = (over: Partial<InspectionBaseEntry> & { id: string }): InspectionBaseEntry => ({
  kind: 'checklist', title: over.id, zone: 'Kitchen', nodeId: 'n-kitchen', by: null, date: 'today',
  submitted: false, decided: false, closing: false, activityId: null, activityName: null,
  reinspectionOfId: null, assigneeId: null, dueDate: null, items: [item(`${over.id}-i1`)], ...over,
});
const placed = (inspections: InspectionBaseEntry[], role = 'pmc') =>
  bakeInspections({ inspections } as InspectionsBase, { role, evidencePath: (id) => id, bindingAssignees: new Set() }).placedInspections;
const issues = (inspections: InspectionBaseEntry[], role = 'pmc') =>
  Object.fromEntries(placed(inspections, role).map((p) => [p.id, p.openIssues]));

describe('placed inspections — open issues', () => {
  it('counts the items on a re-inspection still with the engineer', () => {
    expect(issues([entry({ id: 'INSP-2', reinspectionOfId: 'INSP-1', items: [item('a'), item('b')] })])).toEqual({ 'INSP-2': 2 });
  });

  it('counts the items on a re-inspection awaiting review', () => {
    expect(issues([entry({ id: 'INSP-2', reinspectionOfId: 'INSP-1', submitted: true })])).toEqual({ 'INSP-2': 1 });
  });

  it('a decided re-inspection has none left open here', () => {
    expect(issues([entry({ id: 'INSP-2', reinspectionOfId: 'INSP-1', submitted: true, decided: true })])).toEqual({ 'INSP-2': 0 });
  });

  it('a failed item on the original inspection is not counted again: its re-inspection carries it', () => {
    const failed = entry({ id: 'INSP-1', submitted: true, decided: true, items: [item('a', { result: 'FAIL', rejected: true })] });
    const re = entry({ id: 'INSP-2', reinspectionOfId: 'INSP-1', items: [item('b')] });
    expect(issues([failed, re])).toEqual({ 'INSP-1': 0, 'INSP-2': 1 });
  });

  it('an ordinary open checklist is work, not an issue', () => {
    expect(issues([entry({ id: 'INSP-1' })])).toEqual({ 'INSP-1': 0 });
  });

  it('keeps AUTH-02: no placed inspections for a client', () => {
    expect(placed([entry({ id: 'INSP-2', reinspectionOfId: 'INSP-1' })], 'client')).toEqual([]);
  });
});
