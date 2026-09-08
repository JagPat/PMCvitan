import { describe, expect, it } from 'vitest';
import { bakeInspections, type InspectionBaseEntry, type InspectionsBase } from './inspections-serialize';

/**
 * A PMC issues field checklists to the site. Each one is work someone is expected to do.
 *
 * `bakeInspections` used to answer "which checklist is open?" with `Array.find` over an
 * UNORDERED `findMany` — so a site with two open checklists surfaced exactly one of them,
 * and which one was whatever the query planner returned. The other was issued work that no
 * surface showed: the engineer could not open it, and the PMC who issued it could not see it
 * either (`checklist` is the field view, and `reviews` only carries SUBMITTED inspections).
 *
 * These probes fix both halves: every open checklist is carried, and the field view's single
 * choice is deterministic rather than planner-dependent.
 */

const entry = (over: Partial<InspectionBaseEntry> & { id: string }): InspectionBaseEntry => ({
  kind: 'checklist',
  title: `Checklist ${over.id}`,
  zone: 'Ground floor',
  nodeId: null,
  by: null,
  date: 'today',
  submitted: false,
  decided: false,
  closing: false,
  activityId: null,
  activityName: null,
  reinspectionOfId: null,
  items: [{ id: `${over.id}-i1`, name: 'Verify', order: 0, state: null, photos: 0, note: '', result: null, swatch: null, rejected: false, mediaIds: [] }],
  ...over,
});

const bake = (inspections: InspectionBaseEntry[], role: string) =>
  bakeInspections({ inspections } as InspectionsBase, { role, evidencePath: (id) => `/evidence/${id}` });

describe('bakeInspections — issued checklists are visible', () => {
  it('carries EVERY open checklist, not just one', () => {
    const slices = bake([entry({ id: 'INSP-2' }), entry({ id: 'INSP-1' })], 'engineer');
    expect(slices.openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-2']);
  });

  it('shows the PMC who issued them the outstanding checklists', () => {
    const slices = bake([entry({ id: 'INSP-1' }), entry({ id: 'INSP-2' })], 'pmc');
    // Before: the PMC saw none of them — `checklist` is the field view and `reviews`
    // requires `submitted`, so issued work was invisible to its own author.
    expect(slices.openChecklists).toHaveLength(2);
    expect(slices.reviews).toHaveLength(0);
  });

  it('excludes submitted and non-checklist rows from the open list', () => {
    const slices = bake(
      [
        entry({ id: 'INSP-1' }),
        entry({ id: 'INSP-2', submitted: true }),
        entry({ id: 'INSP-3', kind: 'review', submitted: true }),
      ],
      'engineer',
    );
    expect(slices.openChecklists.map((c) => c.id)).toEqual(['INSP-1']);
  });

  it('picks the field view deterministically, whatever order the rows arrive in', () => {
    const forward = bake([entry({ id: 'INSP-1' }), entry({ id: 'INSP-2' })], 'engineer');
    const reversed = bake([entry({ id: 'INSP-2' }), entry({ id: 'INSP-1' })], 'engineer');
    expect(forward.checklist?.id).toBe(reversed.checklist?.id);
    expect(forward.checklist?.id).toBe('INSP-1');
  });

  it('still falls back to a submitted checklist when none is open', () => {
    const slices = bake([entry({ id: 'INSP-4', submitted: true })], 'engineer');
    expect(slices.openChecklists).toEqual([]);
    expect(slices.checklist?.id).toBe('INSP-4');
  });

  it('shows the whole field view to whoever the field view is for', () => {
    // `checklist` is deliberately NOT role-gated — it is the on-site view. The open list
    // carries exactly that visibility, so no role sees a truncated version of it.
    const slices = bake([entry({ id: 'INSP-1' }), entry({ id: 'INSP-2' })], 'contractor');
    expect(slices.checklist).not.toBeNull();
    expect(slices.openChecklists).toHaveLength(2);
  });
});
