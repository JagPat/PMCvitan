# The decision learns who decides — withdraw, the decider, consultation, and the architect

**Status: PLAN — the task-4 programme frame plus the FULL design of unit 4a.**
Task 4 is four implementation units, 4a → 4b → 4c → 4d, each its own PR and
review stop. This document carries 4a (`decisions.withdraw`) to implementation
readiness; units 4b–4d keep their SCOPE in §B and receive their design in a
dedicated follow-up plan unit (the split at the review-lifecycle limit — §B
records why). The `room` → `space` rename is NOT here (owner-gated, sequenced
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
   (§B).

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

**And the NEIGHBOURING commands learn the new value at the SERVICE, not from
the trigger** (Codex, round 6): today's `approve` takes the row's CURRENT
status as its CAS source, so a stale client replaying an approval against a
now-withdrawn decision would drive a `withdrawn → approved` update into the
terminal trigger — a raw database error mid-write instead of a refusal. The
approve path validates `prior ∈ {pending, change}` BEFORE the CAS and returns
a deliberate 409 for a withdrawn row, with NO approval revision, register
event, or notice side effect — probed by the open-pending → withdraw →
stale-approve-replay ordering (P3).

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
stripped for every non-pmc viewer. **And the OLD pending notice is RETIRED, not
kept** (Codex, round 3 — an earlier head kept it "as history" and the review is
right that it is not history, it is a live false instruction: a client bell
still saying "awaiting approval" for a decision every other surface has removed
tells the client to approve something they can no longer open). Notices are
DERIVED communication artifacts with no decision FK today, so 4a adds a nullable
`Notification.decisionId` stamp (additive, in the retry-safe
`ADD COLUMN IF NOT EXISTS` form like every column and enum value this plan
adds — Codex, round 6: a deploy that aborts on a later trigger must re-run past
the already-added column; the decision-notice writers set it)
and the withdraw transaction DELETES the pending notices stamped with that
decision — the `DecisionEvent` register, not the bell, is the history. A
LEGACY unstamped pending notice (the owner's live case predates the stamp) is
retired by its exact text shape rebuilt from the decision's own title, guarded
by multiplicity: if more than one pending decision shares the title, the
ambiguous rows are left and reported rather than guessed at. Probed: the client
bell after withdrawal carries NO awaiting item for the decision (P10). The
client's pending item disappears (status-derived); the register, not the bell
feed, is where the withdrawal is explained to the authority that manages it.

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
additive `ALTER TYPE … ADD VALUE IF NOT EXISTS` migration — the retry-safe form,
so a deploy that aborts on a later diagnostic re-runs past the already-added
value; every enum addition in this plan uses it) rather than riding an orthogonal
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
| notice audience stripping (`domain/notifications.ts:19`, `snapshot.service.ts:181`) | strips PENDING notices for non-pmc/client; knows no other decision-notice shape | the OLD pending notice is RETIRED in the withdraw tx (stamp-based, legacy text-shape with the multiplicity guard — §A.2; a bell item demanding approval of an unopenable decision is a false instruction, not history); the NEW withdrawal notice is stripped for every non-pmc viewer via `isWithdrawnDecisionNotice` — title and reason never reach roles that never saw the decision, nor the client (§A.2) |
| projection `decisions.inbox` (`decisions.projection.ts:25,29,112`) | `decision.` prefix dispatch; full-refresh-from-canonical | picks the new event up with no per-event logic; the diagnostic comparables include `status` field-for-field and must know the value |
| activity gate callers (`activities.service.ts:432`, `activities.query.ts:127`) | consume `statusOf`/`statusMap` verbatim | unchanged — the reading function above is the single point of interpretation |

### 4. The event and the sealed catalog

`decision.withdrawn` joins, in order: `DOMAIN_EVENT_TYPES`
(`packages/shared/src/platform/events.ts:34-40`) → `EXTERNAL_EFFECTS`
(`apps/api/src/platform/external-effects.ts:41-47`) as `{ invalidate: true,
push: null }` (surfaces refresh; no push — `change_requested`/`change_withdrawn`
set the precedent for lifecycle corrections). **And the withdraw must outrun the
QUEUED past** (Codex, round 4): a committed `decision.published` push intent the
relay has not yet delivered survives the withdrawal in the durable outbox, so a
lagging or restarted relay would tell the client "awaiting your approval" about
a decision every surface has since hidden. **The guard lives in the DOMAIN, not
the platform relay** (Codex, round 6 — "the dispatcher re-derives" would have
meant the platform outbox synchronously reading a decisions table, a module-
boundary violation): the push intent gains an indexed SUBJECT key at emission
(the decision id, platform-owned column, set by the emitting module), and the
WITHDRAW TRANSACTION — which owns the knowledge of when — cancels the still-
pending `decision.published` push intents for that subject through a narrow
platform-owned operation (cancelled and recorded, never deleted; platform
mutates only its own table; decisions never reaches into the relay and the
relay never reads decisions). A relay claiming after the commit finds the
intent cancelled. **And a delivery LEASED just before the withdraw is covered
too** (Codex, round 7): the relay leases a row before it sends, so cancelling
only still-pending rows would miss one claimed moments before the withdrawal
committed — the send path therefore re-checks ITS OWN row's cancellation mark
AFTER the lease and immediately before the notify handoff (a platform-internal
read of the platform's own table — no boundary crossed), and a cancellation
landing during the lease window drops the send with the drop recorded.
**The invariant's TRUE boundary, stated rather than overclaimed** (Codex,
round 8): even the final pre-send check cannot serialize with the withdrawal
COMMIT — a cancellation landing in the instant between that check and the
external notify call is unrecallable, exactly as any already-sent push is, and
closing it would mean the withdraw transaction waiting on external I/O. So the
guarantee is stated at the boundary it actually holds: NO stale push is sent
whose delivery had not yet passed its final pre-send check when the withdrawal
committed; the residual window is check→send (external-call latency,
milliseconds, bounded and identical to the already-sent case the design
already accepts). BOTH provable orderings probed: claim-after-withdraw (found
cancelled at claim) and cancelled-during-lease (the pre-send check drops it,
recorded); the in-flight residual is the DOCUMENTED boundary, not a probe
(P10). The catalog chain then continues: **the coverage
re-seal** — `effectCoverageVersion()` changes with any new key and is pinned at
`outbox.bootstrap.ts:115`, `outbox-operations.service.ts:143` and
`external-effects.test.ts:47-74`, so the re-seal is explicit in the diff, never
a drive-by — → `decisionsManifest.producesEvents` → `DECISION_COMMANDS` in
`packages/shared/src/contracts/decisions.ts` → the manifest⇄contract equality
test (`decisions.contract.test.ts:24-58`) and the catalog-membership test
(`module-registry.test.ts:58`).

### 5. The web surface

The store gains `withdrawDecision` following the existing action pattern
(`store.ts:1854-1937`): a fresh `newIdempotencyKey()` per deliberate action, the
`runRemoteOrQueue` outbox spine, a new op-union variant `{ t: 'withdraw',
decisionId, reason, idempotencyKey }` + replay arm + gateway method
(`apiGateway.ts:1500-1506, 1603-1607`). **The withdrawal evidence travels
through the CONTRACT, not just the screen** (Codex, round 8): today's
`DecisionDto`/shared `Decision`/`serializeDecision` carry no withdrawal fields,
so the register would show a WITHDRAWN chip with no API data behind it — the
serialized decision gains `withdrawnAt`, the withdrawer's display identity, and
`withdrawReason` (pmc-audience only, per §A.3's visibility rule), and P14 pins
the API RESPONSE, not merely the rendered screen state. The register
(`DecisionLogScreen.tsx`) shows the WITHDRAWN state with its reason and
withdrawer, offers the action only to pmc on an eligible decision
(`can('decision.withdraw', role)` + status `pending` + not draft), and the
client screens never see the row at all (server-filtered; the selectors
mirror).

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
2. **Attributed — to a REAL actor** (Codex, round 7): `status='withdrawn'`
   requires `withdrawnAt`, `withdrawnById` and a non-blank `withdrawReason`
   (and the inverse: those columns only with the status) — a CHECK-shaped
   constraint trigger, since the columns live on the row. `withdrawnById` is
   FK-BACKED (the same identity-reference discipline Phase 3 gave
   `responsibleId`/`createdById`): presence alone would let hostile SQL
   attribute the permanent register to a nonexistent actor, so a forged
   withdrawer is unrepresentable, probed (P8). Non-blank is the repository's
   FULL ASCII-whitespace discipline, spelled exactly (Codex, round 1 —
   `btrim(x)` strips spaces only):
   `btrim("withdrawReason", E' \t\n\x0B\f\r') <> ''`, and the hostile probe feeds
   a tabs-and-newlines-only reason (P8).
3. **Never-approved, sealed in BOTH directions — the entry guarded by SOURCE
   STATE, not register emptiness alone** (Codex, rounds 2 + 7 + 9): the
   forward arm admits entry to `withdrawn` ONLY from a published `pending` row
   — the DB-level mirror of the service CAS — because register emptiness is
   NOT proof of never-approved on legacy data: the Phase-3 approval-history
   backfill (PR #192) deliberately left UNPROVABLE legacy approvals without a
   `DecisionApprovalRevision` row, so an `approved` decision with an empty
   register exists and hostile SQL could otherwise withdraw it with a real
   actor and non-blank reason, hiding a decision that carries approval
   evidence. The register-emptiness check stays as the second arm
   (belt-and-braces where BOTH facts exist), and the reverse arm refuses an
   approval-revision insert while the decision is `withdrawn`, taking the
   DECISION ROW LOCK (`FOR UPDATE`) before reading its status — a plain READ
   COMMITTED read would race an uncommitted withdrawal (the insert sees the
   old `pending`, both commit, contradiction) — the Phase-4 bound-3 precedent.
   Probed sequentially, as a two-session barrier race in both orderings
   (exactly one side committing), AND against a legacy approved-with-empty-
   register row under a direct `approved → withdrawn` UPDATE (P8).

The migration is additive and diagnostic-first in the house pattern: every
statement in the retry-safe form (`ADD VALUE IF NOT EXISTS`;
`ADD COLUMN IF NOT EXISTS` for `withdrawnAt`/`withdrawnById`/`withdrawReason`,
`Notification.decisionId`, AND the platform outbox SUBJECT column with its
index (`CREATE INDEX IF NOT EXISTS`) that the push cancellation keys on —
Codex, round 7: the cancel-by-subject code without its column finds no rows,
and a partially-applied key must not fail the re-run; guarded trigger creation
— Codex, round 6 — AND named `pg_constraint`-guarded `DO` blocks for the new
FK and CHECK constraints themselves (Codex, round 8: an aborted deploy that
already created `Decision_withdrawnById_fkey` or the evidence CHECK must not
fail its re-run on the duplicate constraint before the remaining seals
install). **And the subject key reaches BACKWARD** (Codex, round 8): the
column alone would leave pre-migration durable `decision.published` deliveries
subjectless — a publish committed before the deploy, with the relay down and
the withdraw after it, would escape cancel-by-subject — so the migration
BACKFILLS the subject for existing undelivered `decision.published` rows from
their own `DomainEvent` entity id (deterministic, copied from the event the
delivery already carries, never invented), in the same guarded retry-safe
form. It ABORTS with a sample if any existing row already violates what it
seals (none can — the status is new), and legacy databases otherwise upgrade
row-free.

## §B — Units 4b–4d: scope, and where their design now lives

**SPLIT at the review-lifecycle limit (five finding-bearing heads), along the
findings' own seam.** Across rounds 3–5 every finding landed on the 4b–4d design
prose while §A drew none — the same seam signal that split 7B-iii-b and
7B-iii-f, and the same move: the settled half ships, the churning half gets its
own review unit. This document is now the task-4 PROGRAMME FRAME plus the FULL
unit-4a design. Units 4b–4d keep their SCOPE here and receive their design in a
dedicated docs-only plan unit — "the 4b–4d plan" — which must clear its own
exact-head review before unit 4b implementation begins (the same plan-first
contract this document itself satisfies for 4a).

The scope, unchanged from the owner's recorded intent:

- **4b — the per-decision decider, and the record-only issue.** Who decides is a
  property of the decision: `client` (default, backfilled — behavior
  byte-identical), `pmc`, a NAMED project member, or `none` — the record-only
  issue, born in a terminal `recorded` state, zero options required, approvable
  by nobody. The `architect` decider value ships in 4d with the role.
- **4c — consultation distinct from approval.** Recorded, append-only input
  requests to named members feeding the decider; input is never sign-off, never
  moves status, never gates an activity.
- **4d — the architect and forwarding.** `architect` as a real `TokenRole`; the
  settled forwarding design with the owner's 2026-08-13 AMENDMENT (forward
  authority = holder + PMC + architect once one exists); no chain until an
  active architect exists; countersign as a second attributed register act;
  self-countersign is two explicit acts; a disagreeing architect rejects back or
  forwards on.

**The design decisions rounds 1–5 established for these units are BINDING on
the 4b–4d plan and are recorded, each with the finding that forced it, in
`docs/reviews/pr-335-convergence.md`** — among them: the decider reader
enumeration (bell notice, reapproval surfaces, viewer-scoped `countPending`,
push audience); the approve route ceiling widened then service-narrowed; the
user-level (not membership-level) push target; the zero-option create-path
rework and `recorded` terminal seal; the `Membership(projectId, id)` candidate
key and the orgs participant edge; the consultation `projectId` child column,
option-reference keys, non-blank evidence, and published-only + lock-guarded
eligibility at request AND response; `awaiting_countersign` as a first-class
status with the `finalized` register discipline and its emission; the
`ChangeRequest` origin + evidence freeze and the closed `withdrawChange`
escape; forwarding's actor/holder attribution, its event, its open-state and
active-target rules, and the holder columns write-once from 4b. The full prose
of the superseded design lives in this PR's own head history (`ac164c5`) and is
the 4b–4d plan author's starting material — nothing is re-litigated from
memory.

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
| P3 | `approved` and `change` decisions are refused 409 naming `requestChange`; the approval register is untouched; and the REVERSE ordering — a stale approve replayed against a now-withdrawn decision — is a deliberate 409 from the service (`prior ∈ {pending, change}` validated before the CAS) with no revision, event, or notice side effect | the service guard absent at baseline; approve's CAS sourced from the row's current status driving `withdrawn → approved` into the trigger |
| P4 | a blank/absent reason is a 400 at the contract | zod schema absent |
| P5 | client/contractor/engineer/consultant get 403; pmc succeeds; the route-policy identity holds | `ROLE_POLICY['decision.withdraw']` absent |
| P6 | two concurrent withdraws admit exactly one (CAS 409 for the loser), both orderings under the deterministic barrier | the CAS `count===0` branch |
| P7 | double publish admits exactly one — publish's new CAS | `decisions.service.ts:147` plain `update` |
| P8 | PG refuses `withdrawn → pending/approved/change` UPDATE (terminal seal), an unattributed withdrawn row, a FORGED `withdrawnById` naming no real actor (the FK), a whitespace-only reason (tabs/newlines — the `btrim(x, E' \t\n\x0B\f\r')` CHECK), an UPDATE rewriting `withdrawnAt`/`withdrawnById`/`withdrawReason` on an already-withdrawn row (evidence freeze), a withdraw beside an existing `DecisionApprovalRevision`, a direct `approved → withdrawn` UPDATE on a LEGACY approved row whose register is EMPTY (the unprovable-approval backfill class — entry admitted only from published `pending`), AND a `DecisionApprovalRevision` INSERT against a withdrawn decision — the reverse arm ALSO raced as a two-session barrier (withdraw uncommitted vs hostile insert), both orderings, exactly one side committing (the trigger's `FOR UPDATE` on the decision row) | the three triggers absent — hostile SQL accepted at baseline; a register-emptiness-only guard admitting the legacy approved row; the lock-free reverse trigger letting both sides commit |
| P9 | `countPending` and the client pending list drop the decision; the client badge clears | asserted against `decisions.query.ts:173-175` fixtures |
| P10 | a withdrawn decision is INVISIBLE to contractor/engineer/consultant AND to the client (server serialize + web selector agree); the withdrawal NOTICE (title + reason) is stripped from every non-pmc feed (`isWithdrawnDecisionNotice`); the client bell carries NO stale "awaiting approval" item for it — the pending notice is retired (stamp-based; legacy text-shape with the multiplicity guard, ambiguous rows left + reported); and a QUEUED `decision.published` push intent never reaches the client in either PROVABLE ordering — claim-after-withdraw finds the intent cancelled (the withdraw tx cancelled by subject, recorded; legacy pre-migration rows covered by the subject backfill), and cancelled-during-lease is caught by the pre-send re-check (recorded); the check→send in-flight residual is the DOCUMENTED boundary (§A.4), asserted as documentation not as a probe | `selectors.ts:32-38` negative filter leaks it; `decision-serialize.ts:69-77` has no withdrawn arm; `snapshot.service.ts:181` delivers the notice to everyone and keeps the stale pending item; the outbox relay delivering the stale approval push in either provable ordering |
| P11 | `deriveDecisionReading('withdrawn')` yields `wait` with the honest withdrawn reason, and an activity gated on the decision still refuses to start with that reason | `readiness.ts:154-165` else-branch emits "Awaiting the client's approval" |
| P12 | `decision.withdrawn` is in the shared catalog, the external-effect catalog re-seal is exact, manifest⇄contract equality holds | `external-effects.test.ts:47-74` / `decisions.contract.test.ts:24-58` RED on the missing entry |
| P13 | projection `decisions.inbox`: live == projection == rebuild across a withdraw; the rebuild emits zero events | the diagnostic comparables on the new status |
| P14 | the web outbox op replays exactly once under its persisted key; the API RESPONSE carries the withdrawal evidence (`withdrawnAt`, the withdrawer's display identity, the reason — pmc audience only) and the register renders it; the action is absent for non-pmc and for ineligible states | the op-union variant + screen state absent; `DecisionDto`/`serializeDecision` carrying no withdrawal fields — a chip with no data behind it |

### Units 4b–4d — the deferred probes, NAMED here

The full tables (red sites, staging, orderings) ship WITH the 4b–4d design in
its plan unit — but the probes themselves are named NOW (Codex, round 6: a
deferred question must bind to a probe the runner can execute at the stop, not
to a future promise). Each is a commitment the 4b–4d plan elaborates and its
implementation runs red-first:

- **4b** — P15 default-decider byte-identity; P16 member-decider authority
  through the widened route ceiling + service narrowing; P17 decider CHECKs,
  cross-project membership FK, holder columns write-once; P18 `recorded` born
  terminal with no pending surface, notice, or push; P19 the zero-option
  record files through the FULL product path; P20 a DRAFT record gates `wait`,
  a published one `na`; P21 the targeted push reaches the decider and ONLY the
  decider (user-level target); P22 the WHOLE audience follows the decider —
  bell notice, reapproval surfaces, viewer-scoped `countPending`.
- **4c** — P23 consultation round-trip, append-only, non-blank evidence; P24
  consultation moves no status and no gate verdict; P25 visibility widening
  bounded by eligibility (published-only, open-status, at request AND
  response; a withdrawn title/reason never reachable); P26 consultation
  pushes exact, including the org-admin requester; P27 the response's child
  keys make a foreign decision's option unrepresentable.
- **4d** — P28 the role in every mirror; P29 no-active-architect
  byte-identity; P29b removed-architect deactivation + the stranded-decision
  resolution; P30 forward authority, ACTIVE target, eligible states only
  (`awaiting_countersign` excluded from the generic command); P31 the
  `awaiting_countersign` lifecycle with the `finalized` register discipline
  and its own emission; P32 self-countersign as two attributed acts; P33 both
  disagreement outcomes through the open `ChangeRequest` (origin, impacts,
  the closed `withdrawChange` escape, the evidence freeze); P34 the forward
  chain's attribution, event, and the holder-mutation-only-with-forward seal;
  P35 the forward-vs-approve barrier; P36 the switch-writers barrier.
- **Round-5 obligations** — P37 `approved` DB-sealed behind countersign
  finality (no transition out of `awaiting_countersign` into `approved`
  without the finalized fact); P38 the queued-push cancellation/eligibility
  guard generalized to EVERY targeted decision push; P39 removing a
  current-holder membership refused (escape: withdraw-and-reissue in 4b,
  forward from 4d); P40 claim-time holder match on targeted pending pushes;
  P41 consultation eligibility checked UNDER the decision row lock, with the
  request-vs-withdraw barrier; P42 the finality candidate key derived over
  the ACTUAL Phase-3 provenance columns.

Ordering note: P7 sits inside 4a deliberately — the publish CAS is 4a's
neighbour-repair, and the race probe is worthless while withdraw (the reason
the window matters) does not exist.


## §F — Staging, review units, and the known docs-only constraint

**The staging, after the §B split:** this plan PR (the frame + the 4a design) →
**4a implementation** → **the 4b–4d plan unit** (docs-only, its own exact-head
review, carrying every §B obligation) → 4b → 4c → 4d, one unit per PR, each
within the standard budget (20 files / 1,500 lines). 4a first is the point: it
is the owner's live defect, its design has been finding-free since round 3, and
nothing in it depends on the 4b–4d design settling.

4a's fan-out is wide (a status is an interface; the breadth IS the
correctness) and is expected to brush the file budget.
**The enum and its readers are indivisible, so the split line cannot run between
API and web** (Codex, round 1): `DecisionStatus` is a SHARED type and the web's
`as const` maps are the very readers §A.3 enlists — an API-only first half
either fails `pnpm check` outright or loosens the type and ships exactly the
hidden/leaking states P10/P14 exist to prevent. If 4a exceeds budget, the
pre-declared split extracts the ENUM-INDEPENDENT repairs instead — the `publish`
CAS (P7) and the withdrawal-notice audience predicate wiring (P10's filter
half) land as a small preparatory PR touching no status value — and the enum
with its COMPLETE reader closure stays one unit, never mid-invariant. Each unit
lands with its packet, reproduce-first probes staged RED per §E, additive
diagnostic-first migrations only, and the tripwire pins advanced in the same PR
(§A lock-coverage gains `decisions.withdraw`; the external-effect coverage
version re-seals with each unit's events).

**This plan PR itself** set out to ship the plan + the STATUS flip to `task: 4 /
in_progress` in ONE diff (the #331 pattern). The known constraint — docs-only,
and past three finding-bearing heads the review owes a
`Review-Deferred-To-Probes` trailer the gate REFUSES from a diff touching
`docs/STATUS.md` (the PR #324 lesson `docs/STATUS.md` records) — was stated in
this paragraph from the first head, with its escape planned. **The cap was
reached and the escape is now EXECUTED, not hypothetical**: the trailer-carrying
head reverted the STATUS edit (this PR lands the plan + audit only; the trailer
defers still-open verification to `phase-6-task-4`'s own implementation stops,
where every §E probe runs red-first), and the STATUS flip to `task: 4 /
in_progress / phase_plan: <this plan>` lands as the IMMEDIATE tiny follow-up PR
after this one merges — the `phase_plan` pin is satisfied there because the plan
file already resolves on `main` at that moment. Nothing is dismissed: the place
of verification moves from prose to probes, which is the deferral mechanism's
whole design.

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
