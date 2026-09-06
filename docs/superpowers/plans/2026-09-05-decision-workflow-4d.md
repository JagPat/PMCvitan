# Decision workflow, unit 4d — the architect, forwarding and countersign: the plan

**Status: PLANNING — this is the docs-only 4d plan unit the merged 4b plan's
§E order requires** (`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`
§E: "the 4d plan unit (STARTING MATERIAL: the §C orchestration design at
`6a53aae` + §D obligations 4–6) → 4d implementation"), reached exactly when
the 4c plan said it would be (`2026-08-29-decision-workflow-4c.md` §D: "4d …
its plan unit follows 4c implementation — ALL SIX PRs, 4c-0 through 4c-v";
4c-v merged as PR #535 at `main` `f5da6654`, the handoff recorded by #536 at
`d7eed4ce`). It must clear its own exact-head review to a fresh clean +1
before 4d implementation begins — the same plan-first contract that preceded
4a, 4b and 4c, all three now DELIVERED AND CLEARED (4a: PR #337; 4b: PR #468
at `fe9df58d`; 4c: the six units #489 → #498 → #506 → #528 → #533 → #535, with
the 4c plan itself cleared at #490's gate).

**Review lineage.** This document is the REPLACEMENT of PR #543 (`Replaces: #543` —
labelled by the orchestrator before it closed, so the ledger holds its
obligation; every predecessor closed at the limit stays a labelled pending
obligation until a MERGED unit names it, one merge discharging one — the
accepted gap of `docs/reviews/replacement-lineage-repair.md`; #541 alone
holds no label, having closed before it could be labelled — the #514/#513
lesson in STATUS), itself the replacement of #542, #541, #540, #539, #538 and
#537 in turn — the same docs-only unit and nothing else, seven times rebuilt
from the same `main`. Round 1 on #537's first head
(`d82d47f4`: eight Codex findings — three P1 on the dark-deploy boundary, two P1
on evidence integrity, one P1 on the stranded return path, two P2 on the push
send boundary and the status readers) was folded on its second head
(`77ab82b1`); round 2 on that head (six findings — three P1: the changed
consumers' durable contract versions, the preflight's ordering against a
concurrent writer, a repair that soft-removal could not perform; three P2: the
rejection origin in the DTO and the withdraw affordance, two more
non-exhaustive status readers, the send boundary for the two new push
families) exhausted #537's review round, so it closed without a third head and
this replacement carries all fourteen fixes, each annotated "(this plan's
review round 1)" or "(review round 2)" where it lands. Round 3 — the
replacement's own first head (`cae3d167`), seven P1 findings: the existing
targeted-push ceilings, `ChangeRequest`'s missing project key, the response
push for an architect requester, the decision-authority primitive that must
not widen, the unfrozen provenance field, the role-holder actor arm, and the
NULL-provenance cutoff for standard requests — was folded on its second head
(`cbbe9d23`), annotated "(review round 3)". Round 4 — that second head, five P1
findings: the forward push surviving a withdrawal, the standard change receipt
naming the decision rather than the request it creates, a role-targeted push
sent to a member who lost standing between claim and send, forwarding left
OPEN while previous-release consumers still ran, and the entry into
`awaiting_countersign` sealed from the revision side only — exhausted #538's
review round in turn, so it closed without a third head and this second
replacement carries all twenty-six fixes, the five annotated "(review round
4)". Round 5 — this replacement's own first head (`91416864`), five P1
findings: the Team role pickers offering a role the reservation refuses (and
the orphaned `User` that refusal leaves), a staging sentence that still
ordered the audit before the reservation, the pre-send standing re-check
limited to role fan-outs, 4d-i in `ALWAYS_EXECUTE` replaying its audit
against a legitimate architect on a post-retirement baseline, and the 4d-ii
catalog-data migration missing from the baseline path — was folded on its
second head (`0526eb8d`), annotated "(review round 5)". Round 6 — that second
head, four P1 findings: a per-recipient skip that set the WHOLE delivery's
cancellation mark, a countersign demand cancelled for good when the last
architect left with nothing re-notifying the next one, a uniform membership
re-check that dropped a membership-less org-admin requester, and no web probe
of the architect's own action controls — exhausted #539's review round in
turn, so it closed without a third head and this third replacement carries
all thirty-five fixes, the four annotated "(review round 6)". Round 7 — this
third replacement's own first head (`fcc6d15b`), seven P1 findings: the
retirement marker colliding with the 4c-iii-r closed trigger inventory, the
re-notification firing on every architect activation rather than a genuine
chain reactivation, project archival absent from the pre-send hook, the
Inbox action selector with no architect branch, the sole-architect-and-holder
removal that the widened orphan guard refused, the green approval
notification written before finality, and the shared reservation function
left outside the transient replay block — was folded on its second head
(`04b5491c`), annotated "(review round 7)". Round 8 — that second head, five
P1 findings: the retirement marker insert not idempotent under
`ALWAYS_EXECUTE`, the stale-send residual mis-described as carrying no
decision content, the client's approval confirmation copy still promising a
lock under an active chain, the final approval notification attributed to
the finalizer rather than the approver, and the new `ChangeRequest`
no-TRUNCATE seal missing from the reset registry — exhausted #540's review
round in turn, so it closed without a third head and this fourth replacement
carries all forty-seven fixes, the five annotated "(review round 8)". Round 9 — the fourth replacement's own first
head (`a05fdd80`), three P1 findings: the withdrawal cancelling only the
decider and forward families while a claimed `consultation_responded` push
to an architect requester could still send the title; the drain covering
server processes while a pre-4d browser tab could approve into a status its
bundle cannot render; and the finalizer resolving the approver's CURRENT
name where the revision froze no name — is folded on its second head,
annotated "(review round 9)". Round 10 — that second head (`6ec40f12`), four
P1 findings: the delivered `DecisionApprovalRevision_append_only` trigger
rejecting the very finality flip 4d pairs; `architect` absent from the
`DeciderKind` designation contract the 4b plan deferred to 4d; the projected
`countersignRequired` going stale when the architect standing changes with
no decision event; and the round-9 withdrawal cancellation also marking the
PMC requester's response push P38 requires delivered — exhausted #541's
review round in turn, so it closed without a third head and THIS fifth
replacement carries all fifty-four fixes, the four annotated "(review round
10)". Round 11 — the fifth replacement's (#542's) own first head (`aafc0e17`), five
findings (four P1, one P2): the two provenance writers never taught to state
`revisionFinalized` before 4d-iii drops its default; the stale-client chain
check racing the activation it guards at the transport layer; the
`deciderPush` producer routing an architect-designated decision to the
clients; the client-contract boundary fencing only the awaiting status while
the architect designation and the architect session are shapes a stale bundle
meets first; and the Portfolio `countPending` reporting zero for an
architect — was folded on its second head, annotated "(review round 11)".
Round 12 — that second head (`182a09bf`), three P1 findings: the membership,
roster and switch responses carrying the `architect` role to a stale tab
before the shell read the boundary refuses; the two CANCELLATION spec copies
omitting `revisionFinalized` where create/revise had been fixed; and an
active non-holder architect unable to see the pending decision the plan lets
them forward — exhausted #542's review round in turn, so it closed without a
third head and THIS sixth replacement carries all sixty-two fixes, the three
annotated "(review round 12)". Round 13 — the sixth replacement's (#543's) own first
head (`7bfdc3e0`), six P1 findings: the last-architect exemption stated for
the NAMED holder but not the architect ROLE designation; approval assigned
no cancellation for a claimed decider/forward push; a forward whose
designation does not change satisfying every seal; the withdrawal target
filter wrongly applied to `consultation_requested`; the architect DESIGNATION
reachable on an unpublished draft while the reservation stands; and the
`countersignRequired` freshness signal bypassed by a direct membership write
— was folded on its second head, annotated "(review round 13)". Round 14 —
that second head (`9c6dc588`), six P1 findings: the two new enum values
committing ahead of the seal transaction with no `Decision` audit under the
lock; `consultation_requested` deliveries surviving the transitions that
close the consultation-open set; the round-13 read-time overlay putting a
synchronous orgs read on every decision response; `countersignRequired`
serialized when false, breaking P29's literal byte identity; the round-6
re-notification bypassed by a direct architect activation; and P29b still
asserting the signal round 13 withdrew — exhausted #543's review round in
turn, so it closed without a third head and the seventh replacement (#544)
carried all seventy-four fixes, the six annotated "(review round 14)". Round 15 —
the seventh replacement's (#544's) own first head (`4dda84fc`), seven findings (six
P1, one P2): the registry's hard-coded `KNOWN_ROLES` mirror missing from the
role fan-out (the 4d-ii release would refuse to boot); a "both" left over from
round 13's third reservation door in the transient block and the replay
text; the round-14 fold reading chain presence through the orgs participant
(still an orgs-owned table) and the asynchronous refresh not atomic with the
membership commit; `ChangeRequest.origin` classified additive-ignorable while
a stale PMC tab renders a Withdraw the server refuses; the gateway's direct
`/auth/session` fetch omitting the contract header; and the three fact
tables never registered in the decisions manifest's ownership sets — was
folded on its second head, annotated "(review round 15)". Round 16 — that
second head (`822d4838`), three P1 findings: the `DecisionChainStanding`
mirror sealed against a wrong write but not against ERASURE (no DELETE seal,
no statement-level no-TRUNCATE seal, the table absent from
`TRUNCATE_SEALS`, so a truncated mirror reads `countersignRequired: false`
while the approve still requires the countersign); the round-14 `SET LOCAL`
service gate CALLER-CONTROLLED (a transaction-local setting any holder of the
application's database role can set is not a privilege boundary, so a direct
architect write could pass the trigger and commit with the mirror left
`false`); and the round-15 mirror seal a DECISIONS trigger synchronously
reading the orgs-owned `Membership` at every commit — exhausted #544's
review round in turn, so it closed without a third head and THIS eighth
replacement carries all eighty-four fixes, the three annotated "(review
round 16)". Round 17 — this eighth replacement's own first head (`d52af4f8`),
five findings (three P1, two P2): the mirror's cascade-delete exception naming
`Project_t4c_deleting`, a trigger 4c-v RETIRED; the round-16 orgs-owned
correspondence seal selecting the decisions-owned mirror at commit — the
forbidden cross-module table read in the other direction; the mirror's
provenance attached to the delivered `phase6_t4c_provenance_bound`, which
reads `NEW.id` on a row keyed by `projectId` alone; the architect's
consultation chooser with no roster loaded on a fresh session; and
`/me/portfolio` carrying `Membership.role` verbatim outside the client
boundary — is folded on its second head, annotated "(review round 17)": the
standing moves DOWN into the platform kernel as a trigger-maintained
register no module reads across a boundary, and the writer boundary becomes
the command ledger on the membership row itself. Round 18 — that second
head (`5efbfc06`), three findings (two P1, one P2): a legal DIRECT transition
(a `pending → approved` write while the chain is inactive, admitted by §A.2)
slipping a claimed push past a send boundary that re-judged the person and
the project but never the SUBJECT; the zero↔one architect crossing reaching
no OTHER open tab, the membership events being catalogued `invalidate:
false`; and the archived-project drop never re-emitted when
`restoreProject` clears `archivedAt` with the architect count unchanged —
exhausted #545's review round in turn, so it closed without a third head and
THIS ninth replacement carries all ninety-two fixes, the three annotated
"(review round 18)". Round 19 — this ninth replacement's own first head
(`0ae38c88`), seven findings (six P1, one P2): the round-18 subject re-judge
run once per delivery, leaving a role fan-out's second recipient a stale
send; its `consultation_responded` rule flat ("not withdrawn") where the
claim predicate is target-aware; the client boundary fencing `/auth/switch`
but not the other token-minting responses; `ChangeRequest.origin` serialized
when `standard`, breaking P29's byte identity; the probe table running P40 →
P42 with no P41 barrier for the transitions that close the consultation set;
the activation side effects bound to service code a hand-run receipt can
bypass; and a rewritable `sourceCommandId` on the membership row where
trusted evidence must be append-only — is folded on its second head,
annotated "(review round 19)": the crossing emits at the database boundary
and a decisions-owned ordered consumer drives the re-notification, the
provenance becomes an immutable per-transition fact, and the send hook
re-judges the subject per recipient with the claim predicate itself. Round
20 — that second head (`e60b540c`), five P1 findings: the crossing event
carrying no actor for the audit row its consumer must write; the enum values
committing BEFORE the `Decision` reservation, a gap an audit cannot close
against a concurrent writer (its abort rolls back the reservations, never the
writer's row); a freshly registered consumer replaying every historical
`project.restored` through the relay's backfill scanner; the transition
fact's actor never re-judged for team-management authority once hand-written
receipts are admitted; and the admitted hand-run activation never touching
the readiness key, so an approval could commit `approved` after the chain
activated — exhausted #546's review round in turn, so it closed without a
third head and THIS tenth replacement carries all one hundred and four
fixes, the five annotated "(review round 20)". Round 21 — this tenth
replacement's own first head (`64b0c239`), five P1 findings: the consumer
cutover created without an immutability or no-TRUNCATE seal; the withdraw
command's target-aware cancellation taking the decision lock BEFORE the
target memberships, inverting the canonical order against a concurrent
`consultation.respond`; the `decision.awaiting_countersign` emission left in
the service path while the seals admit a hand-run receipt + revision +
transition bundle that emits nothing; the restore re-emit rebuilding work from
open subjects instead of the deliveries archival actually consumed (a dropped
response push lost, a delivered decider push duplicated); and the crossing
event unable to name the transition fact whose actor the audit must trace —
is folded on its second head, annotated "(review round 21)": the cutover
sealed, target locks before the decision lock, every 4d-sealed transition
emitting from its seal, archival PARKING deliveries that restoration releases
unchanged, and the transition fact binding the crossing event's id. Round 22
— that second head (`ad4352dc`), seven P1 findings: the park written inside
a hook whose result the relay marks `succeeded` regardless; the archived
read and the park not one transaction under the project lock, so a
restoration between them leaves a row held forever; the cutover sealed
against rewrite but open to a later INSERT; the cutover schema staged in
4d-ii beside service work instead of in the dark migration; the
`Notification` and `DecisionEvent` rows still written by service code a
hand-run bundle skips; the fact-to-event association chosen AFTER the write
by search, swappable by a hand-run writer; and a PMC's self-transition to
`architect` failing its own fact seal on the post-state — exhausted #547's
review round in turn, so it closed without a third head and THIS eleventh
replacement carries all one hundred and sixteen fixes, the seven annotated
"(review round 22)". Round 23 — this eleventh replacement's own first head
(`29ee11af`), five P1 findings: the P40 archive arm asserting a cancellation
MARK where the parking contract holds the row pending and unmarked; the
transition fact declared column-immutable while its `standingEventId` must
move from NULL to the event the membership write emits; §A.1 and P28 still
committing the enum value ahead of the reservation that round 20 placed
before it; the fact's membership FK checked immediately though `members.add`
inserts the fact before the membership row exists; and P36 demanding a
countersign delivery for an approval that reached finality before any chain
existed — is folded on its second head, annotated "(review round 23)": the
arm parked and released on restoration, ONE explicitly sealed NULL→event-id
transition on the fact, the text-judged doors before the enum in every
statement of the order, the membership FK `DEFERRABLE INITIALLY DEFERRED`,
and ZERO countersign deliveries for an approve that won under no chain.
Round 24 — that second head (`966defdd`), eight findings (seven P1, one
P2): the last-architect cancellation of pending countersign demands left
to the service while the seals admit a hand-run deactivation, so a
hand-run removal of A followed by B's activation leaves two live demands;
a role fan-out parked as a WHOLE row after its first recipient was sent,
so restoration re-sends that recipient; the relay's legacy/shadow
recovery claim admitting a zero-attempt row by `updatedAt` alone, so a
parked row is reclaimed and re-parked every lease interval; the audit
repair for a pre-existing `architect`/`awaiting_countersign` row routed
through a service whose Prisma client cannot read that row; the
`platform_emit_event` twin defined with no actor argument, so every
seal-emitted human act would be attributed to the system; 4d-iii's
retirement list naming three of the four doors; 4d-ii's catalog change
never staged through the external-effect reseal an outbox-mode fleet
requires; and the cutover fill re-run by `ALWAYS_EXECUTE` against its own
INSERT seal — exhausted #548's review round in turn, so it closed without
a third head and THIS twelfth replacement carries all one hundred and
twenty-nine fixes, the eight annotated "(review round 24)". Round 25 —
this twelfth replacement's own first head (`a87742ae`), six P1 findings:
the forward door named on `phase6_t4b2_decision_seal`, which carries the
role arms but no holder-freeze arm, while the delivered
`decision_t4b_attribution_seal` is what freezes the decider tuple; the
owner's cap phrased as leaving an exhausted PR open, against the
repository's close-and-replace rule; the re-notification racing the
unordered `webpush.notify` worker, which can send the original countersign
demand to the new architect before the ordered consumer handles either
crossing; the seal-emitted events claiming an `actorRole` no paired fact
freezes; the reserved-value repair unable to clear an
`awaiting_countersign` row by either branch; and P31b admitting two
approval revisions over one approval transition — is folded on its second
head, annotated "(review round 25)": the door opened in the attribution
seal, the cap restated as the owner's directive to the loop with the
protocol intact, a decisions-owned countersign notice that serializes the
send and the re-emit on the decision row lock, action-time actor role and
name frozen on every 4d fact, a `--revert-provisional` repair branch under
the repair-engine discipline, and one register row per approval
transition. Round 26 — that second head (`56a27029`), six P1 findings:
the round-25 notice register absent from 4d-i's table, manifest and
no-TRUNCATE inventories; the no-chain direct approval P37 admits updating
the decision without an event, so a caught-up `decisions.inbox`
generation serves the stale DTO; the `--revert-provisional` repair
needing columns and a table the aborting 4d-i has not yet created;
`approvedByRole` required by §A but absent from the migration inventory
and the 4d-ii writer list; the standing trigger emitting a crossing event
inside the project-delete cascade, against the project being deleted;
and the cutover described as both INSERT-sealed in 4d-i and filled by
4d-ii — exhausted #549's review round in turn. The owner's cap at #549
was reached and reported on #482; the owner LIFTED IT BY ONE (JagPat,
2026-09-06, Board GO on #549: "lift the close-and-replace cap by one …
#550 is the new last replacement"), so #549 closed without a third head
and THIS thirteenth replacement carries all one hundred and forty-one
fixes, the six annotated "(review round 26)": the notice register and
the repair-evidence table in every 4d-i inventory, the no-chain approve
joining the seal-emitted set, a retry-safe repair bootstrap transaction
ahead of the audit, `approvedByRole` staged and written, no emission
under the cascade, and a migration-gated one-time fill arm on the
cutover seal. Round 27 — this thirteenth replacement's own first head
(`27ea7871`), four findings (two P1, two P2): the one-time fill arm's
`xmin = txid_current()` predicate, which PostgreSQL cannot evaluate (no
`xid = bigint` operator); the countersign notice sealed only by FKs, a
uniqueness and mutation seals, so a direct writer could name an unrelated
delivery and an arbitrary standing position and silence the one
replacement; the cascade probe asserting a hard delete of a project that
holds a committed `membership.standing_changed` event, which the
`DomainEvent.tenant` `Restrict` FK refuses regardless; and the dev-session
fallback minting `dev-architect` under `ALLOW_DEV_AUTH` without reading the
reservation — is folded on its second head, annotated "(review round
27)": the repository's `txid_current()::text::xid` cast, an INSERT-time
correspondence seal binding the notice to its own countersign delivery
and to the register's current position, the cascade arm scoped to the
event-free project with the eventful hard delete asserted REFUSED, and
the dev session refusing `architect` while the reservation stands. **The
close-and-replace protocol stands unchanged; the owner directs who takes
its next step**: should THIS PR reach a second finding-bearing head, the autonomous loop opens no replacement itself —
it reports the exhausted head and its findings on #482 and stops, and no
#551 is opened without a new Board call. No design decision carried from
`6a53aae` was reopened; every fix is a precision this plan owed and had
not stated.

## Provenance, and what is NOT re-litigated

The STARTING MATERIAL is the §C orchestration design at PR #340 head `6a53aae`
(`docs/superpowers/plans/2026-08-14-decision-workflow-4b-4d.md` there, §C +
the unit-4d probe table in its §D and the uniform seal contract in §C.3),
carried here in substance with each decision's forcing round annotated — none
reopened. The binding ledgers (`docs/reviews/pr-335-convergence.md`,
`docs/reviews/pr-340-convergence.md`) stand; the merged 4b plan's §D carries
obligations 4–6 to THIS unit as named probes (P31b/P42b, P31c/P34b, P33b),
elaborated to full rows in §B below. The owner's 2026-08-13 AMENDMENT
(forward authority = holder + PMC + architect once one exists) is settled and
carried. Nothing is dismissed and nothing settled is redesigned.

4b's and 4c's DELIVERED surfaces are settled input, and this plan is written
against what actually merged (not the pre-delivery sketch):

- **4b**: the decider model (`deciderKind` client/pmc/member/none on
  `Decision` — `'architect'` deliberately deferred to 4d WITH the role, the
  4b plan's round-1 decision §A.1 takes up here, review round 10;
  `deciderMembershipId` bound by the composite FK to
  `Membership @@unique([projectId, id])`, the holder tuple frozen from
  publication or attribution by `Decision_t4b_attribution_seal`
  (`decision_t4b_attribution_seal`; review round 25 — not
  `phase6_t4b2_decision_seal`, whose arms are the role arms) — the
  WRITE-ONCE door §A.2 loosens by exactly one opening), the orgs-owned
  holder-orphan guards `Membership_t4b2_holder_guard` /
  `OrgMembership_t4b2_holder_guard` (P39's DB arm is DELIVERED; §A.2 EXTENDS
  its predicate, it does not re-create it) and the participant answer
  `holdsOpenDecisions` the orgs member commands ask; the user-TARGETED push
  spine with the catalog-declared claim-time predicate (`pushFamily:
  'decider'`, bound at bootstrap to `decisions.deciderPushTarget`); the §B.1
  try-acquire-or-refuse protocol and the §B.2 owned SQL primitives
  (`phase6_membership_is_active`, `phase6_effective_role_standing`,
  `phase6_user_decision_authority`, `phase6_decisions_hold_role`,
  `phase6_decisions_name_membership`).
- **4c**: the two consultation tables with their full seal network —
  `DecisionConsultation_t4c_request_seal` and
  `DecisionConsultationResponse_t4c_response_seal` (both judging the
  eligibility predicate `"publishedAt" IS NOT NULL AND status IN
  ('pending','change')` at lines the 4d-i migration REPLACES, §A.2), the
  append-only and named no-TRUNCATE seals, the `openCycle` freeze (the
  approval COUNT as trusted cycle evidence); the TWO orgs-owned primitives
  4c-i registered — `phase6_membership_active_user(projectId, membershipId)`
  (locks the membership row, returns its `userId` when ACTIVE) and
  `phase6_project_operable(projectId)` (locks `Project` before reading
  `archivedAt`) — and the decisions-owned `phase6_try_readiness(projectId)`,
  which IS the §C.2 "try-acquire, never wait in a trigger" protocol the
  starting material specified, now a DELIVERED primitive every 4d seal calls
  rather than re-invents (its key is `readinessLockKey(projectId)` from
  `readiness-lock.ts`, exported precisely so a second caller takes the SAME
  lock); the §C rule-ii command PROVENANCE shape — `NOT NULL sourceCommandId`
  with a project-contained composite FK to `CommandExecution(projectId, id)`,
  a `(projectId, sourceCommandId)` one-use UNIQUE, and the DEFERRABLE
  result-binding constraint trigger `phase6_t4c_provenance_bound` (+
  `phase6_t4c_provenance_reserved`) that ties the row to the RESULT of the
  reserved command executing it — which 4c also bound onto
  `DecisionApprovalRevision` (`DecisionApprovalRevision_t4c_provenance`, the
  partial one-use `DecisionApprovalRevision_source_command_key`); the
  per-event-FAMILY claim predicates (`pushFamily: 'decider' |
  'consultation_requested' | 'consultation_responded'`, each a
  `decisions.*PushTarget` query the outbox binds at bootstrap); and the
  RETIRED rollout latch — 4c-v dropped the per-project `consultation`
  capability entirely, so 4d inherits NO capability read and adds none.
- **Three hand-offs the 4c plan recorded for THIS unit's review**, each
  taken up in §A: the `architect` joins the consultation REQUESTER set
  (`consultation.request` ceiling + a NEW orgs-owned orchestration-authority
  primitive, §A.2 — NOT a widening of `phase6_user_decision_authority`,
  review round 3) "with the role"; the consultation eligibility carve-out gains the
  `awaiting_countersign` arm "with the status itself"; and the delivered
  `deciderPushTarget` reads its decision with a plain `findFirst` — 4c's
  CLEARED surface, which 4c did not silently change and left for "4d's own
  review to weigh deliberately" (4c plan §C, P38c/P40c): §A.2 weighs it and
  changes it, because forwarding makes the holder MOVE, which is the one
  fact that read now has to be right about.

Two delivered disciplines apply to every fact below without their own
probes, because the tripwires that pin them are merged and will fail an
implementation PR that skips them: every new command rides the command
ledger with an idempotency key and joins the §A readiness-lock COMMAND-LEVEL
enumeration (`readiness-lock-coverage.test.ts`, `SECTION_A_COMMANDS`); every
new event joins the shared + sealed external-effect catalogs
(`external-effects.ts`, the sorted-tuple pin); every new table with a
statement-level no-TRUNCATE seal joins `TRUNCATE_SEALS` in
`prisma/sanctioned-reset.ts` (the 4c-0 helper) or the whole battery's setup
fails; and every migration joins the `pg-parse` corpus pin and — where it
carries raw guards OR data a `prisma db push` baseline cannot have — `ALWAYS_EXECUTE`
in `scripts/migrate.sh` (review round 5: a catalog-DATA migration is in that
class exactly as `20271116000000` is).

## §A — The design (the §C starting material, carried)

### 1. The role, honestly fanned out

`architect` joins `TokenRole` (`packages/shared/src/domain/types.ts` — today
`'pmc' | 'client' | 'engineer' | 'contractor' | 'consultant' | 'worker'`) and
its mirrors — `auth.ts`, BOTH zod role enums, `PushRole` **and the EXISTING
targeted catalog entries whose ceilings the role must enter** (review round
3): `decision.published` and `decision.consultation_requested` in
`EXTERNAL_EFFECTS` list every role a decider or consultee can hold, and their
emitters (`deciderPush`, the consultation request) persist the named member's
ACTUAL role even for a user-targeted push — which `buildDispatchIntent`
rejects when the role is outside the ceiling, aborting the whole command. So
publishing a decision held by an architect, or consulting an architect, would
fail the moment the reservation retires unless both entries admit the role.
4d-ii widens both, and a catalog tripwire enumerates every targeted entry
whose narrowing site persists a member role and asserts each admits the full
member vocabulary; P28 probes both paths end to end (a decision published to
an architect holder; a consultation requested from an architect) —, the
`decisionsManifest.permissions` AND the registry's hard-coded `KNOWN_ROLES`
mirror (`apps/api/src/platform/module-registry/registry.ts` — review round
15: `validateModuleRegistry()` rejects any manifest permission naming a role
outside that set and `ModuleRegistryService.onModuleInit()` aborts API
startup on the resulting `unknown-permission`, so a 4d-ii release that
widened the manifest without the mirror could not boot; P28's identity walk
pins it with the other mirrors), the membership-role comment in
`schema.prisma`, and every `ROLE_POLICY` entry the role belongs in
(`packages/shared/src/domain/policy.ts`; the exact policy row set is the
unit's FIRST deliverable — `project.read` and `members.read` (the roster
the consultation chooser needs; review round 17) certainly among them,
`decision.approve`/`decision.change`/`decision.withdrawChange`/
`decision.updateDraft` and `consultation.respond` where the architect can be
the HOLDER or a consultee, `consultation.request` because the architect joins
the requester set (the 4c hand-off), the four NEW 4d actions of §A.2, and
`decision.create`/`decision.publish`/`decision.withdraw` deliberately NOT —
issuing and withdrawing stay the PMC's) — with the `route-policy.test.ts`
walk ("every role-gated endpoint carries a `@RolesFor` action and its roles
ARE `ROLE_POLICY[action]`"; "every `ROLE_POLICY` action is exercised by at
least one gated route") pinning whatever it says (P28). **And the role is
a DESIGNATION, not only a token** (review round 10): the 4b plan deferred
`'architect'` in `DeciderKind` to 4d explicitly
(`2026-08-14-decision-workflow-4b.md`: "`'architect'` joins the enum IN UNIT
4d WITH the role"), and the delivered contract still admits `client | pmc |
member | none` everywhere it is judged — the Prisma `DeciderKind` enum, the
zod `DECIDER_KINDS`, the shared type, `viewerIsDecider`
(`packages/shared/src/domain/decider.ts`, false for any kind it does not
know), `deciderNoun`, the role arms of the two 4b seals (the open-holder
rule in `phase6_t4b2_decision_seal` and the holder-orphan audit both judge
`deciderKind IN ('client','pmc')` by `phase6_effective_role_standing`), the
decider picker and the audience selectors. Without the fan-out a PMC could
neither create a decision for, nor forward one to, the ARCHITECT ROLE
designation this plan names throughout: `deciderKind: 'architect'` is
refused at zod, and a stored value would grant its holders neither
visibility nor approval authority — leaving only a specifically named
architect through `member`, which is not the design. So the designation
fans out with the role: 4d-i adds the enum value in the retry-safe form the
4a/4b files used (`ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS
'architect'`, its own statement — a value added inside a transaction is
unusable until it commits — issued only AFTER the transaction that installs
the TEXT-judged reservation doors `Decision_t4d_architect_reserved` and
`Decision_t4d_awaiting_reserved` has committed: the doors judge
`NEW."deciderKind"::text` and `NEW."status"::text`, which PostgreSQL
evaluates whether or not the value exists yet, so no window opens in which
either value is representable and unreserved, and the seal transaction's
`Decision` audit under its table lock is the diagnostic for rows that
PRE-DATE 4d-i — review rounds 14 and 20, §D; review round 23 aligned this
section and P28 with that order, both having still read as enum-then-door)
and widens the role arms of both 4b seals to `('client','pmc','architect')`,
so an open decision designated to the architect role must have an effective
architect holder exactly as a `pmc` one must a PMC; 4d-ii adds the value to
the shared type, `DECIDER_KINDS`, `viewerIsDecider` (`architect` designates
the ROLE — any active architect decides, the `client`/`pmc` shape),
`deciderNoun`, the DTO, the decider picker, the audience selectors and the
labels — AND the PRODUCER that selects the push audience (review round
11): `DecisionsService.deciderPush` maps `member` to its named user, `pmc`
to the PMC role and EVERY other kind to `client`, so a widened input union
alone would compile and push "New decision awaiting your approval" for an
architect-designated decision to the CLIENTS; it gains an explicit
`architect` arm (`roles: ['architect']`, the role fan-out the delivered
`decision.published` ceiling admits from round 3), the delivered
`deciderPushTarget` claim predicate gains the same arm (an
architect-designated decision is actionable while an active architect
holds the role — `phase6_effective_role_standing ≥ 1`, the `pmc`/`client`
shape), and P28's role-held arm asserts the publication's RECIPIENTS —
every active architect's links and no client link (RED at base: the
fallthrough targets `client`); and the forward door's role-`toDesignation`
arm (`phase6_effective_role_standing ≥ 1`, §A.2) admits it unchanged. Dark until
4d-iii like everything else: while the reservation stands no membership can
hold the role, so `phase6_effective_role_standing(project, 'architect') =
0` and a PUBLISHED decision designated to it is refused by the same
open-holder rule that refuses a `pmc` decision in a project with no PMC —
but that rule judges publication only (review round 13): the delivered
`DecisionsService.create` births an unpublished DRAFT carrying its
`deciderKind` before any standing check, and the 4b seal's role arms fire at
the publication boundary, so a `countersign-v1` client could store an
architect-designated draft while a pre-4d process still serves — and that
process reads the project's rows through its old Prisma enum BEFORE the
author-visibility filter, failing on the unknown value. The reservation
therefore has a THIRD door: 4d-i installs `Decision_t4d_architect_reserved`,
a BEFORE INSERT OR UPDATE trigger refusing ANY `Decision` row whose
`deciderKind` is `architect` — draft or published — through the SAME
refusal function as the two other doors, dropped by the SAME 4d-iii
statement; `decisions.create`/`updateDraft` refuse the value 409 naming the
drain directive while it stands (the picker is already gated on the
shell's `rollout.phase6_4d` read). P29c probes the unpublished-draft path:
while reserved, a service create naming the role is 409 and a hostile direct
draft insert is refused, so no row anywhere carries the value; after 4d-iii
both succeed, and the published one is then judged by the open-holder rule. P28 gains the role-held arms, RED at base
(zod refuses the value; `viewerIsDecider` returns false): a PMC creates a
decision with `deciderKind: 'architect'` and forwards a pending one to the
architect role designation; every active architect sees each in the
Decision Log and one of them approves (an architect-designated approval
under an active chain still lands `awaiting_countersign` — the chain judges
it like any other, P32's two-key self-countersign rule applying); a removed
architect sees neither; and the P39 role-designation arm refuses removing
the LAST architect while a `pending`/`change` decision names the role
(exactly the `client`/`pmc` rule — the round-7 exemption is for the chain,
and extends to an `awaiting_countersign` decision designated to the role as
it does to one naming the architect by membership: the removal deactivates
the chain and the departed-holder `returned` bundle re-homes it). **The
fan-out includes the PRODUCT PATH that mints memberships** (`6a53aae` round 2): the
Team screen's role picker and role labels (`TeamScreen.tsx` `ROLES` /
`ROLE_LABEL`, `RolePicker.tsx` `ROLES`, and every web role list the mirrors
walk reaches) gain `architect`, or a PMC could deploy the role with no UI path
to add an active architect — the countersign chain then activates only
through direct API calls, which is not a shipped feature. **And the pickers
OFFER the role only once the reservation has retired** (review round 5): 4d-ii
ships the option while 4d-i's reservation still refuses every membership
INSERT or UPDATE carrying it, so an offered-and-refused role would surface as
a database-trigger failure — and worse than a harmless refusal, because the
delivered `MembersService.add` provisions the invited `User` BEFORE entering
the membership transaction (`members.service.ts`), so a trigger refusal at the
membership INSERT would leave an orphaned identity behind. Two guards, the
same shape as the Forward affordance (§D): the web role pickers gate
`architect` on the shell-level `rollout.phase6_4d: 'reserved' | 'open'` read
(ONE read serving both the role option and the Forward affordance, baked from
the reservation trigger's presence in `pg_trigger`), so no client offers what
the server refuses; and `MembersService.add` and the role-update command
REFUSE `architect` with a 409 naming `phase-6-4d-previous-release-drained`
BEFORE ANY WRITE — before the `User` provisioning — while the reservation
stands, the DB trigger remaining the seal against every other writer.
Probed (P28b's service arm): adding an architect by a NEW email while
reserved → 409 and ZERO `User` rows created; after 4d-iii the same call
creates the member. The pre-existing provision-before-transaction ordering
is an orphan hazard for ANY membership failure and is named here, not
widened into 4d. P28's identity walk
covers the web lists beside the backend mirrors. The role is a project
MEMBERSHIP role like the other five; `worker` stays deliberately absent from
the zod allowlists; the EXISTING `CompanyKind`/discipline vocabulary that
already spells `architect` (a firm's kind, a consultant's discipline) is a
different axis and is untouched. Where the controller prose already says
"PMC/architect", the allowlist finally matches the words.

**The role is DELIVERED DARK and armed only after the drain** (this plan,
§D — the 4c rollout discipline applied to 4d's own mixed-version hazard):
4d-i installs an orgs-owned RESERVATION on `Membership` refusing any INSERT
or UPDATE whose NEW row carries `role = 'architect'` — judged on NEW
regardless of OLD, so a removed row already in that role can be neither
restored nor re-keyed into service through it (the exact shape of 4c-i's
`ProjectCapability_t4c_reserved`), and it is dropped by the trailing
migration-only unit 4d-iii once the previous release is attested drained.
**And the reservation covers EVERY 4d producer — the forward door included**
(review round 4): the architect reservation keeps the CHAIN off, but
forwarding needs no architect (P29's holder/PMC forward), so 4d-ii's
`decisions.forward` would emit `decision.forwarded` while an ALREADY-RUNNING
previous-release push worker — which ran `syncConsumerCatalog` once at ITS
startup and is fenced by the version bump only when it RESTARTS — could still
claim that delivery, know no `forward` family, and take the unguarded send
path: after its old pre-send read a second forward cancels the delivery, it
never performs 4d-ii's final re-read, and the displaced holder is sent the
push. 4d-i therefore ALSO installs `DecisionForward_t4d_reserved`, a BEFORE
INSERT trigger refusing EVERY `DecisionForward` row through the SAME
refusal function, dropped by the SAME 4d-iii statement — so before the
attested drain no forward, hence no holder mutation, no `decision.forwarded`
and no forward push, can exist; every other 4d producer (countersign,
disagree, the stranded resolution, `decision.awaiting_countersign`) already
requires an architect and is fenced by the role reservation. On the service
path `decisions.forward` refuses 409 naming
`phase-6-4d-previous-release-drained` while the reservation stands — judged
the way the database judges it, by the reservation trigger's presence in
`pg_trigger` (one catalog read, under the readiness lock, the read
`upgrade-proof.sh` already performs) — and the web Forward affordance
follows the shell-level `rollout.phase6_4d: 'reserved' | 'open'` read
(the SAME read the Team role pickers gate on, §A.1; review round 5) baked
from that catalog read, so no client offers what the server refuses
(ui-server-parity; P34's web arm); 4d-iii's drop flips the read. P29c gains
the four arms: with the reservation ARMED a service forward is 409, a hostile
direct `DecisionForward` insert is refused, the outbox holds no
`decision.forwarded`, and no Forward renders; after 4d-iii all four open. The
alternative — deploying and draining the consumer fence in a unit BEFORE the
producers — was weighed and not taken: it adds a fifth PR and a second
attestation over the same fleet, while extending the delivered 4c-iii
reservation shape to one more producer costs one trigger and keeps the ONE
attestation.
**And the reservation is installed only onto a database that holds NO such
row** (this plan's review round 1): `Membership.role` is an unconstrained
`String` today, so a pre-existing row already spelling `architect` — a
value nothing validated because no vocabulary admitted it — would survive
the reservation untouched and arm the chain the instant
`phase6_effective_role_standing` learns the role, which is exactly the
mixed-version state the reservation exists to prevent. 4d-i therefore carries
a DIAGNOSTIC-FIRST audit (the delivered `ABORT` pattern of 20271015/20271120)
— **ordered AFTER the reservation is installed, inside the same transaction**
(review round 2, correcting a round-1 draft that audited first): the
migration's `CREATE TRIGGER` for the reservation takes ACCESS EXCLUSIVE on
`Membership`, so every concurrent writer — a direct one or a previous-release
instance — blocks until this transaction ends; only THEN does the audit count
`Membership` rows with `role = 'architect'` in ANY status, and if the count is
not zero it RAISES with a bounded sample and the WHOLE transaction rolls back,
the trigger included — never re-roles, never deletes. Auditing before the
trigger would leave the classic gap: a writer inserting an active architect
row after the count observed zero and before `CREATE TRIGGER` took its lock
would be grandfathered past the reservation and arm the chain in the dark
window. Both orderings are barrier-probed on the shipped file exactly as
4c-iii's transition race is (P28b): writer-first — the migration waits at
`CREATE TRIGGER`, then its audit sees the committed row and ABORTS;
migration-first — the writer waits, then is REFUSED by the reservation.
**The operator repair is a RE-ROLE, never a soft removal** (review round 2):
the ordinary team removal path sets `status = 'removed'` and leaves `role` in
place (`members.service.ts`), and the audit counts every status, so a
soft-removed `architect` row aborts the next deploy identically. The §P6T4D
entry 4d-i adds to `docs/RUNBOOK.md` therefore directs the operator to
re-role every offending row to the role the member actually holds through
the ordinary team role command (the aborted attempt installed nothing, so
that UPDATE is free), or — for a row that never legitimately existed — to
delete it with the documented operator SQL, subject to the delivered 4b
holder guards, which refuse deleting the named holder of an open decision
(that row is re-roled instead); then the same runner redeploys.
`upgrade-proof.sh` plants BOTH an active and a soft-removed hostile row and
drives abort → re-role → redeploy end to end (the correction-2/3 abort-proof
discipline), and the P3005 baseline path cannot skip the audit because the
migration is in `ALWAYS_EXECUTE`.
Until 4d-iii no project can hold an active architect, so no chain can
activate, no decision can enter `awaiting_countersign`, and no JWT can
carry the role — INCLUDING the dev session (review round 27: in a
non-production environment with `ALLOW_DEV_AUTH=true`, `AuthService.session`
falls back to minting `dev-<role>` for a role with no matching user,
reading neither `Membership` nor the reservation, so 4d-ii's widened
`sessionSchema` would let a `countersign-v1` client obtain an architect
JWT while membership creation is still blocked; the fallback therefore
REFUSES `architect` — 409 naming the drain directive — until
`rollout.phase6_4d` is open, and P28b covers this alternate token
producer) — which is what keeps a still-serving pre-4d instance safe
(§D states the two concrete failures the reservation prevents). "Activating
the chain" is thereafter a per-project PRODUCT act — the PMC adds an
architect member — never an operator step.

### 2. Orchestration

The settled design, plus the owner's 2026-08-13 amendment, as behavior:

- **Forwarding**: an append-only `DecisionForward` chain — `projectId`,
  `decisionId`, `fromDesignation` (the DISPLACED holder: kind + membership),
  `toDesignation` (the new one), **`forwardedById` (the ACTOR — round 2:
  forward authority includes non-holders, so a PMC forwarding a client-held
  decision is recorded as the PMC displacing the client)** with the
  action-time `forwardedByRole` and `forwardedByName` frozen beside it
  (review round 25 — below), `reason`, `at`,
  and the delivered provenance shape (`sourceCommandId`, §A.3 obligation 6)
  — all immutable. The HOLDER is not a new concept: it is the decision's
  CURRENT decider designation (4b §A.1) — forwarding re-points that
  designation and the chain records each hop, so every pending surface,
  badge and push that "follows the decider" follows the forward
  automatically. **Forwarding EMITS** (round 2): `decision.forwarded` joins
  the catalog (`invalidate: true`, the targeted push at the NEW holder
  through the user-level dispatch, `pushFamily: 'forward'`), re-seal probed
  (P34). **The holder is mutable ONLY through the recorded act — and the act
  must MATCH the change** (round 3; strengthened `6a53aae` round 1): the 4b
  write-once trigger that ACTUALLY freezes the holder — `Decision_t4b_attribution_seal`
  (`decision_t4b_attribution_seal`, `20270826000000_phase6_t4b_approval_attribution`,
  whose published-or-attributed arm refuses any change to `deciderKind` or
  `deciderMembershipId`; review round 25 — the plan had named
  `phase6_t4b2_decision_seal`, which carries the role arms this plan widens
  but no holder-freeze arm, so the forward row and holder update would have
  rolled back at the seal that was never loosened) — loosens to
  exactly one opening — a change accompanied by a same-transaction
  `DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns
  and whose `toDesignation` EQUALS the NEW ones — **and the two DIFFER**
  (review round 13): equality alone admits a forward from the client to the
  client, a no-op holder UPDATE paired with a matching row that appends
  immutable handoff evidence and sends a forwarded push for a handoff that
  never happened; the command refuses a same-target forward 409 ("already
  the holder"), the holder-door arm requires the holder columns to actually
  change, and the forward-side reverse seal refuses a row whose
  `fromDesignation` equals its `toDesignation`, so the no-op is
  unrepresentable at both layers (P34). Mere row presence is
  forgeable: a hostile transaction could insert a forward row naming
  unrelated designations and re-home the holder to a third member with the
  trigger satisfied — authority, counts and pushes following an unrecorded
  transition. The seal compares the transition to its evidence
  field-for-field; hostile-probed BOTH ways — no row at all, and a mismatched
  row (P34). **And the pairing is sealed in BOTH directions** (round 2): a
  `DecisionForward` INSERT is itself refused unless the SAME transaction
  carries the matching holder mutation — otherwise a direct insert fabricates
  immutable handoff evidence (`forwardedById`, `reason`) for a handoff that
  never happened, and the chain/register reports it as history. A DEFERRED
  constraint trigger checks the pair at commit from the forward side exactly
  as the holder trigger checks it from the decision side; the orphan-row
  hostile insert is probed (P34). **Forwarding is legal only in states the
  NEW HOLDER can act on** (rounds 3–4): `pending` and `change` ONLY, CAS'd on
  status; terminal states refuse, and `awaiting_countersign` is EXCLUDED from
  the generic command — that status is the ARCHITECT's action item, and
  while a countersign is pending the only routing moves are the architect's
  own (countersign, reject-back, or forward-on through the disagreement flow,
  which lands `change` and leaves the new holder actionable). Both refusal
  classes probed (P30). Forward authority: the current HOLDER + the PMC **+
  the architect once one exists** (the AMENDMENT). The `reason` carries the
  sibling non-blank discipline exactly as 4c-i spelled it (this plan's
  review round 1 — a bare `btrim(x)` strips spaces only): `NOT NULL` AND
  `CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '')` — the complete ASCII
  whitespace set, two obligations not one, since a CHECK over NULL passes as
  UNKNOWN — beside zod `trim().min(1)`; a tab-and-newline-only value is
  probed refused at the DB (P34). The TARGET must be able to act (round 2):
  `toDesignation` validates through the orgs participant as an ACTIVE
  same-project member/role — a removed-target forward is 409 (P30). **And
  the target's standing is judged AT THE DB too** (round 3): the service 409
  binds only the command path — hostile SQL could insert a MATCHING forward
  row naming a removed membership (or a role with no active member) and
  re-home the holder in the same transaction; the pairing seals pass, and the
  holder-orphan guard never fires because the target was ALREADY inactive
  when installed. The holder-door trigger therefore also validates the NEW
  holder's standing — a named-member `toDesignation` must resolve through
  `phase6_membership_active_user` (the composite FK pins existence and
  project; ACTIVE standing is the primitive's read, under the membership row
  lock), a role `toDesignation` must have `phase6_effective_role_standing`
  ≥ 1 — the standing read riding the delivered `phase6_try_readiness`
  protocol as the chain-presence read does (below), so it cannot race a
  concurrent removal. Hostile-probed: a matching forward row to a removed
  membership AND to an empty role, both refused (P34). **The DOOR itself is
  status-gated** (round 4): the `pending`/`change` rule is stated as the
  command CAS, but the DB door opens on any matching forward row — hostile
  SQL could re-home the holder on an `approved`, `recorded`, `withdrawn` or
  `awaiting_countersign` decision, rewriting a terminal or
  countersign-pending register with every pairing seal green. The
  holder-door trigger AND the forward reverse seal therefore both require the
  decision's status to be `pending` or `change` at the mutation; the hostile
  terminal and awaiting shapes join P34. **And the recorded ACTOR must be
  able to perform the act** (round 4): `forwardedById` is immutable evidence,
  but nothing at the DB required it to name someone with forward authority —
  a matched hostile row attributed to an inactive contractor or an unrelated
  member would record an authorized handoff nobody made. The door validates
  the actor: at the DB, `forwardedById` must hold ACTIVE standing granting
  forward authority — the current holder's own user (the named membership's
  user via `phase6_membership_active_user`; for a ROLE designation, a user who
  HOLDS that role via a NEW orgs-owned, lock-bearing
  `phase6_user_holds_role(project, user, role)`, the per-user twin of
  `phase6_effective_role_standing`: TRUE iff THIS user contributes to the
  role's effective standing — an ACTIVE membership in that role, read under
  its row lock, or for `pmc` the membership-less org owner/admin path —
  never "someone holds it"; review round 3, which found the delivered
  `phase6_decisions_hold_role(project, role)` takes no user and answers only
  whether any open decision is assigned to the role, so a matched hostile row
  naming an unrelated contractor as `forwardedById` on a client-held decision
  passed while any active client existed), or `pmc`/`architect` via the NEW
  orgs-owned `phase6_user_orchestration_authority(project, user)` — ACTIVE
  `pmc` or `architect` membership, or the membership-less org owner/admin
  path, under the same locks as its sibling — **and NOT via a widened
  `phase6_user_decision_authority`** (review round 3): that primitive is the
  DB backstop for decision-CREATE authority, called by
  `phase6_t4b2_decision_seal` when a record is born, converted or published,
  so widening it would let a direct insert attributed to an architect pass
  seals this plan explicitly keeps PMC-only (`decision.create`,
  `decision.publish`); it stays byte-identical. Both new primitives are
  ORGS-owned and registered exactly as 4c-i's two were, reaching the
  decisions seals over the declared decisions → orgs edge. The same standing
  read under the same protocol; the inactive-actor and unauthorized-actor
  hostile rows are probed, and the role-holder arm's own: another user holds
  the client role while the recorded actor does not (P34).
  **And the architect can SEE what the architect may forward** (review round
  12): the canonical `decisionVisibleToViewer` shows a `pending` decision to
  the PMC, the decider and a standing consultee only, and the web
  `selectLogDecisions` mirrors it, so an active architect who is neither the
  holder nor a consultee could not retrieve — let alone render a Forward
  affordance on — the client- or member-held pending decision this plan lets
  them forward; P30's direct HTTP probe would pass while the product path did
  not exist. The audience widens by EXACTLY one more arm, the consultee
  precedent: while the chain is ACTIVE an active architect sees every
  `pending` decision of the project (and every `awaiting_countersign` one —
  already the architect's own obligation), in the ONE shared predicate
  (`decisionVisibleToViewer`, its web mirrors `selectLogDecisions` /
  `selectVisibleDecisions`, and the projection read-path filter — the same
  sites 4b and 4c widened together so they cannot drift), gaining no
  authority by sight (forward authority is the rule above, judged at the
  command and the DB); `change`, `approved` and `recorded` stay as today,
  `withdrawn` stays pmc-only, and with no chain the predicate is
  byte-identical (P29). An explicit architect queue was weighed and not
  taken: a second audience rule for one role, drifting from the first. P34's
  web arm probes a NON-holder architect forwarding a client-held pending
  decision through the shipped UI — the row rendered in the architect's
  Decision Log with the Forward affordance, the forward driven end to end,
  the displaced holder's push cancelled — RED at base (the row is absent),
  plus the negative: the same row absent for a removed architect and for an
  architect while the chain is inactive. **Forwarding SERIALIZES against
  approval and countersign** (round 1): each
  of approve/countersign/forward takes `lockProjectReadiness` and then the
  decision row's lock in the canonical order (readiness → `Project` →
  `Membership` → `Decision`, the 4c §A order P41 pinned) and re-checks the
  holder INSIDE the transaction, so the loser of either ordering is a
  deterministic 409 — barrier-probed in BOTH orderings (P35). **And the
  decider push follows the forward AT CLAIM** (the 4c hand-off, weighed): the
  delivered `deciderPushTarget` reads its decision with a plain `findFirst`,
  which was correct while the holder could not move after publication. It
  can now. The claim predicate therefore takes the decision row's lock before
  reading the holder (the discipline 4c's consultation claim already uses —
  4c plan P38c/P40c, review round 12), so a forward committing between
  enqueue and claim re-targets the pending DECIDER push at the installed
  holder or drops it with the recorded cancellation mark, while a
  still-standing consultee push SURVIVES the same forward. **The guarantee
  is stated at the boundary it can actually hold** (this plan's review
  round 1): the delivered `makePushConsumer` awaits the claim query's OWN
  transaction and only then calls the EXTERNAL `notifyTargetedUser`, so the
  decision row lock is released before the send — a claim can read holder
  A and commit, a forward can commit holder B, and a lock inside the query
  alone cannot stop the send to A. The send is external I/O and cannot be
  inside any transaction, so 4d closes the window to the provider call
  itself and DISCLOSES what remains: (i) EVERY command that changes the fact a
  family's claim predicate reads CANCELS that family's not-yet-sent
  deliveries by subject, under the same lock the predicate reads under —
  the 4a cancellation-by-`subject` key the outbox already carries,
  exercised by a domain that learned its announcement went stale. Stated
  for every family this unit touches, not only the decider (review round 2,
  generalizing a round-1 draft that cancelled decider deliveries alone): a
  forward cancels that decision's `decider` AND `forward` deliveries (a
  second forward invalidates the first forward's push at the now-displaced
  holder exactly as it invalidates the decider's); **and so does the
  APPROVAL that meets the demand** (review round 13): `approve` — landing
  `approved` directly or `awaiting_countersign` under a chain — cancels that
  decision's `decider` AND `forward` deliveries by subject under the decision
  row lock, because a delivery claimed before the approval passes the
  consumer's final delivery-row, standing and project re-reads (none of
  them read the status until review round 18 added the subject re-judge
  below as the backstop for the DIRECT writer the plan admits) and would
  send "awaiting your approval" after the holder acted; the family
  predicates' STATUS arm refuses at CLAIM and, from round 18, again at the
  SEND, and the in-flight one still gets the mark, which is what keeps the
  common case from reaching the send at all; P40 barrier-probes approval between
  claim and send for both families (held at the pre-send barrier, the
  approval commits, the final re-read drops the send — the delivery marked)
  and approval-before-claim (refused at claim by the status arm); **and
  every transition that LEAVES the consultation-open set cancels that
  decision's `consultation_requested` deliveries by subject** (review round
  14): a request push claimed while the decision was `pending` survives the
  consumer's final re-reads after `approve` with no chain lands `approved`,
  after the countersign or the `completed` stranded resolution lands
  `approved`, or after the standard `withdrawChange` returns `change` to
  `approved` — an invitation `consultation.respond` then refuses; the
  approval INTO `awaiting_countersign` cancels nothing of this family
  (consultations stay open while awaiting — the cycle rule in §A.2), and the
  `consultation_responded` deliveries keep the round-10 rule (an answer is
  information, not an invitation); P40 barrier-probes a claimed request
  push against a no-chain approve, a countersign and a `withdrawChange` —
  held at the pre-send barrier, the transition commits, the send dropped and
  the delivery marked — and the awaiting entry leaving it deliverable;
  countersign,
  disagree and the stranded resolution cancel that decision's `countersign`
  delivery (the demand is gone, whichever way); **the PMC's `withdraw` cancels that
  decision's `decider` AND `forward` deliveries — and, review round 9, the two
  consultation families' unsent deliveries for that decision whose TARGET
  leaves the withdrawn audience (a `countersign` delivery cannot exist on a
  pending decision), because a `consultation_responded` delivery claimed
  for an ARCHITECT requester before the withdrawal passes the delivery-row
  re-read AND the family's own standing rule (the architect is still active)
  and would carry the title to a non-PMC after the decision became PMC-only
  — RESTRICTED, review round 10, to exactly those targets: round 9's blanket
  by-subject cancellation also marked a response push to a PMC requester,
  the delivery the round-3 audience arm and P38 require to REMAIN
  deliverable (a withdrawn decision is pmc-only; a PMC may still be told
  advice was given). The withdraw transaction therefore enumerates the
  decision's consultation entries and cancels a `consultation_responded`
  delivery only where its target user lacks PMC standing
  (`hasProjectRoleStanding(user, ['pmc'])` false — the architect requester)
  — IN THE CANONICAL LOCK ORDER (review round 21): that standing read locks
  the target's membership row, and taking it AFTER the decision row would
  invert readiness → `Project` → `Membership` → `Decision` against a
  concurrent `consultation.respond` holding that same membership and
  waiting on the decision, which PostgreSQL resolves by aborting one side.
  So `withdraw`, under `lockProjectReadiness`, FIRST reads the decision's
  consultation entries WITHOUT the decision lock, locks every response
  target's membership in ascending membership id and judges its standing,
  THEN takes the decision row lock and re-validates the consultation set
  under it — an entry that appeared between the two reads means a
  membership this transaction has not locked in order, so the command
  refuses as contended (the try-acquire posture; the client retries) rather
  than lock out of order; P40/P41 gain the withdraw-vs-respond barrier in
  both orderings with no deadlock abort — while EVERY `consultation_requested` delivery for the
  decision is cancelled by subject regardless of target (review round 13):
  the target filter is right for a RESPONSE, an informational answer a PMC
  may still receive, and wrong for a REQUEST, an invitation to act that the
  `consultation.respond` command refuses on a withdrawn subject for a PMC
  consultee exactly as for anyone else — a claimed request push to a PMC
  consultee that survived the filter would invite an impossible action;
  the response cancellation goes through
  a NARROWING arm on the delivered `cancelQueuedPushBySubject`
  (`targetUserIds`, judged against the event's own durable dispatch intent,
  which every arm of that operation — pending, leased, dead, subjectless,
  not-yet-materialized and the repeat pass — already carries, so no arm
  changes shape); the `decider` and `forward` families cancel by subject as
  before, their targets being the displaced audience by construction.
  Probed: PMC requests advice → the consultee responds and the push is
  claimed → the PMC withdraws before the send → the PMC RECEIVES the
  response, the delivery `succeeded`/`dispatch` with no mark; the same
  sequence with an architect requester → marked, nothing sent; and a
  REQUEST push to a PMC consultee claimed before the withdrawal → marked,
  nothing sent (review round 13) (P38's consultation arm and P40's barrier
  arm, both orderings). The cancellation
  is by subject — and target, for the consultation families — under the
  decision row lock inside the withdraw transaction** (review round 4 — the
  forward family knew only a later forward as its invalidation: forward a
  pending decision to an architect or any non-PMC member, enqueue
  `decision.forwarded`, withdraw before the claim — the holder is still
  installed and active, so the predicate accepted a push about a decision
  `decisionVisibleToViewer` now shows to the PMC alone), and the `forward`
  predicate carries a STATUS arm beside the installed-holder test: actionable
  only while the decision is `pending` or `change` — `withdrawn` cancels with
  the recorded mark (the audience boundary, the same arm the response push
  gained in round 3) and the terminal `approved`/`recorded` cancel too (the
  holder acted before the claim; the demand is gone); and the orgs role
  mutation that deactivates the chain — the last architect leaving, under
  `lockProjectReadiness` — cancels the `countersign` deliveries of every
  awaiting decision in the project (the delivery's recorded audience would
  otherwise be sent to a removed architect) — a cancellation that, from
  review round 24, is DERIVED by the `decisions.effects` consumer from the
  `membership.standing_changed { to: 0 }` crossing and never left to the
  service: the seals admit a hand-run receipt-backed deactivation that runs
  no service code, after which a still-pending unsent countersign delivery
  would become actionable for the next architect while the `{ to: 1 }`
  re-emit raised a second — two live demands for one decision; and the
  `{ to: 1 }` re-emit itself decides per decision under the decision row
  lock from the decisions-owned `DecisionCountersignNotice` the countersign
  send hook appends in its own send transaction (review round 25, §A.2 —
  the standing position the send resolved holders against; INSERT-sealed
  to that very delivery and to the register's current position, review
  round 27): a demand
  already sent at or after the crossing, or still pending, is left alone;
  one sent before the crossing, to the displaced architect, is replaced —
  so whichever of the consumer and the unordered push worker runs first,
  exactly one demand reaches the current standing — **and the mutation that
  RE-ACTIVATES the chain re-notifies** (review round 6): the decision stays
  `awaiting_countersign` by design, so approve → architect A removed (its
  delivery cancelled, irreversibly — the mark is terminal) → architect B
  added would leave B authorized to countersign with no delivery and no new
  event to raise one. The orgs mutation that ACTIVATES an architect (add,
  restore, role change INTO `architect`) therefore, under the SAME readiness
  lock and in the SAME transaction — **and ONLY when it is the chain's
  REACTIVATION** (review round 7): the mutation reads
  `phase6_effective_role_standing(projectId, 'architect')` under the lock
  BEFORE its write, and invokes the re-notification only when that count
  was ZERO and becomes one; with architect A already active and a decision
  already awaiting, adding architect B re-emits NOTHING — A's delivery was
  never cancelled, the fan-out at claim resolves the role's CURRENT holders
  so a not-yet-claimed delivery reaches B too, and B's Inbox item (§A.2's
  reader table) carries the demand regardless; a spurious re-emit would
  push A twice and append an immutable `countersign_renotified` row for a
  chain that never deactivated — is, from review round 19, DRIVEN BY THE
  EVENT the platform standing trigger emits on that crossing rather than by
  a participant call the service must remember to make: the decisions-owned
  ORDERED outbox consumer `decisions.effects` handles
  `membership.standing_changed` `{ to: 1 }` by invoking the module's own
  `renotifyAwaitingCountersign(tx, projectId, actor)` under
  `lockProjectReadiness` (the same function round 6 named, now reached
  through the outbox, so a writer that bypasses the service still reaches
  it), which re-emits `decision.awaiting_countersign`
  — the same catalog entry, family and body, payload `{ renotified: true }` —
  for every decision of the project currently `awaiting_countersign`,
  appending a `countersign_renotified` `DecisionEvent` attributed —
  review round 20 — to the EVENT'S ENVELOPE ACTOR: `system:membership-standing`
  for a crossing (the trigger records no human; its payload names the
  `membershipId`, `from`, `to` and the crossing's stream position, and the
  human act is recoverable by an auditor from the immutable
  `MembershipTransition` fact whose `standingEventId` names this event and
  whose id the event's own `transitionId` names (review rounds 21–22) —
  never DERIVED by the consumer, which could pick the
  wrong transition when a membership is removed and restored more than
  once before the handler runs); a restore writes no such row from review
  round 21, releasing parked deliveries instead; the projection fold is a status no-op and the push family
  claims it exactly as the original. Exactly once, never twice: the re-emit
  enumerates decisions whose awaiting entry PRECEDES the crossing (the
  event carries the crossing's stream position; a decision approved after
  the crossing but before the handler runs is notified by its own approve
  and SKIPPED by the handler, its provisional revision being newer than the
  crossing; and — review round 23 — a decision approved BEFORE the crossing
  under NO chain reached terminal `approved`, is not awaiting, is enumerated
  by nothing and owes no countersign at all), the handler is keyed per
  (decision, event) so a redelivery appends nothing, and approve serializes
  with the activation on the readiness lock (P36) — the ordering barrier in
  both directions asserts the exact count per decision: ONE for a decision
  awaiting before the crossing (the re-emit) or approved after it (its own
  approve), ZERO for one approved to finality before it; an activation with
  no awaiting decision emits nothing, and an activation while another architect is already active
  emits nothing (P29b; review round 7). Preserving the cancelled delivery instead was weighed and
  not taken: the cancellation mark is terminal by 4a's design and an
  un-claimable "no recipient yet" delivery would retry to dead-letter; the
  consultation families keep their delivered 4c predicates. (ii) the consumer performs a FINAL same-row
  re-read of the delivery's cancellation mark immediately before
  `notifyTargetedUser` — it reads the DELIVERY row, so it is family-agnostic
  by construction — and drops with the mark if the invalidating command
  landed after the claim; **and for a ROLE-targeted delivery it re-judges
  EACH recipient** (review round 4): the delivered consumer resolves a
  role's current holders ONCE at claim (`roleHolderUserIds`) and then sends
  to each, so with architects A and B active the countersign push claims,
  resolves both, A is removed while B keeps the chain active — the
  last-architect cancellation does not run, the delivery-row re-read is clear
  — and A's device receives decision content after A's standing ended; a
  role-held forward push with two holders has the same gap. The consumer
  therefore re-checks THAT user's standing immediately before EACH
  `notifyTargetedUser` — `phase6_user_holds_role(project, user, role)`, the
  round-3 primitive, read through the orgs participant — and skips a user who
  lost it, sending to the rest; the whole-delivery cancellation on the last
  architect leaving stays (the DEMAND is gone), but it is not the audience
  guard and never was. **And the re-check covers the USER-targeted branch
  too** (review round 5): a `consultation_responded` delivery can be claimed
  while its architect requester A is active, A removed once the claim
  transaction has released its membership lock, and the delivery-row re-read
  stays clear because the membership mutation cancels only `countersign` —
  so the `targetUserId` branch would send the response and the decision title
  to A after A's project access ended; the decider push to a named member and
  the consultee push have the same shape. The final pre-send check is
  therefore ONE HOOK for EVERY recipient of EVERY family: immediately before
  each `notifyTargetedUser` the consumer re-judges THAT user **by the
  family's OWN standing rule, never a uniform membership test** (review round
  6 — a `consultation_responded` requester may be an org owner/admin with NO
  `Membership` row on the project, exactly why 4c keyed that target by user
  and asked the orgs-owned `hasProjectRoleStanding`; a uniform
  `phase6_membership_active_user` check would drop every valid response push
  to them): the responded family re-applies `hasProjectRoleStanding(user,
  ['pmc', 'architect'])` — the claim predicate's own question, asked again
  at the send; the named-decider, consultee and forward-holder families
  re-check the named membership's ACTIVE standing
  (`phase6_membership_active_user`); a role fan-out re-checks
  `phase6_user_holds_role(project, user, role)` — all through the orgs
  participant. **A stale recipient is SKIPPED, never MARKED** (review round
  6): `OutboxDelivery` carries one delivery-wide `cancelledAt` /
  `deliveryAction`, not per-recipient state, so marking the row when A fails
  would make B's own final same-row re-read drop B too (A checked first), or
  record the delivery as wholly cancelled after B's external send (B first).
  The consumer therefore skips the failed user without touching the mark and
  sends to the rest; the delivery completes `succeeded`/`dispatch` with the
  recipients actually sent, and the recorded mark is set ONLY when the whole
  delivery drops — the claim-time non-actionable verdict, the final same-row
  re-read, or EVERY resolved recipient failing the re-check (a user-targeted
  delivery has one recipient, so its failure IS the whole delivery). Durable
  per-recipient evidence was weighed and not taken: it needs a new column on
  the platform's delivery row for a fact the audit register already carries
  in the push provider's own log. Cancelling per family from the membership
  mutation was weighed and not taken: it would make the orgs removal
  enumerate every family's per-user deliveries, while the recipient re-check
  is uniform in SHAPE and family-owned in RULE. The residual is then PER
  RECIPIENT — a removal committing during that one user's provider call —
  the same disclosed class as (iii). **And the hook re-checks the PROJECT,
  not only the person** (review round 7): archival changes a fact every
  decision push predicate reads, and the orgs archive command sets
  `Project.archivedAt` WITHOUT the readiness lock and without cancelling any
  delivery — a `forward` or `countersign` delivery claimed while the project
  was operable, the archive committing before the send, every standing
  re-check still passing, and the provider receiving decision content the
  access layer would refuse to serve. The final pre-send hook therefore also
  asks the delivered `OrgsParticipant.isProjectOperable` (the row-locking
  read, so the archive waits for the check or the check sees the archive)
  for EVERY family, and an archived project PARKS the WHOLE delivery
  (review round 21 — rounds 7 to 20 dropped it with the terminal mark and
  had restoration REBUILD the work from open subjects, which loses a
  parked-family delivery the rebuild never enumerated — a claimed
  `consultation_responded` push — and duplicates a delivered one whose
  subject is merely still open): the hook RETURNS A PARKED OUTCOME to the relay rather
  than writing the row itself (review round 22: the delivered
  `dispatchExternal` marks the row `succeeded` unconditionally once
  `consumer.handle` returns, so a park written inside the hook would be
  overwritten the same instant and `releaseParked` would find nothing —
  the consumer `handle` contract therefore gains an explicit `parked`
  result, and the relay, on it, leaves the row `pending` with
  `nextAttemptAt` set to the far-future HOLD sentinel and `lastError =
  'project_archived'`, attempts untouched, the lease released, NO
  cancellation mark, so the claim query (which already skips a future
  `nextAttemptAt`) never leases it while the project is archived and it can
  never dead-letter — and, review round 24, the relay's legacy/shadow
  RECOVERY claim honours the sentinel too: today `claimExternalRecovery`
  admits any `pending` row with `attempts = 0` once `updatedAt` is older
  than the lease window WITHOUT reading `nextAttemptAt`, so a freshly
  parked row (attempts untouched at zero) would be reclaimed and re-parked
  every lease interval until restoration — permanent relay churn; 4d-ii
  adds `"nextAttemptAt" <= now()` to that recovery arm, and P40's archive
  arm runs in outbox AND legacy/shadow sender modes, asserting the parked
  row is claimed by neither pass while the project stays archived) — and
  the archived READ and the park WRITE are ONE
  transaction that holds the `Project` row lock through the delivery
  update (review round 22: a row-locking `isProjectOperable` read that
  committed before the park would let `restoreProject` clear `archivedAt`
  and its consumer run `releaseParked` between the two, after which the
  hook parks a row the only release has already passed — held forever;
  with the lock held across both, restoration either commits first and the
  read sees an operable project, or waits and its release then finds the
  parked row), so the relay performs the operability read, the parked
  outcome and the row update inside one transaction under that lock; the
  claim-time operability arm parks the same way; project-wide, so the row
  itself is the right instrument. **And a row is parked only BEFORE its
  first recipient is sent** (review round 24): the operability judgement is
  made ONCE per delivery row, at the pre-send barrier ahead of the FIRST
  `notifyTargetedUser`; once any recipient has been sent the row is
  committed to completion — the remaining recipients receive only their
  own standing re-judge, the row ends `succeeded`/`dispatch` and is NEVER
  parked (a parked row is retried WHOLE on release, and the delivered
  `makePushConsumer` re-resolves every role holder with no durable
  per-recipient progress, so parking after A's send would send A twice on
  restoration); an archive landing between two recipients of one fan-out
  is therefore the in-flight residual already stated for the provider
  call, its bound widened from one call to one row's fan-out — the bodies
  generic by construction — stated, not asserted away. P40's archive arm
  gains the interleaving under a barrier: A sent, the project archived at
  B's pre-send barrier → B sent, the row `succeeded`, nothing parked, the
  restoration releases nothing and A is never sent a second time. P40's archive arm gains both orderings
  of restore-vs-park under a barrier (restore-first → sent; park-first →
  released and sent once, never held). Cancelling the decision families from
  the archive command was weighed and not taken for the same reason as the
  membership mutation, and the operability arm joins the two new families'
  claim predicates as well.
  **And RESTORATION RELEASES what archival parked** (review rounds 18
  and 21): `OrgsService.restoreProject` clears `archivedAt` with the
  architect count unchanged, so nothing else would ever resume the parked
  work. The `project.restored` event the restore command ALREADY emits is
  therefore CONSUMED (review round 19 — a side effect that must hold is
  bound to the event, not to a participant call) by the decisions-owned
  ordered consumer `decisions.effects` (§A.2), whose handler asks the
  kernel's `OutboxOperationsService.releaseParked(projectId)` to set
  `nextAttemptAt = now()` and clear `lastError` on every delivery of the
  project parked as `project_archived` — the EXACT deliveries archival
  consumed, family and target preserved on the same rows (review round 21:
  rounds 18–20 had `renotifyOpenDemands` rebuild fresh deliveries from
  today's open subjects, which never enumerated a parked response push and
  re-emitted a decider or countersign demand already delivered), each then
  claimed and sent through the ordinary per-recipient re-judge, so a
  subject or recipient that went stale while the project was archived
  drops there; keyed per (delivery, event) so a redelivery releases nothing
  twice; a project with nothing parked releases nothing. `renotifyOpenDemands`
  is WITHDRAWN, and a restore writes no `countersign_renotified` row (there
  is no re-emission to attribute). A restore by direct SQL (`archivedAt =
  NULL` with no event) is an operator act, symmetric with a direct archive
  that parks nothing, repaired by the platform operator command
  `outbox:release-parked <project>` — the same kernel operation. P29b/P40
  gain the arm: approve under a chain → archive → the countersign push
  claimed and PARKED (pending, held, unmarked) → restore → the same row
  released and sent once; a parked `consultation_responded` push released
  likewise; a decider push delivered before the archive NOT sent again; a
  project with nothing parked releases nothing. P40
  gains the archive-vs-claim barrier for the forward and countersign
  families (archive at the pre-send barrier → nothing sent, the delivery
  PARKED — `pending`, `nextAttemptAt` at the HOLD sentinel, `lastError =
  'project_archived'`, NO cancellation mark, exactly the contract above;
  review round 23 corrected the arm, which had asserted the terminal mark
  that would have left `releaseParked` nothing to resume — and the
  restoration then releases and sends that SAME row once). **And the hook
  re-checks the SUBJECT, not only the person and
  the project** (review round 18): cancellation-by-subject covers the
  SERVICE transitions, but §A.2 admits DIRECT transitions while the chain is
  inactive — a direct `pending → approved` write is in the DB-serialized
  writer set — and such a write executes no service cancellation, so a
  `decider` delivery claimed before it keeps a clear mark, passes every
  standing and operability re-check, and would send "awaiting your
  approval" after the decision is approved; a claimed
  `consultation_requested` push whose decision left the open set by the
  same route has the same gap. The final pre-send hook therefore re-runs
  EACH FAMILY'S OWN CLAIM PREDICATE — the SAME `decisions.*PushTarget`
  question asked at claim, target-aware wherever the claim is (review round
  19): `decider`/`forward`: `pending`/`change` with the holder unchanged;
  `consultation_requested`: the consultation-open set; `countersign`:
  `awaiting_countersign`; `consultation_responded`: the round-10 rule
  verbatim — a PMC-standing target stays actionable AFTER a withdrawal (the
  PMC remains in the withdrawn audience, which is exactly why the withdrawal
  leaves that delivery unmarked), a non-PMC target only while the decision
  is not `withdrawn` (round 18's flat "not withdrawn" rule would have
  dropped at the send the very PMC response the withdrawal preserved) — as
  a decisions-owned read of the decisions-owned `Decision` row (no boundary
  is crossed), immediately before EACH recipient's provider call, in the
  same per-recipient hook as the standing re-check (review round 19: once
  per delivery leaves a role fan-out's window open — recipients A and B
  resolved, the predicate passed while `pending`, A sent, the direct
  `pending → approved` committed, B still standing and still sent the
  obsolete demand with its title). The outcome follows the round-6 rule: a
  subject that left the actionable set BEFORE any send drops the WHOLE
  delivery with the recorded mark (subject-wide, the right instrument, as
  for archival); one that leaves BETWEEN sends skips every remaining
  recipient without touching the mark, and the delivery completes with the
  recipients actually sent. The service
  cancellations stay — they are why the common case never reaches the send
  — and the re-judge is the backstop for the one writer the plan permits;
  the residual narrows to a direct transition committing during the
  provider call itself, the same disclosed class as (iii). P40 gains the
  direct-transition arm: a `decider` push claimed, a direct `pending →
  approved` committed at the pre-send barrier under an inactive chain →
  nothing sent, the delivery marked; a claimed request push against a
  direct transition out of the open set likewise; the fan-out arm — A sent,
  the direct transition committed at B's pre-send barrier, B skipped, no
  mark; and the responded family's target-aware re-judge — the PMC
  requester's response SURVIVES a withdrawal committed at its pre-send
  barrier while the architect requester's is dropped (review round 19);
  (iii) the residual — an
  invalidating command
  committing after that final re-read and before the provider accepts the
  send — is a stale push to the displaced holder, **and it is a
  POST-REVOCATION DISCLOSURE of whatever the body carries, stated as such**
  (review round 8 — an earlier draft called the body content-free, which the
  delivered bodies contradict: the decider push says "New decision awaiting
  your approval: <title>", the consultation bodies carry the title, and the
  approval announcement carries the option and material). Two consequences:
  the two NEW families' bodies are GENERIC by construction — the countersign
  push says a decision awaits the recipient's countersign and the forward
  push that a decision has been forwarded to them, neither naming the
  decision, option or material; the app opens the decision under its own
  authorization — so their residual discloses only that a decision exists;
  and the DELIVERED families' bodies (the decider title, the consultation
  title, the approval announcement) are 4c's cleared surface, left as they
  are and named for what they carry, so their residual is the title (or the
  option and material for the announcement) reaching a device whose standing
  ended inside the provider-call window. That is the same class as the 4c
  stale-tab residual the Board ruled on, recorded as a disclosure bound, not
  claimed away; the displaced holder's surfaces already follow the forward.
  P40 therefore proves, PER FAMILY: the claim-time re-target; the
  invalidation-vs-claim barrier in both orderings — invalidation-first → the
  delivery re-targets or cancels at claim; claim-first-then-invalidation-
  before-send → the final re-read drops it, asserted by holding the consumer
  at the pre-send barrier — for the decider (a forward), the forward family
  (a SECOND forward after the first's claim resolved holder B, AND a PMC
  withdrawal after the claim resolved a non-PMC holder — review round 4), and the
  countersign family (the last architect removed after the claim resolved
  its recipients, AND the NON-last interleaving — A and B resolved, A removed
  at the pre-send barrier, B receives and A receives nothing; the same for a
  role-held forward push with two holders — review round 4), and the
  USER-targeted families (a `consultation_responded` push claimed for an
  active architect requester who is removed at the pre-send barrier → nothing
  sent; the decider push to a named member likewise — review round 5; an
  org-admin requester with NO membership row RECEIVES the response push —
  review round 6; and the claim-first / withdraw-before-send arm for a
  `consultation_responded` push to an ARCHITECT requester — held at the
  pre-send barrier while the PMC withdraws, nothing sent, the delivery marked
  — review round 9, since P38's withdrawal arm covers withdrawal BEFORE the
  claim only; and the SAME barrier with a PMC requester — the push held, the
  PMC withdraws, the response still SENT and the delivery
  `succeeded`/`dispatch` with no mark — review round 10); the delivery row after a partial fan-out `succeeded` /
  `dispatch` with NO cancellation mark, and marked only when every resolved
  recipient is stale (review round 6); and the consultee push surviving
  each. This is a change to 4c's cleared surface,
  made here deliberately and named as such.
- **No chain until an architect exists — and "exists" means an ACTIVE
  membership** (round 1): rows are soft-removed, so mere presence would leave
  the chain armed after the only architect left. The switch is "an ACTIVE
  architect membership exists", read through the orgs participant on the
  service path and through `phase6_effective_role_standing(projectId,
  'architect') > 0` at the DB. **The switch's WRITERS serialize with its
  readers** (round 2): approve/countersign/forward read the switch under
  `lockProjectReadiness`, and the orgs-side mutations that can flip architect
  presence (role update, removal/restore, activation) take the SAME lock
  when the role entering or leaving is `architect`, joining the §A
  lock-coverage enumeration. A role-change-vs-approve barrier probe covers
  activation AND deactivation in both orderings (P36). A project that
  removes its only architect DEACTIVATES the chain for NEW approvals; a
  decision already `awaiting_countersign` is NEVER auto-flipped. **The
  resolution is a NAMED command, not a promise** (round 1 — the concrete
  interleaving: approve → `awaiting_countersign` → the last architect leaves;
  generic forwarding refuses that status and countersign needs an architect,
  so without a defined command the decision is gate-`wait` forever): the
  PMC-only `decisions.resolveStrandedCountersign`, legal ONLY while `status
  = 'awaiting_countersign'` AND no active architect membership exists (both
  re-checked under the decision row lock + `lockProjectReadiness` — the
  switch serialization of P36 covers an architect re-appearing mid-command),
  with two explicit attributed outcomes — **and the resolution is itself a
  REGISTER FACT, not a log line** (round 3): the append-only
  `DecisionStrandedResolution` table (`projectId`, `decisionId`, the exact
  head `revisionId` resolved, `outcome: 'completed' | 'returned'`,
  `resolvedById` + frozen display name + frozen `resolvedByRole` (review
  round 25), `reason` — user-supplied evidence
  with the sibling non-blank discipline as 4c-i spelled it: `NOT NULL` +
  `CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '')` + zod
  `trim().min(1)`, a tab-and-newline-only value refused at both layers
  (P29b; this plan's review round 1) —, `at`, and the provenance shape; same-project composite FKs; immutable; UNIQUE per
  `(projectId, decisionId, revisionId)` — a decision re-stranded on a LATER
  revision resolves again, the same revision never twice). **(a) COMPLETE
  under the no-chain rule** — the head revision's `finalized` flips true and
  the decision moves to `approved` in the SAME transaction as the resolution
  row with outcome `'completed'`, emitting the real finalizing event —
  `decision.approved` or `decision.reapproved` by the revision's recorded
  `approvedFrom` (below); **(b) RETURN to the decider** — the decision moves
  to `change` with a same-transaction open `ChangeRequest` carrying origin
  `countersign_rejection` and the PMC's reason — its `requestedById` is the
  PMC who resolved (this plan's review round 1: the rejection request has
  TWO legal producers, the architect's disagreement under an ACTIVE chain
  and the PMC's stranded return under an INACTIVE one, and its seal
  discriminates them by the fact it is paired with, §B.6; a seal that
  admitted only an architect would make this documented path unusable by
  construction, since the command is legal only when no active architect
  exists) — paired with the resolution row with outcome `'returned'`, so the
  existing machinery demands a fresh approval (which, under the now-INACTIVE chain, lands `approved` directly)
  and the closed `withdrawChange` escape stays closed. The reverse holds too,
  with the BUNDLE named exactly (round 5): a `DecisionStrandedResolution`
  INSERT commits only with its matching same-transaction bundle — outcome
  `'completed'` with the finality flip AND `awaiting_countersign →
  approved`; outcome `'returned'` with `awaiting_countersign → change` AND
  the same-transaction open `ChangeRequest` carrying origin
  `countersign_rejection` (the transition alone is NOT enough: a
  returned-resolution insert without the request would commit a `change`
  decision whose reason no reader can see and which neither `approve` nor
  `withdrawChange` can close, since both require exactly one open request —
  `ChangeRequest_one_open_per_decision`) — the deferred-pairing discipline of
  the forward door; the missing-request hostile bundle is probed (P29b).
  Neither outcome touches `pending`. Probed end-to-end in P29b: both
  outcomes, the refusal while an architect is still active, and the
  architect-reappears race (P29 no-architect-ever byte-identity; P29b
  removed-architect + stranded-decision resolution).
- **Countersign, and the state that carries it** (round 1): under an active
  chain, the decider's approval writes its `DecisionApprovalRevision`
  (bound, as 4c delivered it, to the completed `decisions.approve` receipt)
  and moves the decision to **`awaiting_countersign`** — the third and last
  new `DecisionStatus` value, riding the enum for the reason `withdrawn` and
  `recorded` did — **and the readers that do NOT fail to compile are
  enumerated, because the compiler catches only exhaustive switches** (this
  plan's review round 1, correcting an earlier draft of this sentence that
  claimed every reader would): `StatusChip.tsx` casts `decisionChip` /
  `decisionChipLabel` through `Record<string, …>` and FALLS BACK to the
  withdrawn styling and an upper-cased raw value — 4d-ii adds explicit
  `awaiting_countersign` entries to both maps in
  `packages/shared/src/tokens/colors.ts`; `deriveDecisionReading`
  (`packages/shared/src/domain/readiness.ts`) has a catch-all that describes
  an unknown status as awaiting the existing DECIDER's approval — 4d-ii adds
  the explicit arm (`wait`, "Approved by <decider noun> — awaiting the
  architect's countersign"); `apps/api/src/domain/transitions.ts` carries a
  lagging duplicate `DecisionStatus` union that already lacks `recorded` and
  `apps/api/src/snapshot/types.ts` a string union of its own — 4d-ii points
  both at the shared type; the web audience selectors (`selectors.ts`, the
  `!== 'withdrawn'` exclusions), `DecisionLogScreen.tsx` (its filter list,
  `neverLocked`, the withdrawn-reason block) and the `ScheduleScreen.tsx`
  filter each answer for the value explicitly (an awaiting decision is
  visible, locked against edits, and filterable as "Awaiting countersign").
  Two more, found by the round-2 review after the first enumeration:
  `ConsultationThread.tsx` computes its open set as `pending`/`change`, so
  an awaiting decision would let neither the architect ask nor a consultee
  answer through the UI while the widened service and seals admit both —
  4d-ii widens that predicate with `awaiting_countersign` AND, review round
  17, LOADS THE ROSTER the chooser draws from: `ConsultationThread` derives
  its askable set from the store's `members`, which initializes empty and is
  filled only by `loadTeam()` (the Team screen, `IssueDecisionModal` and
  `DraftsScreen` call it lazily; startup loads the snapshot, memberships,
  portfolio and shell and never the roster), so on a fresh architect session
  the widened Ask would open an EMPTY chooser — 4d-ii has the consultation
  surface call `loadTeam()` when `members` is empty, exactly as
  `IssueDecisionModal` does, under the `members.read` row §A.1 gives the
  role, and P31's web arm drives the architect's Ask from a FRESH store,
  never from seeded members; and
  `lib/locationTree.ts` keys its per-status counters, its `STATUS_LABEL`
  and its status-mode rank by literal status, so without the new key
  `counts[status] += 1` is `NaN` and the Decision Log's status rollup omits
  the group — 4d-ii adds the counter, the label "Awaiting countersign" and
  the rank between `change` and `approved`. A shared TRIPWIRE pins the CLASS
  rather than the instances: a test that walks every `DecisionStatus` value
  against EVERY status-keyed map and predicate in shared and web —
  `decisionChip`, `decisionChipLabel`, `deriveDecisionReading`,
  `locationTree`'s counters/labels/rank, `ConsultationThread`'s open set,
  the Decision Log filter list — each registered in the test so a map added
  later has to be registered too, asserting an explicit key or arm for every
  value (and, for `deriveDecisionReading`, a reason naming that status's
  actual party) — RED for `awaiting_countersign` the moment the enum value
  exists, so a fallback path can never render it (P31's reader arm). Walking the 4a §A.3 reader table: gate `wait` —
  work must not start on an uncountersigned approval; pending surfaces show
  it to the ARCHITECT as their action item — **which names the Inbox
  selector, not only the Decision Log** (review round 7): the Inbox and the
  navigation badge are driven by `selectActionItems` (`store/selectors.ts`),
  which derives decision work from `pending` and `change` rows alone and has
  no architect branch, so an architect opening the app after an approval
  landed `awaiting_countersign` would see NO task; 4d-ii adds the
  `awaiting_countersign` branch — the active ARCHITECT's "N decision(s)
  awaiting your countersign" item (amber, to the Decision Log), the PMC's
  "awaiting the architect's countersign" summary, and when the chain is
  INACTIVE the PMC's red stranded-resolution item — and the selector joins
  the reader enumeration and its tripwire; P31's web arm asserts the
  architect's Inbox item and badge (RED at base: the selector yields nothing
  for the status); withdraw refuses it — an approval
  act exists, which the delivered never-approved seal
  (`phase6_t4a_no_approval_after_withdraw`) also enforces. **The consultation
  carve-out widens WITH the status** (the 4c hand-off): `awaiting_countersign`
  joins the open set in the service predicates AND in both delivered 4c seal
  functions (`phase6_t4c_consultation_request_seal`,
  `phase6_t4c_consultation_response_seal` — `CREATE OR REPLACE` in 4d-i, the
  bodies otherwise byte-identical — the request seal's requester arm moving
  from `phase6_user_decision_authority` to `phase6_user_orchestration_authority`,
  §A.2 above), so an architect may consult on the very approval they must
  countersign. **And the RESPONSE push follows the widened requester set**
  (review round 3): the delivered `consultationRespondedPushTarget` accepts
  requester standing for `['pmc']` only and deliberately carries no status
  arm, because every requester was PMC and a withdrawn decision is pmc-only —
  a PMC may still be told advice was given. An architect requester breaks
  both halves: 4d-ii widens the standing arm to `['pmc', 'architect']` AND
  adds the audience arm the omission relied on — a response push whose
  requester is NOT pmc is cancelled with the recorded mark when the decision
  is `withdrawn` (the `decisionVisibleToViewer` boundary re-judged at claim,
  under the decision row's lock), while a PMC requester keeps today's
  behaviour byte-for-byte. Probed (P38's consultation arm): an active
  architect requester receives the response push; a response enqueued before
  a PMC withdrawal is cancelled for the architect requester and still
  delivered to a PMC requester. The cycle semantics need no new rule and
  are stated so the review can check them: a consultation requested while
  awaiting freezes `openCycle` at the count that INCLUDES the provisional
  approval; the countersign appends NO revision (finality is a flip on the
  existing head, §A.3), so such a consultation stays cycle-valid until the
  decision leaves the open set (`approved` on countersign — refused on
  status; `change` on rejection — still answerable); a later re-approval
  appends the next revision and closes the cycle exactly as 4c's P25d
  proves. **A provisional approval must not be TRUSTABLE as a final one**
  (round 3): the register is a provenance TARGET, so the row carries
  `finalized` — born `true` outside a chain (today's behavior byte-identical),
  born `false` under a chain, flipped `true` by the countersign as its ONE
  permitted transition, trigger-sealed. **And the countersign fact is a ROW,
  not a boolean** (round 2): "flipped by the countersign" is unenforceable
  while the countersign has no shape of its own — hostile SQL could flip
  `finalized` and approve, leaving finality with no separately attributed
  act behind it. The second register act is therefore a concrete append-only
  `DecisionCountersign` table (`projectId`, `decisionId`, the exact
  `revisionId` countersigned, `countersignedById` + frozen display name +
  frozen `countersignedByRole` (review round 25), `at`, the provenance shape; composite FKs same-project, immutable like the
  register), and the `finalized` false→true flip is trigger-PAIRED to a
  same-transaction pairing fact for that exact revision — the
  `DecisionCountersign` row (the chain path), or the
  `DecisionStrandedResolution` row with outcome `'completed'` (the ONLY other
  legal finalizer — the PMC's stranded resolution, above) — the forward-door
  discipline applied to finality. A finalized-only flip with NEITHER fact is
  unrepresentable, probed directly (P31). **And the delivered append-only
  seal is REPLACED, never stacked under** (review round 10): the register
  already carries `DecisionApprovalRevision_append_only`
  (`20261212000000_phase3_approval_provenance`, `phase3_immutable_row()`),
  which rejects EVERY UPDATE and DELETE, so the paired false→true flip the
  countersign and the `'completed'` resolution perform would abort the whole
  transaction before the pairing trigger ever judged it. 4d-i therefore
  DROPS that trigger in the same transaction that installs the register's
  own replacement — a BEFORE UPDATE OR DELETE seal that refuses every
  DELETE and admits an UPDATE only when the SOLE change is `finalized`
  false→true (every other column — `approvedById`, `onBehalfOf`,
  `approvedFrom`, `approvedByName`, the revision, decision and project
  identity, the timestamps — compared OLD to NEW and frozen; a true→false
  or true→true write refused), the pairing to the same-transaction
  `DecisionCountersign` or `'completed'` `DecisionStrandedResolution` fact
  judged by the DEFERRED pairing trigger of §B.4 exactly as stated. The
  register is thus append-only in every respect but the one flip this plan
  adds, and the drop-and-replace is one migration step — never two triggers
  voting on the same row. Hostile-probed (P31): a DELETE refused; an UPDATE
  of any other column — `approvedByName` on a finalized AND on a provisional
  row included — refused; the flip without the paired fact refused at
  commit; the legal paired flip accepted; the old trigger ABSENT and the
  replacement PRESENT by name in 4d-i's closing verification and in
  `upgrade-proof.sh`, where the legacy fixture's rows (all `finalized =
  true`) stay byte-identical. **And the BIRTH value is sealed
  too** (round 4): the flip pairing judges UPDATEs only — direct SQL could
  INSERT a revision already `finalized = true` under an ACTIVE chain, never
  firing the pairing trigger, and `MaterialRequirementSpec` /
  `LabourRequirementSpec` provenance could then FK the forged finality as a
  countersigned approval. A BEFORE INSERT seal on `DecisionApprovalRevision`
  judges the born value by chain presence under `phase6_try_readiness`: with
  an active architect chain a revision is BORN `false` — finality only ever
  arrives through the paired acts; with no active chain, born `true`, today's
  behavior. The forged-birth hostile insert is probed (P31, with P42's
  provenance arm). **And the ENTRY into `awaiting_countersign` is sealed from
  the DECISION side** (review round 4): the pairing of §B.4 judges the
  REVISION insert — a direct `UPDATE "Decision" SET status =
  'awaiting_countersign'` inserts nothing, so neither the birth seal nor the
  approved-entry seal fires, and the decision sits countersign-pending with
  NO provisional head for the countersign or the stranded resolution to
  name. The approved-entry trigger's BEFORE UPDATE arm therefore also judges
  every transition INTO `awaiting_countersign`: legal only FROM
  `pending`/`change` and only under an ACTIVE chain (the presence read under
  `phase6_try_readiness`, as (i) below), and a DEFERRED pairing requires at
  commit that the decision's HEAD revision is the provisional approval this
  transition recorded — `finalized = false`, `approvedFrom` equal to the
  status the transition left, citing a COMPLETED `decisions.approve` receipt
  naming this decision (the correspondence is to the transition's receipt,
  never an `xmin` test — the 20271115 header's round-28 lesson), and
  UNDISPOSED: named by no `countersign_rejection` `ChangeRequest` and no
  `DecisionStrandedResolution`, both of which record the exact `revisionId`
  they disposed of (the rejection request therefore carries `revisionId` —
  NOT NULL for `countersign_rejection`, NULL for standard rows, CHECK-pinned,
  frozen with the rest of its evidence — so a rejected or returned head can
  never be re-entered by a bare status flip, while the real re-approval
  appends a FRESH head that passes). Hostile-probed (P31): the bare
  transition with no revision, refused at commit; the re-entry of a rejected
  or returned decision onto its disposed head, refused; the transition under
  an INACTIVE chain, refused; the legal approve, accepted. **And the pairing is sealed from the countersign side too,
  making the act ATOMIC** (round 3): pairing only the flip leaves the SPLIT
  act representable — hostile SQL inserts the countersign row and flips the
  revision finalized while the decision stays `awaiting_countersign`, and a
  LATER direct status update leans on that pre-existing row, reaching
  `approved` without the countersign command's atomic status change, event
  and push. A DEFERRED reverse seal therefore refuses a `DecisionCountersign`
  INSERT unless the SAME transaction carries BOTH the finalized flip on that
  exact revision AND the decision's `awaiting_countersign → approved`
  transition — row, flip and status are ONE transaction or none. The orphan
  countersign row (no same-tx flip, no same-tx transition) and the split
  two-transaction replay are both hostile-probed (P31). **And the
  countersigner must BE an architect** (round 4): the pairing seals judge
  row, flip and transition but not WHO — a hostile same-transaction bundle
  attributed to any user would pass them all, and the register would treat a
  non-architect's row as the countersign fact. The countersign INSERT seal
  validates `countersignedById` holds ACTIVE `architect` standing on the
  project at the act (the standing read under the same protocol; the service
  command already enforces authority — this is the hostile-path backstop),
  hostile-probed with a non-architect and a removed-architect attribution
  (P31). **The transition EMITS its own truth** (round 3) — and, review round
  21, THE SEAL EMITS IT: the database admits an authorized hand-run bundle
  (a `decisions.approve` receipt reserved and completed by hand, the paired
  provisional revision, the `pending → awaiting_countersign` write) through
  the same ledger boundary the plan treats as a valid alternate writer, and
  a service-path emission would leave that committed state with no event,
  no socket invalidation, no push and no `decisions.inbox` fold. So for
  EVERY transition 4d seals — the awaiting entry, the forward door, the
  finality flip (countersign or `completed` stranded resolution, choosing
  `decision.approved`/`reapproved` by the revision's recorded
  `approvedFrom`), the `returned` stranded resolution and the countersign
  rejection (`decision.change_requested` from the P33b request pairing) —
  the EVENT IS WRITTEN BY THE SEAL that admits the transition, through the
  kernel's `platform_emit_event` at the deferred pairing check, with the
  envelope actor read from the transition's own paired fact
  (`approvedById`, `forwardedById`, `countersignedById`, `resolvedById`,
  `requestedById` — decisions-owned rows) TOGETHER WITH THE ACTION-TIME
  ROLE AND NAME THE SAME FACT FREEZES (review round 25: no paired fact
  carried a role, `ChangeRequest` and `CommandExecution` carry only an id,
  and a forwarder renamed or re-roled before the handler runs would leave
  the derived notification with current or NULL metadata for a historical
  act — so every 4d fact freezes `<act>ByRole` and `<act>ByName` at the
  act, written by the command from the actor's token and hand-run writers
  alike, immutable with the row: `DecisionForward.forwardedByRole/Name`,
  `DecisionCountersign.countersignedByRole` beside its frozen name,
  `DecisionStrandedResolution.resolvedByRole` beside its frozen name,
  `DecisionApprovalRevision.approvedByRole` beside `approvedByName` (both
  nullable for pre-4d rows, CHECK-required from 4d-ii), and the
  countersign-rejection `ChangeRequest.requestedByRole/Name`
  (CHECK-required exactly when `origin = 'countersign_rejection'`), each
  under the fact's freeze; the seal passes the id and role as the twin's
  `actorId`/`actorRole` and the frozen name in the payload as `actorName`,
  and `decisions.effects` builds every derived notification from the
  payload, never from the current membership — a rename and a re-role
  between the act and the handler are probed and the notification carries
  the act-time values) passed as the twin's `actorId`/`actorRole`
  arguments (review round 24 — the human mode of §A.2's twin, never its
  system default) and the catalog's dispatch intent; the service emits NONE of these — nor, from review round 26, the no-chain approve — itself (one emitter, the
  SQL-twin tripwire proving byte-identical rows) — and, review round 22,
  the two DERIVED durable writes each transition owes follow the same
  rule, because a hand-run countersign or `completed` bundle that now
  emits its event, push, invalidation and fold would otherwise leave the
  audit register and the snapshot feed disagreeing with the approved
  decision: the `DecisionEvent` audit row (`forwarded`, the awaiting
  entry's provisional `approved`/`reapproved`, `countersigned`,
  `stranded_resolved`, the rejection's `change_requested`) is WRITTEN BY
  THE SAME SEAL in the same statement as the event — a decisions-owned
  trigger over a decisions-owned register, the actor read from the paired
  fact — so the register is exactly as complete for a hand-run bundle as
  for the service path; and the `Notification` feed rows — the
  provisional "awaiting the architect's countersign" on the awaiting
  entry, the green approved on the finality flip built from the revision's
  frozen `approvedByName` (round 9), the forward and rejection notices —
  are DERIVED by the decisions-owned ordered consumer `decisions.effects`
  (the consumer §A.2 introduced for the re-notification, named for
  everything it now owns) from the seal-emitted events, idempotent per
  (event, recipient), written through the kernel's notification helper
  inside the handler transaction, so the feed agrees with the decision for
  every writer; the service writes neither for a 4d transition nor, from
  review round 26, for the no-chain approve (its 4b in-transaction
  notification withdrawn with its in-service emission, the derived row
  byte-identical), `decisions.inbox` folds
  them and the push families claim them exactly as before, and a
  legacy/shadow-mode process picks a seal-emitted delivery up through the
  relay's recovery pass rather than the immediate dispatcher — the same
  path `membership.standing_changed` takes. **And 4d-ii is a CATALOG
  CHANGE, staged as one** (review round 24): its new push families and
  widened targeted entries change the sealed external-effect coverage
  hash, and the delivered `OutboxBootstrap` REFUSES to start in
  `OUTBOX_SENDER_MODE=outbox` while the persisted seal differs from the
  compiled catalog, so a production already in outbox mode cannot bring
  4d-ii up by a plain redeploy. 4d-ii's staging therefore follows
  `docs/RUNBOOK.md`'s catalog-change sequence, written into the packet as
  steps: drain the old fleet to zero instances → deploy 4d-ii in
  legacy/shadow sender mode (no seal required; the in-request dispatcher
  the sole sender) → rebuild projections → `outbox:status` clean (`dead:
  0`, `blocked: 0`) → `outbox:seal-external` recording the NEW coverage →
  restart in outbox mode, the startup validating the seal — BEFORE 4d-iii;
  P38 gains the probe: the 4d-ii build refused in outbox mode under the
  4d-i seal, served in shadow, resealed, then booting in outbox mode. The no-chain
  `pending`/`change → approved` transition JOINS the seal-emitted set in
  4d-ii (review round 26: P31b/P37 admit a receipt-backed direct bundle
  under an inactive chain, and a service-only emission would let that
  bundle update the canonical row without advancing `ProjectEventStream`,
  so a caught-up `decisions.inbox` generation kept serving the stale
  pending/change DTO and the wrong work gate) — the lifecycle seal emits
  `decision.approved`/`reapproved` through the twin with the revision's
  frozen actor, and 4d-ii REMOVES 4b's in-service emission and its
  in-transaction notification for that transition in the same unit (one
  emitter; the SQL-twin tripwire proves the rows byte-identical, so the
  cleared 4b surface's OUTPUT is unchanged and the feed row is derived by
  `decisions.effects` like every other), P37's inactive-chain direct
  bundle asserting the event emitted, the stream advanced and the
  `decisions.inbox` fold applied. P31/P34/P33 gain the hand-run-bundle arm: the bundle
  committed by direct SQL → the event emitted, the tab refreshed, the push
  claimed, the fold applied.
  `decision.awaiting_countersign` joins the catalog (`invalidate: true`,
  targeted push at the ARCHITECT, `pushFamily: 'countersign'` whose claim
  predicate re-checks `awaiting_countersign` AND an active architect — 4c's
  per-family mechanism, one more family); the countersign emits the real
  finalizing event — and **which one is a fact the provisional approval
  RECORDED, not a guess the finalizer makes** (this plan's review round 1):
  the delivered `approve` emits `decision.reapproved` when it acts from
  `change` and `decision.approved` from `pending` (`prior === 'change'`,
  `decisions.service.ts`), and consumers distinguish the two. Under a chain
  that act is provisional and its finalizer runs later, so
  `DecisionApprovalRevision` gains an immutable `approvedFrom: 'pending' |
  'change'` — and, review round 9, an immutable `approvedByName`, the
  approval-time display name frozen at the act (the register's
  `approvedById` names an account whose name can change between the
  provisional approval and its finalization; a rename between the two acts
  is probed and the green notification carries the name recorded at the
  act) — (CHECK-pinned; written by every approve from 4d-ii; NULL only on
  pre-4d legacy rows, which are finalized and will never be finalized again,
  and REQUIRED — the birth seal's arm — on any revision born `finalized =
  false`), and the countersign, or the stranded `'completed'` resolution,
  emits `decision.reapproved` when `approvedFrom = 'change'` and
  `decision.approved` otherwise. The audit register keeps its shape: the
  provisional approve still appends its `approved`/`reapproved`
  `DecisionEvent` (the act happened and is attributable), and the finalizer
  appends — from review round 22, BY THE SEAL that admits the flip — a
  `countersigned` (or `stranded_resolved`) `DecisionEvent`; the 4c cycle
  count reads revisions, not events, and is untouched. **And the
  durable `Notification` tells the truth about finality** (review round 7):
  the delivered `approve` writes the green "X approved …" notification
  UNCONDITIONALLY in its transaction (`decisions.service.ts`), so an
  approval that now lands `awaiting_countersign` would announce an approval
  to every snapshot reader before any architect acted. Under an ACTIVE chain
  the provisional approve YIELDS a PROVISIONAL notification instead — "X
  approved … — awaiting the architect's countersign", the awaiting colour,
  never green — and the finality flip yields the green approved
  notification (both DERIVED, from review round 22, by the
  `decisions.effects` consumer from the seal-emitted events, never written
  by the command or the finalizer, so a hand-run bundle's feed row is the
  same row the service path produces),
  **built from the provisional revision's FROZEN approver facts** (review
  round 8): the text names the APPROVER exactly as today's does — the revision's
  FROZEN `approvedByName` (review round 9: the delivered register stores
  `approvedById` and `onBehalfOf` but no name, so resolving the id at
  finalization would attribute the historical act to whatever the account
  is called THEN; the revision therefore freezes the approval-time display
  name exactly as `DecisionEvent.actorName` freezes it, NOT NULL on every
  revision born from 4d-ii and NULL only on legacy rows, immutable with the
  rest of the register, and the finalizer reads that column and never the
  account), or "Client" for a client decider, with the `onBehalfOf` phrasing
  when a PMC recorded the client's consent —
  and carries the finalization as a DISTINCT attribution ("— countersigned
  by <architect>", or "— finalized by <PMC> with no active architect" for
  `completed`), never claiming the finalizer approved the option; a
  rejection or `returned` resolution writes the change-request notification
  the existing path produces; with no chain the approve's notification is
  byte-identical to today's. P31 probes the notification feed beside the
  domain event: after the provisional approve the feed carries the
  provisional text and no green approval; after the countersign, the green
  one naming the original approver and the countersigner separately. The
  reopened-then-countersigned probe asserts the `reapproved` emission (P31);
  the re-seal chain is 4a's (P31). The countersign is a
  second, separately-attributed register act referencing the exact revision;
  a SELF-countersign (architect is also the decider) is TWO explicit acts
  under two idempotency keys (P32). `pending` stays unreachable after any
  approval act, so 4a's eligibility proof survives 4d intact.
- **EVERY entry into `approved` is DB-SEALED behind the chain** (round-5
  obligation 1; widened `6a53aae` round 1; serialized and made precise round
  2): sealing only the `awaiting_countersign → approved` edge leaves the
  direct road open — hostile SQL under an ACTIVE chain could mark the head
  revision finalized and move `pending`/`change` straight to `approved`,
  never traversing the awaiting state. The BEFORE UPDATE trigger therefore
  judges ANY transition INTO `approved`, with THREE precisions: **(i) the
  presence read SERIALIZES — by TRY-ACQUIRE, never by waiting in a trigger**
  (round 3, and now a DELIVERED primitive rather than a design: the seal
  calls `phase6_try_readiness(projectId)` exactly as 4c's request and
  response seals do): on the SERVICE path the command already holds the
  readiness key from `lockProjectReadiness` — advisory locks are reentrant,
  the try-acquire succeeds; on a DIRECT write with the key free it acquires
  and HOLDS to commit, making the presence read exclusive (a service command
  starting meanwhile blocks at its FIRST statement, the one sanctioned wait
  point, holding no other locks); on a DIRECT write with the key CONTENDED
  it REFUSES the write outright — a seal refuses, it never waits inside a
  trigger, so no lock-order inversion exists (a row-level `FOR UPDATE` on
  architect memberships cannot serialize a FIRST activation — the classic
  phantom — and a trigger that BLOCKS on the advisory key inverts the
  service's lock order into a deadlock). The same protocol binds the
  `Membership` writes that can flip holder-relevant standing (activation,
  removal/restore — hard DELETE included — and role change) and every
  seal-trigger cross-table standing read; for the `architect` role those
  writes are, from 4d-i, held to COMMAND PROVENANCE ON THE ROW ITSELF —
  the orgs-owned `Membership_t4d_architect_provenance` seal requires every
  write whose OLD or NEW role is `architect` to be paired with an immutable
  `MembershipTransition` fact citing a reserved orgs membership command
  that completes naming that row (review rounds 17 and 19, the
  re-notification paragraph below — round 14's `SET LOCAL` gate, round
  16's cross-module correspondence seal and round 17's rewritable column
  are all withdrawn), so the
  direct-writer probes for that role assert REFUSAL AT COMMIT, not
  serialization. **And the membership seal judges
  CONTENT, not only timing** (round 5): the delivered
  `phase6_t4b2_membership_guard` already re-judges the holder-orphaning
  predicate at the DB for `pending`/`change` decisions (P39's DB arm); 4d-i
  EXTENDS its open set with `awaiting_countersign` for the NAMED holder and
  the ROLE designations it guards today — and deliberately does NOT add the
  architect role to it: the last architect leaving is the chain
  DEACTIVATING, resolved by the named command above, never a refused
  removal. **The two rules meet in ONE row, and the exception is named**
  (review round 7): P32 lets an architect be the named decider, so the sole
  architect A can be BOTH the last architect and the named holder of a
  decision A approved into `awaiting_countersign`; the widened guard would
  then refuse A's removal (the awaiting decision names A) while the chain
  promise says it is never refused — a PMC who could neither remove A nor
  reach the stranded resolution. The guard's awaiting arm therefore EXEMPTS
  exactly this case: removing a named holder of an awaiting decision is NOT
  refused when that member is the project's LAST active architect — and,
  review round 13, the SAME exemption covers the architect ROLE designation:
  an `awaiting_countersign` decision designated to the architect role names
  the last architect as the last active member of its holder role, and the
  round-10 designation fan-out stated the extension in §A.1 while P39 and
  this paragraph still spoke of the named holder only, a contradiction an
  implementation could resolve by refusing (the PMC then unable to reach the
  stranded resolution). Both shapes — named holder AND role designation —
  are exempt for exactly the last active architect and no one else; the
  removal proceeds, the chain deactivates, the countersign deliveries are
  cancelled, and the decision stays `awaiting_countersign` with a DEPARTED
  holder whose only exits are the stranded resolution's two outcomes:
  `completed` finalizes (the approval act stands as history); `returned` for
  a departed holder REQUIRES a same-command `toDesignation` and re-homes
  atomically — the resolution bundle carries a `DecisionForward` row from the
  departed holder to the named ACTIVE target, actor the resolving PMC,
  reason the resolution's, so the decision lands in `change` with an active
  holder and never trips the `pending`/`change` orphan guard; a `returned`
  without a target for a departed holder is 400; the bundle-aware provenance
  binds the third fact to the same receipt. A named holder who is an
  architect but NOT the last one stays refused, the 409 naming the pending
  countersign (another architect must countersign or reject first — the
  approval act is awaiting finality, and the holder's departure waits on
  that act). Probed (P39, P29b): the sole-architect-holder removal
  succeeds and deactivates the chain; `completed` then approves; `returned`
  with a target re-homes into `change` with the forward fact; `returned`
  without one is refused; the non-last architect-holder removal is refused
  naming the countersign. The hostile direct soft-removal AND the hostile role-change of an
  awaiting decision's holder are probed (P39). All four pairings are
  deterministic — service/service serializes on the blocking lock (P36
  unchanged), service/hostile and hostile/hostile resolve by
  try-acquire-or-refuse — probed in both orderings beside the service-path
  P36 races. **(ii) with the chain ACTIVE**, the legal entries are: FROM
  `awaiting_countersign` WITH the SAME-transaction `DecisionCountersign` row
  finalizing the head revision (the attributed fact, not the boolean —
  same-transaction, because the countersign act is atomic per its reverse
  seal; a prior-transaction row is exactly the split act that seal forbids);
  or FROM `change` as the standard `withdrawChange` RESTORATION — the open
  request is `origin = 'standard'` AND the head revision is ALREADY
  `finalized = true` from its original countersign (the ordinary correction
  path this seal must not strand); `pending → approved` and any `change →
  approved` on an unfinalized head or a `countersign_rejection` request are
  refused outright. **(iii) with the chain INACTIVE, the direct road is
  NARROW** (narrowed round 3): direct approval stays legal only FROM
  `pending` or `change` — the approvals born under no chain, today's
  behavior byte-identical. An `awaiting_countersign` decision was born under
  a chain, so its exit DEMANDS paired evidence even after the last architect
  leaves: the same-tx `DecisionCountersign` row, or the same-tx
  `DecisionStrandedResolution` row with outcome `'completed'` (the PMC
  command's fact) — a bare hostile `awaiting_countersign → approved` flip
  under an inactive chain is refused, closing the stranded bypass that would
  end a countersign-required approval with no resolution evidence. Probed:
  the direct `pending → approved` hostile flip under an active chain, the
  finalized-boolean-only flip, the stale awaiting-flip without the
  countersign row, the bare awaiting-flip under an INACTIVE chain (refused
  without the resolution fact), the standard restoration PASSING, the
  rejection-request restoration REFUSED, and the activation-vs-approval
  barrier (P37).
- **The finality key, stated exactly** (round-5 obligation 6): the existing
  Phase-3/4 provenance rows (`MaterialRequirementSpec`,
  `LabourRequirementSpec`) FK onto the register's candidate key `(projectId,
  decisionId, version, optionKey)` (`DecisionApprovalRevision_provenance_target_key`,
  delivered). The finality pin therefore WIDENS that key: the register gains
  `@@unique([projectId, decisionId, version, optionKey, finalized])`, each
  provenance row gains an immutable `revisionFinalized` column CHECK-pinned
  `true`, and the composite FK re-targets the widened key — the
  `PurchaseOrder.comparisonStatus` precedent verbatim (Phase 3 F4), so
  provenance naming an unfinalized revision is UNREPRESENTABLE and a
  `finalized → false` flip on a referenced row is refused by the FK itself.
  The migration is additive and backfills `finalized = true` on every
  existing row (every pre-4d approval is final by definition — today's
  behavior) and `revisionFinalized = true` on every existing spec row; from
  4d-ii the two spec WRITERS state the pin explicitly from the widened
  `approvedRef` (review round 11 — §A.3 names the change and P42 probes
  the post-4d-iii write). **The
  column DEFAULTS (`true`) are KEPT through the drain** (this plan's review
  round 1, correcting a draft that dropped them in 4d-i): 4d-i deploys while
  previous-release instances still serve, and those instances insert
  `DecisionApprovalRevision`, `MaterialRequirementSpec` and
  `LabourRequirementSpec` rows that name neither column — a required column
  with no default would fail every ordinary approval and requirement write
  an old instance performs, the one thing a dark migration must never do.
  Born-`true` under the default is CORRECT for the whole pre-drain window,
  because the reservation keeps every chain inactive (the birth seal admits
  it under an inactive chain, §A.2). 4d-iii — after the drain, when only
  writers that state the pin explicitly remain — drops the two defaults, so
  from then on a provenance row must state its pin. Hostile
  probes: provenance onto an unfinalized revision; the finalized→false flip
  under reference (P42, with P31's lifecycle).
- **Disagreement — the `change` state's OWN machinery honored** (round 2):
  BOTH disagreement outcomes land in `change` AND create the open
  `ChangeRequest` in the same transaction, requested by the architect with
  the disagreement reason. **The request carries its ORIGIN, and the
  ordinary escape hatch is closed for it** (round 3): `ChangeRequest` gains an
  immutable `origin: 'standard' | 'countersign_rejection'` (additive, default
  `'standard'`, backfilled) — the existing `withdrawChange` (the service's
  `change → approved` restoration) would on a disagreement request complete
  an approval WITHOUT its countersign, so `withdrawChange` refuses
  `countersign_rejection` requests with a 409 naming re-approval as the only
  way forward (P33). **And the affordance follows the refusal** (review
  round 2): the delivered serializer (`decision-serialize.ts`) carries the
  open request's reason, impacts and requester but NOT its origin, and
  `DecisionLogScreen.tsx`'s `mayWithdraw` offers Withdraw to every PMC and
  to the request's author — so without more, the architect who rejected and
  every PMC would be offered an action that deterministically 409s. 4d-ii
  serializes the immutable `origin` in the shared DTO on the live, projected
  and rebuilt paths alike — PRESENT ONLY WHEN NON-`standard` (review round
  19: a `standard` origin is OMITTED and absence hydrates as `'standard'`,
  the `countersignRequired` precedent, so an ordinary request's wire shape
  is byte-identical to today's and P29's literal identity holds; a pre-4d
  stored DTO with no origin reads as `'standard'`, which is exactly true of
  every pre-4d request), and
  `mayWithdraw` suppresses the affordance for `countersign_rejection`;
  P33's web arm asserts no Withdraw renders for a rejection request while
  the service still refuses the direct call. **The request's EVIDENCE freezes with its origin — and
  with its DECISION** (round 4; `decisionId` round 2; `origin` round 4): the
  delivered `ChangeRequest_t4b2_seal` / `phase6_t4b2_change_request_seal`
  freeze is EXTENDED to cover `origin`, `decisionId`, `revisionId` (review
  round 4), `reason`, `costImpact`,
  `timeImpactDays` and `requestedById` for EVERY `ChangeRequest` row (the
  class, not the instance), with the close transitions as the only permitted
  mutations. `origin` is in the list because it is the GUARD `withdrawChange`
  trusts — a hostile re-label of an open `countersign_rejection` request to
  `'standard'` would reopen the closed escape and restore `change →
  approved` without a countersign; and an open request re-pointed at another
  decision would strip the change-state decision of the one open request its
  machinery requires while attaching the reason to the wrong register entry.
  The re-point AND the origin re-label are probed hostile (P33). The
  disagreement command accepts the impacts as OPTIONAL inputs defaulting to
  0 (round 3). The two paths: **REJECT BACK** keeps the original decider as
  holder — they re-approve and the chain runs again; **FORWARD ON** re-points
  the holder to the decider the architect names (validated active) — through
  the SAME forward door and with the SAME `DecisionForward` fact as the
  generic command (this plan: the disagreement's forward is not a second
  holder-mutation path; it is the one door, taken from `awaiting_countersign`
  in the same transaction that lands `change`, which is why the door's
  status predicate admits `awaiting_countersign → change` ONLY when the
  transaction also carries the `countersign_rejection` request — the
  `6a53aae` "excluded from the generic command" rule stated at the DB) — the
  new holder finds an actionable change-state decision, re-approves, and the
  chain runs again. Neither path returns to `pending`; neither erases the
  approval act it answers; and approve-from-`change` under an ACTIVE chain
  lands `awaiting_countersign` exactly like approve-from-`pending`. Probed
  end to end (P33).

### 3. The uniform seal contract — every 4b–4d fact table

Four review rounds of the starting material each surfaced instances of ONE
generative rule; the rule is therefore the contract, and the table below is
its CLOSED enumeration over every fact these units add. 4c delivered a SIXTH
obligation this plan adds to the contract, because every 4c fact carries it
and the reviewer of 4c-ii (F1) required it of the approval register too.
Each fact table carries SIX DB obligations beside its zod contract and
service authority:

1. **Append-only + evidence freeze** — UPDATE/DELETE sealed at the row AND
   `TRUNCATE` sealed at the statement (both named; 4c's completeness rule —
   a row trigger never fires for TRUNCATE); every evidence AND discriminator
   column immutable (`origin`, kinds, designations, `outcome` included), with
   the named close-transitions as the only permitted mutations.
2. **Transition pairing, BOTH directions** — where the fact records a state
   transition, the row commits only with its same-transaction transition and
   the transition only with its row (deferred constraint triggers — the
   forward-door discipline).
3. **Actor standing** — the recorded actor must hold ACTIVE standing that
   authorizes the act, judged at the DB under `phase6_try_readiness` (the
   service command stays the authority; the seal is the hostile-path
   backstop).
4. **Subject eligibility** — the decision must be in exactly the states the
   act is legal in: the SAME predicate as the command CAS, re-judged by the
   seal — AND the project operable via `phase6_project_operable`, lock
   before read, the 4c §A order.
5. **Same-project composite FKs** — every reference project-bound through
   the child's own `projectId`.
6. **Command provenance** (4c, delivered) — `NOT NULL sourceCommandId` with
   the project-contained composite FK to `CommandExecution`, the one-use
   `(projectId, sourceCommandId)` UNIQUE, and the deferred result-binding
   constraint trigger tying the row to the reserved command's RESULT and
   the receipt's `actorId` to the row's recorded actor. **Extended for
   BUNDLES** (this plan's review round 1): the delivered
   `phase6_t4c_provenance_bound` requires the receipt's `resultRef` to name
   the row itself, which a command writing ONE fact satisfies and a command
   writing a bundle (forward-on: request + forward; the stranded return:
   resolution + request) cannot, since one receipt names one result. The
   4d-owned `phase6_t4d_provenance_bound` therefore accepts a `resultRef`
   naming the row OR naming the bundle's PRIMARY fact when the same
   transaction pairs them and both cite the SAME receipt — the primary is
   the reject-back/forward-on REQUEST for `decisions.disagree` and the
   RESOLUTION row for `resolveStrandedCountersign`; the per-table one-use
   UNIQUE still holds (one receipt, at most one row per table), and the
   pairing seals already bind the secondary to its primary. `ChangeRequest`
   joins the contract — and it carries no `projectId` today, only
   `decisionId`, so the project-contained composite FK needs its key first
   (review round 3): 4d-i adds `projectId`, backfilled from each row's
   decision and, for every later INSERT, filled by a BEFORE INSERT trigger
   that copies it from the row's decision when the writer omits it (a BEFORE
   trigger runs before constraint checks, so the column is `NOT NULL` from
   the start while the previous release's `requestChange`, which never names
   it, keeps working during the drain — the old-write-shape probe of P42
   extends to `ChangeRequest`), bound by a composite FK `(projectId,
   decisionId)` to the delivered `Decision(projectId, id)` candidate key so a
   copied or hostile project can never disagree with the decision's; THEN the
   nullable `sourceCommandId` with its `(projectId, sourceCommandId)`
   composite FK to `CommandExecution` + the partial one-use UNIQUE, which the
   P33b seal REQUIRES for every `countersign_rejection` row — the reject-back
   path was otherwise forgeable by an active architect with direct SQL and
   every other seal green. **Both new columns join the class-wide freeze**
   (review round 3): `projectId` and `sourceCommandId` enter the
   `phase6_t4b2_change_request_seal` identity/evidence comparison, so a later
   UPDATE can neither NULL nor replace the receipt a request has already
   justified a transition with (an INSERT-time provenance trigger alone
   leaves that path open); the NULLing and the replacing hostile UPDATEs
   are probed (P33). A `'standard'` request written by 4d-ii's
   `requestChange` carries `sourceCommandId` too — **and its receipt must
   BIND** (review round 4): the delivered `requestChange` returns `resultRef:
   decisionId` (`decisions.service.ts`), which the result-binding trigger
   refuses at commit for EVERY standard request the moment 4d-ii cites the
   receipt, since the receipt must name the fact row (or a bundle's
   primary). 4d-ii therefore changes the `decisions.requestChange` receipt to
   name the created `ChangeRequest.id` — the uniform rule, a command that
   writes a fact names THAT fact; `resultRef` is receipt evidence, never the
   command's response (the response is the rebuilt snapshot, unchanged), so
   no client observes the change, and a legacy receipt naming the decision
   binds nothing because legacy rows carry NULL. Probed (P33): a standard
   request citing a receipt whose `resultRef` names the decision, refused at
   commit; naming the request row, accepted; the keyed replay appends
   nothing — and a NULL stays
   admissible on standard rows ONLY during the drain, for the legacy rows and
   the previous release's writer: **4d-iii installs the trailing INSERT-time
   seal** (review round 3) requiring a non-NULL `sourceCommandId` on EVERY new
   `ChangeRequest` row whatever its origin — historical NULL rows untouched,
   since the seal judges INSERTs and the freeze already forbids rewriting them
   — so after rollout a direct transaction can no longer move a decision to
   `change` and file a receipt-less request; the NULL-provenance standard
   insert refused and the legacy NULL rows surviving are probed in 4d-iii.

| fact | pairing (2) | actor standing (3) | subject eligibility (4) | provenance (6) | probes |
|---|---|---|---|---|---|
| `Decision` holder columns (4b) | the forward door, from 4d | named decider membership ACTIVE at create/holder-write | the kind⟺status CHECKs; the delivered orphan guard, open set widened to `awaiting_countersign` | — (the decision row's own commands are ledgered) | P17/P18/P39 |
| `DecisionConsultation` (4c) | — (records no transition) | `requestedById` ACTIVE pmc **+ architect (4d)**; consultee ACTIVE at insert | open (`pending`/`change` **+ `awaiting_countersign` (4d)**) AND published | delivered | P25/P27 |
| `DecisionConsultationResponse` (4c) | — (UNIQUE per consultation) | responder is the named consultee | the same predicate re-judged at response, cycle-frozen | delivered | P23/P25/P27 |
| `DecisionForward` (4d) | holder mutation ⟷ row | `forwardedById` = holder-user / pmc / architect, ACTIVE | `pending`/`change` only; `awaiting_countersign` ONLY with the same-tx `countersign_rejection` request | required | P34 |
| `DecisionCountersign` (4d) | finality flip + `awaiting → approved` ⟷ row | `countersignedById` ACTIVE architect | `awaiting_countersign` only | required | P31 |
| `DecisionStrandedResolution` (4d) | outcome BUNDLE ⟷ row (`completed`: flip + →`approved`; `returned`: →`change` + the open `countersign_rejection` request) | `resolvedById` pmc; non-blank reason | `awaiting_countersign` AND no active architect | required | P29b |
| `DecisionApprovalRevision` finality (4d) | birth value by chain presence; flip only by paired fact | carried by the pairing facts | the §A.2 approved-entry seal | delivered (4c) | P31/P37/P42 |
| `ChangeRequest` origin (4d) | `countersign_rejection` ⟷ the exact `awaiting_countersign → change` transition, AND with its producer's fact: no stranded row (the architect's disagreement) or the same-tx `DecisionStrandedResolution(outcome='returned')` (the PMC's return) (P33b) | `requestedById` ACTIVE architect under an ACTIVE chain; ACTIVE pmc authority (= the resolution's `resolvedById`) when paired with the stranded return | the awaiting subject | REQUIRED for `countersign_rejection` (primary for reject-back/forward-on; secondary to the resolution for the return); admissible NULL on `'standard'` rows only | P29b/P33/P33b |

A future fact table added under these units inherits this contract by
default: omitting an obligation is a defect by construction, not a
discovery, and each unit's review packet walks this table for every fact it
ships.

The unit writes only decisions-owned TABLES and the two ADDITIVE columns on
foreign provenance rows (`revisionFinalized` on the two spec tables — the
`comparisonStatus` precedent, an obligation the provenance target imposes on
its referrers) — its foreign CODE changes are the readiness lock joining the orgs
role mutations (an edit the orgs module makes to its own commands) and,
review round 11, the two provenance WRITERS learning to state the pin: the
delivered `decisions.approvedRef` returns exactly `decisionId`,
`decisionVersion` and `optionKey`, and `RequirementsService` spreads that
result verbatim into the material spec insert and into
`LabourRequirementParticipant.writeRequirementSpec`, so once 4d-iii drops
the `revisionFinalized` default every provenance-bearing requirement
create or revise would fail on the required column. 4d-ii therefore
widens the decisions-owned query — `approvedRef` returns the head
revision's `finalized` as `revisionFinalized` beside the three fields and
REFUSES an unfinalized head outright (its status arm already refuses
`awaiting_countersign`; the finality arm is stated so the writer never
depends on the status alone) — and EVERY spec writer states it explicitly:
the create/revise writers from the widened `approvedRef`, and (review round
12) the two CANCELLATION copies too — `RequirementsService.cancel` copies
the head's `MaterialRequirementSpec` column by column and
`LabourRequirementParticipant.copyRequirementSpecForCancel` copies the
`LabourRequirementSpec` (and its slices) the same way, each naming only the
three provenance columns, so after the drop a cancel would abort at the spec
insert though create and revise succeeded; both copies carry
`revisionFinalized` forward from the head row VERBATIM (a copy of a pinned
provenance is the same pin — the head is finalized or it could never have
been written), and a 4d-ii WRITER SWEEP enumerates every INSERT site on the
two spec tables (create, revise, cancel; material and labour) and asserts
each states the column, the tripwire against a later writer omitting it —
each an edit the owning module (activities; labour through its participant)
makes to its own code; P42 probes a current-version provenance write
SUCCEEDING for a material AND a labour requirement after 4d-iii through the
shipped writers — create, revise AND cancel — RED at base where the
three-field spread fails on the required column, beside the old shape failing
— and the one foreign fact it needs is DECLARED: membership truth is
orgs-owned, routed through the named participant API and the orgs-owned SQL
primitives from 4b/4c on (the P5 layering lesson of
`pr-324-convergence.md`, applied up front).

## §B — The carried §D obligations, elaborated (P31b/P42b, P31c/P34b, P33b)

The merged 4b plan's §D reserved these probe numbers to this unit and bound
each carried question to its probe. The full rows:

4. **P31b/P42b — every register INSERT pairs with its approval act.** EVERY
   `DecisionApprovalRevision` INSERT pairs with its same-transaction approval
   act and authorized decider, under an ACTIVE chain AND an INACTIVE one.
   PROVES: a revision born `finalized = true` with no approval transition on a
   still-`pending` decision is unrepresentable, so the widened finality FK
   can never let provenance trust an approval that never happened. HOW: 4c
   already binds every revision to a COMPLETED `decisions.approve` receipt
   naming this decision (`DecisionApprovalRevision_t4c_provenance`), which is
   the "approval act" half; 4d-i's BEFORE INSERT birth seal (§A.2) adds the
   chain half and a DEFERRED pairing that the same transaction carries the
   decision's approval transition (`pending`/`change` → `approved` under no
   chain, → `awaiting_countersign` under a chain) whose recorded actor holds
   decider standing for the decision's CURRENT holder designation — and the
   REVERSE (review round 4): every transition INTO `awaiting_countersign`
   carries its same-transaction provisional revision, undisposed, or is
   refused at commit (§A.2), so a bare status flip cannot manufacture a
   countersign demand with no head to finalize. RED SITE:
   the hostile insert of a `finalized = true` revision with a forged receipt
   into a `pending` decision — under the active chain (born-true refused by
   the birth seal) AND under the inactive chain (no same-tx transition,
   refused at commit). STAGING: 4d-i, seal-stripped run (§C).
5. **P31c/P34b — exactly one matching fact per paired transition.** Two
   matching `DecisionForward` rows over ONE holder mutation, and two
   `DecisionCountersign` rows over ONE finality flip, are both refused.
   PROVES: the pairing is one-to-one, not one-to-many — a duplicate
   evidence row would let a second actor claim the same act. HOW: the
   forward reverse seal counts the same-transaction forward rows for the
   decision and refuses > 1 (the holder door already requires the ONE row to
   match field-for-field); `DecisionCountersign` carries UNIQUE
   `(projectId, decisionId, revisionId)` so the duplicate is unrepresentable
   at the index, AND the reverse seal refuses a second row in the same
   transaction so the UNIQUE is not the only thing standing; AND — review
   round 25 — the APPROVAL REGISTER: P31b pairs every
   `DecisionApprovalRevision` with an approval transition, but a direct
   transaction could reserve two valid `decisions.approve` receipts under
   different idempotency keys, make ONE `pending → approved` (or `→
   awaiting_countersign`) transition and insert revisions v1 and v2 citing
   the two receipts — the per-receipt one-use indexes and the per-version
   uniqueness both pass and both rows pair to the one transition, inflating
   the cycle count and minting a second finalized provenance target for an
   act that happened once; so the register's deferred pairing seal counts
   the same-transaction `DecisionApprovalRevision` inserts per decision and
   refuses more than ONE, exactly as many as the transaction's approval
   transitions of that decision (the lifecycle door admits one), and the
   birth seal requires the new row's `version` to be the decision's next.
   Absorbed into §A.3's obligation 2 for every future fact. RED SITE: the
   two-row hostile bundles, the two-receipt two-revision bundle. STAGING:
   4d-i.
6. **P33b — the `countersign_rejection` request joins the uniform contract
   as a full row.** Its INSERT pairs bidirectionally with the exact
   `awaiting_countersign → change` transition, validated for its PRODUCER
   and an awaiting subject — a forged disagreement bundle attributed to an
   unrelated user is unrepresentable. HOW (this plan's review round 1, which
   found the first draft admitted only the architect and so made the
   documented PMC return path unusable by construction): a DEFERRED seal on
   `ChangeRequest` INSERT with `origin = 'countersign_rejection'` requires
   the same transaction to carry the subject's `awaiting_countersign →
   change` transition AND exactly one of the two legal producer shapes —
   (a) the ARCHITECT's disagreement: NO same-transaction
   `DecisionStrandedResolution` for the decision, the chain ACTIVE, and
   `requestedById` resolving to ACTIVE `architect` standing under
   `phase6_try_readiness`; or (b) the PMC's stranded RETURN: a
   same-transaction `DecisionStrandedResolution` for the decision with
   outcome `'returned'`, the chain INACTIVE, and `requestedById` EQUAL to
   that row's `resolvedById` holding ACTIVE pmc standing
   (`phase6_user_orchestration_authority`, judged for the pmc arm — the
   decision-authority primitive stays untouched, review round 3) — AND a
   non-NULL `sourceCommandId`
   bound through the bundle rule of §A.3 obligation 6 (the request is the
   primary for (a), the resolution is for (b)). The decision-side lifecycle
   seal requires the transition to carry exactly one such request. The
   ordinary `'standard'` request keeps its delivered pairing untouched. RED
   SITE: the orphan rejection request (no same-tx transition); the request
   attributed to a non-architect under an active chain; a returned-bundle
   request attributed to anyone but the resolving PMC, or to an architect;
   the transition without the request; the rejection request with NO
   `sourceCommandId`, or citing a receipt whose result names neither it nor
   its paired primary. STAGING: 4d-i.

## §C — The probe table (P28–P42, plus the carried arms)

Every probe's RED evidence is anchored to the implementation unit's ACTUAL
BASE COMMIT, not to an in-branch shape commit (the 4c plan's review round 1).
Every arm whose subject EXISTS at base (the approve CAS, the holder freeze,
the consultation carve-out, the decider push family, the `withdrawChange`
restoration, the orphan guard) runs as a base-compatible black-box probe —
HTTP against the guarded surface, SQL against the base-migrated schema —
executed and RECORDED against the real base SHA in the packet before any
contract, column, or enum is added. Arms whose subject is a NEW table,
column, enum value or seal are executed from the implementation base by the
SEAL-STRIPPED MIGRATION RUN (**BOARD DECISION, not re-litigable** —
2026-08-29, on PR #480, carried verbatim from the 4c plan §C): the probe
harness, checked out AT the implementation base, applies 4d-i's migration
TWICE to scratch databases — once with the specific seal statement omitted
(the omission performed BY THE TEST, one named object at a time), where the
hostile insert is ACCEPTED, and once whole, where the same insert is
REJECTED — both runs recorded in the packet with their SQL and outcomes. Red
sites name where today's behavior lives.

| probe | proves | red site / staging |
|---|---|---|
| P28 | the role in every mirror: `TokenRole`, both zod enums, `PushRole`, the `ROLE_POLICY` rows (§A.1's exact set), `decisionsManifest.permissions`, AND the web role pickers/labels (`TeamScreen.tsx`, `RolePicker.tsx`) — the identity walk pins the set; a membership with the new role is mintable through the shipped UI once 4d-iii has dropped the reservation — and NOT OFFERED before it: the role pickers gate `architect` on the shell's `rollout.phase6_4d` read, and `MembersService.add` refuses the role 409 BEFORE provisioning the invited `User` while the reservation stands (a new-email add while reserved → 409 and zero `User` rows; review round 5); the dev-session fallback (`ALLOW_DEV_AUTH`, `AuthService.session`) refuses `architect` while the reservation stands and mints it after 4d-iii — the alternate token producer covered (review round 27); the EXISTING targeted ceilings admit the role — a decision published to an architect holder and a consultation requested from an architect both dispatch (RED at base: `buildDispatchIntent` rejects the out-of-ceiling role and the command aborts), and the catalog tripwire over every targeted entry whose narrowing site persists a member role (review round 3); **P28b (this plan): the RESERVATION** — between 4d-i and 4d-iii a direct `Membership` INSERT or role UPDATE whose NEW row names `architect` is refused at the DB (a removed row already in that role can be neither restored nor re-keyed through it), so no project can arm the chain while a previous-release instance may still serve; after 4d-iii the same statements succeed — the mirror of 4c's reservation probe; AND the AUDIT — 4d-i applied over a database holding ANY `Membership` row with `role = 'architect'` (active OR soft-removed) ABORTS naming the rows and installs nothing, and likewise over ANY `Decision` row with `deciderKind = 'architect'` or `status = 'awaiting_countersign'`, audited under the `Decision` table lock as the diagnostic for rows that PRE-DATE 4d-i — the two TEXT-judged `Decision` doors installed in their own transaction BEFORE the `ADD VALUE` statements, so no window exists in which a concurrent direct writer can store either value unreserved (review rounds 14 and 20; the row aligned with §D's order in review round 23) — both orderings barrier-probed against a direct writer (review round 14); the audit runs AFTER the reservation's `CREATE TRIGGER` in the same transaction, barrier-probed in both orderings on the shipped file (writer-first → the migration waits then aborts on the committed row; migration-first → the writer waits then is refused); the operator repair is a RE-ROLE through the team role command (a soft removal leaves `role` in place and aborts the next deploy identically — asserted), or the guarded operator DELETE, and the same file then deploys (the `upgrade-proof.sh` abort → re-role → redeploy cycle; review rounds 1–2); the REPLAY arm — the P3005 baseline of a post-4d-iii database holding an active architect replays 4d-i as a no-op on its transient block (marker present) and keeps the architect, while a pre-4d-iii baseline (no marker) installs and audits (review round 5) | `types.ts`, `contracts.ts`, `external-effects.ts`, `policy.ts`, the Team screen role lists; the orgs-owned reservation trigger |
| P29 | no-active-architect byte-identity: with no architect membership ever, approve lands `approved` directly with `finalized = true`, forward is refused for the missing role's authority but works for holder/PMC, and the whole 4b/4c surface is byte-identical; **P29c (this plan): mixed-version byte-identity** — with the reservation ARMED (4d-i and 4d-ii deployed, 4d-iii not), every project is chain-off, no row can be `awaiting_countersign`, no membership can be `architect`, no `DecisionForward` row and no `decision.forwarded` delivery can exist (a service forward 409s naming the drain directive, a hostile direct forward insert is refused, no Forward affordance renders — review round 4), no `Decision` row — DRAFT or published — carries `deciderKind = 'architect'` (a service create/updateDraft naming it 409s, a hostile direct draft insert is refused; both succeed after 4d-iii — review round 13), every read a pre-4d instance performs on these tables sees only values its enums know, and — the STALE-CLIENT arm, review round 9 — a browser declaring only `recorded-v1` is refused on approve under an active chain — judged inside the command under the readiness lock, the activation-between-check-and-approve barrier in both orderings (review round 11) — and receives no `awaiting_countersign` row and no architect-designated row, an architect session is refused on the shell read for that client (review round 11), while a `countersign-v1` client sees everything; after 4d-iii all four forward arms open | the chain switch; the reservation on all three doors — membership role, forward row, decision designation |
| P29b | removed-architect deactivation + the stranded decision: the chain deactivates for NEW approvals; `decisions.resolveStrandedCountersign` drives BOTH outcomes (complete-under-no-chain → `approved` with finality + emission; return-to-decider → `change` with the origin-stamped open request), each writing its append-only `DecisionStrandedResolution` fact (UNIQUE per revision; the orphan-fact insert refused by the reverse pairing; a whitespace-only reason — spaces, AND a tab-and-newline-only value — refused at zod AND the CHECK; provenance-bound as the bundle's primary), the RETURNED bundle's request authored by the resolving PMC and ADMITTED by the P33b seal on that pairing (a returned-bundle request attributed to anyone else, or to an architect, refused), the `completed` outcome emitting `decision.reapproved` when the stranded revision's `approvedFrom` is `change`, end-to-end through re-approval; the bare hostile `awaiting_countersign → approved` flip under the INACTIVE chain refused without the fact; the returned-resolution bundle MISSING its `countersign_rejection` request refused at commit; refused while an architect is still active; the architect-reappears race deterministic; the RE-NOTIFICATION (review round 6) — approve → architect A removed (countersign delivery cancelled) → architect B added: exactly one new `decision.awaiting_countersign` delivery per still-awaiting decision, B receives, AND — review round 24 — the HAND-RUN sequence: A removed by a hand-run receipt-backed write while the original countersign delivery is pending and unsent, B activated (by hand or by the service) before that delivery is claimed → the `{ to: 0 }` crossing cancels the original with the mark, the `{ to: 1 }` re-emit raises exactly ONE live delivery, B receives once; the same sequence with the consumer HELD until after B's activation (both crossings pending) → the original marked, one re-emit, never two live demands ; AND — review round 25 — the PUSH-WORKER interleavings: the original claimed and sent to B AFTER the crossing but BEFORE the handler runs → the notice names the crossing's position, the handler skips, B receives ONE; the original sent to A BEFORE A's removal → the notice pre-dates the crossing, the handler re-emits, B receives ONE; the original still pending when the handler runs → skipped, resolved to B at its own send, ONE; the handler and the send contending on the decision row lock in both orderings → ONE — the terminal delivery count asserted per decision, a `countersign_renotified` audit row attributed to the crossing event's system actor and naming the `membershipId` and stream position that identify the immutable `MembershipTransition` (review round 20); an activation with no awaiting decision emits nothing; an activation while another architect is ALREADY active emits nothing and appends no `countersign_renotified` row (review round 7); the projection fold a status no-op; the FRESHNESS arm (review rounds 10, 13, 14, 15, 16 and 17 — the value now a KERNEL read of the platform-owned `ProjectRoleStanding` register the membership trigger maintains from the row it is handed; no signal, no module reading another module's table anywhere, not even at commit) — a `pending` decision projected, the first architect added through the service → the register moves to 1 in the same commit and the very next read of the projected row shows `countersignRequired: true` (present only when true) with no fold delivery in between; the last architect removed → the field absent the same way; A-active/B-added crosses no boundary (register 1 → 2, the field unchanged); register = `phase6_effective_role_standing(project, 'architect')` after EVERY transition shape (insert, activate, soft-remove, restore, re-role in and out, the project cascade); a DIRECT architect INSERT / role UPDATE / soft removal / restore REFUSED without a receipt, refused at commit with a reserved-but-uncompleted receipt, refused with a receipt borrowed from another command type or actor, by the orgs-owned `Membership_t4d_architect_provenance` pairing seal, the immutable `MembershipTransition` fact and its deferred `phase6_t4d_membership_transition_bound` binding (review rounds 17 and 19 — the command ledger as an append-only per-transition fact: not a `SET LOCAL` flag, not a cross-module seal, not a rewritable column), a hard DELETE of an architect row refused outright, and the crossing event emitted by the standing trigger for EVERY writer — a hand-run-receipt insert of architect B after A left still refreshes every tab and B is still re-notified through the `decisions.effects` consumer (review round 19); a direct write to the register refused, the register erased by DELETE or by TRUNCATE refused, `Membership` truncated refused (review rounds 16–17); every OTHER open tab refreshed by the orgs-owned `membership.standing_changed` invalidation on the zero↔one crossing and by nothing on 1 → 2 (review round 18); rebuild == live (the projection stores no such field); the DEPARTED-holder stranded return (review round 7) — `returned` with a target re-homes into `change` with the forward fact in the same bundle, `returned` without one refused | the new resolution command + its fact table + the switch; the `decisions.effects` ordered consumer on `membership.standing_changed` / `project.restored` (review round 19) |
| P30 | forward authority (holder/PMC/architect), ACTIVE target only, eligible states only — terminal AND `awaiting_countersign` refusals both probed through the guarded HTTP route with the shared `ROLE_POLICY` action | the forward command |
| P31 | the `awaiting_countersign` lifecycle: approval under a chain lands it with `finalized = false` — a revision BORN `finalized = true` under an active chain refused by the INSERT seal; the countersign is ONE atomic act — the attributed `DecisionCountersign` ROW + the finality flip + the `awaiting_countersign → approved` transition in one transaction, sealed from BOTH sides (the boolean-only hostile flip refused; the orphan countersign row refused at commit by the deferred reverse seal; the split two-transaction replay refused; the REPLACED append-only seal, review round 10 — a DELETE, and an UPDATE of any column other than the flip, `approvedByName` on a provisional row included, refused, the paired flip accepted, the delivered `_append_only` trigger absent by name after 4d-i) AND attributed to an ACTIVE architect (a non-architect or removed-architect `countersignedById` refused) AND carrying provenance (an absent, foreign, spent or wrong-actor `sourceCommandId` refused — the 4c arms verbatim) + emits the finalizing event by the revision's recorded `approvedFrom` — `decision.approved` for a provisional approval from `pending`, `decision.reapproved` for one from `change` (the reopened → reapproved-into-awaiting → countersigned sequence probed end to end, with the `approved`/`reapproved` + `countersigned` audit rows; a revision born `finalized = false` with NULL `approvedFrom` refused by the birth seal); the ENTRY sealed from the decision side (review round 4) — a bare `UPDATE` to `awaiting_countersign` with no same-transaction provisional revision refused at commit, the re-entry of a rejected or returned decision onto its disposed head refused, the entry under an INACTIVE chain refused, the legal approve accepted; `decision.awaiting_countersign` emitted BY THE ENTRY SEAL at commit through `platform_emit_event` with the architect-targeted push — a hand-run receipt + revision + transition bundle emits it too, and the service emits it nowhere else (review round 21); the READER arm — the shared tripwire walking every `DecisionStatus` value against `decisionChip`/`decisionChipLabel` and `deriveDecisionReading` (RED for `awaiting_countersign` at base: the chip falls back to withdrawn styling, the reading to the decider's approval), plus `StatusChip`, the log filter, the audience selectors, the schedule filter, the consultation thread's open set (the architect asks and a consultee answers on an awaiting decision through the UI) and the location tree's counters, label and rank (no `NaN`, the group present in the status rollup) each answering for the value explicitly; the WEB arm for the architect's OWN controls (review round 6) — the Decision Log renders Countersign, Reject back and Forward on for an `awaiting_countersign` decision to an active architect and to nobody else (a PMC sees the stranded-resolution control only while the chain is INACTIVE), and invoking each through the shipped UI drives the command end to end — countersign → `approved` with finality, reject-back → `change` with the origin-stamped request, forward-on → `change` + the `DecisionForward` fact — RED at base (no control renders; the status falls through the chip fallback) and asserted GREEN post-fix as a product-path assertion, not staging prose; the INBOX arm (review round 7) — `selectActionItems` yields the active architect's countersign item and the navigation badge for an awaiting decision, the PMC's awaiting summary, and the red stranded item when the chain is inactive (RED at base: the selector derives nothing from the status); the PORTFOLIO arm (review round 11) — `countPending` reports on the architect's card the role-designated pending decisions and the awaiting countersigns, and on the PMC's the stranded ones while the chain is inactive (RED at base: zero); the NOTIFICATION arm (review round 7) — the feed after a provisional approve carries the provisional "awaiting the architect's countersign" text and no green approval, and the green one only after the countersign or the `completed` resolution, naming the ORIGINAL approver with the countersigner or resolver as a distinct attribution (review round 8); the CLIENT APPROVAL arm (review round 8) — the approve modal and success copy under an active chain read "sent to the architect for countersign" / "awaiting the architect's countersign", byte-identical to today with no chain; **P31b** the register INSERT pairing (§B.4); **P31c** exactly one countersign per flip (§B.5) | the approve CAS (`decisions.service.ts` `approve`); the new countersign table + its reverse seal + the birth/standing seals; the catalog |
| P32 | self-countersign is TWO attributed acts under two idempotency keys — one combined act is refused; the two acts appear as two ledger receipts and two register facts | the countersign command |
| P33 | both disagreement outcomes: origin-stamped open `ChangeRequest`, `withdrawChange` refusal on `countersign_rejection`, the class-wide evidence freeze INCLUDING `decisionId`, `origin` AND `revisionId` (review round 4) (the hostile re-point to another decision refused; the hostile `countersign_rejection → 'standard'` re-label refused — the closed escape cannot be reopened by relabelling), impacts rendered, reject-back AND forward-on driven through re-approval to completion — forward-on through the ONE forward door with its `DecisionForward` fact (the request the bundle's provenance primary, the forward citing the same receipt); the freeze covering the new `projectId` and `sourceCommandId` — the hostile UPDATE that NULLs the receipt and the one that replaces it both refused (review round 3); the request's immutable `origin` serialized on the live, projected and rebuilt DTOs and the Withdraw affordance SUPPRESSED for a `countersign_rejection` request in the Decision Log while the direct call still 409s (the web arm, review round 2); the reject-back and forward-on requests carrying a non-NULL `sourceCommandId` bound to the completed `decisions.disagree` receipt — the direct-SQL disagreement bundle by an ACTIVE architect with every pairing, standing and eligibility seal green but NO receipt, refused at commit; **P33b** the rejection request's own pairing, its two producer shapes, and its provenance (§B.6) | the `ChangeRequest` machinery (`requestChange`/`withdrawChange`); the extended freeze |
| P34 | the forward chain: attribution (actor vs displaced holder), the web Forward affordance following `rollout.phase6_4d` (absent while the reservation stands, rendered after 4d-iii — review round 4), the `decision.forwarded` emission + re-seal, the NON-HOLDER architect's product path (review round 12) — a client-held pending decision rendered in the active architect's Decision Log with the Forward affordance and forwarded end to end through the shipped UI, RED at base where the audience rule hides the row, absent again for a removed architect and while the chain is inactive — non-blank reason (zod + the complete-whitespace `btrim` CHECK + NOT NULL — a tab-and-newline-only reason refused at the DB), the PAIRING sealed in BOTH directions — hostile holder UPDATE refused with NO same-tx forward row AND with a MISMATCHED one; the SAME-TARGET forward refused at the command (409) and at both DB doors — a no-op holder UPDATE paired with a `from = to` row, and the bare `from = to` row insert (review round 13); a hostile ORPHAN `DecisionForward` insert (no same-tx holder mutation) refused by the deferred reverse seal; the DOOR status-gated at the DB (a matched forward + holder mutation on an `approved`/`recorded`/`withdrawn` decision refused, and on an `awaiting_countersign` decision refused WITHOUT the same-tx rejection request); the TARGET's standing judged at the DB (a matching row naming a removed membership or an empty role refused); the ACTOR's standing judged at the DB (an inactive or unauthorized `forwardedById` refused; the role-holder arm's own — a matched row on a client-held decision whose `forwardedById` is a contractor while another active client exists, refused by `phase6_user_holds_role`; review round 3); provenance (the 4c arms); **P34b** exactly one forward per holder mutation (§B.5) | the 4b write-once trigger's one door + the reverse constraint trigger + the status/target/actor standing reads |
| P35 | the forward-vs-approve barrier: both orderings deterministic, exactly one surviving outcome, a coherent holder; and forward-vs-countersign likewise | the row-lock serialization in the canonical order |
| P36 | the switch-writers barrier: architect role-change vs approve, activation AND deactivation, both orderings — the SERVICE activation and, review round 20, the HAND-RUN one (a direct INSERT under a hand-completed receipt) each vs `approve` and vs the stranded resolution, both orderings, the hand-run writer refused as contended while the key is held and the terminal state asserted (approve-first → the activation lands after and the decision stays `approved`; activation-first → the approve lands `awaiting_countersign`); the orgs role mutations for `architect` take `lockProjectReadiness` (the §A enumeration grows by them — review round 18; the restore re-emit rides the `decisions.effects` consumer, review round 19); activation-vs-approve asserts the countersign deliveries per decision EXACTLY by ordering (review round 6; corrected review round 23): approve-first under NO chain lands terminal `approved` and owes NOTHING — the later first-architect activation's re-emit enumerates only `awaiting_countersign` decisions, so ZERO countersign deliveries for that decision, asserted, never a fabricated demand; activation-first → the approve lands `awaiting_countersign` and its OWN approve emits the ONE; a decision ALREADY awaiting when the activation crosses (approved under an earlier chain, then stranded) receives the ONE re-emit; never two for one decision | `lockProjectReadiness` on the orgs role mutations |
| P37 | EVERY entry into `approved` sealed behind the chain, SERIALIZED by `phase6_try_readiness`: under an ACTIVE chain the direct `pending → approved` hostile flip refused, the finalized-boolean-only flip refused, the awaiting-flip without the SAME-TX countersign ROW refused, the standard `withdrawChange` restoration (finalized head, `standard` open request) PASSES, the `countersign_rejection` restoration refused; under an INACTIVE chain direct approval legal ONLY from `pending`/`change` — the bare awaiting-flip refused without the stranded-resolution fact; the first-architect-activation-vs-approval barrier deterministic in both orderings (the seal reentrant on the service path, hold-to-commit when free, REFUSE when contended — never blocking inside a trigger) | the new status-transition seal + the try-readiness protocol on every seal-trigger standing read |
| P38 | the pre-send eligibility guard generalized to EVERY targeted decision push through PER-EVENT-FAMILY predicates — the two NEW families (`countersign`: awaiting + active architect; `forward`: installed holder AND status `pending`/`change` — a withdrawn or terminal decision cancels with the recorded mark, review round 4) beside the three 4c delivered (`decider`, `consultation_requested`, `consultation_responded`): one positive AND one negative probed per new family — a valid consultee push is NOT dropped by the countersign predicate; the consultation-responded predicate widened to the architect requester WITH the withdrawn-audience arm — an active architect requester receives the response push, a response enqueued before a PMC withdrawal is cancelled for the architect requester and still delivered to a PMC requester (review round 3), while a REQUEST push enqueued before the withdrawal is cancelled for every consultee, a PMC consultee included (review round 13); the two new predicates bound at bootstrap under the BUMPED `webpush.notify` contract, and a process compiled at the old version refused by `syncConsumerCatalog` at startup (the 4c-ii startup-fence probe, re-run for version 3); the catalog-data migration in `ALWAYS_EXECUTE` — a P3005 baseline over a pre-4d-ii database runs it and the upgraded process starts (review round 5) | the delivered per-family registration + the two new `decisions.*PushTarget` queries + the consumer catalog bump and its catalog-data migration |
| P39 | the delivered orphan guard EXTENDED: removing or re-roling the NAMED holder, or the last active member of a ROLE designation, of an `awaiting_countersign` decision is refused at BOTH layers (409 through `holdsOpenDecisions`; the DB guard on the hostile direct write); removing the LAST ARCHITECT is NOT refused — it deactivates the chain (P29b) — INCLUDING when that architect is the named holder of an awaiting decision OR the last active member of the architect ROLE designation an awaiting decision names (the one named exemption, review round 7, extended to the role designation in review round 13 — the removal proceeds, the chain deactivates, the stranded `returned` re-homes the role-designated decision with a `toDesignation` exactly as the departed named holder), while a named holder who is an architect but not the last is refused naming the pending countersign, and a `pending`/`change` decision designated to the role still refuses removing its last architect (the open-holder rule, unchanged) | `holdsOpenDecisions` + `phase6_t4b2_membership_guard`, open set widened |
| P40 | claim-time per-family re-check: a forward between commit and claim re-targets or drops the pending DECIDER push, recorded, while a still-standing consultee push SURVIVES the same forward; the `deciderPushTarget` read takes the decision row lock (the 4c hand-off, changed here); the SEND BOUNDARY (review round 1): the forward command cancels not-yet-sent decider deliveries by subject under the decision row lock, the consumer re-reads the cancellation mark immediately before `notifyTargetedUser` and re-judges EACH recipient by the family's OWN standing rule before that user's send — role standing for a fan-out (review round 4), the named membership's active standing for decider/consultee/holder targets (review round 5), `hasProjectRoleStanding` for the responded family's membership-less requester (review round 6) — a stale recipient SKIPPED without the whole-delivery mark (review round 6), and the forward-vs-claim barrier is driven in BOTH orderings — forward-first → re-target or cancel at claim; claim-first with the consumer HELD at the pre-send barrier while the forward commits → the final re-read drops the send and the displaced holder receives nothing — with the in-flight residual (a forward landing after the final re-read, during the provider call) stated as a post-revocation disclosure bound — the new families' bodies generic by construction, the delivered bodies named for the title they carry (review round 8) — not asserted away; the withdraw-vs-claim barrier for a non-PMC holder in both orderings, and the APPROVAL-vs-claim barrier for the `decider` and `forward` families in both orderings — approval-first refused at claim by the status arm; claim-first held at the pre-send barrier while the approval commits and cancels by subject, the final re-read drops the send, the delivery marked (review round 13); the OPEN-SET-EXIT barrier for `consultation_requested` — a claimed request push against a no-chain approve, a countersign and a `withdrawChange`, each dropped at the final re-read with the mark, while the approval into `awaiting_countersign` leaves it deliverable (review round 14), and the non-last-member interleaving (architects A and B resolved at claim, A removed at the pre-send barrier → B receives, A nothing; a two-holder role forward likewise) — review round 4; the user-targeted arm — a `consultation_responded` push claimed for an active architect requester removed at the pre-send barrier sends nothing, the named-member decider push likewise — review round 5; an org-admin requester with no membership receives the response push, and the partial fan-out (A stale, B sent) leaves the delivery `succeeded`/`dispatch` with no mark while an all-stale fan-out is marked — review round 6; the archive-vs-claim barrier for the forward and countersign families — the project archived at the pre-send barrier → nothing sent, the delivery PARKED (review round 7, parking from round 21); the direct-transition arm — a `decider` push claimed, a direct `pending → approved` committed at the pre-send barrier under an inactive chain → nothing sent, the delivery marked, and a claimed request push against a direct transition out of the open set likewise; the fan-out arm (A sent, the direct transition at B's barrier, B skipped, no mark) and the responded family's target-aware re-judge (the PMC requester's response survives a withdrawal at the send, the architect requester's is dropped) — review round 19; the restore arm — archive → the claimed push PARKED unmarked → restore → the same row released and sent once, a delivered push not sent again, nothing for a project with nothing parked (review rounds 18 and 21) | the delivery claim path; `decisions.query.ts` `deciderPushTarget`; the forward command's subject cancellation; `consumers.ts` `makePushConsumer` |
| P41 | the delivered 4c lock-order + terminal-state probe EXTENDED to the transitions 4d adds that CLOSE the consultation-open set (review round 19 — the table ran P40 → P42 and never extended it): `consultation.request` and `consultation.respond` vs the COUNTERSIGN, vs the `completed` stranded resolution, and vs the standard `withdrawChange` (`change → approved`), each in BOTH orderings under the canonical lock order, asserting the TERMINAL invariant directly — consultation-first leaves the historical consultation/response standing and the finalizer commits `approved` beside it; finalize-first returns 409 with NO consultation row, NO response row and NO `consultation_*` effect (a lock-AFTER-read implementation that reads `awaiting_countersign`, lets the finalizer commit and then inserts against the closed subject fails here, exactly as 4c's round-22 arm fails it against `approve`); the `returned` stranded resolution and the countersign REJECTION land `change`, which stays in the open set, so the same probe asserts the consultation ACCEPTED after them; no deadlock abort in either ordering | `consultations.service.ts` request/respond; `decisions.countersign`, `resolveStrandedCountersign`, `withdrawChange` |
| P42 | the finality candidate key over the ACTUAL provenance columns: provenance onto an unfinalized revision unrepresentable (both spec tables); `finalized → false` under reference refused by the FK; the additive backfill leaves every legacy revision `finalized = true` and every legacy spec row `revisionFinalized = true`, proven over the legacy fixture in `upgrade-proof.sh`; the DEFAULTS hold through the drain — a revision, a material spec and a labour spec inserted WITHOUT the new columns (the previous release's write shape) all succeed on the 4d-i schema and land `true` (review round 1), a `ChangeRequest` inserted WITHOUT `projectId` is filled from its decision and one naming another project's id is refused by the composite FK (review round 3), and 4d-iii's drop of the defaults is probed by the same inserts then failing AND by a current-version provenance write through the SHIPPED writers — a material and a labour requirement created, revised AND cancelled with `decisionId` after the drop, the cancellation copy carrying the pin forward — succeeding with `revisionFinalized = true` from the widened `approvedRef` (review rounds 11–12; RED at base: the writers spread the three-field result and the insert fails on the required column), its trailing provenance seal by a NULL-`sourceCommandId` standard insert refused while the legacy NULL rows survive; **P42b** with P31b (§B.4) | `DecisionApprovalRevision_provenance_target_key` widened + the two spec FKs re-targeted |

## §D — Staging, review unit, and order

- **This plan document is the review unit**, and its STATUS record travels
  WITH IT — docs-only, its own exact-head Codex review to a fresh clean +1,
  through the orchestrator's exact-head gate (`codex-current-head`), which
  is the INDEPENDENT clearance the 4c plan's #486/#490 detour restored: a
  plan merged without it gates its implementation until it is obtained. The
  folded record NAMES ITS OWN PR in `open_pr` (the 4c plan §D, review round
  9): `assessPostMergeRunnerState` clears a self-referential `open_pr`
  before resolving, so naming it survives its own merge — falling back to
  `task: 4` — while keeping `detectStatusDrift` quiet for the whole time the
  PR is open. `next_task` stays `phase-6-task-4d`: the id names the task
  stop, and it is THIS narrative that binds what starts at it — 4d-i, only
  after this plan clears. Past the plan-review round cap this unit's heads
  owe `Review-Deferred-To-Probes: phase-6-task-4d` (the id parses under the
  gate's `TASK_REFERENCE` shape) — the probes above are exactly the
  executable deferral targets that trailer names; the deferral trailer is
  refused from a STATUS-touching diff, so past the cap the STATUS pointer
  lands separately (the PR #335 two-step), and not before.
- **4d implementation follows as FOUR PRs — the dark migration 4d-i, the
  service/role/UI unit 4d-ii, a drain attestation, and the trailing
  reservation retirement 4d-iii — each honouring the mandatory migration
  seam** (the additive schema is deployable before any caller uses it — that
  viable seam makes a single migration+service+UI PR a violation of the
  repository's migration review-unit rule, and this plan takes the seam):
  - **4d-i, the migration unit**: ONE additive migration, in one explicit
    `BEGIN`/`COMMIT` where PostgreSQL permits it, opening with the
    RESERVATION's `CREATE TRIGGER` and — only after that lock is held — the
    diagnostic-first AUDIT that ABORTS on any pre-existing
    `Membership.role = 'architect'` row (§A.1: the reservation FIRST, the
    audit SECOND, one transaction; review round 5 corrected a staging
    sentence that still read preflight-first) (the `awaiting_countersign` and
    `architect` enum values are added the way 20271015 added `recorded` —
    an enum value cannot be USED in the transaction that adds it, so the
    seals that compare against it are installed after the value commits,
    exactly as 4b's were — but, review round 20, the RESERVATION doors on
    `Decision` are installed BEFORE the values, in their own preceding
    transaction, judged as TEXT, so no window exists in which a value is
    representable and unreserved): the FIVE decisions-owned tables — the
    three fact tables (`DecisionForward`, `DecisionCountersign`,
    `DecisionStrandedResolution`), the append-only
    `DecisionCountersignNotice(projectId, decisionId, deliveryId,
    standingPosition, at)` of §A.2 (review round 26 — same-project
    composite FKs to `Decision(projectId, id)` and `OutboxDelivery`, UNIQUE
    `(projectId, deliveryId)`, its append-only seal and the statement-level
    `DecisionCountersignNotice_t4d_no_truncate`; created EMPTY here so
    4d-ii's send hook and consumer can append and read it — AND, review
    round 27, an INSERT-time CORRESPONDENCE seal
    `DecisionCountersignNotice_t4d_bound`, since FKs, uniqueness and
    mutation seals alone would admit a notice naming an unrelated
    same-project delivery and an arbitrary high `standingPosition`, which
    the `{ to: 1 }` handler would read as "already demanded" and skip the
    only replacement: the seal requires that the named `OutboxDelivery` is
    the `webpush.notify` delivery of a countersign-family `DomainEvent`
    (the `decision.awaiting_countersign` demand or its re-emit) whose
    `entityId` is `NEW."decisionId"` in `NEW."projectId"`; that the
    delivery's `succeeded` write belongs to the CURRENT transaction (its
    `xmin = txid_current()::text::xid`, the receipt-seal conversion) — the
    notice is born in the send transaction or not at all; and that
    `NEW."standingPosition"` equals the register's current
    `lastCrossingPosition` for `(projectId, 'architect')`, read under the
    row lock — RED SITES: a notice naming a decider-family or another
    decision's delivery; a notice inserted outside the send transaction; a
    position ahead of or behind the register), and the
    operator-only `DecisionRepairAction` evidence register of §D (review
    round 26 — created by the repair bootstrap transaction below, append-only
    with `DecisionRepairAction_t4d_no_truncate`) — each registered
    in `decisionsManifest.ownsModels` AND `readEncapsulated` in the same PR
    with the `boundary.test.ts` complete-set pins advanced (review round 15:
    the boundary suite requires Prisma DMMF ownership to EXACTLY equal the
    manifests, so a model cannot enter `schema.prisma` unregistered, and
    `readEncapsulated` keeps the evidence tables inside the foreign-read
    analyzer; `RolloutRetirement` and the platform-owned `ProjectRoleStanding`
    register — one `architect` row per project, backfilled from the
    migration's own count, with its writer-depth seal, its project-cascade
    arm and the statement-level `ProjectRoleStanding_t4d_no_truncate`
    (review rounds 16–17), and the crossing emit through the
    canonical-pinned `platform_emit_event` SQL twin (review round 19), and
    the EMPTY, sealed `OutboxConsumerCutover` table (review round 22), §A.2 —
    are registered on the platform manifest the same way; the decisions-owned
    ordered consumer `decisions.effects`, its cutover fill and
    `decisionsManifest.consumesEvents` land in 4d-ii) — with composite
    same-project FKs, candidate keys, CHECKs (`btrim` non-blank, the
    `outcome` and designation-kind discriminators), the six contract
    obligations' seals — append-only + named no-TRUNCATE, the deferred
    pairing triggers in both directions, actor-standing and
    subject-eligibility reads through the delivered primitives under
    `phase6_try_readiness`, and the 4c provenance shape reusing
    `phase6_t4c_provenance_bound` where a command writes one fact and the
    4d-owned bundle-aware `phase6_t4d_provenance_bound` where it writes a
    bundle (§A.3); `DecisionApprovalRevision.finalized` (DEFAULT `true`,
    KEPT) with the birth seal, the widened candidate key and the backfill,
    the delivered `DecisionApprovalRevision_append_only` trigger DROPPED and
    replaced by the one-flip seal (review round 10),
    and the immutable `approvedFrom`, `approvedByName` and — review round
    26, staged where §A requires it — `approvedByRole` (all nullable for
    legacy rows, all required on any revision born `false` — review round
    9 for the frozen name, round 25 for the frozen role), the four columns
    added by the repair bootstrap transaction and CHECK-pinned here; `revisionFinalized` on the two spec tables
    (DEFAULT `true`, KEPT) with the CHECK, the backfill and the FK
    re-target; `ChangeRequest.projectId` (backfilled, trigger-filled for
    old writers, `NOT NULL`, composite-FK-bound to `Decision(projectId, id)`)
    and `ChangeRequest.origin` with their backfills, the extended freeze
    (now covering `origin`, `projectId` and `sourceCommandId`), the nullable
    provenance `sourceCommandId` with its composite FK and partial one-use
    UNIQUE, and the two-producer P33b pairing; the two NEW orgs-owned
    primitives `phase6_user_orchestration_authority` and
    `phase6_user_holds_role` (registered as 4c-i's two were; review round 3);
    the PERMANENT platform-owned `Membership_t4d_role_standing` register
    trigger, the PERMANENT orgs-owned `Membership_t4d_architect_provenance`
    pairing seal with the append-only orgs-owned `MembershipTransition`
    fact, its `phase6_t4d_membership_transition_bound` binding and
    `MembershipTransition_t4d_no_truncate` (review round 19 — no provenance
    column on `Membership`), the statement-level `Membership_t4d_no_truncate`, and the
    orgs-owned `Project_t4d_deleting` flag trigger (review round 17,
    replacing round 14's `SET LOCAL`-gated
    `Membership_t4d_architect_service_only` and round 16's cross-module
    `Membership_t4d_chain_mirror`: the standing moves DOWN into the kernel
    and the writer boundary is the command ledger on the membership row
    itself, §A.2; none dropped by 4d-iii); the widened `phase6_t4b2_decision_seal`
    (its role arms), the forward door opened in `decision_t4b_attribution_seal`
    (status-gated, target- and actor-judged; review round 25) and the
    approved-entry seal with its decision-side `awaiting_countersign` entry
    arm and the rejection request's `revisionId` (review round 4); the `phase6_t4b2_membership_guard` open set
    widened; the two 4c consultation seals `CREATE OR REPLACE`d with the
    `awaiting_countersign` arm and the requester arm moved onto
    `phase6_user_orchestration_authority` (`phase6_user_decision_authority`
    byte-identical); and the RESERVATION — the orgs-owned
    `Membership_t4d_architect_reserved` (judged on NEW regardless of OLD),
    `DecisionForward_t4d_reserved` on every forward row (review round 4) AND
    `Decision_t4d_architect_reserved` on every `Decision` row naming the
    architect designation, draft or published (review round 13), and
    `Decision_t4d_awaiting_reserved` on every `Decision` row carrying the
    awaiting status (review round 20) — FOUR doors, one shared refusal
    function, the two `Decision` doors installed before the enum values. **And the reservation on `Decision`
    PRECEDES the enum values** (review rounds 14 and 20): `DeciderKind.architect`
    and `DecisionStatus.awaiting_countersign` are added in their own
    statements and commit first, so round 14 had the seal transaction AUDIT
    `Decision` for a row stored in the gap — but an audit cannot undo a
    CONCURRENT writer: a direct insert committing between the values and
    the seal transaction makes the audit abort, which rolls back the
    reservations and leaves the writer's row AND the committed values
    behind — exactly the mixed-version state 4d-i exists to prevent, and a
    still-serving old Prisma client fails on that row. So 4d-i CLOSES the
    gap instead of auditing it: `Decision_t4d_architect_reserved` and a
    fourth door `Decision_t4d_awaiting_reserved` (both transient, both
    dropped by 4d-iii) are created in their own transaction BEFORE the `ADD
    VALUE` statements, judging the row AS TEXT — `NEW."deciderKind"::text =
    'architect'`, `NEW."status"::text = 'awaiting_countersign'` — which
    PostgreSQL evaluates whether or not the value exists yet, so no window
    opens in which either value is representable and unreserved; the audit
    stays as the diagnostic for rows that PRE-DATE 4d-i (the same shape as
    the `Membership.role` audit), the seal transaction still holding the
    `Decision` table lock its `CREATE TRIGGER` statements take,
    diagnostic-first, ABORTING with the rows named and installing nothing —
    with nothing left for a concurrent writer to slip past; the operator
    repair is NOT a service-path edit (review round 24: 4d-i aborts BEFORE
    the release whose Prisma client knows the values deploys, and the
    still-serving pre-4d client cannot READ a row holding an enum value its
    generated enum does not know — the very failure §D names — so a repair
    routed through the old service would leave every redeploy blocked on
    the same row) but the platform operator command
    `decision:repair-reserved-value <decisionId> (--decider-kind <client|pmc>
    --holder <membershipId> | --withdraw --reason <text> |
    --revert-provisional --reason <text>)`, shipped with
    4d-i in the operator CLI and acting through raw SQL (`$executeRaw` with
    `::text` predicates, never deserializing the row through a Prisma
    model): it touches ONLY a row the audit's own text predicate names,
    either rewrites `deciderKind` to an operator-named EXISTING kind with
    the holder the operator names (validated against the roster) or
    withdraws the row exactly as the 4b withdrawal writes it (the status
    transition and its `ChangeRequest` pairing reproduced by hand under a
    reserved operator receipt — the ledger's valid alternate writer; legal
    ONLY for a published `pending` row with no approval evidence, which is
    all the delivered `phase6_t4a_withdraw_entry` seal admits), or — review
    round 25, for the row whose reserved value is `status =
    'awaiting_countersign'`, which neither of the two branches could clear
    (a re-kind leaves the status, and an awaiting row was created by an
    approval revision the withdraw seal refuses) — REVERTS THE PROVISIONAL
    APPROVAL under the repair-engine discipline of the cleared `t45`/`t2c`
    tools, over prerequisites that EXIST when the audit aborts (review
    round 26: 4d-i's file opens with a REPAIR BOOTSTRAP transaction,
    committed FIRST and independently retry-safe — `CREATE TABLE IF NOT
    EXISTS "DecisionRepairAction"` with its seals, and `ALTER TABLE
    "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS` for the nullable
    `finalized`, `approvedFrom`, `approvedByName` and `approvedByRole`
    columns, all additive and invisible to the pre-4d client — ahead of the
    doors transaction, the `ADD VALUE` statements and the seal-and-audit
    transaction, so an audit abort leaves the bootstrap committed and the
    repair below runs on exactly the database it aborted over; the later
    seal transaction adds the CHECKs, backfills and candidate key over
    those columns; the P3005 replay finds every bootstrap statement a
    no-op): one bounded transaction that writes a before-image
    `DecisionRepairAction` evidence row, disables ONLY the named seals for
    its statements, sets `status` back to the provisional revision's
    recorded `approvedFrom` (`pending` when the row carries none), RETIRES
    that unfinalized revision (its receipt left completed as history, its
    image in the evidence row), re-enables and verifies every seal, and
    commits only if the audit predicate no longer names the row — refusing
    a row whose latest revision is finalized; each branch appending an
    `operator_repaired` `DecisionEvent` with the operator identity and
    reason, and refusing any other row, an unknown holder, or an invented
    status; the same file then deploys, and `upgrade-proof.sh`
    drives abort → repair (with NO 4d-capable client running) → redeploy for
    BOTH reserved values — a planted `architect` row re-kinded and a
    planted `awaiting_countersign` row reverted (review round 25). P28b's arm
    gains both values, barrier-probed in both orderings against a direct
    writer on the shipped file — the writer racing the `ADD VALUE` step
    REFUSED by the text door, never grandfathered (review round 20). Every non-blank text
    column carries the complete-whitespace `btrim` CHECK beside `NOT NULL`
    (review round 1). Its integration suite is the seal-stripped harness of §C;
    `upgrade-proof.sh` gains the P42 backfill assertions over the legacy
    fixture, the old-write-shape inserts succeeding under the kept defaults,
    the planted pre-existing architect row driving abort → repair →
    redeploy, and one hostile insert per seal; `TRUNCATE_SEALS` gains TEN
    entries across 4d-i and 4d-ii — the three new fact tables, the
    countersign notice's `DecisionCountersignNotice_t4d_no_truncate` and
    the repair evidence's `DecisionRepairAction_t4d_no_truncate` (review
    round 26), the register's `ProjectRoleStanding_t4d_no_truncate`,
    `Membership_t4d_no_truncate`, `MembershipTransition_t4d_no_truncate`
    (review rounds 16–19), the cutover's
    `OutboxConsumerCutover_t4d_no_truncate` (review rounds 21–22, the
    table created empty and sealed in 4d-i) AND the `ChangeRequest`
    no-TRUNCATE seal the uniform contract adds to that existing table (review round 8: a
    statement trigger fires on an empty table, and the harness's `TRUNCATE
    "Decision" … CASCADE` reaches `ChangeRequest`, so an unregistered seal
    would fail every sanctioned reset), while the `RolloutRetirement` marker
    table is deliberately NOT in the reset's table list at all — it is a
    rollout fact, never test data, and the replay probes run on the scratch
    database `upgrade-proof.sh` provisions; `ALWAYS_EXECUTE` gains the migration (raw guards a `db push`
    baseline cannot have — the 4c-i lesson) — **and its transient portion is
    a NO-OP once 4d has retired** (review round 5): in `ALWAYS_EXECUTE` a
    later P3005 baseline of a MATURE database — one holding a legitimate
    active architect after 4d-iii — replays 4d-i before 4d-iii, and an
    unconditional file would re-create the reservation and then ABORT on
    that valid row in its any-status audit, so the deploy never reaches the
    retirement that removes the reservation. 4d-i therefore SPLITS its body:
    the PERMANENT guards (tables, seals, backfills, primitives) run
    unconditionally and re-runnably, while the TRANSIENT block — all FOUR
    reservation triggers (`Membership_t4d_architect_reserved`,
    `DecisionForward_t4d_reserved`, `Decision_t4d_architect_reserved`,
    `Decision_t4d_awaiting_reserved`;
    review round 15 corrects a "both" that survived round 13's third door —
    a door left in the permanent portion would be re-created by an
    `ALWAYS_EXECUTE` replay after retirement while the marker skips the
    transient cleanup, blocking architect-designated decisions
    indefinitely), their SHARED refusal function (review round 7 —
    a function created in the permanent portion would be re-created on the
    post-retirement replay and survive a no-op 4d-iii, so it lives and dies
    with its triggers) AND the audit — runs only when the durable
    RETIREMENT MARKER is absent. That marker is one row in a NEW, sealed
    platform table `RolloutRetirement(unit TEXT PRIMARY KEY, retiredAt,
    retiredBy)` created by 4d-i's permanent portion — NOT a row on
    `OutboxOperatorAction` (review round 7): the 4c-iii-r verifier
    (`inbox-repair-seals.ts` `verifyMarkerSeals`) keeps a CLOSED inventory
    and rejects ANY unexpected BEFORE INSERT/UPDATE row trigger on that
    table, its trigger functions are canonical-body-pinned, and the
    immutable `20271125000000` repeats the closed-inventory check on every
    replay, so a fourth trigger there would fail the verifier closed and
    block the next deploy. The new table carries the 4c-iii-r seal SHAPE on
    its own surface — creation gated to the writing path by a `SET LOCAL
    vitan.phase6_4d_retire = 'on'` flag that only 4d-iii's transaction
    sets (a mistake-proofing gate in exactly the 4c-iii-r sense — "unforgeable
    by ACCIDENT" — never a privilege or service-only claim, which this
    deployment's single table-owning role could not honour; review round
    16), UPDATE and DELETE refused, no-TRUNCATE — because a forged marker
    would skip the reservation on an undrained database, the same class as a
    forged repair marker; and `verifyMarkerSeals` is probed UNCHANGED after
    4d-i and 4d-iii (its inventory still exactly the three 4c-iii-r
    triggers), so the two markers never meet. Probed (P28b's replay arm, in `upgrade-proof.sh`): the P3005
    baseline of a post-4d-iii database holding an active architect — 4d-i
    replays, finds the marker, installs no reservation, no refusal function
    and aborts nothing, 4d-iii replays, re-drops nothing and verifies the
    retirement complete, the architect survives and the function is absent
    (review round 7); and the baseline of a
    pre-4d-iii database (no marker) still installs the reservation and
    audits; the corpus pin advances.
    **Deployed dark**: no contract, no command, no route, no reader; a
    still-serving 4d-ii-less instance cannot produce any new value.
    Expected to EXCEED the standard budget on probes alone — its packet
    argues `justified-large` on its own evidence, never by reference to this
    sentence.
  - **4d-ii, the service/role/UI unit** (review round 17: it also moves the
    three orgs membership mutations — `members.add`, `members.updateRole`,
    `members.remove`; re-activation goes through `add` — onto the command
    ledger, the provenance 4d-i's seal on architect rows demands, and loads
    the roster on the consultation surface, §A.2): the role fan-out (§A.1 — every
    mirror, the policy rows, the web lists — and the `DeciderKind`
    DESIGNATION fan-out: the enum value and the two 4b seals' widened role
    arms from 4d-i, then `DECIDER_KINDS`, the shared type,
    `viewerIsDecider`, `deciderNoun`, the DTO, the decider picker, the
    audience selectors, the labels, the `deciderPush` producer and the
    `deciderPushTarget` claim predicate (review round 11), AND the
    viewer-scoped `DecisionsQueryService.countPending` — the Portfolio tile
    count whose predicate today gives a non-PMC viewer only
    client-designated rows or rows naming their membership: it gains the
    `architect` role arm (an active architect counts the `pending`
    decisions designated to the role) and counts the viewer's
    `awaiting_countersign` obligations (an architect's pending countersigns;
    the PMC's stranded ones while the chain is inactive), the portfolio
    probe asserting the architect's card reports them, zero at base —
    review rounds 10–11); the four commands
    (`decisions.forward`, `decisions.countersign`, `decisions.disagree` with
    its two paths, `decisions.resolveStrandedCountersign`) on the command
    ledger with idempotency keys and `lockProjectReadiness` in the canonical
    order; the approve CAS landing `awaiting_countersign` under a chain; the
    `withdrawChange` refusal; `decisions.approvedRef` returning
    `revisionFinalized` and refusing an unfinalized head, with the material
    and labour create/revise writers spreading it explicitly, the two
    cancellation copies carrying it forward, and the writer sweep pinning
    every spec INSERT site (review rounds 11–12);
    every approve recording `approvedFrom` and
    `requestChange` recording `sourceCommandId` with its receipt naming the
    created request row (review round 4); `decisions.forward` refusing 409
    while the forward reservation stands, `MembersService.add` and the
    role-update command refusing `architect` BEFORE any write while the role
    reservation stands (review round 5), and the shell's ONE
    `rollout.phase6_4d` read that the Forward affordance AND the Team role
    pickers follow (review rounds 4–5); the existing targeted
    catalog entries `decision.published` and `decision.consultation_requested`
    admitting `architect` in their push ceilings, with the catalog tripwire
    over every targeted entry whose narrowing site persists a member role;
    `consultationRespondedPushTarget` widened to `['pmc','architect']` with
    the withdrawn-audience arm (§A.2; review round 3); the consultation predicates
    widened; the architect's Decision Log controls (Countersign / Reject
    back / Forward on, rendered for an active architect on an awaiting
    decision and probed as a product path — review round 6); the
    decisions-owned `decisions.effects` ordered consumer driving
    `renotifyAwaitingCountersign` from `membership.standing_changed` and
    the kernel's `releaseParked` from `project.restored` (review rounds 19
    and 21 — no participant call from the orgs mutations, no re-emission on
    restore), and the per-recipient
    pre-send re-check by each
    the `countersign-v1` client contract with its transport-layer
    interceptor and the four commands' stale-client refusal (review round
    9); the withdraw transaction cancelling the consultation families' unsent
    deliveries for the decision whose target leaves the withdrawn audience
    (review round 9, narrowed to those targets in round 10); the frozen
    `approvedByName` AND `approvedByRole` written by every approve from
    4d-ii (review rounds 9 and 26 — the role from the actor's token, frozen
    with the row, the value the seal passes to the twin);
    family's own standing rule that skips without marking (review round 6)
    and re-checks project operability through `isProjectOperable` (review
    round 7); the re-notification gated on the zero-to-one chain
    reactivation (review round 7); the provisional approval `Notification`
    under an active chain with the green one written by the finalizer
    (review round 7); the `selectActionItems` architect branch and its
    Inbox item (review round 7); the orphan guard's one named exemption
    and the departed-holder `returned` bundle (review round 7);
    the reader enumeration of §A.2 — the shared chip maps, the
    `deriveDecisionReading` arm, the two lagging API status unions pointed
    at the shared type, the log/schedule filters and audience selectors, AND
    the client's approval confirmation (review round 8 — `ApproveModal.tsx`
    promises "Will be locked" and the store flashes "Approved & locked — saved
    to the server" while the command now lands `awaiting_countersign` and the
    architect may reject it back): the decision DTO gains a server-baked
    `countersignRequired` (true while the project has an active architect),
    the modal reads it — "Will be sent to the architect for countersign" — and
    the success copy follows the status the command RETURNS ("Approved —
    awaiting the architect's countersign"), never a client-side guess — **and
    the PROJECTED value cannot go stale** (review round 10): the
    `decisions.inbox` fold refreshes a project's DTOs only on `decision.*`
    events (`decisions.projection.ts` `deliveryFor`), and adding a project's
    FIRST architect, or removing its last, produces no decision event — the
    round-6 re-notification enumerates only decisions already
    `awaiting_countersign` — so an already-projected `pending` decision
    would keep `countersignRequired: false`, the modal would promise a lock,
    and the approve would land `awaiting_countersign`. The projection must
    not read `Membership` synchronously (a decisions consumer over an
    orgs-owned table). Round 10 answered with a service-emitted signal
    (`DecisionsParticipant.chainStandingChanged` → a
    `decision.countersign_chain_changed` event refreshing the fold); round
    13 found it incomplete and REPLACES it: this plan permits direct
    `Membership` writes after retirement (activation, removal, hard DELETE,
    re-role — the DB-serialized writer set of §A.2), and a direct architect
    INSERT crosses no service boundary, emits no signal, and leaves the
    stored DTO chain-off while `approve` reads the live standing. Round 13
    answered with a read-time overlay; round 14 found THAT contradicts the
    boundary too — a synchronous orgs read on every decision-list response
    is exactly the cross-module synchronous read the repository forbids —
    and withdrew it in turn, and found the round-6 RE-NOTIFICATION bypassed
    the same way (A leaves, its deliveries cancelled terminally; B inserted
    directly receives neither the new delivery nor the
    `countersign_renotified` row). The answer is to CLOSE THE WRITER SET, not
    to widen the readers (review round 14) — and to close it with the
    LEDGER: not a flag, and not a cross-module seal (review rounds 16 and
    17). Round 14 installed a `Membership_t4d_architect_service_only` seal
    refusing any architect write unless the transaction carried the orgs
    service's `SET LOCAL vitan.phase6_architect_mutation` gate; round 16
    found a transaction-local setting is not a privilege boundary — any
    direct writer holding the application's database role (the only role
    this deployment has, and it OWNS every table, so no GRANT, row policy or
    SECURITY DEFINER fence can hold it either; the 4c-iii-r marker gate's
    own comment claims only "unforgeable by ACCIDENT") can `SET LOCAL` the
    same name and pass — and replaced it with an orgs-owned deferred
    `Membership_t4d_chain_mirror` seal that SELECTED the decisions-owned
    mirror at commit; round 17 found THAT is the forbidden cross-module
    table read in the other direction — a trigger selecting a peer module's
    table is routed through no participant, whatever the prose calls the
    edge. Both are WITHDRAWN, with the decisions-owned `DecisionChainStanding`
    mirror they guarded and the `DecisionsParticipant.chainStandingChanged`
    write that fed it. What replaces them follows the boundary rule to the
    letter — shared logic moves DOWN, never sideways between peers — in two
    parts, neither of which reads a peer's table.

    FIRST, the standing itself moves DOWN into the platform kernel: a
    platform-owned register `ProjectRoleStanding(projectId, role,
    activeCount, changedAt, lastCrossingPosition)` — the last column, from
    review round 25, the `ProjectEventStream` position of the most recent
    zero↔one crossing, written by the register trigger from the crossing
    event it emits (NULL until the first crossing) so a reader can tell
    which standing it resolved against — primary key `(projectId, role)`, same-project
    FK to `Project` `ON DELETE CASCADE`, `activeCount >= 0` CHECK,
    registered in `platformManifest.ownsModels` (the kernel's tables are
    shared infrastructure, as its manifest says) and served by a
    platform-owned `RoleStandingQuery.activeCount(tx, projectId, role)` —
    the kernel's contract, exactly as `CapabilitiesService.isEnabled` serves
    `ProjectCapability` to every module. Its ONLY writer is the
    platform-owned `Membership_t4d_role_standing` trigger, AFTER INSERT OR
    UPDATE OR DELETE FOR EACH ROW on `Membership`, which computes the change
    from the row it is handed and NOTHING else — `before := (OLD.role =
    'architect' AND OLD.status = 'active')`, `after := (NEW.role =
    'architect' AND NEW.status = 'active')`, delta `after − before` — and,
    when the delta is non-zero, applies `INSERT … ON CONFLICT ("projectId",
    "role") DO UPDATE SET "activeCount" = "activeCount" + delta`: no read of
    `Membership`, no read of any decisions table, no count. The register is
    generic in shape so a later unit can carry other roles; 4d maintains the
    `architect` row only, and `phase6_effective_role_standing` stays the
    authority for `client`/`pmc` exactly as delivered. It agrees with the
    orgs primitive BY CONSTRUCTION, not by a cross-module check: both are
    functions of the same `Membership` rows, a row trigger fires for every
    row write, the register's own seals admit no other writer — a BEFORE
    INSERT OR UPDATE OR DELETE seal refusing any write that arrives at
    `pg_trigger_depth() = 1` (a statement issued directly) and admitting
    only a write nested inside another trigger: the standing trigger's, or
    the cascade of the project's own deletion, recognized (review round 17)
    by depth AND the transaction-local flag the orgs-owned
    `Project_t4d_deleting` BEFORE DELETE trigger on `Project` sets — 4c-iii's
    `Project_t4c_deleting` shape reinstalled under a 4d name, because 4c-v
    retired the original together with the seal that read it, so a plan
    naming the retired trigger would have refused every project deletion
    once the register held a row per project; the CHECK turns a delta that
    would go negative into a refusal, never a clamp; the statement-level
    `ProjectRoleStanding_t4d_no_truncate`, registered in `TRUNCATE_SEALS` —
    and `Membership` itself gains the statement-level
    `Membership_t4d_no_truncate` (registered likewise), so the rows the
    register counts cannot vanish beneath it. 4d-i backfills one `architect`
    row per project from a count taken in the migration (zero, which the
    audit proves), `upgrade-proof.sh` asserts register = count over the
    legacy fixture, P29b asserts it after EVERY transition shape (insert,
    activate, soft-remove, restore, re-role in and out, through the service;
    the project cascade), and an operator `platform:verify` diagnostic
    compares the two OFFLINE, never in a transaction. `countersignRequired`
    is then a KERNEL read: the ONE decisions read path — live and projection
    alike, in the hydrate step both run — overlays `activeCount > 0` for
    `(projectId, 'architect')` through `RoleStandingQuery` (one keyed lookup
    per response, present only when true), SYNCHRONOUS with the membership
    commit whose trigger wrote it, never stored in the projection DTO,
    never read from `Membership` anywhere in decisions; the approve CAS and
    every DB seal keep judging the chain by the orgs primitive under the
    readiness lock over the delivered decisions → orgs edge (the cleared
    authority), and the two cannot disagree for the reason above. The
    `decision.countersign_chain_changed` signal stays WITHDRAWN for good
    (round 10 introduced it, 13 withdrew it, 14 restored it, 15 withdrew
    it): nothing in the projection stores the value, so no FOLD needs
    refreshing, and the `decisions.inbox` bump keeps its two other reasons.
    **But OTHER OPEN TABS do** (review round 18): a client that loaded a
    `pending` decision before the first architect was added holds
    `countersignRequired` absent in its store, and the orgs membership
    events (`membership.added`, `membership.role_changed`,
    `membership.removed`) are catalogued `invalidate: false`, so no socket
    `changed` reaches that tab and it can open the approval modal promising
    a final lock while the server lands `awaiting_countersign`. The crossing
    therefore EMITS — and, review round 19, it emits AT THE DATABASE
    BOUNDARY, bound to the transition itself rather than to code the
    service must remember to run: the platform-owned
    `Membership_t4d_role_standing` trigger, on exactly the zero↔one
    crossing of the `architect` count it has just applied — and NEVER
    under the project-delete cascade (review round 26: the cascading
    `Membership` delete would otherwise cross to zero and emit a
    `DomainEvent` whose tenant FK names the project being deleted, so the
    parent delete is rejected; the trigger recognizes the cascade exactly
    as the register seal does — `pg_trigger_depth() > 1` AND the
    transaction-local `Project_t4d_deleting` flag — and there applies no
    delta and emits nothing, the register row and the memberships falling
    with the project — for the project that CAN be hard-deleted, which is
    an EVENT-FREE one (review round 27: `DomainEvent.tenant` references
    `Project` with `onDelete: Restrict`, so a project that ever crossed
    holds its committed `membership.standing_changed` event and its hard
    delete is refused at that FK before any cascade runs; the supported
    path for a live project is `archive`, §A.2's parking, and a sanctioned
    reset that first disposes of the event store is out of this plan's
    scope); the cascade probe therefore deletes an event-free project with
    memberships but no architect ever active and asserts the delete
    succeeds with no emission, no delta and no register row, AND
    hard-deletes a project holding an active architect and asserts the
    delete is REFUSED by the tenant FK with the event, the fact and the
    register row intact — never worked around) — calls the
    platform-owned SQL twin of `emitEvent` — `platform_emit_event(projectId,
    eventType, entityType, entityId, payload, actorId DEFAULT NULL,
    actorRole DEFAULT NULL)`, a kernel primitive that locks and increments
    `ProjectEventStream`, writes the `DomainEvent` envelope with the
    catalog's own dispatch intent and — review round 24 — the actor the
    caller states: a NULL actor is the SYSTEM mode (`system:membership-standing`,
    the standing trigger's), a non-NULL actor is the HUMAN mode writing the
    envelope's actor fields exactly as `emitEvent` writes a command actor's
    (the decision seals of §A.2 pass the paired fact's actor; a twin without
    the argument would have attributed every hand-run forward, countersign,
    resolution and rejection to the system), and materializes one
    `OutboxDelivery` per consumer in `OutboxConsumerCatalog` EXACTLY as
    `emitEvent` does, its function body canonical-pinned (the 4c-iii-r
    marker-seal discipline) with a tripwire asserting the SQL twin and the
    TypeScript `emitEvent` produce byte-identical rows for the same input
    in BOTH actor modes (the system mode against `emitEvent` with the
    system actor, the human mode against `emitEvent` with a command actor —
    review round 24) — one signal-only event `membership.standing_changed` `{ role:
    'architect', from, to, membershipId, streamPosition }` — carrying no
    actor, since the trigger has no human to record truthfully and the
    consumer attributes to the envelope's system actor rather than deriving
    one (review round 20), and the `transitionId` the row write named in
    `Membership.lastTransitionId` (review round 22 — the fact is inserted
    before the write, so the trigger carries its id without a table read),
    the FACT carrying the event's id in turn (`standingEventId`, UNIQUE,
    review round 21), so an audit row naming this event traces to exactly
    one transition and no writer can pair them otherwise — (project-scoped,
    `invalidate: true`, no push family, in both catalogs and
    `orgsManifest.producesEvents` — the orgs table is its source, the kernel
    its carrier, the manifest's own words), which the external-effect
    dispatcher turns into the ordinary per-project socket `changed`, so
    every open tab on the project refetches and its next read carries the
    kernel overlay; and which the decisions-owned ordered consumer
    `decisions.effects` consumes (below) for the re-notification. Round 18
    had the orgs service emit it; a receipt proves a command ran, not that
    the service's side effects ran (direct SQL can reserve, write and
    complete a receipt in one transaction — the platform receipt seal says
    so itself), so a side effect that must hold for EVERY writer is bound
    where every writer passes: the row trigger. This is not round 10's
    signal returning: that one was decisions-owned and existed to refresh a
    STORED projection value; this one refreshes CLIENTS and drives the
    re-notification, stores nothing, and cannot be bypassed by any writer
    that reaches the table. P29b gains the arm: two sessions, the second
    holding a loaded `pending` decision; the first adds the first architect
    → the second receives `changed`, refetches, and its modal reads the
    countersign copy; the same with the architect INSERTED BY DIRECT SQL
    under a hand-run receipt (review round 19) — the event still emitted,
    the tab still refreshed, the re-notification still delivered;
    A-active/B-added emits no signal (1 → 2 is not a crossing), and the last
    architect leaving emits it once.

    SECOND, the writer boundary is the COMMAND LEDGER, recorded as an
    IMMUTABLE FACT PER TRANSITION (review round 19 — round 17 put a
    rewritable `sourceCommandId` on the `Membership` row itself, which
    erased the link to the earlier transition on every re-role and left the
    column freely updatable once the row was no longer an architect;
    trusted evidence is append-only): the orgs-owned
    `MembershipTransition(id, projectId, membershipId, fromRole, fromStatus,
    toRole, toStatus, actorId, sourceCommandId NOT NULL, standingEventId,
    at)` fact — `standingEventId` nullable, UNIQUE, an FK to
    `DomainEvent(eventId)`, REQUIRED exactly when the transition crossed
    zero↔one and naming the `membership.standing_changed` event this
    transaction emitted for this membership (review round 21), set by the
    one sealed NULL→event-id update below (review round 23) —
    a same-project composite FK to `Membership(projectId, id)` that is
    `DEFERRABLE INITIALLY DEFERRED` (review round 23: on `members.add` the
    fact is inserted BEFORE the membership row it names exists — the
    service preallocates BOTH ids — so an immediately-checked FK would refuse
    the documented ordering; the deferred check holds at commit, and the
    pairing seal already refuses an orphan fact), a same-project composite
    FK to
    `CommandExecution(projectId, id)` (immediate — the receipt is reserved
    before the fact), the `(projectId, sourceCommandId)` one-use UNIQUE,
    every column immutable under the uniform contract (append-only + the
    named `MembershipTransition_t4d_no_truncate`, in `TRUNCATE_SEALS`) WITH
    EXACTLY ONE sealed exception (review round 23 — the fact is inserted
    before the membership write that emits its event, so it cannot be born
    with the event's id, and a column-immutable fact could never acquire
    it: every first-architect activation and last-architect deactivation
    would roll back at the pairing seal): the append-only trigger ADMITS
    the single UPDATE shape `OLD."standingEventId" IS NULL AND
    NEW."standingEventId" IS NOT NULL` in which every other column is
    byte-equal between OLD and NEW and the named event is a
    `membership.standing_changed` `DomainEvent` of THIS transaction whose
    `entityId` is the fact's `membershipId` and whose payload
    `transitionId` is the fact's own id (a kernel `DomainEvent` read, the
    same read the deferred pairing seal makes), and REFUSES every other
    UPDATE — any other column changed, a non-NULL `standingEventId`
    rewritten to anything, a NULL set to an event of another type,
    membership or transaction, or to one whose payload names a different
    fact — and every DELETE; the writer (the orgs service, or a hand-run
    bundle reproducing it) performs that one UPDATE after the membership
    write, and the deferred pairing seal still requires the column non-NULL
    for every crossing fact at commit (RED SITES: the crossing fact left
    NULL → refused at commit; the second rewrite refused; the cross-named
    event refused; the non-crossing fact given an event refused, since no
    event of this transaction names it), registered in
    `orgsManifest.ownsModels`/`readEncapsulated`. `Membership` itself gains
    no provenance column. The orgs-owned `Membership_t4d_architect_provenance`
    seal pairs the fact BOTH WAYS on exactly the writes that can flip
    architect standing: a DEFERRED constraint trigger on `Membership`
    requiring, for any INSERT or UPDATE whose OLD or NEW role is
    `architect`, exactly one same-transaction `MembershipTransition` row
    for that membership whose `(from, to)` equals the transition the write
    made (the forward-door discipline) and — review rounds 21 and 22 — bound to
    its crossing event AT THE WRITE, never chosen afterwards: the fact is
    inserted FIRST with a preallocated id (`standingEventId` still NULL),
    the membership write names it in the orgs-owned pointer column
    `Membership.lastTransitionId` (a pointer to the latest transition, NOT
    evidence — the evidence is the fact; the column is rewritten by every
    standing-flipping write, and the seal requires it to name a fact for
    THIS write), the platform standing trigger reads `NEW."lastTransitionId"`
    from the row it is handed (no table read) and carries it in the crossing
    event's payload as `transitionId`, and the deferred pairing seal
    requires at commit that the fact the row names exists in this
    transaction for this membership with matching `(from, to)`, that its
    `standingEventId` names the one `membership.standing_changed` event of
    this transaction whose payload `transitionId` is that fact (a kernel
    `DomainEvent` read), and that no other crossing event names it — so two
    same-direction transitions of one membership in one hand-run
    transaction cannot swap their events, each event naming the fact the
    row write itself named (round 21 had the service search `DomainEvent`
    after the write, an association a hand-run writer could pair either
    way); a BEFORE INSERT OR UPDATE OR DELETE
    trigger on `Membership` that — review round 20 — whenever the write
    FLIPS active architect standing (`before ≠ after`, computed from
    OLD/NEW exactly as the register trigger computes it) calls
    `phase6_try_readiness(pid)` and refuses as contended if the key is held:
    the delivered §B.1 try-acquire protocol the membership guard already
    applies to holder-relevant writes, which short-circuits for a plain
    architect INSERT because it reduces no existing role — without it a
    hand-run activation never touches the readiness key, so an approval
    holding the key could observe no architect, write `pending → approved`,
    and let the unblocked activation commit first, terminal `approved`
    though the chain activated before it; with it every activation and
    deactivation, service or hand-run, serializes with `approve` and the
    stranded resolution on the ONE key; and, on the fact, a BEFORE INSERT
    trigger calling the delivered `phase6_t4c_provenance_reserved` (the
    receipt RESERVED now, of an orgs membership command type, by the
    recorded actor) AND — review round 20 — re-judging the recorded actor's
    AUTHORITY at the database boundary with the service's own predicate,
    since a hand-written receipt can name any actor: `MembersService.canManage`
    admits the project's PMC (an active `pmc` membership on THIS project)
    or an org owner/admin (`OrgMembership.role IN ('owner','admin')` for
    the project's org), judged — review round 22 — against the standing the
    transaction STARTED with: for the membership's own user (a
    self-transition, which `updateRole` permits — a PMC re-roling themselves
    to `architect` would otherwise pass the service check, mutate the row,
    and fail the seal on their post-state) the fact's own
    `fromRole`/`fromStatus` ARE the captured pre-state and `fromRole = 'pmc'
    AND fromStatus = 'active'` satisfies it; for any other actor the
    current predicate; so the seal refuses a fact whose `actorId` holds
    neither — an active contractor named on a hand-reserved
    `members.updateRole` receipt cannot record, and thereby authorize, a
    transition into `architect` (an orgs-owned trigger over orgs-owned rows,
    under `phase6_try_readiness`; P29b gains the ineligible-actor probe),
    paired with the DEFERRED, TABLE-SPECIFIC
    `phase6_t4d_membership_transition_bound` requiring at commit that the
    cited command SUCCEEDED naming `NEW."membershipId"` as its result
    (review round 17: the delivered `phase6_t4c_provenance_bound` binds
    `resultRef = NEW.id`, which here would be the fact's own id, not the
    membership's; the register needs no binding, its only writer being a
    trigger) AND that a same-transaction `Membership` write matching the
    fact exists (an orphan fact refused). A hard DELETE of a row whose OLD
    role is `architect` is refused outright except as the cascade of the
    project's own deletion (depth and flag, as above) — the product removes
    an architect by status, and the removal IS a transition the fact
    records. That is the rule every 4c fact already lives under, applied at
    the one orgs row whose standing decisions depend on, and it makes the
    three orgs membership mutations that can touch an architect —
    `members.add` (re-activation of a removed member goes through it),
    `members.updateRole`, `members.remove` — COMMANDS on the ledger in
    4d-ii, each writing its `MembershipTransition` row: `executeCommand`
    with an idempotency key and `resultRef` = the membership id, the routes
    and the web store carrying the key, the §A command-level readiness-lock
    enumeration gaining all three. They are not today (`members.service.ts`
    takes `lockProjectReadiness` and writes no receipt;
    `worker-devices.service.ts` is the orgs precedent for the ledger). The
    trust boundary is the ledger's own, stated where the platform seals it
    (`20270425000000_platform_command_receipt_seal`: no trigger can
    distinguish the application from SQL that reproduces the protocol by
    hand — reserve, write, complete, in one transaction) — and THAT is why
    no side effect is left to the service (review round 19): the
    re-notification and the tab invalidation are bound to the crossing at
    the database boundary above, so an architect B written by hand-run SQL
    under a hand-completed receipt after A left still emits
    `membership.standing_changed`, still refreshes every tab and is still
    re-notified. The re-notification lives in a NEW decisions-owned ORDERED
    outbox consumer `decisions.effects`, registered beside
    `decisions.inbox` with `decisionsManifest.consumesEvents` gaining
    `membership.standing_changed` and `project.restored` (the
    ordered-consumer delivery-count pins advance): on
    `membership.standing_changed { to: 0 }` its handler cancels by subject,
    under each decision row lock, every not-yet-sent `countersign` delivery
    of the project's awaiting decisions (review round 24 — the
    last-architect cancellation §A.2 bound to the service mutation is
    derived here instead, so a hand-run deactivation cancels exactly as the
    service one does); on `membership.standing_changed { to: 1 }` its
    handler runs the module's own `renotifyAwaitingCountersign` under
    `lockProjectReadiness` for every decision whose awaiting entry precedes
    the crossing's stream position (an approve committing after the
    crossing but before the handler is notified by its own approve and
    skipped), and deciding, per decision and UNDER THE DECISION ROW LOCK, from the
    decisions-owned append-only `DecisionCountersignNotice(projectId,
    decisionId, deliveryId, standingPosition, at)` fact (review round 25 —
    round 24 neutralized only still-pending deliveries, but the ordered
    consumer is not ordered against the independent, unordered
    `webpush.notify` worker, which can claim and send the ORIGINAL
    countersign demand to the new architect B before either crossing is
    handled, after which cancelling finds a succeeded row and the re-emit
    sends B a second demand): the countersign family's send hook, in the
    transaction that records its send and under the same decision row
    lock, appends the notice naming the delivery and the register's
    `lastCrossingPosition` it resolved the holders against; the handler
    then SKIPS a decision whose latest notice names a `standingPosition`
    at or after this crossing (the demand already reached the current
    standing), SKIPS one whose countersign delivery is still pending (it
    resolves the current holders at its own send and writes its notice),
    and emits the replacement ONLY when the latest notice pre-dates the
    crossing — the demand went to the displaced architect — or none exists
    after the round-24 cancellation; because the send and the handler
    serialize on the one decision row lock, every interleaving leaves
    exactly one demand at the current standing; on `project.restored` it runs
    the kernel's `releaseParked(projectId)` on the deliveries archival
    parked (review round 21 — no re-emission); both keyed per (subject or
    delivery, eventId) so a redelivery appends nothing, the re-notification
    emitting through the outbox inside the handler transaction. **And history is a no-op** (review round 20): when a
    consumer is first registered, the relay's `expandMissingDeliveries`
    creates a delivery for EVERY historical `DomainEvent` through the
    consumer's own `deliveryFor`, so a fresh `decisions.effects` would
    process every `project.restored` ever emitted (harmless once
    restoration only RELEASES parked rows, since none pre-date the
    consumer, but still one delivery and one release pass per historical
    event — and the cutover keeps history a recorded no-op regardless of
    what a later handler does). The
    4d-ii catalog-data migration that registers the consumer therefore
    records its registration CUTOVER — the maximum `DomainEvent.streamPosition`
    per project at registration, in a platform-owned
    `OutboxConsumerCutover(consumer, projectId, sincePosition)` table that
    4d-i CREATES EMPTY and seals (review round 22 — the dark migration unit
    is the schema's seam, and an empty table activates nothing) and that
    4d-ii's catalog-data migration FILLS THROUGH THE SEAL'S ONE-TIME FILL
    ARM (review round 26 — round 24 had the seal armed only after the
    fill, leaving the table open to a preseeded `sincePosition` between the
    two units; the seal installed by 4d-i instead admits an INSERT ONLY when
    the transaction-local setting `phase6.t4d_cutover_fill` names the
    consumer AND that consumer's `OutboxConsumerCatalog` row was inserted
    in the CURRENT transaction — `xmin = txid_current()::text::xid`, the
    conversion `20270425000000_platform_command_receipt_seal` already uses
    (review round 27: PostgreSQL has no equality operator between the
    `xid` system column and the `bigint` `txid_current()` returns, so the
    literal predicate would error and block the catalog migration) — so the
    registering migration alone can fill, in the one transaction that
    registers, a preseed before registration is refused for want of the
    in-transaction catalog row, and every later INSERT is refused for want
    of both) in the one transaction that registers the consumer (the catalog row itself is unchanged; registered
    in `platformManifest.ownsModels`) — IMMUTABLE and CLOSED once registered
    (review rounds 21 and 22: `sincePosition` decides which durable events
    execute, so a raised value would silence a genuine post-registration
    restore, a lowered or deleted one would replay history, and a row ADDED
    later for a project registered without one — a project created after
    registration has no row and needs none — could set an arbitrary
    `sincePosition` that silences its genuine restores and standing changes;
    so the BEFORE INSERT OR UPDATE OR DELETE seal 4d-i installs refuses
    every rewrite and every INSERT outside the one-time fill arm above
    (review rounds 24 and 26) — and the registration-and-fill phase of that
    `ALWAYS_EXECUTE` migration is GUARDED AS A WHOLE (review round 24): it
    runs only while the consumer's `OutboxConsumerCatalog` row is ABSENT,
    and an already-registered consumer skips registration and fill without
    issuing a single INSERT (an `INSERT … ON CONFLICT DO
    NOTHING` still fires the BEFORE INSERT trigger and would be refused;
    dropping the seal for the replay would reopen the history boundary),
    so the P3005 replay and every later deploy pass, P38 probing a SECOND
    execution of 4d-ii's file over an already-registered database — no
    error, the cutover rows byte-unchanged —, and the statement-level
    `OutboxConsumerCutover_t4d_no_truncate` refuses TRUNCATE, registered in
    `TRUNCATE_SEALS` with 4d-i and carried in the
    upgrade-proof's hostile-insert inventory) — and the
    consumer's `deliveryFor` classifies any event at or below its project's
    cutover as `noop` (recorded `succeeded`/`noop`, exactly as a
    non-invalidating event is), so the backfill scanner records history as
    done without acting on it; `membership.standing_changed` cannot
    pre-date the consumer (the event type is new), and a project created
    after registration has no cutover row and nothing historical. P38's
    baseline arm gains the probe (and, review round 22, a later INSERT of
    a cutover row for a post-registration project refused; review round 26,
    a preseeded row between 4d-i and 4d-ii refused, and the fill admitted
    only inside the registering transaction): a database
    holding historical
    `project.restored` events, the consumer registered → every historical
    delivery `succeeded`/`noop`, zero notifications, zero
    `countersign_renotified` rows; a restore AFTER registration → the
    re-emit. This consumer is NOT a projection: `decisions.inbox` stays
    recompute-only, and a projection rebuild replays nothing into
    `decisions.effects`, whose cursor is its own. Un-notified B is
    impossible not because the write is, but because the side effect no
    longer depends on who wrote. `architect` leaves the §A.2 DB-serialized
    direct-writer set, and a direct architect write is REFUSED (hostile
    probes, review rounds 16–19: INSERT, role UPDATE into and out of
    `architect`, soft removal, restore — each without a transition fact
    refused at commit, each with a fact citing no receipt refused, each with
    a fact whose receipt never completed refused at commit, each with a
    receipt borrowed from another command type or actor refused, a fact
    whose `(from, to)` disagrees with the write refused, an orphan fact
    refused; a hard DELETE refused; the fact UPDATEd, DELETEd or TRUNCATEd
    refused; a direct write to the register refused, the register erased by
    DELETE or by TRUNCATE refused, `Membership` truncated refused; each
    through the service succeeding, the register moving by exactly one in
    the same commit with the crossing event emitted; the hand-run-receipt
    write succeeding with the SAME event, refresh and re-notification); the
    operator repair stays the service re-role (P28b), and the 4d-i audit is
    unaffected (a migration's own statements run before the seals exist;
    4d-i backfills the register at zero, which the audit proves true — no
    architect can exist while reserved). **And the DTO field is
    OMITTED when false** (review round 14): `countersignRequired` is
    serialized only when true and hydrated as false when absent — the 4c-ii
    consultation precedent, absence being the pre-change default — so the
    no-chain DTO is byte-identical to today's and P29's literal byte
    identity holds; the wire-shape tripwire classifies it
    additive-when-present. Probed (P29b, RED at base): a `pending` decision
    projected → the first architect added through the service → the mirror
    flips in the same commit and the very next read of the projected row
    shows `countersignRequired: true` and the modal the countersign copy,
    no fold delivery in between; the last architect removed → the field
    absent the same way; A-active/B-added crosses no boundary and writes
    nothing (register 1 → 2); register = orgs primitive after every
    transition shape; a direct architect INSERT refused without a receipt,
    refused at commit with an uncompleted one, refused with a borrowed one;
    a hard DELETE of an architect row refused; a direct write to the
    register refused; the register erased by DELETE and by TRUNCATE refused;
    the project's own deletion cascading through it (review rounds 16–17);
    rebuild == live (the
    projection stores no such field); with no
    chain both surfaces stay byte-identical; P31's web arm drives the client
    approval path under an active chain and asserts the provisional copy —
    with the shared tripwire that walks every `DecisionStatus` value; the three
    events (`decision.forwarded`, `decision.awaiting_countersign`, the
    existing `decision.approved` from the countersign) in both catalogs with
    the two new push families, the orgs-owned `membership.standing_changed`
    invalidation beside them (review round 18), the locked `deciderPushTarget`, every
    invalidating command's cancellation-by-subject of its family's
    not-yet-sent deliveries and the consumer's final pre-send re-read —
    delivery row, each recipient's standing, project operability and, review
    round 18, the family's own subject predicate (§A.2, P40); **the two changed consumers' DURABLE
    contract versions bumped, with the matching catalog-data migration**
    (review round 2 — the 4c-ii precedent,
    `20271116000000_phase6_t4c_ii_rollout_fence`): `webpush.notify`
    (`consumers.ts`, `catalogVersion` 2 → 3, for the two new claim families)
    and `decisions.inbox` (`decisions.projection.ts`, 2 → 3, for the
    awaiting state and the forward-installed holder in its fold — the
    chain-changed signal withdrawn for good in round 15, the standing being
    a kernel-owned register the read path overlays), with the
    `OutboxConsumerCatalog` rows and `ProjectionGeneration.catalogVersion`
    migrated in 4d-ii's OWN catalog-data migration, so `syncConsumerCatalog`
    refuses a restarted or rolled-back pre-4d-ii process at startup and it
    can never claim the sole ordered delivery — its push consumer knows no
    `decision.forwarded` and would fall through to the unguarded send, its
    fold knows no `awaiting_countersign`. That is what makes the drain
    DURABLE rather than a one-time observation, exactly as 4c-ii's bump did;
    the socket consumer is not bumped (it carries no new contract). **That
    catalog-data migration joins `ALWAYS_EXECUTE`** (review round 5), as
    `20271116000000` does: the P3005 baseline loop resolves every migration
    outside the list as applied after `prisma db push`, which reproduces
    schema and never data — a restored pre-4d-ii database would keep its
    `OutboxConsumerCatalog` rows at version 2 while the binaries declare 3,
    and `syncConsumerCatalog` would refuse EVERY upgraded process at startup.
    Probed on the baseline path (the runner proof, P38): P3005 over a
    pre-4d-ii database leaves the catalog migration pending, runs it, and the
    upgraded process starts. 4d-ii
    therefore carries this ONE catalog-data migration beside its service
    change and declares the seam inseparable in its packet for the reason
    4c-ii did — the version and the code that declares it must move
    together; the orgs role mutations joining the readiness lock; the `decisions.inbox`
    projection row/fold/rebuild/filter carrying the awaiting state and the
    forward-installed holder (live == projection == rebuild, the P22/P25c
    thread); the web surfaces (the architect's countersign/disagree action
    item, the forward affordance for holder/PMC/architect, the stale-state
    banner the 4a §A.3 reader table requires for `awaiting_countersign`).
    **Still chain-off AND forward-off everywhere**, because the reservation
    stands on all three doors (review rounds 4 and 13): the
    unit ships every reader and writer while no project can exercise them,
    which is what makes the previous-release drain a pure operational step.
    Its STATUS fold SETS `blocking_directive: phase-6-4d-previous-release-drained`
    from `in_progress` (the 4c-ii shape, cleared the same way).
  - **The drain attestation** — the operator states that every process
    older than the 4d-ii release is stopped or drained, as an
    `OPERATOR-ATTESTATION` on the controlling issue naming the directive and
    the minimum release, carrying no agent-generation marker — the
    attestation covers processes ALREADY RUNNING, which no code can observe;
    the bumped consumer contracts above fence every process that STARTS,
    which is what keeps the attested state durable afterwards. **Browser
    tabs cannot be drained, so they stand behind a CLIENT CONTRACT boundary
    instead** (review round 9): the delivered `RecordedCompatInterceptor`
    already treats `x-vitan-decisions-contract: recorded-v1` as the 4b
    boundary, and a pre-4d tab sends exactly that, so once 4d-iii lets a
    chain activate such a tab could approve a decision, receive the unknown
    `awaiting_countersign`, report "Approved & locked", fall through the
    chip fallback and hold no countersign-aware action state. 4d-ii
    therefore introduces the next contract value `countersign-v1` (the web
    gateway declares it on EVERY request that reaches the API — `req()` and,
    review round 15, the direct `fetch('/auth/session')` in
    `ApiGateway.connect()` that `useApiSync` takes under `DEV_AUTH` with only
    a `Content-Type` header today, which would present the NEW bundle's
    architect session as a stale client and drop API initialization to local
    data; the client-boundary tripwire enumerates every `fetch(` site in the
    gateway and asserts the header on each API-bound one)
    and a sibling transport-layer interceptor beside the untouched 4b one:
    for a request declaring less than `countersign-v1`, every
    `awaiting_countersign` row is STRIPPED from a `decisions` array at the
    boundary (an awaiting decision demands nothing a pre-4d tab could do —
    the architect's action needs the new role, the PMC's is to wait — so
    hiding it until the next full load loses no actionable state, the 4b
    reasoning verbatim), and the four 4d-touched commands (`approve`,
    `forward`, `countersign`, `disagree`) REFUSE such a request with a
    409 naming the contract and asking for a reload whenever the project's
    chain is ACTIVE — a stale tab can never approve INTO a status its bundle
    cannot render, while with no chain the approve stays byte-identical.
    **That refusal is judged INSIDE the command, under the lock, never at
    the transport** (review round 11): a boundary-time chain read can race
    the activation it guards — a `recorded-v1` approve observes no
    architect at the interceptor and passes, the first architect activation
    commits, then `approve` takes `lockProjectReadiness`, sees the active
    chain and lands `awaiting_countersign` for a bundle that cannot render
    it. So the interceptor is the READ-side strip only; the declared
    contract travels with the request into the command (the request-scoped
    context the actor already rides) and each of the four commands
    re-judges it AFTER acquiring `lockProjectReadiness` — the same lock
    under which the chain presence decides the approval's outcome —
    refusing 409 before any write when the chain is active and the client
    declares less than `countersign-v1`. P29c barrier-tests the
    activation-between-check-and-approve ordering: the stale approve is
    HELD after its boundary pass, the activation commits under the lock,
    the approve resumes, acquires the lock and is refused — no awaiting row,
    no provisional revision, no notification — and the same sequence with a
    `countersign-v1` client lands `awaiting_countersign` exactly once.
    The boundary is dark until 4d-iii like everything else and is probed
    BEFORE the role is enabled. **And the boundary is SHAPE-COMPLETE, not
    status-only** (review round 11): after 4d-iii a stale bundle also meets
    a `pending` decision whose `deciderKind` is `architect` (its
    `deciderNoun` renders the client, its `viewerIsDecider` returns false)
    and an `architect` SESSION (a token role its role maps do not contain),
    both of which exist before any decision is awaiting. So for a request
    declaring less than `countersign-v1` the interceptor strips every
    decision row carrying a shape the contract introduced — `status =
    'awaiting_countersign'` OR `deciderKind = 'architect'` — from every
    `decisions` array (an architect-designated pending decision demands
    nothing a pre-4d non-architect tab could do that a reload does not
    restore: the PMC's withdraw waits for the next full load, the 4b
    reasoning again); the session/shell read for a user whose token role is
    `architect` is REFUSED with the same reload 409 (a role the bundle cannot
    map is not hidden, it is refused — there is no stale-safe rendering of
    an architect's own session) — and, review round 12, so is every response
    that can hand the role to a stale tab BEFORE that shell read: the
    delivered web store applies the role a switch returns before it fetches
    the shell (`loadOrgData` → `switchProject` → `applyAuthResult` sets the
    session role from the `/auth/switch` result and only then loads the
    shell), and `/me/memberships` and `/projects/:projectId/members` list
    role values verbatim, so a `recorded-v1` tab signed in under another
    role could accept a membership list naming `architect`, switch into that
    project and hold a role its role maps do not contain. For a lesser
    client the boundary classifies the three — and, review round 19, EVERY
    token-minting response with the first: `/auth/switch` into an
    architect membership is REFUSED with the reload 409 (never a token the
    bundle cannot map), and so is an architect SIGN-IN through
    `/auth/login`, `/auth/password/complete`, `/auth/otp/verify`,
    `/auth/email/verify` and `/auth/google` — each returns the same
    `TokenResult`, whose `role` the delivered store hands straight to
    `screensFor` in `applyAuthResult`, and a cached `recorded-v1` bundle has
    no `architect` key, so it would fail there before any shell read could
    return the 409; the tripwire enumerates every route whose service
    method returns `TokenResult` (`/auth/worker/token` is the device flow
    and mints no role a bundle maps) and asserts each is classified — `/me/memberships` has its architect memberships
    STRIPPED (the tab cannot enter them; the next full load restores them),
    and the roster `/projects/:projectId/members` has its architect rows
    stripped likewise (display-only on a stale tab, restored on reload), and
    — review round 17 — so does `/me/portfolio`: `OrgsService.portfolio`
    builds its rows from `Membership.role` verbatim and a still-open tab
    refreshes it unconditionally, so a `recorded-v1` PMC tab re-roled to
    architect would otherwise receive the new enum through a route neither
    stripped nor refused, render the project card and offer an Open the
    switch then rejects — for a lesser client the architect rows are
    STRIPPED from the portfolio (the card absent until reload); the
    tripwire below carries `Membership.role = 'architect'` as a wire shape
    with these three sites classified; `decisions.create`/`updateDraft` naming
    `deciderKind: 'architect'` and `decisions.forward` to the role are
    refused for a lesser client by the same in-command check; the additive
    field `countersignRequired` passes through as a field a stale bundle
    ignores (present only when true, round 14); and — review round 15 —
    `ChangeRequest.origin` is NOT additive-ignorable: a `recorded-v1` PMC
    tab receiving a `change` decision whose open request is a
    `countersign_rejection` ignores the origin, its `mayWithdraw` renders
    Withdraw for every PMC, and the queued `withdrawChange` is then refused
    by the server — an action offered that cannot be performed — so for a
    lesser client the interceptor STRIPS every decision row whose open
    change request carries a non-`standard` origin (the decision is inside
    the architect's chain; the PMC's next full load restores it), the row
    classified strip beside the awaiting and architect-designated shapes,
    the server's `withdrawChange` refusal remaining the backstop. A TRIPWIRE pins completeness: a test enumerates every enum
    value and column 4d adds (`DecisionStatus.awaiting_countersign`,
    `DeciderKind.architect`, `TokenRole.architect`, `Membership.role =
    'architect'` on the membership, roster, switch AND portfolio responses
    (review rounds 12 and 17), `TokenResult.role = 'architect'` on every
    token-minting response (review round 19), `ChangeRequest.origin`,
    `countersignRequired`, the
    `DecisionForward` DTO) and asserts each is
    classified strip / refuse / additive-ignorable with its server-side
    refusal named, so a 4d shape added later without a classification fails
    it. P29c gains the stale-client arms — a pending architect-designated
    decision absent from a `recorded-v1` snapshot and present for
    `countersign-v1`; an architect session refused on the shell read for
    `recorded-v1` and served for `countersign-v1`; an architect signing in
    through EACH token-minting route refused for `recorded-v1` with the
    reload 409 and served for `countersign-v1` (review round 19); a
    `recorded-v1` tab
    holding a PMC session seeing no architect membership in `/me/memberships`,
    no architect row in the roster and no architect card on `/me/portfolio`
    (review round 17), and refused on `/auth/switch` into an
    architect membership, while `countersign-v1` sees both and switches
    (review round 12); a `recorded-v1`-only
    client under an active chain refused on approve (never told "Approved &
    locked") and receiving no awaiting row, while a `countersign-v1` client
    sees and drives everything; the P38 startup-fence probe already covers the server
    processes the attestation cannot — the record
    STATUS's own rule requires (the #530 lesson: nothing an agent writes
    supplies it). **BOARD DECISION carried from 4c (2026-08-29, on PR
    #480)**: an operator-declared directive, NO automated drain actor. Why
    the drain matters for 4d, stated concretely: a pre-4d instance's Prisma
    client fails to READ any `Decision` row whose `status` is a value its
    generated enum does not know, and its zod `TokenRole` refuses to mint a
    JWT for an `architect` member — so a project whose chain activates while
    an old instance still serves is a split brain of exactly 4c's class, per
    project, for that project's decisions and that member's sign-in. The
    reservation makes that state unreachable until the fleet is attested
    drained.
  - **4d-iii, the reservation retirement**: a migration-only unit that
    drops ALL FOUR reservation doors — `Membership_t4d_architect_reserved`,
    `DecisionForward_t4d_reserved`, `Decision_t4d_architect_reserved` AND
    `Decision_t4d_awaiting_reserved` (review round 24: this list had named
    three, which would have left every approval under an active chain
    refused at `awaiting_countersign` after the rollout opened) — with their
    shared function (review rounds 4, 13 and 24), its closing check naming
    each of the four AND the two
    kept finality defaults (`finalized`, `revisionFinalized` — after the
    drain only writers that state the pin remain, §A.2; review round 1) AND
    installs the trailing INSERT-time seal requiring `sourceCommandId` on
    every new `ChangeRequest` row (§A.3 obligation 6; review round 3) AND
    writes the sealed `RolloutRetirement` marker 4d-i's transient block keys
    on (review rounds 5 and 7) — the write is `INSERT … ON CONFLICT (unit)
    DO NOTHING` under the `SET LOCAL` gate, so the ordinary later deploy that
    re-runs an `ALWAYS_EXECUTE` migration over the immutable row neither
    aborts on the primary key nor rewrites it, and the closing verification
    requires the row to EXIST (review round 8; probed by applying 4d-iii
    twice: one row, no error) — re-runnable — every replay re-drops the
    FOUR triggers AND their shared function `IF EXISTS` (review rounds 15
    and 20)
    and then CHECKS the
    retirement complete exactly as 4c-v's closing block does, raising if a
    trigger or the function remains (review round 7) — in `ALWAYS_EXECUTE`
    after 4d-i, with the mirror probes
    (P28b; the old-write-shape inserts of P42 now refused) and the proof's
    before/after structure exactly as 4c-v did for 4c-iii's seal.
    There is NO backfill (chain activation is a per-project product act by
    the PMC, never a database default) and NO preservation seal (nothing
    must be kept present), so 4d has no analogue of 4c-iii/4c-iv and no
    third gate: 4d-iii carries no rollout prerequisite of its own — an
    architect membership is written only by the new release, and once the
    old release is drained there is no reader that can be surprised by it.
    **4d is complete when 4d-iii merges**, and the §E handoff to the
    remaining decision-workflow scope (the master plan's post-4d items, none
    of which is authorized by this plan) follows it.
- **Not in 4d, stated so the review can hold the line**: no rename
  (`room` → `space`), no external collaboration, no change to approval
  history (the register stays append-only in every respect but the one
  paired `finalized` flip — the delivered `_append_only` trigger replaced by
  a seal admitting exactly that flip, review round 10; `finalized`,
  `approvedFrom` and `approvedByName` are the additive columns and the flip
  is the one paired transition), no UX or performance
  work beyond the surfaces §A.2 names, and no contractor-capture unit (units
  1–6 stay Board-gated).

## What carries forward

- The binding ledgers of `docs/reviews/pr-335-convergence.md` and
  `docs/reviews/pr-340-convergence.md` — every decision above annotated with
  its round is carried from them, none reopened.
- 4a's delivered seal network, audience rule, cancellation spine, and
  linkability authority; 4b's delivered decider model, targeted push spine,
  §B.1/§B.2 primitives, holder freeze and orphan guards; 4c's delivered
  consultation register, the try-readiness protocol as a primitive, the
  command-provenance shape, the per-family push predicates, and the
  dark-migration → drain → enable rollout discipline — extended by
  reference, never rewritten.
- The owner's recorded intent: decisions decided by the right party, issues
  filed without ceremony, consultation that informs without gating, and an
  architect who countersigns without becoming a bottleneck nobody can route
  around.
