# Decision workflow, unit 4c — consultation: the plan

**Status: PLANNING — this is the docs-only 4c plan unit the merged 4b plan's
§E order requires** (`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`
§E: "the 4c plan unit — its own docs-only review; STARTING MATERIAL: the §B
consultation design at PR #340 head `6a53aae` + §D obligations 1–3 — → 4c
implementation"). It must clear its own exact-head review to a fresh clean +1
before 4c implementation begins — the same plan-first contract that preceded
4a and 4b, both now DELIVERED AND CLEARED (4a: PR #337; 4b: PR #468 merged at
`main` `fe9df58d` after the eleven-round lineage #463→#468, packet
`docs/reviews/phase-6-t4b-decider-packet.md`).

## Provenance, and what is NOT re-litigated

The STARTING MATERIAL is the §B consultation design at PR #340 head `6a53aae`
(`docs/superpowers/plans/2026-08-14-decision-workflow-4b-4d.md` there, §B +
the unit-4c probe table in its §D), carried here in substance with each
decision's forcing round annotated — none reopened. The binding ledgers
(`docs/reviews/pr-335-convergence.md`, `docs/reviews/pr-340-convergence.md`)
stand; the merged 4b plan's §D carries obligations 1–3 to THIS unit as named
probes (P25c, P25d, P38c/P40c), elaborated to full rows in §C below. Nothing
is dismissed and nothing settled is redesigned.

4b's DELIVERED surface is settled input, and this plan is written against what
actually merged (not the pre-delivery sketch):

- the decider model (`deciderKind` client/pmc/member/none, the holder freeze
  from publication, `decisions.updateDraft` as the drafting door) and the
  `Membership @@unique([projectId, id])` candidate key 4c's composite FKs bind;
- the user-TARGETED push spine: subscription↔user linkage with credential
  version + token expiry, the project-scoped sign-out AND persona-switch
  unlink, `notifyTargetedUser` through the orgs-owned `sessionStillValid`,
  and the catalog-declared claim-time predicate (`deciderPushTarget` shape);
- the §B.1 try-acquire-or-refuse protocol (`phase6_try_readiness`) with the
  round-8 KEY-BEFORE-JUDGEMENT rule: a seal takes its serialization key BEFORE
  consulting row existence, never after a prefilter that concurrent
  uncommitted writes can empty;
- the §B.2 owned SQL primitives (`phase6_membership_is_active`,
  `phase6_effective_role_standing`, `phase6_user_decision_authority`) — DB
  seals ask cross-module questions through these, never raw joins invented
  per-seal;
- the round-11 LIVE-STANDING rule: an act's authorizing role is re-validated
  inside the transaction via `OrgsParticipant.hasProjectRoleStanding` with
  `forUpdate` — a guard-passed JWT role is never trusted at write time;
- `decisionVisibleToViewer` + the `decisions.inbox` projection thread
  (row/fold/rebuild/filter) that P22 delivered, which P25c extends.

## §A — The design (the §B starting material, carried)

Two labour-adjacent append-only facts, owned by decisions:
`DecisionConsultation` (**`projectId`**, decisionId, requestedById,
consulteeMembershipId, **`consulteeUserId`** — the consultee's USER
identity SNAPSHOT at request time under the lock, review round 3: the
membership row's `userId` is mutable in place (the delivered
`Membership_t4b2_holder_guard` ignores a `userId` re-key when role and
status are unchanged), so a consultation recording only the membership id
would let an alternate writer re-key that membership to a different user
who then inherits the consultation's visibility and response authority
while every FK stays valid; the visibility widening and the response
authority are judged against this SNAPSHOT, so a post-request re-key
STRANDS the consultation (nobody inherits it — the pmc re-requests)
rather than silently transferring it, hostile-probed by
request → re-key membership → the re-keyed user gains NO visibility and
their response insert is refused (P25/P25d) — question, requestedAt) —
the child carries its OWN
`projectId` (round 2: a composite FK cannot bind columns the child does not
have), and BOTH references are project-scoped through it: the composite FK
onto the `(projectId, id)` candidate key 4b added to `Membership`, and a
composite FK onto `Decision(projectId, id)`, so a project-A consultation can
never name a project-B consultee or decision — and
`DecisionConsultationResponse` (**`projectId`** — the response carries its
OWN project key exactly as the consultation does, review round 2: the carried
uniform seal contract binds EVERY fact reference through the child's own
project column, and a response without one would leave its FK tuples
project-unbound — consultationId, **`respondedById`** — the
RECORDED responder, review round 1: without a recorded actor on the response
row the P25d non-consultee seal has nothing to compare against the named
consultee, and a raw writer could forge advice presented forever as the
member's own; the command populates it from the authenticated caller, the
response-side INSERT seal compares it with the consultation's SNAPSHOT
`consulteeUserId` (review round 3 — never the membership's CURRENT
`userId`, which a re-key can change) AND requires the named membership to
still be active and still resolve to that snapshot user, and it sits
inside the immutable evidence set the append-only
seal covers — response text, an OPTIONAL recommended option, respondedAt;
append-only, sealed — and ONE per consultation, PR #340 round 5: a UNIQUE
constraint on `consultationId` makes a second response unrepresentable — readers model a singular response, and
two contradictory immutable recommendations with a doubled
`consultation_responded` push must not exist — with the command returning a
deterministic 409 on a repeat under a different idempotency key; the
duplicate service path AND the direct duplicate insert are probed, P23).

**The recommendation is a same-decision option REFERENCE, never a raw index**
(round 2): an index is append-only evidence bound to nothing — `3` on a
two-option decision is immutable nonsense, and an index survives option
reordering pointing somewhere else. The response stores the server-resolved
`DecisionOption` id under composite FKs constrained to the SAME decision —
and the response row carries the CHILD KEYS those FKs need (round 3): its own
`decisionId`, bound TWICE — `(projectId, consultationId, decisionId)`
referencing a `(projectId, id, decisionId)` candidate key on
`DecisionConsultation` (a NEW table — 4c-i defines any key it needs; the
tuple carries the response's own `projectId` per the round-2 uniform seal
contract), and `(decisionId, recommendedOptionId)` referencing a
`(decisionId, id)` candidate key on `DecisionOption` — the option tuple is
DELIBERATELY project-less (review round 3): `DecisionOption` is an EXISTING
table with NO `projectId` column, so a `(projectId, decisionId, id)` key is
unrealizable inside 4c-i's dark scope (adding the column would demand a
backfill, old-writer compatibility, and re-cover of the delivered option
evidence seals — none of which a dark migration may do), and it is also
UNNEEDED: the response's project↔decision pairing is already pinned by its
consultation FK, whose parent's own `(projectId, decisionId)` FK onto
`Decision(projectId, id)` makes a cross-project decision unrepresentable —
so same-decision binding on the option completes the chain transitively.
4c-i ADDS the `(decisionId, id)` UNIQUE index on `DecisionOption` as the
FK's supporting candidate key — additive and vacuously satisfiable (`id`
alone is already unique, so it can reject no existing or future row) with
no writer change, exactly the shape of 4b's `Membership (projectId, id)`
key. A response naming a foreign decision's
option — or ANY cross-project tuple — is unrepresentable, hostile-probed
with an out-of-range index AND a
foreign option id (P27). A consultation on a RECORD cannot arise (records are
ineligible below), so the option reference is always against a choice's 2–4
frozen-after-publication options.

**`question` and `response` are user-supplied EVIDENCE** (round 1): zod
`trim().min(1)` at the contract AND the exact repository CHECK
`btrim(x, E' \t\n\x0B\f\r') <> ''` on both columns — **and both columns are
`NOT NULL`** (review round 4: a CHECK over NULL evaluates to UNKNOWN and
PASSES, so the btrim guard alone would let a direct insert commit an
append-only consultation or response with no evidence text at all) — with
P23 asserting the whitespace-only refusal at both layers AND the null
direct insert refused at the database (a 4c-i hostile probe beside the
whitespace one).

**Append-only means UPDATE, DELETE, AND TRUNCATE** (review round 3):
PostgreSQL row triggers never fire for `TRUNCATE`, so row-level seals alone
leave `TRUNCATE "DecisionConsultationResponse"` free to erase every
immutable response — and `TRUNCATE "DecisionConsultation" CASCADE` the
whole register — while the decisions stand. Both new tables carry NAMED
statement-level no-truncate seals (the delivered decision-evidence
pattern: `Decision`/`DecisionOption`/`OrgMembership` all hold one), each
hostile-probed directly (P23).

The PMC requests (the `architect` joins the requester set IN 4d with the role
— the same staging rule as the decider value); the named member responds; the
thread renders under the decision in the register and the decider's view.
Three invariants: consultation NEVER moves `status`, NEVER changes a gate
verdict (P24 — and the compared value is an EXPLICIT status-and-gate
projection, review round 1: a successful request MUST change the served
decision data, adding the thread and widening the consultee's slice, so full
before/after DTO snapshots cannot be byte-equal; P24 asserts byte-equality of
the `(status, gate verdicts)` projection and SEPARATELY asserts the
consultation DTO/audience DID change — a probe that compared whole snapshots
would either reject the correct implementation or be quietly written to omit
the consultation data), and WIDENS visibility exactly one way — a consultee sees THAT
decision (and its thread) while their consultation stands, an exception added
beside AUTH-02 in `decisionVisibleToViewer`, not a rewrite of it.

**The widening has an ELIGIBILITY carve-out** (rounds 2–4): a consultation may
be requested only on a decision whose question is still OPEN — in 4c that set
is `pending` or `change` (the `awaiting_countersign` arm is ADDED BY 4d with
the status itself) **AND PUBLISHED** (round 4: status alone admits an
author-private DRAFT whose `status` is `pending`; `publishedAt IS NOT NULL`
joins the request AND response guards) — never on `withdrawn` (whose title
and reason are pmc-only; a consultation there would leak exactly what 4a
hides), `approved`, or `recorded` (nothing left to inform). Refused 409 at
the service, with the withdrawn-leak probe asserting a consultee gains NO
visibility of a withdrawn row (P25). **The RESPONSE re-checks the same
eligibility at ITS moment** (round 3): a request made while `pending`
outlives the decision, and a stale response after a withdrawal would append
evidence — and push — against a row the consultee must no longer see; refused
409, probed by request → withdraw → late-response (P25). **And BOTH checks
run UNDER the decision row lock** (round-5 obligation 5): the eligibility
read takes the decision row's share lock inside the command transaction — the
lock-before-read rule 4a's own linkability authority follows — so a
withdrawal committing concurrently either waits or is seen — and this
lock-before-read holds on the REQUEST and the RESPONSE path ALIKE (review
round 1): a response path left as a plain eligibility read could read
`pending`, lose the race to a committing withdrawal, and still append advice
plus its push against the withdrawn decision while every request-side probe
passes. P41 therefore carries TWO barrier-controlled arms — request-vs-
withdraw AND response-vs-withdraw — each proven in both orderings with the
final response/effect invariant asserted directly.

**And the eligibility is sealed at the ROW, not only the command** (round 4):
the append-only `DecisionConsultation` row is the durable fact that widens
`decisionVisibleToViewer`, so a direct INSERT bypassing the locked command
path would grant standing visibility onto an ineligible decision — a
withdrawn row's pmc-only title leaking to a fabricated consultee. A DB INSERT
seal re-judges the command's own predicate (status `pending`/`change` —
`awaiting_countersign` joins in 4d — AND `publishedAt IS NOT NULL`, AND the
consultee membership ACTIVE via `phase6_membership_is_active`, AND the
SNAPSHOT `consulteeUserId` EQUAL to that membership's locked `userId` at
insert — review round 4: without this arm a direct insert can name Alice's
active membership but snapshot Bob, and the snapshot-judged visibility then
exposes the decision to Bob as a purported consultee while every FK and
listed predicate passes; the hostile mismatched-snapshot insert is probed
(P25) — AND
`requestedById` holding ACTIVE requesting authority — pmc via
`phase6_user_decision_authority`, joined by architect in 4d: the contract's
actor-standing obligation applied to this fact's RECORDED actor, round 5)
under the decision row's share lock. **And BOTH INSERT seals take the
`Project` row lock BEFORE reading operability** (review round 4: a seal that
merely reads `archivedAt` without locking can read the project as operable,
lose the race to a committing archive, and still commit the immutable row —
the same lock-before-read rule the commands follow, applied inside the
trigger; the DIRECT-insert-vs-archive interleaving is barrier-probed in
both orderings, not just the HTTP path P41 covers). Delivered-4b disciplines apply to this
seal verbatim: it serializes through the §B.1 try-acquire-or-refuse readiness
protocol (reentrant on the service path, hold-to-commit when free, REFUSE
when contended — never blocking inside a trigger), and it takes its locks
BEFORE consulting decision or standing state (the round-8 key-before-
judgement rule). The hostile row against a withdrawn AND a draft decision,
and the unauthorized-requester row, are probed (P25); the RESPONSE side's own
hostile inserts are P25d (§B below).

**The RESPONSE command's live standing** (the 4b round-11 rule instantiated):
`consultations.respond` re-validates INSIDE its transaction that the caller
IS the named consultee's user and that the consultee membership is STILL
ACTIVE — through `OrgsParticipant.lockActiveMembershipById` (the same in-tx
re-lock the 4b approve path uses for a named decider) — so a consultee
removed after their JWT was minted cannot append immutable advice. The
REQUEST command re-validates the requester's pmc standing the same way
(`hasProjectRoleStanding` with `forUpdate`). **And BOTH write commands
serialize with project archival** (review round 2): passing
`ProjectAccessService` at the door is a read of a then-live project — an
archive can commit between the guard and the write, and the eligibility
predicates alone (decision open, membership active, actor matching) would
all still pass, appending immutable advice plus its push into an archived
project. `consultations.request` and `consultations.respond` therefore
lock-and-check `isProjectOperable` INSIDE the transaction BEFORE reading
the decision — the exact transactional shape the delivered decider push
claim performs — the DB INSERT seals mirror the same operability predicate,
and P41 gains an archive-vs-response barrier arm (both orderings:
archive-first → respond 409 with no row and no effect; respond-first → the
advice stands, recorded against a then-operable project).

**Consultation ships as a PRODUCT surface, not a service function** (review
round 1): the unit adds the shared `ROLE_POLICY` actions
(`consultation.request`, `consultation.respond`), guarded controller routes,
and the request/respond UI affordances (the requester picks a consultee on
the decision; the consultee sees the question and answers from their widened
view). The respond route's `RolesGuard` CEILING admits EVERY role a consultee
can hold — any active member (contractor, engineer, consultant, supplier
included) can be named — with the SERVICE narrowing to the named consultee
(the delivered 4b round-7 widen-ceiling-narrow-in-service rule: a route
ceiling tighter than the eligible set makes the guard reject a legitimately
named consultee before the service's own check can admit them). The request
route's ceiling is the requesting set (pmc in 4c; architect joins in 4d). P23
therefore traverses the ACTUAL guarded HTTP path end-to-end for a
NON-pmc-role consultee — a contract/service-layer round-trip alone would pass
while the shipped app still locks the consultee out.

Events `decision.consultation_requested` (push to the consultee) and
`decision.consultation_responded` (push to the requester) join the catalog
with the 4a re-seal discipline, riding 4b's user-targeted dispatch — the
consultee is resolved from their membership; the requester may be an
org-admin USER with no membership row, which is exactly why the target is
user-keyed (P26). Both events inherit the generalized pre-send/claim-time
eligibility class of the merged 4b plan's §A.3 — the 4c instantiation is
P38c/P40c (§B below). The consultee is a MEMBERSHIP — when external
collaborators arrive (6.2+), they arrive as members and this table already
names them.

## §B — The carried §D obligations, elaborated (P25c, P25d, P38c/P40c)

The merged 4b plan's §D reserved these probe numbers to this unit and bound
each carried question to its probe. The full rows:

1. **P25c — the projected consultation audience.** The `decisions.inbox`
   projection carries the resolved CONSULTATION audience beside the decider
   designation, threaded through the SAME row/fold/rebuild/filter path P22
   delivered for the decider: the projection row records the decision's
   standing consultations keyed by the SNAPSHOT `consulteeUserId` — NEVER
   by re-resolving the membership (review round 4: a fold that derives the
   audience as membership → current user re-admits the re-keyed user on
   every REBUILD even though the live snapshot rule excludes them; the
   snapshot travels in the event payload and the projection stores and
   filters by it) — the
   read-path filter admits the snapshot user's slice exactly as the live
   `decisionVisibleToViewer` widening does, and a REBUILD preserves the
   slice, INCLUDING after a membership re-key (live == projection == rebuild
   all EXCLUDE the re-keyed user — the re-key case is probed across all
   three). PROVES: after a consultation is requested, the consultee's
   PROJECTED slice admits exactly that decision; a same-role non-consultee's
   does not; live == projection == rebuild. RED SITE: the `decisions.inbox`
   projection row schema/fold/filter (today decider-only). The projection
   change is additive to the row payload; a rebuild emits zero events (the
   delivered projection discipline).
2. **P25d — the response-side DB eligibility seal's OWN hostile probes.**
   §A's INSERT seal on `DecisionConsultation` has a response-side twin: a
   `DecisionConsultationResponse` INSERT is refused at the DATABASE when its
   parent decision is no longer response-eligible (withdrawn/approved/
   recorded, or unpublished), OR the project is not operable (§A's archival
   rule mirrored at the row, review round 2), OR its RECORDED
   `respondedById` (§A — the
   response row's own actor column, without which this seal has no actor to
   judge) is not the consultation's SNAPSHOT `consulteeUserId` (review
   round 3: judged against the snapshot, never the membership's mutable
   current `userId`), OR the named membership no longer RESOLVES to that
   snapshot user (a re-key strands the consultation — §A),
   OR the named consultee membership is NO LONGER ACTIVE
   via `phase6_membership_is_active` (review round 2: without this arm, a
   consultee removed AFTER the request still resolves — the decision is open
   and `respondedById` matches — so a direct insert forges advice §A says a
   removed consultee can never append). PROVES: the direct hostile INSERT
   against an
   ineligible decision, one attributed to a non-consultee responder, and one
   naming a REMOVED consultee's own user (removed-then-hostile-insert), are
   all refused at the DB — the append-only advice register cannot be forged
   past the locked command. RED SITE: the response table's migration seals
   (the service guard alone, without this, is the exact service-only gap the
   4b correction rounds repeatedly closed). Same seal disciplines as §A's
   request seal: try-acquire readiness, locks before judgement.
3. **P38c/P40c — the consultation push families instantiate the §A.3 class
   standing rule.** `decision.consultation_requested` (consultee-targeted)
   and `decision.consultation_responded` (requester-targeted) carry
   per-family eligibility predicates at BOTH the pre-send guard and the
   delivery CLAIM — and BOTH predicates check PROJECT OPERABILITY first
   (review round 1): a consultation push queued before the project is
   archived would otherwise still deliver decision content after project
   authorization refuses access, since the decision stays open, the
   consultation stands, and memberships can stay active; both families
   therefore run the same transactional lock-and-check of
   `isProjectOperable` before reading the decision that the DELIVERED
   decider family performs (`apps/api/src/decisions/decisions.query.ts`
   claim path), probed by archive-between-enqueue-and-claim. Then: the
   consultee predicate re-checks the consultation still
   stands, the decision is still consultee-visible (not withdrawn), and the
   consultee membership is still active; the requester predicate re-checks
   the requester still holds requesting standing (pmc — or, per the
   delivered claim-time shape, the push re-targets to the CURRENT holder set
   where the family defines one, else drops with the recorded cancellation
   mark). PROVES: a consultee removed — or a requester demoted — or a
   project ARCHIVED — between
   enqueue and claim never receives decision content (re-targeted or dropped,
   recorded); a still-standing consultation's push SURVIVES unrelated churn.
   RED SITE: the per-family claim predicate registration (today only the
   `decider` family is registered); the pre-send guard's family table.

## §C — The probe table (P23–P27, P41, plus the carried arms)

Every probe's RED evidence is anchored to the implementation unit's ACTUAL
BASE COMMIT, not to an in-branch shape commit (review round 1: a shape-only
commit can itself introduce the state a test rejects, or conceal a base
incompatibility behind newly added symbols — red at the shape commit proves
nothing about the base). Every arm whose subject EXISTS at base
(the P24 status/gate surface, the P25 visibility boundary, the P25c
projection slice, the P26/P38c/P40c push families) runs as a base-compatible
black-box probe — HTTP against the guarded surface, SQL against the
base-migrated schema — executed and RECORDED against the real base SHA in
the packet before any contract, column, or enum is added, demonstrating the
absent behavior on the base itself (no consultation route, no widening, no
family predicate). Arms whose subject is a NEW table or symbol (the seals,
FKs, UNIQUEs, and zod refusals of P23/P25d/P27) stage red at a MINIMAL shape
commit that adds the bare tables/contracts with every seal and guard
deliberately absent — and that shape commit's own diff is quoted in the
packet so the review can see it introduces no behavior the red probes then
"discover". Red sites name where today's behavior lives.

| probe | proves | red site / staging |
|---|---|---|
| P23 | consultation round-trip THROUGH THE SHIPPED PRODUCT PATH: request → respond over the guarded HTTP routes with the shared `ROLE_POLICY` actions, the respond ceiling admitting every consultee-eligible role (a NON-pmc consultee — contractor/engineer/consultant — completes the round-trip; the service narrows to the named consultee), append-only (UPDATE/DELETE sealed at the row AND `TRUNCATE` sealed at the statement — both tables carry named no-truncate seals, each hostile-probed, since row triggers never fire for TRUNCATE), non-blank evidence refused at zod AND the CHECK AND a NULL direct insert refused (`NOT NULL` on both evidence columns — a CHECK over NULL passes as UNKNOWN); ONE response per consultation — a second respond is a deterministic 409 under a different idempotency key, and the direct duplicate insert is refused by the UNIQUE | the two new tables' migration + contracts + the response UNIQUE + `ROLE_POLICY`/route registration (`RolesGuard` today rejects roles absent from a route's ceiling before any service check) |
| P24 | consultation moves NO status and NO gate verdict — the EXPLICIT `(status, gate verdicts)` projection byte-equal before/after, with a SEPARATE assertion that the consultation DTO/audience DID change (full-snapshot equality is unsatisfiable and would force the probe to omit the served consultation data) | `DecisionsService` status CAS surface; the gate reader |
| P25 | visibility widening bounded by eligibility: published-only + open-status at request AND response; the withdrawn-leak refusal (no title/reason reachable); request → withdraw → late-response refused 409; the DB INSERT seal refusing a direct consultation row against a withdrawn AND a draft decision (visibility never widened by a forged row) AND a row whose `requestedById` lacks requesting authority (an inactive or unauthorized requester never fabricates a standing request) AND a row naming a REMOVED consultee membership (the request seal's `phase6_membership_is_active` arm probed directly — a raw writer must not mint a request a later membership reactivation would make visible and answerable) AND a row whose SNAPSHOT `consulteeUserId` is not the named membership's locked `userId` (the mismatched-snapshot forgery); the membership RE-KEY probe — request → re-key the consultee membership's `userId` → the re-keyed user gains NO visibility (widening judged on the SNAPSHOT `consulteeUserId`) and their respond is refused: a consultation strands, never transfers | `decisionVisibleToViewer`; the request/response guards + the consultation INSERT seal |
| P25c | the PROJECTED path THROUGH BOTH EVENTS, keyed by the SNAPSHOT: after the request, the SNAPSHOT `consulteeUserId`'s `decisions.inbox` slice admits exactly the consulted decision and a same-role non-consultee's does not; after the RESPONSE, the projected slice carries the ANSWERED thread (a fold that consumes `consultation_requested` but drops `consultation_responded` fails here); a rebuild preserves BOTH states (live == projection == rebuild after the request AND after the response); and after a membership RE-KEY, live, projection, AND rebuild all EXCLUDE the re-keyed user (a fold that re-resolves membership → current user re-admits them on rebuild and fails here — the projection stores and filters the snapshot from the event payload) | the `decisions.inbox` projection row schema/fold/filter (decider-only today) |
| P25d | the response-side DB seal: a direct `DecisionConsultationResponse` INSERT against an ineligible decision; one whose recorded `respondedById` is not the consultation's SNAPSHOT `consulteeUserId`; one naming a REMOVED consultee's own user (removed-then-hostile-insert — active membership re-judged via `phase6_membership_is_active`); one after a membership RE-KEY (the membership no longer resolves to the snapshot user — refused in BOTH directions: the old user and the new); one into a non-operable project; AND the DIRECT-insert-vs-archive BARRIER (both orderings — the seal takes the `Project` row lock BEFORE its operability read, so an insert racing a committing archive blocks and is refused, never committed into the archived project; a static already-archived probe alone would miss this interleaving) — each refused at the database | the response table's migration seals + the `respondedById`/`consulteeUserId` columns they judge |
| P26 | consultation pushes exact: consultee push on request, requester push on response — including the org-admin requester with no membership row | the user-target dispatch delivered by 4b (P21) |
| P27 | EVERY project-scoped consultation FK proven by hostile insert, not just claimed: a consultation pairing project A with project B's DECISION; one pairing project A with project B's consultee MEMBERSHIP; a response whose `projectId` disagrees with its consultation's; and the option arms — an out-of-range index refused at the contract, a foreign decision's option id refused by the `(decisionId, id)` composite FK (a 4c-i that accidentally created scalar FKs fails these before the migration becomes immutable history) | the consultation-row and response-row composite FKs and candidate keys |
| P38c/P40c | the consultation push families' pre-send AND claim-time standing, PROJECT OPERABILITY FIRST: a project archived — or a consultee removed, or a requester demoted — between enqueue and claim never receives decision content (the same transactional `isProjectOperable` lock-and-check the delivered decider family runs before reading the decision; re-targeted or dropped with the recorded mark); a still-standing consultee push survives | the per-family predicate registration (decider-only today) + the pre-send guard |
| P41 | eligibility is checked UNDER the decision row lock on BOTH write paths, barrier-controlled in both orderings each: request-vs-withdraw (request-first → withdraw sees the widening it must revoke nothing for; withdraw-first → request 409); response-vs-withdraw (response-first → the advice and its push stand against a then-eligible decision; withdraw-first → respond 409, NO response row and NO `consultation_responded` effect exists — the final-state invariant asserted directly); archive-vs-response (respond-first → the advice stands against a then-operable project; archive-first → respond 409 with no row and no effect — the in-tx `isProjectOperable` lock-and-check serializing the two); AND archive-vs-REQUEST (request-first → the consultation and its push stand; archive-first → request 409, NO consultation row and NO `consultation_requested` effect exists — review round 3: §A binds BOTH write commands to the in-tx operability lock, and without this arm an implementation could lock the response path only, letting a request that passed the outer access check append into a concurrently-archived project while every listed ordering passed) | the consultation command's AND the response command's lock acquisition |

Two delivered-4b disciplines apply to every row above without needing their
own probes, because the tripwires that pin them are already merged and will
fail the implementation PR if skipped: every new command rides the command
ledger with an idempotency key and the §A readiness-lock coverage enumeration
grows by the new commands; every new event joins the shared + sealed
external-effect catalogs.

## §D — Staging, review unit, and order

- **This plan document is the review unit** — one file, docs-only, its own
  exact-head Codex review to a fresh clean +1. STATUS bookkeeping travels in
  its OWN pull request (the PR #335 two-step, made up front: the deferral
  trailer is refused from a STATUS-touching diff). Past the plan-review round
  cap this unit's heads owe `Review-Deferred-To-Probes: phase-6-task-4c` —
  the probes above are exactly the executable deferral targets that trailer
  names.
- **4c implementation follows as TWO PRs honouring the mandatory
  migration seam** (review round 1: the additive schema is deployable before
  any caller uses it — that viable seam makes a single migration+service+UI
  PR a violation of the repository's migration review-unit rule, and this
  plan takes the seam rather than claiming an inseparable unit):
  - **4c-i, the migration unit**: ONE additive migration only — the two
    tables (with their own `projectId`, the `consulteeUserId` snapshot,
    and `respondedById`), the composite
    FKs and candidate keys (including the additive vacuously-satisfiable
    `(decisionId, id)` UNIQUE index on the existing `DecisionOption`), the
    CHECKs, the response UNIQUE, the row-level append-only seals PLUS the
    two named statement-level no-TRUNCATE seals, and the two INSERT
    eligibility seals — deployed dark (no caller, no contract, no route).
    Every statement is RETRY-SAFE (review round 2): `IF NOT EXISTS`/
    `IF EXISTS` or duplicate-object guards on each `CREATE`/`ADD
    CONSTRAINT`/trigger wherever PostgreSQL supports them (the 20271015
    discipline), because a deploy that fails after creating an early object
    must complete — not stop at the existing object — on retry; the
    upgrade proof EXERCISES that partial-apply retry (kill after the first
    objects, re-run, assert every seal armed). And it carries EVERY
    DATABASE probe arm the schema makes provable — P25d's seal arms
    (including the direct-insert-vs-archive BARRIER, both orderings), ALL
    of P27's cross-project hostile inserts (project A + project B's
    decision; project A + project B's consultee membership; a response
    `projectId` disagreeing with its consultation's; the foreign option
    id), the
    P25 insert-seal arms (including the removed-consultee-membership and
    mismatched-snapshot forgeries), append-only INCLUDING the two
    statement-level
    TRUNCATE hostile probes, AND P23's DB arms: the two non-blank
    `btrim` CHECKs (whitespace-only hostile insert), the two `NOT NULL`
    null-evidence hostile inserts, and the one-response
    UNIQUE (direct duplicate insert) — review round 2: a DB invariant whose
    first probe waits for 4c-ii could merge wrong and become immutable
    history before anything detects it; no invariant this migration
    installs is probed later than the PR that installs it. Plus the
    upgrade-proof
    extension and its compatibility statement: the old release runs
    unchanged over the migrated schema because nothing reads or writes the
    new tables.
  - **4c-ii, the behaviour unit**: contracts, commands, `ROLE_POLICY`/routes,
    the visibility widening, the P25c projection thread, the push families,
    and the UI affordances — with the remaining probes, red-anchored per §C
    against ITS base (which already carries 4c-i).
  Each PR keeps the full delivered discipline: the folded-STATUS convention
  (each updates `open_pr` in the same change), the vision-alignment
  statement, six-row invariant matrix, and review packet; reproduce-first
  probes; the full gate battery (pnpm check, the integration battery on a
  pristine migrated DB, upgrade-proof for 4c-i, and both e2e senders) before
  its one validated push per round. If implementation uncovers a genuine
  inseparability, that PR must argue it explicitly with the
  inseparable-unit marker — never by silently recombining the seam.
- 4c depends on 4b's targeted dispatch and the `Membership(projectId, id)`
  candidate key — both DELIVERED. The review-efficiency budget (20 files /
  1,500 lines) is expected to HOLD for 4c; the PR argues its own case in its
  packet, never by reference to this sentence.
- 4d (architect, forwarding, countersign) is NOT this unit: its plan unit
  follows 4c implementation per the merged §E order, carrying §D obligations
  4–6.

## What carries forward

- The binding ledgers of `docs/reviews/pr-335-convergence.md` and
  `docs/reviews/pr-340-convergence.md` — every decision above annotated with
  its round is carried from them, none reopened.
- 4a's delivered seal network, audience rule, cancellation spine, and
  linkability authority; 4b's delivered decider model, targeted push spine,
  §B.1/§B.2 primitives, and the round-8–11 hardening rules (key before
  judgement; live standing at the act; identity-keyed session reads) —
  extended by reference, never rewritten.
- The owner's recorded intent: decisions decided by the right party, issues
  filed without ceremony, consultation that informs without gating, and an
  architect who countersigns without becoming a bottleneck nobody can route
  around.
