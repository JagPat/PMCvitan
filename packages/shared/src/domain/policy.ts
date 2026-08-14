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
  // Phase 6 task 4a — withdrawing a published decision retires a question the practice asked;
  // that is the practice's call alone (the client never had authority over the asking either).
  'decision.withdraw': ['pmc'],
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
  // Phase 5 Task 4 (§F/§I) — recording, amending and REJECTING a vendor's claim.
  //
  // §I's permission list does not name this one, and Task 4 adds it rather than borrowing
  // `commercial.read` or silently reusing `commercial.certify`, because §I's own rule is that
  // "a permission a route needs and the manifest does not declare is not a gap in the docs; it
  // is an unauthorized write path". Recording what a counterparty claims is data entry against
  // site-adjacent evidence, so it is the same engineer-and-above surface as measurement — the
  // authority that MATTERS is `commercial.verify` below and, from Task 5, certification.
  'commercial.bill': ['pmc', 'engineer'],
  // §I — opening the §E three-way check on a claim. Task 4 ships only the transition INTO
  // verification (`submitted → under-verification`); the VERDICT and everything it authorises
  // land in Task 5 with the evidence that makes them safe.
  'commercial.verify': ['pmc'],
  // Phase 5 Task 5B (§E/§F/§I) — CERTIFYING a claim, and SUPERSEDING a certificate.
  //
  // Separate from `commercial.verify` even though both resolve to `pmc` today, because they are
  // different authorities that happen to coincide: verification is an arithmetic check anyone
  // trusted with the register may run, certification CREATES MONEY someone may approve. Collapsing
  // them would mean a later widening of the verification surface silently widened the payment
  // authority too — and §I's own rule is that a permission the manifest does not declare is not a
  // documentation gap, it is an unauthorized write path.
  //
  // §I's segregation rule is NOT this permission. It is a per-act check against the evidence the
  // certificate consumes, evaluated server-side under the bill lock, with a named and attributable
  // exception path — a role list cannot express "not the person who recorded THIS evidence".
  'commercial.certify': ['pmc'],
  // §I — issuing the GRANT that excuses a conflicted certification. Same role list as `certify`
  // today, and deliberately its OWN permission: the two are different acts by different people,
  // and collapsing them would mean any later widening of who may certify silently widened who may
  // authorise a certifier to override the rule that stops them.
  'commercial.sod.grant': ['pmc'],
  // §H — WITHHOLDING money from a certified payable, and RELEASING part of it. Separate
  // permissions for the same reason `certify` and `sod.grant` are separate: they are different
  // acts, and a practice may well want the person who applies a penalty to be someone other than
  // the person who can give it back. Same role list today; the point is that widening one later
  // does not silently widen the other.
  'commercial.deduct': ['pmc'],
  'commercial.deduct.release': ['pmc'],
  // Phase 5 Task 6A (§I) — approving payment and recording it are SEPARATE authorities, and both
  // are separate from certification. The plan is explicit that certification and payment approval
  // are deliberately apart; declaring one permission for both would make the certifier-vs-approver
  // rule unenforceable at the route.
  'commercial.approve-payment': ['pmc'],
  'commercial.record-payment': ['pmc'],
  // Phase 5 Task 6B unit ii (§H) — recovering money already paid. The PAYER'S authority, which is
  // why it sits beside `record-payment` rather than under it: reversing is the same person's act
  // on the same bank relationship, and §0 makes it the first step of the correction ordering a
  // certificate carrying cash requires. Its OWN permission for the reason every pair in this block
  // is separate — a practice may want the person who can send money to be unable to claw it back,
  // and widening one must never silently widen the other.
  'commercial.reverse-payment': ['pmc'],
  // Phase 5 Task 6C (§H) — paying a counterparty AHEAD of any certified claim. Its own permission
  // for the reason every pair in this block has one: an advance commits the practice to money with
  // no certificate behind it yet, which is a different risk from paying a bill that was certified,
  // approved and bounded. Recovering it needs no new permission — an `advance-recovery` is a
  // deduction, so `commercial.deduct` already governs it.
  'commercial.pay-advance': ['pmc'],
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
