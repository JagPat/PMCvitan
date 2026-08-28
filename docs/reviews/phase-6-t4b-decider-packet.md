# Phase 6 unit 4b — the decision decider model (implementation packet)

- **Plan:** `docs/superpowers/plans/2026-08-14-decision-workflow-4b.md` (merged PR #340; the
  BINDING §A/§B/§C design) under the family plan `docs/superpowers/plans/2026-08-13-decision-workflow.md` §B.
- **Base:** `2aee1722` · **Branch:** `claude/decision-workflow-4b`
- **Staged-red commit (the probes' honest baseline):** `52088062` — the SHAPE (the `recorded`/
  `none` enum arms, the decider contract fields, the push-subscription linkage columns, the
  widened shared types) with every behavior deliberately absent, per the staging discipline
  the 4a packet pinned.

## Vision alignment

One user workflow: WHO decides a decision — the owner's question the 4b plan answers. Today
"pending" is hard-wired to the client; 4b makes the decider explicit (`client`/`pmc`/a NAMED
member/`none` — the record-only issue that files a fact nobody approves), routes the ENTIRE
pending audience to that decider (visibility, bell, counts, projection, route, push), and
guards the holder at both layers so no membership or org-membership write can strand a
published open decision. One fact, one owner: the decision row carries the holder; orgs owns
standing (`phase6_effective_role_standing`, `sessionStillValid`); decisions owns the
open-holder answer (`DecisionsParticipant.holdsOpenDecisions`, the
`phase6_decisions_name_membership`/`phase6_decisions_hold_role` primitive pair); the platform
outbox owns only its own claim/cancellation marks. Pre-4b behaviour is byte-preserved: every
legacy decision is `client`-held by backfill, and an omitted `deciderKind` keeps every
existing caller unchanged.

## Review unit

<!-- review-size: justified-large -->
**Justified-large:** the plan's §A.3 is explicit that the pending audience must move on EVERY
surface in ONE unit — "each of these routes to THE DECIDER — and 'each' means ALL of them" —
because a partial cut either LEAKS a pending decision to a non-decider or HIDES a decider's
action item. The shared `viewerIsDecider` predicate and the widened `decision.approve`
ceiling are one interface with readers on both sides of the API/web line, so the split cannot
run between them. The migration is inseparable for the §A.1 reason the plan records (round
14–18): the holderless AUDIT, the guards it certifies, and the service writers that hold the
readiness key must deploy as one change or the audit's serialization story is false.

### What this unit delivers

- **§A.1 the decider model.** `Decision.deciderKind` (`client` default) + the named-member FK;
  `decisions.create`/`publish` validate the holder through the OWNER
  (`OrgsParticipant.lockActiveMembershipById`, `effectiveRoleStanding`) under
  `lockProjectReadiness`; the RE-ORDERED create (unpublished birth → options → same-tx
  publication) so the DB seals judge one shape; `decisions.updateDraft` (the drafting door:
  title/location/options/holder + the coherent record⟺choice conversion) with its own policy
  and route; `decisions.approve` narrowed to the ACTUAL decider (named member by user, role
  kinds by role, the PMC on-behalf recorded as `onBehalfOf: <kind>`) behind the widened route
  ceiling; publication freezes the holder (service CAS + the `20270826` attribution seal +
  this migration's lifecycle seal).
- **§A.1 the holder-orphan guard, BOTH designations, BOTH layers.** The orgs commands
  (`MembersService.add/updateRole/remove`, `OrgsService.updateOrgMemberRole/removeOrgMember`)
  consult `DecisionsParticipant.holdsOpenDecisions` in their own transaction and refuse a
  write that would strand a named holder or the last effective holder of a held role —
  including the round-19 activation-displacement arm and the round-11 org-membership arm
  walked per covered project in stable ascending order under the readiness keys. The DB
  re-judges the same content: `Membership_t4b2_holder_guard` /
  `OrgMembership_t4b2_holder_guard` call the decisions-owned predicate primitives under the
  §B.1 try-acquire-or-refuse protocol; the identity-freeze CLASS
  (`Membership.userId/projectId`, `OrgMembership.userId/orgId`, `Project.orgId`) makes every
  re-home a removal-plus-addition.
- **§A.2 the record-only issue.** `deciderKind: 'none'` ⟺ terminal `recorded` (the pair
  CHECK, both directions); EXACTLY ZERO options (zod refinement + the deferred
  `phase6_t4b2_option_floor` re-counting the published aggregate at commit from BOTH doors);
  the "Issue recorded" notice (ordinary audience, deliberately not a pending shape); NO push;
  approvable by nobody (deliberate 409); born-terminal with the approval-clean entry
  (plant-then-convert refused) and the published-record evidence freeze + delete seal; the
  recorded GATE arm — a linked DRAFT record gates `wait` ("publish it"), a published one `na`
  ("record only — no approval required") — threaded through `deriveDecisionReading`, the
  activities bake, and the in-tx `activities.start` read (`statusAndDraftOf`).
- **§A.3 the audience follows the decider.** The ONE shared `viewerIsDecider` predicate
  (`@vitan/shared`) consumed by `decisionVisibleToViewer` (pending = pmc + THE DECIDER), the
  projection read-path filter (the decider designation rides the fold's dto, so live ==
  projection == rebuild), the snapshot bell stripping (notice kept exactly when its decision
  is in the viewer's visible slice; legacy unlinked notices keep the pre-4b audience), the
  viewer-scoped `countPending` + the portfolio caller invoking it for EVERY role, the web
  mirrors (`selectLogDecisions`/`selectVisibleDecisions`/`selectDeciderPending`/
  `selectDeciderReapproval`/`selectActionItems`/nav badge over `sessionUserId` from the JWT),
  and the ROUTE arm (`withDeciderRoute`: `client-decisions` reachable exactly for an open
  decider — RouteBridge + nav; the Inbox CTA lands and stays).
- **§A.3 the targeted push spine.** `PushSubscription` linkage (user + credential version +
  the token's own `exp`) attributed on every authenticated subscribe; sign-out unlink (web +
  `POST …/push/unlink`); TARGETED delivery only to currently-valid links (expiry AND live
  version via the orgs-owned `sessionStillValid` — never a role-ceiling fallback); the
  catalog's `pushFamily: 'decider'` on `decision.published` (in the sealed coverage
  preimage) with the claim-time predicate (`DecisionsQueryService.deciderPushTarget`: still
  published, still demanding, the named membership still ACTIVE) bound at bootstrap — a
  stale claim re-targets to the current holder or drops with the recorded cancellation mark;
  `buildDispatchIntent` narrowing (roles ⊆ ceiling; the persisted intent carries the
  narrowed roles + target user).
- **ONE additive diagnostic-first migration** `20271015000000_phase6_t4b_decider`: the enum
  arms (`::text` comparisons only, so the transaction never consumes the values it adds), the
  §B.2 owned primitives, the §A.1 four-table `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE`
  serialization + the holderless AUDIT (aborts with a bounded sample; operator repair
  `docs/RUNBOOK.md §P6T4B` — withdraw-and-reissue or restore a covering membership, never
  inventing a holder), and the seal network (kind⟺status + swatch + record-approval-null
  CHECKs; the decision lifecycle seal with the recorded-birth author-authority arm
  (`phase6_user_decision_authority`), publication + reopen standing arms; the deferred
  two-door option floor; the widened published-parent option freeze; the change-request seal;
  the record delete seal; both membership guards; the project-org freeze) — all under the
  §B.1 try-readiness protocol.

## Pre-review checks (the template's five)

1. `pnpm check` — EXIT 0 (automation 292/292 incl. the pg-parse corpus advanced 91→92; web
   lint/typecheck/tests 952/952/build; api typecheck/tests 794/794/build).
2. Focused reproduce-first tests — `phase6-t4b-decider.test.ts` (integration, live PG: P16/
   P17/P18-ordering/P39 both layers + org + activation arms/P20/P21/P22 server halves) and
   `tests/decider.test.tsx` (web: the shared predicate, the selector mirrors, the decider
   route, the record-mode create, the drafts re-point affordance) — GREEN against this head;
   the behaviors are absent at the staged-red commit `52088062` by construction (the shape
   commit carries the columns and contracts with no service/seal behavior).
3. Full integration battery on a pristine migrated DB — see Gates below.
4. `scripts/upgrade-proof.sh` — the new 4b-decider stop: the legacy register (client-held
   published open decisions, no active client) makes the AUDIT abort naming §P6T4B; the
   sanctioned repair (re-activating the removed member as the covering client — the ordinary
   team command's effect) lets the same migration apply; then the precision arm (a coherent
   published record ACCEPTED) and the hostile arms (forged author, optioned record at commit,
   record transition/delete, last-holder soft-removal/re-role, the identity-freeze class)
   all hold. Every prior Phase-1..6 rejection survives.
5. Tripwires advanced IN THIS UNIT: mutating routes 168→170 (the draft PATCH + push unlink,
   signatures pinned), dispatch sites 81→82 (`decisions.updateDraft`), the decisions manifest
   commands/queries/routes + the shared contract, `orgs.workflowParticipants` gains
   `decisions` (module-registry pin), the push-consumer payload pin (`targetUserId`), the
   coverage-version preimage gains `pushFamily`, the policy matrix pins (approve ceiling +
   `decision.updateDraft`).

## Invariant matrix (six rows)

| Invariant | Where enforced | Proven by |
|---|---|---|
| A published open decision always has a CURRENT effective holder — no write may strand it, no publish may birth it holderless | the orgs command guards (`refuseHolderOrphan`, `guardedOrgStandingWrite`) + `Membership_t4b2_holder_guard`/`OrgMembership_t4b2_holder_guard` (decisions-owned predicates, §B.1 try-acquire) + the create/publish standing arms + the migration AUDIT | P39 probes (named + role arms, command AND direct SQL, org demotion, activation displacement, the draft non-blocking arm); the upgrade-proof audit abort→repair cycle |
| The holder is write-once FROM PUBLICATION; drafts edit freely through ONE door | `decisions.updateDraft` (unpublished CAS) + the publish row lock + the `20270826` attribution seal + the lifecycle seal | P17 probes (published re-point 409 at HTTP and refused at SQL; the stranded-draft recovery path names the door) |
| A record (`none` ⟺ `recorded`) is born terminal with EXACTLY ZERO options and approval-clean entry; published records are frozen and permanent | the zod refinements + `Decision_t4b2_kind_status_check`/`record_approval_null` + the deferred two-door option floor + the entry seal + the record delete seal | P16 probes (contract 400s; the planted-option commit refusal; plant-then-convert refused; freeze/delete refused; the coherent record accepted) |
| The pending audience IS the decider's: no leak to a same-role non-decider or the non-deciding client, no hidden action item — live, projected, belled, counted, routed | the ONE shared `viewerIsDecider` in `decisionVisibleToViewer` + the projection filter + the snapshot notice rule + viewer-scoped `countPending` + the web mirrors + `withDeciderRoute` | P22 probes (server slice + projection dto + bell + counts, decider vs same-role vs client) and the web decider suite |
| A targeted "decide this" push reaches ONLY currently-valid links of the CURRENT holder, and never a displaced/revoked/settled one | the persisted narrowed intent + `notifyTargetedUser` (link expiry + `sessionStillValid`) + the claim-time `deciderPushTarget` re-judgement + the 4a cancellation mark | P21 server probes (intent target; actionable→approved drop; role/record claims) + the push unit tests |
| Pre-4b behaviour is byte-identical for every existing caller | the `client` default (contract + column), the omitted-field create path, the unchanged 4a seals (`20270810`/`20270826` byte-for-byte) | the retained 4a/attribution suites; the upgrade-proof legacy assertions (client backfill, no invented approvals, every prior rejection surviving) |

## Gates

- `pnpm check` EXIT 0 — automation 292/292; web 952/952 (lint+typecheck+build clean); API
  794/794 (typecheck+build clean).
- Full integration battery on a pristine migrated database (92 migrations): **99 files /
  1299 tests, exit 0** — includes the new `phase6-t4b-decider.test.ts` (16 probes) and the
  repaired fixtures (re-ordered creates, sanctioned option-freeze bypass, covering client
  memberships for projects that publish client-held decisions).
- `scripts/upgrade-proof.sh` PASSED end-to-end, including the new 4b-decider stop (audit
  abort → §P6T4B repair → apply → precision + hostile arms).
- `test:e2e:api:allmodules` **38/38** and `test:e2e:api:outbox` **32/32** over the reseeded
  demo register (the seed itself now follows the RE-ORDERED create, and the reopened DL-003
  carries the two-option frozen question a published choice must hold; one earlier run
  flaked on the documented `daily-log-lost-response`/`daily-log-module-query` timing steps —
  clean on re-run, no 4b surface).
- Route-policy, module-registry, boundary, cross-module-graph tripwires GREEN at the new
  pins.

## Deferred by name (not this unit)

- 4c/4d remain unstarted per the owner's direction; `architect` joins the decider enum IN 4d
  with the role; the 4d forward is the re-homing door for an approved decision (the 409s
  name it).
- The mobile/web push SERVICE-WORKER surface consumes the targeted payload unchanged; only
  delivery targeting changed server-side.
- Contractor-capture units 1–6 stay behind the standing Board gate
  (`contractor-capture-units-1-6-board-go`); nothing here touches them.

## Round-1 correction (the Codex review of head `f99634f4` — eight findings, ONE fix-forward head)

Every finding was read and batched before any push; each carries its fix and its probe. The
`20271015` migration is EDITED in place (this branch's own unmerged migration — the test DB is
rebuilt and the upgrade proof re-run over the edited body); `20270810`/`20270826` stay
byte-for-byte unchanged.

- **F3 (P1, migration INSERT arm)** — a row born ALREADY PUBLISHED is now judged by the SAME
  holder arms as the publication boundary, under §B.1: the readiness key serializes against a
  concurrent membership write, a member holder must be ACTIVE, and a role-held OPEN row
  (`pending`/`change`) must have effective standing; a settled `approved` import carries no
  open obligation and the role arm deliberately skips it, and an UNPUBLISHED draft insert
  stays free. Probe `R1-F3` (RED at `f99634f4`: the hostile insert died only later, at the
  option floor with the wrong message; GREEN: refused at the boundary with the holder answer).
- **F8 (P1, recorded entry)** — EVERY transition entering `recorded` re-runs the AUTHOR-
  authority check the birth door runs (the frozen author's name enters the permanent register
  at that moment), and `updateDraft` refuses the conversion with a deliberate 409 naming the
  reason before the seal backstops it. Probe `R1-F8` (RED: the hostile conversion committed;
  GREEN: 409 at the command + refusal at the seal + the precision arm converting cleanly once
  standing is restored).
- **F5 (P1, role-held decider pushes)** — a decider-family ROLE claim now resolves the role's
  CURRENT effective holders through the orgs-owned `effectiveRoleHolderUserIds` (active
  memberships + the membership-less org owner/admin pmc arm under the explicit-membership
  precedence) and delivers ONLY to their currently-valid links; the stored-subscription-role
  broadcast path is gone for the family, so a removed member's device receives nothing.
  Pinned by the consumer unit probe in `outbox.test.ts`.
- **F4 (P1, boundary)** — the subscribe-attribution identity check routes through the
  orgs-owned `resolveUserIdentity`; `PushService` no longer reads the `User` table. Unit
  probes in `push.service.test.ts`.
- **F1 (P2, sign-out handoff)** — the server clears a push link ONLY when it still belongs to
  the authenticated caller (`unlink(endpoint, callerUserId)`), so user A's delayed sign-out
  request can never strip user B's re-attributed link; on a push-capable browser the handoff
  additionally WAITS (bounded, 1.5s) for the unlink before the teardown, while every other
  environment stays synchronous. Unit probes in `push.service.test.ts`.
- **F2 (P1, web log)** — the register renders a RECORD as a filed fact (its own branch: no
  approver, no options arithmetic, no approval demand, the RECORDED label) instead of leaking
  the approved shape (`Ageing undefined`, `-Infinity`). Probe in `tests/decider.test.tsx`.
- **F6 (P2, drafts conversion)** — converting a record draft back to a choice opens an inline
  2–4-option form and submits kind + options (lead swatch included) in ONE `updateDraft`;
  a bare kind change is never dispatched. Probe in `tests/decider.test.tsx`.
- **F7 (P2, decider deep link)** — the `/client/decisions` route is judged only against a
  SETTLED decision slice (in-flight and authed-pre-fetch states hold the route, mirroring the
  capability branch's unknown-state posture), so a named decider's bookmarked approval link
  survives a cold load; a settled non-decider is still bounced. Probes in
  `tests/routeBridge.test.tsx`.

Gates re-run at the correction head: `pnpm check` EXIT 0 (automation 292/292; web 956/956;
api 796/796); full integration battery on a rebuilt pristine DB (totals in the PR thread);
`upgrade-proof.sh` re-run end-to-end over the EDITED `20271015`; `test:e2e:api:allmodules` +
`:outbox`.
