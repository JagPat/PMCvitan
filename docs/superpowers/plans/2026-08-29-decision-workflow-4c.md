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

**Both facts carry COMMAND PROVENANCE, so no ACCEPTED write is invisible to
the projection** (review round 11): the `decisions.inbox` consumer dispatches
only on `decision.*` and then REFRESHES the whole generation from canonical
state, so a row appended with NO event leaves an already-active generation
classified as caught up while it serves its pre-insert DTO — `moduleDecisions`
would hide a perfectly valid consultation until an unrelated decision event or
an operator rebuild happened by. An earlier draft treated such a row as
ACCEPTED-BUT-INVISIBLE and probed only that a REBUILD eventually recovered it;
that is a stale read served as current, and the fix is to make the state
UNREPRESENTABLE rather than recoverable. Both tables therefore carry a
`NOT NULL sourceCommandId` with a project-contained composite FK to
`CommandExecution(projectId, id)` — the DELIVERED §C rule-ii provenance shape
(`StockTransaction` and eight later facts hold exactly this pair) — so the only
writer that can append a consultation or a response is one that reserved a
command-ledger row in the same project: the command path, which emits, which
refreshes the projection in the same commit.

**And that provenance binds the command's RESULT, not merely a valid receipt**
(review round 12): a same-project FK alone lets a direct writer COPY any
existing `CommandExecution.id` onto a new row, satisfy every listed seal, and
commit without emitting — the absent/foreign/fabricated probes all pass while
the projected read stays stale exactly as before. The obvious remedy (require a
`succeeded` command and its `resultRef`) is UNREACHABLE at insert time under
the delivered ordering, which this plan read before adapting it:
`executeCommand` RESERVES the row `status='reserved'` with a NULL `resultRef`,
RUNS the mutation — which is when the consultation row is inserted — and only
THEN flips the row to `succeeded` with its `resultRef`, all in ONE transaction
(`apps/api/src/platform/commands.ts`). A BEFORE INSERT trigger can never see
`succeeded`. The binding therefore uses the TWO moments the delivered shape
actually offers:

- **at INSERT** — the referenced command must be same-project, of the MATCHING
  type (`consultations.request` for a consultation, `consultations.respond` for
  a response), and still `reserved`: that is precisely the command CURRENTLY
  EXECUTING, since every past consultation command is already `succeeded` and
  so cannot be borrowed; plus a `(projectId, sourceCommandId)` UNIQUE per table
  making each receipt ONE-USE;
- **at COMMIT** — a DEFERRABLE INITIALLY DEFERRED constraint trigger (the
  delivered `phase4_labour_demand_sealed` pattern) requires that command to now
  be `succeeded` with its `resultRef` EQUAL to the new row's own id, which
  `executeCommand` writes before the transaction ends. The command's result IS
  this row, or the commit fails.

Probed (P25/P25d) as: reuse of an already-SPENT receipt; a `succeeded`
unrelated receipt; a wrong-TYPE receipt; and a row whose command commits with a
`resultRef` naming something else. Stated honestly, the residual is a writer
who forges a whole ledger row — which is forging a COMMAND, and is the command
ledger's own append-only and idempotency discipline, not something these two
tables can or should re-litigate. The probes then follow the states that
actually exist — the ORDINARY projected read is asserted IMMEDIATELY after the
request (not only after a rebuild). This makes no seal redundant: a
command-path row must still satisfy every eligibility predicate. It removes the
one ACCEPTED shape whose read was wrong.

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

**And eligibility is not a STATUS test alone — a consultation is bound to the
decision's OPEN CYCLE** (review round 11): `decisions.requestChange` requires
`approved` and moves the decision back to `change`
(`apps/api/src/decisions/decisions.service.ts`), so a status-only response
guard REVIVES a consultation the approval already closed. Request while
`pending` → approve → request change → a late response appends immutable
advice and emits `consultation_responded` against a question that belonged to
the PREVIOUS cycle, and whose request push was already cancelled at the
approval (§B.3) — two decision cycles mixed into one thread. The consultation
therefore FREEZES the decision's open-cycle generation at request time as
`openCycle`: the number of `DecisionApprovalRevision` rows the decision
carries (0 before its first approval — the register is decisions-owned,
immutable and monotonic per decision under its delivered `(decisionId,
version)` UNIQUE, which 4b shipped). The response COMMAND and the response
INSERT SEAL both require the decision's CURRENT cycle to still equal that
frozen value, so an approval permanently closes every consultation from the
cycle it ended, and a reopen begins a cycle the old thread can never re-enter;
asking again in the new cycle means a NEW consultation, which is the same
shape as the register's own "a changed need is a NEW decision" rule. The
`consultation_requested` claim predicate (§B.3) checks the frozen cycle too,
so a reopen cannot resurrect a delivery the approval already cancelled. **And
the INITIAL value is sealed at the request INSERT, not merely compared later**
(review round 12): a seal that only compares `openCycle` at RESPONSE time
trusts whatever the request wrote, so a command bug storing `current + 1`
would mint a consultation that is unanswerable now but becomes answerable
after ONE approve-and-reopen — the exact revival this field exists to prevent,
arriving through a legitimate writer rather than a hostile one. The request
INSERT seal therefore validates `NEW.openCycle` EQUALS the decision's current
`DecisionApprovalRevision` count, read under the SAME decision row lock the
seal already takes, with hostile current-minus-one and current-plus-one probes
(P25).
Probed as request → approve → reopen → late response: refused 409 at the
service AND refused at the database (P25d), with no response row and no
`consultation_responded` effect. **And because this design makes the revision
COUNT trusted cycle evidence, 4c-i seals `DecisionApprovalRevision` against
TRUNCATE too** (review round 15): the register's delivered append-only trigger
is ROW-level, and PostgreSQL row triggers never fire for `TRUNCATE`, so
`TRUNCATE "DecisionApprovalRevision" CASCADE` would return the count to 0 and
make the response command AND the INSERT seal accept a stale cycle-0
consultation in the reopened cycle — the exact revival `openCycle` exists to
prevent, reached by erasing the evidence instead of forging it. 4c-i adds the
NAMED statement-level no-truncate seal (the same delivered pattern
`Decision`/`DecisionOption`/`OrgMembership` already carry, and the same one
this unit applies to its own two tables) with its own hostile probe. This is
the general rule the unit now follows: sealing a fact append-only is
incomplete until the tables its predicates COUNT are sealed at the statement
level as well.

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
with the decision row's share lock HELD while those predicates are judged, and
acquired in the canonical order above — `Membership` before `Decision`, never
the reverse (review round 13). **And BOTH INSERT seals take the
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

**ONE CANONICAL LOCK ORDER for the whole 4c surface: readiness key →
`Project` → `Membership` → `Decision`** (review round 13). Round 12 required
the push claim to lock the decision before judging its status, and an earlier
draft had the INSERT seals resolve the consultee "under the decision row's
share lock" — both put `Decision` BEFORE `Membership`, which DEADLOCKS against
the delivered approval path: `decisions.approve` takes `lockProjectReadiness`,
then locks the named decider's membership through
`OrgsParticipant.lockActiveMembershipById`, and only then updates the
`Decision` row (`apps/api/src/decisions/decisions.service.ts`). When the
consultee IS the named decider — an ordinary case, since the person best placed
to advise is often the one deciding — approval holds `Membership` waiting for
`Decision` while a 4c path holds `Decision` waiting for `Membership`, and
PostgreSQL aborts one of them. Every 4c path therefore acquires in APPROVAL's
order: the readiness key first (the delivered §B.1 try-acquire-or-refuse
protocol), then `Project` through `phase6_project_operable` (approval never
takes this row, so it joins no cycle), then `Membership` through
`phase6_membership_active_user`, then `Decision`. Status, `openCycle` and
eligibility are still judged AFTER the decision lock is held — the round-12
requirement is met, only the order in which the earlier locks are taken
changes. This binds both write commands, both INSERT seals, and both push
claim predicates; the ordering is stated ONCE here and referenced, never
restated per-path, so a later unit cannot reintroduce the inversion by editing
one site. P41 carries a consultee-IS-decider approve-vs-request barrier arm
proving no deadlock abort occurs in either ordering.

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
   the DELIVERED-FOLD arm (review round 11 replaced a canonical-source arm that
   asserted an accepted eventless insert; review round 13 corrected what it
   asserts): the probe PROCESSES the ordered outbox delivery and THEN requires
   `moduleDecisions` to answer with `source: 'projection'` carrying the
   consultee's slice. Asserting an immediate read instead would prove nothing —
   `emitEvent` only materializes the delivery, and until the relay applies it
   `readServableGeneration` rejects the lagging generation, so `moduleDecisions`
   returns the LIVE slice (`source: 'live'`) and passes even when the
   consultation fold is broken. Immediacy is already protected by that live
   fallback and needs no probe; what needs one is the FOLD. And the eventless
   alternate write
   that would leave a stale generation looking caught up is now
   UNREPRESENTABLE, refused by the `sourceCommandId` provenance FK (§A). The
   audience stays a COLUMN rather than a payload field for the REBUILD's sake:
   `rebuildSeed` replays no payloads, so only a canonical column survives a
   generation swap. RED SITE: the
   `decisions.inbox` projection row schema/fold/filter and `DECISION_INCLUDE`
   (today decider-only). The projection change is additive to the row
   payload; a rebuild emits zero events (the delivered projection
   discipline).
2. **P25d — the response-side DB eligibility seal's OWN hostile probes.**
   §A's INSERT seal on `DecisionConsultation` has a response-side twin: a
   `DecisionConsultationResponse` INSERT is refused at the DATABASE when its
   parent decision is no longer response-eligible (withdrawn/approved/
   recorded, or unpublished), OR the decision's CURRENT open cycle no longer
   equals the consultation's frozen `openCycle` (review round 11: a
   `requestChange` reopen restores a `change` status the status test alone
   would admit, reviving a consultation the approval closed), OR its
   `sourceCommandId` names no command-ledger row in this project (review
   round 11: an eventless alternate write the projection would never see),
   OR the project is not operable (§A's archival
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
   claim path), probed by archive-between-enqueue-and-claim. **And the
   DECISION row is locked before its status and cycle are judged** (review
   round 12): the `Project` lock serializes ARCHIVAL and nothing else, so a
   claim that then read the decision plainly could see `pending`, lose the
   race to an approval committing on the unrelated `Decision` row, and still
   send a request-to-respond push for a consultation that approval just
   closed — the §A eligibility this claim mirrors, defeated by the same
   lock-before-read gap §A closes on the write paths. Both consultation
   families take the DECISION row's lock BEFORE reading status and
   `openCycle` — **in the ONE canonical 4c lock order below, not decision-first**
   (review round 13) — with an approve-vs-claim BARRIER probe asserting the
   terminal delivery outcome in both orderings (claim-first → the push stands
   against a then-open decision; approve-first → the delivery is recorded
   CANCELLED and nothing is sent). The delivered `deciderPushTarget` reads its decision with
   a plain `findFirst`; that is 4b's CLEARED surface and this unit does NOT
   silently change it — the difference is recorded here so 4d's own review can
   weigh it deliberately. Then: the
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
   delivery recorded CANCELLED) AND the consultation's frozen `openCycle`
   still equal to the decision's current cycle (review round 11: a
   `requestChange` reopen would otherwise restore an open status and
   resurrect a delivery the approval already cancelled), the
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
FKs, UNIQUEs, and zod refusals of P23/P25d/P27) are ALSO executed from the
implementation base, by a SEAL-STRIPPED MIGRATION RUN rather than a shape
commit (review round 15, replacing a draft that staged red at a minimal shape
commit and quoted its diff): a defect class in a table that does not yet exist
cannot be demonstrated by running a probe against the base schema — it errors
on a missing relation, which is evidence of nothing — and a quoted diff is an
assertion, not a run. So the probe harness, checked out AT the implementation
base, applies 4c-i's migration TWICE to scratch databases: once with the
specific seal statement omitted (the omission performed BY THE TEST, one named
object at a time), where the hostile insert is ACCEPTED, and once whole, where
the same insert is REJECTED. Both runs happen at the base commit, both are
recorded in the packet with their SQL and their outcomes, and the pairing
proves the seal is what rejects rather than some incidental constraint — which
is what red-then-green is for. This is the discipline `upgrade-proof.sh`
already uses to prove delivered seals precise rather than merely strict. Red sites name where today's behavior lives.

| probe | proves | red site / staging |
|---|---|---|
| P23 | consultation round-trip THROUGH THE SHIPPED PRODUCT PATH, asserted GATE-ON (review round 14: an earlier row said "in BOTH gate states", which no implementation can satisfy — the rollout specification requires the gate-OFF write surface to REFUSE and emit nothing, so a gate-off round-trip either fails or is only reachable by enabling the gate, which would invalidate the mixed-version safety proof. The gate-OFF arm therefore asserts REFUSAL with no row, no event and no push; the round-trip below is gate-ON), plus — per the 4c-iii retirement — a project CREATED AFTER that deployment reaching the routes with no further operator action, so the gate is a rollout latch and not a permanent pilot: request → respond over the guarded HTTP routes with the shared `ROLE_POLICY` actions, the respond ceiling admitting every consultee-eligible role in the EXISTING vocabulary (a NON-pmc consultee — contractor/engineer/consultant/client — completes the round-trip in the RENDERED flow, not only the HTTP response; the service narrows to the named consultee; 4c adds NO role), append-only (UPDATE/DELETE sealed at the row AND `TRUNCATE` sealed at the statement — both tables carry named no-truncate seals, each hostile-probed, since row triggers never fire for TRUNCATE), non-blank evidence refused at zod AND the CHECK AND a NULL direct insert refused (`NOT NULL` on both evidence columns — a CHECK over NULL passes as UNKNOWN); ONE response per consultation — a second respond is a deterministic 409 under a different idempotency key, and the direct duplicate insert is refused by the UNIQUE | the two new tables' migration + contracts + the response UNIQUE + `ROLE_POLICY`/route registration (`RolesGuard` today rejects roles absent from a route's ceiling before any service check) |
| P24 | consultation moves NO status and NO gate verdict — the EXPLICIT `(status, gate verdicts)` projection byte-equal before/after, with a SEPARATE assertion that the consultation DTO/audience DID change (full-snapshot equality is unsatisfiable and would force the probe to omit the served consultation data) | `DecisionsService` status CAS surface; the gate reader |
| P25 | visibility widening bounded by eligibility: published-only + open-status at request AND response; the withdrawn-leak refusal (no title/reason reachable); request → withdraw → late-response refused 409; the DB INSERT seal refusing a direct consultation row against a withdrawn AND a draft decision (visibility never widened by a forged row) AND a row whose `requestedById` lacks requesting authority (an inactive or unauthorized requester never fabricates a standing request) AND a row naming a REMOVED consultee membership (the request seal's `phase6_membership_is_active` arm probed directly — a raw writer must not mint a request a later membership reactivation would make visible and answerable) AND the WRONG-AUDIENCE row whose canonical `consulteeUserId` is NOT the user `phase6_membership_active_user(projectId, consulteeMembershipId)` resolves (review round 10: that column is the projection's rebuildable audience, so an unchecked one would mint a projected slice and a widened view for a stranger — a reachable forgery, unlike the re-key the delivered identity freeze makes unrepresentable) AND the PROVENANCE arms — a `sourceCommandId` that is absent, names another project's command, is fabricated, is an ALREADY-SPENT receipt, is a `succeeded` or wrong-TYPE receipt rather than the `reserved` command currently executing, or whose command commits with a `resultRef` naming something else (review round 11 identified the eventless alternate write the `decisions.inbox` consumer would never see; review round 12 bound the receipt to the command's RESULT so a COPIED valid id no longer satisfies it) — AND the INITIAL-CYCLE arms, a request row whose `openCycle` is the decision's current approval count minus one or plus one, both refused under the locked decision row (review round 12: an unsealed initial value lets a legitimate command bug mint a consultation that becomes answerable in the WRONG cycle after one approve-and-reopen) AND the DIRECT-request-insert-vs-archive BARRIER, asserted as the TWO reachable outcomes rather than a uniform refusal (review round 9: the seal locks `Project` before reading operability, so insert-first WINS the lock, reads the project operable and commits — the archive then waits and commits after, leaving valid historical evidence; only archive-first makes the insert wait and then reject. The same two-outcome shape P41 already states for the command path); and the IDENTITY-FREEZE premise probe — a hostile `UPDATE "Membership" SET "userId" = …` is REJECTED by the delivered `Membership_t4b_identity_frozen`, which is why `consulteeMembershipId` is a lifetime identity, why the canonical `consulteeUserId` beside it can never DRIFT (its seal arm guards forgery, not drift), and why no re-key probe appears anywhere in this plan | `decisionVisibleToViewer`; the request/response guards + the consultation INSERT seal |
| P25c | the PROJECTED path THROUGH BOTH EVENTS: after the request, the consultee's `decisions.inbox` slice admits exactly the consulted decision and a same-role non-consultee's does not; after the RESPONSE, the projected slice carries the ANSWERED thread (a fold that consumes `consultation_requested` but drops `consultation_responded` fails here); and a rebuild preserves BOTH states (live == projection == rebuild after the request AND after the response). The audience is the DECISIONS-OWNED CANONICAL `DecisionConsultation.consulteeUserId` reached through the widened `DECISION_INCLUDE` — never a payload-only field and never re-resolved from `Membership` at fold time, which would be a cross-module read from a projection (review round 10): `rebuildSeed` seeds from `tx.decision.findMany({ include: DECISION_INCLUDE })` and replays no historical payloads, so ONLY a canonical column lets the three converge. Two arms hold it: the DELIVERED-FOLD arm — the probe PROCESSES the ordered delivery and then requires `moduleDecisions` to answer `source: 'projection'` with the consultee's slice, NOT merely to return it immediately (review round 13: until the relay applies the delivery, `readServableGeneration` rejects the lagging generation and `moduleDecisions` falls back to `source: 'live'`, so an immediate read passes even with a broken fold; the live fallback already guarantees immediacy) — and the provenance arm, since the eventless alternate write that would leave a stale generation looking caught up is refused by the `sourceCommandId` FK (review round 11, replacing an arm that asserted an accepted eventless insert) | the `decisions.inbox` projection row schema/fold/filter and `DECISION_INCLUDE` (decider-only today) |
| P25d | the response-side DB seal: a direct `DecisionConsultationResponse` INSERT against an ineligible decision; the REOPENED-CYCLE response — request while `pending` → approve → `decisions.requestChange` back to `change` → a late response, refused 409 at the service AND at the database because the decision's current open cycle no longer equals the consultation's frozen `openCycle` (review round 11: a status-only guard would revive a consultation the approval closed and mix two decision cycles in one immutable thread), with no response row and no `consultation_responded` effect; one whose `sourceCommandId` names no command-ledger row in this project, or an already-spent, `succeeded`, or wrong-type receipt, or one whose command commits with a `resultRef` naming another row (review round 12); one whose recorded `respondedById` is not the consultee's user as resolved by `phase6_membership_active_user(projectId, consulteeMembershipId)`; one naming a REMOVED consultee's own user (removed-then-hostile-insert — the same locked call returns NULL once the membership is inactive); one into an already-archived project — each refused at the database; AND the DIRECT-insert-vs-archive BARRIER asserted as its TWO reachable outcomes (review round 9: insert-first takes the `Project` lock, reads operable and COMMITS, the archive committing after it — historical evidence against a then-operable project; archive-first makes the insert wait and REJECT. A uniform "refused in both orderings" was unreachable and contradicted this plan's own P41 row) | the response table's migration seals + the `respondedById` column they judge |
| P26 | consultation pushes exact: consultee push on request, requester push on response — including the org-admin requester with no membership row | the user-target dispatch delivered by 4b (P21) |
| P27 | EVERY project-scoped consultation FK proven by hostile insert, not just claimed: a consultation pairing project A with project B's DECISION; one pairing project A with project B's consultee MEMBERSHIP; a response whose `projectId` disagrees with its consultation's; and the option arms — an out-of-range index refused at the contract, a foreign decision's option id refused by the `(decisionId, id)` composite FK (a 4c-i that accidentally created scalar FKs fails these before the migration becomes immutable history) | the consultation-row and response-row composite FKs and candidate keys |
| P38c/P40c | the consultation push families' pre-send AND claim-time standing, PROJECT OPERABILITY FIRST: a project archived — or a consultee removed (the claim re-resolves the membership through `phase6_membership_active_user`, which returns NULL once it is inactive — the response seal's own arm applied at send time), or a requester demoted — between enqueue and claim never receives decision content (the transactional `isProjectOperable` lock-and-check; re-targeted or dropped with the recorded mark); an ALREADY-ANSWERED `consultation_requested` delivery is cancelled with the recorded mark (no request-to-respond push after the response exists); a decision APPROVED between enqueue and claim likewise cancels its `consultation_requested` delivery, since §A's respond command would 409 the push's own invitation (review round 10: the claim re-checks the published `pending`/`change` set, not merely un-withdrawn); a still-standing consultee push survives; the APPROVE-VS-CLAIM BARRIER in both orderings, proving the claim takes the DECISION row's lock before reading status and cycle rather than relying on the `Project` lock, which serializes archival only (review round 12: claim-first → the push stands against a then-open decision; approve-first → the delivery is recorded CANCELLED and nothing is sent); and the MIXED-VERSION arms, split by the two REACHABLE GATE STATES rather than by consumer class (review round 10) — **gate OFF with old-shaped consumers present**: the consultation write surface refuses, NO `decision.consultation_*` event is emitted, so no old projection worker, push worker or API reader can ever claim or serve one, and every other project's behaviour is byte-identical to today; **gate ON with upgraded-only consumers**: the full flow — the fold carries the thread, the push families honour every claim predicate, the consultee's read is correct on every instance. The two states are EXHAUSTIVE, and the deliberately UNASSERTED combination is gate-on-beside-an-old-worker: the outbox has ONE ordered delivery per consumer, so an old worker there WOULD claim it and perform the stale fold or unguarded send — that is the hazard the deploy-then-enable RUNBOOK order forbids, not a behaviour any code in this unit can prevent, and a probe asserting otherwise would be unsatisfiable | the per-family predicate registration (decider-only today) + the pre-send guard + the ordered-consumer rollout seam + the capability-gated write surface |
| P41 | eligibility is checked UNDER the decision row lock on BOTH write paths, ACQUIRED IN THE CANONICAL ORDER (readiness → `Project` → `Membership` → `Decision`, §A) with a consultee-IS-decider arm proving no deadlock abort against `decisions.approve` in either ordering — approval takes `Membership` before `Decision`, so any 4c path locking them the other way round would force PostgreSQL to abort one side (review round 13) — barrier-controlled in both orderings each: request-vs-withdraw (request-first → withdraw sees the widening it must revoke nothing for; withdraw-first → request 409); response-vs-withdraw (response-first → the advice and its push stand against a then-eligible decision; withdraw-first → respond 409, NO response row and NO `consultation_responded` effect exists — the final-state invariant asserted directly); archive-vs-response (respond-first → the advice stands against a then-operable project; archive-first → respond 409 with no row and no effect — the in-tx `isProjectOperable` lock-and-check serializing the two); AND archive-vs-REQUEST (request-first → the consultation and its push stand; archive-first → request 409, NO consultation row and NO `consultation_requested` effect exists — review round 3: §A binds BOTH write commands to the in-tx operability lock, and without this arm an implementation could lock the response path only, letting a request that passed the outer access check append into a concurrently-archived project while every listed ordering passed) | the consultation command's AND the response command's lock acquisition |

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
- **4c implementation follows as THREE PRs — 4c-i, 4c-ii, then the
  gate-retirement unit 4c-iii — the first two honouring the mandatory
  migration seam** (review round 1: the additive schema is deployable before
  any caller uses it — that viable seam makes a single migration+service+UI
  PR a violation of the repository's migration review-unit rule, and this
  plan takes the seam rather than claiming an inseparable unit):
  - **4c-i, the migration unit**: ONE additive migration only — the two
    tables (with their own `projectId`, the consultation's canonical
    `consulteeUserId` audience column and its frozen `openCycle`, the
    response's `respondedById`, and BOTH tables' `NOT NULL sourceCommandId`
    with its project-contained composite FK to `CommandExecution(projectId,
    id)` — the delivered §C rule-ii provenance shape — plus the
    `(projectId, sourceCommandId)` one-use UNIQUE per table and the
    DEFERRABLE INITIALLY DEFERRED result-binding constraint trigger §A
    specifies),
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
    reinstated canonical column guards), the PROVENANCE arms on BOTH
    tables (an absent, foreign-project, fabricated, already-SPENT,
    `succeeded`, or wrong-TYPE `sourceCommandId` refused at INSERT, and a
    commit whose command's `resultRef` names another row refused by the
    DEFERRED constraint trigger — so no accepted write is invisible to the
    projection), the INITIAL-CYCLE arms (a request row whose `openCycle` is
    the current approval count minus or plus one, refused under the locked
    decision row), and the
    response seal's REOPENED-CYCLE arm (a late response after
    approve-then-reopen refused at the database because the decision's
    current cycle no longer equals the consultation's frozen `openCycle`),
    append-only INCLUDING the two
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
    complete. The deploy-then-enable order is a RUNBOOK step and the capability
    row is the machine-checkable predicate the write surface and the emitter
    both read. **4c-i makes that row impossible to PRE-enable** (review round
    13): `ProjectCapability` is `@@id([projectId, capability])` over a
    FREE-TEXT `capability` column with NO whitelist, and `capability:enable`
    accepts any string — so a `consultation` row could already exist before
    4c-ii deploys, and the first upgraded instance would emit while old workers
    still ran, exactly what the gate exists to prevent. 4c-i therefore (a)
    ABORTS, diagnostic-first, if ANY `capability = 'consultation'` row exists,
    since the unit is dark and nothing legitimate can have created one, and (b)
    adds a CHECK restricting `capability` to the KNOWN set — **every value
    already SHIPPED, plus the new one** (review round 14): `materials`,
    `labour`, `commercial`, `consultation`. `CapabilitiesService` declares all
    three existing ones (`MATERIALS_CAPABILITY`, `LABOUR_CAPABILITY`,
    `COMMERCIAL_CAPABILITY` — the Phase-5 §L commercial pilot), and an earlier
    draft's set omitted `commercial`, which would have ABORTED 4c-i on any
    commercial pilot project or made every later
    `capability:enable --capability commercial` fail. The general rule, stated
    so the next unit adding a value does not repeat it: a whitelist introduced
    over an EXISTING free-text column enumerates what production already
    contains, and the migration's diagnostic aborts on an unrecognized value
    rather than silently narrowing the vocabulary. The CHECK is itself
    diagnostic-first — aborting on an unrecognized existing value rather than
    failing opaquely — so no stray string can ever mint a gate again. After that the row appears only through
    the deliberate operator step. The residual is stated rather than hidden: an
    operator running the enable step early, after 4c-i but before the fleet has
    drained, is performing the action the RUNBOOK order forbids — now a
    deliberate act against a whitelisted capability, not an accident. And
    **the MIXED-VERSION proof is split by those two gate
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
    correct on every instance. **But draining API processes is NOT enough,
    because BROWSER TABS cannot be drained** (review round 13): an
    already-open tab keeps running the PREVIOUS web bundle, whose audience
    selectors discard a non-decider's pending decision, so after the gate
    opens a new PMC could request a consultation and the consultee could
    receive the push while their live tab hides both the decision and the
    respond affordance — the server-side reader gate cannot see that client at
    all. This repository already solved exactly this problem and says so:
    `RecordedCompatInterceptor` documents that browser tabs cannot be drained
    and negotiates the shape with a CLIENT CONTRACT header — a request sending
    `x-vitan-decisions-contract: recorded-v1` receives the full register, one
    without it receives the older shape
    (`apps/api/src/common/recorded-compat.interceptor.ts`). 4c extends that
    SAME mechanism rather than inventing one: the new bundle advertises a
    consultation-aware contract value, and the consultation WRITE commands
    REFUSE a request whose caller has not advertised it — so a stale tab can
    never originate a consultation its own UI could not then show, and the
    reads it makes continue to receive the shape it understands. The
    MIXED-VERSION probe therefore covers the CLIENT axis too: an old-bundle
    request to `consultations.request` is refused with the upgrade-your-tab
    error, and the same request from an advertising bundle succeeds.

    **What that refusal can and cannot reach — stated plainly** (review round
    15). It gates the ORIGINATOR, which the server observes on the very
    request it is judging. It does NOT gate the named CONSULTEE's client, and
    deliberately so: the server cannot know what bundle a consultee's tab is
    running — they may have no tab open at all — and the only way to guess is
    a last-seen contract per user, which would make anyone who has not opened
    the app since the upgrade PERMANENTLY un-consultable. That trades a
    transient display gap for a durable authorization gap, and is worse.
    Nor can any server response repair it: the pre-4c bundle's
    `selectVisibleDecisions` filters CLIENT-SIDE
    (`status !== 'pending' || viewerIsDecider(...)`,
    `apps/web/src/store/selectors.ts`), so no DTO shape makes an old tab render
    the row — and the one shape that would, claiming the consultee is the
    decider, is a lie that corrupts the register's attribution. So the residual
    is REAL and is disclosed rather than designed around: a consultee whose tab
    was already open on the pre-4c bundle sees nothing IN THAT TAB until it
    reloads. What carries them is the channel that does not run in the tab —
    the `consultation_requested` PUSH is delivered regardless of bundle
    version, and following it loads the document afresh, which serves the
    current bundle, where the thread and the respond affordance are present.
    4c-ii additionally ships the bundle-version signal the NEW bundle honours,
    so this is the LAST release in which an open tab can be stale about
    consultation at all; that signal cannot help clients that predate it, which
    is exactly why the sender-side refusal and the push path both exist here. **And the gate RETIRES — it is a rollout
    latch, not a permanent pilot** (review round 11): `materials` and `labour`
    are genuine per-project product pilots, but consultation is a CORE
    decision workflow, so leaving it opt-in would strand every project created
    after the enable step with request/respond routes that 404 forever, with
    no path out. The retirement is three named steps: (1) deploy
    4c-ii with emission OFF; (2) once the rollout is confirmed drained, ONE
    OPERATOR step backfills the capability row for every EXISTING project —
    data only, no behaviour change, which is what the RUNBOOK's
    deploy-then-enable order names; (3) a LATER DEPLOYMENT, its own
    compatibility-staged unit landing after the fleet is fully upgraded, makes
    `projects.create` enable the capability for new projects, backfills any
    project created since step 2, and only THEN deletes the gate reads from
    the write surface and the emitter. **Automatic enablement belongs to step
    3's deployment, not to step 2's operator moment** (review round 12,
    correcting an earlier draft that said `projects.create` "begins" enabling
    at step 2): deployed code cannot start behaving differently because an
    operator acted, so that wording could only mean the create path enables
    from its own DEPLOY time — and a project created through an upgraded API
    while old workers and readers were still draining would be immediately
    gate-on, its consultation event claimable by the old projection worker or
    sendable by the old unguarded push path, which is exactly what the gate
    exists to prevent. The `ProjectCapability` mechanism holds per-project rows
    only, so no later operator action can reach back into already-deployed
    create code. Staging enablement into step 3 needs no new mechanism; the
    alternative — a separate rollout-complete LATCH that `projects.create`
    reads — was considered and rejected for adding a second gate to reason
    about when the deployment boundary already provides the ordering. The cost
    is stated plainly: a project created BETWEEN steps 2 and 3 carries no row
    and its consultation routes 404 until step 3, a bounded and
    operator-visible window that step 3's own backfill closes. The probe is
    step 3's: a project created after that deployment reaches the consultation
    routes with no further operator action.
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
  - **4c-iii, the gate-retirement unit** (review round 13: the step-3
    deployment above is MANDATORY, so it gets an executable review-unit slot
    rather than a prose promise — without one the autonomous runner would
    advance to 4d after 4c-ii, leaving every project created after step 2
    without a capability row and its consultation routes 404 with nothing
    scheduled to close the window). It lands AFTER the operator backfill and
    after the fleet is confirmed drained, and it carries exactly: enablement at
    `projects.create`, the backfill of any project created since step 2, and
    the REMOVAL of the capability-gate reads from the write surface and the
    emitter — each additive and separately revertible. **It does NOT remove the
    CLIENT-CONTRACT refusal** (review round 14): the two mechanisms answer to
    different clocks, and an earlier draft retired them together. The
    capability gate is a ROLLOUT latch, discharged once the SERVER fleet has
    drained — which 4c-iii is the deployment that confirms. Contract
    negotiation answers to CLIENT versions, and browser tabs cannot be drained
    at all (`RecordedCompatInterceptor` says so in as many words): dropping the
    refusal at 4c-iii would let a stale tab advertising only the old contract
    originate a consultation again, for a consultee whose own stale tab hides
    the decision and the respond affordance — reopening precisely the hole
    round 13 closed. The refusal therefore lives on the same clock as
    `recorded-v1` itself, retired only when the old browser contract is no
    longer supported, which is its own unit and not 4c's. Its probes: a project
    created after this deployment reaches the consultation routes with no
    operator action; an existing project is unaffected; no capability row is
    required anywhere once the gate reads are gone; AND an old-contract client
    is STILL refused after retirement. **4c is not
    complete until 4c-iii merges**, and the §E handoff to 4d is gated on it —
    the runner may not treat 4c-ii's merge as the end of the unit. **The
    prerequisite is FAIL-CLOSED through the delivered control plane, not an
    awaited human** (review round 15): 4c-ii's own STATUS fold SETS
    `blocking_directive` naming the rollout prerequisite (drain confirmed, the
    all-project backfill executed), with `task_state: correction_required`.
    `assessRunnerState` then resolves to `directive:<name>` rather than
    advancing — it cannot start 4c-iii or hand off to 4d while the directive
    stands, and it flags the incoherent shape if a directive is set beside a
    non-directive state (`scripts/autonomous-status-state.mjs`). Clearing the
    directive is a STATUS commit, so the prerequisite has a machine-observed
    state AND an attributable, reviewable record of who declared the fleet
    drained — the same shape every other blocking directive in this loop uses.
    Without it the runner would either strand silently or advance past the
    rollout ordering; with it, stranding is impossible and skipping is
    impossible.
- 4d (architect, forwarding, countersign) is NOT this unit: its plan unit
  follows 4c implementation — ALL THREE PRs, 4c-iii included — per the merged
  §E order, carrying §D obligations 4–6.

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
