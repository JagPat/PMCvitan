import { describe, it, expect } from 'vitest';
import { notificationKind, notificationLink, notificationTarget, type NotificationRecords } from '@/lib/notifications';

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
    inspections: [
      { id: 'INSP-21', title: 'Waterproofing Ponding Test', zone: 'Terrace' },
      { id: 'INSP-22', title: 'Pre-Tiling Inspection', zone: 'Bathroom 2 · 3rd Floor' },
    ],
    inspectionsSettled: true,
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
    expect(notificationLink(n('New decision issued for approval: Living Room Flooring'), 'pmc', records)).toEqual(at('decision-log', 'DL-014'));
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
    expect(notificationLink(n('Re-inspection due: Waterproofing, Terrace'), 'pmc', { ...records, inspectionsSettled: false })).toEqual(at('inspect-review', null, { loading: true }));
    // settled, the same notice is judged
    expect(notificationLink(n('New decision issued for approval: Porch Tiles'), 'pmc', records)).toEqual(at('decision-log', null, { missing: true }));
  });

  it('an inspection notice opens the inspection it names by id', () => {
    expect(notificationLink(n('Re-inspection INSP-022 created for 2 item(s) — due 10 Oct 2026.'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-022'));
  });

  it('"Re-inspection due: <work>, <zone>" opens the re-inspection task there, else the one inspection of that work there', () => {
    const due = n('Re-inspection due: Waterproofing, Terrace');
    expect(notificationLink(due, 'pmc', records)).toEqual(at('inspect-review', 'INSP-21'));
    const withTask = { ...records, inspections: [...records.inspections, { id: 'INSP-030', title: 'Re-inspection: Waterproofing Ponding Test', zone: 'Terrace' }] };
    expect(notificationLink(due, 'pmc', withTask)?.item).toBe('INSP-030');
    expect(notificationLink(due, 'pmc', { ...records, inspections: [] })).toEqual(at('inspect-review', null, { missing: true }));
  });

  it('Codex 4203544289 — "New checklist issued: <title> — <zone>" opens that checklist', () => {
    expect(notificationLink(n('New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor'), 'pmc', records)).toEqual(at('inspect-review', 'INSP-22'));
    expect(notificationLink(n('New checklist issued: Pre-Tiling Inspection — Kitchen'), 'pmc', records)).toEqual(at('inspect-review', null, { missing: true }));
  });

  it('an inspection notice naming no record opens its screen, never "missing"', () => {
    expect(notificationLink(n('Inspection approved. Contractor and client notified.'), 'pmc', records)).toEqual(at('inspect-review', null));
  });

  it('a screen that cannot show one record opens as before', () => {
    // an engineer's re-inspection opens the field checklist screen, which has no item route
    expect(notificationLink(n('Re-inspection due: Waterproofing, Terrace'), 'engineer', records)).toEqual(at('engineer-check', null));
    expect(notificationLink(n('Drawing issued: A-201 Rev C'), 'contractor', records)).toEqual(at('drawings', null));
    expect(notificationLink(n('Signal lost'), 'pmc', records)).toBeNull();
  });
});
