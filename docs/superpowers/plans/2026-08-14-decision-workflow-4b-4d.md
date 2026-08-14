# Decision workflow, units 4b–4d — the plan

**Status: PLANNING — this document is the second half of the §B split the
task-4 programme frame (PR #335, `docs/superpowers/plans/2026-08-13-decision-workflow.md`)
pre-declared.** It designs units 4b (the per-decision decider + the record-only
issue), 4c (consultation), and 4d (the `architect` role + forwarding +
countersign) to implementation readiness, elaborates the named probes P15–P42,
and answers the six round-5 obligations recorded in
`docs/reviews/pr-335-convergence.md`. It must clear its own exact-head review
before unit 4b implementation begins — the same plan-first contract the
programme frame satisfied for 4a, which is now DELIVERED AND MERGED (PR #337,
sixteen reviewed heads, packet `docs/reviews/phase-6-t4a-withdraw-packet.md`).

## Provenance, and what is NOT re-litigated

The programme frame narrowed at the review-lifecycle limit along the findings'
own seam: every round-3/4/5 finding landed on the 4b–4d prose while §A drew
none. That prose — rounds 1–4's design, each decision annotated with the
finding that forced it — remains readable at PR #335's head `ac164c5` and is
this document's STARTING MATERIAL. The decisions recorded there and in the
audit's binding ledger are **settled**: this plan carries them forward,
integrates the six round-5 obligations, and adds only what the obligations
require. Nothing established is reopened; where this document repeats a settled
decision it repeats it verbatim in substance, citing the round that forced it.

4a's delivered surface is likewise settled input: the `withdrawn` terminal
status with its seal network, the audience rule (`decisionVisibleToViewer`),
the targeted-cancellation spine (`subject` + `cancelQueuedPushBySubject`), the
readiness redaction pair, and the `linkableInProject` write-path authority.
Where 4b–4d touch these, they extend — never rewrite.

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
cross-project membership reference unrepresentable (P17). Membership FACTS
(active standing, held role) are orgs-owned reads:
`decisionsManifest.workflowParticipants` gains `orgs` and every consumer routes
through the named orgs participant (the 7B-iii-g
`OrgsParticipant.projectRoleCandidates` precedent, beside the
`lockActiveMembership` edge 4a already declared) — never a raw `tx.membership`
read from the decisions module.

The create contract exposes the decider; `approveSchema` stays
`{ optionIndex }` — the approver is server-resolved, but the AUTHORITY check
becomes: the actor IS the decider (by role or named membership), or the PMC
acting on the decider's behalf, recorded honestly — `onBehalfOf` generalizes
from the hard-coded `'client'` (`decisions.service.ts`) to the decider's
designation. **And the on-behalf record names the EXACT holder** (this plan's
round 3): a designation alone is not attributable once the holder later
changes — the PMC approves on behalf of named member A, a `change` reopens,
a forward re-homes the decision to B, and an approval act recorded as merely
`member` can no longer prove WHOSE consent it captured. The approval evidence
therefore freezes the holder TUPLE at the act — `deciderKind`, the named
`deciderMembershipId` where one exists, and the frozen display identity as
the register renders it — on the act itself: the holder columns are current
STATE, the act keeps its own history. Probed: PMC-on-behalf-of-A →
requestChange → forward-to-B → re-approve; the FIRST act still names A (P16).
**The holder columns are WRITE-ONCE from the day they exist**
(round 4): between 4b and 4d a hostile update could otherwise re-home a pending
decision with no recorded actor while authority, counts, notices and pushes
follow the rewritten holder. 4b ships the columns immutable-after-create (a
BEFORE UPDATE trigger refuses ANY change; no 4b service path needs one),
hostile-update probed (P17); 4d LOOSENS that trigger to exactly one opening — a
change accompanied by its same-transaction `DecisionForward` row (P34). The
freeze comes first; the door comes with the act that justifies it.

**The ROUTE ceiling widens with it** (round 2): `ROLE_POLICY['decision.approve']`
admits only client/pmc today, so a contractor named as decider meets a 403
before the service runs. 4b widens the approve policy to the union of possible
decider roles (the CEILING, pinned by the `route-policy.test.ts` identity walk)
and the SERVICE is the authority that narrows to the actual decider — the
ceiling-then-narrow shape the push catalog already uses — probed both ways: the
member-decider contractor approves; the same-role non-decider is refused (P16).

**Removing the CURRENT HOLDER's membership is refused** (round-5 obligation 3):
a membership that is the decider designation of any OPEN decision (`pending`,
`change` — and from 4d, `awaiting_countersign`) cannot be removed. The refusal
lives in the orgs member-removal command, which already consults participants
for standing questions; it asks the NEW decisions-owned participant answer
`decisions.holdsOpenDecisions({ membershipId, role, projectId })` through the
declared `orgs ⇄ decisions` participant channels (cycle-exempt, both
directions already exist in the module graph: `orgs.dependsOn` includes
`decisions`). **The check covers BOTH holder designations** (this plan's round
2): a `membershipId` match alone covers named-member holders, but a
ROLE-designated holder (`client`, `pmc` — and from 4d, `architect`, including
a forwarded-to role) is orphaned just the same when the LAST ACTIVE member of
that role leaves; the participant therefore also answers "is this membership
the last active holder of a role named by any open decision", and removal or
role-change of that last holder is refused with the same 409. The escape: in
4b, withdraw-and-reissue (4a ships it); from 4d, forward. Never a silent
orphaning — both designations probed (P39).

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
arm), the web create form supports filing without options, and P19 asserts the
FULL path (create → persist → serialize → register render), never contract
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
BOTH verbs** (round 1; the DELETE arm this plan's round 2): a BEFORE UPDATE
trigger refuses any transition out of it, and the 4a no-delete seal
(`Decision_t4a_d_no_delete`) extends its refusal to `recorded` rows — a filed
issue is a permanent register entry exactly like a withdrawal, and without the
delete arm hostile SQL could erase the record the gate and the team trust
(the sanctioned destructive resets keep their existing named-trigger bypass —
no new bypass site). Both probed directly (P18): the hostile
`recorded → approved` flip AND the hostile DELETE. **And the kind–status pair is
DB-COHERENT in BOTH directions** (this plan's round 1): the member⟺membershipId
CHECK alone leaves `deciderKind='none', status='pending'` representable — a
published decision with no possible approver still driving every pending and
gate surface. A CHECK seals the pair: `deciderKind='none'` iff
`status='recorded'` (a record is never pending/approvable; no other kind may
occupy `recorded`), refusing the hostile insert AND the hostile update, probed
as P18's inverse arm.

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
- **the SERVABLE projection carries the decider** (this plan's round 3) — the
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
  projection path, plus a rebuild preserving the slice (P22).

**"Only the decider" requires a dispatch target the push spine does not have**
(round 1): the outbox persists ROLE audiences and `PushSubscription` carries no
user linkage, so a role-level push for a named-member decider would notify
every member holding that role. 4b's first deliverable is the TARGETED
dispatch — and the target is a **USER, not a membership** (round 2): an org
owner/admin operating as `pmc` legitimately has NO project `Membership` row, so
a membership-keyed target would drop them or fan out to every pmc. The push
intent gains an optional user target beside its role ceiling (a membership
designation RESOLVES to its user at dispatch; an org-admin actor already IS a
user), the subscription→user linkage is added where the owning module holds it,
and the probe pair proves BOTH directions: the target receives; a same-role
non-target does NOT (P21). The static catalog names the CEILING audience and
the dispatch site narrows to the actual decider; `buildDispatchIntent`'s
mismatch refusal treats the catalog as the ceiling.

**The 4a cancellation/eligibility spine generalizes to the CLASS** (round-5
obligation 2): the sender's final pre-send re-check and the queued-push
cancellation-by-subject cover EVERY targeted decision push — `decision.published`
today, the decider-targeted pushes 4b adds, 4c's consultation pushes, 4d's
countersign/forward pushes — not the one event 4a shipped them for. **The
shared rule is the MECHANISM, and the predicate is PER EVENT FAMILY** (this
plan's round 1): "is the target still the holder" is the DECIDER-push
predicate only — the class's normal targets are often NOT holders
(`consultation_requested` targets the consultee, `consultation_responded` the
requester, `awaiting_countersign` the architect while the decider stays
holder), and a holder-only check would drop or re-target valid, actionable
pushes. Each event family therefore declares its own "still actionable for
THIS target" predicate beside its catalog entry: decider pushes → the target
is still the holder AND the status still demands their decision; consultation
pushes → the consultation still stands AND the decision is still open-eligible
(§B) for the widened viewer; `awaiting_countersign` → the decision still
awaits AND the target is still an ACTIVE architect; forward pushes → the
target is still the holder the forward installed. P38 probes one positive AND
one negative per family. **And the claim-time predicate speaks the same
per-family language** (round-5 obligation 4): for DECIDER pushes, a forward
committed between enqueue and claim re-targets the delivery to the new
holder — or drops it with the cancellation mark, recorded — never delivering a
"decide this" demand to a displaced holder; the other families re-check their
own predicate at claim. Probed with the forward-between-commit-and-claim
interleaving plus a consultation-claim survivor (the forward does NOT drop a
still-standing consultee push) (P40).

## §B — Unit 4c: consultation — input is not sign-off

Two labour-adjacent append-only facts, owned by decisions:
`DecisionConsultation` (**`projectId`**, decisionId, requestedById,
consulteeMembershipId, question, requestedAt) — the child carries its OWN
`projectId` (round 2: a composite FK cannot bind columns the child does not
have), and BOTH references are project-scoped through it: the composite FK onto
the `(projectId, id)` candidate key 4b adds to `Membership`, and a composite FK
onto `Decision(projectId, id)`, so a project-A consultation can never name a
project-B consultee or decision — and `DecisionConsultationResponse`
(consultationId, response text, an OPTIONAL recommended option, respondedAt;
append-only, sealed).

**The recommendation is a same-decision option REFERENCE, never a raw index**
(round 2): an index is append-only evidence bound to nothing — `3` on a
two-option decision is immutable nonsense, and an index survives option
reordering pointing somewhere else. The response stores the server-resolved
`DecisionOption` id under composite FKs constrained to the SAME decision — and
the response row carries the CHILD KEYS those FKs need (round 3): its own
`decisionId`, bound TWICE — `(consultationId, decisionId)` referencing a
`(id, decisionId)` candidate key on `DecisionConsultation`, and
`(decisionId, recommendedOptionId)` referencing a `(decisionId, id)` candidate
key on `DecisionOption` — so a response naming a foreign decision's option is
unrepresentable, hostile-probed with an out-of-range index AND a foreign
option id (P27).

**`question` and `response` are user-supplied EVIDENCE** (round 1): zod
`trim().min(1)` at the contract AND the exact repository CHECK
`btrim(x, E' \t\n\x0B\f\r') <> ''` on both columns, with P23 asserting the
whitespace-only refusal at both layers.

The PMC requests (the architect joins the requester set IN 4d with the role —
the same staging rule as the decider value); the named member responds; the
thread renders under the decision in the register and the decider's view.
Three invariants: consultation NEVER moves `status`, NEVER changes a gate
verdict (P24), and WIDENS visibility exactly one way — a consultee sees THAT
decision (and its thread) while their consultation stands, an exception added
beside AUTH-02 in `decisionVisibleToViewer`, not a rewrite of it.

**The widening has an ELIGIBILITY carve-out** (rounds 2–4): a consultation may
be requested only on a decision whose question is still OPEN — in 4c that set
is `pending` or `change` (the `awaiting_countersign` arm is ADDED BY 4d with
the status itself) **AND PUBLISHED** (round 4: status alone admits an
author-private DRAFT whose `status` is `pending`; `publishedAt IS NOT NULL`
joins the request AND response guards) — never on `withdrawn` (whose title and
reason are pmc-only; a consultation there would leak exactly what 4a hides),
`approved`, or `recorded` (nothing left to inform). Refused 409 at the service,
with the withdrawn-leak probe asserting a consultee gains NO visibility of a
withdrawn row (P25). **The RESPONSE re-checks the same eligibility at ITS
moment** (round 3): a request made while `pending` outlives the decision, and a
stale response after a withdrawal would append evidence — and push — against a
row the consultee must no longer see; refused 409, probed by
request → withdraw → late-response (P25). **And BOTH checks run UNDER the
decision row lock** (round-5 obligation 5): the eligibility read takes the
decision row's share lock inside the command transaction — the lock-before-read
rule 4a's own linkability authority follows — so a withdrawal committing
concurrently either waits or is seen; the request-vs-withdraw barrier probe
proves both orderings deterministic (P41).

Events `decision.consultation_requested` (push to the consultee) and
`decision.consultation_responded` (push to the requester) join the catalog with
the 4a re-seal discipline, riding 4b's user-targeted dispatch — the consultee
is resolved from their membership; the requester may be an org-admin USER with
no membership row, which is exactly why the target is user-keyed (P26). Both
events inherit the generalized pre-send/claim-time eligibility class of §A.3
(P38/P40). The consultee is a MEMBERSHIP — when external collaborators arrive
(6.2+), they arrive as members and this table already names them.

## §C — Unit 4d: the architect, and forwarding

### 1. The role, honestly fanned out

`architect` joins `TokenRole` and its mirrors — `auth.ts`, BOTH zod role
enums, `PushRole`, `decisionsManifest.permissions`, the membership-role comment
in `schema.prisma`, and every `ROLE_POLICY` entry the role belongs in (the
exact policy row set is the unit's FIRST deliverable — `project.read` certainly
among them, `decision.create` deliberately NOT: issuing stays the PMC's) — with
the `route-policy.test.ts` identity walk pinning whatever it says (P28). **The
fan-out includes the PRODUCT PATH that mints memberships** (this plan's round
2): the Team screen's role picker and role labels (and every web role list the
mirrors walk reaches) gain `architect`, or a PMC could deploy the role with no
UI path to add an active architect — the countersign chain then activates only
through direct API calls, which is not a shipped feature. P28's identity walk
covers the web lists beside the backend mirrors. The role is a project
MEMBERSHIP role like the other five; `worker` stays deliberately absent from
the zod allowlists. Where the controller prose already says "PMC/architect",
the allowlist finally matches the words.

### 2. Orchestration

The settled design, plus the owner's 2026-08-13 amendment, as behavior:

- **Forwarding**: an append-only `DecisionForward` chain — `projectId`,
  `decisionId`, `fromDesignation` (the DISPLACED holder), `toDesignation` (the
  new one), **`forwardedById` (the ACTOR — round 2: forward authority includes
  non-holders, so a PMC forwarding a client-held decision is recorded as the
  PMC displacing the client)**, `reason`, `at` — all immutable. The HOLDER is
  not a new concept: it is the decision's CURRENT decider designation (§A.1) —
  forwarding re-points that designation and the chain records each hop, so
  every pending surface, badge and push that "follows the decider" follows the
  forward automatically. **Forwarding EMITS** (round 2): `decision.forwarded`
  joins the catalog (`invalidate: true`, the targeted push at the NEW holder
  through §A.3's user-level dispatch), re-seal probed (P34). **The holder is
  mutable ONLY through the recorded act — and the act must MATCH the change**
  (round 3; strengthened this plan's round 1): the 4b write-once trigger
  loosens to exactly one opening — a change accompanied by a same-transaction
  `DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns
  and whose `toDesignation` EQUALS the NEW ones. Mere row presence is
  forgeable: a hostile transaction could insert a forward row naming unrelated
  designations and re-home the holder to a third member with the trigger
  satisfied — authority, counts and pushes following an unrecorded transition.
  The seal compares the transition to its evidence field-for-field;
  hostile-probed BOTH ways — no row at all, and a mismatched row (P34).
  **And the pairing is sealed in BOTH directions** (this plan's round 2): a
  `DecisionForward` INSERT is itself refused unless the SAME transaction
  carries the matching holder mutation — otherwise a direct insert fabricates
  immutable handoff evidence (`forwardedById`, `reason`) for a handoff that
  never happened, and the chain/register reports it as history. A DEFERRED
  constraint trigger checks the pair at commit from the forward side exactly
  as the holder trigger checks it from the decision side; the orphan-row
  hostile insert is probed (P34). **Forwarding is
  legal only in states the NEW HOLDER can act on** (rounds 3–4): `pending` and
  `change` ONLY, CAS'd on status; terminal states refuse, and
  `awaiting_countersign` is EXCLUDED from the generic command — that status is
  the ARCHITECT's action item, and while a countersign is pending the only
  routing moves are the architect's own (countersign, reject-back, or
  forward-on through the disagreement flow, which lands `change` and leaves the
  new holder actionable). Both refusal classes probed (P30). Forward authority:
  the current HOLDER + the PMC **+ the architect once one exists** (the
  AMENDMENT). The `reason` carries the sibling non-blank discipline (zod +
  CHECK; P34). The TARGET must be able to act (round 2): `toDesignation`
  validates through the orgs participant as an ACTIVE same-project
  member/role — a removed-target forward is 409 (P30). **And the target's
  standing is judged AT THE DB too** (this plan's round 3): the service 409
  binds only the command path — hostile SQL could insert a MATCHING forward
  row naming a removed membership (or a role with no active member) and
  re-home the holder in the same transaction; the pairing seals pass, and the
  holder-removal guard (P39) never fires because the target was ALREADY
  inactive when installed. The holder-door trigger therefore also validates
  the NEW holder's standing: a named-member `toDesignation` must reference an
  ACTIVE same-project membership (the composite FK pins existence and
  project; ACTIVE standing is the trigger's read), a role `toDesignation`
  must have at least one ACTIVE member of that role — the standing read
  riding the same advisory-lock protocol as the chain-presence read (below),
  so it cannot race a concurrent removal. Hostile-probed: a matching forward
  row to a removed membership AND to an empty role, both refused (P34).
  **Forwarding SERIALIZES
  against approval and countersign** (round 1): each of
  approve/countersign/forward takes the decision row's lock and re-checks the
  holder INSIDE the transaction, so the loser of either ordering is a
  deterministic 409 — barrier-probed in BOTH orderings (P35).
- **No chain until an architect exists — and "exists" means an ACTIVE
  membership** (round 1): rows are soft-removed, so mere presence would leave
  the chain armed after the only architect left. The switch is "an ACTIVE
  architect membership exists", read through the orgs participant. **The
  switch's WRITERS serialize with its readers** (round 2):
  approve/countersign/forward read the switch under `lockProjectReadiness`, and
  the orgs-side mutations that can flip architect presence (role update,
  removal/restore) take the SAME lock when the role entering or leaving is
  `architect`, joining the §A lock-coverage enumeration. A
  role-change-vs-approve barrier probe covers activation AND deactivation in
  both orderings (P36). A project that removes its only architect DEACTIVATES
  the chain for NEW approvals; a decision already `awaiting_countersign` is
  NEVER auto-flipped. **The resolution is a NAMED command, not a promise**
  (this plan's round 1 — the concrete interleaving: approve →
  `awaiting_countersign` → the last architect leaves; generic forwarding
  refuses that status and countersign needs an architect, so without a defined
  command the decision is gate-`wait` forever): the PMC-only
  `decisions.resolveStrandedCountersign`, legal ONLY while `status =
  'awaiting_countersign'` AND no active architect membership exists (both
  re-checked under the decision row lock + `lockProjectReadiness` — the switch
  serialization of P36 covers an architect re-appearing mid-command), with two
  explicit attributed outcomes — **and the resolution is itself a REGISTER
  FACT, not a log line** (this plan's round 3): the append-only
  `DecisionStrandedResolution` table (`projectId`, `decisionId`, the exact
  head `revisionId` resolved, `outcome: 'completed' | 'returned'`,
  `resolvedById` + frozen display name, `reason`, `at`; same-project
  composite FKs; immutable; UNIQUE per `(projectId, decisionId, revisionId)`
  — a decision re-stranded on a LATER revision resolves again, the same
  revision never twice). **(a) COMPLETE under the no-chain rule** — the
  head revision's `finalized` flips true and the decision moves to `approved`
  in the SAME transaction as the resolution row with outcome `'completed'`,
  emitting the real `decision.approved`; **(b) RETURN to the decider** — the
  decision moves to `change` with a same-transaction open `ChangeRequest`
  carrying origin `countersign_rejection` and the PMC's reason, paired with
  the resolution row with outcome `'returned'`, so the existing machinery
  demands a fresh approval (which, under the now-INACTIVE chain, lands
  `approved` directly) and the closed `withdrawChange` escape stays closed.
  The reverse holds too: a `DecisionStrandedResolution` INSERT commits only
  with its matching same-transaction transition (the deferred-pairing
  discipline of the forward door). Neither outcome touches `pending`.
  Probed end-to-end in P29b: both outcomes, the refusal while an architect is
  still active, and the architect-reappears race (P29 no-architect-ever
  byte-identity; P29b removed-architect + stranded-decision resolution).
- **Countersign, and the state that carries it** (round 1): under an active
  chain, the decider's approval writes its `DecisionApprovalRevision` and moves
  the decision to **`awaiting_countersign`** (the third and last new
  `DecisionStatus` value, walking the 4a §A.3 reader table: gate `wait` — work
  must not start on an uncountersigned approval; pending surfaces show it to
  the ARCHITECT as their action item; withdraw refuses it — an approval act
  exists, which the never-approved DB seal also enforces). **A provisional
  approval must not be TRUSTABLE as a final one** (round 3): the register is a
  provenance TARGET, so the row carries `finalized` — born `true` outside a
  chain (today's behavior byte-identical), born `false` under a chain, flipped
  `true` by the countersign as its ONE permitted transition, trigger-sealed.
  **And the countersign fact is a ROW, not a boolean** (this plan's round 2):
  "flipped by the countersign" is unenforceable while the countersign has no
  shape of its own — hostile SQL could flip `finalized` and approve, leaving
  finality with no separately attributed act behind it. The second register
  act is therefore a concrete append-only `DecisionCountersign` table
  (`projectId`, `decisionId`, the exact `revisionId` countersigned,
  `countersignedById` + frozen display name, `at`; composite FKs same-project,
  immutable like the register), and the `finalized` false→true flip is
  trigger-PAIRED to a same-transaction pairing fact for that exact
  revision — the `DecisionCountersign` row (the chain path), or the
  `DecisionStrandedResolution` row with outcome `'completed'` (the ONLY
  other legal finalizer — the PMC's stranded resolution, above) — the
  forward-door discipline applied to finality. A finalized-only flip with
  NEITHER fact is unrepresentable, probed directly (P31). **And the pairing is sealed from the countersign side
  too, making the act ATOMIC** (this plan's round 3): pairing only the flip
  leaves the SPLIT act representable — hostile SQL inserts the countersign
  row and flips the revision finalized while the decision stays
  `awaiting_countersign`, and a LATER direct status update leans on that
  pre-existing row, reaching `approved` without the countersign command's
  atomic status change, event and push. A DEFERRED reverse seal therefore
  refuses a `DecisionCountersign` INSERT unless the SAME transaction carries
  BOTH the finalized flip on that exact revision AND the decision's
  `awaiting_countersign → approved` transition — row, flip and status are
  ONE transaction or none. The orphan countersign row (no same-tx flip, no
  same-tx transition) and the split two-transaction replay are both
  hostile-probed (P31).
  **The transition EMITS its own truth** (round 3): `decision.awaiting_countersign`
  joins the catalog (`invalidate: true`, targeted push at the ARCHITECT); the
  countersign emits the real `decision.approved`; the re-seal chain is 4a's
  (P31). The countersign is a second, separately-attributed register act
  referencing the exact revision; a SELF-countersign (architect is also the
  decider) is TWO explicit acts under two idempotency keys (P32). `pending`
  stays unreachable after any approval act, so 4a's eligibility proof survives
  4d intact.
- **EVERY entry into `approved` is DB-SEALED behind the chain** (round-5
  obligation 1; widened this plan's round 1; serialized and made precise this
  plan's round 2): sealing only the `awaiting_countersign → approved` edge
  leaves the direct road open — hostile SQL under an ACTIVE chain could mark
  the head revision finalized and move `pending`/`change` straight to
  `approved`, never traversing the awaiting state. The BEFORE UPDATE trigger
  therefore judges ANY transition INTO `approved`, with THREE precisions:
  **(i) the presence read SERIALIZES — by TRY-ACQUIRE, never by waiting in
  a trigger** (restated this plan's round 3): a row-level `FOR UPDATE` on the
  architect memberships cannot serialize a FIRST activation (no architect row
  exists to lock — the classic phantom), and a trigger that BLOCKS on the
  readiness advisory lock inverts the service's lock order — a direct
  `Membership` UPDATE holds its row lock before its trigger runs, so it would
  wait on the advisory key while a service command holding that key waits on
  the same row: a deadlock, not the deterministic serialization P36 promises.
  The seal triggers therefore acquire the `readiness:<projectId>` key (which
  `readiness-lock.ts` exports precisely so a second caller takes the SAME
  lock, never one that merely looks like it) with
  `pg_try_advisory_xact_lock`: on the SERVICE path the command already holds
  the key from `lockProjectReadiness` — advisory locks are reentrant, the
  try-acquire succeeds; on a DIRECT write with the key free it acquires and
  HOLDS to commit, making the presence read exclusive (a service command
  starting meanwhile blocks at its FIRST statement, the one sanctioned wait
  point, holding no other locks); on a DIRECT write with the key CONTENDED it
  REFUSES the write outright — a seal refuses, it never waits inside a
  trigger, so no lock-order inversion exists. The same protocol binds the
  `Membership` writes that can flip holder-relevant standing (activation,
  removal/restore — hard DELETE included — and role change: the same set the
  §A lock-coverage enumeration already binds on the service path) and every
  seal-trigger cross-table standing read (the chain presence here, the
  forward target standing above). All four pairings are deterministic —
  service/service serializes on the blocking lock (P36 unchanged),
  service/hostile and hostile/hostile resolve by try-acquire-or-refuse —
  probed in both orderings beside the service-path P36 races. **(ii) with the
  chain ACTIVE**, the legal entries are: FROM `awaiting_countersign` WITH the
  SAME-transaction `DecisionCountersign` row finalizing the head revision
  (the attributed fact, not the boolean — same-transaction, because the
  countersign act is atomic per its reverse seal; a prior-transaction row is
  exactly the split act that seal forbids); or FROM `change` as the
  standard `withdrawChange` RESTORATION — the open request is `origin =
  'standard'` AND the head revision is ALREADY `finalized = true` from its
  original countersign (the ordinary correction path this seal must not
  strand); `pending → approved` and any `change → approved` on an unfinalized
  head or a `countersign_rejection` request are refused outright. **(iii)
  with the chain INACTIVE, the direct road is NARROW** (narrowed this plan's
  round 3): direct approval stays legal only FROM `pending` or `change` — the
  approvals born under no chain, today's behavior byte-identical. An
  `awaiting_countersign` decision was born under a chain, so its exit
  DEMANDS paired evidence even after the last architect leaves: the same-tx
  `DecisionCountersign` row, or the same-tx `DecisionStrandedResolution`
  row with outcome `'completed'` (the PMC command's fact) — a bare hostile
  `awaiting_countersign → approved` flip under an inactive chain is refused,
  closing the stranded bypass that would end a countersign-required approval
  with no resolution evidence. Probed: the direct `pending → approved`
  hostile flip under an active chain, the finalized-boolean-only flip, the
  stale awaiting-flip without the countersign row, the bare awaiting-flip
  under an INACTIVE chain (refused without the resolution fact), the
  standard restoration PASSING, the rejection-request restoration REFUSED,
  and the activation-vs-approval barrier (P37).
- **The finality key, stated exactly** (round-5 obligation 6): the existing
  Phase-3/4 provenance rows (`MaterialRequirementSpec`, `LabourRequirementSpec`)
  FK onto the register's candidate key
  `(projectId, decisionId, version, optionKey)`
  (`DecisionApprovalRevision_provenance_target_key`). The finality pin
  therefore WIDENS that key: the register gains
  `@@unique([projectId, decisionId, version, optionKey, finalized])`, each
  provenance row gains an immutable `revisionFinalized` column CHECK-pinned
  `true`, and the composite FK re-targets the widened key — the
  `PurchaseOrder.comparisonStatus` precedent verbatim, so provenance naming an
  unfinalized revision is UNREPRESENTABLE and a `finalized → false` flip on a
  referenced row is refused by the FK itself. The migration is additive and
  backfills `finalized = true` on every existing row (every pre-4d approval is
  final by definition — today's behavior). Hostile probes: provenance onto an
  unfinalized revision; the finalized→false flip under reference (P42, with
  P31's lifecycle).
- **Disagreement — the `change` state's OWN machinery honored** (round 2):
  BOTH disagreement outcomes land in `change` AND create the open
  `ChangeRequest` in the same transaction, requested by the architect with the
  disagreement reason. **The request carries its ORIGIN, and the ordinary
  escape hatch is closed for it** (round 3): `ChangeRequest` gains an immutable
  `origin: 'standard' | 'countersign_rejection'` (additive, default
  `'standard'`) — the existing `withdrawChange` restores `change → approved`,
  which on a disagreement request would complete an approval WITHOUT its
  countersign, so `withdrawChange` refuses `countersign_rejection` requests
  with a 409 naming re-approval as the only way forward (P33). **The request's
  EVIDENCE freezes with its origin — and with its DECISION** (round 4;
  `decisionId` this plan's round 2): the freeze trigger covers `decisionId`,
  `reason`, `costImpact`, `timeImpactDays` and `requestedById` for EVERY
  `ChangeRequest` row (the class, not the instance), with the close
  transitions as the only permitted mutations — an open request re-pointed at
  another decision would strip the change-state decision of the one open
  request its machinery requires while attaching the reason to the wrong
  register entry; the re-point is probed hostile (P33). The disagreement command accepts the
  impacts as OPTIONAL inputs defaulting to 0 (round 3). The two paths:
  **REJECT BACK** keeps the original decider as holder — they re-approve and
  the chain runs again; **FORWARD ON** re-points the holder to the decider the
  architect names (validated active) — the new holder finds an actionable
  change-state decision, re-approves, and the chain runs again. Neither path
  returns to `pending`; neither erases the approval act it answers; and
  approve-from-`change` under an ACTIVE chain lands `awaiting_countersign`
  exactly like approve-from-`pending`. Probed end to end (P33).

The unit writes only decisions-owned TABLES — its one foreign CODE change is
the readiness lock joining the orgs role mutations (an edit the orgs module
makes to its own commands) — and the one foreign fact it needs is DECLARED:
membership truth is orgs-owned, routed through the named participant API from
4b on (the P5 layering lesson of `pr-324-convergence.md`, applied up front).

## §D — The probe tables, P15–P42

Every probe runs red-first at its unit's staged baseline (the 4a §D
discipline: an in-branch shape commit carrying contracts/enums/columns with the
behavior deliberately absent, so the probe fails on BEHAVIOR, not on a missing
symbol). Red sites name where today's behavior lives.

### Unit 4b

| probe | proves | red site / staging |
|---|---|---|
| P15 | default-decider byte-identity: with no caller opting in, every surface (approve authority, notice, push, counts, badges) behaves byte-for-byte as before the migration | the full existing decisions test surface re-run over a `deciderKind`-bearing schema; plus an explicit fixture asserting `'client'` backfill on legacy rows |
| P16 | member-decider authority: the named contractor approves through the widened ceiling; a same-role non-decider is 403/refused at the SERVICE, not the route; the PMC on-behalf approval freezes the EXACT holder tuple (kind + membershipId + display identity) on the act — after change → forward-to-B → re-approve, the FIRST act still names A | `ROLE_POLICY['decision.approve']` + `decisions.service.ts` approve authority + the on-behalf evidence columns |
| P17 | decider CHECKs (`member` ⟺ membershipId), the cross-project membership FK refusal, and the holder columns write-once (hostile UPDATE refused) | the new columns' migration; `Membership @@unique([projectId, id])` |
| P18 | `recorded` born terminal: no pending surface, no awaiting notice, no push intent; the "Issue recorded" notice at ordinary audience; the hostile `recorded → approved` flip AND the hostile DELETE both refused by trigger; the INVERSE coherence arm — `deciderKind='none'` with `status='pending'` refused by CHECK on insert AND update, and `recorded` refused for every other kind | `decisions.service.ts` create/publish side effects; the terminal + no-delete seals + the pair CHECK |
| P19 | the zero-option record files through the FULL product path: create → persist → serialize → register render, web form included | `DecisionsService.create` lead-presentation derivation (`input.options[0]`) |
| P20 | a DRAFT record gates `wait` ("publish it"); a published record gates `na` | the gate reader's recorded arm consulting the draft flag |
| P21 | the targeted push reaches the decider USER and only them: target receives; same-role non-target does not; the org-admin (membership-less) target receives | the outbox role-audience shape; the new user-target column + subscription linkage |
| P22 | the WHOLE audience follows the decider: bell notice (decider vs same-role non-decider vs client), reapproval surfaces through approve → requestChange → re-approve, viewer-scoped `countPending` (two-engineers-one-decider), AND the PROJECTED slice — the `decisions.inbox` projection row carries the decider designation, the read-path filter distinguishes the named decider from a same-role non-decider (no leak, no hidden action item), and a rebuild preserves the slice | `countPending`; AUTH-02 narrowing in `decision-serialize.ts`; `selectActionItems`; `isPendingDecisionNotice` stripping; the `decisions.inbox` projection row schema/fold/filter |
| P39 | removing the current-holder membership is refused 409 through the participant for BOTH designations — the named-member holder AND the last active member of a ROLE named by an open decision (role-change of that last holder refused too); a non-holder membership still removes | the orgs member-removal command + the widened `holdsOpenDecisions` participant answer |

### Unit 4c

| probe | proves | red site / staging |
|---|---|---|
| P23 | consultation round-trip: request → respond, append-only (UPDATE/DELETE sealed), non-blank evidence refused at zod AND the CHECK | the two new tables' migration + contracts |
| P24 | consultation moves NO status and NO gate verdict — before/after snapshots byte-equal | `DecisionsService` status CAS surface; the gate reader |
| P25 | visibility widening bounded by eligibility: published-only + open-status at request AND response; the withdrawn-leak refusal (no title/reason reachable); request → withdraw → late-response refused 409 | `decisionVisibleToViewer`; the request/response guards |
| P26 | consultation pushes exact: consultee push on request, requester push on response — including the org-admin requester with no membership row | the user-target dispatch of P21 |
| P27 | the response's child keys make a foreign decision's option unrepresentable: out-of-range index refused at the contract; a foreign option id refused by the composite FK | the response-row candidate keys |
| P41 | eligibility is checked UNDER the decision row lock: the request-vs-withdraw barrier is deterministic in both orderings (request-first → withdraw sees the widening it must revoke nothing for; withdraw-first → request 409) | the consultation command's lock acquisition |

### Unit 4d

| probe | proves | red site / staging |
|---|---|---|
| P28 | the role in every mirror: TokenRole, both zod enums, PushRole, policy rows, AND the web team-management role pickers/labels — the identity walk pins the set; a membership with the new role is mintable through the shipped UI | `types.ts`, `contracts.ts`, `external-effects.ts`, `ROLE_POLICY`, the Team screen role lists |
| P29 | no-active-architect byte-identity: with no architect membership ever, approve lands `approved` directly — the whole 4b/4c surface byte-identical | the chain switch |
| P29b | removed-architect deactivation + the stranded decision: the chain deactivates for NEW approvals; `decisions.resolveStrandedCountersign` drives BOTH outcomes (complete-under-no-chain → `approved` with finality + emission; return-to-decider → `change` with the origin-stamped open request), each writing its append-only `DecisionStrandedResolution` fact (UNIQUE per revision; the orphan-fact insert refused by the reverse pairing), end-to-end through re-approval; the bare hostile `awaiting_countersign → approved` flip under the INACTIVE chain refused without the fact; refused while an architect is still active; the architect-reappears race deterministic | the new resolution command + its fact table + the switch |
| P30 | forward authority (holder/PMC/architect), ACTIVE target only, eligible states only — terminal AND `awaiting_countersign` refusals both probed | the forward command |
| P31 | the `awaiting_countersign` lifecycle: approval under a chain lands it with `finalized=false`; the countersign is ONE atomic act — the attributed `DecisionCountersign` ROW + the finality flip + the `awaiting_countersign → approved` transition in one transaction, sealed from BOTH sides (the boolean-only hostile flip refused; the orphan countersign row refused at commit by the deferred reverse seal; the split two-transaction replay refused) + emits `decision.approved`; `decision.awaiting_countersign` emits at entry with the architect-targeted push | the approve CAS; the new countersign table + its reverse seal; the catalog |
| P32 | self-countersign is TWO attributed acts under two idempotency keys — one combined act is refused | the countersign command |
| P33 | both disagreement outcomes: origin-stamped open `ChangeRequest`, `withdrawChange` refusal on `countersign_rejection`, the class-wide evidence freeze INCLUDING `decisionId` (the hostile re-point to another decision refused), impacts rendered, reject-back AND forward-on driven through re-approval to completion | the `ChangeRequest` machinery |
| P34 | the forward chain: attribution (actor vs displaced holder), the `decision.forwarded` emission + re-seal, non-blank reason, the PAIRING sealed in BOTH directions — hostile holder UPDATE refused with NO same-tx forward row AND with a MISMATCHED one; a hostile ORPHAN `DecisionForward` insert (no same-tx holder mutation) refused by the deferred reverse seal — and the TARGET's standing judged at the DB: a MATCHING forward row naming a removed membership or an empty role refused by the holder-door standing read | the 4b write-once trigger's one door + the reverse constraint trigger + the target-standing read |
| P35 | the forward-vs-approve barrier: both orderings deterministic, exactly one surviving outcome, a coherent holder | the row-lock serialization |
| P36 | the switch-writers barrier: architect role-change vs approve, activation AND deactivation, both orderings | `lockProjectReadiness` on the orgs role mutations |
| P37 | EVERY entry into `approved` sealed behind the chain, SERIALIZED by try-acquire-or-refuse: under an ACTIVE chain the direct `pending → approved` hostile flip refused, the finalized-boolean-only flip refused, the awaiting-flip without the SAME-TX countersign ROW refused, the standard `withdrawChange` restoration (finalized head, `standard` open request) PASSES, the `countersign_rejection` restoration refused; under an INACTIVE chain direct approval legal ONLY from `pending`/`change` — the bare awaiting-flip refused without the stranded-resolution fact; the first-architect-activation-vs-approval barrier deterministic in both orderings (the seal triggers `pg_try_advisory_xact_lock` the readiness key — reentrant on the service path, hold-to-commit when free, REFUSE when contended — never blocking inside a trigger, so no lock-order deadlock) | the new status-transition seal + the try-advisory protocol on every seal-trigger standing read |
| P38 | the pre-send eligibility guard generalized to EVERY targeted decision push through PER-EVENT-FAMILY predicates (decider→holder+status; consultation→standing+open-eligible; countersign→awaiting+active architect; forward→installed holder): one positive AND one negative probed per family — a valid consultee push is NOT dropped by the decider predicate | the 4a pre-send re-check, generalized per family |
| P40 | claim-time per-family re-check: a forward between commit and claim re-targets or drops the pending DECIDER push, recorded — the displaced holder is never notified to decide — while a still-standing consultee push SURVIVES the same forward | the delivery claim path |
| P42 | the finality candidate key over the ACTUAL provenance columns: provenance onto an unfinalized revision unrepresentable; `finalized → false` under reference refused by the FK; the additive backfill leaves every legacy row `finalized=true` | `DecisionApprovalRevision_provenance_target_key` + the two spec FKs |

## §E — Staging, review units, and order

One unit per PR, in order **4b → 4c → 4d**, each: the folded-STATUS convention;
the staged-red shape commit before behavior (the 4a §D discipline); the
vision-alignment statement, six-row invariant matrix, and review packet; its
own exact-head review to a fresh clean +1 before the next unit begins. 4c
depends on 4b's targeted dispatch and `Membership(projectId, id)` candidate
key; 4d depends on both and loosens 4b's holder freeze. The review-efficiency
budget (20 files / 1,500 lines) is expected to HOLD for 4c; 4b and 4d carry
reader enumerations that may justify the marker — each PR argues its own case
in its packet, never by reference to this sentence.

This plan document itself is a DOCS-ONLY review unit — and it stays PURELY
docs-only: the STATUS bookkeeping travels in its OWN pull request (this plan's
round 1 — the deferral trailer is refused from a STATUS-touching diff, the
exact two-step PR #335 was forced into; the split is made up front this time,
and STATUS keeps the `work_item: none` sentinel while `task_state` is an open
state, because `assessRunnerState` consults `work_item` only in the `merged`
branch). Past the plan-review round cap this unit's heads owe
`Review-Deferred-To-Probes: phase-6-task-4` per `docs/AUTONOMOUS_LOOP.md` —
the probes above are exactly the executable deferral targets that trailer
names.

## What carries forward

- The binding ledger of `docs/reviews/pr-335-convergence.md` — every decision
  above annotated with its round is carried FROM that ledger, none reopened.
- 4a's delivered seal network, audience rule, cancellation spine, and
  linkability authority — extended by reference, never rewritten.
- The owner's recorded intent: decisions decided by the right party, issues
  filed without ceremony, consultation that informs without gating, and an
  architect who countersigns without becoming a bottleneck nobody can route
  around.
