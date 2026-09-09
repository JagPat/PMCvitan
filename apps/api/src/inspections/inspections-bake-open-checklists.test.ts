import { describe, expect, it } from 'vitest';
import { bakeInspections, compareInspectionIds, type InspectionBaseEntry, type InspectionsBase } from './inspections-serialize';

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
  assigneeId: null,
  items: [{ id: `${over.id}-i1`, name: 'Verify', order: 0, state: null, photos: 0, note: '', result: null, swatch: null, rejected: false, mediaIds: [] }],
  ...over,
});

/** `bindingAssignees` defaults to EVERY named assignee — the ordinary case, where each one still
 *  holds an active corrective membership. The round-7 probes below pass a narrower set to say that a
 *  particular assignee no longer does. */
const bake = (
  inspections: InspectionBaseEntry[],
  role: string,
  viewerId?: string,
  bindingAssignees?: ReadonlySet<string>,
) =>
  bakeInspections({ inspections } as InspectionsBase, {
    role,
    evidencePath: (id) => `/evidence/${id}`,
    viewerId,
    bindingAssignees: bindingAssignees
      ?? new Set(inspections.map((i) => i.assigneeId).filter((id): id is string => typeof id === 'string')),
  });

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

/**
 * The two id producers disagree about padding: `nextSeqId('INSP-', …)` mints `INSP-023` while the
 * seeded rows carry `INSP-18`/`INSP-21`/`INSP-22`, and both shapes live in one project. Ordering
 * those by their characters puts the newest checklist first — `'INSP-023' < 'INSP-22'` because
 * `'0' < '2'` — so the field view's default would be the newest issued checklist, and the
 * outstanding list would read oldest-first over one range and newest-first over the other.
 */
describe('inspection ids order by issue sequence, not by padding', () => {
  it('orders a padded id after the unpadded one it actually follows', () => {
    expect(compareInspectionIds('INSP-023', 'INSP-22')).toBeGreaterThan(0);
    expect(compareInspectionIds('INSP-22', 'INSP-023')).toBeLessThan(0);
    expect(compareInspectionIds('INSP-9', 'INSP-10')).toBeLessThan(0);
  });

  it('stays a total order for ids it cannot read as a sequence', () => {
    expect(compareInspectionIds('INSP-7', 'INSP-7')).toBe(0);
    // different prefixes, and a suffix that is not a number: the string order still decides
    expect(compareInspectionIds('DL-2', 'INSP-1')).toBeLessThan(0);
    expect(compareInspectionIds('INSP-x', 'INSP-1')).toBeGreaterThan(0);
  });

  it('opens the OLDEST checklist across both id shapes, and lists them in issue order', () => {
    const slices = bake([entry({ id: 'INSP-023' }), entry({ id: 'INSP-22' }), entry({ id: 'INSP-9' })], 'engineer');
    expect(slices.openChecklists.map((c) => c.id)).toEqual(['INSP-9', 'INSP-22', 'INSP-023']);
    expect(slices.checklist?.id).toBe('INSP-9');
  });

  it('orders the review queue by the same rule', () => {
    const submitted = (id: string) => entry({ id, kind: 'review', submitted: true, by: 'Eng' });
    const slices = bake([submitted('INSP-023'), submitted('INSP-22')], 'pmc');
    expect(slices.reviews.map((r) => r.id)).toEqual(['INSP-22', 'INSP-023']);
  });
});

/**
 * A rejected inspection creates a re-inspection ASSIGNED to whoever submitted the original — named
 * corrective work, not the site's. The field view is deliberately ungated by ROLE, but that is not a
 * reason to hand engineer B engineer A's remedial work: B could fill it, submit it, and be recorded
 * as the person who did it. Carrying every open checklist to every engineer is what made that
 * reachable, so the boundary that carries them is where the assignment has to be honoured.
 */
describe('assigned corrective work stays with its assignee', () => {
  const assigned = (id: string, assigneeId: string | null) => entry({ id, assigneeId, reinspectionOfId: 'INSP-0' });

  it('offers an engineer their own assigned re-inspection and the unassigned work, not a colleague’s', () => {
    const rows = [assigned('INSP-1', 'eng-a'), assigned('INSP-2', 'eng-b'), entry({ id: 'INSP-3' })];
    const a = bake(rows, 'engineer', 'eng-a');
    expect(a.openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-3']);
    const b = bake(rows, 'engineer', 'eng-b');
    expect(b.openChecklists.map((c) => c.id)).toEqual(['INSP-2', 'INSP-3']);
  });

  it('does not open a colleague’s assigned work as the field view’s default either', () => {
    // the singular slice is chosen from the same filtered set — otherwise the list hides it and the
    // screen still opens it
    const slices = bake([assigned('INSP-1', 'eng-b'), entry({ id: 'INSP-2' })], 'engineer', 'eng-a');
    expect(slices.checklist?.id).toBe('INSP-2');
  });

  /**
   * ROUND 8, FINDING 2 — the assignment rule must not reach backwards over a finished record.
   *
   * Engineer B legitimately submits a checklist stranded by assignee A; A is later reactivated, so
   * A's assignment binds again — and the read then hid from B the record of work B actually did,
   * down to `checklist: null` when it was the project's only one. `mine` answers "may I DO this?",
   * which is a question about OPEN work.
   */
  it('keeps a SUBMITTED record readable after its assignee becomes binding again', () => {
    const submittedByReplacement = entry({ id: 'INSP-1', assigneeId: 'eng-a', submitted: true, kind: 'checklist', by: 'B' });
    const slices = bake([submittedByReplacement], 'engineer', 'eng-b', new Set(['eng-a']));
    expect(slices.checklist?.id).toBe('INSP-1');
    // it is a record, not outstanding work
    expect(slices.openChecklists).toEqual([]);
  });

  it('still does not open a colleague’s OPEN assigned checklist as the fallback', () => {
    // the round-3 guard this must not re-break: with nothing of the viewer's own open, an open
    // checklist that binds to somebody else is still not theirs to be shown
    const slices = bake([assigned('INSP-1', 'eng-b')], 'engineer', 'eng-a', new Set(['eng-b']));
    expect(slices.openChecklists).toEqual([]);
    expect(slices.checklist).toBeNull();
  });

  it('shows the PMC everything, because they issued it and must see what is outstanding', () => {
    const rows = [assigned('INSP-1', 'eng-a'), assigned('INSP-2', 'eng-b'), entry({ id: 'INSP-3' })];
    expect(bake(rows, 'pmc').openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-2', 'INSP-3']);
  });

  /**
   * ROUND 7, FINDING 1 — the read must answer the assignment question with the SAME rule `submit` does.
   *
   * Round 6 made the assignment stop binding once its assignee can no longer do the work (removed,
   * re-roled, or a PMC who named themselves and holds no checklist screen), so `submit` accepts a
   * replacement engineer. This boundary went on filtering by the stored id, so the very callers the
   * new rule made eligible could neither see the checklist nor open it: the work was submittable in
   * principle by people who could not reach it in practice. These probes are RED against a `mine`
   * that reads `assigneeId` alone.
   */
  it('returns a STRANDED assignee’s checklist to every eligible engineer', () => {
    const rows = [assigned('INSP-1', 'eng-gone'), entry({ id: 'INSP-2' })];
    // `eng-gone` was removed from the project (or re-roled): their assignment binds nobody now.
    const slices = bake(rows, 'engineer', 'eng-a', new Set());
    expect(slices.openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-2']);
    // and it is openable, not merely listed — the singular slice comes from the same filtered set
    expect(slices.checklist?.id).toBe('INSP-1');
  });

  it('still keeps a BINDING assignee’s checklist off a colleague’s view', () => {
    // the negative half: an assignee who IS still eligible is unchanged by finding 1's fix
    const rows = [assigned('INSP-1', 'eng-b'), entry({ id: 'INSP-2' })];
    const slices = bake(rows, 'engineer', 'eng-a', new Set(['eng-b']));
    expect(slices.openChecklists.map((c) => c.id)).toEqual(['INSP-2']);
  });

  it('returns a PMC self-assigned re-inspection to the engineers, matching submit', () => {
    // `pmcSelfExplicit`: `decide` admits a PMC naming themselves, and `submit` then treats that
    // assignment as non-binding because a PMC has no checklist screen. The read has to agree.
    const rows = [assigned('INSP-1', 'pmc-1')];
    expect(bake(rows, 'engineer', 'eng-a', new Set()).openChecklists.map((c) => c.id)).toEqual(['INSP-1']);
  });

  it('leaves UNASSIGNED checklists everybody’s — the common case, unchanged', () => {
    const rows = [entry({ id: 'INSP-1' }), entry({ id: 'INSP-2' })];
    expect(bake(rows, 'engineer', 'eng-a').openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-2']);
    expect(bake(rows, 'engineer', 'eng-z').openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-2']);
  });
});
