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
  this row, or the commit fails;
- **and at BOTH moments, the ACTOR must match** (review round 17): the
  referenced `CommandExecution.actorId` must EQUAL the fact's own recorded
  actor — `requestedById` on the consultation, `respondedById` on the response.
  Without this the receipt constrains project, type, state, reuse and result
  identity but says nothing about WHO acted, so an alternate writer could
  reserve a genuine `consultations.request` as PMC A, attribute the immutable
  row to a different authorized PMC B, let the command complete with the
  correct `resultRef`, and satisfy every other arm — leaving an append-only
  fact that permanently contradicts its own provenance. The response path is
  worse: it could record the named consultee as the responder while a different
  actor executed the command, which is exactly the forgery `respondedById`
  exists to prevent. Probed on both tables with a receipt whose `actorId` names
  someone other than the row's recorded actor.

**And both commands REQUIRE an `Idempotency-Key`, refusing without one with a
deliberate 400** (review round 19): when `COMMAND_KEY_ENFORCED` is unset or
false and a caller omits the header, the delivered kernel takes its LEGACY
unkeyed branch, which reserves NO ledger row and runs with
`{ commandId: null }` (`apps/api/src/platform/commands.ts`). Both new tables
require a non-null `sourceCommandId` naming the currently reserved receipt, so
that branch cannot serve them: without the refusal the write reaches PostgreSQL
and surfaces as an internal constraint failure — a 500 where the honest answer
is that this command needs a key. The refusal sits at the contract, before any
work, and P23 gains the MISSING-KEY probe rather than testing only keyed
round-trips.

Probed (P25/P25d) as: reuse of an already-SPENT receipt; a `succeeded`
unrelated receipt; a wrong-TYPE receipt; and a row whose command commits with a
`resultRef` naming something else. Stated honestly, the residual is a writer
who forges a whole ledger row — which is forging a COMMAND, and is the command
ledger's own discipline, not something these two tables can or should
re-litigate. **That discipline is a DELIVERED database seal, named here so the
claim is checkable** (review round 24, after a review searched for it and
concluded no such seal existed): migration
`20270425000000_platform_command_receipt_seal` installs
`CommandExecution_receipt_protocol` `BEFORE INSERT OR UPDATE`, which refuses a
receipt minted already terminal, FREEZES receipt identity (`actorId`,
`commandType`, `idempotencyKey`, `requestHash`, `createdAt`, `id` and the scope
columns), makes a completed receipt immutable in outcome, result and
completion time, and requires the completing UPDATE to come from the SAME
transaction that inserted the row (`xmin = txid_current()`). So the specific
attacks are already refused: an unused receipt cannot be re-pointed at a chosen
actor or command type, a receipt reserved in an earlier transaction cannot be
adopted and completed later, and an existing fact's provenance cannot be
rewritten afterwards. What the seal's own header documents as remaining — and
4c neither widens nor re-litigates — is a deliberate multi-statement forgery
performed inside ONE transaction by a role holding INSERT/UPDATE on the ledger,
whose answer is a privilege grant (`docs/RUNBOOK.md §CMDR`) rather than another
trigger, since no trigger can distinguish "the application ran" from "SQL that
reproduced what the application would have written". The probes then follow the states that
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
level as well. **And the sanctioned reset is updated in the SAME unit**
(review round 18): `apps/api/prisma/seed.ts` truncates
`DecisionApprovalRevision` directly and disables only
`ActivityDependency_no_truncate` around that statement, so installing this seal
as a migration-only change would break every repeated seed and e2e run against
a previously seeded database — the new trigger raises before the reset can
clear the rows. 4c-i therefore carries the guarded disable/enable of the new
trigger inside that same transactional reset, exactly as the delivered seals
before it did. **And `seed.ts` is not the only reset** (review round 20): 49 integration
files reference this register and truncate it directly in their own
setup/teardown (`start-readiness-race.test.ts`, `phase1-baseline.test.ts`, and
47 more). A `BEFORE TRUNCATE` trigger fires even on an EMPTY table, so every
one of them would fail the moment 4c-i installs the seal — the required
integration battery would stop being runnable, which is a worse outcome than
the forgery the seal prevents. The sweep must also cover CASCADE PARENTS, not
just direct truncations (review round 21): `event-catalog.test.ts` truncates
`"Decision", … CASCADE` and disables only the Decision, DecisionEvent and
DecisionOption guards — PostgreSQL includes `DecisionApprovalRevision` in that
cascade and fires its trigger anyway, so that suite still fails after every
direct truncation is converted. The sanctioned reset is therefore CENTRALIZED
into one shared helper performing the guarded disable/truncate/re-enable, which
the suites call instead of issuing raw `TRUNCATE` — direct and cascade-parent
alike — so the next seal on a reset-covered table changes one place, not fifty.

**That sweep is its own PREREQUISITE unit, 4c-0** (review round 21): it touches
at least 47 integration files plus the helper and the seed reset, which alone
exceeds the 20-file review budget — and folding it into 4c-i would push that
unit over the limit while burying a mechanical refactor inside a migration
review. 4c-0 is PURE refactor: it introduces the helper and converts every
sanctioned reset to it with NO seal installed and NO behaviour change, so it is
reviewable as exactly what it is and is separately revertible. It carries the
`justified-large` marker with its file count as the evidence, since a
mechanical sweep cannot be split further without leaving the battery
half-converted. 4c-i then installs the seal against an already-centralized
reset and stays inside the budget. A seal whose only artifact is its migration
is not finished: the repository's own reset contract is part of installing it,
and "the reset" means every sanctioned one — cascades included.

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
with the 4a re-seal discipline — **and that discipline DICTATES 4c-ii's
deployment shape, which is therefore NOT a plain rolling upgrade** (review
round 21). Adding either key changes `effectCoverageVersion()`, and
`outbox.bootstrap.ts` REFUSES to start a process with the production
`OUTBOX_SENDER_MODE=outbox` unless the persisted cutover seal's
`coverageVersion` equals the compiled one — "reseal (in legacy/shadow) after
the external-effect catalog changed". So an upgraded instance would abort at
boot until the seal is regenerated, and `docs/RUNBOOK.md`'s reseal sequence
requires ZERO old instances, deployment in legacy/shadow mode, an audited
`outbox:seal-external`, and only then a restart into outbox mode. Earlier
drafts of this plan assumed old instances kept serving THROUGH 4c-ii and
drained afterwards; those two cannot both hold. 4c-ii therefore follows the
DELIVERED cutover sequence rather than a rollout invented here: the fleet is
taken to zero old instances, the new build is deployed in legacy/shadow mode,
the reseal is run and audited, and the fleet restarts into outbox mode. Note
what this simplifies rather than complicates — the drain happens as PART of
4c-ii instead of after it, so the consumer-catalog fence and the capability
reservation are both protecting a window that the cutover already closes; they
stay because a fence that is redundant in the intended sequence is exactly what
catches an unintended one. The `blocking_directive` still attests the drain,
now as confirmation that the cutover completed. The catalog-data migration is a
SEPARATE seal from this one and updates neither — both move in 4c-ii, each by
its own mechanism, and 4c-ii's packet shows both verified, riding 4b's user-targeted dispatch — the
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
   `decisionVisibleToViewer` widening does. **And PRE-4c stored DTOs are
   hydrated at read time** (review round 18): widening `DECISION_INCLUDE` and
   the serializer does not rewrite JSON already stored in an ACTIVE, caught-up
   generation, and the `catalogVersion` bump does not trigger a rebuild — so a
   quiet project could keep answering `source: 'projection'` with pre-4c DTOs
   that lack the consultation collection entirely, breaking live/projection
   equality and the new UI until some unrelated decision event happened to
   refresh it. P25c did not catch this because its own first request emits the
   event that refreshes every row. The read path therefore HYDRATES a stored
   DTO without the collection to the EMPTY consultation shape — the same
   compatibility move the delivered decider path already makes — and P25c gains
   the probe that names the gap: a generation materialized BEFORE 4c-ii, left
   untouched, serves the empty shape rather than a missing field, and matches
   live. PROVES: after a consultation is
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
already uses to prove delivered seals precise rather than merely strict.
**BOARD DECISION, not re-litigable** (2026-08-29, on PR #480): the
seal-stripped run IS the accepted formulation, and no fourth one is to be
invented. A constraint on a table the same migration creates has no base
behaviour to be red against — probing the base schema errors on a missing
relation — so "red at base" for this class means exactly what is written
here. Red sites name where today's behavior lives.

| probe | proves | red site / staging |
|---|---|---|
| P23 | consultation round-trip THROUGH THE SHIPPED PRODUCT PATH, asserted GATE-ON (review round 14: an earlier row said "in BOTH gate states", which no implementation can satisfy — the rollout specification requires the gate-OFF write surface to REFUSE and emit nothing, so a gate-off round-trip either fails or is only reachable by enabling the gate, which would invalidate the mixed-version safety proof. The gate-OFF arm therefore asserts REFUSAL with no row, no event and no push; the round-trip below is gate-ON), plus — per the 4c-iv retirement behaviour — a project CREATED AFTER that deployment reaching the routes with no further operator action, so the gate is a rollout latch and not a permanent pilot: request → respond over the guarded HTTP routes with the shared `ROLE_POLICY` actions, the respond ceiling admitting every consultee-eligible role in the EXISTING vocabulary (a NON-pmc consultee — contractor/engineer/consultant/client — completes the round-trip in the RENDERED flow, not only the HTTP response; the service narrows to the named consultee; 4c adds NO role), append-only (UPDATE/DELETE sealed at the row AND `TRUNCATE` sealed at the statement — both tables carry named no-truncate seals, each hostile-probed, since row triggers never fire for TRUNCATE), non-blank evidence refused at zod AND the CHECK AND a NULL direct insert refused (`NOT NULL` on both evidence columns — a CHECK over NULL passes as UNKNOWN); ONE response per consultation — a second respond is a deterministic 409 under a different idempotency key, and the direct duplicate insert is refused by the UNIQUE | the two new tables' migration + contracts + the response UNIQUE + `ROLE_POLICY`/route registration (`RolesGuard` today rejects roles absent from a route's ceiling before any service check) |
| P24 | consultation moves NO status and NO gate verdict — the EXPLICIT `(status, gate verdicts)` projection byte-equal before/after, with a SEPARATE assertion that the consultation DTO/audience DID change (full-snapshot equality is unsatisfiable and would force the probe to omit the served consultation data) | `DecisionsService` status CAS surface; the gate reader |
| P25 | visibility widening bounded by eligibility: published-only + open-status at request AND response; the withdrawn-leak refusal (no title/reason reachable); request → withdraw → late-response refused 409; the DB INSERT seal refusing a direct consultation row against a withdrawn AND a draft decision (visibility never widened by a forged row) AND a row whose `requestedById` lacks requesting authority (an inactive or unauthorized requester never fabricates a standing request) AND a row naming a REMOVED consultee membership (the request seal's `phase6_membership_is_active` arm probed directly — a raw writer must not mint a request a later membership reactivation would make visible and answerable) AND the WRONG-AUDIENCE row whose canonical `consulteeUserId` is NOT the user `phase6_membership_active_user(projectId, consulteeMembershipId)` resolves (review round 10: that column is the projection's rebuildable audience, so an unchecked one would mint a projected slice and a widened view for a stranger — a reachable forgery, unlike the re-key the delivered identity freeze makes unrepresentable) AND the PROVENANCE arms — a `sourceCommandId` that is absent, names another project's command, is fabricated, is an ALREADY-SPENT receipt, is a `succeeded` or wrong-TYPE receipt rather than the `reserved` command currently executing, or whose command commits with a `resultRef` naming something else, or whose receipt's `actorId` is NOT the row's recorded `requestedById` (review round 17: without actor equality a genuine receipt reserved by one PMC can attribute the immutable row to another) (review round 11 identified the eventless alternate write the `decisions.inbox` consumer would never see; review round 12 bound the receipt to the command's RESULT so a COPIED valid id no longer satisfies it) — AND the INITIAL-CYCLE arms, a request row whose `openCycle` is the decision's current approval count minus one or plus one, both refused under the locked decision row (review round 12: an unsealed initial value lets a legitimate command bug mint a consultation that becomes answerable in the WRONG cycle after one approve-and-reopen) AND the DIRECT-request-insert-vs-archive BARRIER, asserted as the TWO reachable outcomes rather than a uniform refusal (review round 9: the seal locks `Project` before reading operability, so insert-first WINS the lock, reads the project operable and commits — the archive then waits and commits after, leaving valid historical evidence; only archive-first makes the insert wait and then reject. The same two-outcome shape P41 already states for the command path); and the IDENTITY-FREEZE premise probe — a hostile `UPDATE "Membership" SET "userId" = …` is REJECTED by the delivered `Membership_t4b_identity_frozen`, which is why `consulteeMembershipId` is a lifetime identity, why the canonical `consulteeUserId` beside it can never DRIFT (its seal arm guards forgery, not drift), and why no re-key probe appears anywhere in this plan | `decisionVisibleToViewer`; the request/response guards + the consultation INSERT seal |
| P25c | the PROJECTED path THROUGH BOTH EVENTS: after the request, the consultee's `decisions.inbox` slice admits exactly the consulted decision and a same-role non-consultee's does not; after the RESPONSE, the projected slice carries the ANSWERED thread (a fold that consumes `consultation_requested` but drops `consultation_responded` fails here); and a rebuild preserves BOTH states (live == projection == rebuild after the request AND after the response). The audience is the DECISIONS-OWNED CANONICAL `DecisionConsultation.consulteeUserId` reached through the widened `DECISION_INCLUDE` — never a payload-only field and never re-resolved from `Membership` at fold time, which would be a cross-module read from a projection (review round 10): `rebuildSeed` seeds from `tx.decision.findMany({ include: DECISION_INCLUDE })` and replays no historical payloads, so ONLY a canonical column lets the three converge. Two arms hold it: the DELIVERED-FOLD arm — the probe PROCESSES the ordered delivery and then requires `moduleDecisions` to answer `source: 'projection'` with the consultee's slice, NOT merely to return it immediately (review round 13: until the relay applies the delivery, `readServableGeneration` rejects the lagging generation and `moduleDecisions` falls back to `source: 'live'`, so an immediate read passes even with a broken fold; the live fallback already guarantees immediacy) — and the provenance arm, since the eventless alternate write that would leave a stale generation looking caught up is refused by the `sourceCommandId` FK (review round 11, replacing an arm that asserted an accepted eventless insert) | the `decisions.inbox` projection row schema/fold/filter and `DECISION_INCLUDE` (decider-only today) |
| P25d | the response-side DB seal: a direct `DecisionConsultationResponse` INSERT against an ineligible decision; the REOPENED-CYCLE response — request while `pending` → approve → `decisions.requestChange` back to `change` → a late response, refused 409 at the service AND at the database because the decision's current open cycle no longer equals the consultation's frozen `openCycle` (review round 11: a status-only guard would revive a consultation the approval closed and mix two decision cycles in one immutable thread), with no response row and no `consultation_responded` effect; one whose `sourceCommandId` names no command-ledger row in this project, or an already-spent, `succeeded`, or wrong-type receipt, or one whose command commits with a `resultRef` naming another row (review round 12), or one whose receipt's `actorId` is NOT the row's recorded `respondedById` (review round 17); one whose recorded `respondedById` is not the consultee's user as resolved by `phase6_membership_active_user(projectId, consulteeMembershipId)`; one naming a REMOVED consultee's own user (removed-then-hostile-insert — the same locked call returns NULL once the membership is inactive); one into an already-archived project — each refused at the database; AND the DIRECT-insert-vs-archive BARRIER asserted as its TWO reachable outcomes (review round 9: insert-first takes the `Project` lock, reads operable and COMMITS, the archive committing after it — historical evidence against a then-operable project; archive-first makes the insert wait and REJECT. A uniform "refused in both orderings" was unreachable and contradicted this plan's own P41 row) | the response table's migration seals + the `respondedById` column they judge |
| P26 | consultation pushes exact: consultee push on request, requester push on response — including the org-admin requester with no membership row | the user-target dispatch delivered by 4b (P21) |
| P27 | EVERY project-scoped consultation FK proven by hostile insert, not just claimed: a consultation pairing project A with project B's DECISION; one pairing project A with project B's consultee MEMBERSHIP; a response whose `projectId` disagrees with its consultation's; a response that changes BOTH `decisionId` and `recommendedOptionId` to another SAME-PROJECT decision (review round 21: the other arms pass even if the response→consultation FK omits `decisionId` — the cross-project arm is caught by `projectId` and the option arm by the same-decision option FK — so only this one proves the third parent-key column participates, catching a same-project writer who pairs consultation A with decision B and B's option, permanently attaching a recommendation to the wrong decision); and the option arms — an out-of-range index refused at the contract, a foreign decision's option id refused by the `(decisionId, id)` composite FK (a 4c-i that accidentally created scalar FKs fails these before the migration becomes immutable history) | the consultation-row and response-row composite FKs and candidate keys |
| P38c/P40c | the consultation push families' pre-send AND claim-time standing, PROJECT OPERABILITY FIRST: a project archived — or a consultee removed (the claim re-resolves the membership through `phase6_membership_active_user`, which returns NULL once it is inactive — the response seal's own arm applied at send time), or a requester demoted — between enqueue and claim never receives decision content (the transactional `isProjectOperable` lock-and-check; re-targeted or dropped with the recorded mark); an ALREADY-ANSWERED `consultation_requested` delivery is cancelled with the recorded mark (no request-to-respond push after the response exists); a decision APPROVED between enqueue and claim likewise cancels its `consultation_requested` delivery, since §A's respond command would 409 the push's own invitation (review round 10: the claim re-checks the published `pending`/`change` set, not merely un-withdrawn); a still-standing consultee push survives; the APPROVE-VS-CLAIM BARRIER in both orderings, proving the claim takes the DECISION row's lock before reading status and cycle rather than relying on the `Project` lock, which serializes archival only (review round 12: claim-first → the push stands against a then-open decision; approve-first → the delivery is recorded CANCELLED and nothing is sent); and the MIXED-VERSION arms, split by the two REACHABLE GATE STATES rather than by consumer class (review round 10) — **gate OFF with old-shaped consumers present**: the consultation write surface refuses, NO `decision.consultation_*` event is emitted, so no old projection worker, push worker or API reader can ever claim or serve one, and every other project's behaviour is byte-identical to today; **gate ON with upgraded-only consumers**: the full flow — the fold carries the thread, the push families honour every claim predicate, the consultee's read is correct on every instance. The two states are EXHAUSTIVE, and the deliberately UNASSERTED combination is gate-on-beside-an-old-worker: the outbox has ONE ordered delivery per consumer, so an old worker there WOULD claim it and perform the stale fold or unguarded send — that is the hazard the deploy-then-enable RUNBOOK order forbids, not a behaviour any code in this unit can prevent, and a probe asserting otherwise would be unsatisfiable | the per-family predicate registration (decider-only today) + the pre-send guard + the ordered-consumer rollout seam + the capability-gated write surface |
| P41 | eligibility is checked UNDER the decision row lock on BOTH write paths, ACQUIRED IN THE CANONICAL ORDER (readiness → `Project` → `Membership` → `Decision`, §A) with a consultee-IS-decider arm proving BOTH that no deadlock abort occurs against `decisions.approve` in either ordering AND the TERMINAL state of each (review round 22: a no-deadlock assertion alone passes for a lock-AFTER-read implementation that reads `pending`, lets the approval commit, and then appends the consultation and its `consultation_requested` effect against the now-approved decision — so the arm pins the outcomes: request-first leaves the historical consultation standing, approve-first returns 409 with NO consultation row and NO effect) — approval takes `Membership` before `Decision`, so any 4c path locking them the other way round would force PostgreSQL to abort one side (review round 13) — barrier-controlled in both orderings each: request-vs-withdraw (request-first → withdraw sees the widening it must revoke nothing for; withdraw-first → request 409); response-vs-withdraw (response-first → the advice and its push stand against a then-eligible decision; withdraw-first → respond 409, NO response row and NO `consultation_responded` effect exists — the final-state invariant asserted directly); archive-vs-response (respond-first → the advice stands against a then-operable project; archive-first → respond 409 with no row and no effect — the in-tx `isProjectOperable` lock-and-check serializing the two); AND archive-vs-REQUEST (request-first → the consultation and its push stand; archive-first → request 409, NO consultation row and NO `consultation_requested` effect exists — review round 3: §A binds BOTH write commands to the in-tx operability lock, and without this arm an implementation could lock the response path only, letting a request that passed the outer access check append into a concurrently-archived project while every listed ordering passed) | the consultation command's AND the response command's lock acquisition |

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
- **4c implementation follows as SIX PRs — the prerequisite reset sweep 4c-0,
  then 4c-i, 4c-ii, the enablement transition 4c-iii, the gate-read removal
  4c-iv, and the trailing seal retirement 4c-v (review round 25) — each
  honouring the mandatory migration seam** (review round 1: the additive schema is deployable before
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
    commit whose command's `resultRef` names another row, or a receipt whose
    `actorId` is not the row's recorded actor, refused by the
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
    and the UI affordances — **which consult the capability exactly as the
    write surface and the emitter do** (review round 26). The gate was
    specified on the commands and the emitter only, which left the upgraded
    bundle free to RENDER request/respond controls during the whole window in
    which every project is still gate-off — between 4c-ii and 4c-iii, and for
    as long as the drain directive is outstanding. Controls whose every request
    returns a deterministic 404 are not a byte-identical gate-off state; they
    are a visibly broken one, and the §D inertness claim would have been false
    for the client even while true for the server. So the client reads the same
    per-project capability the server does (the delivered `capabilities:
    string[]` shell contract that gates the `materials` and `labour` screens),
    and that client read is REMOVED IN 4c-iv together with the server-side
    ones — the gate retires in one place, not two. The gate-OFF arm of P23
    accordingly asserts the RENDERED state as well as the refused request: no
    request affordance on the decision, and no respond affordance in the
    consultee's view — with the remaining probes, red-anchored per §C
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
    still ran, exactly what the gate exists to prevent. 4c-i therefore ABORTS,
    diagnostic-first, if ANY `capability = 'consultation'` row exists: the unit
    is dark, so nothing legitimate can have created one, and the abort is
    precise about which project holds it.

    **The reservation trigger is installed BEFORE that audit reads, in the same
    transaction** (review round 24) — the same ordering rule, for the same
    reason, that round 21 established for 4c-iii's trigger-before-backfill.
    "Diagnostic-first" orders the abort before the SCHEMA CHANGE, and that is
    not sufficient here: an audit that reads first can observe no
    `consultation` row, a concurrent generic `capability:enable` INSERT (or a
    key UPDATE into `consultation`) can commit against the previous release,
    and only THEN does `CREATE TRIGGER` take its lock. The trigger is not
    retroactive, so 4c-i would commit having passed its own diagnostic with the
    gate already enabled — the precise state the audit exists to refuse.
    Creating the trigger first takes `ACCESS EXCLUSIVE` on `ProjectCapability`
    inside the transaction, so any concurrent writer blocks until commit and
    the audit then reads a snapshot no other session can extend; a writer that
    was already in flight either committed before the lock (and the audit sees
    its row, and aborts) or resumes after commit (and the reservation rejects
    it). Ordering it this way needs no new mechanism and no table-level `LOCK`
    statement, since `CREATE TRIGGER` takes that lock itself. The probe is a
    barrier-controlled interleaving with a TERMINAL assertion in both
    orderings: the concurrent enable either lands before the migration (4c-i
    ABORTS, naming the project) or is REJECTED by the reservation — and 4c-i
    never commits with a `consultation` row present.

    **And that is ALL 4c-i does to the capability vocabulary — BOARD DECISION,
    not re-litigable** (2026-08-29, on PR #480). Review round 13 required a
    CHECK restricting `capability` to a known set and round 14 required
    `commercial` added to it; round 16 then rejected that same CHECK on two
    counts at once — that it does not actually prevent pre-enablement (true: an
    operator can still enable `consultation` between 4c-i and 4c-ii, which is
    what the RUNBOOK order and §D's staging govern), and that restricting an
    existing free-text column breaks the previous release's generic
    `capability:enable` writer during the dark window. Both cannot be satisfied
    by one constraint, and the Board resolved it: **no CHECK on
    `ProjectCapability.capability`.** The pre-existing-row abort stays, because
    it is effective for THIS unit and breaks no writer. Any future narrowing of
    that vocabulary is its own compatibility-staged unit with its own writer
    change — not a rider on a dark migration.

    **The reservation covers the WHOLE dark window, not just migration time**
    (review round 19): the abort runs ONCE, during 4c-i, while the previous
    release's `capability:enable` keeps accepting any name for as long as the
    window is open — so a `consultation` row inserted BETWEEN 4c-i and 4c-ii
    would leave the first upgraded instance seeing the gate already OPEN while
    old workers could still serve, making the gate-off arm non-exhaustive. 4c-i
    therefore also installs a narrow RESERVATION trigger on `ProjectCapability`
    rejecting BOTH an INSERT and an UPDATE transitioning into
    `capability = 'consultation'` for the duration of the window (review round
    21: `capability` is a mutable key with no freeze trigger, so an INSERT-only
    guard leaves `UPDATE "ProjectCapability" SET "capability" = 'consultation'`
    on an existing row wide open — the same gate-open state by another route;
    the alternate-writer probe covers the UPDATE arm explicitly) — and it stays armed THROUGH 4c-ii, giving way only at 4c-iii,
    ATOMICALLY with the controlled enablement (review round 20, correcting
    round 19's own placement), where it is REPLACED rather than simply removed
    (review round 24 — see 4c-iii below: the reservation that forbids the row
    becomes a PRESERVATION seal that forbids removing it, and that seal
    outlives 4c-iv's rollout, retiring only in the trailing 4c-v). Dropping it during 4c-ii would reopen the hole
    mid-transition: 4c-ii DRAINS the old fleet first (§A's cutover sequence — the
    external-effect reseal requires zero old instances), but the drain is an
    OPERATIONAL step, and the standalone previous-release `capability:enable`
    CLI is a separate process that runs no bootstrap at all, so neither the
    consumer fence nor the drain can see it. An operator with the old CLI still
    on their machine could enable during or after the cutover and before the
    controlled enablement (review round 22: 4c-ii is NOT rolling — every
    earlier statement to the contrary is struck; what survives is that the
    reservation must outlast the cutover, because the hole it closes is a
    human-operable one the deployment sequence never touches). It could therefore insert `consultation` in that
    window, an upgraded API could emit, and an old worker could claim the sole
    delivery. The reservation and the enablement are two halves of one
    transition and must move together, after the drain, in the one unit that
    owns both. This does not
    reopen the Board decision above: there is still no CHECK constraining the
    column's vocabulary, every SHIPPED capability still enables through the
    unchanged generic writer, and the only rejected value is the one no
    legitimate caller can yet have reason to write. The abort and the
    reservation are one guarantee over one window — the first for rows that
    already exist, the second for rows attempted while it is open. And
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
    failed.

    **But the ordering is not the only protection, because a DURABLE
    CONSUMER-VERSION FENCE already exists and 4c-ii arms it** (review round 17,
    which correctly observed that a one-time drain assertion does not survive a
    rollback, a restart, or an autoscaling event putting a previous-release
    worker back into service AFTER the gate is open). `syncConsumerCatalog`
    asserts the compiled contract against the persisted row for every consumer
    at startup and THROWS on any difference in kind, effect, or
    `catalogVersion` — "the catalog is never silently reinterpreted"
    (`apps/api/src/platform/outbox/registry.ts`). 4c-ii therefore BUMPS
    `catalogVersion` on the consultation-consuming consumers (the
    `decisions.inbox` projection and the push consumer) as part of its own
    change. From that moment a previous-release process cannot take up service
    at all: its compiled version no longer matches the persisted one, sync
    throws, and it never reaches the claim path — so a rolled-back or
    newly-scheduled old worker is fenced out on EVERY start, not merely at the
    one moment an operator looked. This is why the gate-on/old-worker
    combination stays unasserted as a PROBE while ceasing to be a live hazard:
    the fence makes that worker unable to run, rather than able to run and
    trusted not to claim. The probe that IS added asserts the fence itself — a
    process compiled with the previous `catalogVersion` fails startup against a
    4c-ii-migrated database, with the drift error naming the consumer.

    **Arming it takes an explicit CATALOG-DATA MIGRATION, and 4c-ii carries
    one** (review round 18, correcting round 17's own fix): `syncConsumerCatalog`
    CREATES a missing row and ASSERTS an existing one — it never UPDATES, and
    says so outright ("a changed contract requires an explicit migration, never
    a silent overwrite"). So bumping only the COMPILED `catalogVersion`, in a
    unit described as behaviour-only, would leave the persisted row at the old
    version and abort every UPGRADED process at bootstrap — the fence pointed
    the wrong way. 4c-ii therefore ships one narrow catalog-data migration that
    UPDATEs the persisted `catalogVersion` for exactly the two consultation-
    consuming consumers, and it is INSEPARABLE from the code by construction:
    a consumer's compiled contract and its persisted version must land in the
    same deployment or one of them is wrong. The ordering is what makes it
    safe: `migrate.sh` applies the row update before the new processes start,
    so an already-running previous-release worker keeps serving (it re-syncs
    only at startup) while emission is still gated OFF, and it can never come
    back after a restart. By the time the operator opens the gate, only
    upgraded processes can be running — which is the property round 17 claimed
    and this migration is what actually delivers. **The alternative an earlier draft allowed — "or an
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
    reloads. The push is NOT a guarantee and this plan does not claim it as one
    (review round 16, correcting round 15's own wording): `subscribeToPush`
    no-ops without service-worker support, without granted notification
    permission, or without server VAPID, and its catch comment says outright
    that "push is best-effort — the app works without it"
    (`apps/web/src/data/push.ts`). Where a subscription DOES exist the push
    carries the consultee, and following it loads the document afresh onto the
    current bundle; where one does not, nothing reaches that tab until it
    reloads on its own.

    What BOUNDS that residual is what a consultation is: it INFORMS and never
    GATES. §A's first invariant is that a consultation moves no status and no
    gate verdict (P24), so an unseen request cannot block a decision, strand an
    approval, or lose a fact — the thread is durable, and it appears complete
    the moment that tab reloads for any reason. The failure mode is a PMC
    waiting on an answer that has not been seen yet, which is why 4c-ii shows
    the REQUESTER their outstanding requests with their age, so an unanswered
    consultation is visible to the person who can follow it up by other means
    rather than silently pending. That is the recipient-safe property actually
    available here: not a delivery guarantee, but a state in which nothing is
    lost and the gap is visible to someone who can act on it. 4c-ii also ships
    the bundle-version signal the NEW bundle honours, so this is the LAST
    release in which an open tab can be stale about consultation at all; that
    signal cannot help clients predating it, which is why the sender-side
    refusal exists. **BOARD DECISION, not re-litigable** (2026-08-29, on PR
    #480): this disclosed bound is the accepted answer. Consultation is NOT
    deferred until the pre-4c bundle leaves support — that would be a
    scheduling and scope change rather than a fix to this unit — and the sender
    is not gated on the recipient's client version, which would make anyone who
    has not opened the app since the upgrade permanently un-consultable. **And the gate RETIRES — it is a rollout
    latch, not a permanent pilot** (review round 11): `materials` and `labour`
    are genuine per-project product pilots, but consultation is a CORE
    decision workflow, so leaving it opt-in would strand every project created
    after the enable step with request/respond routes that 404 forever, with
    no path out. The retirement is the two named units §D stages, and they are
    named here in the same terms so the two sections cannot drift: (1) deploy
    4c-ii gated, then complete the drain-first cutover the RUNBOOK specifies,
    which the `blocking_directive` attests; (2) **4c-iii, the ENABLEMENT
    TRANSITION** — ONE transaction that drops the reservation trigger, installs
    the `AFTER INSERT` trigger on `Project`, and THEN backfills the capability
    row for every existing project, in that order; (3) **4c-iv**, which removes
    the gate reads from the write surface and the emitter, and nothing else.
    **There is NO operator backfill step** (review round 23, correcting a
    narrative this section carried from before the round-18/20/21 restaging):
    an earlier draft here told an operator to backfill the capability row
    between 4c-ii and the final unit, and then combined creation enablement,
    a second backfill and the gate-read removal into that final unit. Both
    halves are now wrong, and not merely stale wording. The first would FAIL:
    the 4c-i reservation stays armed through 4c-ii and drops only inside
    4c-iii's transaction, so an operator insert of the `consultation`
    capability is rejected — and bypassing the reservation to force it through
    would perform the data transition outside the reviewed migration, which is
    the one thing the dark-migration staging exists to prevent. The second
    would restore exactly the migration/service coupling the 4c-iii/4c-iv
    split was made to remove.

    What survives from the earlier rounds is the REASONING, re-pointed at the
    delivered mechanism. Round 12 established that automatic enablement cannot
    ride an operator moment, because deployed code cannot start behaving
    differently because an operator acted; a create path that enabled from its
    own deploy time would make a project created while old workers and readers
    were still draining immediately gate-on, its consultation event claimable
    by the old projection worker or sendable by the old unguarded push path.
    That objection is answered STRUCTURALLY rather than by scheduling: 4c-iii
    enables at the DATABASE, through a trigger every create path produces —
    the previous release's and the new one's alike — so there is no build to
    upgrade before coverage is complete, and correspondingly **no window in
    which a created project carries no row**. The earlier draft's disclosed
    cost, a project created between the operator backfill and the final
    deployment whose routes 404 until that deployment lands, does not exist
    under this staging and is withdrawn rather than restated. The probes are
    4c-iii's barrier-controlled concurrent create (the project has its row,
    whichever side won) and 4c-iv's: a project created after that deployment
    reaches the consultation routes with no further operator action.
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
  - **4c-iii, the ENABLEMENT TRANSITION, and 4c-iv, the gate-read REMOVAL**
    (review round 18: an earlier draft put the all-project data backfill,
    `projects.create`, and the gate-read removal in ONE unit, which is the same
    migration/service coupling this plan's own seam rule forbids — and the seam
    is viable, since after the fleet has drained the transition can land while
    the existing gate is still authoritative, and the removal follows. So they
    split, and neither claims an inseparable unit).

    **4c-iii — the ENABLEMENT TRANSITION**, landing after the drain is
    confirmed, performing in ONE transaction the three things that must not be
    separable (review round 20): it REPLACES the reservation trigger with a
    PRESERVATION seal (review round 24), installs an
    `AFTER INSERT` trigger on `Project` that creates the row for every project
    created from then on, and THEN backfills the capability row for every
    existing project — **in that order** (review round 21).

    **Replaced, not merely dropped, because the row's ABSENCE is as dangerous
    as its premature presence** (review round 24). 4c-iii establishes rows at
    creation time and by backfill, but between 4c-iii and 4c-iv the gate reads
    are still authoritative and the free-text `capability` column is still
    mutable by the generic writer — so once the reservation is gone, nothing
    stops an alternate writer DELETING a `consultation` row or UPDATING its key
    away from `consultation`. During the 4c-iv rollout that reproduces exactly
    the split brain this staging exists to prevent, from the other direction: a
    4c-iv instance, which no longer reads the gate, accepts a consultation
    write for that project while a still-serving 4c-ii/4c-iii instance refuses
    the same project because its gate read finds no row. So 4c-iii installs, in
    the same transaction that removes the reservation, a seal rejecting EVERY way
    PostgreSQL offers to remove that row: a row-level `DELETE`, a row-level
    `UPDATE` moving an existing row's key OFF `consultation`, and a
    STATEMENT-level `BEFORE TRUNCATE` on `ProjectCapability`. It is not a
    vocabulary whitelist (the Board pin stands: no CHECK on `capability`, and
    every other capability value is untouched).

    **The third arm is stated by ENUMERATION over the mechanism, not because
    review found it** (review round 26, which found it — and that is the point).
    Row triggers do not fire for `TRUNCATE`; this plan already relies on that
    fact TWICE, giving both consultation evidence tables named statement-level
    no-truncate seals for exactly this reason, so specifying a row-only seal
    here was my own inconsistency rather than a subtlety. The completeness rule
    is therefore written down once: a seal that must keep a row PRESENT is
    complete only when it covers row `DELETE`, row `UPDATE` of the sealed key,
    and statement `TRUNCATE` — and any future seal in this plan asserting
    presence is read against that list rather than against what a reviewer
    happened to try. **The seal outlives 4c-iv and retires in 4c-v** (review round 25):
    while ANY reader can still consult the row, the row must exist, and 4c-iv
    is itself a rolling deployment, so its own instances are the last readers.
    The probe is the alternate-writer path in ALL THREE arms — a direct
    `DELETE`, a direct key `UPDATE` off `consultation`, and a `TRUNCATE
    "ProjectCapability"` are each REFUSED between 4c-iii and 4c-v, and all
    three are permitted once 4c-v has retired the seal.

    Backfilling first
    leaves a hole: a concurrent `Project` INSERT can commit after the backfill's
    statement snapshot but before `CREATE TRIGGER` takes its table lock, so that
    project appears in neither — absent from the backfill, never seen by the
    trigger — and its routes stay gate-off until 4c-iv despite the
    every-project claim. Creating the trigger FIRST takes `ACCESS EXCLUSIVE` on
    `Project` inside the transaction, so concurrent inserts block until commit
    and every row is covered by one mechanism or the other; the backfill is
    `ON CONFLICT DO NOTHING` for the overlap. A barrier-controlled probe drives
    a concurrent create against the transition and asserts the terminal state:
    the project has its row, whichever side won. That last piece is what makes the transition safe
    against ANY release still in service after the cutover: `projects.create`
    cannot be changed retroactively in a build already deployed, but a DB-level default is produced by EVERY
    create path — the previous release's and the new one's alike — so no
    project can be created without a row while any release is in service. The
    gate READS stay in place and authoritative throughout; behaviour does not
    change, which is why this unit is separately revertible.

    **4c-iv — the gate-read REMOVAL**, and nothing else: the capability-gate
    reads come out of the write surface and the emitter. **It carries NO
    migration at all** (review round 25, correcting round 24, which put the
    preservation seal's drop in this unit). That was wrong for the reason the
    seal exists: 4c-iv is itself a ROLLING deployment, so while it rolls, its
    own predecessor instances are still gate readers. A migration that dropped
    the seal at the start of that rollout would reopen precisely the window the
    seal closes — an alternate writer deletes or re-keys a `consultation` row,
    the already-upgraded instances accept consultation writes for that project,
    and the not-yet-upgraded ones refuse them. "Removing the last reader" is
    not an event this unit's migration can be ordered against, because the
    migration runs BEFORE the readers are gone. So 4c-iv becomes a pure
    service-change unit, which the seam rule prefers anyway.

    **4c-v — the SEAL RETIREMENT**, a migration-only unit that drops the
    preservation trigger, landing after the 4c-iv rollout is confirmed complete
    — attested exactly as 4c-ii's cutover is, through the delivered
    `blocking_directive` (no new mechanism, and no automated drain actor: the
    Board pin holds). **It DOES gate the handoff to 4d** (review round 26,
    correcting round 25, which asserted the opposite). That correction is not a
    change of preference — round 25's preference was not EXPRESSIBLE in the
    delivered control plane, and I should have checked before claiming it.
    `assessRunnerState` resolves any non-`none` `blocking_directive` from
    `in_progress`/`correction_required` as `directive:<name>` ahead of every
    other work source ("a validated defect outranks every other work source"),
    and it explicitly REFUSES a directive set from any other state as one that
    "blocks progression without scheduling any work". So the two options the
    mechanism actually offers are: set the directive, and 4d waits; or do not
    set it, and nothing ever schedules 4c-v. There is no third state, and
    inventing a parallel non-blocking work source to obtain one would be a new
    control-plane mechanism for a hygiene task — a worse trade than the wait.
    **4c-v is therefore the last gate of 4c**, and the §E handoff to 4d follows
    its merge. The cost is stated plainly: 4d waits on one operator attestation
    that the 4c-iv rollout completed, which is the same attestation shape 4c-ii
    already requires. The probe is the
    mirror of 4c-iii's: the alternate-writer DELETE and key-UPDATE, refused
    before 4c-v and permitted after. It is safe precisely
    because 4c-iii already guarantees the row exists for every project, past
    and future, whichever release created it. An earlier draft combined
    creation-time enablement with the read removal in one unit (review round
    20): after its backfill, a still-serving previous-release instance could
    create a project with no row, and then a new instance would accept
    consultation writes for it while an old instance still returned the
    gate-off refusal for the same project — a split brain the backfill could
    not repair, because it cannot cover rows created after it ran.

    Both units are MANDATORY and hold executable review-unit slots rather than
    a prose promise (review round 13): without them the runner would advance to
    4d after 4c-ii, leaving projects without a capability row and their
    consultation routes 404 with nothing scheduled to close the window.
    **Neither removes the CLIENT-CONTRACT refusal** (review round 14): the two mechanisms answer to
    different clocks, and an earlier draft retired them together. The
    capability gate is a ROLLOUT latch, discharged once the SERVER fleet has
    drained — which 4c-iii is the transition that follows it. Contract
    negotiation answers to CLIENT versions, and browser tabs cannot be drained
    at all (`RecordedCompatInterceptor` says so in as many words): dropping the
    refusal at 4c-iv would let a stale tab advertising only the old contract
    originate a consultation again, for a consultee whose own stale tab hides
    the decision and the respond affordance — reopening precisely the hole
    round 13 closed. The refusal therefore lives on the same clock as
    `recorded-v1` itself, retired only when the old browser contract is no
    longer supported, which is its own unit and not 4c's. Its probes: a project
    created after this deployment reaches the consultation routes with no
    operator action; an existing project is unaffected; no capability row is
    required anywhere once the gate reads are gone; AND an old-contract client
    is STILL refused after retirement. **4c is not
    complete until 4c-v merges** (review round 26, extending this boundary from
    4c-iv: the trailing seal retirement gates 4d because the delivered control
    plane offers no non-blocking way to schedule it — see 4c-v's own entry),
    and the §E handoff to 4d is gated on it — the runner may not treat 4c-ii's,
    4c-iii's or 4c-iv's merge as the end of the unit. **The
    prerequisite is FAIL-CLOSED through the delivered control plane, not an
    awaited human** (review round 15): 4c-ii's own STATUS fold SETS
    `blocking_directive` naming the rollout prerequisite — **the DRAIN
    CONFIRMATION ONLY** (review round 20, correcting an earlier draft that also
    demanded "the all-project backfill executed"): once 4c-iii IS the backfill,
    requiring the backfill before 4c-iii may start is circular — the loop would
    either wait forever or an operator would have to mutate production outside
    the reviewed unit, which is exactly what putting the backfill in a reviewed
    unit was meant to prevent. The directive therefore attests one fact a human
    can attest and code cannot observe: the previous release has drained.
    Everything mechanical belongs to 4c-iii — with
    `task_state: correction_required`.
    `assessRunnerState` then resolves to `directive:<name>` rather than
    advancing — it cannot start 4c-iii or 4c-iv, nor hand off to 4d, while the directive
    stands, and it flags the incoherent shape if a directive is set beside a
    non-directive state (`scripts/autonomous-status-state.mjs`). Clearing the
    directive is a STATUS commit, so the prerequisite has a machine-observed
    state AND an attributable, reviewable record of who declared the fleet
    drained — the same shape every other blocking directive in this loop uses.
    Without it the runner would either strand silently or advance past the
    rollout ordering; with it, stranding is impossible and skipping is
    impossible. **BOARD DECISION, not re-litigable** (2026-08-29, on PR #480):
    this stays as an operator-declared directive and NO automated drain or
    backfill actor is invented for it. Review round 9 already established that
    no code in this repository can observe "every serving process has
    drained" — `OutboxConsumerCatalog` cannot enumerate processes or releases —
    and round 16's call to automate it asks for the very signal round 9
    correctly rejected as unimplementable.
- 4d (architect, forwarding, countersign) is NOT this unit: its plan unit
  follows 4c implementation — ALL SIX PRs, 4c-0 through 4c-v — per the merged
  §E order, carrying §D obligations 4–6 (review round 26: 4c-v gates this
  handoff, for the control-plane reason given in its own staging entry).

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
