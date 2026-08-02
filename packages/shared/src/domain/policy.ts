/**
 * Authorization policy — the single source of truth for "which roles may perform which
 * project action". One map, consumed by both sides so they cannot drift:
 *   • the web UI gates action affordances with `can(action, role)` (e.g. show the
 *     "Acknowledge" button only to roles the server will accept), and
 *   • the API's `@Roles`/`RolesGuard` enforce the same allowlists on the endpoints.
 *
 * Keep these lists identical to the API's `@Roles(...)` decorators. Today the API
 * hard-codes matching literals because `@vitan/shared` is a source-only package the
 * Node runtime can't import; once it's promoted to a built package the API should
 * `@RolesFor(action)` straight from this map and the duplication disappears entirely.
 *
 * Drift this fixes: the drawings "acknowledge" button was gated to contractor|engineer
 * in the UI while the API accepts pmc too — so a PMC saw no button for an action the
 * server allowed. Both now read `ROLE_POLICY['drawing.acknowledge']`.
 */
import type { TokenRole } from './types';

export const ROLE_POLICY = {
  'decision.create': ['pmc'],
  // publish a private draft decision → issue it to the client (the architect's authority)
  'decision.publish': ['pmc'],
  'decision.approve': ['client', 'pmc'],
  // consultants raise change requests to flag a conflict in their discipline (read-mostly otherwise)
  'decision.change': ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
  // withdraw an open change request — endpoint allowlist; the SERVICE narrows it to the
  // actual requester or the PMC, so the UI must also check requestedById (Phase 1 Task 2)
  'decision.withdrawChange': ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
  // Phase 3 Task 1 — the ActivityRequirement demand contract is authored by the PMC (plan §H matrix)
  'requirement.manage': ['pmc'],
  // the full requirement register read (§H): pmc + engineer; the client sees only the readiness
  // summary surfaces (a later-task concern), never the raw register
  'requirement.read': ['pmc', 'engineer'],
  // Phase 3 Task 6 — approving/revoking a material substitution (§B) is pmc authority (§H matrix)
  'substitution.manage': ['pmc'],
  // Phase 3 Task 2 — the procurement pilot surface (plan §H matrix). Requisition drafting +
  // submission is a pmc/engineer action; approval and everything from RFQs through comparison
  // is pmc authority. Vendor CRUD is an ORG-ADMIN surface (org membership, not a project role)
  // and therefore is not represented here. The pipeline read mirrors requirement.read.
  'requisition.submit': ['pmc', 'engineer'],
  'requisition.approve': ['pmc'],
  'procurement.manage': ['pmc'],
  'procurement.read': ['pmc', 'engineer'],
  // Phase 3 Task 4 — the inventory store surface (plan §H matrix). Receipt recording and the
  // quality decisions (accept/reject) plus the vendor-return that closes a rejection are
  // pmc/engineer store work; the free-form adjustment and the reversal correction are pmc
  // authority; the store read mirrors procurement.read.
  'stock.record': ['pmc', 'engineer'],
  'stock.adjust': ['pmc'],
  'stock.read': ['pmc', 'engineer'],
  // Phase 4 Task 1 — the labour pilot surface (plan §H matrix). Trusted-workforce identity
  // (worker/crew onboarding, revocation, device binding, trade/skill catalog) is pmc authority;
  // the workforce register read mirrors requirement.read (pmc + engineer). The labour DEMAND is
  // authored through the Activities-owned `requirement.manage` command routed by type, so it needs
  // no separate labour policy. The fuller labour permission set (allocation/attendance/commit/
  // override, plan §H) lands with its routes in Tasks 2–5.
  'labour.manage': ['pmc'],
  'labour.read': ['pmc', 'engineer'],
  // Phase 4 Task 2 — the labour COMMERCIAL chain (plan §F/§H). Mirrors the procurement authority
  // split: requesting/submitting a labour requisition is pmc/engineer site work; approving it and
  // the labour RFQ/quote/comparison/PO/commitment machine is pmc authority; the commercial reads
  // mirror `labour.read`. `VendorLabourProfile` is an ORG-ADMIN surface (org membership, like vendor
  // CRUD) and is therefore NOT represented here.
  'labour.requisition.request': ['pmc', 'engineer'],
  'labour.requisition.approve': ['pmc'],
  'labour.commit.manage': ['pmc'],
  // Phase 4 Task 3 — the §C time-capacity FACT surface (plan §H matrix). Allocating a worker/crew to
  // an activity's dated slice is site work the engineer plans with the pmc; recording presence is the
  // muster (engineer/contractor + the worker's own device path); recording effort mirrors attendance;
  // widening §B satisfaction with a skill substitution is pmc authority (the same authority that
  // approves a material substitution). Revoking presence is a correction, so it stays pmc.
  'allocation.manage': ['pmc', 'engineer'],
  'attendance.record': ['pmc', 'engineer', 'contractor'],
  'attendance.revoke': ['pmc'],
  'labour.work.record': ['pmc', 'engineer', 'contractor'],
  'labour.override': ['pmc'],
  // Phase 4 Task 5 — §E reconciliation + §I measured output. OBSERVING a crew-vs-allocation
  // mismatch is site work (the same authority that records presence, minus the worker device
  // path); RESOLVING one is pmc authority — the §E rule, mirroring `dailyLog.resolveMismatch`.
  // Recording measured construction output mirrors `labour.work.record` (site facts are entered
  // by the people on site; the fact is immutable and evidence-bearing).
  'labour.mismatch.record': ['pmc', 'engineer'],
  'labour.mismatch.resolve': ['pmc'],
  'activity.output.record': ['pmc', 'engineer', 'contractor'],
  // Phase 5 Task 1 — the COMMERCIAL pilot surface (plan §C/§I). Defining a cost head and
  // attributing a vendor commitment to one are the acts that decide which budget carries which
  // money, so both are pmc authority. `commercial.attribute` follows the WRITE, not the route: it
  // is enforced identically by the standalone re-attribution route and by `CommercialParticipant`
  // inside `pos.issue`/`labour.po.issue`, so PO-issue authority alone never confers it (§C).
  // The fuller §I authority set (certification, payment approval, SoD, approval limits) lands
  // with the facts it guards in Tasks 5–6.
  'commercial.manage': ['pmc'],
  'commercial.attribute': ['pmc'],
  // Phase 5 Task 2 (§B) — setting or revising a budget is the act that decides how much a cost
  // head may carry, so it is pmc authority alongside `commercial.manage`. A budget GATES nothing,
  // so there is no separate approval role: exceeding it raises an exception, never a refusal.
  'commercial.budget.manage': ['pmc'],
  'commercial.read': ['pmc', 'engineer'],
  // Phase 5 Task 3 (§D/§I) — a measurement is a BILLING fact taken against signed-off work, so it
  // is the engineer-and-above surface the site already trusts to record what happened, not an
  // org-admin one. Task 5's SoD rule then keeps the measurer out of the certifier's seat.
  'commercial.measure': ['pmc', 'engineer'],
  'activity.start': ['engineer', 'pmc'],
  'activity.complete': ['engineer', 'pmc'],
  // planning & scheduling — the PMC authors the plan
  'activity.manage': ['pmc'],
  'phase.manage': ['pmc'],
  'node.manage': ['pmc'],
  'inspection.create': ['pmc'],
  'inspection.submit': ['engineer', 'pmc'],
  'inspection.decide': ['pmc'],
  'dailyLog.start': ['engineer', 'pmc'],
  'dailyLog.addMaterial': ['engineer', 'pmc'],
  'dailyLog.flagMismatch': ['engineer', 'pmc'],
  // Phase 3 Task 5 (§E) — closing a mismatch observation is the PMC's attributable quality
  // decision (the flag is engineer site work; the resolution disposes of the dispute)
  'dailyLog.resolveMismatch': ['pmc'],
  'dailyLog.submit': ['engineer', 'pmc'],
  'media.upload': ['pmc', 'engineer'],
  'media.delete': ['pmc', 'engineer'],
  // re-file a photo onto a location-tree node (or unfile) — same authority as upload
  'media.file': ['pmc', 'engineer'],
  'drawing.issue': ['pmc'],
  // publish a private draft drawing → issue it to the build team
  'drawing.publish': ['pmc'],
  'drawing.presign': ['pmc'],
  'drawing.acknowledge': ['pmc', 'engineer', 'contractor'],
  'drawing.delete': ['pmc'],
  // re-file a drawing onto a location-tree node (or unfile) — architect controls placement
  'drawing.file': ['pmc'],
  // Real account holders only — a `worker` device token has no User row (see the API's
  // POST /orgs gate), so it is intentionally excluded.
  'org.create': ['pmc', 'client', 'engineer', 'contractor'],
  // ── Read surfaces that require a REAL account (a worker device token is excluded,
  // SEC-02 / P1-2). The API GETs derive their allowlist from here too (Phase 2 Task 2),
  // so the whole role-gated surface — reads and writes — has ONE source of truth. The web
  // UI does not currently gate these reads, so `can()` simply isn't called for them.
  'project.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
  'members.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
  'companies.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
} as const satisfies Record<string, readonly TokenRole[]>;

/** A permissioned project action, e.g. `'drawing.acknowledge'`. */
export type PolicyAction = keyof typeof ROLE_POLICY;

/** True when `role` is permitted to perform `action`. Mirrors the server's allowlist. */
export function can(action: PolicyAction, role: TokenRole): boolean {
  return (ROLE_POLICY[action] as readonly TokenRole[]).includes(role);
}

/** The roles permitted to perform `action` (readonly). */
export function rolesFor(action: PolicyAction): readonly TokenRole[] {
  return ROLE_POLICY[action];
}
