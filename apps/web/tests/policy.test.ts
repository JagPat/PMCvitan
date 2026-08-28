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
  'decision.publish': ['pmc'],
  // Phase 6 unit 4b — the approve allowlist is the CEILING, not the authority: a decision now
  // names WHO decides it, a named member may hold any active project role, and the SERVICE
  // narrows to the actual decider (a same-role non-decider is refused there, never here).
  'decision.approve': ['client', 'pmc', 'engineer', 'contractor', 'consultant'],
  // Phase 6 unit 4b — re-point an unpublished draft's decider; issuing decisions is pmc authority.
  'decision.updateDraft': ['pmc'],
  'decision.change': ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
  'decision.withdrawChange': ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
  // Phase 6 task 4a — withdrawing a published decision retires a question the practice asked;
  // that is the practice's call alone.
  'decision.withdraw': ['pmc'],
  'requirement.manage': ['pmc'],
  'requirement.read': ['pmc', 'engineer'],
  'substitution.manage': ['pmc'],
  'requisition.submit': ['pmc', 'engineer'],
  'requisition.approve': ['pmc'],
  'procurement.manage': ['pmc'],
  'procurement.read': ['pmc', 'engineer'],
  // Phase 3 Task 4 — the inventory store surface (plan §H matrix): receipt/accept/reject/
  // vendor-return are pmc+engineer store work; adjustment + reversal are pmc; read mirrors
  // procurement.read.
  'stock.record': ['pmc', 'engineer'],
  'stock.adjust': ['pmc'],
  'stock.read': ['pmc', 'engineer'],
  // Phase 4 Task 1 — the labour pilot surface (plan §H matrix): trusted-workforce identity
  // (worker/crew onboarding, revocation, device binding, catalog) is pmc authority; the
  // workforce register read mirrors requirement.read (pmc + engineer).
  'labour.manage': ['pmc'],
  'labour.read': ['pmc', 'engineer'],
  // Phase 4 Task 2 — the labour COMMERCIAL chain (plan §F/§H): requesting/submitting a labour
  // requisition is pmc/engineer; the requisition sign-off + RFQ/quote/comparison/PO machine is
  // pmc; the CapacityCommitment lifecycle is pmc.
  'labour.requisition.request': ['pmc', 'engineer'],
  'labour.requisition.approve': ['pmc'],
  'labour.commit.manage': ['pmc'],
  // Phase 4 Task 3 — the §C time-capacity FACT surface (plan §H matrix): allocation is site work
  // the engineer plans with the pmc; recording presence and effort is the muster (engineer +
  // contractor); revoking presence is a pmc correction; widening §B satisfaction with a skill
  // substitution is pmc authority (the same authority that approves a material substitution).
  'allocation.manage': ['pmc', 'engineer'],
  'attendance.record': ['pmc', 'engineer', 'contractor'],
  'attendance.revoke': ['pmc'],
  'labour.work.record': ['pmc', 'engineer', 'contractor'],
  'labour.override': ['pmc'],
  'labour.mismatch.record': ['pmc', 'engineer'],
  'labour.mismatch.resolve': ['pmc'],
  'activity.output.record': ['pmc', 'engineer', 'contractor'],
  // Phase 5 Task 1 — the COMMERCIAL pilot surface (plan §C/§I). Defining a cost head and
  // attributing a vendor commitment to one decide which budget carries which money, so both are
  // pmc. `commercial.attribute` follows the WRITE, not the route: the participant enforces it
  // inside `pos.issue`/`labour.po.issue` exactly as the standalone route does, so PO-issue
  // authority alone never confers it. The register read mirrors `procurement.read`.
  'commercial.manage': ['pmc'],
  'commercial.attribute': ['pmc'],
  'commercial.budget.manage': ['pmc'],
  'commercial.read': ['pmc', 'engineer'],
  // Phase 5 Task 3 (§D) — a measurement is a BILLING fact taken against signed-off work, so it
  // is the engineer-and-above surface the site already trusts to record what happened.
  'commercial.measure': ['pmc', 'engineer'],
  // Phase 5 Task 4 (§F/§I) — recording/amending/rejecting a vendor claim is the engineer-and-above
  // data-entry surface; opening the §E verification on one is pmc.
  'commercial.bill': ['pmc', 'engineer'],
  'commercial.verify': ['pmc'],
  // Phase 5 Task 5B (§E/§F/§I) — certifying a claim and superseding a certificate. Separate from
  // `commercial.verify` even though both are pmc today: certification creates money someone may
  // approve, and collapsing them would let a later widening of verification widen payment too.
  'commercial.certify': ['pmc'],
  'commercial.sod.grant': ['pmc'],
  'commercial.deduct': ['pmc'],
  'commercial.deduct.release': ['pmc'],
  'commercial.approve-payment': ['pmc'],
  'commercial.record-payment': ['pmc'],
  'commercial.reverse-payment': ['pmc'],
  'commercial.pay-advance': ['pmc'],
  'activity.start': ['engineer', 'pmc'],
  'activity.complete': ['engineer', 'pmc'],
  'activity.manage': ['pmc'],
  'phase.manage': ['pmc'],
  'node.manage': ['pmc'],
  'inspection.create': ['pmc'],
  'inspection.submit': ['engineer', 'pmc'],
  'inspection.decide': ['pmc'],
  'dailyLog.start': ['engineer', 'pmc'],
  'dailyLog.addMaterial': ['engineer', 'pmc'],
  'dailyLog.flagMismatch': ['engineer', 'pmc'],
  // Phase 3 Task 5 (§E) — closing a mismatch is the PMC's attributable authority decision.
  'dailyLog.resolveMismatch': ['pmc'],
  'dailyLog.submit': ['engineer', 'pmc'],
  'media.upload': ['pmc', 'engineer'],
  'media.delete': ['pmc', 'engineer'],
  'media.file': ['pmc', 'engineer'],
  'drawing.issue': ['pmc'],
  'drawing.publish': ['pmc'],
  'drawing.presign': ['pmc'],
  'drawing.acknowledge': ['pmc', 'engineer', 'contractor'],
  'drawing.delete': ['pmc'],
  'drawing.file': ['pmc'],
  'org.create': ['pmc', 'client', 'engineer', 'contractor'],
  // Read surfaces requiring a real account (the API derives these GET allowlists from the
  // same map — Phase 2 Task 2); a worker device token is excluded.
  'project.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
  'members.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
  'companies.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
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

  it('withdraw shares the change allowlist — the SERVICE narrows it to requester-or-PMC (Phase 1 Task 2)', () => {
    expect([...rolesFor('decision.withdrawChange')].sort()).toEqual([...rolesFor('decision.change')].sort());
    expect(can('decision.withdrawChange', 'worker')).toBe(false);
  });
});
