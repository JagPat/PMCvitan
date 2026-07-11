import { describe, it, expect } from 'vitest';
import { notificationKind, notificationTarget } from '@/lib/notifications';

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
