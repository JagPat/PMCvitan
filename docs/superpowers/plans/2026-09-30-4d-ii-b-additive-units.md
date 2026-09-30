# 4d-ii-b — the additive staging (B1 … B6) and the inventory-to-unit map

Staging record of 2026-09-30, opened by the autonomous runner at the handoff after #675 and #676:
4d-ii-b, the CLIENT unit of Phase 6 task 4d, is delivered as additive units under this record, as
4d-i-b (`2026-09-21-4d-i-b-additive-units.md`) and 4d-ii-a (`2026-09-26-4d-ii-a-additive-units.md`)
were, rather than as the one `justified-large` PR that §D of `2026-09-07-decision-workflow-4d.md`
stages. STATUS records the staging as the owner's disposition; this record is that disposition's
vehicle. Merging it records the additive staging; closing it, or a coordination note on #482
choosing §D's single unit, reverses it before any B-unit opens. Either way the content is §D's.

This document changes **how 4d-ii-b is staged, not what it contains**. Every item of §D's 4d-ii-b
inventory (plan lines 7278–7297) maps to exactly one unit below; §A remains the specification for
each item. 4d-ii-a is complete on `main` (A8b merged as #673, `f8274f4`), the drain attestation and
4d-iii are unchanged, and the drain's minimum release stays the release carrying A8b.

## Why additive, and what the gap map found

A gap map of the inventory against `main` at `4f24a24` (#675) found almost none of the client unit
built. In `apps/web/src`:

- the gateway's `req()` declares `X-Vitan-Decisions-Contract: recorded-v1` (`apiGateway.ts:775`),
  and the direct `fetch('/auth/session')` in `ApiGateway.connect()` (`:503`) declares nothing;
  no test enumerates the gateway's `fetch(` sites (there are three — `:503` and `:768` are API-bound,
  `:1264` is a presigned object-storage PUT that must not carry the header);
- nothing reads the shell's `rollout.phase6_4d`; the web `ProjectShell` type has no `rollout` field
  and `loadShell` stores only `enabledModules` and the capabilities;
- `architect` is absent from the Team screen's `ROLES`/`ROLE_LABEL`, the Portfolio `ROLE_LABEL`, the
  Drawings `ROLE_SHORT`, both decider pickers and the gateway's `deciderKind` input types; the
  persona is parked in `PERSONAS_OWED` with `screensFor.architect = []`, and `applyAuthResult` would
  land an architect sign-in on an undefined screen;
- `selectActionItems` derives decision work from `pending` and `change` only; the audience mirrors
  show an `awaiting_countersign` row to every role; `locationTree`'s `STATUS_LABEL` and `rank`, the
  Decision Log's `STATUS_FILTERS` and rollup chips lack the value; the shell badge is computed
  locally and never renders `counts.pendingDecisions`;
- `countersignRequired` and `changeRequest.origin` are declared in the shared type and read nowhere;
  the approval modal and the success copy say "Approved & locked" unconditionally; the Withdraw
  affordance ignores `origin`; the consultation surface's open set lacks `awaiting_countersign` and
  never loads the roster itself;
- no client call exists for `decisions.forward`, `decisions.countersign`, `decisions.disagree` or
  `decisions.resolveStrandedCountersign`; no outbox op, no store action, no control;
- the three member commands are sent without an `Idempotency-Key` (the server synthesizes one per
  call, so a retry after a lost response can run twice).

Two API tests already pin what the client owes and refuse silence about it:
`apps/api/src/domain/decision-status-tripwire.test.ts` (registrations marked "owed by 4d-ii-b" for
`locationTree`, the Decision Log's filters and counts, and every web status predicate) and
`apps/api/src/common/role-vocabulary-tripwire.test.ts` (the four web role lists/maps and the
`PERSONAS_OWED` pin). A unit that changes a pinned predicate re-registers it with a verdict in the
same change; that is a test edit in `apps/api`, not a server change.

§D itself expects the unit to exceed the standard budget ("declares the marker its size warrants —
`justified-large` … if it exceeds the budget"). The additive split keeps every unit inside the
standard budget with one concern each, so each gets a full exact-head review, and a finding on one
surface does not hold the others.

## Why each unit is safe on its own

4d-ii-b was specified to land while the six reservation doors stand ("its browser proofs driven
against the 4d-ii-a server with the doors still standing — the boundary probed BEFORE the role is
enabled"). Every unit below keeps that property:

- **The contract declaration is admitted today.** The delivered 4b interceptor passes any non-empty
  header; the 4d-ii-a interceptor serves a `countersign-v1` client everything untouched and strips
  or refuses only shapes no row can carry while the doors stand. A tab declaring `countersign-v1`
  against the current server behaves byte-identically to one declaring `recorded-v1`.
- **The rollout read stays `'reserved'`** until 4d-iii retires the doors, so every affordance the
  units gate on `rollout.phase6_4d === 'open'` (the Team pickers' `architect` option, the decider
  pickers' `architect` designation, the Forward affordance) renders nothing new.
- **The readers meet no rows.** No decision can be `awaiting_countersign`, no membership `architect`,
  no change request non-`standard`; the new branches are exercised by unit tests on planted DTOs and
  by the server's own refusals, and are inert on live data.
- **The commands are refused before any write.** Forward, countersign, disagree and stranded all
  409 while reserved; the client surfaces those refusals honestly and renders their controls only for
  states that cannot exist. Nothing a unit adds is reachable by delivered traffic.
- **No unit ships a migration or a server runtime change.** The only `apps/api` edits are the two
  tripwire tests' registrations moving from "owed" to registered with a verdict.

## The inventory-to-unit map

Line figures are estimates from the gap map; the standard budget is 20 files / 1,500 changed lines.

| § D inventory item | Unit |
| --- | --- |
| the web gateway declaring `countersign-v1` on every API-bound request, with the client-boundary `fetch(` tripwire | B1 |
| the store's handling of the additive fields (`countersignRequired`, `changeRequest.origin`, the awaiting status) and the shell's `rollout.phase6_4d` read | B1 |
| the web role fan-out: the role lists, the decider picker's `architect` designation and the Team role pickers following `rollout.phase6_4d` | B2 |
| the architect persona (`PERSONAS_OWED` emptied; `screensFor.architect`; the sign-in landing) | B2 |
| the Inbox `awaiting_countersign` branch (the architect's item, the PMC's summary, the PMC's stranded item) and the reader enumeration's web arms under the shared status tripwire | B3 |
| the shell badge rendering `countPending`'s count | B3 |
| the approval confirmation copy reading `countersignRequired` and the success copy following the returned status | B4 |
| the roster on the consultation surface (the open set widened; the roster loaded) | B4 |
| the Withdraw affordance suppressed on a `countersign_rejection` request; the rejection request rendered with its origin and impacts | B4 |
| the four commands on the client — gateway, outbox ops and replay, write-ahead store actions with idempotency keys | B5a |
| the Forward affordance following `rollout.phase6_4d`; the architect's Decision Log controls (Countersign / Reject back / Forward on); the PMC's stranded resolution | B5b |
| the `DecisionForward` DTO — served only if a unit renders forward history; otherwise none, and the completeness tripwire's "owed" entry is closed as not served | B5b |
| the client `Idempotency-Key` on `members.add` / `members.updateRole` / `members.remove` (plan lines 3108–3116: "the client key ships in the CLIENT unit 4d-ii-b") | B6 |
| the web arms of P28b, P29c, P30, P31, P33 and P34 | each with the unit that owns the surface — see the units |
| the STATUS fold setting `blocking_directive: phase-6-4d-previous-release-drained` | the post-merge STATUS record of the LAST unit to merge |

### B1 — the client boundary and the rollout read

The gateway declares `X-Vitan-Decisions-Contract: countersign-v1` on `req()` and on the
`connect()` fetch; the presigned upload PUT stays bare. A client-boundary tripwire test enumerates
every `fetch(` site in `apiGateway.ts` from source and asserts the header on each API-bound one by
capturing the request (the `dev-auth-identity` harness's `vi.stubGlobal('fetch', …)` pattern),
refusing a new site that is neither declared API-bound nor exempted. The web `ProjectShell` type
gains `rollout: { phase6_4d: 'reserved' | 'open' }` (mirroring `ProjectShellDto`), `loadShell` stores
it, and the store exposes one selector every later gate reads; the value is `'reserved'` until a shell
read says otherwise, never assumed open. The shared `Decision` fields already declared
(`countersignRequired?`, `changeRequest.origin?`) are read through the store untouched (they are
today) and pinned by a test that plants them and reads them back.

Web arm of P29c: the declaration on every API-bound site (the strip/refuse classifications
themselves are the server's, exercised by `countersign-compat.test.ts`). Proof against the reserved
server: a Playwright spec asserts every API request the app makes carries the header and that the
shell read lands `rollout.phase6_4d = 'reserved'`. ~150 lines, standard.

### B2 — the role fan-out and the architect persona

`architect` joins the Team screen's `ROLES`/`ROLE_LABEL`, the Portfolio `ROLE_LABEL` and the
Drawings `ROLE_SHORT`; the Team pickers (`member-role`, `member-role-<userId>`) OFFER it only when
`rollout.phase6_4d === 'open'` (rendering an existing architect member's row either way). Both
decider pickers (`IssueDecisionModal`, `DraftsScreen`) and the gateway's `deciderKind` input types
gain the `architect` designation under the same gate. `PERSONAS_OWED` is emptied, `screensFor.architect`
gets the role's screens from its `ROLE_POLICY` rows (the Inbox, the Decision Log, Drawings, Places,
the consultation surface), and `applyAuthResult`/`setRole`/`localEmailSignIn` refuse to land on an
undefined screen. **Every consumer of the derived `ROLES` list is under the same gate**, not only the
Team pickers: emptying `PERSONAS_OWED` adds `architect` to `ROLES` globally, and both persona
switchers render that list unconditionally today — the desktop `RolePicker` and the mobile `TopBar`
switcher under `DEV_AUTH` — so B2 replaces the static list with one rollout-aware selector (the
`ROLES` for the shell's current `rollout.phase6_4d`) that every switcher and picker reads, and no
switcher offers `architect` while the shell reads `'reserved'` (#677 review, finding 4145060015). The
role-vocabulary tripwire's four owed registrations and the persona pin move to registered, in the same
change.

Web arms of P28 (the web role lists and pickers) and P28b/P34 (the pickers follow the ONE shell
read): unit tests render each picker AND each persona switcher under `'reserved'` and `'open'`; a
Playwright spec against the reserved server asserts no picker or switcher offers `architect`.
~250 lines, standard.

### B3 — the readers, the Inbox branch and the badge

`selectActionItems` gains the `awaiting_countersign` branch §A.2 specifies (plan lines 3409–3416):
the active architect's "N decision(s) awaiting your countersign", the PMC's "awaiting the architect's
countersign" summary, and the PMC's stranded-resolution item when the chain is inactive (the client
reads chain activity the way the DTO exposes it — `countersignRequired` on the pending rows — and
never invents an active chain). The audience mirrors (`selectLogDecisions`, `selectVisibleDecisions`)
admit an awaiting row to the PMC, the architect, the decider and a standing consultee only, matching
`decisionVisibleToViewer`. **The approval route stays limited to actionable states**: `RouteBridge`'s
decider-route set, which gates the `client-decisions` approval screen, keeps its `pending`/`change`
condition — an awaiting decision is not one its decider can approve, and admitting it would deep-link a
named non-client decider to an empty approval screen (#677 review, finding 4145060024); awaiting rows
are read on the Decision Log and through the visibility selectors, and the architect acts on them
through B5b's controls, not the approval route. Its tripwire predicate is re-registered with that
verdict. `locationTree`'s `STATUS_LABEL` and
`rank`, the Decision Log's `STATUS_FILTERS` and rollup chips, and `StatusChip` answer the value. The
shell badge renders `counts.pendingDecisions` (the server's `countPending`, which carries the
architect and stranded arms) where the web computes a local count today, with the local derivation
kept as the offline fallback. Every status predicate the tripwire pins is re-registered with its
verdict.

Web arm of P31 (the reader tripwire, the Inbox item and badge). Unit tests plant awaiting rows per
role; a Playwright spec against the reserved server asserts the badge equals the shell count.
~300 lines, standard.

**As built (the B3 unit).** The badge arm lands as the web arm of `countPending`'s two 4d arms, derived
LIVE from the served rows, not as a render of the shell's `counts.pendingDecisions`: the Decision Log
nav badge carries `selectCountersignObligations` — the architect's awaiting rows, the PMC's STRANDED ones
(`isStrandedCountersign`: an awaiting row served WITHOUT the `countersignRequired` overlay, which the
server applies to every row it serves while the kernel register reads an active architect, so the
chain's activity is read per row exactly as the DTO exposes it and never invented) — and the approval
badge keeps round-7 F5's combined pending + re-approval count. Rendering the shell count instead would
have regressed two delivered rules: `countPending`'s PMC arm counts EVERY pending decision (the Portfolio
tile's management count), which since 4b round-3 F1 is not the PMC's badge, and the server count omits
the re-approvals F5 requires the approval badge to carry; and a point-in-time shell read would go stale
after every write-ahead approval where the local derivation clears at once. The Playwright spec therefore
pins the RELATION rather than an equality: for the seeded client the approval badge equals the shell's
`counts.pendingDecisions` plus the client's re-approvals, and the Decision Log badge (the countersign
arms) is absent with no awaiting row. The Inbox items are `arch-countersign` (amber), `pmc-stranded`
(red, before the summary) and `pmc-countersign` (ink), all pointed at the Decision Log; the register's
`STATUS_FILTERS` gained the `recorded` chip too, so the set answers every status; the row renders a
provisional approval with its attribution ("Approved by … — awaiting the architect's countersign"),
no lock, and the tag PROVISIONAL; the audience mirrors share one `openDemandVisible` rule (pending and
awaiting: the architect, the decider, a standing consultee). The consultation surface's open-set
predicate stays registered as owed by B4.

### B4 — the copy, the consultation surface and the withdraw rule

`ApproveModal` reads `countersignRequired` and says "Will be sent to the architect for countersign"
instead of "Will be locked"; `confirmApprove`'s success copy follows the approved decision's status in
the RETURNED snapshot ("Approved — awaiting the architect's countersign" for `awaiting_countersign`,
the delivered copy for `approved`), which needs `runRemote` to let a command derive its message from
the accepted snapshot rather than a fixed string. `ConsultationThread`'s open set gains
`awaiting_countersign` (mirroring `CONSULTATION_OPEN_STATUSES`) and loads the roster when `members`
is empty, as `IssueDecisionModal` does. `mayWithdraw` is suppressed when
`changeRequest.origin === 'countersign_rejection'`, and the rejection request is rendered with its
origin and impacts.

Web arms of P31 (the provisional copy under an active chain) and P33 (the Withdraw affordance
suppressed while the direct call still 409s). Unit tests plant both shapes; the Playwright proof
against the reserved server is the delivered copy unchanged. ~200 lines, standard.

### B5a — the four commands on the client

Gateway methods `forwardDecision`, `countersignDecision`, `disagreeDecision` and
`resolveStrandedCountersign` on the four routes with the shared input types
(`ForwardDecisionInput`, `DisagreeDecisionInput`, `ResolveStrandedCountersignInput`), each sending an
`Idempotency-Key`; four `OutboxOp` variants with `replayOutboxOp` arms; write-ahead store actions
minting one key per act, so a lost response replays the SAME key and self-countersign stays two
explicit acts under two keys (P32's client half). Refusals (409 while reserved, a lesser client under
an active chain, an ineligible state) are surfaced as the server's message, never masked. Unit tests
cover the lost response, the double-click and the replay for each command, and the scope guard on a
project switch mid-flight. No UI in this unit. ~350 lines, standard.

### B5b — the affordances and the controls

The Forward affordance on a `pending`/`change` decision for its holder, the PMC and an architect,
rendered only when `rollout.phase6_4d === 'open'`; the architect's Decision Log controls on an
`awaiting_countersign` decision — Countersign, Reject back (`disagree` with `path: 'reject_back'`),
Forward on (`path: 'forward_on'` with the target) — and the PMC's stranded resolution (`completed` /
`returned`) when the chain is inactive; the awaiting row's rendering and attribution; the non-blank
reason at the client layer. If a unit renders forward history it serves a `DecisionForward` DTO and
classifies it in the completeness tripwire in the same change; otherwise the "owed" entry is closed
as not served.

Web arms of P30, P33 and P34: unit tests drive each control through the store with the server's
refusals planted; Playwright against the reserved server asserts no Forward renders and the awaiting
controls are absent (the states cannot exist), which is P29c's "no Forward renders" arm. ~400 lines,
standard.

### B6 — the client keys on the member commands

`addMember`, `updateMemberRole` and `removeMember` send an `Idempotency-Key` minted per act, so a
lost response retried by the user runs once (the server dedups a keyed replay; a keyless call keeps
its per-call synthesized key for tabs older than this unit). Unit tests assert the same key on the
retry and that a second distinct act mints a new one. ~120 lines, standard.

## Order and what a unit may not do

Sequence: B1 → B2 → B3 → B4 → B5a → B5b; B6 after B1, independently. A unit starts only after its
dependencies are on `main`, and only one is open at a time. No unit may:

- retire a reservation door, activate `decisions.effects`, or change any server runtime code (the
  two API tripwire tests' registrations are the only `apps/api` edits);
- ship a migration or a build variable;
- render an architect designation, an `architect` picker option or a Forward affordance while the
  shell reads `rollout.phase6_4d = 'reserved'`;
- fold the drain directive before the last unit merges.

Each unit's PR carries the standard markers, `migration-scope: none`, the five pre-review checks and
the invariant matrix, names its proof arms, and is RED at its base for the surface it adds.

## The review priorities that travel with the units

dot's priorities (#482 comment 5906093330, posted with Jagrut's approval) map as: the accurate
"awaiting countersign" copy from `countersignRequired` and the returned status → B4; the Countersign /
Reject back / Forward on / stranded paths with the Inbox and Decision Log states, badges, roster and
permissions → B3, B4, B5a, B5b; Withdraw suppressed on a `countersign_rejection` request → B4;
`countersign-v1` on every API-bound request including `/auth/session` with a coverage test → B1;
retries, lost responses, double-clicks, role/project changes and both rejection paths through
re-approval → B5a (the commands) and B5b (the paths), with self-countersign as two explicit acts →
B5a; `rollout.phase6_4d` for role pickers and Forward → B2 and B5b; the rollout gated through client
completion and the drain, with the minimum server release including A8b → the fold below.

## The drain

Unchanged from the 4d-ii-a record: the drain's minimum release is the release carrying A8b
(`f8274f4`), fenced by A8b's persisted server-generation minimum. 4d-ii-b's STATUS fold — the
post-merge STATUS record of the LAST B-unit to merge — SETS
`blocking_directive: phase-6-4d-previous-release-drained` naming that release, and the drain
attestation (an `OPERATOR-ATTESTATION`, REQUIRED, with the autonomous evidence as fail-closed
corroboration) follows before 4d-iii.
