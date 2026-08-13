# The decision learns who decides — withdraw, the decider, consultation, and the architect

**Status: PLAN. Four implementation units (4a–4d), each its own PR and review stop,
in that order.** The `room` → `space` rename is NOT here (owner-gated, sequenced
behind this task — see `docs/STATUS.md`'s gated-successor table). External-party
IDENTITY and the collaborator BOUNDARY are NOT here (units 6.1b/6.2/6.3 and the
reserved probes named below). This plan reworks WHO a decision goes to and what can
be done about one that went out wrongly — over today's project members only.

## The problem, in the owner's words

Three gaps, all hit live on a real project on 2026-08-13:

1. **"Currently I have created an issue in one project, but now it has been sent to
   Client. How does the admin delete it and manage it?"** — There is no way out.
   The lifecycle is `create / publish / approve / requestChange / withdrawChange`
   (`apps/api/src/decisions/decisions.service.ts`), and `withdrawChange` only
   cancels a change REQUEST. Once `publishedAt` is set, the decision sits on the
   client's pending list forever or gets approved. Nothing withdraws it; nobody —
   admin included — can remove a wrongly-published issue from the client's view.

2. **"Do I always have to give the options?"** — Yes, today:
   `createDecisionSchema` requires `options: min(2).max(4)`
   (`apps/api/src/contracts.ts:467-478`). There is no record-style issue. And the
   only non-client path is `publish: false` — an author-PRIVATE draft the rest of
   the team cannot see either. An issue that needs no client approval has no home.

3. **"The client may not be the only decision taker or have the knowledge or the
   bandwidth … the architect needs to orchestrate THE DECISION. There are technical
   decisions which other agencies or other people may have to take a call on or
   provide their insight and input."** — The model hard-codes the client as the
   only decider: `approve` is `['client','pmc']` with `onBehalfOf` fixed to
   `'client'` (`decisions.service.ts:194`), the pending audience is
   `role === 'pmc' || role === 'client'` (`orgs.service.ts:1137`), and the
   published-pending visibility rule admits only pmc/client
   (`decision-serialize.ts:69-77`). The controller PROSE already says "the
   PMC/architect's authority" (`decisions.controller.ts:28,41,53`) — but no
   `architect` role exists anywhere in the type system.

## The decision

Four changes, one model:

1. **`decisions.withdraw` (unit 4a)** — an attributable, reasoned, TERMINAL
   withdrawal of a published, never-approved decision. The register keeps the row
   as history with a `withdrawn` status; the client's pending surfaces derive from
   status and clear; nothing is silently deleted. This is deliberately the FIRST
   unit: it is the owner's live defect.

2. **The per-decision DECIDER (unit 4b)** — each decision names who decides:
   `client` (the default — every existing row backfills to it, byte-identical
   behavior), `pmc`, a NAMED project member, or `none` — a record-only issue
   that is born in a terminal `recorded` state, needs no options, and is
   approvable by nobody because nothing is being decided. The `architect`
   decider value joins IN unit 4d together with the role that can hold it
   (§B.1).

3. **CONSULTATION distinct from approval (unit 4c)** — the PMC or architect asks
   named members for input on a decision; requests and responses are recorded
   append-only and feed the decider's view. Input is not sign-off: consultation
   never moves status and never gates an activity.

4. **The ARCHITECT and forwarding (unit 4d)** — `architect` becomes a real
   `TokenRole`, and the settled forwarding design activates: the architect
   orchestrates where a decision goes next. Forward authority is the holder + the
   PMC **+ the architect once one exists** — this AMENDS the earlier settled
   answer (holder + PMC), on the owner's 2026-08-13 instruction, and the amendment
   is flagged here deliberately. Retained settled answers: no chain exists until
   an architect exists; a self-countersign is two explicit recorded acts; a
   disagreeing architect may reject back OR forward on.

## What this plan is NOT

- **Not the rename.** `room` → `space` has its own catalogue
  (`docs/reviews/pr-330-convergence.md`) and starts only on the owner's explicit
  go, after this task.
- **Not external collaboration.** "Other agencies" participate TODAY as project
  members (`consultant`/`contractor` memberships) — that is this plan's whole
  reach. True outside-the-project access is the phase-6 collaboration line (6.1a
  merged; 6.1b CLOSED-HELD; the boundary plan unwritten), and this plan builds NO
  parallel identity, principal, scope or grant mechanism. The seam: when
  collaborators arrive, they arrive as members-with-narrower-scopes, and the
  decider/consultee designations here already name memberships, so nothing in
  this unit needs re-modelling then.
- **Not the reserved task-3 probes.** `Review-Deferred-To-Probes:
  phase-6-task-3` in `docs/reviews/pr-324-convergence.md` reserves P1–P5
  (route-policy tripwires, scope-completeness, §B reachability, §A layering).
  Unit 4d's new role will LOOK adjacent to P1/P2 — it is not them, and this unit
  does not run them; they stay bound to their stop.
- **Not a change to approval history.** `DecisionApprovalRevision` stays
  immutable and append-only; nothing here can erase or rewrite an attributable
  approval (the platform invariant). Withdraw is refused wherever an approval
  exists — see §A.

## §A — Unit 4a: `decisions.withdraw`

### 1. Eligibility: published, pending — and `pending` PROVES never-approved

Withdraw targets exactly the owner's case: `publishedAt` set, `status='pending'`.
The state machine makes `pending` sufficient proof of a clean history: `approve`
moves `pending|change → approved`, `requestChange` moves `approved → change`,
`withdrawChange` moves `change → approved` — no path re-enters `pending`. A
decision that reads `pending` has never carried an approval. Refusals:

- a DRAFT (`publishedAt` null) → 409 — drafts need no withdrawal; the author
  controls them (and `create`+`publish` already do).
- `approved` or `change` → 409 naming `requestChange` as the honest path — these
  carry attributable approvals the register must keep authoritative.

Belt-and-braces, the transaction also asserts no `DecisionApprovalRevision` rows
exist for the id, and the DB seal (point 6) makes the combination unrepresentable.

### 2. The command

`POST /projects/:projectId/decisions/:decisionId/withdraw`, policy
`decision.withdraw: ['pmc']` (a new `ROLE_POLICY` entry —
`packages/shared/src/domain/policy.ts` — and the `route-policy.test.ts` identity
walk covers the new route automatically). Body: `{ reason: z.string().trim().min(1) }`
— the reason is REQUIRED; a withdrawal without one is the silent delete this
design refuses. Ledger type `decisions.withdraw` through the standard
`resolveActor → hashRequest → peekReplay → executeCommand` spine; keyed replays
append nothing.

Transition: **CAS** `updateMany({ where: { id, projectId, status: 'pending',
publishedAt: { not: null } }, data: { status: 'withdrawn', withdrawnAt,
withdrawnById, withdrawReason } })`, `count === 0` → 409 "The decision changed
while withdrawing — reload and retry" (the `approve` pattern,
`decisions.service.ts:211-225`). Same-tx: a `DecisionEvent { type: 'withdrawn' }`
register row, and an APPENDED notification notice ("Decision withdrawn: <title> —
<reason>"), following the approve precedent (`decisions.service.ts:275`) —
notifications are project-scoped text notices with no decision FK, so the design
APPENDS the truth chronologically and deletes nothing; the actionable pending
surfaces derive from `status` and clear by themselves. **The withdrawal notice is
AUDIENCE-FILTERED to pmc** (Codex, round 1): the snapshot's notice stripping
today recognizes only the pending-notice text shape (`isPendingDecisionNotice`,
`domain/notifications.ts:19`, applied at `snapshot.service.ts:181`), so an
unfiltered withdrawal notice would hand contractor/engineer/consultant AND the
client the title and reason of a decision §A.3 declares pmc-only — a new
`isWithdrawnDecisionNotice` predicate joins the same mechanism and the notice is
stripped for every non-pmc viewer. The client's pending item simply disappears
(status-derived); the register, not the bell feed, is where the withdrawal is
explained to the authority that manages it.

**`publish` gains the CAS it lacks, in this unit.** It is today the ONE command
with a read-then-write window (plain `update` at `decisions.service.ts:147` behind
a pre-read at `:137`). Withdraw joins a lifecycle where every transition
compare-and-sets; leaving its neighbour racy would be repeating the asymmetry.
`publish` becomes `updateMany({ where: { id, projectId, publishedAt: null } })`,
`count === 0` → 409.

**The readiness lock.** `approve`/`requestChange`/`withdrawChange` take
`lockProjectReadiness` because they move decision status, which the activity gate
reads (`activities.service.ts:432` inside `start`'s locked tx). Withdraw moves
status too, so it takes the lock — by CLASS (a command that mutates a fact the
readiness read consumes), not by verdict arithmetic, even though today's verdict
is unchanged (`pending` and `withdrawn` both read `wait`). The §A lock-coverage
tripwire enumeration gains `decisions.withdraw`.

### 3. The status is an interface — the reader enumeration

`withdrawn` joins the `DecisionStatus` enum (Prisma `schema.prisma:18-22`, an
additive `ALTER TYPE … ADD VALUE` migration) rather than riding an orthogonal
nullable column, PRECISELY so the type system fans out: the TS mirror
(`domain/transitions.ts:37`), the shared `Decision` type, and every `as const`
map keyed by `DecisionStatus` fail to COMPILE until each reader answers for the
new value. The enumerated readers, each with its decided behavior:

| reader | today | with `withdrawn` |
|---|---|---|
| `deriveDecisionReading` (`packages/shared/src/domain/readiness.ts:154-165`) | else-branch → `wait` + "Awaiting the client's approval" — the WRONG reason | explicit branch → `wait` + "The linked decision was withdrawn — re-issue or relink" (verdict unchanged, reason honest; a withdrawn decision must not silently unblock work whose question is unanswered) |
| `decisionVisibleToViewer` (`decision-serialize.ts:69-77`) | AUTH-02: published-pending is pmc/client-only | `withdrawn` is **pmc-only**. It was pmc/client-visible while pending; contractor/engineer/consultant NEVER saw it, and withdrawal must not widen an audience |
| `countPending` (`decisions.query.ts:173-175`) | `status: 'pending'` filter | drops it automatically — the client badge clears; asserted by probe, not assumed |
| `selectPending` / `selectReapproval` (web `selectors.ts:20-29`) | positive filters | drop it automatically; asserted |
| `selectLogDecisions` (`selectors.ts:32-38`) | contractor/engineer get `status !== 'pending'` — a NEGATIVE filter that would LEAK a withdrawn decision to roles that never saw it | excludes `withdrawn` for non-pmc; the server-side `decisionVisibleToViewer` rule is the authority and the selector mirrors it |
| `selectActionItems` (`selectors.ts:252-292`) | rebuilds pending/changes inline | withdrawn contributes to NO action item |
| nav badge (`useNavItems.ts:15`, an inline duplicate of the pending filter) | `status === 'pending'` | drops it; the duplication is noted for 4b (which touches the audience) |
| `STATUS_FILTERS` + chips + rail (`DecisionLogScreen.tsx:19-23,146-148,195,211`; `tokens/colors.ts:32-48`; `StatusChip.tsx:23-30`) | typed triple `pending\|approved\|change` | a fourth WITHDRAWN state: filter, count chip, rail colour, chip label — the maps are `as const` keyed by `DecisionStatus`, so TS flags every miss |
| notice audience stripping (`domain/notifications.ts:19`, `snapshot.service.ts:181`) | strips PENDING notices for non-pmc/client; knows no other decision-notice shape | the OLD pending notice stays in the client/pmc feed as history (the approve precedent keeps it too); the NEW withdrawal notice is stripped for every non-pmc viewer via `isWithdrawnDecisionNotice` — title and reason never reach roles that never saw the decision, nor the client (§A.2) |
| projection `decisions.inbox` (`decisions.projection.ts:25,29,112`) | `decision.` prefix dispatch; full-refresh-from-canonical | picks the new event up with no per-event logic; the diagnostic comparables include `status` field-for-field and must know the value |
| activity gate callers (`activities.service.ts:432`, `activities.query.ts:127`) | consume `statusOf`/`statusMap` verbatim | unchanged — the reading function above is the single point of interpretation |

### 4. The event and the sealed catalog

`decision.withdrawn` joins, in order: `DOMAIN_EVENT_TYPES`
(`packages/shared/src/platform/events.ts:34-40`) → `EXTERNAL_EFFECTS`
(`apps/api/src/platform/external-effects.ts:41-47`) as `{ invalidate: true,
push: null }` (surfaces refresh; no push — `change_requested`/`change_withdrawn`
set the precedent for lifecycle corrections) → **the coverage re-seal**:
`effectCoverageVersion()` changes with any new key and is pinned at
`outbox.bootstrap.ts:115`, `outbox-operations.service.ts:143` and
`external-effects.test.ts:47-74` — the re-seal is explicit in the diff, never a
drive-by → `decisionsManifest.producesEvents` → `DECISION_COMMANDS` in
`packages/shared/src/contracts/decisions.ts` → the manifest⇄contract equality
test (`decisions.contract.test.ts:24-58`) and the catalog-membership test
(`module-registry.test.ts:58`).

### 5. The web surface

The store gains `withdrawDecision` following the existing action pattern
(`store.ts:1854-1937`): a fresh `newIdempotencyKey()` per deliberate action, the
`runRemoteOrQueue` outbox spine, a new op-union variant `{ t: 'withdraw',
decisionId, reason, idempotencyKey }` + replay arm + gateway method
(`apiGateway.ts:1500-1506, 1603-1607`). The register (`DecisionLogScreen.tsx`)
shows the WITHDRAWN state with its reason and withdrawer, offers the action only
to pmc on an eligible decision (`can('decision.withdraw', role)` + status
`pending` + not draft), and the client screens never see the row at all
(server-filtered; the selectors mirror).

### 6. The DB seals

Three, all additive, declared in `schema.prisma` where declarable and pinned by
`schema-migration-drift.test.ts` (the 6.1a Root-B lesson — a constraint only in
migration SQL is not a constraint):

1. **Terminal, and the evidence FROZEN with it** (Codex, round 2): a BEFORE
   UPDATE trigger refuses any transition OUT of `withdrawn` — a resurrected
   decision would be a forged register entry — AND refuses any change to
   `withdrawnAt`/`withdrawnById`/`withdrawReason` once the row is `withdrawn`:
   a status-only terminal seal would let hostile SQL rewrite WHO withdrew and
   WHY while the status stays legal, which is rewritten history wearing an
   intact seal. Write-once means the columns, not just the state (P8).
2. **Attributed**: `status='withdrawn'` requires `withdrawnAt`, `withdrawnById`
   and a non-blank `withdrawReason` (and the inverse: those columns only with the
   status) — a CHECK-shaped constraint trigger, since the columns live on the row.
   Non-blank is the repository's FULL ASCII-whitespace discipline, spelled exactly
   (Codex, round 1 — `btrim(x)` strips spaces only):
   `btrim("withdrawReason", E' \t\n\x0B\f\r') <> ''`, and the hostile probe feeds
   a tabs-and-newlines-only reason (P8).
3. **Never-approved**: withdrawing is refused while any `DecisionApprovalRevision`
   row exists for the decision — the same fact the state machine proves, sealed
   where the data lives.

The migration is additive and diagnostic-first in the house pattern: it ABORTS
with a sample if any existing row already violates what it seals (none can — the
status is new), and legacy databases upgrade row-free.

## §B — Unit 4b: the decider, and the record-only issue

### 1. The model

`Decision` gains `deciderKind` (default `'client'`; every existing row backfills
`'client'` — behavior byte-identical until a caller says otherwise) and
`deciderMembershipId` (nullable, same-project composite FK, required iff
`kind='member'`, sealed by CHECK). **The 4b contract admits
`'client' | 'pmc' | 'member' | 'none'` — `'architect'` joins the enum IN UNIT 4d
WITH the role** (Codex, round 1): 4b ships before the `architect` TokenRole
exists, and a 4b-only deployment accepting an architect-decider would create
decisions no one can authenticate to see or approve, with PMC-on-behalf the only
escape. The value and the role are one deliverable. The composite FK needs a
candidate key `Membership` does not have — today it carries only `id` and
`@@unique([projectId, userId])` — so 4b adds `@@unique([projectId, id])` as an
additive orgs-owned schema change in the same PR, covered by
`schema-migration-drift.test.ts`, and the FK then makes a cross-project
membership reference unrepresentable (P17). Membership FACTS (is this membership
active, does it hold a role) are orgs-owned reads: `decisions.workflowParticipants`
gains `orgs` and the validation routes through the orgs participant (the
7B-iii-g `OrgsParticipant.projectRoleCandidates` precedent — the same module
already answers "who holds standing" for commercial), never a raw `tx.membership`
read from the decisions module.

The create contract exposes the decider; `approveSchema` stays `{ optionIndex }`
— the approver is still server-resolved, but the AUTHORITY check becomes: the
actor IS the decider (by role or named membership), or the PMC acting on the
decider's behalf, recorded honestly — `onBehalfOf` generalizes from the
hard-coded `'client'` (`decisions.service.ts:194`) to the decider's designation.

### 2. `none` — the record-only issue

`deciderKind: 'none'` answers the owner's first two questions at once: the
decision is born PUBLISHED-or-draft as usual but in a new terminal `recorded`
status — filed, team-visible, approvable by nobody. Its contract relaxes
`options` from `min(2)` to `min(0)` (a record may document zero, one, or several
courses); every other kind keeps `min(2)` — a CHOICE still needs alternatives.
**Relaxing the contract alone leaves the product path broken** (Codex, round 1):
`DecisionsService.create` derives its lead presentation from `input.options[0]`
and writes the REQUIRED `Decision.photoSwatch` from `lead.swatch`, so
`options: []` would throw before persistence with the schema green. 4b therefore
reworks the create path for the zero-option shape — the presentation columns
sourced from options become nullable-or-defaulted for a record (an additive
migration + serializer arm), the web create form supports filing without options,
and P19 asserts the FULL path (create → persist → serialize → register render),
never contract acceptance alone. **The create/publish side effects branch too**
(Codex, round 2): today's path unconditionally appends the "Decision awaiting
approval" notice and pushes `decision.published` at the pending audience — a
false approval demand for a record nobody can approve. For `deciderKind='none'`
the notice reads "Issue recorded: <title>" (ordinary audience — it is not a
pending notice and no stripping shape matches it deliberately) and the
published-event push narrows to NOBODY (the same decider-routed dispatch
narrowing §B.3 builds — a record's decider set is empty), probed at the bell
AND the push intent (P18). `recorded` walks the SAME reader table as §A.3:
gate reading `na` ("record only — no approval required"; an activity linked to a
record must not wait on nobody) — **for a PUBLISHED record only** (Codex,
round 2): `statusOf` reads status regardless of draftness, so a PRIVATE draft
record would otherwise unblock an activity gate with evidence the team cannot
see; the recorded arm therefore consults the draft flag — draft → `wait` ("the
linked record is unpublished — publish it"), published → `na` — and P20 proves
an activity linked to a draft record refuses to start until publish. Pending
surfaces exclude `recorded` structurally,
register shows a RECORDED state, visibility is the ordinary published-decision
audience (it is a team record, not a pending approval — AUTH-02's
pending-narrowing does not apply), and the `as const` maps force every miss to a
compile error. **`recorded` is TERMINAL and sealed like `withdrawn`** (Codex,
round 1): a BEFORE UPDATE trigger refuses any transition out of it — `approve`'s
CAS never matches it, and hostile SQL flipping a record to `approved` would
manufacture a locked approval the activity gate then trusts — with the seal
probed directly (P18).

### 3. The pending audience follows the decider

Today "pending" is hard-wired to the client: `countPending`'s audience gate
(`orgs.service.ts:1137`), AUTH-02's pmc/client narrowing
(`decision-serialize.ts:69-77`), `selectActionItems`' `client-pending` item, the
nav badge, and the push target `['client']` on `decision.published`
(`external-effects.ts:41-47`). With a decider, each of these routes to THE
DECIDER: the pending decision is visible to pmc + the decider (a named-member
decider sees their own pending item; from 4d, an architect-decider sees theirs), the
badge and action items key on "decisions I decide", and the published-event push
reaches the decider and only the decider — the static catalog names the CEILING
audience (the union of decider roles) and the dispatch site narrows to the
actual decider; `buildDispatchIntent`'s mismatch refusal
(`external-effects.ts:272-287`) is extended to treat the catalog as the ceiling.
**"Only the decider" requires a dispatch target the push spine does not have**
(Codex, round 1): the outbox persists ROLE audiences (`push.roles`) and
`PushSubscription` carries no user or membership linkage, so a role-level push
for a named-member decider would notify EVERY member holding that role, and
omitting the role would notify nobody. 4b's first deliverable is therefore the
targeted dispatch — and the target is a USER, not a membership (Codex, round 2):
an org owner/admin operating as `pmc` legitimately has NO project `Membership`
row (the `ProjectAccessService`/`OrgsParticipant` fallback), so a
membership-keyed target would either drop them or fall back to notifying every
pmc. The push intent gains an optional user target beside its role ceiling (a
membership designation RESOLVES to its user at dispatch; an org-admin actor
already IS a user), the subscription→user linkage is added where the owning
module holds it, and the probe pair proves BOTH directions: the target receives,
a same-role non-target does NOT — including the org-admin-requester case in 4c
(P26). 4c's consultation pushes ride the same mechanism. Every one of these readers is named in the
unit's packet the way §A.3 names its readers.

## §C — Unit 4c: consultation — input is not sign-off

Two labour-adjacent append-only facts, owned by decisions:
`DecisionConsultation` (decisionId, requestedById, consulteeMembershipId — a
same-project composite FK onto the `(projectId, id)` candidate key 4b adds,
question, requestedAt) and `DecisionConsultationResponse` (consultationId,
response text, an OPTIONAL recommended option, respondedAt; append-only,
sealed). **The recommendation is a same-decision option REFERENCE, never a raw
index** (Codex, round 2): an index is append-only evidence that nothing binds to
the decision's actual options — `3` on a two-option decision is immutable
nonsense the UI cannot render, and an index survives option reordering pointing
somewhere else. The response stores the server-resolved `DecisionOption` id
under a composite FK constrained to the SAME decision, with a hostile probe
feeding an out-of-range index and a foreign decision's option id (P27). **`question` and `response` are user-supplied EVIDENCE and carry the
sibling non-blank discipline** (Codex, round 1): zod `trim().min(1)` at the
contract AND the exact DB CHECK `btrim(x, E' \t\n\x0B\f\r') <> ''` on both
columns — append-only whitespace is immutable evidence that says nothing — with
P23 asserting the whitespace-only refusal at both layers, not merely
round-trip/attribution. The PMC requests (the architect joins the requester set
IN 4d with the role — the same staging rule as the decider value, §B.1: no
authority names a role that cannot yet authenticate); the named member responds;
the thread renders under the decision in the register and in the decider's view. Three invariants, stated
now: consultation NEVER moves `status` (no CAS touches it), NEVER changes a gate
verdict, and WIDENS visibility exactly one way — a consultee sees THAT decision
(and its thread) while their consultation stands, an exception added to
`decisionVisibleToViewer` beside AUTH-02, not a rewrite of it. Events
`decision.consultation_requested` (push to the consultee) and
`decision.consultation_responded` (push to the requester) join the catalog with
the same re-seal discipline as §A.4. The consultee is a MEMBERSHIP — when
external collaborators arrive (6.2+), they arrive as members and this table
already names them.

## §D — Unit 4d: the architect, and forwarding

### 1. The role, honestly fanned out

`architect` joins `TokenRole` (`packages/shared/src/domain/types.ts:16`) and its
mirrors — `auth.ts:24`, BOTH zod role enums (`contracts.ts:6,616`), `PushRole`
(`external-effects.ts:22`), `decisionsManifest.permissions`, the membership-role
comment (`schema.prisma:812`), and every `ROLE_POLICY` entry the role belongs in
(the exact policy row set is the unit's FIRST deliverable — `project.read`
certainly among them, `decision.create` deliberately NOT (issuing stays the
PMC's) — and the `route-policy.test.ts` identity walk pins whatever it says).
The role is a project MEMBERSHIP role like the other five;
`worker` stays deliberately absent from the zod allowlists. Where the controller
prose already said "PMC/architect" (`decisions.controller.ts:28,41,53`,
`policy.ts:21`), the allowlist finally matches the words — that is this unit's
one-line summary.

### 2. Orchestration

The settled design, plus the owner's amendment, as behavior:

- **Forwarding**: an append-only `DecisionForward` chain (decisionId, fromId,
  toDesignation, reason, at). The HOLDER is not a new concept: it is the
  decision's CURRENT decider designation (§B.1) — a decision is born held by
  its decider, forwarding re-points that designation, and the chain records
  each hop, so every pending surface, badge and push that "follows the decider"
  follows the forward automatically. Forward authority: the current HOLDER +
  the PMC **+ the architect once one exists** (the AMENDMENT — previously
  holder + PMC).
  The `reason` is user-supplied EVIDENCE for an append-only holder change and
  carries the sibling non-blank discipline — zod `trim().min(1)` AND the exact
  `btrim(x, E' \t\n\x0B\f\r') <> ''` CHECK (Codex, round 2; P34). And the
  TARGET must be able to act (Codex, round 2): `toDesignation` is validated
  through the orgs participant as an ACTIVE same-project member/role that can
  hold the decision — forwarding to a removed membership or an unheld role
  commits a holder no one can authenticate as, vanishing the decision from
  every pending surface with PMC-on-behalf the only way back. A removed-target
  forward is a 409, probed (P30).
  **Forwarding SERIALIZES against approval and countersign** (Codex, round 1 —
  the concrete interleaving: A reads holder=client and starts approving, B
  forwards to engineer and commits, A's approval lands under a holder that no
  longer exists): every one of approve/countersign/forward takes the decision
  row's lock and re-checks the holder INSIDE the transaction (the lock-before-
  read rule), so the loser of either ordering is a deterministic 409 — proven by
  a barrier probe in BOTH orderings asserting exactly one surviving outcome and
  a coherent holder (P35).
- **No chain until an architect exists — and "exists" means an ACTIVE
  membership** (Codex, round 1): `Membership` rows are soft-removed
  (`invited | active | removed`), so mere row presence would leave the chain
  armed after the only architect left, stranding every approval behind a
  countersign nobody can give. The switch is "an ACTIVE architect membership
  exists", read through the orgs participant (§B.1's edge). **And the switch's
  WRITERS serialize with its readers** (Codex, round 2 — the concrete
  interleaving: A reads "no active architect" and approves straight to
  `approved`; B promotes a consultant to architect and commits; A commits an
  approval the now-active chain should have held at `awaiting_countersign`):
  approve/countersign/forward read the switch under `lockProjectReadiness`, and
  the orgs-side mutations that can flip architect presence —
  `MembersService.updateRole` (today lock-free at `members.service.ts:106-110`),
  member removal/restore — take the SAME lock when the role entering or leaving
  is `architect`, joining the §A lock-coverage enumeration in 4d. A
  role-change-vs-approve barrier probe covers activation AND deactivation in
  both orderings (P36). A project that removes its only architect DEACTIVATES
  the chain for NEW approvals; a decision already `awaiting_countersign` at that
  moment is NEVER auto-flipped — the PMC resolves it by an explicit attributable
  act (complete it under the no-chain rule, or return it to the decider), both
  recorded as chain entries. Probes: no-architect-ever (P29), removed-architect
  + the stranded-decision resolution (P29b), the switch races (P36).
- **Countersign, and the state that carries it** (Codex, round 1): §A's
  eligibility proof rests on `pending` being unreachable after ANY approval act,
  and "approved but not yet countersigned" is a state the enum must therefore
  NAME rather than fake. Under an active chain, the decider's approval writes
  its `DecisionApprovalRevision` and moves the decision to a new
  **`awaiting_countersign`** status (the third and last new `DecisionStatus`
  value, walking the same §A.3 reader table: gate reads `wait` — work must not
  start on an uncountersigned approval; pending surfaces show it to the
  ARCHITECT as their action item; withdraw refuses it — an approval act exists,
  which the never-approved DB seal also enforces). The architect's countersign —
  a second, separately-attributed register act referencing the exact
  `DecisionApprovalRevision` — moves it to `approved`. A SELF-countersign
  (architect is also the decider) is TWO explicit recorded acts under two
  idempotency keys, never one implied one. `pending` stays unreachable after any
  approval act, so §A's proof survives 4d intact.
- **Disagreement — and the `change` state's OWN machinery honored** (Codex,
  round 2): reusing a state borrows its whole contract, and `change` is backed
  by exactly ONE open `ChangeRequest` — `approve()` from `change` rolls back
  unless precisely one open request resolves (`decisions.service.ts:226-236`),
  and the serializer renders the reason FROM that open row. So BOTH
  disagreement outcomes land in `change` AND create the open `ChangeRequest` in
  the same transaction, requested by the architect with the disagreement
  reason: **REJECT BACK** keeps the original decider as holder — they re-approve
  (which resolves the request, per the existing machinery) and the chain runs
  again; **FORWARD ON** re-points the holder to the decider the architect
  names (validated active, as above) — the NEW holder finds an actionable
  change-state decision, re-approves, and the chain runs again
  (`awaiting_countersign → countersign → approved`). Neither path returns to
  `pending` (the §A invariant holds); neither erases the approval act it
  answers — the register keeps both sides; and approve-from-`change` under an
  ACTIVE chain lands `awaiting_countersign` exactly like approve-from-`pending`
  (the countersign rule is about the chain, not the prior status). Probed end
  to end: P33 drives reject-back AND forward-on through re-approval to
  completion by the new holder.

The unit writes only decisions-owned TABLES — its one foreign CODE change is
the readiness lock joining the orgs role mutations (§ above), an edit the orgs
module makes to its own commands — and the one foreign fact it needs
is DECLARED now rather than left conditional (Codex, round 1): membership truth
— active standing, held role, same-project identity — is orgs-owned, so
`decisions.workflowParticipants` gains `orgs` in 4b and every consumer (member-
decider validation §B, consultee validation §C, the architect presence switch
and holder checks here) routes through the named orgs participant API
(`projectRoleCandidates`/`hasProjectRoleStanding` and an active-membership
assertion beside them — the 7B-iii-g precedent), never a synchronous
`tx.membership` read from the decisions module. That is the P5 layering lesson
from `pr-324-convergence.md` applied up front — the reserved task-3 CHECK is not
run here, the discipline is.

## §E — Named probes

Per house convention each probe is seen RED before the change that turns it
green, at the staged commit the packet names (a base-commit red proves the
fixture illegal, not the defect present — the staging note in
`2026-08-12-nested-locations.md` §D governs). `must first be seen to FAIL
against` names the exact site.

### Unit 4a

| probe | proves | must first be seen to FAIL against |
|---|---|---|
| P1 | withdraw of a published pending decision lands `withdrawn` + reason + actor; a `DecisionEvent 'withdrawn'` and the appended feed notice exist; keyed replay appends nothing | route absent — `decisions.controller.ts` (404 at the staged baseline) |
| P2 | a draft is refused 409 | the service guard absent at baseline |
| P3 | `approved` and `change` decisions are refused 409 naming `requestChange`; the approval register is untouched | the service guard absent at baseline |
| P4 | a blank/absent reason is a 400 at the contract | zod schema absent |
| P5 | client/contractor/engineer/consultant get 403; pmc succeeds; the route-policy identity holds | `ROLE_POLICY['decision.withdraw']` absent |
| P6 | two concurrent withdraws admit exactly one (CAS 409 for the loser), both orderings under the deterministic barrier | the CAS `count===0` branch |
| P7 | double publish admits exactly one — publish's new CAS | `decisions.service.ts:147` plain `update` |
| P8 | PG refuses `withdrawn → pending/approved/change` UPDATE (terminal seal), an unattributed withdrawn row, a whitespace-only reason (tabs/newlines — the `btrim(x, E' \t\n\x0B\f\r')` CHECK), an UPDATE rewriting `withdrawnAt`/`withdrawnById`/`withdrawReason` on an already-withdrawn row (evidence freeze), and a withdraw beside an existing `DecisionApprovalRevision` (never-approved seal) | the three triggers absent — hostile SQL accepted at baseline |
| P9 | `countPending` and the client pending list drop the decision; the client badge clears | asserted against `decisions.query.ts:173-175` fixtures |
| P10 | a withdrawn decision is INVISIBLE to contractor/engineer/consultant AND to the client (server serialize + web selector agree), and the withdrawal NOTICE (title + reason) is stripped from every non-pmc feed (`isWithdrawnDecisionNotice`) | `selectors.ts:32-38` negative filter leaks it; `decision-serialize.ts:69-77` has no withdrawn arm; `snapshot.service.ts:181` delivers the notice to everyone |
| P11 | `deriveDecisionReading('withdrawn')` yields `wait` with the honest withdrawn reason, and an activity gated on the decision still refuses to start with that reason | `readiness.ts:154-165` else-branch emits "Awaiting the client's approval" |
| P12 | `decision.withdrawn` is in the shared catalog, the external-effect catalog re-seal is exact, manifest⇄contract equality holds | `external-effects.test.ts:47-74` / `decisions.contract.test.ts:24-58` RED on the missing entry |
| P13 | projection `decisions.inbox`: live == projection == rebuild across a withdraw; the rebuild emits zero events | the diagnostic comparables on the new status |
| P14 | the web outbox op replays exactly once under its persisted key; the register shows WITHDRAWN with reason; the action is absent for non-pmc and for ineligible states | the op-union variant + screen state absent |

### Unit 4b

| probe | proves | must first be seen to FAIL against |
|---|---|---|
| P15 | default-decider create is byte-identical to today (contract default + backfill) — the no-caller-change proof | the field's absence itself (schema equality fixture) |
| P16 | a `member`-decider decision is approvable by that member and by pmc-on-behalf (recorded as on-behalf-of-the-decider), and by NO other role | `decisions.service.ts:194` hard-coded `'client'` |
| P17 | `deciderKind='member'` without a membership id (and the inverse) is unrepresentable — contract 400 and PG CHECK — and a CROSS-PROJECT membership reference is refused by the composite FK onto `Membership(projectId, id)` | the CHECK + the candidate key absent — hostile insert accepted |
| P18 | a `none` decision is born `recorded`, appears in the register and NEVER in any pending surface, badge, or action item; publishing it appends NO "awaiting approval" notice and pushes to NOBODY ("Issue recorded" notice instead — the bell and the push intent both asserted); PG refuses any transition OUT of `recorded` (approve CAS and hostile SQL both) | the `recorded` arm absent in each filter; the unconditional pending notice/push at `decisions.service.ts:101,149`; the terminal trigger absent |
| P19 | a record files end-to-end with `options: []` — create → persist → serialize → register render (the FULL product path, not contract acceptance alone) — and every other kind still refuses fewer than 2 | `contracts.ts:467-478` unconditional `.min(2)`; `DecisionsService.create`'s `input.options[0]` lead derivation throws on the empty array |
| P20 | an activity linked to a PUBLISHED `recorded` decision reads gate `na` with the record-only reason; linked to a DRAFT record it reads `wait` ("unpublished") and `start` refuses — publishing flips it to `na` | `readiness.ts:154-165` else-branch; `statusOf` blind to draftness |
| P21 | the pending push on `decision.published` reaches the decider and ONLY the decider — a same-role NON-decider member receives nothing (the per-membership dispatch target) | the static `push: ['client']` at `external-effects.ts:41-47`; the role-only push spine |
| P22 | pending visibility follows the decider: a named-member decider SEES their pending decision; a non-decider consultant does NOT | `decision-serialize.ts:69-77` pmc/client-only arm |

### Unit 4c

| probe | proves | must first be seen to FAIL against |
|---|---|---|
| P23 | a consultation request + response round-trips, append-only at PG (no UPDATE/DELETE), attributed both ways; a whitespace-only `question` or `response` is refused at the contract AND by the `btrim(x, E' \t\n\x0B\f\r')` CHECK | the tables/seals absent; the non-blank checks absent |
| P24 | consultation moves NO status and changes NO gate verdict (fixture: pending stays pending, gate reading identical before/after) | trivially green only AFTER the tables exist — red at the staged baseline via the absent read |
| P25 | the consultee sees THAT decision only while their consultation stands; another consultant still sees nothing | `decision-serialize.ts:69-77` |
| P26 | the two consultation events push to exactly the consultee / the requester — INCLUDING an org-admin requester with no membership row (user-level target), while every same-role non-target member receives nothing; the catalog re-seal is exact | the catalog entries absent; a membership-keyed target that drops the org-admin |
| P27 | a consultee MEMBERSHIP from another project is unrepresentable (same-project composite FK); a recommendation naming an out-of-range index or ANOTHER decision's option id is refused (the same-decision option FK) | the FKs absent — hostile inserts accepted |

### Unit 4d

| probe | proves | must first be seen to FAIL against |
|---|---|---|
| P28 | an `architect` membership authenticates, resolves policy, and appears in every role mirror (compile + runtime walk) | the `TokenRole` union — each mirror RED one by one |
| P29 | with NO ACTIVE architect membership ever, 4b behavior is byte-identical (no chain, no countersign) — the presence-switch proof | the activation predicate |
| P29b | removing the only architect DEACTIVATES the chain for new approvals; a decision already `awaiting_countersign` is never auto-flipped and is resolved only by an explicit attributable PMC act | presence read as row-existence — a `removed` membership keeps the chain armed |
| P30 | forward authority: holder ✓, pmc ✓, architect ✓ (once active), any other member ✗ — the AMENDED rule; a forward naming a REMOVED membership or an unheld role is a 409 (active-target validation) | the pre-amendment holder+PMC check; the unvalidated `toDesignation` |
| P31 | a decider approval under an active chain writes its revision and lands `awaiting_countersign` (gate `wait`, withdraw refused, the architect's action item); the countersign — a second attributed register act referencing the exact `DecisionApprovalRevision` — lands `approved` | the countersign state/guard absent |
| P32 | a self-countersign is two explicit acts with two ledger entries under two idempotency keys | the single-act shortcut |
| P33 | BOTH disagreement outcomes land in `change` WITH the open `ChangeRequest` created in-tx (the reason renders from it; NEVER back to `pending`), keeping BOTH register acts; reject-back keeps the decider as holder, forward-on re-points to the named ACTIVE decider; each path then completes end-to-end — re-approve resolves the request, lands `awaiting_countersign`, countersign lands `approved` | the chain table absent; a reject-back landing `change` with NO open request (`decisions.service.ts:226-236` rolls the re-approval back and the serializer shows no reason) |
| P34 | the forward chain is append-only at PG and same-project-sealed; a whitespace-only forward `reason` is refused at the contract AND by the `btrim(x, E' \t\n\x0B\f\r')` CHECK | hostile insert/update accepted; the non-blank checks absent |
| P35 | forward vs approve/countersign under the deterministic barrier, BOTH orderings: exactly one outcome survives, the loser is a 409, the holder is coherent (no approval recorded under a superseded holder) | the lock-free holder read — both interleavings commit at the staged baseline |
| P36 | architect role-change vs approve under the deterministic barrier, BOTH directions (activation: promote-to-architect vs a direct approve; deactivation: demote vs a chain approve), BOTH orderings: the committed outcome matches the switch state AT COMMIT — never `approved` under an active chain, never `awaiting_countersign` under an inactive one | `MembersService.updateRole` lock-free at `members.service.ts:106-110` — the stale-switch approval commits at the staged baseline |

Ordering notes: P7 sits inside 4a deliberately — the publish CAS is 4a's
neighbour-repair and the race probe is worthless while withdraw (the reason the
window matters) does not exist. P15 opens 4b because every later probe leans on
the backfill being invisible. P29 precedes P30–P33: the chain probes are
meaningless until the presence-switch is proven off.

## §F — Staging, review units, and the known docs-only constraint

**One unit per PR, in order 4a → 4b → 4c → 4d**, each within the standard budget
(20 files / 1,500 lines). 4a's fan-out is the widest (a status is an interface;
the breadth IS the correctness) and is expected to brush the file budget.
**The enum and its readers are indivisible, so the split line cannot run between
API and web** (Codex, round 1): `DecisionStatus` is a SHARED type and the web's
`as const` maps are the very readers §A.3 enlists — an API-only first half
either fails `pnpm check` outright or loosens the type and ships exactly the
hidden/leaking states P10/P14 exist to prevent. If 4a exceeds budget, the
pre-declared split extracts the ENUM-INDEPENDENT repairs instead — the `publish`
CAS (P7) and the withdrawal-notice audience predicate wiring (P10's filter
half) land as a small preparatory PR touching no status value — and the enum
with its COMPLETE reader closure stays one unit, never mid-invariant. Each unit lands with its packet,
reproduce-first probes staged RED per §E, additive diagnostic-first migrations
only, and the tripwire pins advanced in the same PR (§A lock-coverage gains
`decisions.withdraw`; the external-effect coverage version re-seals in 4a, 4b
and 4c; the role mirrors pin in 4d).

**This plan PR itself** ships the plan + the STATUS flip to `task: 4 /
in_progress` in ONE diff (the #331 pattern the `phase_plan` pin enforces). The
known constraint, stated rather than discovered: the diff is docs-only, and past
three finding-bearing heads a docs-only review owes a `Review-Deferred-To-Probes`
trailer the gate REFUSES from a diff touching `docs/STATUS.md`
(`docs/STATUS.md` records this exact lesson from PR #324). The escape, if the
cap is reached: the trailer-carrying head REVERTS the STATUS edit (the diff
stops touching STATUS; the trailer becomes acceptable; the deferral targets this
task's own implementation stops, which `deferralPhases` admits while phase 6 has
open work), and the flip lands as the immediate tiny follow-up — the #324-proven
two-step. This paragraph exists so that head, if ever needed, is a planned move
rather than an improvisation.

## What carries forward

1. **A status value is an interface** (pr-334-convergence). Every new
   `DecisionStatus` value — `withdrawn` (4a), `recorded` (4b),
   `awaiting_countersign` (4d) — rides the enum precisely so every reader is
   FORCED to answer; §A.3's reader table is the enumeration done up front, not
   after a finding.
2. **A constraint only in migration SQL is not a constraint** (pr-327 Root B).
   Every seal here is declared in `schema.prisma` where Prisma can express it and
   pinned by the drift test where it cannot.
3. **The check's scope belongs to the data** (pr-327 Root A). The never-approved
   seal lives on the decision's register, not in the caller.
4. **Probes red on reasoning alone prove nothing** (pr-327 Root D). Every §E row
   names its red site; the packet records the staged red evidence.
5. **The public door must express what the contract accepts** (pr-333's one
   correction). 4b's create form exposes the decider; 4a's register exposes the
   withdrawal — no capability ships reachable only by curl.
