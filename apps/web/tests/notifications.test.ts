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
      { id: 'DL-014', title: 'Living Room Flooring' },
      { id: 'DL-015', title: 'Living Room' },
      { id: 'DL-009', title: 'Master Bath CP Fittings' },
    ],
    inspections: [
      { id: 'INSP-21', title: 'Waterproofing Ponding Test', zone: 'Terrace' },
      { id: 'INSP-22', title: 'Pre-Tiling Inspection', zone: 'Bathroom 2 · 3rd Floor' },
    ],
  };
  const n = (text: string, decisionId?: string) => ({ text, time: 'now', color: '#000', ...(decisionId ? { decisionId } : {}) });

  it('a decision notice opens the decision the server names', () => {
    expect(notificationLink(n('Decision awaiting approval: Anything', 'DL-009'), 'pmc', records)).toEqual({ screen: 'decision-log', item: 'DL-009', missing: false });
    // the client's own decision surface takes the same record
    expect(notificationLink(n('Decision awaiting approval: Anything', 'DL-009'), 'client', records)).toEqual({ screen: 'client-decisions', item: 'DL-009', missing: false });
  });

  it('a legacy notice with no id opens the decision whose title it quotes, the longest title winning', () => {
    // "Living Room" is ALSO quoted, but the longer "Living Room Flooring" is the one the notice is about
    expect(notificationLink(n('New decision issued for approval: Living Room Flooring'), 'pmc', records)).toEqual({ screen: 'decision-log', item: 'DL-014', missing: false });
  });

  it('an id the server names is followed even before the slice holds it (the register judges it once loaded)', () => {
    expect(notificationLink(n('Decision awaiting approval: X', 'DL-777'), 'pmc', { ...records, decisions: [] })).toEqual({ screen: 'decision-log', item: 'DL-777', missing: false });
  });

  it('a notice naming no decision, whose title matches none, is MISSING — never the bare register', () => {
    expect(notificationLink(n('New decision issued for approval: Porch Tiles'), 'pmc', records)).toEqual({ screen: 'decision-log', item: null, missing: true });
  });

  it('two decisions with the same quoted title name neither', () => {
    const twins: NotificationRecords = { ...records, decisions: [{ id: 'A', title: 'Door' }, { id: 'B', title: 'Door' }] };
    expect(notificationLink(n('Decision awaiting approval: Door'), 'pmc', twins)?.item).toBeNull();
  });

  it('an inspection notice opens the inspection it names by id', () => {
    expect(notificationLink(n('Re-inspection INSP-22 created for 2 item(s) — due 10 Oct 2026.'), 'pmc', records)).toEqual({ screen: 'inspect-review', item: 'INSP-22', missing: false });
    // followed as given: the review screen says so if it cannot show it
    expect(notificationLink(n('Re-inspection INSP-404 created for 1 item(s).'), 'pmc', records)).toEqual({ screen: 'inspect-review', item: 'INSP-404', missing: false });
  });

  it('"Re-inspection due: <work>, <zone>" opens the re-inspection task there, else the one inspection of that work there', () => {
    const due = n('Re-inspection due: Waterproofing, Terrace');
    expect(notificationLink(due, 'pmc', records)).toEqual({ screen: 'inspect-review', item: 'INSP-21', missing: false });
    const withTask: NotificationRecords = { ...records, inspections: [...records.inspections, { id: 'INSP-030', title: 'Re-inspection: Waterproofing Ponding Test', zone: 'Terrace' }] };
    expect(notificationLink(due, 'pmc', withTask)?.item).toBe('INSP-030');
    expect(notificationLink(due, 'pmc', { ...records, inspections: [] })).toEqual({ screen: 'inspect-review', item: null, missing: true });
  });

  it('a screen that cannot show one record opens as before, never missing', () => {
    // an engineer's re-inspection opens the field checklist screen, which has no item route
    expect(notificationLink(n('Re-inspection due: Waterproofing, Terrace'), 'engineer', records)).toEqual({ screen: 'engineer-check', item: null, missing: false });
    expect(notificationLink(n('Drawing issued: A-201 Rev C'), 'contractor', records)).toEqual({ screen: 'drawings', item: null, missing: false });
    expect(notificationLink(n('Signal lost'), 'pmc', records)).toBeNull();
  });
});
