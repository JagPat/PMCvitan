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
  per-seal. **4c's seals need two facts the delivered inventory cannot
  express, so 4c-i REGISTERS TWO NEW owned primitives in the same discipline**
  (review round 6, restated in round 9: `phase6_membership_is_active` returns
  only a boolean, so it can neither lock the membership row nor return the
  `userId` the response seal must compare, and nothing exposes a lockable
  project-operability check — following the old inventory would force the
  decisions-owned triggers to read `Membership`/`Project` directly, the exact
  cross-module raw read the primitives exist to prevent, or to drop the
  active-standing and archival predicates and admit the P25/P25d hostile
  inserts):
  - an ORGS-owned `phase6_membership_active_user(projectId, membershipId)` —
    takes the membership row's lock, returns its `userId` when the
    membership is ACTIVE and NULL otherwise, so a seal establishes standing
    and reads the identity in ONE owned call. Identity itself is frozen by
    the delivered `Membership_t4b_identity_frozen`, so this is not a
    re-key defence (review round 9); what it serializes against is the
    ACTIVE→removed transition, which is a live state change, and splitting
    it into a boolean check plus a separate read would leave a window
    between them;
  - an ORGS-owned `phase6_project_operable(projectId)` — takes the
    `Project` row's lock BEFORE reading `archivedAt`, returning operability,
    so the seals' lock-before-read ordering (§A) is the primitive's own
    contract rather than each trigger's private SQL. **Orgs, not a
    "projects" module** (review round 7): there is no `projects` module in
    the registry — `orgs` owns `project` (`orgsManifest.ownsModels`) and the
    existing lock-bearing `isProjectOperable` is already an `OrgsParticipant`
    method, which the delivered decider claim path calls
    (`decisions.query.ts`). Naming a fictitious owner would have required
    either registering an impossible participant or letting a
    decisions-owned primitive read another module's table; the SQL primitive
    is the DB-side twin of that existing participant method, on the same
    decisions → orgs boundary.
  Both are therefore ORGS-owned and registered exactly as the delivered three
  are (owned by the module that owns the fact, granted to the decisions
  seals, named in the module registry), reaching the decisions seals through
  the ALREADY-DECLARED decisions → orgs edge — no new module dependency —
  and 4c-i installs them beside the seals that call them;
- the round-11 LIVE-STANDING rule: an act's authorizing role is re-validated
  inside the transaction via `OrgsParticipant.hasProjectRoleStanding` with
  `forUpdate` — a guard-passed JWT role is never trusted at write time;
- `decisionVisibleToViewer` + the `decisions.inbox` projection thread
  (row/fold/rebuild/filter) that P22 delivered, which P25c extends.

## §A — The design (the §B starting material, carried)

Two labour-adjacent append-only facts, owned by decisions:
`DecisionConsultation` (**`projectId`**, decisionId, requestedById,
consulteeMembershipId, **`consulteeUserId`**, question, requestedAt). **A
membership id denotes one person for its lifetime, and the DATABASE already
guarantees it** (review round 9, correcting rounds 3–5): rounds 3–5 read
`consulteeUserId` as a SNAPSHOT defending against an alternate writer
re-keying `Membership.userId`, reasoning from the delivered
`Membership_t4b2_holder_guard` — which does ignore a `userId` change when
role and status are unchanged. That was the wrong trigger to reason from.
The EARLIER `Membership_t4b_identity_frozen`
(`20270826000000_phase6_t4b_approval_attribution`, `BEFORE UPDATE OF
"userId", "projectId"`) RAISES on any change to either column, so the
re-key is unrepresentable, every probe premised on performing one would fail
at setup, and the mismatched-SNAPSHOT forgery class those rounds invented
cannot arise. **The column stays — for an entirely different and
load-bearing reason** (review round 10): it is the DECISIONS-OWNED CANONICAL
AUDIENCE, the fact `decisions.inbox` folds and, decisively, the fact a
REBUILD reads. `rebuildSeed` seeds the generation from canonical rows
(`tx.decision.findMany({ include: DECISION_INCLUDE })`) and returns the
current stream maximum, replaying NO historical payloads
(`apps/api/src/decisions/decisions.projection.ts`): an audience living only
in an event payload is lost by every rebuild, and a fold resolving it from
`Membership` would be the cross-module read the module rules forbid. A
decisions-owned column is read by BOTH paths, so live, projection and
rebuild converge on ONE source (P25c). Because identity is frozen the column
can never DRIFT from `Membership`; what it CAN be is FORGED by a raw writer,
so the request INSERT seal validates it equals
`phase6_membership_active_user(projectId, consulteeMembershipId)` at
insertion — the WRONG-AUDIENCE arm, a reachable forgery unlike a re-key —
and that one locked call also establishes the membership is still ACTIVE,
which is why `phase6_membership_active_user` earns its place regardless:
removal and revocation are live state changes even though identity is
frozen. What the plan probes about the freeze itself is only the PREMISE: a
hostile `UPDATE "Membership" SET "userId" = …` is rejected by the delivered
trigger (P25). The child carries its OWN
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
response-side INSERT seal compares it with the consultee's user resolved
through `phase6_membership_active_user(projectId, consulteeMembershipId)`
— which is BOTH the current and the original user, since
`Membership_t4b_identity_frozen` makes the identity immutable (review
round 9) — and that one locked call also establishes the membership is
still ACTIVE, and it sits
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
consultee membership ACTIVE via `phase6_membership_active_user`, which
returns the consultee's user under the row lock and NULL once the membership
is inactive, AND the row's own canonical `consulteeUserId` EQUAL to that
returned user (review round 10: the column is the projection's REBUILDABLE
audience source, so a raw writer naming an arbitrary user there would mint a
projected slice — and a widened view — for someone never consulted; this is
the reachable WRONG-AUDIENCE forgery, not the mismatched-SNAPSHOT drift
rounds 3–5 imagined, which `Membership_t4b_identity_frozen` makes
unrepresentable) — AND
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
can hold — any active member in the EXISTING project-role vocabulary
(`pmc`, `client`, `engineer`, `contractor`, `consultant`; review round 6:
an earlier draft also named a `supplier` consultee, but no such role exists
in `TokenRole`, the API `Role`, or the project-role contract, so `RolesGuard`
could never admit one and P23 could not authenticate one — 4c introduces NO
role, and any future role addition is its own compatibility-staged unit) —
with the SERVICE narrowing to the named consultee
(the delivered 4b round-7 widen-ceiling-narrow-in-service rule: a route
ceiling tighter than the eligible set makes the guard reject a legitimately
named consultee before the service's own check can admit them). The request
route's ceiling is the requesting set (pmc in 4c; architect joins in 4d). P23
therefore traverses the ACTUAL guarded HTTP path end-to-end for a
NON-pmc-role consultee — a contract/service-layer round-trip alone would pass
while the shipped app still locks the consultee out. **And the WEB audience
mirrors widen with the server** (review round 5): the store's shared
audience selectors (`selectLogDecisions`/`selectVisibleDecisions`) today
discard every non-PMC pending row unless `viewerIsDecider`, so a widened
API response could carry the consulted decision while the rendered UI still
hides it — and the respond affordance with it — from the very non-pmc
consultee P23 admits at the HTTP layer. The shared web audience predicate
gains the consultee arm (the viewer is the decision's canonical consultee →
the row renders with its thread and the respond affordance), and the P23
round-trip covers the RENDERED flow, not only the HTTP response.

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
   standing consultations keyed by the DECISIONS-OWNED CANONICAL
   `DecisionConsultation.consulteeUserId` (§A), reached through
   `DECISION_INCLUDE`, which 4c-ii WIDENS to carry the consultation rows and
   their responses. Both projection paths then read ONE source: the
   incremental fold upserts from the canonical rows it already loads for that
   decision, and `rebuildSeed` — which seeds from
   `tx.decision.findMany({ include: DECISION_INCLUDE })` and returns the
   current stream maximum, replaying NO historical payloads
   (`apps/api/src/decisions/decisions.projection.ts`) — reads exactly those
   same rows (review round 10, correcting a payload-keyed draft: an audience
   carried only in the event payload is dropped by every rebuild, and a fold
   resolving the membership itself would be the cross-module read the module
   rules forbid). Identity is frozen, so the canonical column can never
   disagree with `Membership`; a raw writer naming a stranger there is
   refused by the request seal's WRONG-AUDIENCE arm (§A, probed in P25). The
   read-path filter admits that user's slice exactly as the live
   `decisionVisibleToViewer` widening does. PROVES: after a consultation is
   requested, the consultee's PROJECTED slice admits exactly that decision; a
   same-role non-consultee's does not; live == projection == rebuild — AND
   the CANONICAL-SOURCE arm: an ELIGIBLE DIRECT consultation INSERT (accepted
   by the seal, emitting no event, so nothing triggers an incremental fold
   for it) is picked up by a rebuild, whose slice then matches live. That is
   the convergence a payload-keyed audience could not reach at all, and the
   reason the audience is a column rather than a payload field. RED SITE: the
   `decisions.inbox` projection row schema/fold/filter and `DECISION_INCLUDE`
   (today decider-only). The projection change is additive to the row
   payload; a rebuild emits zero events (the delivered projection
   discipline).
2. **P25d — the response-side DB eligibility seal's OWN hostile probes.**
   §A's INSERT seal on `DecisionConsultation` has a response-side twin: a
   `DecisionConsultationResponse` INSERT is refused at the DATABASE when its
   parent decision is no longer response-eligible (withdrawn/approved/
   recorded, or unpublished), OR the project is not operable (§A's archival
   rule mirrored at the row, review round 2), OR its RECORDED
   `respondedById` (§A — the
   response row's own actor column, without which this seal has no actor to
   judge) is not the consultee's user as resolved by
   `phase6_membership_active_user(projectId, consulteeMembershipId)` — one
   locked call that is both the current and the original identity, since
   `Membership_t4b_identity_frozen` freezes it (review round 9),
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
   stands, the decision is still RESPONSE-ELIGIBLE by §A's own predicate —
   PUBLISHED and `pending`/`change`, not merely un-withdrawn (review round
   10: an APPROVE committing between enqueue and claim leaves the project
   operable, the membership active, the consultation unanswered and the
   decision un-withdrawn, so a not-withdrawn test still sends a
   request-to-respond push for a question §A's respond command now answers
   with a 409 — a push inviting an action the server refuses. The SAME
   published-and-open predicate therefore runs at the pre-send guard AND
   again at the CLAIM, and a decision that has left the open set has its
   delivery recorded CANCELLED), the
   consultee membership is still ACTIVE at claim time, re-resolved through
   `phase6_membership_active_user` (review round 5, restated in round 9: the
   targeted intent names a user, and a membership REMOVED between enqueue and
   claim would otherwise still deliver decision content to that user's
   still-linked subscription after they lost standing — the same locked
   resolve the response seal performs, applied at the claim; identity itself
   cannot drift, being frozen); AND, for the `consultation_requested`
   family specifically, NO response exists yet (review round 5: a consultee
   who saw the in-app thread and answered before the queued delivery was
   claimed must not receive a request-to-respond push for a question they
   already answered — the claim records the delivery CANCELLED, the
   delivered cancellation mark); the requester predicate re-checks
   the requester still holds requesting standing (pmc — or, per the
   delivered claim-time shape, the push re-targets to the CURRENT holder set
   where the family defines one, else drops with the recorded cancellation
   mark). PROVES: a consultee removed — or a requester
   demoted — or a
   project ARCHIVED — between
   enqueue and claim never receives decision content (re-targeted or dropped,
   recorded); an already-ANSWERED request push is cancelled, recorded; a
   decision APPROVED between enqueue and claim has its
   `consultation_requested` delivery cancelled and recorded, never sent
   (the approve-before-claim ordering probed directly);
   a still-standing consultation's push SURVIVES unrelated churn.
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
| P23 | consultation round-trip THROUGH THE SHIPPED PRODUCT PATH: request → respond over the guarded HTTP routes with the shared `ROLE_POLICY` actions, the respond ceiling admitting every consultee-eligible role in the EXISTING vocabulary (a NON-pmc consultee — contractor/engineer/consultant/client — completes the round-trip in the RENDERED flow, not only the HTTP response; the service narrows to the named consultee; 4c adds NO role), append-only (UPDATE/DELETE sealed at the row AND `TRUNCATE` sealed at the statement — both tables carry named no-truncate seals, each hostile-probed, since row triggers never fire for TRUNCATE), non-blank evidence refused at zod AND the CHECK AND a NULL direct insert refused (`NOT NULL` on both evidence columns — a CHECK over NULL passes as UNKNOWN); ONE response per consultation — a second respond is a deterministic 409 under a different idempotency key, and the direct duplicate insert is refused by the UNIQUE | the two new tables' migration + contracts + the response UNIQUE + `ROLE_POLICY`/route registration (`RolesGuard` today rejects roles absent from a route's ceiling before any service check) |
| P24 | consultation moves NO status and NO gate verdict — the EXPLICIT `(status, gate verdicts)` projection byte-equal before/after, with a SEPARATE assertion that the consultation DTO/audience DID change (full-snapshot equality is unsatisfiable and would force the probe to omit the served consultation data) | `DecisionsService` status CAS surface; the gate reader |
| P25 | visibility widening bounded by eligibility: published-only + open-status at request AND response; the withdrawn-leak refusal (no title/reason reachable); request → withdraw → late-response refused 409; the DB INSERT seal refusing a direct consultation row against a withdrawn AND a draft decision (visibility never widened by a forged row) AND a row whose `requestedById` lacks requesting authority (an inactive or unauthorized requester never fabricates a standing request) AND a row naming a REMOVED consultee membership (the request seal's `phase6_membership_is_active` arm probed directly — a raw writer must not mint a request a later membership reactivation would make visible and answerable) AND the WRONG-AUDIENCE row whose canonical `consulteeUserId` is NOT the user `phase6_membership_active_user(projectId, consulteeMembershipId)` resolves (review round 10: that column is the projection's rebuildable audience, so an unchecked one would mint a projected slice and a widened view for a stranger — a reachable forgery, unlike the re-key the delivered identity freeze makes unrepresentable) AND the DIRECT-request-insert-vs-archive BARRIER, asserted as the TWO reachable outcomes rather than a uniform refusal (review round 9: the seal locks `Project` before reading operability, so insert-first WINS the lock, reads the project operable and commits — the archive then waits and commits after, leaving valid historical evidence; only archive-first makes the insert wait and then reject. The same two-outcome shape P41 already states for the command path); and the IDENTITY-FREEZE premise probe — a hostile `UPDATE "Membership" SET "userId" = …` is REJECTED by the delivered `Membership_t4b_identity_frozen`, which is why `consulteeMembershipId` is a lifetime identity, why the canonical `consulteeUserId` beside it can never DRIFT (its seal arm guards forgery, not drift), and why no re-key probe appears anywhere in this plan | `decisionVisibleToViewer`; the request/response guards + the consultation INSERT seal |
| P25c | the PROJECTED path THROUGH BOTH EVENTS: after the request, the consultee's `decisions.inbox` slice admits exactly the consulted decision and a same-role non-consultee's does not; after the RESPONSE, the projected slice carries the ANSWERED thread (a fold that consumes `consultation_requested` but drops `consultation_responded` fails here); and a rebuild preserves BOTH states (live == projection == rebuild after the request AND after the response). The audience is the DECISIONS-OWNED CANONICAL `DecisionConsultation.consulteeUserId` reached through the widened `DECISION_INCLUDE` — never a payload-only field and never re-resolved from `Membership` at fold time, which would be a cross-module read from a projection (review round 10): `rebuildSeed` seeds from `tx.decision.findMany({ include: DECISION_INCLUDE })` and replays no historical payloads, so ONLY a canonical column lets the three converge. The CANONICAL-SOURCE arm proves it: an eligible DIRECT consultation insert emits no event, yet a rebuild surfaces the consultee's slice and it matches live | the `decisions.inbox` projection row schema/fold/filter and `DECISION_INCLUDE` (decider-only today) |
| P25d | the response-side DB seal: a direct `DecisionConsultationResponse` INSERT against an ineligible decision; one whose recorded `respondedById` is not the consultee's user as resolved by `phase6_membership_active_user(projectId, consulteeMembershipId)`; one naming a REMOVED consultee's own user (removed-then-hostile-insert — the same locked call returns NULL once the membership is inactive); one into an already-archived project — each refused at the database; AND the DIRECT-insert-vs-archive BARRIER asserted as its TWO reachable outcomes (review round 9: insert-first takes the `Project` lock, reads operable and COMMITS, the archive committing after it — historical evidence against a then-operable project; archive-first makes the insert wait and REJECT. A uniform "refused in both orderings" was unreachable and contradicted this plan's own P41 row) | the response table's migration seals + the `respondedById` column they judge |
| P26 | consultation pushes exact: consultee push on request, requester push on response — including the org-admin requester with no membership row | the user-target dispatch delivered by 4b (P21) |
| P27 | EVERY project-scoped consultation FK proven by hostile insert, not just claimed: a consultation pairing project A with project B's DECISION; one pairing project A with project B's consultee MEMBERSHIP; a response whose `projectId` disagrees with its consultation's; and the option arms — an out-of-range index refused at the contract, a foreign decision's option id refused by the `(decisionId, id)` composite FK (a 4c-i that accidentally created scalar FKs fails these before the migration becomes immutable history) | the consultation-row and response-row composite FKs and candidate keys |
| P38c/P40c | the consultation push families' pre-send AND claim-time standing, PROJECT OPERABILITY FIRST: a project archived — or a consultee removed (the claim re-resolves the membership through `phase6_membership_active_user`, which returns NULL once it is inactive — the response seal's own arm applied at send time), or a requester demoted — between enqueue and claim never receives decision content (the transactional `isProjectOperable` lock-and-check; re-targeted or dropped with the recorded mark); an ALREADY-ANSWERED `consultation_requested` delivery is cancelled with the recorded mark (no request-to-respond push after the response exists); a decision APPROVED between enqueue and claim likewise cancels its `consultation_requested` delivery, since §A's respond command would 409 the push's own invitation (review round 10: the claim re-checks the published `pending`/`change` set, not merely un-withdrawn); a still-standing consultee push survives; and the MIXED-VERSION arms, split by the two REACHABLE GATE STATES rather than by consumer class (review round 10) — **gate OFF with old-shaped consumers present**: the consultation write surface refuses, NO `decision.consultation_*` event is emitted, so no old projection worker, push worker or API reader can ever claim or serve one, and every other project's behaviour is byte-identical to today; **gate ON with upgraded-only consumers**: the full flow — the fold carries the thread, the push families honour every claim predicate, the consultee's read is correct on every instance. The two states are EXHAUSTIVE, and the deliberately UNASSERTED combination is gate-on-beside-an-old-worker: the outbox has ONE ordered delivery per consumer, so an old worker there WOULD claim it and perform the stale fold or unguarded send — that is the hazard the deploy-then-enable RUNBOOK order forbids, not a behaviour any code in this unit can prevent, and a probe asserting otherwise would be unsatisfiable | the per-family predicate registration (decider-only today) + the pre-send guard + the ordered-consumer rollout seam + the capability-gated write surface |
| P41 | eligibility is checked UNDER the decision row lock on BOTH write paths, barrier-controlled in both orderings each: request-vs-withdraw (request-first → withdraw sees the widening it must revoke nothing for; withdraw-first → request 409); response-vs-withdraw (response-first → the advice and its push stand against a then-eligible decision; withdraw-first → respond 409, NO response row and NO `consultation_responded` effect exists — the final-state invariant asserted directly); archive-vs-response (respond-first → the advice stands against a then-operable project; archive-first → respond 409 with no row and no effect — the in-tx `isProjectOperable` lock-and-check serializing the two); AND archive-vs-REQUEST (request-first → the consultation and its push stand; archive-first → request 409, NO consultation row and NO `consultation_requested` effect exists — review round 3: §A binds BOTH write commands to the in-tx operability lock, and without this arm an implementation could lock the response path only, letting a request that passed the outer access check append into a concurrently-archived project while every listed ordering passed) | the consultation command's AND the response command's lock acquisition |

Two delivered-4b disciplines apply to every row above without needing their
own probes, because the tripwires that pin them are already merged and will
fail the implementation PR if skipped: every new command rides the command
ledger with an idempotency key and the §A readiness-lock coverage enumeration
grows by the new commands; every new event joins the shared + sealed
external-effect catalogs.

## §D — Staging, review unit, and order

- **This plan document is the review unit**, and its STATUS record travels
  WITH IT — docs-only, its own exact-head Codex review to a fresh clean +1.
  The plan-unit two-step (STATUS in a separate pointer PR, from the 4b plan's
  §E) is SUPERSEDED by review round 7: `docs/STATUS.md`'s own rule is "Update
  this file in the same PR as the work it describes, so state and code never
  disagree on `main`", and the two-step produced exactly the failure that rule
  forbids — pointer PR #472 merged naming `open_pr: 473`, #473 was then
  replaced at its round limit, and `main` was left resolving
  `assessRunnerState` to a CLOSED PR. A folded record NAMES ITS OWN PR in `open_pr`
  (review round 9, correcting an earlier draft of this very paragraph that
  said `none`): `assessPostMergeRunnerState` simulates the merge by clearing
  a SELF-REFERENTIAL `open_pr` before resolving, so naming it survives its
  own merge — falling back to `task: 4` — while ALSO keeping
  `detectStatusDrift` quiet for the whole time the PR is open. Recording
  `none` beside a live autonomous PR is the drift the shepherd exists to
  report, and every future unit folding its STATUS follows the self-naming
  convention. The deferral gate's
  "land the STATUS change on its own" branch does NOT conflict: it fires only
  for a docs-only head at three or more finding-bearing heads, which the
  two-finding-head replacement reset makes unreachable within one PR. Past
  the plan-review round cap this unit's heads owe
  `Review-Deferred-To-Probes: phase-6-task-4c` — the probes above are exactly
  the executable deferral targets that trailer names.
- **4c implementation follows as TWO PRs honouring the mandatory
  migration seam** (review round 1: the additive schema is deployable before
  any caller uses it — that viable seam makes a single migration+service+UI
  PR a violation of the repository's migration review-unit rule, and this
  plan takes the seam rather than claiming an inseparable unit):
  - **4c-i, the migration unit**: ONE additive migration only — the two
    tables (with their own `projectId`, the consultation's canonical
    `consulteeUserId` audience column, and the response's `respondedById`),
    the composite
    FKs and candidate keys (including the additive vacuously-satisfiable
    `(decisionId, id)` UNIQUE index on the existing `DecisionOption`), the
    CHECKs, the response UNIQUE, the row-level append-only seals PLUS the
    two named statement-level no-TRUNCATE seals, the TWO NEW owned
    ORGS-owned primitives the seals call (`phase6_membership_active_user`,
    `phase6_project_operable` — §"what carries forward" above; both owned by
    `orgs`, which owns `membership` and `project`, reached over the
    already-declared decisions → orgs edge), and the two
    INSERT
    eligibility seals — deployed dark (no caller, no contract, no route).
    Every statement is RETRY-SAFE (review round 2): `IF NOT EXISTS`/
    `IF EXISTS` or duplicate-object guards on each `CREATE`/`ADD
    CONSTRAINT`/trigger wherever PostgreSQL supports them (the 20271015
    discipline), because a deploy that fails after creating an early object
    must complete — not stop at the existing object — on retry; the
    upgrade proof EXERCISES that partial-apply retry (kill after the first
    objects, re-run, assert every seal armed). And it carries EVERY
    DATABASE probe arm the schema makes provable — P25d's seal arms AND
    P25's request-seal arms
    (each including its OWN direct-insert-vs-archive BARRIER, both
    orderings, on the request AND the response table alike), ALL
    of P27's cross-project hostile inserts (project A + project B's
    decision; project A + project B's consultee membership; a response
    `projectId` disagreeing with its consultation's; the foreign option
    id), the
    P25 insert-seal arms (the removed-consultee-membership forgery and the
    WRONG-AUDIENCE forgery — a `consulteeUserId` that is not the user
    `phase6_membership_active_user` resolves; review round 10 struck an
    earlier `mismatched-snapshot` arm here, which was unreachable once
    `Membership_t4b_identity_frozen` was recognized and is NOT what the
    reinstated canonical column guards), append-only INCLUDING the two
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
    against ITS base (which already carries 4c-i). **Its two new event
    families are ROLLOUT-SEQUENCED against previous-release workers**
    (review round 5, the delivered unit-6 rollout precedent — the outbox
    has ONE ordered delivery per consumer, so a claim by the wrong version
    is not retried by the right one): (a) the PROJECTION consumer
    dispatches every `decision.*` event, so an old worker could claim a
    `decision.consultation_*` event and upsert the row with its old
    include/serializer — advancing the generation while ERASING the
    consultation thread and audience from the projected DTO; (b) an old
    PUSH worker claiming a consultation delivery recognizes no family and
    falls through to the unguarded targeted send, bypassing every claim
    predicate §B.3 requires. 4c-ii therefore carries ONE mandated
    compatibility mechanism, the EMISSION GATE — and its predicate is an
    EXPLICIT OPERATOR ENABLEMENT, not an inferred fleet state (review round
    9). There is no repo-wide signal that could answer "is every serving
    process upgraded": `OutboxConsumerCatalog.catalogVersion` is a per-consumer
    CONTRACT version and `syncConsumerCatalog` upserts one global row per
    consumer name, asserting compiled-vs-persisted and THROWING on drift
    (`platform/outbox/registry.ts`) — it cannot enumerate processes or their
    releases, and no equivalent advertisement exists for API readers at all.
    Opening a gate from that state would be opening it blind; waiting on it
    would disable consultation writes forever. So the seam is the one this
    repository already uses for staged capability: 4c-ii ships the consumers
    and readers that UNDERSTAND the families while emission stays OFF, and a
    pmc/operator step turns it on per project through the delivered
    `ProjectCapability` mechanism (`capability:enable`, the same per-project
    row `materials` and `labour` ride) AFTER the rollout is confirmed
    complete. The deploy-then-enable order is a RUNBOOK step, the capability
    row is the machine-checkable predicate the write surface and the emitter
    both read, and **the MIXED-VERSION proof is split by those two gate
    states, because they are the only reachable ones** (review round 10,
    correcting a draft that demanded an old-shaped worker beside the new one
    while a consultation thread existed — an unsatisfiable conjunction):
    **gate OFF, old-shaped consumers present** — the consultation commands
    404/refuse, NO `decision.consultation_*` event is emitted, and therefore
    no old projection worker, push worker or serving API reader can claim or
    serve one; every other project is byte-identical to today. This arm is
    the whole protection, and it is what the gate exists to provide.
    **Gate ON, upgraded-only consumers** — the full flow: the fold carries
    the consultation thread and audience, the push families honour every §B.3
    claim predicate, and the consultee's read is correct on every serving
    instance. The combination the plan deliberately does NOT assert is
    gate-on beside an old worker: the outbox has ONE ordered delivery per
    consumer, so an old worker there WOULD claim the consultation delivery
    and perform exactly the stale fold or unguarded send described above.
    That is the hazard the deploy-then-enable order forbids operationally —
    not a behaviour any code shipped IN this unit can prevent — and a probe
    requiring the old worker never to claim an emitted event would be
    unsatisfiable, which is precisely how the struck alternative below
    failed. **The alternative an earlier draft allowed — "or an
    old-version claim structurally refuses the unrecognized family" — is
    STRUCK as impossible** (review round 8): a change shipped IN 4c-ii
    cannot alter the behaviour of a process that is ALREADY RUNNING, and the
    old behaviour is not a gap but the live code —
    `decisions.projection.ts` dispatches on `eventType.startsWith('decision.')`
    (so a consultation event IS claimed and refreshed through the old
    serializer) and `platform/outbox/consumers.ts` guards only
    `family === 'decider'` (so any other family falls through to the ordinary
    targeted send). Refusal could only come from a compatibility release
    landed BEFORE the emitting one; the emission gate achieves the same
    protection within this unit, so it is what the plan requires — proven by
    the two gate-state arms above (gate off: an old-shaped projection worker
    and an old-shaped push worker are running and NOTHING reaches either,
    because nothing is emitted; gate on with the fleet upgraded: the thread
    is folded and every claim predicate is honoured). **The same gate covers serving
    API READERS** (review round 6): a previous-release instance still
    answering HTTP serves `snapshotSlice`/`moduleDecisions` through its OLD
    include, serializer and `decisionVisibleToViewer`, so a consultee routed
    there would see no thread — and, being a non-decider, would have the
    pending decision filtered out of their list entirely — even though the
    request committed and the push arrived. The consultation WRITE surface
    (`consultations.request`/`respond` and their routes) is therefore gated
    off until every serving reader understands the new audience and DTO — the
    same advertised-contract mechanism, the same never-in-one-mixed-version-
    step rule — with a MIXED-VERSION HTTP probe: while an old-shaped reader
    is serving, the write surface refuses (nothing is committed that a
    reader cannot show), and once the gate opens the consultee's read is
    correct on every instance.
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
