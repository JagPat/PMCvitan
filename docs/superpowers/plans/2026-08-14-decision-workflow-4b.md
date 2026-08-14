# Decision workflow, unit 4b — the plan

**Status: PLANNING — narrowed to unit 4b at the review-lifecycle limit.**
This document began as the second half of the §B split the task-4 programme
frame (PR #335, `docs/superpowers/plans/2026-08-13-decision-workflow.md`)
pre-declared: one plan for units 4b (the per-decision decider + the
record-only issue), 4c (consultation), and 4d (the `architect` role +
forwarding + countersign). Six review rounds in (finding heads 7, 8, 6, 9, 4,
8 — thirty-four findings corrected, then eight more), the five-finding-head
lifecycle advisory fired and the convergence packet's pre-commitment bound:
**this unit narrows instead of correcting again** — the PR #335 precedent
applied at the same limit that forced it there. This document now designs
UNIT 4b ONLY, plus the seal architecture every later unit cites (§B). The 4c
and 4d designs remain readable at PR #340's head `6a53aae` and are the
pre-declared STARTING MATERIAL of their own follow-up plan units (§E), each
carrying its named round-6 obligations (§D) — nothing is dismissed. Unit 4b
implementation begins only after this plan clears its own exact-head review —
the same plan-first contract 4a satisfied (PR #337, DELIVERED AND MERGED).

## Provenance, and what is NOT re-litigated

The decisions recorded at PR #335's head `ac164c5`, in
`docs/reviews/pr-335-convergence.md`'s binding ledger, and through PR #340's
six review rounds (`docs/reviews/pr-340-convergence.md`) are **settled**:
this document carries the 4b subset forward verbatim in substance, each
decision cited with the round that forced it. Nothing established is
reopened.

4a's delivered surface is likewise settled input: the `withdrawn` terminal
status with its seal network, the audience rule (`decisionVisibleToViewer`),
the targeted-cancellation spine (`subject` + `cancelQueuedPushBySubject`),
the readiness redaction pair, and the `linkableInProject` write-path
authority. Where 4b touches these, it extends — never rewrites.

## §A — Unit 4b: the decider, and the record-only issue

### 1. The model

`Decision` gains `deciderKind` (default `'client'`; every existing row
backfills `'client'` — behavior byte-identical until a caller says otherwise)
and `deciderMembershipId` (nullable, same-project composite FK, required iff
`kind='member'`, sealed by CHECK). **The 4b contract admits
`'client' | 'pmc' | 'member' | 'none'` — `'architect'` joins the enum IN UNIT
4d WITH the role** (round 1): 4b ships before the `architect` TokenRole exists,
and a 4b-only deployment accepting an architect-decider would create decisions
no one can authenticate to see or approve. The composite FK needs a candidate
key `Membership` does not have — today it carries only `id` and
`@@unique([projectId, userId])` — so 4b adds `@@unique([projectId, id])` as an
additive orgs-owned schema change in the same PR, and the FK then makes a
cross-project membership reference unrepresentable (P17). **And the FK proves
too little on its own** (round 4 of the joint review): existence-in-project is
not standing — a direct insert can name a REMOVED membership as decider, and a
later `Membership.userId` re-key would silently re-home every named holder
to another user without touching `Decision` at all, so the holder write-once
trigger never fires while authority, counts and targeted pushes follow the
moved identity. Two seals close this: the Decision INSERT/holder-write seal
validates the named membership is ACTIVE — a standing read through the
ORGS-OWNED DB primitive under the try-advisory protocol, both defined in §B
and introduced WITH this 4b seal, reused by every later one — and
`Membership.userId` AND `Membership.projectId` join an orgs-owned identity
freeze (`projectId` round 8): a membership row is BORN bound to its user and
its project and never re-keys either — a direct project-move would strand
every decision holding it as silently as a user re-key (display identity
changes are display-column changes; a new person or a new project is a NEW
membership). All hostile shapes probed (P17/P39). Membership FACTS (active standing, held role) are
orgs-owned reads at EVERY layer: in TypeScript,
`decisionsManifest.workflowParticipants` gains `orgs` and every consumer
routes through the named orgs participant (the 7B-iii-g
`OrgsParticipant.projectRoleCandidates` precedent, beside the
`lockActiveMembership` edge 4a already declared) — never a raw
`tx.membership` read from the decisions module; at the DATABASE layer the
same boundary holds through §B.2's declared SQL primitives — a
decisions-owned trigger never SELECTs from the orgs-owned table.

The create contract exposes the decider — **and so does the shipped UI**
(this plan's round 7): a contract field no screen can set is not a product
path, and today's `IssueDecisionModal`/`issueDecision` payload carry only
question/options/location/publish. The create modal gains the decider
picker — default `client` (untouched, the payload and behavior are
byte-identical: P15's guarantee), `pmc`, a NAMED ACTIVE member (the
candidate list loaded through the orgs participant the module already
routes membership reads through), or record-only (`none`, the §A.2 zero-
option form) — so a PMC mints every decider kind through the shipped
product, never through direct API calls; probed as P16's UI arm beside the
service-layer fixtures, and P19 already walks the record form.
`approveSchema` stays
`{ optionIndex }` — the approver is server-resolved, but the AUTHORITY check
becomes: the actor IS the decider (by role or named membership), or the PMC
acting on the decider's behalf, recorded honestly — `onBehalfOf` generalizes
from the hard-coded `'client'` (`decisions.service.ts`) to the decider's
designation. **And the on-behalf record names the EXACT holder** (round 3):
a designation alone is not attributable once the holder later changes — the
PMC approves on behalf of named member A, a `change` reopens, a forward (4d)
re-homes the decision to B, and an approval act recorded as merely `member`
can no longer prove WHOSE consent it captured. The approval evidence
therefore freezes the holder TUPLE at the act — `deciderKind`, the named
`deciderMembershipId` where one exists, and the frozen display identity as
the register renders it — on the act itself: the holder columns are current
STATE, the act keeps its own history. Probed: PMC-on-behalf-of-A →
requestChange → re-approve; the FIRST act still names A (P16).
**The holder columns are WRITE-ONCE FROM PUBLICATION** (round 4 of
PR #335; the draft carve-out this plan's round 7): between 4b and 4d a
hostile update could otherwise re-home a PUBLISHED decision with no recorded
actor while authority, counts, notices and pushes follow the rewritten
holder. But an UNPUBLISHED draft is the author's private, weightless
workspace — freezing its holder at create would strand a draft whose named
member later leaves (withdraw rejects drafts; a write-once column forbids
re-pointing; the only exit would force private content to publish). So the
freeze binds WITH publication, exactly like the recorded evidence freeze:
while `publishedAt IS NULL` the author edits the holder like any other draft
field; the PUBLISH transition atomically re-validates the named holder's
ACTIVE standing under the readiness lock (a stranded draft refuses to
publish, naming the fix — edit the draft's holder, THROUGH the shipped
`decisions.updateDraft` command this unit adds (round 8): contract + service
+ the Drafts screen's edit affordance, legal only while `publishedAt IS
NULL`, covering the holder and the other draft fields — the recovery is a
product path, not a database operation, exercised in P17); from publication the
BEFORE UPDATE trigger refuses ANY holder change (no 4b service path needs
one), hostile-update probed alongside the legal draft re-point (P17); 4d
LOOSENS that trigger to exactly one opening — a change accompanied by its
same-transaction `DecisionForward` row, designed in the 4d plan unit.
**And publication itself is one-way** (round 9): keying the freeze to the
CURRENT `publishedAt` invites the two-transaction bypass — clear
`publishedAt`, re-point the holder through the now-legal draft door,
republish. `publishedAt` is therefore WRITE-ONCE for every decision (the 4a
withdrawn entry-freeze generalized): a published→draft transition is refused
by trigger for all kinds, so the draft door exists only for rows that were
NEVER published; the bypass is probed in P17. The freeze comes with the act
that gives the columns weight; the door comes with the act that justifies
it.

**The ROUTE ceiling widens with it** (round 2): `ROLE_POLICY['decision.approve']`
admits only client/pmc today, so a contractor named as decider meets a 403
before the service runs. 4b widens the approve policy to the union of possible
decider roles (the CEILING, pinned by the `route-policy.test.ts` identity walk)
and the SERVICE is the authority that narrows to the actual decider — the
ceiling-then-narrow shape the push catalog already uses — probed both ways: the
member-decider contractor approves; the same-role non-decider is refused (P16).

**Removing the CURRENT HOLDER's membership is refused — for PUBLISHED open
decisions** (round-5 obligation 3 of PR #335; the published scope this plan's
round 7): a membership that is the decider designation of any PUBLISHED OPEN
decision (`pending`, `change` — and from 4d, `awaiting_countersign`; always
`publishedAt IS NOT NULL`) cannot be removed. A private DRAFT never blocks a
removal — it is weightless, and its holder is editable until publish (above),
so the draft that names a since-removed member is fixed by editing, never by
forcing publication. **And the REOPEN path re-validates too** (round 8): the
guard cannot see an `approved` decision, so its member holder may legally
leave while it is closed — `requestChange` (`approved → change`) therefore
re-validates the holder's ACTIVE standing atomically under the readiness
lock, refusing 409 with withdraw-and-reissue named as the escape when the
holder is gone; a reopened decision can never be born holderless (P39/P22).
The refusal lives in the orgs member-removal command, which already consults
participants for standing questions; it asks the NEW decisions-owned
participant answer `decisions.holdsOpenDecisions({ membershipId, role,
projectId })` through the declared `orgs ⇄ decisions` participant channels
(cycle-exempt, both directions already exist in the module graph:
`orgs.dependsOn` includes `decisions`). **The check covers BOTH holder
designations** (round 2): a `membershipId` match alone covers named-member
holders, but a ROLE-designated holder (`client`, `pmc` — and from 4d,
`architect`) is orphaned just the same when the LAST ACTIVE member of that
role leaves; the participant therefore also answers "is this membership the
last active holder of a role named by any open decision", and removal or
role-change of that last holder is refused with the same 409. **And the DB
seal judges the same content** (round 5): the orgs-owned membership seal of
§B.2 re-judges the holder-orphaning predicate on DIRECT writes — a hostile
soft-removal or role-change that would strand an open decision's holder is
refused at the database, not only at the command. The escape: in 4b,
withdraw-and-reissue (4a ships it); from 4d, forward. Never a silent
orphaning — both designations, both layers, probed (P39).

### 2. `none` — the record-only issue

`deciderKind: 'none'` answers the owner's first question: the decision is born
PUBLISHED-or-draft as usual but in a new terminal **`recorded`** status —
filed, team-visible, approvable by nobody. Its contract relaxes `options` from
`min(2)` to `min(0)`; every other kind keeps `min(2)` — a CHOICE still needs
alternatives. **Relaxing the contract alone leaves the product path broken**
(round 1): `DecisionsService.create` derives its lead presentation from
`input.options[0]` and writes the REQUIRED `Decision.photoSwatch` from
`lead.swatch`, so `options: []` would throw before persistence. 4b reworks the
create path for the zero-option shape — the option-sourced presentation columns
become nullable-or-defaulted for a record (an additive migration + serializer
arm), the web create form supports filing without options — and the DRAFT
path publishes too (round 8): `DraftsScreen` readiness currently hard-codes
`options.length >= 2`, which would strand a saved zero-option record as
permanently unpublishable; readiness derives from the KIND (a record is
ready with zero options; every other kind keeps the two-option floor), and
P20 walks save-as-draft → publish for a record. P19 asserts the FULL path
(create → persist → serialize → register render), never contract
acceptance alone. **The create/publish side effects branch too** (round 2):
today's path unconditionally appends the "Decision awaiting approval" notice
and pushes `decision.published` at the pending audience — a false approval
demand for a record nobody can approve. For `'none'` the notice reads "Issue
recorded: <title>" (ordinary audience; deliberately NOT matching any pending
stripping shape) and the published-event push narrows to NOBODY (the
decider-routed dispatch of §A.3 with an empty decider set), probed at the bell
AND the push intent (P18). `recorded` walks the SAME reader enumeration as 4a's
§A.3: the activity gate reads `na` ("record only — no approval required") —
**for a PUBLISHED record only** (round 2): a PRIVATE draft record would
otherwise unblock a gate with evidence the team cannot see, so the recorded arm
consults the draft flag — draft → `wait` ("the linked record is unpublished —
publish it"), published → `na` — and P20 proves an activity linked to a draft
record refuses to start until publish. Pending surfaces exclude `recorded`
structurally; the register shows a RECORDED state; visibility is the ordinary
published-decision audience (a team record, not a pending approval — AUTH-02's
pending-narrowing does not apply); the `as const` reader maps force every miss
to a compile error. **`recorded` is TERMINAL and sealed like `withdrawn` — in
BOTH verbs AND in its EVIDENCE** (round 1; the DELETE arm round 2; the
evidence freeze round 6): a BEFORE UPDATE trigger refuses any transition out
of it; the 4a no-delete seal (`Decision_t4a_d_no_delete`) extends its refusal
to `recorded` rows; and — because a permanent register entry whose CONTENT can
be rewritten is not permanent — the PUBLISHED record's question and option
evidence freeze exactly like the withdrawn seal network's: title, room/space linkage, `publishedAt`, `authorId` (round 8 — a permanent
record must keep its attribution), `projectId` (round 9 — a permanent record
must stay in the register it was filed in), and the record's
`DecisionOption` rows (where any exist) are immutable once
`status='recorded'` AND published, with the DRAFT-edit path retained until
publish (an unpublished record is still the author's to fix). **And a
record can never carry approval evidence** (round 9): a coherence CHECK
requires every approval-derived column (`approvedOption`, `approvedById`,
`approver`, `onBehalfOf`) to be NULL while `status='recorded'`, on INSERT
and UPDATE — the unapprovable permanent record can neither be born with nor
later gain a forged approval surface (P18). Without the freeze, hostile SQL could retitle the filed
issue, move it, clear `publishedAt`, or replace its options while
`status='recorded'` — the register and any gate linkage no longer preserving
what was filed. All probed directly (P18): the hostile `recorded → approved`
flip, the hostile DELETE, and the hostile retitle/re-room/`publishedAt`-clear/
option-replace on a published record — with the draft edit still accepted.
**And the kind–status pair is DB-COHERENT in BOTH directions** (round 1 of
this plan's review): the member⟺membershipId CHECK alone leaves
`deciderKind='none', status='pending'` representable — a published decision
with no possible approver still driving every pending and gate surface. A
CHECK seals the pair: `deciderKind='none'` iff `status='recorded'` (a record
is never pending/approvable; no other kind may occupy `recorded`), refusing
the hostile insert AND the hostile update, probed as P18's inverse arm.

### 3. The pending audience follows the decider

Today "pending" is hard-wired to the client: `countPending`'s audience gate,
AUTH-02's pmc/client narrowing (`decision-serialize.ts`), `selectActionItems`'
`client-pending` item, the nav badge, the persisted BELL notice and its
stripping predicate (`isPendingDecisionNotice`), and the push target
`['client']` on `decision.published` (`external-effects.ts`). With a decider,
each of these routes to THE DECIDER — and "each" means ALL of them (round 2):

- **the bell feed** — the awaiting notice reaches pmc + the decider and is
  STRIPPED for everyone else (an engineer-decider sees their notice; the client
  no longer receives a demand for a decision they do not decide), probed
  decider vs same-role non-decider vs client (P22);
- **the `change` / reapproval surfaces** — `selectReapproval`, the reapprove
  action item, the readiness wording: a reopened decision is the SAME approval
  obligation with the same audience, so decider-follows covers `pending` AND
  `change`, probed through approve → requestChange → re-approve (P22);
- **`countPending` gains the VIEWER** — it counts the decisions THAT VIEWER
  decides (pmc seeing all), probed on the two-engineers-one-decider case (P22);
- **the SERVABLE projection carries the decider** (round 3) — the
  `decisions.inbox` projection path filters rows on `publishedAt`/`authorId`/
  `status` alone today, so a projection read cannot tell a named engineer-
  decider from another engineer of the same role: patched naively it either
  LEAKS the pending decision or HIDES the decider's action item. The
  projection row schema gains the decider designation (kind + the resolved
  decider USER for a named membership — the same user-level resolution the
  targeted dispatch performs), the ONE fold derives it so live == projection
  == rebuild by construction, and the read-path filter narrows on it. Probed
  on the PROJECTED slice, not only the live snapshot: the decider's item
  present, the same-role non-decider's absent, both served from the
  projection path, plus a rebuild preserving the slice (P22);
- **the approval ROUTE follows the decider too** (round 4) — the only
  approval surface today is the `client-decisions` screen, exposed by
  `screensFor()` to the `client` role alone, with `RouteBridge` bouncing a
  forbidden path back to the role home: a named engineer-decider could be
  authorized at the API and pointed at the item by the Inbox, yet clicking
  the CTA could not KEEP them on an approval surface. 4b extends approval
  surface availability to the actual decider — the decision-approval screen
  (or its in-role equivalent) is reachable for a viewer who is the decider
  of at least one open decision, the Inbox CTA lands and STAYS there, and a
  same-role non-decider still has no route. Probed as P22's route arm beside
  the audience arms.

**"Only the decider" requires a dispatch target the push spine does not have**
(round 1): the outbox persists ROLE audiences and `PushSubscription` carries no
user linkage, so a role-level push for a named-member decider would notify
every member holding that role. 4b's first deliverable is the TARGETED
dispatch — and the target is a **USER, not a membership** (round 2): an org
owner/admin operating as `pmc` legitimately has NO project `Membership` row, so
a membership-keyed target would drop them or fan out to every pmc. The push
intent gains an optional user target beside its role ceiling (a membership
designation RESOLVES to its user at dispatch; an org-admin actor already IS a
user), the subscription→user linkage is added where the owning module holds it —
**and STAGED honestly over the existing devices** (round 9): today's
`PushSubscription` rows carry no owner, and a backfill cannot invent one.
The linkage lands first (attributed opportunistically on the next
authenticated app open); the decider-targeted NARROWING activates
per-subscription only where the link exists, an unlinked device continuing
to receive exactly the ROLE-ceiling behavior it receives today — no
regression, no silent drop — until its owner reappears. P21 includes a
pre-migration subscription in both arms. The probe pair proves BOTH
directions: the target receives; a same-role non-target does NOT (P21). The static catalog names the CEILING audience and
the dispatch site narrows to the actual decider; `buildDispatchIntent`'s
mismatch refusal treats the catalog as the ceiling.

**The 4a cancellation/eligibility spine generalizes to the CLASS** (round-5
obligation 2 of PR #335): the sender's final pre-send re-check and the
queued-push cancellation-by-subject cover EVERY targeted decision push —
`decision.published` today, the decider-targeted pushes 4b adds, and the
consultation/countersign/forward pushes the later units add — not the one
event 4a shipped them for. **The shared rule is the MECHANISM, and the
predicate is PER EVENT FAMILY** (round 1): "is the target still the holder"
is the DECIDER-push predicate only — the class's normal targets are often NOT
holders (a consultee, a requester, an architect), and a holder-only check
would drop or re-target valid, actionable pushes. Each event family declares
its own "still actionable for THIS target" predicate beside its catalog
entry; 4b ships the class mechanism plus its first family: decider pushes →
the target is still the holder AND the status still demands their decision.
**And EVERY family's predicate includes the target's CURRENT project
standing** (round 6, stated here as a CLASS rule): a target whose membership
was removed — or whose authority was revoked — between enqueue and claim must
never receive decision content after revocation; the standing arm is part of
the class contract, instantiated by each unit for its families and probed
with a removal-between-enqueue-and-claim arm per family (4b's decider family
in P21/P22; the later families in their own plans). **And the claim-time
predicate speaks the same per-family language** (round-5 obligation 4 of
PR #335): the delivery claim path re-checks the family predicate at claim —
for decider pushes, a holder change committed between enqueue and claim
re-targets the delivery to the new holder or drops it with the cancellation
mark, recorded — never delivering a "decide this" demand to a displaced or
revoked target.

## §B — The seal architecture (introduced by 4b, cited by every later unit)

### 1. The try-acquire-or-refuse protocol

Every DB seal in this task family that must read CROSS-TABLE standing or
presence serializes by TRY-ACQUIRE, never by waiting in a trigger. A
row-level `FOR UPDATE` cannot serialize a FIRST activation (no row exists to
lock — the classic phantom), and a trigger that BLOCKS on the readiness
advisory lock inverts the service's lock order — a direct write holds its row
lock before its trigger runs, so it would wait on the advisory key while a
service command holding that key waits on the same row: a deadlock, not
deterministic serialization. The seal triggers therefore acquire the
`readiness:<projectId>` key (which `readiness-lock.ts` exports precisely so a
second caller takes the SAME lock, never one that merely looks like it) with
`pg_try_advisory_xact_lock`: on the SERVICE path the command already holds
the key from `lockProjectReadiness` — advisory locks are reentrant, the
try-acquire succeeds; on a DIRECT write with the key free it acquires and
HOLDS to commit, making the standing read exclusive (a service command
starting meanwhile blocks at its FIRST statement, the one sanctioned wait
point, holding no other locks); on a DIRECT write with the key CONTENDED it
REFUSES the write outright — a seal refuses, it never waits inside a trigger,
so no lock-order inversion exists. All pairings are deterministic:
service/service serializes on the blocking lock; service/hostile and
hostile/hostile resolve by try-acquire-or-refuse — and every ordering probe
uses the repository's DETERMINISTIC readiness-lock barrier discipline
(round 8): each session is held at its intended lock point and confirmed
blocked/positioned before the competing write proceeds — never a sleep —
and the probe asserts the FINAL holder-standing invariant directly, so the
try-acquire/refusal interleaving is actually exercised (P17/P39). 4b
introduces the protocol
with its decider-standing seal and binds the `Membership` writes that can
flip holder-relevant standing (activation, removal/restore — hard DELETE
included — and role change: the same set the §A lock-coverage enumeration
already binds on the service path); probed in both orderings (P17/P39).

### 2. Cross-module facts at the DB layer — owned primitives, never table reads

**A decisions-owned trigger must not SELECT from the orgs-owned `Membership`
table** (round 6): the module boundary the TypeScript participant channels
enforce does not stop at the database. Each module therefore exposes the DB
facts its seals owe other modules as OWNED, DECLARED SQL functions — the
database analogue of the participant channel, named for the owner and
registered beside the manifest's participant declarations so the boundary
tripwires can walk them:

- ORGS-owned primitives (created by an orgs migration, callable by
  decisions-owned seals): membership-is-active for a `(projectId,
  membershipId)`; **effective-role-standing** for a `(projectId, role)`
  (renamed round 8 from active-member-count, because a bare membership
  count does not model the plan's own authority rule — it counts ACTIVE
  memberships in the role PLUS, for `pmc`, owner/admin standing on the
  project's org with the same precedence as authorization, so removing the
  last PMC membership while an org owner still covers the role is NOT a
  holder-orphaning and is not refused — probed in P39); and
  **user-decision-authority for a `(projectId, userId)`** (round 7;
  operability round 9) — does this user currently hold standing that
  authorizes creating decisions on this project: an ACTIVE membership in a
  decision-creating role OR owner/admin standing on the project's org (the
  membership-less pmc case), AND the project itself is OPERABLE — the
  primitive judges `archivedAt` while holding the `Project` row lock, the
  same order `ProjectAccessService.authorize` implies, so an
  already-archived insert is refused and an archive committing concurrently
  either waits or is seen (both shapes probed, P18). The recorded-insert
  seal consumes it to validate `authorId`: a terminal `recorded` row is
  BORN permanent with no later act to catch a forged author, so a direct
  insert attributed to an unrelated or null actor must be unrepresentable
  (P18).
- DECISIONS-owned primitive (callable by the orgs-owned membership seal):
  does-any-open-decision-name-this-holder for a `(projectId, membershipId,
  role)` — the DB re-judgement of `holdsOpenDecisions`, mirroring the
  existing bidirectional `orgs ⇄ decisions` TS channel.

The orgs-owned membership seal (the `userId` identity freeze, the
holder-orphan refusal, and the try-advisory binding of standing writes) is an
ORGS-owned trigger on the orgs-owned table that calls the decisions-owned
predicate; the decisions-owned decider seal calls the orgs-owned standing
primitives. Neither module's trigger reads the other's table. Every later
unit's standing read (the architect chain presence, the forward
target/actor standing — designed in the 4d plan) uses the same primitives or
adds its own under the same ownership rule.

### 3. The uniform seal contract

Six review rounds of the joint plan each surfaced instances of ONE
generative rule; the rule is the contract, and each unit's plan carries the
table rows for the facts IT ships (this document: the 4b rows; the 4c/4d
rows travel with their plan units). Every fact table carries FIVE DB
obligations beside its zod contract and service authority:

1. **Append-only + evidence freeze** — UPDATE/DELETE sealed; every evidence
   AND discriminator column immutable, with named close-transitions as the
   only permitted mutations.
2. **Transition pairing, BOTH directions, EXACTLY ONE fact per transition** —
   where the fact records a state transition, the row commits only with its
   same-transaction transition and the transition only with its row.
3. **Actor standing** — the recorded actor must hold ACTIVE standing that
   authorizes the act, judged at the DB under §B.1's protocol through §B.2's
   primitives (the service command stays the authority; the seal is the
   hostile-path backstop).
4. **Subject eligibility** — the decision must be in exactly the states the
   act is legal in: the SAME predicate as the command CAS, re-judged by the
   seal.
5. **Same-project composite FKs** — every reference project-bound through
   the child's own `projectId`.

| 4b fact | pairing (2) | actor standing (3) | subject eligibility (4) | probes |
|---|---|---|---|---|
| `Decision` holder columns | write-once FROM PUBLICATION (draft edits legal; the 4d door comes with 4d) | named decider membership ACTIVE at publish | the kind⟺status CHECKs; the orgs-side orphan guard (published open decisions only) | P17/P18/P39 |
| `recorded` decisions | — (terminal at birth) | `authorId` validated by the orgs user-decision-authority primitive | published-record evidence frozen; draft edits retained until publish | P18/P19/P20 |

A future fact table added under this task inherits the contract by default:
omitting an obligation is a defect by construction, and each unit's review
packet walks its rows for every fact it ships.

## §C — The probe table, P15–P22 + P39

Every probe runs red-first at the unit's staged baseline (the 4a §D
discipline: an in-branch shape commit carrying contracts/enums/columns with
the behavior deliberately absent, so the probe fails on BEHAVIOR, not on a
missing symbol). Red sites name where today's behavior lives.

| probe | proves | red site / staging |
|---|---|---|
| P15 | default-decider byte-identity: with no caller opting in, every surface (approve authority, notice, push, counts, badges) behaves byte-for-byte as before the migration | the full existing decisions test surface re-run over a `deciderKind`-bearing schema; plus an explicit fixture asserting `'client'` backfill on legacy rows |
| P16 | member-decider authority: the named contractor approves through the widened ceiling; a same-role non-decider is 403/refused at the SERVICE, not the route; the PMC on-behalf approval freezes the EXACT holder tuple (kind + membershipId + display identity) on the act — after a `change` reopening and re-approval, the FIRST act still names the original holder; AND the UI arm — the create modal's decider picker mints every kind (client default byte-identical, pmc, named ACTIVE member from the participant-loaded candidates, record-only) through the shipped product | `ROLE_POLICY['decision.approve']` + `decisions.service.ts` approve authority + the on-behalf evidence columns + `IssueDecisionModal`/`issueDecision` |
| P17 | decider CHECKs (`member` ⟺ membershipId), the cross-project membership FK refusal, the holder columns write-once FROM PUBLICATION (the draft re-point legal; the hostile post-publish UPDATE refused; publish atomically re-validates the named holder's ACTIVE standing and refuses a stranded draft naming the fix), a removed-membership decider refused at publish through the orgs-owned primitive, and the `Membership.userId` identity freeze (a hostile re-key refused — a named holder can never silently move to another user) | the new columns' migration; `Membership @@unique([projectId, id])`; the §B.1 protocol + §B.2 primitives; the publish transition |
| P18 | `recorded` born terminal: no pending surface, no awaiting notice, no push intent; the "Issue recorded" notice at ordinary audience; the hostile `recorded → approved` flip AND the hostile DELETE both refused; the PUBLISHED record's evidence frozen — hostile retitle, re-room, `publishedAt`-clear and option replace/delete all refused, the DRAFT edit still accepted; the INVERSE coherence arm — `deciderKind='none'` with `status='pending'` refused by CHECK on insert AND update, and `recorded` refused for every other kind; AND the author arm — a direct `recorded` insert whose `authorId` fails the orgs user-decision-authority primitive (unrelated, null, or revoked) refused, the membership-less org-admin author accepted | `decisions.service.ts` create/publish side effects; the terminal + no-delete + evidence-freeze seals + the pair CHECK + the author-standing seal |
| P19 | the zero-option record files through the FULL product path: create → persist → serialize → register render, web form included | `DecisionsService.create` lead-presentation derivation (`input.options[0]`) |
| P20 | a DRAFT record gates `wait` ("publish it"); a published record gates `na` | the gate reader's recorded arm consulting the draft flag |
| P21 | the targeted push reaches the decider USER and only them: target receives; same-role non-target does not; the org-admin (membership-less) target receives; the decider-family standing arm — a target removed between enqueue and claim is re-targeted or dropped with the cancellation mark, never delivered | the outbox role-audience shape; the new user-target column + subscription linkage; the claim-time predicate |
| P22 | the WHOLE audience follows the decider: bell notice (decider vs same-role non-decider vs client), reapproval surfaces through approve → requestChange → re-approve, viewer-scoped `countPending` (two-engineers-one-decider), the PROJECTED slice (the `decisions.inbox` projection row carries the decider designation, the read-path filter distinguishes the named decider from a same-role non-decider — no leak, no hidden action item — and a rebuild preserves the slice), AND the ROUTE (the decision-approval surface reachable for the actual decider; the Inbox CTA lands and stays; the same-role non-decider still has no route) | `countPending`; AUTH-02 narrowing in `decision-serialize.ts`; `selectActionItems`; `isPendingDecisionNotice` stripping; the projection row schema/fold/filter; `screensFor()` + `RouteBridge` |
| P39 | removing the current-holder membership is refused for BOTH designations — the named-member holder AND the last active member of a ROLE named by a PUBLISHED open decision (role-change of that last holder refused too) — at BOTH layers: 409 through the participant on the command path, and the orgs-owned DB membership seal (calling the decisions-owned predicate primitive) refusing the hostile DIRECT soft-removal and role-change that bypass it; a non-holder membership still removes; AND the draft arm — a private draft naming the member does NOT block the removal, and the stranded draft is fixed by editing its holder, never by forced publication | the orgs member-removal command + the widened `holdsOpenDecisions` participant answer + the §B.2 membership seal |

## §D — Obligations carried to the successor plan units

PR #340's round-6 review returned eight findings; three are folded above
(the recorded evidence freeze — P18; the §B.2 ownership rule for DB-layer
membership reads; the class-level target-standing rule — §A.3). The other
five are 4c/4d design obligations. **Each is carried as a NAMED PROBE, not
prose** (this plan's round 7): the probe numbers P23–P42 are RESERVED to the
successor units (their joint-plan assignments held stable), each carried
question is bound to its probe HERE, and the successor plans elaborate the
full rows (proves / red site / staging) that these named probes execute
RED→GREEN at their unit's review stops. Nothing is dismissed:

**To the 4c plan unit** (consultation):
1. **P25c (a named arm of P25)** — the `decisions.inbox` projection carries
   the resolved CONSULTATION audience beside the decider designation (the
   projection row/fold/rebuild/filter thread); PROVES: after a consultation
   is requested, the consultee's projected slice admits exactly that
   decision, a same-role non-consultee's does not, and a rebuild preserves
   the slice — on the PROJECTED path, not only the live read.
2. **P25d (a named arm of P25)** — the response-side DB eligibility seal's
   OWN hostile probes; PROVES: a direct `DecisionConsultationResponse`
   INSERT against an ineligible decision, and one attributed to a
   non-consultee responder, are both refused at the database.
3. **P38c/P40c (named arms of P38/P40)** — the consultation push families
   instantiate the §A.3 class standing rule; PROVES: a consultee removed —
   or a requester demoted — between enqueue and claim never receives
   decision content (re-targeted or dropped with the cancellation mark).

**To the 4d plan unit** (architect, forwarding, countersign):
4. **P31b/P42b (named arms of P31/P42)** — EVERY `DecisionApprovalRevision`
   INSERT pairs with its same-transaction approval act and authorized
   decider, under an ACTIVE chain AND an INACTIVE one; PROVES: a revision
   born `finalized=true` with no approval transition on a still-`pending`
   decision is unrepresentable, so the widened finality FK can never let
   provenance trust an approval that never happened.
5. **P31c/P34b (named arms of P31/P34)** — EXACTLY ONE matching fact per
   paired transition; PROVES: two matching `DecisionForward` rows over one
   holder mutation, and two `DecisionCountersign` rows over one flip, are
   both refused. (Also absorbed into §B.3's obligation 2 for every future
   fact.)
6. **P33b (a named arm of P33)** — the `countersign_rejection`
   `ChangeRequest` joins the uniform contract as a full row; PROVES: its
   INSERT pairs bidirectionally with the exact `awaiting_countersign →
   change` transition, validated for an ACTIVE architect requester and an
   awaiting subject — a forged disagreement bundle attributed to an
   unrelated user is unrepresentable.

## §E — Staging, review units, and order

Per-unit, plan-first, sequential: **this 4b plan** (its own exact-head review
to a fresh clean +1) → **4b implementation** (one PR; folded STATUS; the
staged-red shape commit before behavior; vision-alignment statement, six-row
invariant matrix, review packet walking §B.3's rows for every fact shipped) →
**the 4c plan unit** (its own docs-only review; STARTING MATERIAL: the §B
consultation design at PR #340 head `6a53aae` + §D obligations 1–3) → **4c
implementation** → **the 4d plan unit** (STARTING MATERIAL: the §C
orchestration design at `6a53aae` + §D obligations 4–6) → **4d
implementation**. The review-efficiency budget (20 files / 1,500 lines) is
expected to HOLD for each unit; each PR argues its own case in its packet.

Plan documents stay PURELY docs-only: STATUS bookkeeping travels in its own
pull request (the deferral trailer is refused from a STATUS-touching diff —
the PR #335 two-step; `work_item` keeps the `none` sentinel while
`task_state` is an open state because `assessRunnerState` consults
`work_item` only in the `merged` branch). Past the plan-review round cap a
plan unit's heads owe `Review-Deferred-To-Probes: phase-6-task-4` per
`docs/AUTONOMOUS_LOOP.md` — the probes above are the executable deferral
targets that trailer names.

## What carries forward

- The binding ledger of `docs/reviews/pr-335-convergence.md` and the six
  reviewed rounds of `docs/reviews/pr-340-convergence.md` — every decision
  above cited with the round that forced it, none reopened.
- 4a's delivered seal network, audience rule, cancellation spine, and
  linkability authority — extended by reference, never rewritten.
- The owner's recorded intent: decisions decided by the right party, and
  issues filed without ceremony — with consultation and the architect
  following in their own pre-declared units.
