import { describe, it, expect } from 'vitest';
import { can, rolesFor, ROLE_POLICY, type PolicyAction, type TokenRole } from '@vitan/shared';

const ALL_ROLES: TokenRole[] = ['pmc', 'client', 'engineer', 'contractor', 'worker'];

/**
 * The canonical role→action matrix. This table IS the spec the API's @Roles decorators
 * must mirror; if the two disagree, one of them is wrong. Keeping it here as an explicit
 * literal (not derived from ROLE_POLICY) makes an accidental edit to the map fail loudly.
 */
const EXPECTED: Record<PolicyAction, TokenRole[]> = {
  'decision.create': ['pmc'],
  'decision.approve': ['client', 'pmc'],
  'decision.change': ['pmc', 'client', 'contractor', 'engineer'],
  'activity.start': ['engineer', 'pmc'],
  'activity.complete': ['engineer', 'pmc'],
  'activity.manage': ['pmc'],
  'phase.manage': ['pmc'],
  'inspection.submit': ['engineer', 'pmc'],
  'inspection.decide': ['pmc'],
  'dailyLog.flagMismatch': ['engineer', 'pmc'],
  'dailyLog.submit': ['engineer', 'pmc'],
  'media.upload': ['pmc', 'engineer'],
  'media.delete': ['pmc', 'engineer'],
  'drawing.issue': ['pmc'],
  'drawing.presign': ['pmc'],
  'drawing.acknowledge': ['pmc', 'engineer', 'contractor'],
  'drawing.delete': ['pmc'],
  'org.create': ['pmc', 'client', 'engineer', 'contractor'],
};

describe('authorization policy (shared source of truth)', () => {
  it('matches the expected role→action matrix exactly', () => {
    for (const action of Object.keys(EXPECTED) as PolicyAction[]) {
      expect([...rolesFor(action)].sort()).toEqual([...EXPECTED[action]].sort());
    }
    // No stray actions beyond the spec.
    expect(Object.keys(ROLE_POLICY).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('fixes the drawings-acknowledge drift: PMC may acknowledge, client may not', () => {
    expect(can('drawing.acknowledge', 'pmc')).toBe(true); // the bug: UI hid this from PMC
    expect(can('drawing.acknowledge', 'engineer')).toBe(true);
    expect(can('drawing.acknowledge', 'contractor')).toBe(true);
    expect(can('drawing.acknowledge', 'client')).toBe(false);
    expect(can('drawing.acknowledge', 'worker')).toBe(false);
  });

  it('restricts drawing issue/delete and inspection sign-off to the PMC', () => {
    for (const role of ALL_ROLES) {
      const isPmc = role === 'pmc';
      expect(can('drawing.issue', role)).toBe(isPmc);
      expect(can('drawing.delete', role)).toBe(isPmc);
      expect(can('inspection.decide', role)).toBe(isPmc);
    }
  });

  it('never permits a worker device token to perform any policied action', () => {
    for (const action of Object.keys(ROLE_POLICY) as PolicyAction[]) {
      expect(can(action, 'worker')).toBe(false);
    }
  });

  it('lets the site engineer raise a change request (the #44 regression fix)', () => {
    expect(can('decision.change', 'engineer')).toBe(true);
  });
});
