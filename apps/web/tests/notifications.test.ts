import { describe, it, expect } from 'vitest';
import {
  notificationKind, notificationLink, notificationTarget, decisionsSliceSettled, inspectionsSliceSettled, type NotificationRecords,
} from '@/lib/notifications';

describe('notificationKind — infer the subject from the templated text', () => {
  it('classifies every fixed phrasing the backend/demo produce', () => {
    expect(notificationKind('Decision awaiting approval: Living Room Flooring')).toBe('decision');
    expect(notificationKind('Client approved Master Bath CP Fittings — Kohler')).toBe('decision');
    expect(notificationKind('Drawing issued: A-201 Rev C — Living Room')).toBe('drawing');
    expect(notificationKind('Rajesh is building to A-201 Rev C')).toBe('drawing');
    expect(notificationKind('Re-inspection due: Waterproofing, Terrace')).toBe('inspection');
    expect(notificationKind('New checklist issued: Pre-Tiling — Bathroom 2')).toBe('inspection');
    // a material notice names a decision id — must still classify as material, not decision
    expect(notificationKind('Material mismatch: Marble ≠ approved DL-014')).toBe('material');
    expect(notificationKind('Signal lost')).toBeNull();
  });
});

describe('notificationTarget — role-aware jump from the bell', () => {
  it('routes a decision notice to the role’s decision surface', () => {
    expect(notificationTarget('Decision awaiting approval: X', 'client')).toBe('client-decisions');
    expect(notificationTarget('Decision awaiting approval: X', 'pmc')).toBe('decision-log');
    expect(notificationTarget('Client approved X', 'contractor')).toBe('decision-log');
  });

  it('routes drawings and inspections to the right screen per role', () => {
    expect(notificationTarget('Drawing issued: A-201', 'contractor')).toBe('drawings');
    expect(notificationTarget('Re-inspection due: X', 'pmc')).toBe('inspect-review');
    expect(notificationTarget('New checklist: X', 'engineer')).toBe('engineer-check');
    expect(notificationTarget('Material mismatch: X', 'pmc')).toBe('site-schedule');
  });

  it('returns null when the role has no relevant screen (never a dangling link)', () => {
    // a consultant has no inspection screen
    expect(notificationTarget('Re-inspection due: X', 'consultant')).toBeNull();
    // material → daily-log / site-schedule; a client has neither
    expect(notificationTarget('Material mismatch: X', 'client')).toBeNull();
  });
});

describe('notificationLink — the record a notice opens (live bug 1)', () => {
  const records: NotificationRecords = {
    decisions: [
      { id: 'DL-014', title: 'Living Room Flooring', awaitsViewer: true },
      { id: 'DL-015', title: 'Living Room', awaitsViewer: false },
      { id: 'DL-009', title: 'Master Bath CP Fittings', awaitsViewer: false },
    ],
    decisionsSettled: true,
  };
  const n = (text: string, decisionId?: string) => ({ text, time: 'now', color: '#000', ...(decisionId ? { decisionId } : {}) });
  const at = (screen: string, item: string | null, extra: { missing?: boolean; loading?: boolean } = {}) =>
    ({ screen, item, missing: extra.missing ?? false, loading: extra.loading ?? false });

  it('a decision the server names is opened as given, even before the slice holds it', () => {
    expect(notificationLink(n('Decision awaiting approval: Anything', 'DL-009'), 'pmc', records)).toEqual(at('decision-log', 'DL-009'));
    expect(notificationLink(n('Decision awaiting approval: X', 'DL-777'), 'pmc', { ...records, decisions: [], decisionsSettled: false })).toEqual(at('decision-log', 'DL-777'));
  });

  it('Codex 4203544295 — a structured decisionId decides the kind before any wording does', () => {
    // "material" would classify the text as a material notice; the id says it is a decision
    expect(notificationLink(n('Decision awaiting approval: Material selection', 'DL-009'), 'pmc', records)).toEqual(at('decision-log', 'DL-009'));
    expect(notificationLink(n('Decision awaiting approval: Material selection', 'DL-014'), 'client', records)).toEqual(at('client-decisions', 'DL-014'));
  });

  it('Codex 4203544271 — a client opens the approval screen only for a decision awaiting them; any other in the register', () => {
    expect(notificationLink(n('Decision awaiting approval: Living Room Flooring', 'DL-014'), 'client', records)).toEqual(at('client-decisions', 'DL-014'));
    expect(notificationLink(n('Client approved Master Bath CP Fittings — Kohler', 'DL-009'), 'client', records)).toEqual(at('decision-log', 'DL-009'));
    // a legacy, id-less approval notice for the client goes to the register too
    expect(notificationLink(n('Client approved Master Bath CP Fittings — Kohler'), 'client', records)).toEqual(at('decision-log', 'DL-009'));
  });

  it('Codex 4203544322 — a legacy notice names the title its template quotes, matched EXACTLY', () => {
    // DL-015 "Living Room" does not await this viewer: it opens in the register
    expect(notificationLink(n('New decision issued for approval: Living Room'), 'pmc', records)).toEqual(at('decision-log', 'DL-015'));
    // the quoted decision is gone; a shorter overlapping title must NOT stand in for it
    const gone = { ...records, decisions: records.decisions.filter((d) => d.id !== 'DL-014') };
    expect(notificationLink(n('New decision issued for approval: Living Room Flooring'), 'pmc', gone)).toEqual(at('decision-log', null, { missing: true }));
  });

  it('two decisions with the same exact title name neither: the register opens, nothing is called missing', () => {
    const twins = { ...records, decisions: [{ id: 'A', title: 'Door', awaitsViewer: false }, { id: 'B', title: 'Door', awaitsViewer: false }] };
    expect(notificationLink(n('Decision awaiting approval: Door'), 'pmc', twins)).toEqual(at('decision-log', null));
  });

  it('a decision notice in no template names nothing and opens its screen, never "missing"', () => {
    expect(notificationLink(n('Decision record updated'), 'pmc', records)).toEqual(at('decision-log', null));
  });

  it('Codex 4203544279 — while the records are loading or failed, a template notice is LOADING, never missing', () => {
    expect(notificationLink(n('New decision issued for approval: Porch Tiles'), 'pmc', { ...records, decisionsSettled: false })).toEqual(at('decision-log', null, { loading: true }));
    // settled, the same notice is judged
    expect(notificationLink(n('New decision issued for approval: Porch Tiles'), 'pmc', records)).toEqual(at('decision-log', null, { missing: true }));
  });

  it('Codex 4203960922 — a client is routed to the approval screen only on a SETTLED slice', () => {
    // the command snapshot carried the notice; the slice still holds the pre-approval state
    const stale = { ...records, decisionsSettled: false };
    expect(notificationLink(n('Client approved Living Room Flooring — Marble', 'DL-014'), 'client', stale)).toEqual(at('decision-log', 'DL-014'));
    expect(notificationLink(n('Decision awaiting approval: Living Room Flooring', 'DL-014'), 'client', records)).toEqual(at('client-decisions', 'DL-014'));
  });

  it('Codex review 5440751865 — ANY role named as decider opens the approval screen, where they can act', () => {
    // an engineer, contractor or consultant decider is granted the approval route (withDeciderRoute);
    // the register would show them the decision read-only
    for (const role of ['engineer', 'contractor', 'consultant', 'pmc'] as const) {
      expect(notificationLink(n('Decision awaiting approval: Living Room Flooring', 'DL-014'), role, records)).toEqual(at('client-decisions', 'DL-014'));
      // the same role on a decision it is NOT deciding reads it in the register
      expect(notificationLink(n('Client approved Master Bath CP Fittings — Kohler', 'DL-009'), role, records)).toEqual(at('decision-log', 'DL-009'));
      // and never on an unsettled slice
      expect(notificationLink(n('Decision awaiting approval: Living Room Flooring', 'DL-014'), role, { ...records, decisionsSettled: false })).toEqual(at('decision-log', 'DL-014'));
    }
    // a legacy, id-less notice resolved by its exact title follows the same rule
    expect(notificationLink(n('New decision issued for approval: Living Room Flooring'), 'engineer', records)).toEqual(at('client-decisions', 'DL-014'));
  });

  it('Codex 4206188328 — an id-less decision template is a decision notice, whatever keyword its title holds', () => {
    const titled = (title: string) => ({ ...records, decisions: [{ id: 'DL-050', title, awaitsViewer: false }] });
    for (const title of ['Material selection', 'Drawing room panelling', 'Inspection hatch', 'Checklist board']) {
      expect(notificationLink(n(`Decision awaiting approval: ${title}`), 'pmc', titled(title))).toEqual(at('decision-log', 'DL-050'));
      expect(notificationLink(n(`Decision awaiting approval: ${title}`), 'client', titled(title))).toEqual(at('decision-log', 'DL-050'));
    }
  });

  it('Codex 4206188340 — an unresolved decision notice offers the register, never the approval queue', () => {
    // a client's id-less notice whose decision is gone, still loading, or ambiguous
    expect(notificationLink(n('New decision issued for approval: Porch Tiles'), 'client', records)).toEqual(at('decision-log', null, { missing: true }));
    expect(notificationLink(n('New decision issued for approval: Porch Tiles'), 'client', { ...records, decisionsSettled: false })).toEqual(at('decision-log', null, { loading: true }));
    const twins = { ...records, decisions: [{ id: 'A', title: 'Door', awaitsViewer: true }, { id: 'B', title: 'Door', awaitsViewer: true }] };
    expect(notificationLink(n('Decision awaiting approval: Door'), 'client', twins)).toEqual(at('decision-log', null));
    // a decision notice that names nothing still opens the client's own decision screen, as before
    expect(notificationLink(n('Decision record updated'), 'client', records)).toEqual(at('client-decisions', null));
  });

  it('Codex 4206188348 — an approval notice is matched against whole titles, never split at an em dash', () => {
    const doors = { ...records, decisions: [{ id: 'D1', title: 'Door', awaitsViewer: false }, { id: 'D2', title: 'Door — Oak', awaitsViewer: false }] };
    // material "Oak — premium" on decision "Door": BOTH "Door" and "Door — Oak" are whole-title prefixes, so
    // the notice is ambiguous and names neither — never the wrong record
    expect(notificationLink(n('Client approved Door — Oak — premium'), 'pmc', doors)).toEqual(at('decision-log', null));
    // with only "Door" present, the notice opens it (a greedy split would have looked for "Door — Oak")
    const door = { ...records, decisions: [{ id: 'D1', title: 'Door', awaitsViewer: false }] };
    expect(notificationLink(n('Client approved Door — Oak — premium'), 'pmc', door)).toEqual(at('decision-log', 'D1'));
    // a title holding a dash itself resolves to that title
    const dashed = { ...records, decisions: [{ id: 'D3', title: 'Gate — North', awaitsViewer: false }] };
    expect(notificationLink(n('Client approved Gate — North — Teak'), 'pmc', dashed)).toEqual(at('decision-log', 'D3'));
  });

  it('live bug 1b — an inspection notice opens the inspection its WRITER named, on the role\'s own screen', () => {
    expect(notificationLink(n('Re-inspection INSP-022 created for 2 item(s) — due 10 Oct 2026.'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-022'));
    expect(notificationLink(n('Re-inspection INSP-022 created for 2 item(s) — due 10 Oct 2026.'), 'engineer', records)).toEqual(at('engineer-check', 'INSP-022'));
    // Codex 4205610125 — the engineer's checklist notice opens THAT checklist, not whichever holds the slot
    expect(notificationLink(n('New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor (INSP-22)'), 'engineer', records)).toEqual(at('engineer-check', 'INSP-22'));
    expect(notificationLink(n('New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor (INSP-22)'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-22'));
  });

  it('Codex 4207530075 — the writer\'s id is the LAST token; an id inside the user\'s title or zone names nothing', () => {
    expect(notificationLink(n('New checklist issued: Follow-up INSP-21 — Terrace (INSP-50)'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-50'));
    expect(notificationLink(n('New checklist issued: Slab — Roof (INSP-21) (INSP-51)'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-51'));
    expect(notificationLink(n('Inspection INSP-21 discussed on site'), 'pmc', records)).toEqual(at('inspect-review', null));
  });

  it('Codex 4209321875 — an id-less legacy inspection notice names NOTHING: it is never matched to a current record', () => {
    // the inspection it announced may be decided, and a later one may reuse its title and zone: opening the
    // only current match would send the viewer — an engineer, to fill — to the wrong inspection
    expect(notificationLink(n('New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor'), 'engineer', records)).toEqual(at('engineer-check', null));
    expect(notificationLink(n('New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor'), 'pmc', records)).toEqual(at('inspect-review', null));
    // the owner's seeded repro names no id: it opens Inspection Review, never a near-titled inspection
    expect(notificationLink(n('Re-inspection due: Waterproofing, Terrace'), 'pmc', records)).toEqual(at('inspect-review', null));
  });

  it('an inspection prefix decides the kind before any keyword in the user text does', () => {
    expect(notificationLink(n('New checklist issued: Material test — slab (INSP-40)'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-40'));
    expect(notificationLink(n('Re-inspection due: Drawing room plaster, Ground'), 'pmc', records)).toEqual(at('inspect-review', null));
  });

  it('an inspection notice naming no record opens its screen, never "missing"', () => {
    expect(notificationLink(n('Inspection approved. Contractor and client notified.'), 'pmc', records)).toEqual(at('inspect-review', null));
  });

  it('a screen that cannot show one record opens as before', () => {
    expect(notificationLink(n('Drawing issued: A-201 Rev C'), 'contractor', records)).toEqual(at('drawings', null));
    expect(notificationLink(n('Signal lost'), 'pmc', records)).toBeNull();
  });
});

describe('one "settled" for every judge (Codex 4204448859 / 4205058538 / 4209321885)', () => {
  const base = { projectLoadState: 'ready', commandReconcilePending: false, commandReconcileModulesOnly: false, decisionsLoad: 'ready', inspectionsLoad: 'ready' } as const;

  it('a reconcile owed for EVERY slice (a superseded command snapshot) unsettles every slice, in both read modes', () => {
    const owed = { ...base, commandReconcilePending: true };
    expect(decisionsSliceSettled(owed, true)).toBe(false);
    expect(decisionsSliceSettled(owed, false)).toBe(false);
    expect(inspectionsSliceSettled(owed, true)).toBe(false);
    expect(inspectionsSliceSettled(owed, false)).toBe(false);
  });

  it('Codex 4209321885 — a reconcile owed only for MODULE reads leaves the snapshot-owned slices settled', () => {
    // the command's own snapshot APPLIED: snapshot-owned slices are current; only module reads wait
    const owed = { ...base, commandReconcilePending: true, commandReconcileModulesOnly: true };
    expect(decisionsSliceSettled(owed, true)).toBe(false);
    expect(inspectionsSliceSettled(owed, true)).toBe(false);
    expect(decisionsSliceSettled(owed, false)).toBe(true);
    expect(inspectionsSliceSettled(owed, false)).toBe(true);
  });

  it('otherwise each slice is settled by its own read', () => {
    expect(decisionsSliceSettled(base, true)).toBe(true);
    expect(decisionsSliceSettled({ ...base, decisionsLoad: 'idle' }, true)).toBe(true);
    expect(decisionsSliceSettled({ ...base, decisionsLoad: 'loading' }, true)).toBe(false);
    expect(decisionsSliceSettled({ ...base, decisionsLoad: 'error' }, true)).toBe(false);
    expect(decisionsSliceSettled({ ...base, projectLoadState: 'loading' }, false)).toBe(false);
    expect(decisionsSliceSettled({ ...base, projectLoadState: 'error' }, false)).toBe(false);
    expect(inspectionsSliceSettled(base, true)).toBe(true);
    expect(inspectionsSliceSettled({ ...base, inspectionsLoad: 'idle' }, true)).toBe(false);
    expect(inspectionsSliceSettled({ ...base, inspectionsLoad: 'error' }, true)).toBe(false);
    expect(inspectionsSliceSettled({ ...base, inspectionsLoad: 'idle' }, false)).toBe(true);
    expect(inspectionsSliceSettled({ ...base, projectLoadState: 'error' }, false)).toBe(false);
  });
});
