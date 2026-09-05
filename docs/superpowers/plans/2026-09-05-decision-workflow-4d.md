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

**Review lineage.** This document is the REPLACEMENT of PR #539 (`Replaces: #539`),
itself the replacement of #538, which replaced #537 — the same docs-only unit
and nothing else, three times rebuilt from the same `main`. Round 1 on #537's first head
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
all thirty-five fixes, the four annotated "(review round 6)". No design
decision carried from `6a53aae` was reopened; every fix is a precision this
plan owed and had not stated.

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
  `Decision`, `deciderMembershipId` bound by the composite FK to
  `Membership @@unique([projectId, id])`, the holder tuple frozen from
  publication by `Decision_t4b2_lifecycle_seal` / `phase6_t4b2_decision_seal`
  — the WRITE-ONCE door §A.2 loosens by exactly one opening), the orgs-owned
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
`decisionsManifest.permissions`, the membership-role comment in
`schema.prisma`, and every `ROLE_POLICY` entry the role belongs in
(`packages/shared/src/domain/policy.ts`; the exact policy row set is the
unit's FIRST deliverable — `project.read` certainly among them,
`decision.approve`/`decision.change`/`decision.withdrawChange`/
`decision.updateDraft` and `consultation.respond` where the architect can be
the HOLDER or a consultee, `consultation.request` because the architect joins
the requester set (the 4c hand-off), the four NEW 4d actions of §A.2, and
`decision.create`/`decision.publish`/`decision.withdraw` deliberately NOT —
issuing and withdrawing stay the PMC's) — with the `route-policy.test.ts`
walk ("every role-gated endpoint carries a `@RolesFor` action and its roles
ARE `ROLE_POLICY[action]`"; "every `ROLE_POLICY` action is exercised by at
least one gated route") pinning whatever it says (P28). **The fan-out
includes the PRODUCT PATH that mints memberships** (`6a53aae` round 2): the
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
carry the role — which is what keeps a still-serving pre-4d instance safe
(§D states the two concrete failures the reservation prevents). "Activating
the chain" is thereafter a per-project PRODUCT act — the PMC adds an
architect member — never an operator step.

### 2. Orchestration

The settled design, plus the owner's 2026-08-13 amendment, as behavior:

- **Forwarding**: an append-only `DecisionForward` chain — `projectId`,
  `decisionId`, `fromDesignation` (the DISPLACED holder: kind + membership),
  `toDesignation` (the new one), **`forwardedById` (the ACTOR — round 2:
  forward authority includes non-holders, so a PMC forwarding a client-held
  decision is recorded as the PMC displacing the client)**, `reason`, `at`,
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
  write-once trigger (`phase6_t4b2_decision_seal`, the holder arm) loosens to
  exactly one opening — a change accompanied by a same-transaction
  `DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns
  and whose `toDesignation` EQUALS the NEW ones. Mere row presence is
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
  **Forwarding SERIALIZES against approval and countersign** (round 1): each
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
  holder exactly as it invalidates the decider's); countersign, disagree
  and the stranded resolution cancel that decision's `countersign` delivery
  (the demand is gone, whichever way); **the PMC's `withdraw` cancels that
  decision's `decider` AND `forward` deliveries** (review round 4 — the
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
  otherwise be sent to a removed architect) — **and the mutation that
  RE-ACTIVATES the chain re-notifies** (review round 6): the decision stays
  `awaiting_countersign` by design, so approve → architect A removed (its
  delivery cancelled, irreversibly — the mark is terminal) → architect B
  added would leave B authorized to countersign with no delivery and no new
  event to raise one. The orgs mutation that ACTIVATES an architect (add,
  restore, role change INTO `architect`) therefore, under the SAME readiness
  lock and in the SAME transaction, invokes the decisions-owned
  `DecisionsParticipant.renotifyAwaitingCountersign(tx, projectId, actor)` on
  the EXISTING orgs → decisions participant edge (`orgs.workflowParticipants`
  already names `decisions`), which re-emits `decision.awaiting_countersign`
  — the same catalog entry, family and body, payload `{ renotified: true }` —
  for every decision of the project currently `awaiting_countersign`,
  appending a `countersign_renotified` `DecisionEvent` attributed to the
  activating actor; the projection fold is a status no-op and the push family
  claims it exactly as the original. Exactly once, never twice: the re-emit
  enumerates decisions ALREADY awaiting at activation, and approve serializes
  with the activation on the readiness lock (P36), so a decision approved
  after the activation is notified by its own approve and one approved before
  it by the re-emit — the ordering barrier in both directions asserts one
  delivery per decision, and an activation with no awaiting decision emits
  nothing (P29b). Preserving the cancelled delivery instead was weighed and
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
  the same disclosed class as (iii); (iii) the residual — an invalidating command
  committing after that final re-read and before the provider accepts the
  send — is a stale NUDGE to the displaced holder
  carrying no decision content (the push body names no option, and the
  displaced holder opens a decision they no longer hold, whose surfaces
  already follow the forward), the same class as the 4c stale-tab residual
  the Board ruled on, and it is recorded as such rather than claimed away.
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
  review round 6); the delivery row after a partial fan-out `succeeded` /
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
  `resolvedById` + frozen display name, `reason` — user-supplied evidence
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
  4d-ii widens that predicate with `awaiting_countersign`; and
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
  it to the ARCHITECT as their action item; withdraw refuses it — an approval
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
  `revisionId` countersigned, `countersignedById` + frozen display name,
  `at`, the provenance shape; composite FKs same-project, immutable like the
  register), and the `finalized` false→true flip is trigger-PAIRED to a
  same-transaction pairing fact for that exact revision — the
  `DecisionCountersign` row (the chain path), or the
  `DecisionStrandedResolution` row with outcome `'completed'` (the ONLY other
  legal finalizer — the PMC's stranded resolution, above) — the forward-door
  discipline applied to finality. A finalized-only flip with NEITHER fact is
  unrepresentable, probed directly (P31). **And the BIRTH value is sealed
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
  (P31). **The transition EMITS its own truth** (round 3):
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
  'change'` (CHECK-pinned; written by every approve from 4d-ii; NULL only on
  pre-4d legacy rows, which are finalized and will never be finalized again,
  and REQUIRED — the birth seal's arm — on any revision born `finalized =
  false`), and the countersign, or the stranded `'completed'` resolution,
  emits `decision.reapproved` when `approvedFrom = 'change'` and
  `decision.approved` otherwise. The audit register keeps its shape: the
  provisional approve still appends its `approved`/`reapproved`
  `DecisionEvent` (the act happened and is attributable), and the finalizer
  appends a `countersigned` (or `stranded_resolved`) `DecisionEvent` — the
  4c cycle count reads revisions, not events, and is untouched. The
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
  seal-trigger cross-table standing read. **And the membership seal judges
  CONTENT, not only timing** (round 5): the delivered
  `phase6_t4b2_membership_guard` already re-judges the holder-orphaning
  predicate at the DB for `pending`/`change` decisions (P39's DB arm); 4d-i
  EXTENDS its open set with `awaiting_countersign` for the NAMED holder and
  the ROLE designations it guards today — and deliberately does NOT add the
  architect role to it: the last architect leaving is the chain
  DEACTIVATING, resolved by the named command above, never a refused
  removal. The hostile direct soft-removal AND the hostile role-change of an
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
  behavior) and `revisionFinalized = true` on every existing spec row. **The
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
  and rebuilt paths alike (a pre-4d stored DTO with no origin reads as
  `'standard'`, which is exactly true of every pre-4d request), and
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
its referrers) — its one foreign CODE change is the readiness lock joining
the orgs role mutations (an edit the orgs module makes to its own commands)
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
   transaction so the UNIQUE is not the only thing standing. Absorbed into
   §A.3's obligation 2 for every future fact. RED SITE: the two-row hostile
   bundles. STAGING: 4d-i.
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
| P28 | the role in every mirror: `TokenRole`, both zod enums, `PushRole`, the `ROLE_POLICY` rows (§A.1's exact set), `decisionsManifest.permissions`, AND the web role pickers/labels (`TeamScreen.tsx`, `RolePicker.tsx`) — the identity walk pins the set; a membership with the new role is mintable through the shipped UI once 4d-iii has dropped the reservation — and NOT OFFERED before it: the role pickers gate `architect` on the shell's `rollout.phase6_4d` read, and `MembersService.add` refuses the role 409 BEFORE provisioning the invited `User` while the reservation stands (a new-email add while reserved → 409 and zero `User` rows; review round 5); the EXISTING targeted ceilings admit the role — a decision published to an architect holder and a consultation requested from an architect both dispatch (RED at base: `buildDispatchIntent` rejects the out-of-ceiling role and the command aborts), and the catalog tripwire over every targeted entry whose narrowing site persists a member role (review round 3); **P28b (this plan): the RESERVATION** — between 4d-i and 4d-iii a direct `Membership` INSERT or role UPDATE whose NEW row names `architect` is refused at the DB (a removed row already in that role can be neither restored nor re-keyed through it), so no project can arm the chain while a previous-release instance may still serve; after 4d-iii the same statements succeed — the mirror of 4c's reservation probe; AND the AUDIT — 4d-i applied over a database holding ANY `Membership` row with `role = 'architect'` (active OR soft-removed) ABORTS naming the rows and installs nothing; the audit runs AFTER the reservation's `CREATE TRIGGER` in the same transaction, barrier-probed in both orderings on the shipped file (writer-first → the migration waits then aborts on the committed row; migration-first → the writer waits then is refused); the operator repair is a RE-ROLE through the team role command (a soft removal leaves `role` in place and aborts the next deploy identically — asserted), or the guarded operator DELETE, and the same file then deploys (the `upgrade-proof.sh` abort → re-role → redeploy cycle; review rounds 1–2); the REPLAY arm — the P3005 baseline of a post-4d-iii database holding an active architect replays 4d-i as a no-op on its transient block (marker present) and keeps the architect, while a pre-4d-iii baseline (no marker) installs and audits (review round 5) | `types.ts`, `contracts.ts`, `external-effects.ts`, `policy.ts`, the Team screen role lists; the orgs-owned reservation trigger |
| P29 | no-active-architect byte-identity: with no architect membership ever, approve lands `approved` directly with `finalized = true`, forward is refused for the missing role's authority but works for holder/PMC, and the whole 4b/4c surface is byte-identical; **P29c (this plan): mixed-version byte-identity** — with the reservation ARMED (4d-i and 4d-ii deployed, 4d-iii not), every project is chain-off, no row can be `awaiting_countersign`, no membership can be `architect`, no `DecisionForward` row and no `decision.forwarded` delivery can exist (a service forward 409s naming the drain directive, a hostile direct forward insert is refused, no Forward affordance renders — review round 4), and every read a pre-4d instance performs on these tables sees only values its enums know; after 4d-iii all four forward arms open | the chain switch; the reservation on both doors |
| P29b | removed-architect deactivation + the stranded decision: the chain deactivates for NEW approvals; `decisions.resolveStrandedCountersign` drives BOTH outcomes (complete-under-no-chain → `approved` with finality + emission; return-to-decider → `change` with the origin-stamped open request), each writing its append-only `DecisionStrandedResolution` fact (UNIQUE per revision; the orphan-fact insert refused by the reverse pairing; a whitespace-only reason — spaces, AND a tab-and-newline-only value — refused at zod AND the CHECK; provenance-bound as the bundle's primary), the RETURNED bundle's request authored by the resolving PMC and ADMITTED by the P33b seal on that pairing (a returned-bundle request attributed to anyone else, or to an architect, refused), the `completed` outcome emitting `decision.reapproved` when the stranded revision's `approvedFrom` is `change`, end-to-end through re-approval; the bare hostile `awaiting_countersign → approved` flip under the INACTIVE chain refused without the fact; the returned-resolution bundle MISSING its `countersign_rejection` request refused at commit; refused while an architect is still active; the architect-reappears race deterministic; the RE-NOTIFICATION (review round 6) — approve → architect A removed (countersign delivery cancelled) → architect B added: exactly one new `decision.awaiting_countersign` delivery per still-awaiting decision, B receives, a `countersign_renotified` audit row attributed to the activating actor; an activation with no awaiting decision emits nothing; the projection fold a status no-op | the new resolution command + its fact table + the switch; `DecisionsParticipant.renotifyAwaitingCountersign` on the orgs → decisions edge |
| P30 | forward authority (holder/PMC/architect), ACTIVE target only, eligible states only — terminal AND `awaiting_countersign` refusals both probed through the guarded HTTP route with the shared `ROLE_POLICY` action | the forward command |
| P31 | the `awaiting_countersign` lifecycle: approval under a chain lands it with `finalized = false` — a revision BORN `finalized = true` under an active chain refused by the INSERT seal; the countersign is ONE atomic act — the attributed `DecisionCountersign` ROW + the finality flip + the `awaiting_countersign → approved` transition in one transaction, sealed from BOTH sides (the boolean-only hostile flip refused; the orphan countersign row refused at commit by the deferred reverse seal; the split two-transaction replay refused) AND attributed to an ACTIVE architect (a non-architect or removed-architect `countersignedById` refused) AND carrying provenance (an absent, foreign, spent or wrong-actor `sourceCommandId` refused — the 4c arms verbatim) + emits the finalizing event by the revision's recorded `approvedFrom` — `decision.approved` for a provisional approval from `pending`, `decision.reapproved` for one from `change` (the reopened → reapproved-into-awaiting → countersigned sequence probed end to end, with the `approved`/`reapproved` + `countersigned` audit rows; a revision born `finalized = false` with NULL `approvedFrom` refused by the birth seal); the ENTRY sealed from the decision side (review round 4) — a bare `UPDATE` to `awaiting_countersign` with no same-transaction provisional revision refused at commit, the re-entry of a rejected or returned decision onto its disposed head refused, the entry under an INACTIVE chain refused, the legal approve accepted; `decision.awaiting_countersign` emits at entry with the architect-targeted push; the READER arm — the shared tripwire walking every `DecisionStatus` value against `decisionChip`/`decisionChipLabel` and `deriveDecisionReading` (RED for `awaiting_countersign` at base: the chip falls back to withdrawn styling, the reading to the decider's approval), plus `StatusChip`, the log filter, the audience selectors, the schedule filter, the consultation thread's open set (the architect asks and a consultee answers on an awaiting decision through the UI) and the location tree's counters, label and rank (no `NaN`, the group present in the status rollup) each answering for the value explicitly; the WEB arm for the architect's OWN controls (review round 6) — the Decision Log renders Countersign, Reject back and Forward on for an `awaiting_countersign` decision to an active architect and to nobody else (a PMC sees the stranded-resolution control only while the chain is INACTIVE), and invoking each through the shipped UI drives the command end to end — countersign → `approved` with finality, reject-back → `change` with the origin-stamped request, forward-on → `change` + the `DecisionForward` fact — RED at base (no control renders; the status falls through the chip fallback) and asserted GREEN post-fix as a product-path assertion, not staging prose; **P31b** the register INSERT pairing (§B.4); **P31c** exactly one countersign per flip (§B.5) | the approve CAS (`decisions.service.ts` `approve`); the new countersign table + its reverse seal + the birth/standing seals; the catalog |
| P32 | self-countersign is TWO attributed acts under two idempotency keys — one combined act is refused; the two acts appear as two ledger receipts and two register facts | the countersign command |
| P33 | both disagreement outcomes: origin-stamped open `ChangeRequest`, `withdrawChange` refusal on `countersign_rejection`, the class-wide evidence freeze INCLUDING `decisionId`, `origin` AND `revisionId` (review round 4) (the hostile re-point to another decision refused; the hostile `countersign_rejection → 'standard'` re-label refused — the closed escape cannot be reopened by relabelling), impacts rendered, reject-back AND forward-on driven through re-approval to completion — forward-on through the ONE forward door with its `DecisionForward` fact (the request the bundle's provenance primary, the forward citing the same receipt); the freeze covering the new `projectId` and `sourceCommandId` — the hostile UPDATE that NULLs the receipt and the one that replaces it both refused (review round 3); the request's immutable `origin` serialized on the live, projected and rebuilt DTOs and the Withdraw affordance SUPPRESSED for a `countersign_rejection` request in the Decision Log while the direct call still 409s (the web arm, review round 2); the reject-back and forward-on requests carrying a non-NULL `sourceCommandId` bound to the completed `decisions.disagree` receipt — the direct-SQL disagreement bundle by an ACTIVE architect with every pairing, standing and eligibility seal green but NO receipt, refused at commit; **P33b** the rejection request's own pairing, its two producer shapes, and its provenance (§B.6) | the `ChangeRequest` machinery (`requestChange`/`withdrawChange`); the extended freeze |
| P34 | the forward chain: attribution (actor vs displaced holder), the web Forward affordance following `rollout.phase6_4d` (absent while the reservation stands, rendered after 4d-iii — review round 4), the `decision.forwarded` emission + re-seal, non-blank reason (zod + the complete-whitespace `btrim` CHECK + NOT NULL — a tab-and-newline-only reason refused at the DB), the PAIRING sealed in BOTH directions — hostile holder UPDATE refused with NO same-tx forward row AND with a MISMATCHED one; a hostile ORPHAN `DecisionForward` insert (no same-tx holder mutation) refused by the deferred reverse seal; the DOOR status-gated at the DB (a matched forward + holder mutation on an `approved`/`recorded`/`withdrawn` decision refused, and on an `awaiting_countersign` decision refused WITHOUT the same-tx rejection request); the TARGET's standing judged at the DB (a matching row naming a removed membership or an empty role refused); the ACTOR's standing judged at the DB (an inactive or unauthorized `forwardedById` refused; the role-holder arm's own — a matched row on a client-held decision whose `forwardedById` is a contractor while another active client exists, refused by `phase6_user_holds_role`; review round 3); provenance (the 4c arms); **P34b** exactly one forward per holder mutation (§B.5) | the 4b write-once trigger's one door + the reverse constraint trigger + the status/target/actor standing reads |
| P35 | the forward-vs-approve barrier: both orderings deterministic, exactly one surviving outcome, a coherent holder; and forward-vs-countersign likewise | the row-lock serialization in the canonical order |
| P36 | the switch-writers barrier: architect role-change vs approve, activation AND deactivation, both orderings; the orgs role mutations for `architect` take `lockProjectReadiness` (the §A enumeration grows by them); activation-vs-approve asserts ONE countersign delivery per decision in both orderings — approved-before → the re-emit, approved-after → its own approve, never both (review round 6) | `lockProjectReadiness` on the orgs role mutations |
| P37 | EVERY entry into `approved` sealed behind the chain, SERIALIZED by `phase6_try_readiness`: under an ACTIVE chain the direct `pending → approved` hostile flip refused, the finalized-boolean-only flip refused, the awaiting-flip without the SAME-TX countersign ROW refused, the standard `withdrawChange` restoration (finalized head, `standard` open request) PASSES, the `countersign_rejection` restoration refused; under an INACTIVE chain direct approval legal ONLY from `pending`/`change` — the bare awaiting-flip refused without the stranded-resolution fact; the first-architect-activation-vs-approval barrier deterministic in both orderings (the seal reentrant on the service path, hold-to-commit when free, REFUSE when contended — never blocking inside a trigger) | the new status-transition seal + the try-readiness protocol on every seal-trigger standing read |
| P38 | the pre-send eligibility guard generalized to EVERY targeted decision push through PER-EVENT-FAMILY predicates — the two NEW families (`countersign`: awaiting + active architect; `forward`: installed holder AND status `pending`/`change` — a withdrawn or terminal decision cancels with the recorded mark, review round 4) beside the three 4c delivered (`decider`, `consultation_requested`, `consultation_responded`): one positive AND one negative probed per new family — a valid consultee push is NOT dropped by the countersign predicate; the consultation-responded predicate widened to the architect requester WITH the withdrawn-audience arm — an active architect requester receives the response push, a response enqueued before a PMC withdrawal is cancelled for the architect requester and still delivered to a PMC requester (review round 3); the two new predicates bound at bootstrap under the BUMPED `webpush.notify` contract, and a process compiled at the old version refused by `syncConsumerCatalog` at startup (the 4c-ii startup-fence probe, re-run for version 3); the catalog-data migration in `ALWAYS_EXECUTE` — a P3005 baseline over a pre-4d-ii database runs it and the upgraded process starts (review round 5) | the delivered per-family registration + the two new `decisions.*PushTarget` queries + the consumer catalog bump and its catalog-data migration |
| P39 | the delivered orphan guard EXTENDED: removing or re-roling the NAMED holder, or the last active member of a ROLE designation, of an `awaiting_countersign` decision is refused at BOTH layers (409 through `holdsOpenDecisions`; the DB guard on the hostile direct write); removing the LAST ARCHITECT is NOT refused — it deactivates the chain (P29b) | `holdsOpenDecisions` + `phase6_t4b2_membership_guard`, open set widened |
| P40 | claim-time per-family re-check: a forward between commit and claim re-targets or drops the pending DECIDER push, recorded, while a still-standing consultee push SURVIVES the same forward; the `deciderPushTarget` read takes the decision row lock (the 4c hand-off, changed here); the SEND BOUNDARY (review round 1): the forward command cancels not-yet-sent decider deliveries by subject under the decision row lock, the consumer re-reads the cancellation mark immediately before `notifyTargetedUser` and re-judges EACH recipient by the family's OWN standing rule before that user's send — role standing for a fan-out (review round 4), the named membership's active standing for decider/consultee/holder targets (review round 5), `hasProjectRoleStanding` for the responded family's membership-less requester (review round 6) — a stale recipient SKIPPED without the whole-delivery mark (review round 6), and the forward-vs-claim barrier is driven in BOTH orderings — forward-first → re-target or cancel at claim; claim-first with the consumer HELD at the pre-send barrier while the forward commits → the final re-read drops the send and the displaced holder receives nothing — with the in-flight residual (a forward landing after the final re-read, during the provider call) stated as the disclosed bound, not asserted away; the withdraw-vs-claim barrier for a non-PMC holder in both orderings, and the non-last-member interleaving (architects A and B resolved at claim, A removed at the pre-send barrier → B receives, A nothing; a two-holder role forward likewise) — review round 4; the user-targeted arm — a `consultation_responded` push claimed for an active architect requester removed at the pre-send barrier sends nothing, the named-member decider push likewise — review round 5; an org-admin requester with no membership receives the response push, and the partial fan-out (A stale, B sent) leaves the delivery `succeeded`/`dispatch` with no mark while an all-stale fan-out is marked — review round 6 | the delivery claim path; `decisions.query.ts` `deciderPushTarget`; the forward command's subject cancellation; `consumers.ts` `makePushConsumer` |
| P42 | the finality candidate key over the ACTUAL provenance columns: provenance onto an unfinalized revision unrepresentable (both spec tables); `finalized → false` under reference refused by the FK; the additive backfill leaves every legacy revision `finalized = true` and every legacy spec row `revisionFinalized = true`, proven over the legacy fixture in `upgrade-proof.sh`; the DEFAULTS hold through the drain — a revision, a material spec and a labour spec inserted WITHOUT the new columns (the previous release's write shape) all succeed on the 4d-i schema and land `true` (review round 1), a `ChangeRequest` inserted WITHOUT `projectId` is filled from its decision and one naming another project's id is refused by the composite FK (review round 3), and 4d-iii's drop of the defaults is probed by the same inserts then failing, its trailing provenance seal by a NULL-`sourceCommandId` standard insert refused while the legacy NULL rows survive; **P42b** with P31b (§B.4) | `DecisionApprovalRevision_provenance_target_key` widened + the two spec FKs re-targeted |

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
    sentence that still read preflight-first) (the `awaiting_countersign`
    enum arm is added the way 20271015 added `recorded` — an enum value
    cannot be USED in the transaction that adds it, so the seals that
    compare against it are installed after the value commits, exactly as
    4b's were): the three fact tables (`DecisionForward`,
    `DecisionCountersign`, `DecisionStrandedResolution`) with composite
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
    and the immutable `approvedFrom` (nullable for legacy rows, required on
    any revision born `false`); `revisionFinalized` on the two spec tables
    (DEFAULT `true`, KEPT) with the CHECK, the backfill and the FK
    re-target; `ChangeRequest.projectId` (backfilled, trigger-filled for
    old writers, `NOT NULL`, composite-FK-bound to `Decision(projectId, id)`)
    and `ChangeRequest.origin` with their backfills, the extended freeze
    (now covering `origin`, `projectId` and `sourceCommandId`), the nullable
    provenance `sourceCommandId` with its composite FK and partial one-use
    UNIQUE, and the two-producer P33b pairing; the two NEW orgs-owned
    primitives `phase6_user_orchestration_authority` and
    `phase6_user_holds_role` (registered as 4c-i's two were; review round 3); the widened `phase6_t4b2_decision_seal`
    (the forward door, status-gated, target- and actor-judged) and the
    approved-entry seal with its decision-side `awaiting_countersign` entry
    arm and the rejection request's `revisionId` (review round 4); the `phase6_t4b2_membership_guard` open set
    widened; the two 4c consultation seals `CREATE OR REPLACE`d with the
    `awaiting_countersign` arm and the requester arm moved onto
    `phase6_user_orchestration_authority` (`phase6_user_decision_authority`
    byte-identical); and the RESERVATION — the orgs-owned
    `Membership_t4d_architect_reserved` (judged on NEW regardless of OLD) AND
    `DecisionForward_t4d_reserved` on every forward row (review round 4),
    one shared refusal function. Every non-blank text
    column carries the complete-whitespace `btrim` CHECK beside `NOT NULL`
    (review round 1). Its integration suite is the seal-stripped harness of §C;
    `upgrade-proof.sh` gains the P42 backfill assertions over the legacy
    fixture, the old-write-shape inserts succeeding under the kept defaults,
    the planted pre-existing architect row driving abort → repair →
    redeploy, and one hostile insert per seal; `TRUNCATE_SEALS` gains three
    entries; `ALWAYS_EXECUTE` gains the migration (raw guards a `db push`
    baseline cannot have — the 4c-i lesson) — **and its transient portion is
    a NO-OP once 4d has retired** (review round 5): in `ALWAYS_EXECUTE` a
    later P3005 baseline of a MATURE database — one holding a legitimate
    active architect after 4d-iii — replays 4d-i before 4d-iii, and an
    unconditional file would re-create the reservation and then ABORT on
    that valid row in its any-status audit, so the deploy never reaches the
    retirement that removes the reservation. 4d-i therefore SPLITS its body:
    the PERMANENT guards (tables, seals, backfills, primitives) run
    unconditionally and re-runnably, while the TRANSIENT block — both
    reservation triggers AND the audit — runs only when the durable
    RETIREMENT MARKER is absent. That marker is one sealed
    `OutboxOperatorAction` row, `action = 'rollout.retire.phase6-4d'`,
    written by 4d-iii inside its own transaction and sealed exactly as the
    4c-iii-r repair marker is (`20271125000000`: creation gated to the
    writing path by a `SET LOCAL` flag, promotion/mutation/deletion refused,
    no-TRUNCATE) — a forged marker would skip the reservation on an
    undrained database, the same class as a forged repair marker, hence the
    same seal. Probed (P28b's replay arm, in `upgrade-proof.sh`): the P3005
    baseline of a post-4d-iii database holding an active architect — 4d-i
    replays, finds the marker, installs no reservation and aborts nothing,
    4d-iii replays as a no-op, the architect survives; and the baseline of a
    pre-4d-iii database (no marker) still installs the reservation and
    audits; the corpus pin advances.
    **Deployed dark**: no contract, no command, no route, no reader; a
    still-serving 4d-ii-less instance cannot produce any new value.
    Expected to EXCEED the standard budget on probes alone — its packet
    argues `justified-large` on its own evidence, never by reference to this
    sentence.
  - **4d-ii, the service/role/UI unit**: the role fan-out (§A.1 — every
    mirror, the policy rows, the web lists); the four commands
    (`decisions.forward`, `decisions.countersign`, `decisions.disagree` with
    its two paths, `decisions.resolveStrandedCountersign`) on the command
    ledger with idempotency keys and `lockProjectReadiness` in the canonical
    order; the approve CAS landing `awaiting_countersign` under a chain; the
    `withdrawChange` refusal; every approve recording `approvedFrom` and
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
    decisions-owned `DecisionsParticipant.renotifyAwaitingCountersign`
    invoked by the orgs architect-activation mutations on the existing orgs
    → decisions edge, and the per-recipient pre-send re-check by each
    family's own standing rule that skips without marking (review round 6);
    the reader enumeration of §A.2 — the shared chip maps, the
    `deriveDecisionReading` arm, the two lagging API status unions pointed
    at the shared type, the log/schedule filters and audience selectors —
    with the shared tripwire that walks every `DecisionStatus` value; the three
    events (`decision.forwarded`, `decision.awaiting_countersign`, the
    existing `decision.approved` from the countersign) in both catalogs with
    the two new push families, the locked `deciderPushTarget`, every
    invalidating command's cancellation-by-subject of its family's
    not-yet-sent deliveries and the consumer's family-agnostic final
    pre-send re-read (§A.2, P40); **the two changed consumers' DURABLE
    contract versions bumped, with the matching catalog-data migration**
    (review round 2 — the 4c-ii precedent,
    `20271116000000_phase6_t4c_ii_rollout_fence`): `webpush.notify`
    (`consumers.ts`, `catalogVersion` 2 → 3, for the two new claim families)
    and `decisions.inbox` (`decisions.projection.ts`, 2 → 3, for the
    awaiting state and the forward-installed holder in its fold), with the
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
    stands on both doors (review round 4): the
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
    which is what keeps the attested state durable afterwards — the record
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
    drops `Membership_t4d_architect_reserved` AND `DecisionForward_t4d_reserved`
    with their shared function (review round 4) AND the two
    kept finality defaults (`finalized`, `revisionFinalized` — after the
    drain only writers that state the pin remain, §A.2; review round 1) AND
    installs the trailing INSERT-time seal requiring `sourceCommandId` on
    every new `ChangeRequest` row (§A.3 obligation 6; review round 3) AND
    writes the sealed retirement marker 4d-i's transient block keys on
    (review round 5), re-runnable, in `ALWAYS_EXECUTE` after 4d-i, with the mirror probes
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
  history (the register stays append-only; `finalized` is the one additive
  column and its flip is the one paired transition), no UX or performance
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
