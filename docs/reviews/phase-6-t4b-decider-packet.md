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
api 796/796); full integration battery on a rebuilt pristine DB **99 files / 1302 tests,
exit 0** (the F5 targeted delivery re-characterized in `phase2-consequences`);
`upgrade-proof.sh` re-run end-to-end over the EDITED `20271015` (PASSED);
`test:e2e:api:allmodules` 38/38 + `:outbox` 32/32.

## Replacement round (the Codex review of head `35157acc` — three findings; #463 closed at the two-head limit)

Head `35157acc` was the SECOND finding-bearing head, so per the review-efficiency protocol #463
closes unmerged and this REPLACEMENT PR (branch `claude/decision-workflow-4b-r2`, `Replaces:
#463`) carries the whole unit — every prior decision preserved — plus ONLY these three fixes:

- **R2-F1 (P1, previous-release compatibility)** — a browser tab still running the PRE-4b
  bundle crashes on a `recorded` row (its four-entry chip map dereferences the unknown status).
  The server-process side is excluded by the §P6-4a drain-first deploy, but tabs cannot be
  drained, so the version boundary is a REQUEST CONTRACT: the 4b web bundle declares
  `X-Vitan-Decisions-Contract: recorded-v1` on every call and receives the full register; a
  request without the declaration has `recorded` rows stripped from any `decisions` array at
  the transport layer (`RecordedCompatInterceptor` in `app-setup` — no service or serializer
  carries the compat branch; a record demands nothing, so a stale bundle loses no actionable
  state and picks the records up on its next full load). The CURRENT bundle's `DecisionChip`
  also gains an unknown-status fallback so the NEXT status addition cannot re-open the class.
  Probe `R2-F1` (aware request receives the record; headerless request never does; every other
  row byte-identical).
- **R2-F2 (P2, decider deep link under a failed module read)** — in module-read mode the
  decisions request can fail independently while the snapshot lands (`projectLoadState:
  'ready'` + `decisionsLoad: 'error'`), and the settle predicate treated that as a settled
  slice. It now consults the slice's OWN health (`decisionsLoad` must be `idle`/`ready`), so
  the bookmarked route holds until Retry resolves the read. Probe in
  `tests/routeBridge.test.tsx` (error holds; a successful retry proving the decider keeps the
  route).
- **R2-F3 (P2, readiness responsibility text)** — the decision gate's waiting texts hard-wired
  the client; a pmc- or member-held decision directed site users at the wrong party. The
  decider designation now rides the readiness input end-to-end (`statusAndDraftMap/Of` +
  `snapshotSlice` carry `deciders`; the activities bake and the in-tx `start` read pass it;
  the shared `deciderNoun` derives the text). The client-held texts stay BYTE-IDENTICAL (the
  legacy backfill default). Probes in `src/domain/readiness.test.ts` (per-kind texts; verdicts
  untouched; the omitted-kind backfill).

No migration change in this round — `20271015` is byte-for-byte the round-1 body; the
replacement's migration story is unchanged from the packet above.

## Round-3 correction (the Codex review of head `a13c3454` — four findings, ONE fix-forward head)

Codex attempt 1/2 on the replacement head returned four P2 findings. Each was reproduced RED at
`a13c3454` first (probe names below), then fixed forward as one batch; every prior decision is
preserved and `20271015` is byte-for-byte unchanged.

- **R3-F1 (P2, PMC-held decisions in the action queue)** — `selectActionItems` guarded the
  decider items behind `role !== 'pmc'`, so a pmc-held decision produced no approval task for
  the signed-in PMC while the management summary described ALL pending rows as "awaiting the
  client". The decider filtering now applies to EVERY role (a pmc-held pending/change row is
  the PMC's own `decider-pending`/`decider-reapprove` item at the approval surface), and the
  PMC management summaries (`pmc-pending`/`pmc-change`) cover ONLY decisions held by OTHER
  deciders, with the "awaiting" text naming the client only when every other-held row is
  client-held (the pre-4b world stays byte-identical — the seeded e2e assertion is untouched).
  Probe: `tests/actionQueue.test.ts` "pmc as DECIDER" (RED at `a13c3454`).
- **R3-F2 (P2, archived-project decider push)** — archival keeps a decision pending and its
  memberships intact, so the claim-time predicate still reported a queued `decision.published`
  delivery actionable and the consumer sent a demand `ProjectAccessService.authorize` would
  refuse to open. `deciderPushTarget` now asks the ORGS-owned operability question first
  (`OrgsParticipant.isProjectOperable`, the declared decisions → orgs participant edge — the
  same answer the commercial activation guard uses): a non-operable project drops the claim
  (the delivery cancels with the 4a cancellation mark, never a dead-end push). Probe: `R3-F2`
  in `phase6-t4b-decider.test.ts` (archived → not actionable; un-archived → restored).
- **R3-F3 (P2, record→choice conversion validation)** — a PATCH like `{deciderKind:'client'}`
  on a record draft passed the contract, and the service then flipped the row to
  `pending`/client with its record-era `photoSwatch` still NULL — the `Decision_t4b2_swatch_check`
  aborted the transaction as an uncaught 500. The conversion is now refused DELIBERATELY at
  both layers: the service (which knows the draft's CURRENT kind) returns 400 when converting
  `none` to a choice without a 2–4 option payload, and the contract gains the two refinements
  it can state without the current kind (a record edit never carries options; a choice kind
  edited together with an options payload carries the full 2–4). Probe: `R3-F3` (bare
  conversion 400; explicit-empty 400; optioned-`none` 400; the same conversion with its 2–4
  options lands with the lead swatch installed).
- **R3-F4 (P2, readiness acquisition for unpublished record writes)** — the lifecycle seal's
  recorded-birth arm fires on EVERY record INSERT and its conversion arm on every entry into
  `recorded`, but the service held the readiness key only when publishing: a concurrent key
  holder (an activity start, a membership command) made the trigger's `phase6_try_readiness`
  fail an otherwise valid unpublished record create or draft→record conversion. Both doors now
  acquire `lockProjectReadiness` (first statement of the command transaction, the uniform §B.1
  order), so they SERIALIZE instead of failing spuriously; the two record-arm writes join the
  §A lock-coverage enumeration (`readiness-lock-coverage.test.ts`, 38 → 40). Probe: `R3-F4` —
  a second session holds the key, the command is proven BLOCKED (never a seal failure), the
  release lands it (both doors).

No migration change in this round — `20271015` remains the round-1 body. Gates for this head:
`pnpm check` EXIT 0; the full integration battery on a pristine migrated DB (the t4b suite is
now 22 probes); `test:e2e:api:allmodules` and `:outbox` both green (totals in the PR thread).

## Round-4 correction (the Codex review of head `8e69603b` — three findings; #464 closed at the two-head limit)

Head `8e69603b` was PR #464's SECOND finding-bearing head, so per the review-efficiency protocol
#464 closes unmerged and this SECOND REPLACEMENT PR (branch `claude/decision-workflow-4b-r3`,
`Replaces: #464`) carries the whole unit — every decision from all prior rounds preserved — plus
ONLY these three fixes, each reproduced RED at the carried `8e69603b` state first:

- **R4-F1 (P2, stale-read conversion state)** — `updateDraft` derived `nextKind` and the
  conversion checks from the pre-transaction row while its CAS checked only `publishedAt`, so two
  overlapping valid PATCHes could interleave: A converts a choice draft to a record
  (`options: []`); B, judged against its stale choice read, re-points the now-record to a choice
  kind, skipping the record→choice option validation and aborting on the swatch CHECK as an
  internal error. The transaction now takes the readiness key unconditionally (whether the edit
  ENTERS `recorded` is only knowable from the row's current kind, which is only knowable under
  the row lock — and the key must precede row locks in the §B.1 order), LOCKS the draft row, and
  derives kind/status and every conversion check from the locked truth. Probe: `R4-F1` — the
  exact interleaving is orchestrated deterministically (session A holds the row through the
  conversion while B performs its stale read, condition-based blocked-backend barrier, no fixed
  sleeps); B now receives the same deliberate 400 as the sequential door, and the record is
  untouched.
- **R4-F2 (P1, TRUNCATE seal gap)** — a published record is declared permanent, but TRUNCATE
  fires no row triggers and the 20270826 statement seal (`decision_t4b_no_truncate`) predates
  the `recorded` status: on a register holding records but no approval evidence,
  `TRUNCATE "Decision" CASCADE` passed it and erased every permanent record. The NAMED seal's
  body is WIDENED in this unit's own `20271015` migration (a `CREATE OR REPLACE` — the frozen
  `20270826` is untouched byte-for-byte, the trigger object keeps its name so the sanctioned
  reset paths that disable it by name are unaffected; an unpublished draft record blocks
  nothing). Probes: the deployed-body pin (`R4-F2` in the decider suite) and the behavioural
  proof in `upgrade-proof.sh` — a SECOND fully-migrated row-free scratch database holding ONE
  legally-born published record and no approval evidence (so the old arms cannot mask the gap)
  refuses `TRUNCATE "Decision" CASCADE` with the widened arm's message, and the record survives.
- **R4-F3 (P1, pre-4b bundle push linkage)** — a cached pre-4b bundle's authenticated
  subscribe also carries `user.exp`, so the endpoint was linked to the user even though that
  bundle has no `/push/unlink` in its sign-out: on a shared browser the departing user's link
  stayed valid until JWT expiry, exposing named-decider titles to the next person. User linkage
  is now gated on the SAME version boundary the recorded-compat interceptor reads — the 4b
  bundle declares `X-Vitan-Decisions-Contract` on every request (the gateway attaches it
  unconditionally, subscribe included), while an undeclared authenticated subscribe stores the
  subscription UNLINKED (byte-identical to the pre-4b server) and, because a link-less upsert
  clears the stored attribution, it also SEVERS any lingering link an earlier 4b session left
  on that browser. Probe: `R4-F3` (declared subscribe links; undeclared re-subscribe unlinks
  and keeps role-level delivery).

Migration story: `20270810`/`20270826` remain byte-for-byte unchanged; `20271015` (this unit's
own, unmerged anywhere) gains the widened truncate-seal body, re-proven by a full test-database
rebuild + the extended `upgrade-proof.sh` records-only register cycle. The two record-arm
decision writes remain pinned in the §A lock-coverage enumeration (40).

## Round-5 correction (the Codex review of PR #465 head `f49a0547` — six findings, ONE fix-forward head)

Codex attempt 1/2 on the second replacement's first head returned six findings (one P1). Each
was reproduced RED at `f49a0547` first (the one non-pausable interleaving is pinned
structurally and stated so), then fixed forward as one batch. `20270810`/`20270826` remain
byte-for-byte; `20271015` (this unit's own) gains the option truncate seal below, re-proven by
a full test-database rebuild + the extended upgrade-proof.

- **R5-F1 (P2, claim-predicate atomicity)** — `deciderPushTarget` ran `isProjectOperable` on
  the pooled client, releasing its `FOR UPDATE` at statement end, so an archival committing
  between the operability answer and the decision read still dispatched the dead-end push. The
  whole predicate now runs in ONE `$transaction`: the project-row lock the orgs answer takes is
  held until the decision read has happened, so an archival either happened before (seen —
  dropped) or waits for the claim's commit. The interleaving window cannot be paused from
  outside the service, so the probe is the behavioural arm (R3-F2: archived → dropped) plus a
  STRUCTURAL pin (`R5-F1`) that the predicate's reads share one transaction and none escapes to
  the pooled client.
- **R5-F2 (P2, register attribution)** — a published pending row held by `pmc` or a named
  member still read "awaiting client", directing its own decider at the wrong party. The
  attribution and the change-request re-approval line now derive from the shared `deciderNoun`
  ("awaiting the PMC" / "awaiting the named decider’s re-approval"); the client-held texts stay
  byte-identical. Probe: `R5-F2` in `tests/decider.test.tsx`.
- **R5-F3 (P2, conversion member picker)** — converting a record to `member` silently stored
  `memberCandidates[0]` because the member picker rendered only for a persisted member-held
  row. The picker now renders from the CONVERSION FORM's kind and binds the form's
  `membershipId`, so Confirm assigns the chosen member. Probe: `R5-F3` (default visible, chosen
  member submitted).
- **R5-F4 (P2, conversion vs publish race)** — Confirm closed the form before the PATCH
  resolved while Publish stayed enabled; a publish winning the server lock permanently
  published the row as a record and the conversion then 409ed against the user's confirmed
  choice. `updateDecisionDraft` (via `runRemote`) now resolves a settle boolean; the form stays
  OPEN and the draft's Publish (and Publish-all) are HELD until the server accepts the edit — a
  failed PATCH leaves the form for retry. Probes: `R5-F4` ×2 (held-then-released on success;
  retained on failure).
- **R5-F5 (P1, DecisionOption TRUNCATE seal)** — the option freeze is row-level only, so
  `TRUNCATE "DecisionOption" CASCADE` could erase every option while published `Decision` rows
  stood (choice decisions with zero options; the frozen question destroyed). `20271015` now
  installs the statement-level `DecisionOption_t4b2_no_truncate` (refuses while any option
  belongs to a PUBLISHED parent; drafts-only tables truncate freely; the sanctioned resets
  disable it BY NAME — the event-catalog destructive reset gains exactly that pair). Probes:
  the deployed trigger+body pin (`R5-F5`) and the upgrade-proof behavioural cycle — the
  records-only scratch register gains one legally published pmc-held choice with 2 options, and
  the hostile TRUNCATE is refused by the new seal with both options surviving (the 4a touch
  seal guards only same-transaction touches, so the refusal is attributable).
- **R5-F6 (P2, options-only record edit)** — a PATCH carrying ONLY a nonempty `options` array
  on a record draft passes the contract (`deciderKind` omitted) and previously died inside the
  transaction (observed at the reviewed head as a misleading empty-CAS 409; the seal abort
  Codex named is the same class). The service now refuses ANY nonempty options payload whose
  RESULTING kind is a record — a deliberate 400 from the locked-row derivation. Probe: `R5-F6`
  (record refused + untouched; a choice draft's options-only replace still lands).

## Round-6 correction (the Codex review of PR #465 head `d64ccc5a` — six findings; #465 closed at the two-head limit)

Head `d64ccc5a` was PR #465's SECOND finding-bearing head, so per the review-efficiency protocol
#465 closes unmerged and this THIRD REPLACEMENT PR (branch `claude/decision-workflow-4b-r4`,
`Replaces: #465`) carries the whole unit — every decision from all prior rounds preserved — plus
ONLY these six fixes, each reproduced RED at the carried `d64ccc5a` state first:

- **R6-F1 (P2, direct draft edits vs publish)** — the round-5 hold covered only the conversion
  Confirm; the DIRECT selector branches (choice→record conversion, kind changes, member
  re-points) still dispatched `updateDecisionDraft` without pending state, so a publish could
  win the server lock and permanently publish the OLD kind/holder. EVERY draft edit now rides
  ONE dispatch door (`dispatchDraftUpdate`: pending → await settle → release) that holds the
  draft's Publish, Publish-all, and the selectors themselves. Probes: `R6-F1` ×2 (direct
  conversion; member re-point).
- **R6-F2 (P2, org-member upsert)** — `addOrgMember`'s upsert UPDATE arm could demote an
  owner/admin without the holder guard: an orphaning re-add died as an unhandled trigger error,
  and even a benign one never took the readiness keys first. The upsert now computes `reduces`
  from the target's existing org role and rides `guardedOrgStandingWrite` exactly like
  `updateOrgMemberRole`/`removeOrgMember`. Probe: `R6-F2` (covered-admin re-add at a lower role
  → deliberate 409, row untouched; same-role re-add lands; release → the demotion lands).
- **R6-F3 (P1, OrgMembership TRUNCATE seal)** — unlike `Membership`, `OrgMembership` has no
  inbound decision FK to cascade through an existing seal, so `TRUNCATE "OrgMembership"` could
  strip a membership-less org owner/admin who is the ONLY effective PMC cover for a pmc-held
  published open decision. `20271015` installs the statement-level
  `OrgMembership_t4b2_no_truncate` (refuses while any published open pmc-held decision's
  project has no active explicit pmc membership — exactly the org-only-covered registers).
  Probes: the deployed trigger+body pin (`R6-F3`) and the upgrade-proof org-only-covered cycle
  (a second project whose pmc standing rests solely on the org owner's arm; the hostile
  TRUNCATE refused, the covering row surviving).
- **R6-F4 (P2, snapshot-mode decider deep link)** — a cold `/client/decisions` load whose
  snapshot FAILS reached `projectLoadState: 'error'` with an empty slice, which the settle
  predicate treated as judged — redirecting the bookmarked approval route away before Retry
  could recover it. A project-level error is now UNSETTLED exactly like the module-read error:
  the route holds until a decision-bearing read succeeds. Probe: `R6-F4` in
  `tests/routeBridge.test.tsx` (held through error, judged on ready).
- **R6-F5 (P2, Publish-all readiness)** — the batch ignored per-decision readiness, so it
  could 409 mid-way and publish a partial set from an action labelled as publishing
  everything. The ONE per-draft readiness rule (`decisionReady`) now feeds both the per-row
  button and the batch. Probe: `R6-F5` (an unready draft disables both).
- **R6-F6 (P2, undeclared platform→orgs edge)** — `PushService` (platform) calls the
  orgs-owned `OrgsParticipant` while `platformManifest` declared no edges and the registry
  pinned that false graph. The platform → orgs workflowParticipants edge is now DECLARED and
  the registry pin carries it (`dependsOn` stays empty — the kernel owns no domain logic).
  Probe: the registry pin itself (RED at the carried state with the manifest undeclared).

Migration story: `20270810`/`20270826` remain byte-for-byte unchanged; `20271015` (this unit's
own, unmerged anywhere) gains the OrgMembership truncate seal, re-proven by a full
test-database rebuild + the extended upgrade-proof. No sanctioned reset truncates
`OrgMembership` (all row-level deletes), so no reset path needed the new disable pair.
