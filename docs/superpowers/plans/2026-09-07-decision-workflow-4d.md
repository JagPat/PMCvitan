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
4a, 4b and 4c, all three DELIVERED AND CLEARED (4a: PR #337; 4b: PR #468 at
`fe9df58d`; 4c: the six units #489 → #498 → #506 → #528 → #533 → #535).

## Review lineage, and what this replacement does differently

This document REPLACES PR #552 (`Replaces: #552` — labelled
`review-replacement-required` by the orchestrator before it closed, so the
ledger holds its obligation; every predecessor closed at the limit stays a
labelled pending obligation until a MERGED unit names it, one merge
discharging one — the accepted gap of
`docs/reviews/replacement-lineage-repair.md`; #541 alone holds no label,
having closed before it could be labelled). #552 was itself the fifteenth
replacement of one docs-only unit: #537 → #538 → #539 → #540 → #541 → #542 →
#543 → #544 → #545 → #546 → #547 → #548 → #549 → #550 → #551 → #552, sixteen
PRs, thirty-two Codex review rounds, one hundred and sixty-eight findings,
each PR closed without a third correction head when its second head drew
findings. The closed PRs and their review threads are the record of every
finding and every fold; this document does not reproduce that narration
round by round, because a plan that has to be read through thirty-two
layers of "(review round N)" annotations is not a plan a reviewer can hold
whole — and holding it whole is the point of a plan unit.

**The three findings on #552's second head (`4b9a648f`) are carried, none
dropped**, and each is answered by construction rather than by a patch:

1. **Approval event/feed correspondence.** The round-31 "count-based
   emitter handoff" let the lifecycle seal accept ANY single
   same-transaction approval event and then write nothing, so a
   receipt-backed direct writer could commit a `change → approved`
   transition beside one forged `decision.approved` row with no audit or
   feed row and satisfy the count. This plan withdraws the handoff and the
   seal-emission it served. A seal VERIFIES the complete bundle field by
   field — the event's type, entity, actor and the paired fact's
   attribution, the `DecisionEvent` audit row of the transition's kind, and,
   where the transition owes one, the `Notification` feed row bound to that
   event — and REFUSES the transition otherwise. Nothing is deferred to;
   there is one emitter, the service, for every writer at every instant
   (§A.3 obligation 7).
2. **Durable recipient identity for the countersign demand.** The
   round-31 claim notice recorded the standing position the claim resolved
   holders against, but the delivered `makePushConsumer` resolves
   `roleHolderUserIds` later, in `handle`, after the lease transaction
   commits — so the notice and the send could disagree about who was
   demanded. This plan withdraws the notice register and the claim hook
   with it: the two 4d push families are USER-targeted at EMISSION, their
   recipients resolved under the readiness lock by the emitting command
   and frozen in the event's immutable dispatch intent and the delivery's
   payload; the send iterates that frozen set, re-judging each recipient's
   standing before their own provider call and never resolving a role at
   claim. The crossing handler decides from stream positions the kernel
   already records, not from a register the claim had to append (§A.2, the
   push families).
3. **Staged event/recipient notification uniqueness.** The round-29
   `platform_write_notification` twin promised `(event, recipient)`
   idempotency the `Notification` schema could not express. This plan
   withdraws the twin and stages the one column the correspondence rule
   needs — `Notification.eventId`, nullable, an FK to
   `DomainEvent(eventId)`, partially UNIQUE where non-NULL — in 4d-i, so
   the feed row a transition owes is bound to the event it announces and a
   second row for the same event is unrepresentable (§A.2, §D).

**Why one design pass rather than three more paragraphs.** Rounds 19 to 32
— fourteen rounds, sixty-one findings — landed on ONE commitment made in
round 19 and extended in rounds 21, 22, 24, 26, 29, 30 and 31: that the
database ADMITS a hand-run bundle and therefore must PRODUCE that bundle's
side effects itself — the crossing event from a trigger, a PL/pgSQL twin of
`emitEvent`, a twin of the notification helper, seal-written audit rows, a
count-based handoff between the service's emission and the seal's, a
claim-time notice register, and a relay refactor so the notice could be born
inside the lease. Every one of those findings was a divergence between a
PL/pgSQL reproduction of the service and the service itself, and that class
is OPEN: a twin must track every future change of the helper it mirrors,
and a handoff between two emitters has a race for every ordering the plan
has not yet named. The design pass replaces reproduction with VERIFICATION,
which is CLOSED: a seal checks a fixed correspondence predicate over rows
the transaction already holds, and a bundle that lacks any part is refused.
Nothing a seal admitted before is admitted now without its effects; what
changes is that the effects are demanded of the writer instead of
manufactured for it. §A.4 lists every withdrawn mechanism, the finding it
answered, and how the narrowed design answers that finding — the ledger the
continuation authorization requires (#482, 2026-09-07: "reduce the review
unit at safe dependency seams; preserve the obligations ledger and clearly
name any deferred dependency").

**Scope is reduced only at seams the delivered surface already proves
safe.** Four mechanisms are withdrawn on that ground, each with its
argument in §A.4: the reserved-value repair for `Decision` rows (the state
it repairs is unrepresentable — `DecisionStatus` and `DeciderKind` are
PostgreSQL enums, so no row can hold a value the type lacks), the
consumer-registration cutover (its hazard was retired when restoration
stopped re-emitting), the archived-project parking (the delivered 4c rule —
drop at claim with the recorded mark, no re-emission on restore — is the
cleared behaviour every decision push already has), and the receipt-level
`actorRole`/`actorName` pair (the owning fact seal judges the frozen role
and name against live standing at the act, which is what the pair existed
to prove). No decision carried from `6a53aae` is reopened; no finding is
dismissed; every deferred dependency is named where it is deferred.

**Docs-only.** No schema, no migration, no runtime code, no test change, no
4d implementation. Contractor-capture units 1–6 and the saved UX and
performance work stay Board-gated and are not mixed in.

## Provenance, and what is NOT re-litigated

The STARTING MATERIAL is the §C orchestration design at PR #340 head
`6a53aae` (`docs/superpowers/plans/2026-08-14-decision-workflow-4b-4d.md`
there, §C + the unit-4d probe table in its §D and the uniform seal contract
in §C.3), carried here in substance — none reopened. The binding ledgers
(`docs/reviews/pr-335-convergence.md`, `docs/reviews/pr-340-convergence.md`)
stand; the merged 4b plan's §D carries obligations 4–6 to THIS unit as
named probes (P31b/P42b, P31c/P34b, P33b), elaborated in §B. The owner's
2026-08-13 AMENDMENT (forward authority = holder + PMC + architect once one
exists) is settled and carried. The Board decisions carried from 4c stand:
an operator-declared drain directive with NO automated drain actor
(2026-08-29, on PR #480); the seal-stripped migration run as the RED
evidence for new seals (the same date and PR); a consultation INFORMS and
never GATES (the same).

4b's and 4c's DELIVERED surfaces are settled input, and this plan is written
against what actually merged:

- **4b**: the decider model (`deciderKind` client/pmc/member/none on
  `Decision` — `'architect'` deliberately deferred to 4d WITH the role;
  `deciderMembershipId` bound by the composite FK to `Membership
  @@unique([projectId, id])`; the holder tuple frozen from publication or
  attribution by `Decision_t4b_attribution_seal`
  (`decision_t4b_attribution_seal`, `20270826000000` — the WRITE-ONCE door
  §A.2 loosens by exactly one opening); `phase6_t4b2_decision_seal`, whose
  role arms this plan widens; the orgs-owned holder-orphan guards
  `Membership_t4b2_holder_guard` / `OrgMembership_t4b2_holder_guard` and
  the participant answer `holdsOpenDecisions`; the user-TARGETED push spine
  with the catalog-declared claim-time predicate (`pushFamily: 'decider'`,
  bound at bootstrap to `decisions.deciderPushTarget`, the role's current
  holders resolved at claim through `roleHolderUserIds`); the §B.1
  try-acquire-or-refuse protocol and the §B.2 owned SQL primitives
  (`phase6_membership_is_active`, `phase6_effective_role_standing`,
  `phase6_user_decision_authority`, `phase6_decisions_hold_role`,
  `phase6_decisions_name_membership`); the `ChangeRequest` evidence freeze
  `phase6_t4b2_change_request_seal`; the `x-vitan-decisions-contract:
  recorded-v1` client boundary and its `RecordedCompatInterceptor`.
- **4c**: the two consultation tables with their seal network
  (`DecisionConsultation_t4c_request_seal`,
  `DecisionConsultationResponse_t4c_response_seal`, both judging
  `"publishedAt" IS NOT NULL AND status IN ('pending','change')` at lines
  4d-i REPLACES), the append-only and named no-TRUNCATE seals, the
  `openCycle` freeze; the two orgs-owned primitives 4c-i registered —
  `phase6_membership_active_user(projectId, membershipId)` (locks the
  membership row, returns its `userId` when ACTIVE) and
  `phase6_project_operable(projectId)` (locks `Project` before reading
  `archivedAt`) — and the decisions-owned `phase6_try_readiness(projectId)`,
  the DELIVERED "try-acquire, never wait in a trigger" primitive every 4d
  seal calls (its key is `readinessLockKey(projectId)` from
  `readiness-lock.ts`); the §C rule-ii command PROVENANCE shape — `NOT NULL
  sourceCommandId` with a project-contained composite FK to
  `CommandExecution(projectId, id)`, a `(projectId, sourceCommandId)`
  one-use UNIQUE, and the DEFERRABLE result-binding constraint trigger
  `phase6_t4c_provenance_bound` (+ `phase6_t4c_provenance_reserved`) tying
  the row to the RESULT of the reserved command executing it — also bound
  onto `DecisionApprovalRevision` (`DecisionApprovalRevision_t4c_provenance`,
  the partial one-use `DecisionApprovalRevision_source_command_key`); the
  per-event-FAMILY claim predicates (`pushFamily: 'decider' |
  'consultation_requested' | 'consultation_responded'`); the consultation
  claim predicates' delivered rule for an ARCHIVED project — project
  operability re-checked first, a non-operable project dropping the
  delivery with the recorded cancellation mark; and the RETIRED rollout
  latch — 4c-v dropped the per-project `consultation` capability entirely,
  so 4d inherits NO capability read and adds none.
- **The kernel**: `emitEvent` (`platform/events.ts`) locks and increments
  `ProjectEventStream`, writes the `DomainEvent` envelope with the
  catalog-built immutable `dispatchIntent`, and materializes one
  `OutboxDelivery` per registered consumer IN the caller's transaction;
  the relay's `expandMissingDeliveries` repairs any event that lacks its
  delivery rows (a crash between event commit and delivery creation, or a
  newly registered consumer); the delivery lease is the sole arbiter of who
  sends; `cancelQueuedPushBySubject(tx, { projectId, subject, eventType })`
  is the platform's cancellation-by-subject over its OWN tables; the
  `Notification` feed table is platform-owned, written by the decisions
  service inside its command transactions and stamped with `decisionId`.
- **Three hand-offs the 4c plan recorded for THIS unit's review**, each
  taken up in §A: the `architect` joins the consultation REQUESTER set
  (`consultation.request` ceiling + a NEW orgs-owned orchestration-authority
  primitive — NOT a widening of `phase6_user_decision_authority`) "with the
  role"; the consultation eligibility carve-out gains the
  `awaiting_countersign` arm "with the status itself"; and the delivered
  `deciderPushTarget` reads its decision with a plain `findFirst`, which
  4c left for "4d's own review to weigh deliberately": §A.2 weighs it and
  changes it, because forwarding makes the holder MOVE.

Two delivered disciplines apply to every fact below without their own
probes, because the tripwires that pin them are merged and fail an
implementation PR that skips them: every new command rides the command
ledger with an idempotency key and joins the §A readiness-lock COMMAND-LEVEL
enumeration (`readiness-lock-coverage.test.ts`, `SECTION_A_COMMANDS`); every
new event joins the shared + sealed external-effect catalogs
(`external-effects.ts`, the sorted-tuple pin); every new table with a
statement-level no-TRUNCATE seal joins `TRUNCATE_SEALS` in
`prisma/sanctioned-reset.ts`; every new model joins its owning manifest's
`ownsModels` (and `readEncapsulated` where the module encapsulates its
reads) with the `boundary.test.ts` complete-set pins advanced, because the
boundary suite requires Prisma DMMF ownership to EXACTLY equal the
manifests; and every migration joins the `pg-parse` corpus pin and — where
it carries raw guards OR data a `prisma db push` baseline cannot have —
`ALWAYS_EXECUTE` in `scripts/migrate.sh`.

## §A — The design (the §C starting material, carried)

### 1. The role, honestly fanned out

`architect` joins `TokenRole` (`packages/shared/src/domain/types.ts`) and
EVERY mirror of it: `auth.ts`, BOTH zod role enums, `PushRole`, the
`decisionsManifest.permissions` set, the registry's hard-coded
`KNOWN_ROLES` mirror (`apps/api/src/platform/module-registry/registry.ts` —
`validateModuleRegistry()` rejects a manifest permission naming a role
outside that set and `ModuleRegistryService.onModuleInit()` aborts API
startup on the resulting `unknown-permission`, so a release that widened
the manifest without the mirror could not boot), the membership-role comment
in `schema.prisma`, every `ROLE_POLICY` entry the role belongs in
(`packages/shared/src/domain/policy.ts`; the exact row set is the unit's
FIRST deliverable — `project.read` and `members.read` (the roster the
consultation chooser needs) certainly among them,
`decision.approve`/`decision.change`/`decision.withdrawChange`/
`decision.updateDraft` and `consultation.respond` where the architect can be
the HOLDER or a consultee, `consultation.request` because the architect
joins the requester set, the four NEW 4d actions of §A.2, and
`decision.create`/`decision.publish`/`decision.withdraw` deliberately NOT —
issuing and withdrawing stay the PMC's), with the `route-policy.test.ts`
walk pinning whatever it says (P28). **The EXISTING targeted catalog entries
whose ceilings the role must enter** are widened too: `decision.published`
and `decision.consultation_requested` in `EXTERNAL_EFFECTS` list every role
a decider or consultee can hold, and their emitters persist the named
member's ACTUAL role even for a user-targeted push — which
`buildDispatchIntent` rejects when the role is outside the ceiling, aborting
the whole command. 4d-ii widens both, and a catalog tripwire enumerates every
targeted entry whose narrowing site persists a member role and asserts each
admits the full member vocabulary; P28 probes both paths end to end. **The
fan-out includes the PRODUCT PATH that mints memberships**: the Team screen's
role picker and role labels (`TeamScreen.tsx` `ROLES` / `ROLE_LABEL`,
`RolePicker.tsx` `ROLES`, and every web role list the mirrors walk reaches)
gain `architect`, or the countersign chain could activate only through
direct API calls, which is not a shipped feature. The role is a project
MEMBERSHIP role like the other five; `worker` stays deliberately absent from
the zod allowlists; the EXISTING `CompanyKind`/discipline vocabulary that
already spells `architect` (a firm's kind, a consultant's discipline) is a
different axis and is untouched.

**The role is a DESIGNATION, not only a token.** The 4b plan deferred
`'architect'` in `DeciderKind` to 4d explicitly, and the delivered contract
admits `client | pmc | member | none` everywhere it is judged — the Prisma
`DeciderKind` enum, the zod `DECIDER_KINDS`, the shared type,
`viewerIsDecider` (`packages/shared/src/domain/decider.ts`, false for any
kind it does not know), `deciderNoun`, the role arms of the two 4b seals
(the open-holder rule in `phase6_t4b2_decision_seal` and the holder-orphan
audit both judge `deciderKind IN ('client','pmc')` by
`phase6_effective_role_standing`), the decider picker and the audience
selectors. So the designation fans out with the role: 4d-i adds the enum
value in the retry-safe form the 4a/4b files used (`ALTER TYPE "DeciderKind"
ADD VALUE IF NOT EXISTS 'architect'`, its own statement, issued only AFTER
the transaction that installs the TEXT-judged reservation doors below has
committed) and widens the role arms of both 4b seals to
`('client','pmc','architect')`, so an open decision designated to the
architect role must have an effective architect holder exactly as a `pmc`
one must a PMC; 4d-ii adds the value to the shared type, `DECIDER_KINDS`,
`viewerIsDecider` (`architect` designates the ROLE — any active architect
decides, the `client`/`pmc` shape), `deciderNoun`, the DTO, the decider
picker, the audience selectors, the labels, AND the PRODUCER that selects
the push audience: `DecisionsService.deciderPush` maps `member` to its named
user, `pmc` to the PMC role and EVERY other kind to `client`, so a widened
input union alone would push "New decision awaiting your approval" for an
architect-designated decision to the CLIENTS; it gains an explicit
`architect` arm (`roles: ['architect']`, the role fan-out the widened
`decision.published` ceiling admits — this delivered family keeps its
delivered claim-time resolution through `roleHolderUserIds`, the per-recipient
re-judge of §A.2 guarding each send), the delivered `deciderPushTarget`
claim predicate gains the same arm (an architect-designated decision is
actionable while an active architect holds the role —
`phase6_effective_role_standing ≥ 1`, the `pmc`/`client` shape), and the
forward door's role-`toDesignation` arm (§A.2) admits it unchanged. P28's
role-held arms, RED at base (zod refuses the value; `viewerIsDecider`
returns false): a PMC creates a decision with `deciderKind: 'architect'` and
forwards a pending one to the architect role designation; every active
architect sees each in the Decision Log and one of them approves (an
architect-designated approval under an active chain still lands
`awaiting_countersign` — the chain judges it like any other, P32's two-key
self-countersign rule applying); a removed architect sees neither; the
publication's RECIPIENTS are every active architect's links and no client
link; and the P39 role-designation arm refuses removing the LAST architect
while a `pending`/`change` decision names the role (exactly the
`client`/`pmc` rule — the chain exemption of §A.2 covers an
`awaiting_countersign` decision designated to the role as it covers one
naming the architect by membership). **And the viewer-scoped
`DecisionsQueryService.countPending`** — the Portfolio tile count whose
predicate today gives a non-PMC viewer only client-designated rows or rows
naming their membership — gains the `architect` role arm (an active architect
counts the `pending` decisions designated to the role) and counts the
viewer's `awaiting_countersign` obligations (an architect's pending
countersigns; the PMC's stranded ones while the chain is inactive), the
portfolio probe asserting the architect's card reports them, zero at base.

**The role is DELIVERED DARK and armed only after the drain** (§D — the 4c
rollout discipline applied to 4d's own mixed-version hazard). 4d-i installs
an orgs-owned RESERVATION on `Membership` refusing any INSERT or UPDATE whose
NEW row carries `role = 'architect'` — judged on NEW regardless of OLD, so a
removed row already in that role can be neither restored nor re-keyed into
service through it (the exact shape of 4c-i's `ProjectCapability_t4c_reserved`)
— dropped by the trailing migration-only unit 4d-iii once the previous
release is attested drained. **The reservation covers EVERY 4d producer**:
the architect reservation keeps the CHAIN off, but forwarding needs no
architect, so 4d-ii's `decisions.forward` would emit `decision.forwarded`
while an ALREADY-RUNNING previous-release push worker — fenced by the
consumer version bump only when it RESTARTS — could still claim that
delivery, know no `forward` family, and take the unguarded send path. 4d-i
therefore ALSO installs `DecisionForward_t4d_reserved` (a BEFORE INSERT
trigger refusing EVERY `DecisionForward` row), `Decision_t4d_architect_reserved`
(a BEFORE INSERT OR UPDATE trigger refusing ANY `Decision` row whose
`deciderKind` is `architect`, draft or published — the delivered
`DecisionsService.create` births an unpublished DRAFT carrying its
`deciderKind` before any standing check, and a pre-4d process reads the
project's rows through its old Prisma enum BEFORE the author-visibility
filter, failing on the unknown value) and `Decision_t4d_awaiting_reserved`
(refusing ANY `Decision` row whose `status` is `awaiting_countersign`) — FOUR
doors through ONE shared refusal function `phase6_t4d_reserved()`, all
dropped by ONE 4d-iii statement. **The two `Decision` doors PRECEDE the enum
values**: they are created in their own transaction BEFORE the `ADD VALUE`
statements, judging the row AS TEXT — `NEW."deciderKind"::text =
'architect'`, `NEW."status"::text = 'awaiting_countersign'` — which PostgreSQL
evaluates whether or not the value exists yet, so no window opens in which
either value is representable and unreserved. **No `Decision` row can
PRE-DATE 4d-i carrying either value**: `DecisionStatus` and `DeciderKind` are
PostgreSQL enum types, and a column of an enum type cannot hold a value the
type lacks — so there is no `Decision` audit, no reserved-value repair and no
repair-evidence register for decisions (§A.4 records what #552 carried here
and why it is withdrawn). On the service path `decisions.forward`,
`decisions.create`/`updateDraft` naming `deciderKind: 'architect'`,
`MembersService.add` and the role-update command each refuse 409 naming
`phase-6-4d-previous-release-drained` while the reservation stands — judged
the way the database judges it, by the reservation trigger's presence in
`pg_trigger` (one catalog read, under the readiness lock, the read
`upgrade-proof.sh` already performs), and for the two membership commands
BEFORE ANY WRITE, ahead of the `User` provisioning the delivered
`MembersService.add` performs before its membership transaction (a trigger
refusal at the membership INSERT would otherwise orphan the invited
identity; that pre-existing provision-before-transaction ordering is an
orphan hazard for ANY membership failure and is named here, not widened
into 4d). The web Forward affordance and the Team role pickers follow ONE
shell-level `rollout.phase6_4d: 'reserved' | 'open'` read baked from the same
catalog read, so no client offers what the server refuses (ui-server-parity;
P34's web arm, P28b's service arm: adding an architect by a NEW email while
reserved → 409 and ZERO `User` rows created; after 4d-iii the same call
creates the member). P29c probes the four doors in both states: with the
reservation ARMED a service forward is 409, a hostile direct
`DecisionForward` insert is refused, the outbox holds no
`decision.forwarded`, no Forward renders, a service create naming the
architect designation is 409 and a hostile direct draft insert is refused;
after 4d-iii all open, and a published architect-designated decision is then
judged by the open-holder rule.

**The reservation is installed only onto a database that holds NO such
row.** `Membership.role` is an unconstrained `String`, so a pre-existing row
already spelling `architect` — a value nothing validated because no
vocabulary admitted it — would survive the reservation untouched and arm the
chain the instant `phase6_effective_role_standing` learns the role. 4d-i
therefore carries a DIAGNOSTIC-FIRST audit (the delivered `ABORT` pattern of
20271015/20271120) — ordered AFTER the reservation is installed, inside the
same transaction: the `CREATE TRIGGER` takes ACCESS EXCLUSIVE on
`Membership`, so every concurrent writer blocks until this transaction ends;
only THEN does the audit count `Membership` rows with `role = 'architect'` in
ANY status (the ordinary team removal sets `status = 'removed'` and leaves
`role` in place, so a soft-removed row aborts identically) and ANY `User` row
with `role = 'architect'` (the dev-session fallback reads `User.role`
verbatim), and if either count is not zero it RAISES with a bounded sample
and the WHOLE transaction rolls back, the trigger included — never re-roles,
never deletes. Auditing before the trigger would leave the classic gap: a
writer inserting an active architect row after the count observed zero and
before `CREATE TRIGGER` took its lock would be grandfathered past the
reservation. Both orderings are barrier-probed on the shipped file exactly
as 4c-iii's transition race is (P28b): writer-first — the migration waits at
`CREATE TRIGGER`, then its audit sees the committed row and ABORTS;
migration-first — the writer waits, then is REFUSED by the reservation. **The
operator repair is a RE-ROLE, never a soft removal, and never a repair
engine**: the still-serving pre-4d client reads `Membership.role` as the
`String` it is, so the ordinary team role command re-roles every offending
row to the role the member actually holds (the aborted attempt installed
nothing, so that UPDATE is free), or — for a row that never legitimately
existed — the documented operator SQL deletes it, subject to the delivered
4b holder guards, which refuse deleting the named holder of an open decision
(that row is re-roled instead); a dev `User` fixture is re-roled the same
way. The audit abort follows the committed door and enum statements, and
Prisma records the attempt as failed, so a plain redeploy stops at P3009: the
recovery is repair → `prisma migrate resolve --rolled-back <the 4d-i
migration>` → redeploy, exactly the repository's 4c-iii-r path in
`apps/api/scripts/migrate.sh` (`report_4c_iiir_migration_failure`), which
gains a `report_4d_i_migration_failure` twin printing those three steps when
this file fails; `docs/RUNBOOK.md` gains the §P6T4D section; and
`upgrade-proof.sh` plants BOTH an active and a soft-removed hostile
`Membership` row and a dev `User` row and drives abort → re-role → `migrate
resolve --rolled-back` → redeploy through the REAL runner, never a direct
SQL re-run that bypasses Prisma's failed-migration ledger. The P3005 baseline
path cannot skip the audit because the migration is in `ALWAYS_EXECUTE`.

Until 4d-iii no project can hold an active architect, so no chain can
activate, no decision can enter `awaiting_countersign`, and no JWT can carry
the role — INCLUDING the dev session: in a non-production environment with
`ALLOW_DEV_AUTH=true`, `AuthService.session` falls back to minting
`dev-<role>` for a role with no matching user and otherwise issues the real
`User.role` verbatim, so it REFUSES an `architect` request BEFORE EITHER
BRANCH — 409 naming the drain directive — until `rollout.phase6_4d` is open,
and the synthetic `dev-<role>` fallback NEVER mints `architect` even after it
(a synthetic actor has no account, so no fact it wrote could satisfy the
`<act>ByName` seal of §A.2; a dev architect is a seeded `User` fixture the
real-user branch serves once the rollout is open); P28b covers this alternate
token producer in both arms. "Activating the chain" is thereafter a
per-project PRODUCT act — the PMC adds an architect member — never an
operator step.

### 2. Orchestration

The settled design, plus the owner's 2026-08-13 amendment, as behaviour.
Every fact this section names lives under the uniform seal contract of §A.3;
the paragraphs below state what each seal JUDGES, and §A.3 states the seven
obligations once.

#### Forwarding

An append-only `DecisionForward` chain: `projectId`, `decisionId`,
`fromDesignation` (the DISPLACED holder: kind + membership), `toDesignation`
(the new one), `forwardedById` (the ACTOR — forward authority includes
non-holders, so a PMC forwarding a client-held decision is recorded as the
PMC displacing the client) with the action-time `forwardedByRole` and
`forwardedByName` frozen beside it, `reason`, `at`, and the delivered
provenance shape (`sourceCommandId`) — all immutable. The HOLDER is not a
new concept: it is the decision's CURRENT decider designation (4b §A.1) —
forwarding re-points that designation and the chain records each hop, so
every pending surface, badge and push that "follows the decider" follows the
forward automatically. **Forwarding EMITS**: `decision.forwarded` joins the
catalog (`invalidate: true`, a user-targeted push at the NEW holder,
`pushFamily: 'forward'`, its recipients frozen at emission — the push
families below). **The holder is mutable ONLY through the recorded act, and
the act must MATCH the change**: the 4b write-once trigger that ACTUALLY
freezes the holder — `Decision_t4b_attribution_seal`
(`decision_t4b_attribution_seal`, whose published-or-attributed arm refuses
any change to `deciderKind` or `deciderMembershipId`; not
`phase6_t4b2_decision_seal`, whose arms are the role arms) — loosens to
exactly one opening: a change accompanied by a same-transaction
`DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns
and whose `toDesignation` EQUALS the NEW ones, and the two DIFFER (the
command refuses a same-target forward 409 "already the holder"; the
holder-door arm requires the holder columns to actually change; the
forward-side reverse seal refuses a row whose `from` equals its `to`). Mere
row presence is forgeable — a hostile transaction could insert a forward row
naming unrelated designations and re-home the holder to a third member — so
the seal compares the transition to its evidence field-for-field. **The
pairing is sealed in BOTH directions**: a `DecisionForward` INSERT is
refused at commit (a DEFERRED constraint trigger) unless the SAME
transaction carries the matching holder mutation, exactly as the holder
trigger checks it from the decision side; an orphan row would fabricate
immutable handoff evidence for a handoff that never happened. **The DOOR is
status-gated**: forwarding is legal only in states the NEW HOLDER can act on
— `pending` and `change`, CAS'd on status at the command AND required by both
DB doors; terminal states refuse; `awaiting_countersign` is EXCLUDED from
the generic command (that status is the ARCHITECT's action item) and the DB
door admits `awaiting_countersign → change` ONLY when the transaction also
carries the `countersign_rejection` request (the disagreement's forward-on,
below). **The TARGET must be able to act, judged at the DB too**:
`toDesignation` validates through the orgs participant as an ACTIVE
same-project member/role (a removed-target forward is 409), and the
holder-door trigger validates the NEW holder's standing — a named-member
`toDesignation` must resolve through `phase6_membership_active_user` (the
composite FK pins existence and project; ACTIVE standing is the primitive's
read, under the membership row lock), a role `toDesignation` must have
`phase6_effective_role_standing ≥ 1` — the standing read riding
`phase6_try_readiness` as every seal-trigger standing read does. **The
recorded ACTOR must be able to perform the act**: `forwardedById` must hold
ACTIVE standing granting forward authority — the current holder's own user
(the named membership's user via `phase6_membership_active_user`; for a ROLE
designation, a user who HOLDS that role via the NEW orgs-owned, lock-bearing
`phase6_user_holds_role(project, user, role)`: TRUE iff THIS user
contributes to the role's effective standing — an ACTIVE membership in that
role, read under its row lock, or for `pmc` the membership-less org
owner/admin path — never "someone holds it"), or `pmc`/`architect` via the
NEW orgs-owned `phase6_user_orchestration_authority(project, user)` — ACTIVE
`pmc` or `architect` membership, or the membership-less org owner/admin path
— and NOT via a widened `phase6_user_decision_authority`, which is the DB
backstop for decision-CREATE authority and stays byte-identical so a direct
insert attributed to an architect cannot pass the seals this plan keeps
PMC-only. Both new primitives are ORGS-owned and registered exactly as 4c-i's
two were, reaching the decisions seals over the declared decisions → orgs
edge. The `reason` carries the sibling non-blank discipline as 4c-i spelled
it: `NOT NULL` AND `CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '')` beside
zod `trim().min(1)`. Forward authority: the current HOLDER + the PMC + the
architect once one exists (the AMENDMENT). **The architect can SEE what the
architect may forward**: the canonical `decisionVisibleToViewer` shows a
`pending` decision to the PMC, the decider and a standing consultee only, so
the audience widens by EXACTLY one more arm, the consultee precedent: while
the chain is ACTIVE an active architect sees every `pending` decision of the
project (and every `awaiting_countersign` one — already the architect's own
obligation), in the ONE shared predicate (`decisionVisibleToViewer`, its web
mirrors `selectLogDecisions` / `selectVisibleDecisions`, and the projection
read-path filter), gaining no authority by sight; `change`, `approved` and
`recorded` stay as today, `withdrawn` stays pmc-only, and with no chain the
predicate is byte-identical (P29). **Forwarding SERIALIZES against approval
and countersign**: each of approve/countersign/forward takes
`lockProjectReadiness` and then the decision row's lock in the canonical
order and re-checks the holder INSIDE the transaction, so the loser of
either ordering is a deterministic 409 — barrier-probed in BOTH orderings
(P35). Every hostile shape is probed under P34: no row; a mismatched row; the
orphan row; the same-target no-op at both doors; a matched row on a
terminal or awaiting decision; a matched row naming a removed membership or
an empty role; an inactive or unauthorized actor, and the role-holder arm's
own — another user holds the client role while the recorded actor does not;
the web arm drives a NON-holder architect forwarding a client-held pending
decision through the shipped UI, RED at base where the audience rule hides
the row.

#### The chain switch, and the standing that decides it

**No chain until an architect exists — and "exists" means an ACTIVE
membership**: rows are soft-removed, so mere presence would leave the chain
armed after the only architect left. The switch is "an ACTIVE architect
membership exists", read through the orgs participant on the service path
and through `phase6_effective_role_standing(projectId, 'architect') > 0` at
the DB. **The switch's WRITERS serialize with its readers**:
approve/countersign/forward/the stranded resolution read the switch under
`lockProjectReadiness`, and the orgs-side mutations that can flip architect
presence (role update, removal/restore, activation) take the SAME lock when
the role entering or leaving is `architect`, joining the §A lock-coverage
enumeration; a role-change-vs-approve barrier probe covers activation AND
deactivation in both orderings (P36). A project that removes its only
architect DEACTIVATES the chain for NEW approvals; a decision already
`awaiting_countersign` is NEVER auto-flipped (the stranded resolution
below).

**The standing lives in the platform kernel, so no module reads a peer's
table for it.** A platform-owned register `ProjectRoleStanding(projectId,
role, activeCount, changedAt)` — primary key `(projectId, role)`,
same-project FK to `Project` `ON DELETE CASCADE`, `activeCount >= 0` CHECK,
registered in `platformManifest.ownsModels` — is served by a platform-owned
`RoleStandingQuery.activeCount(tx, projectId, role)`, the kernel's contract,
exactly as `CapabilitiesService.isEnabled` serves `ProjectCapability` to
every module. Its ONLY writer is the platform-owned
`Membership_t4d_role_standing` trigger, AFTER INSERT OR UPDATE OR DELETE FOR
EACH ROW on `Membership`, which computes the change from the row it is handed
and NOTHING else — `before := (OLD.role = 'architect' AND OLD.status =
'active')`, `after := (NEW.role = 'architect' AND NEW.status = 'active')`,
delta `after − before` — and, when the delta is non-zero, applies `INSERT …
ON CONFLICT ("projectId", "role") DO UPDATE SET "activeCount" =
"activeCount" + delta`: no read of `Membership`, no read of any decisions
table, no count, and NO EMISSION (§A.4). The register is generic in shape so
a later unit can carry other roles; 4d maintains the `architect` row only,
and `phase6_effective_role_standing` stays the authority for `client`/`pmc`
exactly as delivered. It agrees with the orgs primitive BY CONSTRUCTION, not
by a cross-module check: both are functions of the same `Membership` rows, a
row trigger fires for every row write, and the register's own seals admit no
other writer — a BEFORE INSERT OR UPDATE OR DELETE seal refusing any write
that arrives at `pg_trigger_depth() = 1` (a statement issued directly) and
admitting only a write nested inside another trigger: the standing trigger's,
or the cascade of the project's own deletion, recognized by depth AND the
transaction-local flag the orgs-owned `Project_t4d_deleting` BEFORE DELETE
trigger on `Project` sets (4c-iii's `Project_t4c_deleting` shape reinstalled
under a 4d name, since 4c-v retired the original); the CHECK turns a delta
that would go negative into a refusal, never a clamp; the statement-level
`ProjectRoleStanding_t4d_no_truncate` and `Membership_t4d_no_truncate`,
both registered in `TRUNCATE_SEALS`, so the rows the register counts cannot
vanish beneath it. 4d-i backfills one `architect` row per project from a
count taken in the migration (zero, which the audit proves),
`upgrade-proof.sh` asserts register = count over the legacy fixture, P29b
asserts it after EVERY transition shape (insert, activate, soft-remove,
restore, re-role in and out, through the service; the project cascade), and
an operator `platform:verify` diagnostic compares the two OFFLINE, never in a
transaction. **`countersignRequired` is then a KERNEL read**: the ONE
decisions read path — live and projection alike, in the hydrate step both
run — overlays `activeCount > 0` for `(projectId, 'architect')` through
`RoleStandingQuery` (one keyed lookup per response, SERIALIZED ONLY WHEN
TRUE and hydrated as false when absent — the 4c-ii consultation precedent, so
the no-chain DTO is byte-identical to today's and P29's literal byte identity
holds; the wire-shape tripwire classifies it additive-when-present),
synchronous with the membership commit whose trigger wrote it, never stored
in the projection DTO, never read from `Membership` anywhere in decisions;
the approve CAS and every DB seal keep judging the chain by the orgs primitive
under the readiness lock over the delivered decisions → orgs edge, and the
two cannot disagree for the reason above. The `decisions.inbox` fold stores
no such field, so no fold needs refreshing when the standing changes.

**The membership write that flips architect standing is a LEDGERED
TRANSITION with an immutable fact and an EMITTED event — demanded of every
writer, produced by none but the service.** The orgs-owned
`MembershipTransition(id, projectId, membershipId, fromRole, fromStatus,
toRole, toStatus, actorId, sourceCommandId NOT NULL, at)` fact — a
same-project composite FK to `Membership(projectId, id)` that is
`DEFERRABLE INITIALLY DEFERRED` (on `members.add` the fact is inserted BEFORE
the membership row it names exists — the service preallocates both ids — so
the check holds at commit), a same-project composite FK to
`CommandExecution(projectId, id)` (immediate — the receipt is reserved before
the fact), the `(projectId, sourceCommandId)` one-use UNIQUE, EVERY column
immutable (append-only + `MembershipTransition_t4d_no_truncate`, in
`TRUNCATE_SEALS`), registered in `orgsManifest.ownsModels`/`readEncapsulated`.
`Membership` itself gains no provenance column and no pointer. The orgs-owned
`Membership_t4d_architect_provenance` seal pairs the fact BOTH WAYS on exactly
the writes that can flip architect standing: a DEFERRED constraint trigger on
`Membership` requiring, for any INSERT or UPDATE whose OLD or NEW role is
`architect`, exactly one same-transaction `MembershipTransition` row for that
membership whose `(fromRole, fromStatus, toRole, toStatus)` equals the
transition the write made (the forward-door discipline) — AT MOST ONE
standing-flipping write per membership per transaction, and at most one per
PROJECT per transaction (the service never writes two; a hand-run bundle
that does is refused rather than let two same-direction facts swap their
events); a BEFORE INSERT OR UPDATE OR DELETE trigger on `Membership` that,
whenever the write FLIPS active architect standing (`before ≠ after`,
computed from OLD/NEW exactly as the register trigger computes it), calls
`phase6_try_readiness(pid)` and refuses as contended if the key is held (the
delivered §B.1 protocol the membership guard already applies to
holder-relevant writes, which short-circuits for a plain architect INSERT
because it reduces no existing role — without it a hand-run activation would
never touch the readiness key, and an approval holding the key could observe
no architect, write `pending → approved`, and let the unblocked activation
commit first); on the fact, a BEFORE INSERT trigger calling the delivered
`phase6_t4c_provenance_reserved` (the receipt RESERVED now, of an orgs
membership command type, by the recorded actor) AND re-judging the recorded
actor's AUTHORITY at the database boundary with the service's own predicate
— `MembersService.canManage` admits the project's PMC (an active `pmc`
membership on THIS project) or an org owner/admin (`OrgMembership.role IN
('owner','admin')` for the project's org) — judged against the standing the
transaction STARTED with (for the membership's own user, a self-transition
`updateRole` permits, the fact's own `fromRole = 'pmc' AND fromStatus =
'active'` IS the captured pre-state; for any other actor the current
predicate), so a fact whose `actorId` holds neither is refused; paired with
the DEFERRED, TABLE-SPECIFIC `phase6_t4d_membership_transition_bound`
requiring at commit that the cited command SUCCEEDED naming
`NEW."membershipId"` as its result (the delivered `phase6_t4c_provenance_bound`
binds `resultRef = NEW.id`, which here would be the fact's own id) AND that a
same-transaction `Membership` write matching the fact exists (an orphan fact
refused). A hard DELETE of a row whose OLD role is `architect` is refused
outright except as the cascade of the project's own deletion (depth and
flag, as above) — the product removes an architect by status, and the
removal IS a transition the fact records. **AND the crossing-capable write
must carry its EVENT** (§A.3 obligation 7, the membership instance): for
every write that flips active architect standing, the same deferred pairing
seal requires — through the platform-owned `platform_tx_event(projectId,
eventType, entityType, entityId)`, the kernel primitive that returns the
`DomainEvent` rows inserted in the CURRENT transaction (`xmin =
txid_current()::text::xid`, the conversion `20270425000000_platform_command_receipt_seal`
already uses) matching the four coordinates, the same shape as
`phase6_t4c_provenance_bound`'s read of the kernel's receipt table — exactly
ONE same-transaction `membership.standing_changed` event whose `entityId` is
the membership, whose payload `transitionId` is that fact's id and whose
payload `activeCount` equals the register's `activeCount` for `(projectId,
'architect')` at commit (one flip per project per transaction makes that
equality exact), and refuses the write otherwise. The three orgs membership
mutations that can touch an architect — `members.add` (re-activation of a
removed member goes through it), `members.updateRole`, `members.remove` —
become COMMANDS on the ledger in 4d-ii, each writing its
`MembershipTransition` row and, on a standing flip, emitting
`membership.standing_changed` `{ role: 'architect', membershipId,
transitionId, from: { role, status }, to: { role, status }, activeCount }`
(project-scoped, `invalidate: true`, no push, in both catalogs and
`orgsManifest.producesEvents`) through the ordinary `emitEvent` after the
write, reading `activeCount` through `RoleStandingQuery` under the readiness
lock it already holds; `executeCommand` with an idempotency key and
`resultRef` = the membership id, the routes and the web store carrying the
key, the §A command-level readiness-lock enumeration gaining all three. They
are not commands today (`members.service.ts` takes `lockProjectReadiness`
and writes no receipt; `worker-devices.service.ts` is the orgs precedent for
the ledger). The trust boundary is the ledger's own, stated where the
platform seals it (`20270425000000_platform_command_receipt_seal`: no
trigger can distinguish the application from SQL that reproduces the
protocol by hand — reserve, write, complete, in one transaction) — and THAT
is why the event is demanded at the boundary rather than produced there: an
architect B written by hand-run SQL under a hand-completed receipt after A
left either carries its `membership.standing_changed` event, in which case
every tab refreshes and the re-notification below runs exactly as for the
service path, or it does not commit. `architect` is thereby OUTSIDE the
direct-writer set: a direct architect write is REFUSED (hostile probes under
P29b: INSERT, role UPDATE into and out of `architect`, soft removal, restore
— each without a transition fact refused at commit, each with a fact citing
no receipt refused, each with a fact whose receipt never completed refused
at commit, each with a receipt borrowed from another command type or actor
refused, a fact whose `(from, to)` disagrees with the write refused, an
orphan fact refused, a crossing write with NO same-transaction event
refused, with an event naming another membership or another fact refused,
with a payload `activeCount` that disagrees with the register refused, two
flips of one membership in one transaction refused; a hard DELETE refused;
the fact UPDATEd, DELETEd or TRUNCATEd refused; a direct write to the
register refused, the register erased by DELETE or by TRUNCATE refused,
`Membership` truncated refused; each through the service succeeding, the
register moving by exactly one in the same commit with the event emitted;
the hand-run bundle reproducing receipt + fact + write + event succeeding
with the SAME refresh and re-notification). The event fires on EVERY
activation or deactivation of an architect membership, crossing or not: a
1 → 2 activation invalidates open tabs harmlessly (duplicate invalidations
are idempotent by the socket consumer's contract) and its consumer below
classifies it a recorded no-op. The project that CAN be hard-deleted is an
EVENT-FREE one (`DomainEvent.tenant` references `Project` with `onDelete:
Restrict`, so a project that ever emitted holds its committed events and its
hard delete is refused at that FK before any cascade runs; the supported path
for a live project is `archive`); the cascade probe deletes an event-free
project with memberships but no architect ever active and asserts the delete
succeeds with no delta and no register row left, AND hard-deletes a project
holding an active architect and asserts the delete is REFUSED by the tenant
FK with the event, the fact and the register row intact.

**OTHER OPEN TABS learn the standing changed**: a client that loaded a
`pending` decision before the first architect was added holds
`countersignRequired` absent in its store, and the delivered membership
events are catalogued `invalidate: false`, so without this event no socket
`changed` would reach that tab and it could open the approval modal
promising a final lock while the server lands `awaiting_countersign`.
`membership.standing_changed` is `invalidate: true`; the external-effect
dispatcher turns it into the ordinary per-project socket `changed`, every
open tab on the project refetches, and its next read carries the kernel
overlay. P29b's arm: two sessions, the second holding a loaded `pending`
decision; the first adds the first architect → the second receives
`changed`, refetches, and its modal reads the countersign copy; the same with
the architect written by a HAND-RUN bundle — the event still emitted, the tab
still refreshed, the re-notification still delivered.

**The re-notification and the last-architect cancellation are DERIVED from
the event by a decisions-owned ORDERED consumer, `decisions.effects`**,
registered beside `decisions.inbox` with `decisionsManifest.consumesEvents`
gaining `membership.standing_changed` (the second non-empty
`consumesEvents` in the registry after labour's; the ordered-consumer
delivery-count pins advance). Its `deliveryFor` dispatches an
`architect`-role event whose payload is a CROSSING — `activeCount = 0` with
`to` not an active architect (deactivation), or `activeCount = 1` with `to`
an active architect (activation) — and records every other event, this
type's non-crossings included, as `noop`; history is a recorded no-op the
same way (the type is new, so no historical event of it exists; the relay's
`expandMissingDeliveries` gives the new consumer a `noop` row per historical
event of every other type through this `deliveryFor`, bounded and one-time,
and P38's registration arm asserts a database holding historical events
registers the consumer with every historical delivery `succeeded`/`noop`,
zero notifications and zero `countersign_renotified` rows). Both handlers
run under `lockProjectReadiness` in the handler transaction — serializing
with `approve`, the stranded resolution and every standing write — and both
decide PER DECISION from stream positions the kernel already holds, through a
platform-owned `EventStreamQuery.latestPosition(tx, projectId, eventType,
entityType, entityId)` (the highest `streamPosition` of an event of that type
about that entity in the project — a kernel query over the kernel's event
store, no module table read): for each of the project's
`awaiting_countersign` decisions (own table, under the decision row lock,
taken AFTER the decision's `countersign` delivery rows are locked `FOR
UPDATE` in ascending id order — the ONE lock order below), let `demand` be
the latest position of a `decision.awaiting_countersign` event about it;
**if `demand` is later than this crossing's position, the decision is
SKIPPED** — its demand was raised against a standing at or after this
crossing, by an approve or a later re-emit that resolved the current
architects itself; **otherwise** the handler cancels by subject every
not-yet-sent `countersign` delivery of the decision (the delivered
`cancelQueuedPushBySubject`, a demand raised before the crossing being
addressed by construction to architects who are ALL gone at a deactivation,
or all departed before an activation from zero) and, for an ACTIVATION,
re-emits `decision.awaiting_countersign` — the same catalog entry, family and
body, payload `{ renotified: true }`, recipients frozen at emission as every
countersign demand's are — for that decision, appending a
`countersign_renotified` `DecisionEvent` attributed to the envelope's system
actor `system:membership-standing` with the crossing event's id and
`transitionId` in its payload (the human act is recoverable by an auditor
from the immutable `MembershipTransition` fact the event names — never
derived by the consumer, which could pick the wrong transition when a
membership is removed and restored more than once before the handler runs);
for a DEACTIVATION it re-emits nothing (the demand is gone until the chain
reactivates). Exactly once, never twice, whatever the interleaving: the
handlers are ORDERED, so the deactivation at P is handled before the
activation at Q; an approve committing after Q targets the current
architects itself and its `demand` exceeds Q, so the Q handler skips it; a
decision awaiting from before P has its pre-P demand cancelled at P (unsent)
or already sent to the departed architect, and receives ONE fresh demand at
Q; a decision approved to finality under NO chain before P is not awaiting,
is enumerated by nothing and owes nothing; an activation while another
architect is already active is not a crossing and emits nothing; the
unordered `webpush.notify` worker only SENDS, never creates deliveries, and
the one race between its send and the handler's cancellation is resolved by
the delivery row lock and the final pre-send re-read below. The handler is
keyed per (decision, event) so a redelivery appends nothing; P36's ordering
barrier asserts the exact count per decision in both directions and P29b
drives approve → A removed → B added, through the service and through the
hand-run bundle, asserting exactly one new `decision.awaiting_countersign`
delivery per still-awaiting decision and that B, and only B, receives it.
This consumer is NOT a projection: `decisions.inbox` stays recompute-only,
and a projection rebuild replays nothing into `decisions.effects`, whose
cursor is its own. Preserving the cancelled delivery instead was weighed and
not taken: the cancellation mark is terminal by 4a's design and an
un-claimable "no recipient yet" delivery would retry to dead-letter.

#### The stranded decision, resolved by a NAMED command

The concrete interleaving: approve → `awaiting_countersign` → the last
architect leaves; generic forwarding refuses that status and countersign
needs an architect, so without a defined command the decision is gate-`wait`
forever. The PMC-only `decisions.resolveStrandedCountersign` is legal ONLY
while `status = 'awaiting_countersign'` AND no active architect membership
exists (both re-checked under the decision row lock + `lockProjectReadiness`
— the switch serialization of P36 covers an architect re-appearing
mid-command), with two explicit attributed outcomes recorded as a REGISTER
FACT: the append-only `DecisionStrandedResolution` table (`projectId`,
`decisionId`, the exact head `revisionId` resolved, `outcome: 'completed' |
'returned'`, `resolvedById` + frozen `resolvedByName` + frozen
`resolvedByRole`, `reason` with the non-blank discipline, `at`, the
provenance shape; same-project composite FKs; immutable; UNIQUE per
`(projectId, decisionId, revisionId)` — a decision re-stranded on a LATER
revision resolves again, the same revision never twice). **(a) COMPLETE
under the no-chain rule** — the head revision's `finalized` flips true and
the decision moves to `approved` in the SAME transaction as the resolution
row with outcome `'completed'`, the service emitting the real finalizing
event — `decision.approved` or `decision.reapproved` by the revision's
recorded `approvedFrom` (below). **(b) RETURN to the decider** — the decision
moves to `change` with a same-transaction open `ChangeRequest` carrying
origin `countersign_rejection` and the PMC's reason, its `requestedById` the
PMC who resolved (the rejection request has TWO legal producers, the
architect's disagreement under an ACTIVE chain and the PMC's stranded return
under an INACTIVE one, and its seal discriminates them by the fact it is
paired with — §B.6), paired with the resolution row with outcome
`'returned'`, so the existing machinery demands a fresh approval (which,
under the now-INACTIVE chain, lands `approved` directly) and the closed
`withdrawChange` escape stays closed. The reverse holds with the BUNDLE
named exactly: a `DecisionStrandedResolution` INSERT commits only with its
matching same-transaction bundle — outcome `'completed'` with the finality
flip AND `awaiting_countersign → approved`; outcome `'returned'` with
`awaiting_countersign → change` AND the same-transaction open
`ChangeRequest` carrying origin `countersign_rejection` (the transition alone
is NOT enough: a returned-resolution insert without the request would commit
a `change` decision whose reason no reader can see and which neither
`approve` nor `withdrawChange` can close, since both require exactly one
open request — `ChangeRequest_one_open_per_decision`). Neither outcome
touches `pending`. **A DEPARTED holder is re-homed atomically**: `returned`
for a decision whose named holder has left (the exemption below) REQUIRES a
same-command `toDesignation` and the resolution bundle carries a
`DecisionForward` row from the departed holder to the named ACTIVE target,
actor the resolving PMC, reason the resolution's, so the decision lands in
`change` with an active holder and never trips the orphan guard; a
`returned` without a target for a departed holder is 400; the bundle-aware
provenance binds the third fact to the same receipt. Probed end to end in
P29b: both outcomes, the refusal while an architect is still active, the
architect-reappears race, the missing-request hostile bundle, the departed
holder's re-homing.

#### Countersign, and the state that carries it

Under an active chain, the decider's approval writes its
`DecisionApprovalRevision` (bound, as 4c delivered it, to the completed
`decisions.approve` receipt) and moves the decision to
**`awaiting_countersign`** — the third and last new `DecisionStatus` value,
riding the enum for the reason `withdrawn` and `recorded` did. **The readers
that do NOT fail to compile are enumerated**, because the compiler catches
only exhaustive switches: `StatusChip.tsx` casts `decisionChip` /
`decisionChipLabel` through `Record<string, …>` and FALLS BACK to the
withdrawn styling — 4d-ii adds explicit `awaiting_countersign` entries to
both maps in `packages/shared/src/tokens/colors.ts`; `deriveDecisionReading`
(`packages/shared/src/domain/readiness.ts`) has a catch-all that describes an
unknown status as awaiting the existing DECIDER's approval — 4d-ii adds the
explicit arm (`wait`, "Approved by <decider noun> — awaiting the architect's
countersign"); `apps/api/src/domain/transitions.ts` carries a lagging
duplicate `DecisionStatus` union that already lacks `recorded` and
`apps/api/src/snapshot/types.ts` a string union of its own — 4d-ii points
both at the shared type; the web audience selectors (`selectors.ts`),
`DecisionLogScreen.tsx` (its filter list, `neverLocked`, the withdrawn-reason
block) and the `ScheduleScreen.tsx` filter each answer for the value
explicitly; `ConsultationThread.tsx` computes its open set as
`pending`/`change` — 4d-ii widens it with `awaiting_countersign` AND loads
the roster the chooser draws from (`ConsultationThread` derives its askable
set from the store's `members`, filled only by `loadTeam()`; on a fresh
architect session the widened Ask would open an EMPTY chooser, so the
consultation surface calls `loadTeam()` when `members` is empty, exactly as
`IssueDecisionModal` does, under the `members.read` row §A.1 gives the role);
`lib/locationTree.ts` keys its per-status counters, its `STATUS_LABEL` and
its status-mode rank by literal status — 4d-ii adds the counter, the label
"Awaiting countersign" and the rank between `change` and `approved`. A
shared TRIPWIRE pins the CLASS: a test walks every `DecisionStatus` value
against EVERY status-keyed map and predicate in shared and web — each
registered in the test so a map added later has to be registered too —
asserting an explicit key or arm for every value, RED for
`awaiting_countersign` the moment the enum value exists. Walking the 4a
§A.3 reader table: gate `wait` — work must not start on an uncountersigned
approval; pending surfaces show it to the ARCHITECT as their action item —
including the Inbox: `selectActionItems` (`store/selectors.ts`) derives
decision work from `pending` and `change` rows alone, so 4d-ii adds the
`awaiting_countersign` branch (the active ARCHITECT's "N decision(s)
awaiting your countersign" item, the PMC's "awaiting the architect's
countersign" summary, and when the chain is INACTIVE the PMC's red
stranded-resolution item) and the selector joins the reader tripwire; the
architect's Decision Log controls (Countersign / Reject back / Forward on)
render for an active architect on an awaiting decision and are probed as a
product path; withdraw refuses it — an approval act exists, which the
delivered `phase6_t4a_no_approval_after_withdraw` seal also enforces. **The
consultation carve-out widens WITH the status** (the 4c hand-off):
`awaiting_countersign` joins the open set in the service predicates AND in
both delivered 4c seal functions (`phase6_t4c_consultation_request_seal`,
`phase6_t4c_consultation_response_seal` — `CREATE OR REPLACE` in 4d-i, the
bodies otherwise byte-identical — the request seal's requester arm moving
from `phase6_user_decision_authority` to
`phase6_user_orchestration_authority`), so an architect may consult on the
very approval they must countersign. **The RESPONSE push follows the widened
requester set**: the delivered `consultationRespondedPushTarget` accepts
requester standing for `['pmc']` only and carries no status arm, because a
withdrawn decision is pmc-only and a PMC may still be told advice was given;
4d-ii widens the standing arm to `['pmc', 'architect']` AND adds the
audience arm the omission relied on — a response push whose requester is NOT
pmc is cancelled with the recorded mark when the decision is `withdrawn`,
while a PMC requester keeps today's behaviour byte-for-byte (P38). The cycle
semantics need no new rule: a consultation requested while awaiting freezes
`openCycle` at the count that INCLUDES the provisional approval; the
countersign appends NO revision (finality is a flip on the existing head),
so such a consultation stays cycle-valid until the decision leaves the open
set; a later re-approval appends the next revision and closes the cycle
exactly as 4c's P25d proves.

**A provisional approval must not be TRUSTABLE as a final one**: the
register is a provenance TARGET, so the row carries `finalized` — born `true`
outside a chain (today's behaviour byte-identical), born `false` under a
chain, flipped `true` by the countersign as its ONE permitted transition,
trigger-sealed. **The countersign fact is a ROW, not a boolean**: the
second register act is a concrete append-only `DecisionCountersign` table
(`projectId`, `decisionId`, the exact `revisionId` countersigned,
`countersignedById` + frozen `countersignedByName` + frozen
`countersignedByRole`, `at`, the provenance shape; composite FKs
same-project; immutable), UNIQUE `(projectId, decisionId, revisionId)`, and
the `finalized` false→true flip is trigger-PAIRED to a same-transaction
pairing fact for that exact revision — the `DecisionCountersign` row (the
chain path), or the `DecisionStrandedResolution` row with outcome
`'completed'` (the ONLY other legal finalizer). A finalized-only flip with
NEITHER fact is unrepresentable (P31). **The delivered append-only seal is
REPLACED, never stacked under**: the register carries
`DecisionApprovalRevision_append_only` (`phase3_immutable_row()`), which
rejects EVERY UPDATE, so the paired flip would abort before the pairing
trigger judged it; 4d-i DROPS that trigger in the same transaction that
installs the register's own replacement — a BEFORE UPDATE OR DELETE seal that
refuses every DELETE and admits an UPDATE only when the SOLE change is
`finalized` false→true (every other column compared OLD to NEW and frozen; a
true→false or true→true write refused), the pairing judged by the DEFERRED
trigger of §B.4. The old trigger ABSENT and the replacement PRESENT by name
join 4d-i's closing verification and `upgrade-proof.sh`, where the legacy
fixture's rows (all `finalized = true`) stay byte-identical. **The BIRTH
value is sealed too**: a BEFORE INSERT seal on `DecisionApprovalRevision`
judges the born value by chain presence under `phase6_try_readiness` — with
an active architect chain a revision is BORN `false`; with no active chain,
born `true` — and requires the new row's `version` to be the decision's
next; the forged-birth hostile insert is probed (P31, with P42's provenance
arm). **The ENTRY into `awaiting_countersign` is sealed from the DECISION
side**: the approved-entry trigger's BEFORE UPDATE arm also judges every
transition INTO `awaiting_countersign` — legal only FROM `pending`/`change`
and only under an ACTIVE chain — and a DEFERRED pairing requires at commit
that the decision's HEAD revision is the provisional approval this
transition recorded: `finalized = false`, `approvedFrom` equal to the status
the transition left, citing a COMPLETED `decisions.approve` receipt naming
this decision, and UNDISPOSED — named by no `countersign_rejection`
`ChangeRequest` and no `DecisionStrandedResolution`, both of which record the
exact `revisionId` they disposed of (the rejection request therefore carries
`revisionId` — NOT NULL for `countersign_rejection`, NULL for standard rows,
CHECK-pinned, frozen with the rest of its evidence), so a rejected or
returned head can never be re-entered by a bare status flip while the real
re-approval appends a FRESH head that passes. **The countersign is
ATOMIC**: a DEFERRED reverse seal refuses a `DecisionCountersign` INSERT
unless the SAME transaction carries BOTH the finalized flip on that exact
revision AND the decision's `awaiting_countersign → approved` transition —
row, flip and status are ONE transaction or none; the orphan row and the
split two-transaction replay are probed (P31). **The countersigner must BE
an architect**: the INSERT seal validates `countersignedById` holds ACTIVE
`architect` standing on the project at the act (`phase6_user_holds_role`,
under `phase6_try_readiness`); a non-architect and a removed-architect
attribution are probed.

**The finalizing event is a fact the provisional approval RECORDED, not a
guess the finalizer makes**: the delivered `approve` emits
`decision.reapproved` when it acts from `change` and `decision.approved` from
`pending` (`prior === 'change'`, `decisions.service.ts`). Under a chain that
act is provisional and its finalizer runs later, so `DecisionApprovalRevision`
gains an immutable `approvedFrom: 'pending' | 'change'`, an immutable
`approvedByName` (the approval-time display name frozen at the act — the
register's `approvedById` names an account whose name can change between the
provisional approval and its finalization) and an immutable
`approvedByRole` (the role HELD at the act, exactly as `DecisionEvent.actorRole`
freezes it) — CHECK-pinned; written by every approve from 4d-ii; NULL only on
pre-4d legacy rows and on rows the previous release writes during the drain
(all finalized, never finalized again); REQUIRED — the birth seal's arm — on
any revision born `finalized = false`. The countersign, or the stranded
`'completed'` resolution, emits `decision.reapproved` when `approvedFrom =
'change'` and `decision.approved` otherwise. The audit register keeps its
shape: the provisional approve appends its `approved`/`reapproved`
`DecisionEvent` (the act happened and is attributable), and the finalizer
appends a `countersigned` (or `stranded_resolved`) `DecisionEvent` — the
service writes both, the seal REQUIRES both (obligation 7); the 4c cycle
count reads revisions, not events, and is untouched. **The durable
`Notification` tells the truth about finality**: the delivered `approve`
writes the green "X approved …" notification UNCONDITIONALLY in its
transaction, so an approval that now lands `awaiting_countersign` would
announce an approval before any architect acted. Under an ACTIVE chain the
provisional approve writes a PROVISIONAL notification instead — "X approved …
— awaiting the architect's countersign", the awaiting colour, never green —
and the finalizer writes the green approved notification, **built from the
provisional revision's FROZEN approver facts**: the text names the APPROVER
exactly as today's does from the revision's frozen `approvedByName` (or
"Client" for a client decider, with the `onBehalfOf` phrasing when a PMC
recorded the client's consent) and carries the finalization as a DISTINCT
attribution ("— countersigned by <architect>", or "— finalized by <PMC> with
no active architect" for `completed`), never claiming the finalizer approved
the option; a rejection or `returned` resolution writes the change-request
notification the existing path produces; with no chain the approve's
notification is byte-identical to today's. Every one of these feed rows is
written by the service in the transition's own transaction, BEFORE the
command's response (the cleared 4b behaviour the snapshot readers depend
on), stamped with the event it announces (`Notification.eventId`, below),
and REQUIRED by the seal that admits the transition (obligation 7). P31
probes the feed beside the domain event: after the provisional approve the
feed carries the provisional text and no green approval; after the
countersign, the green one naming the original approver and the countersigner
separately; a rename between the two acts is probed and the green
notification carries the name recorded at the act. The countersign is a
second, separately-attributed register act referencing the exact revision; a
SELF-countersign (architect is also the decider) is TWO explicit acts under
two idempotency keys (P32). `pending` stays unreachable after any approval
act, so 4a's eligibility proof survives 4d intact.

**Browser tabs cannot be drained, so they stand behind a CLIENT CONTRACT
boundary.** The delivered `RecordedCompatInterceptor` treats
`x-vitan-decisions-contract: recorded-v1` as the 4b boundary, and a pre-4d
tab sends exactly that; once 4d-iii lets a chain activate, such a tab could
approve a decision, receive the unknown `awaiting_countersign`, report
"Approved & locked", fall through the chip fallback and hold no
countersign-aware action state. 4d-ii introduces the next contract value
`countersign-v1` — the web gateway declares it on EVERY request that reaches
the API, `req()` AND the direct `fetch('/auth/session')` in
`ApiGateway.connect()` that `useApiSync` takes under `DEV_AUTH` (a
client-boundary tripwire enumerates every `fetch(` site in the gateway and
asserts the header on each API-bound one) — and a sibling transport-layer
interceptor beside the untouched 4b one that, for a request declaring less
than `countersign-v1`: STRIPS from every `decisions` array each row carrying
a shape the contract introduced — `status = 'awaiting_countersign'`,
`deciderKind = 'architect'`, or an open change request whose `origin` is not
`standard` (a `recorded-v1` PMC tab receiving a `countersign_rejection`
request ignores the origin, its `mayWithdraw` renders Withdraw for every
PMC, and the queued `withdrawChange` is then refused by the server — an
action offered that cannot be performed; the PMC's next full load restores
the row) — an awaiting or architect-designated decision demands nothing a
pre-4d tab could do that a reload does not restore; REFUSES with a reload
409 the session/shell read for a user whose token role is `architect` (a
role the bundle cannot map is not hidden, it is refused) and EVERY
token-minting response that can hand the role to a stale tab before that
shell read — `/auth/switch` into an architect membership, and an architect
SIGN-IN through `/auth/login`, `/auth/password/complete`, `/auth/otp/verify`,
`/auth/email/verify` and `/auth/google`, each returning the `TokenResult`
whose `role` the delivered store hands straight to `screensFor` in
`applyAuthResult` (the tripwire enumerates every route whose service method
returns `TokenResult`; `/auth/worker/token` is the device flow and mints no
role a bundle maps); and STRIPS architect memberships from `/me/memberships`,
architect rows from the roster `/projects/:projectId/members` and architect
cards from `/me/portfolio` (`OrgsService.portfolio` builds its rows from
`Membership.role` verbatim). The four 4d-touched commands (`approve`,
`forward`, `countersign`, `disagree`) and `decisions.create`/`updateDraft`
naming the architect designation REFUSE a lesser client with a 409 naming
the contract and asking for a reload whenever the project's chain is ACTIVE
— **judged INSIDE the command, under the lock, never at the transport**: a
boundary-time chain read can race the activation it guards, so the declared
contract travels with the request into the command (the request-scoped
context the actor already rides) and each command re-judges it AFTER
acquiring `lockProjectReadiness`, refusing before any write; with no chain
the approve stays byte-identical. The additive `countersignRequired` passes
through as a field a stale bundle ignores. A TRIPWIRE pins completeness: a
test enumerates every enum value and column 4d adds
(`DecisionStatus.awaiting_countersign`, `DeciderKind.architect`,
`TokenRole.architect`, `Membership.role = 'architect'` on the membership,
roster, switch AND portfolio responses, `TokenResult.role = 'architect'` on
every token-minting response, `ChangeRequest.origin`, `countersignRequired`,
the `DecisionForward` DTO) and asserts each is classified strip / refuse /
additive-ignorable with its server-side refusal named, so a 4d shape added
later without a classification fails it. P29c carries every stale-client
arm — including the activation-between-check-and-approve barrier in both
orderings: the stale approve is HELD after its boundary pass, the activation
commits under the lock, the approve resumes, acquires the lock and is
refused (no awaiting row, no provisional revision, no notification), while
the same sequence with a `countersign-v1` client lands `awaiting_countersign`
exactly once. The boundary is dark until 4d-iii like everything else and is
probed BEFORE the role is enabled. **And the client's approval confirmation
tells the truth**: `ApproveModal.tsx` promises "Will be locked" and the store
flashes "Approved & locked — saved to the server"; the modal reads
`countersignRequired` — "Will be sent to the architect for countersign" — and
the success copy follows the status the command RETURNS ("Approved —
awaiting the architect's countersign"), never a client-side guess.

#### EVERY entry into `approved` is DB-sealed behind the chain

Sealing only the `awaiting_countersign → approved` edge leaves the direct
road open — hostile SQL under an ACTIVE chain could mark the head revision
finalized and move `pending`/`change` straight to `approved`. The BEFORE
UPDATE trigger therefore judges ANY transition INTO `approved`, with three
precisions. **(i) The presence read SERIALIZES — by TRY-ACQUIRE, never by
waiting in a trigger**: the seal calls `phase6_try_readiness(projectId)`
exactly as 4c's request and response seals do — on the SERVICE path the
command already holds the readiness key (advisory locks are reentrant, the
try-acquire succeeds); on a DIRECT write with the key free it acquires and
HOLDS to commit, making the presence read exclusive; on a DIRECT write with
the key CONTENDED it REFUSES the write outright (a row-level `FOR UPDATE` on
architect memberships cannot serialize a FIRST activation — the classic
phantom — and a trigger that BLOCKS on the advisory key inverts the
service's lock order into a deadlock). The same protocol binds the
`Membership` writes that can flip holder-relevant standing (above) and every
seal-trigger cross-table standing read. **The membership seal judges
CONTENT, not only timing**: the delivered `phase6_t4b2_membership_guard`
re-judges the holder-orphaning predicate at the DB for `pending`/`change`
decisions (P39's DB arm); 4d-i EXTENDS its open set with `awaiting_countersign`
for the NAMED holder and the ROLE designations it guards today — and
deliberately does NOT add the architect role to it: the last architect
leaving is the chain DEACTIVATING, resolved by the named command, never a
refused removal. **The two rules meet in ONE row, and the exception is
named**: the sole architect A can be BOTH the last architect and the named
holder (or the last active member of the architect ROLE designation) of a
decision A approved into `awaiting_countersign`; the widened guard would
refuse A's removal while the chain promise says it is never refused. The
guard's awaiting arm therefore EXEMPTS exactly this case — named holder AND
role designation alike, for exactly the last active architect and no one
else: the removal proceeds, the chain deactivates, the countersign deliveries
are cancelled by the consumer above, and the decision stays
`awaiting_countersign` with a DEPARTED holder whose only exits are the
stranded resolution's two outcomes. A named holder who is an architect but
NOT the last one stays refused, the 409 naming the pending countersign.
Probed (P39, P29b) with the hostile direct soft-removal and role-change of an
awaiting decision's holder. **(ii) With the chain ACTIVE**, the legal
entries are: FROM `awaiting_countersign` WITH the SAME-transaction
`DecisionCountersign` row finalizing the head revision; or FROM `change` as
the standard `withdrawChange` RESTORATION — the open request is `origin =
'standard'` AND the head revision is ALREADY `finalized = true` from its
original countersign (the ordinary correction path this seal must not
strand); `pending → approved` and any `change → approved` on an unfinalized
head or a `countersign_rejection` request are refused outright. **(iii)
With the chain INACTIVE, the direct road is NARROW**: direct approval stays
legal only FROM `pending` or `change` — the approvals born under no chain,
today's behaviour byte-identical — AND ONLY WITH ITS BUNDLE (obligation 7:
the same-transaction `DecisionApprovalRevision` citing a completed
`decisions.approve` receipt, the `decision.approved`/`reapproved` event, the
`approved`/`reapproved` `DecisionEvent`, and — from 4d-iii — the
`Notification` bound to that event); an `awaiting_countersign` decision was
born under a chain, so its exit DEMANDS paired evidence even after the last
architect leaves: the same-tx `DecisionCountersign` row, or the same-tx
`DecisionStrandedResolution` row with outcome `'completed'` — a bare hostile
`awaiting_countersign → approved` flip under an inactive chain is refused.
Probed (P37): the direct `pending → approved` hostile flip under an active
chain, the finalized-boolean-only flip, the stale awaiting-flip without the
countersign row, the bare awaiting-flip under an INACTIVE chain, the standard
restoration PASSING, the rejection-request restoration REFUSED, the
inactive-chain direct bundle WITHOUT its event refused at commit and WITH its
complete bundle accepted, and the activation-vs-approval barrier.

#### The finality key, stated exactly

The existing Phase-3/4 provenance rows (`MaterialRequirementSpec`,
`LabourRequirementSpec`) FK onto the register's candidate key `(projectId,
decisionId, version, optionKey)` (`DecisionApprovalRevision_provenance_target_key`).
The finality pin WIDENS that key: the register gains `@@unique([projectId,
decisionId, version, optionKey, finalized])`, each provenance row gains an
immutable `revisionFinalized` column CHECK-pinned `true`, and the composite
FK re-targets the widened key — the `PurchaseOrder.comparisonStatus`
precedent verbatim (Phase 3 F4), so provenance naming an unfinalized revision
is UNREPRESENTABLE and a `finalized → false` flip on a referenced row is
refused by the FK itself. The migration is additive and backfills `finalized
= true` on every existing row and `revisionFinalized = true` on every
existing spec row. **The column DEFAULTS (`true`) are KEPT through the
drain**: 4d-i deploys while previous-release instances still serve, and
those instances insert `DecisionApprovalRevision`, `MaterialRequirementSpec`
and `LabourRequirementSpec` rows that name neither column; born-`true` under
the default is CORRECT for the whole pre-drain window because the reservation
keeps every chain inactive. 4d-iii drops the two defaults, so from then on a
provenance row must state its pin — and the writers are taught first: the
delivered `decisions.approvedRef` returns exactly `decisionId`,
`decisionVersion` and `optionKey`, which `RequirementsService` spreads
verbatim into the material spec insert and into
`LabourRequirementParticipant.writeRequirementSpec`; 4d-ii widens the query
to return the head revision's `finalized` as `revisionFinalized` and to
REFUSE an unfinalized head outright, and EVERY spec writer states it
explicitly — create and revise from the widened `approvedRef`, and the two
CANCELLATION copies (`RequirementsService.cancel` copies the head's
`MaterialRequirementSpec` column by column;
`LabourRequirementParticipant.copyRequirementSpecForCancel` copies the
`LabourRequirementSpec` and its slices) carrying `revisionFinalized` forward
VERBATIM — with a WRITER SWEEP enumerating every INSERT site on the two spec
tables and asserting each states the column. P42 probes the old write shape
succeeding under the kept defaults, the post-4d-iii shape failing, and a
current-version provenance write SUCCEEDING for a material AND a labour
requirement after 4d-iii through the shipped writers — create, revise AND
cancel — RED at base where the three-field spread fails on the required
column. Each is an edit the owning module (activities; labour through its
participant) makes to its own code, and the one foreign fact 4d needs is
DECLARED: membership truth is orgs-owned, routed through the named
participant API and the orgs-owned SQL primitives.

#### Disagreement — the `change` state's OWN machinery honoured

BOTH disagreement outcomes land in `change` AND create the open
`ChangeRequest` in the same transaction, requested by the architect with the
disagreement reason; the command accepts the impacts as OPTIONAL inputs
defaulting to 0. **The request carries its ORIGIN, and the ordinary escape
hatch is closed for it**: `ChangeRequest` gains an immutable `origin:
'standard' | 'countersign_rejection'` (additive, default `'standard'`,
backfilled) — the existing `withdrawChange` (the service's `change →
approved` restoration) would on a disagreement request complete an approval
WITHOUT its countersign, so `withdrawChange` refuses `countersign_rejection`
requests with a 409 naming re-approval as the only way forward (P33). **The
affordance follows the refusal**: 4d-ii serializes the immutable `origin` in
the shared DTO on the live, projected and rebuilt paths alike — PRESENT ONLY
WHEN NON-`standard` (absence hydrates as `'standard'`, so an ordinary
request's wire shape is byte-identical) — and `DecisionLogScreen.tsx`'s
`mayWithdraw` suppresses Withdraw for `countersign_rejection`; P33's web arm
asserts no Withdraw renders for a rejection request while the direct call
still 409s. **The request's EVIDENCE freezes with its origin and its
decision**: the delivered `phase6_t4b2_change_request_seal` freeze is EXTENDED
to cover `origin`, `decisionId`, `revisionId`, `projectId`, `sourceCommandId`,
`requestedByRole`, `requestedByName`, `reason`, `costImpact`,
`timeImpactDays` and `requestedById` for EVERY `ChangeRequest` row, with the
close transitions as the only permitted mutations — a hostile re-label of an
open `countersign_rejection` request to `'standard'` would reopen the closed
escape, and a re-point to another decision would strip the change-state
decision of its one open request; both are probed (P33). The two paths:
**REJECT BACK** keeps the original decider as holder — they re-approve and
the chain runs again; **FORWARD ON** re-points the holder to the decider the
architect names (validated active) — through the SAME forward door with the
SAME `DecisionForward` fact as the generic command, taken from
`awaiting_countersign` in the same transaction that lands `change` (which is
why the door's status predicate admits `awaiting_countersign → change` ONLY
when the transaction also carries the `countersign_rejection` request) — the
new holder finds an actionable change-state decision, re-approves, and the
chain runs again. Neither path returns to `pending`; neither erases the
approval act it answers; approve-from-`change` under an ACTIVE chain lands
`awaiting_countersign` exactly like approve-from-`pending`. Probed end to
end (P33). The `countersign_rejection` `ChangeRequest` carries the frozen
`requestedByRole`/`requestedByName` pair (CHECK-required exactly when
`origin = 'countersign_rejection'`) and its provenance (§A.3 obligation 6,
§B.6).

#### The push families, and the send boundary stated where it can hold

Two families join the delivered three: `decision.forwarded` (`pushFamily:
'forward'`, at the NEW holder) and `decision.awaiting_countersign`
(`invalidate: true`, `pushFamily: 'countersign'`, at the ARCHITECTS; also the
re-emit's entry). **Both are USER-TARGETED AT EMISSION, with their
recipients frozen in the record** (the answer to #552's second finding):
the emitting command — `forward`, `approve` under a chain, and the
`decisions.effects` re-emit — resolves the recipients under the readiness
lock it already holds (a named-member `toDesignation` → its user; a role
designation → the role's current holders through the orgs participant's
`effectiveRoleHolderUserIds`; the countersign demand → every active
architect), and passes them as `dispatch.push.targetUserIds` — a plural
sibling of the delivered `targetUserId`, admitted by `buildDispatchIntent`
only for a catalog entry whose `pushFamily` declares a frozen audience, and
copied by the consumer's `deliveryFor` into the delivery payload exactly as
`targetUserId` is. The dispatch intent is immutable on the `DomainEvent`
row and the payload is the delivery's own, so WHO was demanded is durable
from the instant of emission; the standing cannot move between the
resolution and the emission because both happen under the ONE readiness
lock the standing writers take. The consumer sends to that frozen set and
to no one else — it never resolves a role at claim for these two families;
a recipient is skipped at the send when the per-recipient re-judge below
finds their standing ended; an architect activated AFTER the demand was
raised (A active, B added — no crossing) receives no push for it, which is
the honest reading of a push as a nudge: B's Inbox item and Decision Log
controls carry the demand regardless (the reader table above), and the
crossing consumer raises a fresh demand exactly when the chain reactivates
from zero. The delivered families keep their delivered resolution
(`decider` resolves a role's current holders at claim through
`roleHolderUserIds`, the 4b mechanism; the two consultation families are
user-targeted already). **The bodies of the two new families are GENERIC by
construction** — the countersign push says a decision awaits the recipient's
countersign and the forward push that a decision has been forwarded to them,
neither naming the decision, option or material; the app opens the decision
under its own authorization — so their residual (below) discloses only that
a decision exists; the DELIVERED families' bodies (the decider title, the
consultation title, the approval announcement) are 4c's cleared surface, left
as they are and named for what they carry.

**The decider push follows the forward AT CLAIM** (the 4c hand-off,
weighed): the delivered `deciderPushTarget` reads its decision with a plain
`findFirst`, which was correct while the holder could not move after
publication. It can now. The claim predicate therefore takes the decision
row's lock before reading the holder (the discipline 4c's consultation claim
already uses), so a forward committing between enqueue and claim re-targets
the pending DECIDER push at the installed holder or drops it with the
recorded cancellation mark, while a still-standing consultee push SURVIVES
the same forward. Each new family's claim predicate is a `decisions.*PushTarget`
query bound at bootstrap under the BUMPED `webpush.notify` contract:
`forward` — actionable while the decision is `pending`/`change` AND the
installed holder is still the delivery's frozen target; `countersign` —
actionable while the decision is `awaiting_countersign` AND an active
architect exists; each re-checks project operability FIRST through
`phase6_project_operable` (the 4c order) and drops a non-operable project's
delivery with the recorded mark exactly as the delivered consultation
predicates do (P38, one positive and one negative per family; a valid
consultee push is NOT dropped by the countersign predicate).

**The guarantee is stated at the boundary it can actually hold.** The
delivered `makePushConsumer` awaits the claim query's OWN transaction and
only then calls the EXTERNAL `notifyTargetedUser`, so the decision row lock is
released before the send; the send is external I/O and cannot be inside any
transaction. 4d therefore closes the window to the provider call itself and
DISCLOSES what remains:

(i) **EVERY command that changes the fact a family's claim predicate reads
CANCELS that family's not-yet-sent deliveries by subject**, under the same
lock the predicate reads under — the 4a `cancelQueuedPushBySubject`. Stated
for every family this unit touches: a forward cancels that decision's
`decider` AND `forward` deliveries (a second forward invalidates the first
forward's push at the now-displaced holder exactly as it invalidates the
decider's); `approve` — landing `approved` directly or `awaiting_countersign`
under a chain — cancels that decision's `decider` AND `forward` deliveries
(a delivery claimed before the approval passes the consumer's delivery-row,
standing and project re-reads and would send "awaiting your approval" after
the holder acted; the family predicates' STATUS arm refuses at CLAIM and
again at the SEND, and the in-flight one still gets the mark); every
transition that LEAVES the consultation-open set — the no-chain approve, the
countersign, the `completed` stranded resolution, the standard
`withdrawChange` — cancels that decision's `consultation_requested`
deliveries by subject (an invitation `consultation.respond` then refuses; the
approval INTO `awaiting_countersign` cancels nothing of this family, since
consultations stay open while awaiting; `consultation_responded` deliveries
are information, not invitations, and keep the withdrawn-audience rule);
countersign, disagree and the stranded resolution cancel that decision's
`countersign` deliveries (the demand is gone, whichever way); the PMC's
`withdraw` cancels that decision's `decider` AND `forward` deliveries, EVERY
`consultation_requested` delivery regardless of target (a request is an
invitation to act that `consultation.respond` refuses on a withdrawn subject
for a PMC consultee exactly as for anyone else), and the
`consultation_responded` deliveries ONLY where the target lacks PMC standing
(`hasProjectRoleStanding(user, ['pmc'])` false — the architect requester; a
withdrawn decision is pmc-only, but a PMC may still be told advice was given
— through a NARROWING `targetUserIds` arm on `cancelQueuedPushBySubject`,
judged against the event's own durable dispatch intent); and the
last-architect deactivation's cancellation of every awaiting decision's
`countersign` deliveries is derived by `decisions.effects` from the event
(above), never left to the membership mutation. **Every cancellation takes
its locks in ONE order** — the delivered readiness → `Project` →
`Membership` order, then the subject `OutboxDelivery` rows `FOR UPDATE` in
ascending id, THEN the `Decision` row — because the relay's claim leases the
delivery first and then the family predicate takes the decision lock; a
command holding the decision and then reaching for a leased delivery would
deadlock and abort one side toward dead-letter. A delivery the command finds
already leased by a claim is SKIPPED, never waited for: that claim, blocked
on the decision lock the command holds next, resumes after the commit and its
final pre-send re-read observes the transition and drops the send with the
mark. The `withdraw` command's target-aware response cancellation reads the
decision's consultation entries WITHOUT the decision lock, locks every
response target's membership in ascending membership id and judges its
standing, THEN takes the delivery rows and the decision row and re-validates
the consultation set under it — an entry that appeared between the two reads
means a membership this transaction has not locked in order, so the command
refuses as contended (the try-acquire posture; the client retries) rather
than lock out of order. P35's barrier gains each command against a
concurrent claim in both orderings, no deadlock; P40/P41 gain the
withdraw-vs-respond barrier in both orderings.

(ii) **The consumer performs a FINAL re-judge immediately before EACH
recipient's provider call**, ONE HOOK for EVERY recipient of EVERY family: the
delivery row's cancellation mark (family-agnostic by construction); the
PROJECT — the delivered `OrgsParticipant.isProjectOperable`, the row-locking
read, so the archive waits for the check or the check sees the archive; the
PERSON, by the family's OWN standing rule and never a uniform membership
test (a `consultation_responded` requester may be an org owner/admin with NO
`Membership` row on the project, exactly why 4c keyed that target by user):
the responded family re-applies `hasProjectRoleStanding(user, ['pmc',
'architect'])`; the named-decider, consultee and forward-holder families
re-check the named membership's ACTIVE standing
(`phase6_membership_active_user`); a role fan-out and the countersign's
frozen set re-check `phase6_user_holds_role(project, user, role)` — all
through the orgs participant; and the SUBJECT — the family's OWN claim
predicate re-run (target-aware wherever the claim is), as a decisions-owned
read of the decisions-owned `Decision` row, so a decision that left the
actionable set between claim and send never sends. The outcome follows one
rule: a subject or project that left the actionable set BEFORE any send
drops the WHOLE delivery with the recorded mark (`OutboxDelivery` carries one
delivery-wide `cancelledAt`/`deliveryAction`, so the mark is the right
instrument only when the whole delivery drops); a stale RECIPIENT is SKIPPED
without touching the mark and the delivery completes `succeeded`/`dispatch`
with the recipients actually sent, the mark set only when EVERY resolved
recipient fails (a user-targeted delivery has one recipient, so its failure
IS the whole delivery); a subject or project that leaves BETWEEN sends skips
every remaining recipient without touching the mark. **An ARCHIVED project
is the delivered 4c rule, not a new mechanism** (§A.4): the delivery is
dropped with the recorded cancellation mark at claim or at the pre-send
barrier, and restoration re-notifies nothing — exactly what every delivered
decision push family already does, and what the Board's "a consultation
informs, never gates" ruling accepts for a push, which is a nudge: on
restoration the awaiting decision is in the architect's Inbox and Decision
Log, the forwarded decision in the holder's, and nothing is stranded. Durable
per-recipient evidence was weighed and not taken: it needs a new column on
the platform's delivery row for a fact the push provider's own log already
carries.

(iii) **The residual** — an invalidating command committing after that final
re-read and before the provider accepts the send — is a stale push to the
displaced holder, **a POST-REVOCATION DISCLOSURE of whatever the body carries,
stated as such**: for the two new families, only that a decision exists;
for the delivered families, the title (or the option and material for the
announcement) reaching a device whose standing ended inside the
provider-call window — the same class as the 4c stale-tab residual the Board
ruled on, recorded as a disclosure bound, not claimed away.

P40 therefore proves, PER FAMILY: the claim-time re-target; the
invalidation-vs-claim barrier in both orderings — invalidation-first → the
delivery re-targets or cancels at claim; claim-first-then-invalidation-
before-send → the final re-read drops it, asserted by holding the consumer at
the pre-send barrier — for the decider (a forward), the forward family (a
SECOND forward after the first's claim, AND a PMC withdrawal after the claim),
the countersign family with its FROZEN set (A and B frozen, A removed at the
pre-send barrier → B receives, A receives nothing, the delivery
`succeeded`/`dispatch` unmarked; the last architect removed after the claim →
nothing sent, the delivery marked; A frozen alone, B added with no crossing
→ B receives nothing from this delivery and holds the Inbox item), the
USER-targeted families (a `consultation_responded` push claimed for an
active architect requester who is removed at the pre-send barrier → nothing
sent; the PMC requester's response SURVIVES a withdrawal committed at its
pre-send barrier while the architect requester's is dropped; an org-admin
requester with NO membership row RECEIVES the response push), the
direct-transition arm (a `decider` push claimed, a direct `pending →
approved` bundle committed at the pre-send barrier under an inactive chain →
nothing sent, the delivery marked; the fan-out arm — A sent, the transition
committed at B's pre-send barrier, B skipped, no mark), the archive arm
(archive at the pre-send barrier → nothing sent, the delivery marked;
restoration re-notifies nothing and the awaiting decision is served to the
architect's Inbox on the next read), and the consultee push surviving each.
This is a change to 4c's cleared surface, made here deliberately and named
as such.

### 3. The uniform seal contract — every 4b–4d fact table

The starting material stated the rule as six DB obligations beside each
fact's zod contract and service authority. This plan adds a SEVENTH, the
generative rule behind #552's first finding and the fourteen review rounds
before it. Each fact table carries:

1. **Append-only + evidence freeze** — UPDATE/DELETE sealed at the row AND
   `TRUNCATE` sealed at the statement (both named; a row trigger never fires
   for TRUNCATE); every evidence AND discriminator column immutable
   (`origin`, kinds, designations, `outcome`, the frozen `<act>ByRole` /
   `<act>ByName` pair included), with the named close-transitions as the
   only permitted mutations.
2. **Transition pairing, BOTH directions** — where the fact records a state
   transition, the row commits only with its same-transaction transition and
   the transition only with its row (deferred constraint triggers — the
   forward-door discipline); EXACTLY ONE fact per paired transition (§B.5).
3. **Actor standing** — the recorded actor must hold ACTIVE standing that
   authorizes the act, judged at the DB under `phase6_try_readiness`; AND the
   fact's frozen `<act>ByRole` must be a role THAT actor holds — judged per
   user by `phase6_user_holds_role(project, user, role)`, with the
   membership-less org owner/admin admitted as `pmc` (the token role
   `AuthService.signInAccess` and the project access path issue such an
   actor; the live `OrgMembership.role IN ('owner','admin')` read is the
   evidence, and no separate label is recorded or demanded) — AND its
   frozen `<act>ByName` must equal the account's display name read by the
   NEW orgs-owned `phase6_user_display_name(userId)` at the act (the fact is
   written in the act's transaction, so "at the act" and "at commit" are the
   same instant); a supplied role the actor does not hold, or a supplied
   name that is not the account's, is refused at the FACT (the service
   command stays the authority; the seal is the hostile-path backstop; no
   platform-owned trigger performs any orgs lookup).
4. **Subject eligibility** — the decision must be in exactly the states the
   act is legal in: the SAME predicate as the command CAS, re-judged by the
   seal — AND the project operable via `phase6_project_operable`, lock before
   read, the 4c §A order.
5. **Same-project composite FKs** — every reference project-bound through
   the child's own `projectId`.
6. **Command provenance** (4c, delivered) — `NOT NULL sourceCommandId` with
   the project-contained composite FK to `CommandExecution`, the one-use
   `(projectId, sourceCommandId)` UNIQUE, and the deferred result-binding
   constraint trigger tying the row to the reserved command's RESULT and
   the receipt's `actorId` to the row's recorded actor. **Extended for
   BUNDLES**: the delivered `phase6_t4c_provenance_bound` requires the
   receipt's `resultRef` to name the row itself, which a command writing ONE
   fact satisfies and a command writing a bundle (forward-on: request +
   forward; the stranded return: resolution + request, + the departed
   holder's forward) cannot. The 4d-owned `phase6_t4d_provenance_bound`
   accepts a `resultRef` naming the row OR the bundle's PRIMARY fact when the
   same transaction pairs them and both cite the SAME receipt — the primary
   is the reject-back/forward-on REQUEST for `decisions.disagree` and the
   RESOLUTION row for `resolveStrandedCountersign`; the per-table one-use
   UNIQUE still holds. `ChangeRequest` joins the contract — and it carries no
   `projectId` today, so 4d-i adds `projectId`, backfilled from each row's
   decision and, for every later INSERT, filled by a BEFORE INSERT trigger
   that copies it from the row's decision when the writer omits it (so the
   column is `NOT NULL` from the start while the previous release's
   `requestChange`, which never names it, keeps working during the drain),
   bound by a composite FK `(projectId, decisionId)` to the delivered
   `Decision(projectId, id)` candidate key; THEN the nullable
   `sourceCommandId` with its composite FK and partial one-use UNIQUE, which
   the P33b seal REQUIRES for every `countersign_rejection` row. A
   `'standard'` request written by 4d-ii's `requestChange` carries
   `sourceCommandId` too, and its receipt must BIND: 4d-ii changes the
   `decisions.requestChange` receipt to name the created `ChangeRequest.id`
   (a command that writes a fact names THAT fact; `resultRef` is receipt
   evidence, never the command's response). A NULL stays admissible on
   standard rows ONLY during the drain, for the legacy rows and the previous
   release's writer: 4d-iii installs the trailing INSERT-time seal requiring a
   non-NULL `sourceCommandId` on EVERY new `ChangeRequest` row whatever its
   origin — historical NULL rows untouched.
7. **Effect correspondence — a seal VERIFIES, it never EMITS.** Where the
   fact's transition owes an effect, the transition commits only with that
   effect present in the SAME transaction, judged at the deferred pairing
   check: exactly ONE `DomainEvent` of the transition's event type, in the
   project, about the decision (`entityType = 'Decision'`, `entityId` the
   decision), `actorKind = 'human'` with `actorId` equal to the paired
   fact's recorded actor — read through the platform-owned
   `platform_tx_event(projectId, eventType, entityType, entityId)` (the rows
   of the current transaction; the same kernel read shape as the receipt
   binding); exactly ONE `DecisionEvent` audit row of EACH kind the table below
   lists for the transition, for the decision, with `actorId` the same actor
   and `actorRole` the fact's frozen role (a decisions-owned row); and, for a transition that owes a
   feed row, exactly ONE `Notification` for the project whose `eventId`
   names that event and whose `decisionId` is the decision. Zero of any part
   is refused; two of any part is refused; a part naming another decision,
   actor or event is refused. There is ONE emitter — the service — for every
   writer at every instant; a hand-run bundle that reproduces the ledger
   protocol reproduces the whole bundle (receipt, fact, transition, event,
   audit row, feed row) or does not commit; nothing is emitted from
   PL/pgSQL, no twin of `emitEvent` or of the notification helper exists,
   and the kernel's `expandMissingDeliveries` gives a hand-written event its
   delivery rows on the relay's next pass (so a legacy/shadow-mode process
   picks such a delivery up through the relay's recovery pass rather than
   the immediate dispatcher — the same path a service-emitted delivery takes
   when its process dies before dispatch). `Notification.eventId` is the
   column this obligation needs: nullable, an FK to `DomainEvent(eventId)`,
   partially UNIQUE where non-NULL (one feed row per event — the promised
   idempotency, now a constraint the schema can express), stamped by every
   decisions notification writer from 4d-ii and by the 4d transitions from
   their first commit; NULL only on legacy rows and on rows the previous
   release writes during the drain; and REQUIRED — by a trailing 4d-iii
   INSERT-time seal — on every new row carrying a `decisionId`.

   The correspondence table, closed over every transition 4d seals:

   | transition | event (`DomainEvent.eventType`) | audit (`DecisionEvent.type`) | feed row | actor bound to | armed |
   |---|---|---|---|---|---|
   | `pending`/`change → awaiting_countersign` (the provisional approve) | `decision.approved` / `decision.reapproved` by `approvedFrom` | `approved` / `reapproved` | the provisional notice | the head revision's `approvedById` | 4d-i (no pre-4d writer can reach the state) |
   | `awaiting_countersign → approved` by countersign | `decision.approved` / `decision.reapproved` by the revision's `approvedFrom` | `countersigned` | the green approved notice | `countersignedById` | 4d-i |
   | `awaiting_countersign → approved` by `completed` resolution | the same, by `approvedFrom` | `stranded_resolved` | the green approved notice | `resolvedById` | 4d-i |
   | `awaiting_countersign → change` by disagreement (reject-back or forward-on) | `decision.change_requested` | `change_requested` | the change-request notice | `requestedById` | 4d-i |
   | `awaiting_countersign → change` by `returned` resolution | `decision.change_requested` | `stranded_resolved` + `change_requested` | the change-request notice | `resolvedById` = `requestedById` | 4d-i |
   | the holder mutation (forward, generic or forward-on) | `decision.forwarded` | `forwarded` | the forward notice | `forwardedById` | 4d-i |
   | `pending`/`change → approved` with NO chain (the direct approve) | `decision.approved` / `decision.reapproved` | `approved` / `reapproved` | the green approved notice | the head revision's `approvedById` | event + audit row from 4d-i (the delivered `approve` writes both in-transaction, so the previous release is compatible through the drain); the feed row's `eventId` binding from 4d-iii, since the previous release writes the row without it |
   | `change → approved` by standard `withdrawChange` | `decision.change_withdrawn` | `change_withdrawn` | — (the delivered path writes none) | the receipt's actor | event + audit row from 4d-i (delivered, in-transaction) |
   | the architect standing flip on `Membership` | `membership.standing_changed` naming the fact | — (orgs; the fact is the audit) | — | the fact's `actorId` | 4d-i (no pre-4d writer can flip the role) |

   A `DecisionEvent` written by the service for a transition this table does
   not list (the delivered `issued`, `drafted`, `draft_updated`,
   `change_withdrawn` on other paths) is untouched; the seal judges only the
   transitions it admits.

The closed enumeration over every fact these units add:

| fact | pairing (2) | actor standing (3) | subject eligibility (4) | provenance (6) | effect (7) | probes |
|---|---|---|---|---|---|---|
| `Decision` holder columns (4b) | the forward door, from 4d | named decider membership ACTIVE at create/holder-write | the kind⟺status CHECKs; the delivered orphan guard, open set widened to `awaiting_countersign` | — (the decision row's own commands are ledgered) | `decision.forwarded` on the holder mutation | P17/P18/P34/P39 |
| `DecisionConsultation` (4c) | — | `requestedById` ACTIVE pmc **+ architect (4d)**; consultee ACTIVE at insert | open (`pending`/`change` **+ `awaiting_countersign` (4d)**) AND published | delivered | delivered (service-emitted, not sealed) | P25/P27 |
| `DecisionConsultationResponse` (4c) | — (UNIQUE per consultation) | responder is the named consultee | the same predicate re-judged at response, cycle-frozen | delivered | delivered | P23/P25/P27 |
| `DecisionForward` (4d) | holder mutation ⟷ row | `forwardedById` = holder-user / pmc / architect, ACTIVE; frozen role + name judged | `pending`/`change` only; `awaiting_countersign` ONLY with the same-tx `countersign_rejection` request | required | `decision.forwarded` + `forwarded` + notice | P34 |
| `DecisionCountersign` (4d) | finality flip + `awaiting → approved` ⟷ row | `countersignedById` ACTIVE architect; frozen role + name judged | `awaiting_countersign` only | required | the finalizing event + `countersigned` + the green notice | P31 |
| `DecisionStrandedResolution` (4d) | outcome BUNDLE ⟷ row | `resolvedById` pmc; frozen role + name judged; non-blank reason | `awaiting_countersign` AND no active architect | required | per outcome, the table above | P29b |
| `DecisionApprovalRevision` finality (4d) | birth value by chain presence; flip only by paired fact; one row per approval transition | carried by the pairing facts; `approvedByRole`/`approvedByName` judged when present | the approved-entry seal | delivered (4c) | the awaiting entry's and the direct approve's rows | P31/P37/P42 |
| `ChangeRequest` origin (4d) | `countersign_rejection` ⟷ the exact `awaiting_countersign → change` transition, AND with its producer's fact (P33b) | `requestedById` ACTIVE architect under an ACTIVE chain, or the resolving pmc; frozen role + name judged | the awaiting subject | REQUIRED for `countersign_rejection`; admissible NULL on `'standard'` rows only until 4d-iii | `decision.change_requested` + `change_requested` + notice | P29b/P33/P33b |
| `MembershipTransition` (4d, orgs) | the architect standing write ⟷ row; one flip per membership and per project per transaction | `actorId` holds team-management authority at the transaction's start | — | required (`phase6_t4d_membership_transition_bound`) | `membership.standing_changed` naming the fact, `activeCount` equal to the register | P29b |

A future fact table added under these units inherits this contract by
default: omitting an obligation is a defect by construction, and each unit's
review packet walks this table for every fact it ships. The unit writes only
decisions-owned and orgs-owned TABLES, the platform-owned register and
kernel primitives named above, and the ADDITIVE columns on foreign rows it
declares (`revisionFinalized` on the two spec tables; `Notification.eventId`
on the platform feed table — an obligation the correspondence rule imposes,
added to the platform's own model by the platform's own migration step).

### 4. The narrowing ledger — every withdrawn mechanism, the finding it answered, and the answer that stands

Nothing below is dismissed. Each row names a mechanism #552 carried, the
review finding (by the closed PR and round in which it was raised) that the
mechanism answered, and how THIS design answers the same finding — by
refusal, by a delivered rule, or by the state being unrepresentable. A
reviewer who finds a row whose answer does not hold has found a defect in
this plan, and that is the review this unit asks for.

| withdrawn from #552 | the finding it answered | how this plan answers it |
|---|---|---|
| `platform_emit_event` — the PL/pgSQL twin of `emitEvent`, canonical-pinned, the crossing event emitted by the standing trigger, every 4d transition's event emitted by its seal | #546 round 19 (a side effect bound to service code a hand-run receipt bypasses); #547 round 21 (`decision.awaiting_countersign` emitted in the service path while the seals admitted a hand-run bundle that emitted nothing); #548 round 24 (the twin's missing actor argument) | Obligation 7: the seal REQUIRES the same-transaction event with the fact's actor and refuses the transition otherwise. A hand-run bundle that emits nothing cannot commit, so no committed state ever lacks its event; the service is the one emitter and there is no second one to keep byte-identical. The membership instance requires `membership.standing_changed` naming the fact for every standing flip. |
| The seal-written `DecisionEvent` audit row | #547 round 22 (`Notification` and `DecisionEvent` rows written by service code a hand-run bundle skips) | Obligation 7 requires the same-transaction `DecisionEvent` of the transition's kind with the fact's actor and role; a bundle without it is refused. |
| `platform_write_notification` — the notification twin, the seal-written feed row, "idempotent per (event, recipient)" | #547 round 22 (as above); #551 round 29 (the feed row derived in `decisions.effects` after the response, so the approval notice stayed absent until an unrelated refresh); #552 round 32 finding 3 (the promised idempotency had no schema) | The service writes the feed row in the transition's transaction, before the response, as the delivered 4b `approve` does today; obligation 7 requires it, bound by `Notification.eventId` (staged in 4d-i, partially UNIQUE, FK to the event) — one row per event is a constraint, not a promise. |
| The count-based emitter handoff (one same-transaction approval event → the seal defers; none → it emits; two → refused) and, before it, the `RolloutRetirement`-marker-keyed arm | #549 round 26 (the no-chain direct bundle updating the row without advancing the stream); #551 round 30 (the seal emitting the no-chain approve TWICE beside a pre-4d process); #552 round 31 (the disarmed window leaving a bundle permanently un-emitted; the marker read racing its insertion); #552 round 32 finding 1 (the count admitting a forged single event) | Obligation 7 on the no-chain `pending`/`change → approved` transition: exactly one `decision.approved`/`reapproved` event with the revision's `approvedById` and exactly one `approved`/`reapproved` audit row are REQUIRED from 4d-i. The delivered `approve` writes both in-transaction, so the pre-4d process is compatible through the drain with no arming and no window; a bundle without them is refused, so nothing is ever left un-emitted; the seal never emits, so there is no second emitter to race; correspondence is judged field by field, so a forged single event fails on its actor, kind or count. |
| `DecisionCountersignNotice` — the claim-time notice register with `standingPosition`, its INSERT-time correspondence seal (`xmin = txid_current()::text::xid` against the lease), the triple uniqueness, `ProjectRoleStanding.lastCrossingPosition` | #549 round 25 (the unordered push worker sending the original demand to B before the ordered consumer handled either crossing); #550 rounds 27–28 (the notice forgeable; the notice racing the irreversible send); #551 round 29 (the handler cancelling a claim resolved against a later standing; the per-delivery uniqueness contradicting the retry rule); #552 round 32 finding 2 (the notice's position and the send's recipients disagreeing) | The countersign demand's recipients are FROZEN AT EMISSION under the readiness lock, in the immutable dispatch intent and the delivery payload; the consumer never resolves a role at claim for this family. The crossing consumer decides per decision from the kernel's stream positions (`EventStreamQuery.latestPosition` of the decision's latest `decision.awaiting_countersign` event against the crossing's position): a demand raised at or after the crossing was resolved against the current standing and is left alone; an earlier one is cancelled (unsent) and replaced. Nothing is appended at claim, so nothing at claim can disagree with the send. |
| The per-consumer `onClaim` hook inside the lease transaction and the refactor of `claim`, `claimOne` and `claimExternalRecovery` | #551 round 29 / #552 round 31 (the claim hook needing the lease's row lock and transaction for the notice) | No notice is written at claim, so no consumer logic needs the lease transaction; the delivered relay is unchanged. |
| The reserved-value repair for `Decision` rows — `decision:repair-reserved-value` with `--decider-kind`, `--withdraw` and `--revert-provisional`, the `DecisionRepairAction` evidence register, the repair bootstrap transaction | #543 round 14 / #546 round 20 (a `Decision` row stored with a new enum value in the gap); #548 round 24 (a repair routed through a client that cannot read the row); #549 rounds 25–26 (the awaiting row neither branch could clear; the repair needing schema the aborting migration had not created) | `DecisionStatus` and `DeciderKind` are PostgreSQL enum types: no `Decision` row can hold either value before the `ADD VALUE` statements, and the two TEXT-judged doors are installed in their own transaction BEFORE those statements, so the gap the audit and the repair existed for is unrepresentable at every instant. There is no `Decision` audit, no repair branch and no evidence register; the additive nullable columns the bootstrap transaction carried are ordinary statements of 4d-i's permanent portion. The `Membership.role` and `User.role` audits stay (free-text columns), with the re-role recovery, which the pre-4d client can perform because those columns are strings it reads. |
| `CommandExecution.actorRole`/`actorName` — the receipt-captured pair, its freeze arm, the nullable-through-drain rule, the trailing 4d-iii receipt seal, and the round-31 staging | #550 round 28 (the frozen role and name supplied by the fact writer, so a PMC's hand-run forward could freeze `architect`); #551 round 29 (the receipt validated by a project-wide predicate in a platform trigger reading orgs standing; the pair mandatory while pre-4d processes reserve without it); #552 round 31 (the pair absent from 4d-i's inventory; the membership-less owner/admin issued `pmc` yet recorded otherwise) | Obligation 3 judges the fact's frozen `<act>ByRole` and `<act>ByName` at the OWNING fact seal against the actor's live standing (`phase6_user_holds_role`, with the owner/admin arm admitting `pmc`) and the account's display name (`phase6_user_display_name`) at the act — which is what the receipt pair existed to prove, without a platform trigger performing any lookup and without a receipt column pre-4d processes cannot write. A supplied role the actor does not hold is refused at the fact. |
| `OutboxConsumerCutover` — the sealed per-project registration cutover, its one-time fill arm (`xmin` predicate), the whole-phase replay guard | #546 round 20 (a freshly registered consumer replaying every historical `project.restored` through the backfill scanner); #547 rounds 21–22 (the cutover unsealed; created in the wrong unit); #549 round 26 and #550 round 27 (the fill arm's staging and predicate) | The round-20 hazard was retired by #547 round 21, when restoration stopped re-emitting; and this plan consumes no `project.restored` at all (parking is withdrawn — next row). `decisions.effects` consumes only `membership.standing_changed`, a NEW type with no history; every historical event of every other type becomes a recorded `noop` through its `deliveryFor`, exactly as a non-invalidating event does — bounded, one-time, and probed under P38 (zero notifications, zero `countersign_renotified` rows at registration over a database holding history). |
| Archived-project PARKING — the `parked` consumer outcome, the far-future `nextAttemptAt` HOLD sentinel, `lastError = 'project_archived'`, `releaseParked`, the `project.restored` consumption, the recovery-claim `nextAttemptAt` fix, `outbox:release-parked` | #540 round 7 (archival absent from the pre-send hook); #545 round 18 (the archived-project drop never re-emitted on restore); #547 rounds 21–22 and #548 rounds 23–24 (the park's transaction, the relay overwriting it, the recovery claim reclaiming it, a row parked after its first recipient) | The pre-send hook re-checks operability for EVERY family (round 7's finding stands answered). For the drop itself this plan takes the DELIVERED 4c rule: a non-operable project drops the delivery with the recorded cancellation mark at claim or at the pre-send barrier, and restoration re-notifies nothing — the cleared behaviour of every delivered decision push (`consultation_requested`, `consultation_responded` and `decider` already drop this way, and 4c has no restore re-emit). The demand is not lost: it is the awaiting or forwarded decision itself, served to the Inbox and Decision Log on the next read after restoration; a push is a nudge, never the record (the Board's informs-never-gates ruling applied to a notification). Round 18's premise — that restoration OWES a re-push — is answered by naming the rule rather than building a second delivery lifecycle for it; the reviewer is asked to judge that as a product rule stated, not a finding dropped. |
| `MembershipTransition.standingEventId` with its one sealed NULL→id UPDATE exception, and `Membership.lastTransitionId` | #547 round 21 (the crossing event unable to name its transition fact); #547 round 22 (the association chosen after the write); #548 round 23 (the fact column-immutable while the column had to move) | The event names the fact (payload `transitionId`) and obligation 7's membership instance requires exactly that event for exactly that fact in the same transaction; the fact needs no back-pointer, so it is fully immutable with no exception, and the swap case is refused outright (one standing flip per membership and per project per transaction). |
| The `awaiting entry precedes the crossing` rule stated as "its provisional revision being newer than the crossing" | #549 round 25 / #551 round 29 (the ordering between a demand and a crossing) | Stated as a kernel stream-position comparison: the decision's latest `decision.awaiting_countersign` event against the crossing event's position, both recorded by the kernel at emission under the ONE readiness lock, so "before" and "after" are total and exact. |
| The countersign demand's ROLE-targeted fan-out resolved at claim | #538 round 4 (a role-targeted push sent to a member who lost standing between claim and send); #546 round 19 (the subject re-judge once per delivery) | The frozen set is re-judged per recipient at the send by `phase6_user_holds_role` (the same per-recipient hook), and the subject is re-judged per recipient; the delivered `decider` family keeps the claim-time role resolution with the same per-recipient hook. |

Everything else #552 carried is carried here unchanged in substance: the
four reservation doors installed before the enum values; the `Membership`
and `User` audits with the re-role recovery through the real runner; the
stale-client `countersign-v1` boundary in full; the `ProjectRoleStanding`
kernel register and the `countersignRequired` overlay; the
`MembershipTransition` fact and the three orgs membership commands joining
the ledger; the forward door, the countersign atomicity, the birth and entry
seals, the replaced append-only seal, the stranded resolution and its
departed-holder re-homing, the disagreement's two paths, the finality key
with the kept defaults and the writer sweep, the `ChangeRequest` freeze and
provenance, the bundle-aware provenance binding, the reader enumeration and
its tripwire, the Inbox and Portfolio arms, the catalog ceilings, the
consumer contract bumps with the catalog-data migration in
`ALWAYS_EXECUTE`, the external-effect reseal staging, the `RolloutRetirement`
marker with its transient block, the ONE lock order with leased deliveries
skipped, the per-recipient pre-send hook, the cancellation-by-subject
inventory, the disclosed residual, and the seal-stripped RED discipline.

## §B — The carried §D obligations, elaborated (P31b/P42b, P31c/P34b, P33b)

The merged 4b plan's §D reserved these probe numbers to this unit and bound
each carried question to its probe. The full rows:

4. **P31b/P42b — every register INSERT pairs with its approval act.** EVERY
   `DecisionApprovalRevision` INSERT pairs with its same-transaction approval
   act and authorized decider, under an ACTIVE chain AND an INACTIVE one.
   PROVES: a revision born `finalized = true` with no approval transition on
   a still-`pending` decision is unrepresentable, so the widened finality FK
   can never let provenance trust an approval that never happened. HOW: 4c
   already binds every revision to a COMPLETED `decisions.approve` receipt
   naming this decision (`DecisionApprovalRevision_t4c_provenance`), which is
   the "approval act" half; 4d-i's BEFORE INSERT birth seal adds the chain
   half and a DEFERRED pairing that the same transaction carries the
   decision's approval transition (`pending`/`change` → `approved` under no
   chain, → `awaiting_countersign` under a chain) whose recorded actor holds
   decider standing for the decision's CURRENT holder designation, WITH its
   effects (obligation 7) — and the REVERSE: every transition INTO
   `awaiting_countersign` carries its same-transaction provisional revision,
   undisposed, or is refused at commit, so a bare status flip cannot
   manufacture a countersign demand with no head to finalize. RED SITE: the
   hostile insert of a `finalized = true` revision with a forged receipt into
   a `pending` decision — under the active chain (born-true refused by the
   birth seal) AND under the inactive chain (no same-tx transition, refused
   at commit); the inactive-chain bundle WITH the transition but WITHOUT its
   event or audit row, refused at commit. STAGING: 4d-i, seal-stripped run
   (§C).
5. **P31c/P34b — exactly one matching fact per paired transition.** Two
   matching `DecisionForward` rows over ONE holder mutation, and two
   `DecisionCountersign` rows over ONE finality flip, are both refused.
   PROVES: the pairing is one-to-one, not one-to-many — a duplicate evidence
   row would let a second actor claim the same act. HOW: the forward reverse
   seal counts the same-transaction forward rows for the decision and refuses
   > 1 (the holder door already requires the ONE row to match
   field-for-field); `DecisionCountersign` carries UNIQUE `(projectId,
   decisionId, revisionId)` so the duplicate is unrepresentable at the index,
   AND the reverse seal refuses a second row in the same transaction; AND the
   APPROVAL REGISTER: a direct transaction could reserve two valid
   `decisions.approve` receipts under different idempotency keys, make ONE
   transition and insert revisions v1 and v2 citing the two receipts — so the
   register's deferred pairing seal counts the same-transaction
   `DecisionApprovalRevision` inserts per decision and refuses more than ONE,
   exactly as many as the transaction's approval transitions of that decision
   (the lifecycle door admits one), and the birth seal requires the new row's
   `version` to be the decision's next; AND obligation 7 counts the events
   and audit rows the same way — exactly one of each per transition, two
   refused. Absorbed into §A.3's obligation 2 for every future fact. RED
   SITE: the two-row hostile bundles, the two-receipt two-revision bundle,
   the two-event bundle. STAGING: 4d-i.
6. **P33b — the `countersign_rejection` request joins the uniform contract
   as a full row.** Its INSERT pairs bidirectionally with the exact
   `awaiting_countersign → change` transition, validated for its PRODUCER and
   an awaiting subject — a forged disagreement bundle attributed to an
   unrelated user is unrepresentable. HOW: a DEFERRED seal on `ChangeRequest`
   INSERT with `origin = 'countersign_rejection'` requires the same
   transaction to carry the subject's `awaiting_countersign → change`
   transition AND exactly one of the two legal producer shapes — (a) the
   ARCHITECT's disagreement: NO same-transaction `DecisionStrandedResolution`
   for the decision, the chain ACTIVE, and `requestedById` resolving to
   ACTIVE `architect` standing under `phase6_try_readiness`; or (b) the PMC's
   stranded RETURN: a same-transaction `DecisionStrandedResolution` for the
   decision with outcome `'returned'`, the chain INACTIVE, and
   `requestedById` EQUAL to that row's `resolvedById` holding ACTIVE pmc
   authority (`phase6_user_orchestration_authority`) — AND a non-NULL
   `sourceCommandId` bound through the bundle rule of §A.3 obligation 6 (the
   request is the primary for (a), the resolution is for (b)) AND the
   `decision.change_requested` event and `change_requested` audit row of
   obligation 7. The decision-side lifecycle seal requires the transition to
   carry exactly one such request. The ordinary `'standard'` request keeps
   its delivered pairing untouched. RED SITE: the orphan rejection request;
   the request attributed to a non-architect under an active chain; a
   returned-bundle request attributed to anyone but the resolving PMC, or to
   an architect; the transition without the request; the rejection request
   with NO `sourceCommandId`, or citing a receipt whose result names neither
   it nor its paired primary; the bundle without its event. STAGING: 4d-i.

## §C — The probe table (P28–P42, plus the carried arms)

Every probe's RED evidence is anchored to the implementation unit's ACTUAL
BASE COMMIT, not to an in-branch shape commit. Every arm whose subject
EXISTS at base (the approve CAS, the holder freeze, the consultation
carve-out, the decider push family, the `withdrawChange` restoration, the
orphan guard) runs as a base-compatible black-box probe — HTTP against the
guarded surface, SQL against the base-migrated schema — executed and
RECORDED against the real base SHA in the packet before any contract, column
or enum is added. Arms whose subject is a NEW table, column, enum value or
seal are executed from the implementation base by the SEAL-STRIPPED
MIGRATION RUN (**BOARD DECISION, not re-litigable** — 2026-08-29, on PR
#480, carried verbatim from the 4c plan §C): the probe harness, checked out
AT the implementation base, applies 4d-i's migration TWICE to scratch
databases — once with the specific seal statement omitted (the omission
performed BY THE TEST, one named object at a time), where the hostile insert
is ACCEPTED, and once whole, where the same insert is REJECTED — both runs
recorded in the packet with their SQL and outcomes. Red sites name where
today's behaviour lives.

| probe | proves | red site / staging |
|---|---|---|
| P28 | the role in every mirror: `TokenRole`, both zod enums, `PushRole`, `KNOWN_ROLES`, the manifest permissions, `ROLE_POLICY` (the exact row set), the schema comment, the web role lists and pickers; the DESIGNATION in every mirror (`DeciderKind`, `DECIDER_KINDS`, the shared type, `viewerIsDecider`, `deciderNoun`, the picker, the audience selectors, the `deciderPush` architect arm and the `deciderPushTarget` arm — a published architect-designated decision's RECIPIENTS are every active architect's links and no client link, RED at base where the fallthrough targets `client`); the widened targeted-catalog ceilings; `countPending`'s architect and awaiting arms; a decision published to an architect holder and a consultation requested from an architect end to end; **P28b** the dark delivery — the four reservation doors, the `Membership`/`User` audits barrier-probed in both orderings on the shipped file (writer-first → ABORT; migration-first → REFUSED), the abort → re-role → `migrate resolve --rolled-back` → redeploy recovery driven through the REAL runner for an active row, a soft-removed row and a dev `User` fixture, the service refusals BEFORE any write (an architect added by a NEW email while reserved → 409 and ZERO `User` rows; after 4d-iii the member is created), the dev session refusing `architect` before either branch while reserved and the synthetic fallback never minting it, and the `ALWAYS_EXECUTE` replay arms — a post-4d-iii database holding an active architect replays 4d-i, finds the marker, installs no door and no refusal function, aborts nothing; a pre-4d-iii database still installs and audits | the role vocabulary, the designation contract, the reservation, the audit, the runner |
| P29 | no-active-architect byte-identity: with no architect membership ever, approve lands `approved` directly with `finalized = true`, forward works for holder/PMC and is refused for the missing role's authority, `countersignRequired` is absent, a `standard` origin is omitted, the whole 4b/4c surface is byte-identical (the wire-shape tripwire); **P29c** mixed-version byte-identity — with the reservation ARMED every project is chain-off, no row can be `awaiting_countersign`, no membership can be `architect`, no `DecisionForward` row, `decision.forwarded` delivery or architect-designated row (draft or published) can exist, no Forward renders, every read a pre-4d instance performs sees only values its enums know; and the STALE-CLIENT arms — every strip / refuse / additive-ignorable classification of the completeness tripwire exercised for `recorded-v1` and `countersign-v1`, the activation-between-check-and-approve barrier in both orderings, an architect signing in through EACH token-minting route refused for the lesser client and served for the newer, after 4d-iii | the whole 4b/4c surface; the interceptor; the four in-command contract checks |
| P29b | removed-architect deactivation + the stranded decision: the chain deactivates for NEW approvals; `decisions.resolveStrandedCountersign` drives BOTH outcomes with their bundles and their effects (the `completed` outcome emitting by `approvedFrom`; the `returned` bundle's request authored by the resolving PMC and admitted by P33b; the returned-resolution bundle MISSING its request refused; a whitespace-only reason refused at zod AND the CHECK); the bare hostile awaiting flip under the INACTIVE chain refused without the fact; refused while an architect is still active; the architect-reappears race deterministic; the departed-holder `returned` with a target re-homing into `change` with the forward fact, without one refused; the RE-NOTIFICATION — approve → A removed → B added, exactly one new `decision.awaiting_countersign` delivery per still-awaiting decision, B and only B receives it, the `countersign_renotified` audit row naming the crossing event and the transition; the HAND-RUN sequence — A removed and B added by receipt-backed direct bundles carrying their events: the same one delivery and the same audit row; A-active/B-added: no crossing, nothing re-emitted, B's Inbox item present; the register after EVERY transition shape; the crossing event on every architect activation/deactivation and the second session's tab refreshing its modal copy; the ineligible-actor fact refused; every direct-write refusal of §A.2's membership paragraph; the cascade probes | the stranded command; the standing register; `decisions.effects`; the membership seals |
| P30 | forward authority (holder/PMC/architect), ACTIVE target only, eligible states only — terminal AND `awaiting_countersign` refusals both probed through the guarded HTTP route with the shared `ROLE_POLICY` action | the forward command |
| P31 | the `awaiting_countersign` lifecycle: approval under a chain lands it with `finalized = false` — a revision BORN `finalized = true` under an active chain refused by the INSERT seal; the countersign is ONE atomic act sealed from BOTH sides (the boolean-only hostile flip refused; the orphan countersign row refused at commit; the split two-transaction replay refused; the REPLACED append-only seal — a DELETE and an UPDATE of any column other than the flip refused, the paired flip accepted, the delivered `_append_only` trigger absent by name after 4d-i) AND attributed to an ACTIVE architect AND carrying provenance (the 4c arms verbatim) AND carrying its EFFECTS — the finalizing event by the revision's recorded `approvedFrom` (the reopened → reapproved-into-awaiting → countersigned sequence end to end, with the `approved`/`reapproved` + `countersigned` audit rows), a countersign bundle WITHOUT its event, WITHOUT its audit row, WITHOUT its feed row, with TWO events, or with an event naming another actor, each refused at commit; the ENTRY sealed from the decision side (the bare transition with no revision, the re-entry onto a disposed head, the transition under an INACTIVE chain, each refused; the legal approve accepted with its provisional notice bound to its event); the frozen `approvedByName`/`approvedByRole` on every 4d-ii revision, a rename between the acts carrying the act-time name; the reader tripwire RED for the value the moment it exists; the Inbox item and badge; the architect's controls as a product path; the consultation carve-out and the response push for an architect requester; the web arm driving the client approval path under an active chain asserting the provisional copy; **P31b/P42b** and **P31c/P34b** (§B) | `decisions.approve`; the register; the readers |
| P32 | self-countersign is TWO attributed acts under two idempotency keys — one combined act is refused; the two acts appear as two ledger receipts and two register facts | the countersign command |
| P33 | both disagreement outcomes: origin-stamped open `ChangeRequest`, `withdrawChange` refusal on `countersign_rejection`, the class-wide evidence freeze INCLUDING `decisionId`, `origin`, `revisionId`, `projectId`, `sourceCommandId` and the frozen role/name pair (the re-point, the re-label, the NULLing and the replacing UPDATEs each refused), impacts rendered, reject-back AND forward-on driven through re-approval to completion — forward-on through the ONE forward door with its `DecisionForward` fact (the request the bundle's provenance primary, the forward citing the same receipt); the `origin` serialized only when non-`standard` on live, projected and rebuilt DTOs and the Withdraw affordance SUPPRESSED for a rejection request while the direct call still 409s; the direct-SQL disagreement bundle by an ACTIVE architect with every pairing, standing and eligibility seal green but NO receipt refused at commit, and with NO event refused at commit; the standard request's receipt naming the request row (naming the decision refused at commit; the keyed replay appends nothing); **P33b** (§B.6) | the `ChangeRequest` machinery; the disagree command |
| P34 | the forward chain: attribution (actor vs displaced holder), the web Forward affordance following `rollout.phase6_4d`, the `decision.forwarded` emission + re-seal, the NON-HOLDER architect's product path (RED at base where the audience rule hides the row; absent for a removed architect and while the chain is inactive), the non-blank reason at both layers, the PAIRING sealed in BOTH directions (no row; a mismatched row; the orphan row; the same-target no-op at both doors), the DOOR status-gated (a matched forward on an `approved`/`recorded`/`withdrawn` decision refused; on an `awaiting_countersign` decision refused WITHOUT the same-tx rejection request), the TARGET's and the ACTOR's standing judged at the DB (a removed membership, an empty role, an inactive actor, an unauthorized actor, the role-holder arm's own case), the frozen `forwardedByRole`/`forwardedByName` judged (a hand-run forward by an active PMC freezing `architect` refused; a name that is not the account's refused), the forward bundle WITHOUT its event, audit row or notice refused at commit; the forward push's recipients FROZEN at emission (a role `toDesignation` resolved to its holders under the lock; the delivery payload carrying them) | the forward door; the attribution seal; the forward command |
| P35 | the forward-vs-approve barrier: both orderings deterministic, exactly one surviving outcome, a coherent holder; forward-vs-countersign likewise; every cancelling command vs a concurrent claim in both orderings under the ONE lock order, no deadlock | the row-lock serialization in the canonical order |
| P36 | the switch-writers barrier: architect role-change vs approve, activation AND deactivation, both orderings — the SERVICE activation and the HAND-RUN one (a direct INSERT under a hand-completed receipt with its fact and event) each vs `approve` and vs the stranded resolution, the hand-run writer refused as contended while the key is held and the terminal state asserted (approve-first → the activation lands after and the decision stays `approved`; activation-first → the approve lands `awaiting_countersign`); the orgs role mutations for `architect` in the §A enumeration; activation-vs-approve asserting the countersign deliveries per decision EXACTLY by ordering — approve-first under NO chain owes ZERO; activation-first → the approve's OWN emission is the ONE; a decision already awaiting when the activation crosses receives the ONE re-emit; never two for one decision; the ordered handlers' P-before-Q sequence with an approve landing between them | `lockProjectReadiness` on the orgs role mutations; `decisions.effects` |
| P37 | EVERY entry into `approved` sealed behind the chain, SERIALIZED by `phase6_try_readiness`: under an ACTIVE chain the direct `pending → approved` hostile flip refused, the finalized-boolean-only flip refused, the awaiting-flip without the SAME-TX countersign ROW refused, the standard `withdrawChange` restoration PASSES, the `countersign_rejection` restoration refused; under an INACTIVE chain direct approval legal ONLY from `pending`/`change` AND ONLY WITH ITS BUNDLE — the receipt-backed direct bundle with revision, transition, event and audit row ACCEPTED, the stream advanced and the `decisions.inbox` fold applied; the same bundle without its event refused at commit; with two events refused; with an event whose `actorId` is not the revision's approver refused; with the audit row missing refused; after 4d-iii, without a feed row bound to the event refused, and BEFORE 4d-iii the previous release's write shape (feed row with NULL `eventId`) accepted — the bare awaiting-flip refused without the stranded-resolution fact; the first-architect-activation-vs-approval barrier deterministic in both orderings | the status-transition seal + obligation 7 |
| P38 | the pre-send eligibility guard generalized to EVERY targeted decision push through PER-EVENT-FAMILY predicates — the two NEW families (`countersign`: awaiting + active architect; `forward`: installed holder AND `pending`/`change`) beside the three delivered: one positive AND one negative per new family; a valid consultee push NOT dropped by the countersign predicate; the responded predicate widened to the architect requester WITH the withdrawn-audience arm; a REQUEST push enqueued before a withdrawal cancelled for every consultee; the two new predicates bound under the BUMPED `webpush.notify` contract (`catalogVersion` 2 → 3), a process compiled at the old version refused by `syncConsumerCatalog` at startup, the catalog-data migration in `ALWAYS_EXECUTE` (a P3005 baseline over a pre-4d-ii database runs it and the upgraded process starts), a SECOND execution of 4d-ii's catalog file over an already-registered database a no-op; the `decisions.effects` REGISTRATION over a database holding historical events — every historical delivery `succeeded`/`noop`, zero notifications, zero `countersign_renotified` rows; the external-effect RESEAL sequence — the 4d-ii build refused in outbox mode under the 4d-i seal, served in shadow, resealed, then booting in outbox mode; `targetUserIds` admitted by `buildDispatchIntent` only for the two frozen-audience families and refused elsewhere | the per-family registration + the two new `decisions.*PushTarget` queries + the consumer catalog bump |
| P39 | the delivered orphan guard EXTENDED: removing or re-roling the NAMED holder, or the last active member of a ROLE designation, of an `awaiting_countersign` decision refused at BOTH layers (409 through `holdsOpenDecisions`; the DB guard on the hostile direct write); removing the LAST ARCHITECT NOT refused — it deactivates the chain (P29b) — INCLUDING when that architect is the named holder or the last member of the architect ROLE designation an awaiting decision names (the one named exemption), while a named holder who is an architect but not the last is refused naming the pending countersign, and a `pending`/`change` decision designated to the role still refuses removing its last architect | `holdsOpenDecisions` + `phase6_t4b2_membership_guard`, open set widened |
| P40 | the send boundary per family (§A.2): the claim-time re-target (the `deciderPushTarget` read taking the decision row lock); the invalidation-vs-claim barrier in both orderings for the decider, forward, countersign (the frozen-set arms), user-targeted and consultation families; the direct-transition arm and the fan-out arm; the archive arm — the delivery dropped with the mark at the pre-send barrier and NOTHING re-notified on restoration, the awaiting decision served to the architect's next read; the responded family's target-aware re-judge; the withdraw-vs-respond barrier in both orderings; the delivery row after a partial fan-out `succeeded`/`dispatch` with NO mark, marked only when every resolved recipient is stale; the consultee push surviving each; the residual stated per family | the consumer's per-recipient hook; the cancellation inventory |
| P41 | the delivered 4c lock-order + terminal-state probe EXTENDED to the transitions 4d adds that CLOSE the consultation-open set: `consultation.request` and `consultation.respond` vs the COUNTERSIGN, vs the `completed` stranded resolution, and vs the standard `withdrawChange`, each in BOTH orderings under the canonical lock order, asserting the TERMINAL invariant directly — consultation-first leaves the historical consultation/response standing and the finalizer commits `approved` beside it; finalize-first returns 409 with NO consultation row, NO response row and NO `consultation_*` effect; the `returned` resolution and the countersign REJECTION land `change`, which stays in the open set, so the same probe asserts the consultation ACCEPTED after them; no deadlock abort in either ordering | `consultations.service.ts` request/respond; `decisions.countersign`, `resolveStrandedCountersign`, `withdrawChange` |
| P42 | the finality candidate key over the ACTUAL provenance columns: provenance onto an unfinalized revision unrepresentable (both spec tables); `finalized → false` under reference refused by the FK; the additive backfill leaves every legacy revision `finalized = true` and every legacy spec row `revisionFinalized = true`, proven over the legacy fixture in `upgrade-proof.sh`; the DEFAULTS hold through the drain — a revision, a material spec and a labour spec inserted WITHOUT the new columns all succeed on the 4d-i schema and land `true`, a `ChangeRequest` inserted WITHOUT `projectId` is filled from its decision and one naming another project's id is refused by the composite FK, a `Notification` inserted WITHOUT `eventId` succeeds; 4d-iii's drop of the defaults probed by the same inserts then failing AND by a current-version provenance write through the SHIPPED writers — create, revise AND cancel, material and labour — succeeding with `revisionFinalized = true` from the widened `approvedRef` (RED at base); 4d-iii's trailing seals — a NULL-`sourceCommandId` standard request refused while the legacy NULL rows survive; a decision notification without `eventId` refused while legacy rows survive; **P42b** with P31b (§B.4) | `DecisionApprovalRevision_provenance_target_key` widened + the two spec FKs re-targeted; the trailing seals |

## §D — Staging, review unit, and order

- **This plan unit** is docs-only: this document and the STATUS record it
  owes, folded in the same PR under `CLAUDE.md`'s rule that an autonomous
  `claude/**` draft names itself (`task_state: in_progress`, `open_pr` this
  PR's number on the pointer commit; `none` on the unit commit, because the
  number does not exist until the PR is created — the §D self-naming
  convention every 4c and 4d unit followed). `reviewed_merge` stays
  `f5da6654` (the last REVIEWED merge; #536 was a STATUS record),
  `next_task` stays `phase-6-task-4d` (the id names the task stop; this
  narrative binds what starts at it — 4d-i, only after this plan clears),
  `phase_plan` stays the 4c plan until this plan CLEARS, when the
  implementation's first fold moves it. Runner invariants over the parsed
  Now block: `assessRunnerState` → `pr:<this>` while open;
  `assessPostMergeRunnerState` → simulated, allowed, `task:4`;
  `detectStatusDrift` with the self-named `open_pr` live → no drift. It
  clears by a fresh clean +1 through the `codex-current-head` gate — the
  independent clearance the 4c plan's #486/#490 detour restored as a
  precondition — and 4d implementation begins only after that merge, from
  the `main` that carries it. Should this PR reach a second finding-bearing
  head, the protocol's close-and-replace applies exactly as it did sixteen
  times before, under the standing continuation authorization (#482,
  2026-09-07): a freshly scoped replacement from current `main` carrying
  `Replaces: #<this>` and every unresolved finding — no PR-number cap.

- **4d implementation follows as FOUR PRs — the dark migration 4d-i, the
  service/role/UI unit 4d-ii, a drain attestation, and the trailing
  reservation retirement 4d-iii — each honouring the mandatory migration
  seam** (the additive schema is deployable before any caller uses it — that
  viable seam makes a single migration+service+UI PR a violation of the
  repository's migration review-unit rule, and this plan takes the seam):

  - **4d-i, the migration unit**: ONE additive migration file in THREE
    parts, ordered so no window opens. **Part 1, the doors transaction**:
    the shared refusal function `phase6_t4d_reserved()` and the two
    TEXT-judged `Decision` doors (`Decision_t4d_architect_reserved`,
    `Decision_t4d_awaiting_reserved`), committed FIRST. **Part 2, the enum
    statements**: `ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS
    'architect'` and `ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS
    'awaiting_countersign'`, each its own statement (a value added inside a
    transaction is unusable until it commits — the way 20271015 added
    `recorded`). **Part 3, the seal-and-audit transaction**, opening with the
    orgs-owned RESERVATION's `CREATE TRIGGER` (`Membership_t4d_architect_reserved`)
    and — only after that lock is held — the diagnostic-first `Membership`
    and `User` audits that ABORT with a bounded sample, then everything else:
    the THREE decisions-owned fact tables (`DecisionForward`,
    `DecisionCountersign`, `DecisionStrandedResolution`), each registered in
    `decisionsManifest.ownsModels` AND `readEncapsulated`, with composite
    same-project FKs, candidate keys, CHECKs (`btrim` non-blank over the
    complete ASCII whitespace set, the `outcome` and designation-kind
    discriminators), the seven contract obligations' seals — append-only +
    named no-TRUNCATE, the deferred pairing triggers in both directions,
    actor-standing (the frozen role and name judged) and subject-eligibility
    reads through the delivered primitives under `phase6_try_readiness`,
    the 4c provenance shape reusing `phase6_t4c_provenance_bound` where a
    command writes one fact and the 4d-owned bundle-aware
    `phase6_t4d_provenance_bound` where it writes a bundle, and the
    effect-correspondence checks through the NEW platform-owned
    `platform_tx_event`; the platform-owned `ProjectRoleStanding` register
    with its writer-depth seal, its project-cascade arm, the orgs-owned
    `Project_t4d_deleting` flag trigger and `ProjectRoleStanding_t4d_no_truncate`,
    backfilled to one `architect` row per project at zero;
    `Membership_t4d_no_truncate`; the orgs-owned `MembershipTransition` fact
    (registered in `orgsManifest.ownsModels`/`readEncapsulated`) with its
    deferred membership FK, its receipt FK, its one-use UNIQUE, its
    append-only and `MembershipTransition_t4d_no_truncate` seals, the
    `phase6_t4d_membership_transition_bound` binding, the actor-authority
    BEFORE INSERT trigger, and the PERMANENT orgs-owned
    `Membership_t4d_architect_provenance` pairing seal with its event
    correspondence; the platform-owned `Membership_t4d_role_standing`
    register trigger; `Notification.eventId` (nullable, FK to
    `DomainEvent(eventId)`, partial UNIQUE); `DecisionApprovalRevision.finalized`
    (DEFAULT `true`, KEPT) with the birth seal, the widened candidate key and
    the backfill, the delivered `DecisionApprovalRevision_append_only`
    trigger DROPPED and replaced by the one-flip seal, and the immutable
    `approvedFrom`, `approvedByName` and `approvedByRole` (nullable for
    legacy and drain-window rows, required on any revision born `false`);
    `revisionFinalized` on the two spec tables (DEFAULT `true`, KEPT) with
    the CHECK, the backfill and the FK re-target; `ChangeRequest.projectId`
    (backfilled, trigger-filled for old writers, `NOT NULL`,
    composite-FK-bound to `Decision(projectId, id)`), `ChangeRequest.origin`
    and `revisionId` with their backfills and CHECKs, the frozen
    `requestedByRole`/`requestedByName` pair, the extended freeze, the
    nullable `sourceCommandId` with its composite FK and partial one-use
    UNIQUE, the `ChangeRequest_t4d_no_truncate` seal (a statement trigger
    fires on an empty table, and the harness's `TRUNCATE "Decision" …
    CASCADE` reaches `ChangeRequest`), and the two-producer P33b pairing; the
    three NEW orgs-owned primitives `phase6_user_orchestration_authority`,
    `phase6_user_holds_role` and `phase6_user_display_name` (registered as
    4c-i's two were); the widened `phase6_t4b2_decision_seal` (its role arms),
    the forward door opened in `decision_t4b_attribution_seal` (status-gated,
    target- and actor-judged) and the approved-entry seal with its
    decision-side `awaiting_countersign` entry arm; the
    `phase6_t4b2_membership_guard` open set widened with its one named
    exemption; the two 4c consultation seals `CREATE OR REPLACE`d with the
    `awaiting_countersign` arm and the requester arm moved onto
    `phase6_user_orchestration_authority` (`phase6_user_decision_authority`
    byte-identical); and the remaining reservation door
    `DecisionForward_t4d_reserved`. **The TRANSIENT portion is a NO-OP once 4d
    has retired**: in `ALWAYS_EXECUTE` a later P3005 baseline of a MATURE
    database — one holding a legitimate active architect after 4d-iii —
    replays 4d-i before 4d-iii, and an unconditional file would re-create
    the reservation and ABORT on that valid row. 4d-i therefore SPLITS its
    body: the PERMANENT guards (tables, columns, seals, backfills,
    primitives, the register) run unconditionally and re-runnably, while the
    TRANSIENT block — all FOUR reservation triggers, their SHARED refusal
    function and the audit — runs only when the durable RETIREMENT MARKER is
    absent. That marker is one row in a NEW, sealed platform table
    `RolloutRetirement(unit TEXT PRIMARY KEY, retiredAt, retiredBy)` created
    by 4d-i's permanent portion — NOT a row on `OutboxOperatorAction`, whose
    4c-iii-r verifier (`verifyMarkerSeals`) keeps a CLOSED trigger inventory
    that a fourth trigger would fail. The new table carries the 4c-iii-r seal
    SHAPE on its own surface — creation gated to the writing path by a `SET
    LOCAL vitan.phase6_4d_retire = 'on'` flag that only 4d-iii's transaction
    sets (mistake-proofing in the 4c-iii-r sense, "unforgeable by ACCIDENT" —
    never a privilege boundary, which this deployment's single table-owning
    role could not honour), UPDATE and DELETE refused, no-TRUNCATE — and
    `verifyMarkerSeals` is probed UNCHANGED after 4d-i and 4d-iii. Every
    statement is `IF NOT EXISTS`/`IF EXISTS`/`CREATE OR REPLACE` so a
    partial apply retries. `TRUNCATE_SEALS` gains SEVEN entries across 4d-i
    and 4d-ii — the three fact tables, `ProjectRoleStanding_t4d_no_truncate`,
    `Membership_t4d_no_truncate`, `MembershipTransition_t4d_no_truncate` and
    `ChangeRequest_t4d_no_truncate` — while `RolloutRetirement` is
    deliberately NOT in the reset's table list (a rollout fact, never test
    data). `ALWAYS_EXECUTE` gains the migration (raw guards a `db push`
    baseline cannot have); `scripts/migrate.sh` gains
    `report_4d_i_migration_failure`; `docs/RUNBOOK.md` gains §P6T4D; the
    migration corpus pin advances. Its integration suite is the
    seal-stripped harness of §C; `upgrade-proof.sh` gains the P42 backfill
    assertions over the legacy fixture, the old-write-shape inserts
    succeeding under the kept defaults, the planted hostile `Membership` and
    `User` rows driving abort → re-role → `migrate resolve --rolled-back` →
    redeploy through the real runner, the register-equals-count assertion,
    and one hostile insert per seal. **Deployed dark**: no contract, no
    command, no route, no reader; a still-serving 4d-ii-less instance cannot
    produce any new value, and the ONE 4d-sealed transition it can perform —
    the no-chain approve — already writes the event and audit row the
    correspondence requires and keeps writing its feed row without
    `eventId`, which the seal admits until 4d-iii. Expected to EXCEED the
    standard budget on probes alone — its packet argues `justified-large`
    on its own evidence.

  - **4d-ii, the service/role/UI unit**: the role fan-out (§A.1 — every
    mirror, the policy rows, the web lists, the DESIGNATION fan-out, the
    `deciderPush` architect arm, the `deciderPushTarget` arm, `countPending`);
    the four commands (`decisions.forward`, `decisions.countersign`,
    `decisions.disagree` with its two paths,
    `decisions.resolveStrandedCountersign`) on the command ledger with
    idempotency keys and `lockProjectReadiness` in the canonical order, each
    writing its fact with the frozen role and name from the actor's token,
    emitting its event and writing its audit row and feed row (with
    `eventId`) in the transition's transaction; the approve CAS landing
    `awaiting_countersign` under a chain with the provisional notice, the
    frozen `approvedFrom`/`approvedByName`/`approvedByRole`, and its `decider`
    and `forward` cancellations; the countersign demand's recipients and the
    forward push's recipients resolved under the lock and passed as
    `targetUserIds` (the `DispatchInput` sibling of `targetUserId`,
    `buildDispatchIntent` admitting it only for the two frozen-audience
    families, the consumer's `deliveryFor` copying it); every decisions
    notification writer stamping `eventId`; the `withdrawChange` refusal;
    `decisions.approvedRef` returning `revisionFinalized` and refusing an
    unfinalized head, with the material and labour create/revise writers
    spreading it explicitly, the two cancellation copies carrying it forward,
    and the writer sweep; `requestChange` recording `sourceCommandId` with
    its receipt naming the created request row; the three orgs membership
    mutations becoming commands writing their `MembershipTransition` row and
    emitting `membership.standing_changed` on a standing flip;
    `decisions.forward`, `decisions.create`/`updateDraft`,
    `MembersService.add` and the role-update command refusing 409 while the
    reservation stands, and the shell's ONE `rollout.phase6_4d` read; the
    existing targeted catalog entries admitting `architect`;
    `consultationRespondedPushTarget` widened with the withdrawn-audience
    arm; the consultation predicates widened and the roster loaded on the
    consultation surface; the architect's Decision Log controls; the
    decisions-owned ORDERED consumer `decisions.effects` with
    `decisionsManifest.consumesEvents` gaining `membership.standing_changed`
    and the platform-owned `EventStreamQuery.latestPosition`; the
    per-recipient pre-send hook and the cancellation-by-subject inventory in
    the ONE lock order with the `targetUserIds` narrowing arm on
    `cancelQueuedPushBySubject`; the `countersign-v1` client contract with
    its transport-layer interceptor, the in-command refusals and the
    completeness tripwire; the reader enumeration of §A.2, the shared status
    tripwire, the Inbox branch, the client's approval confirmation copy; the
    `countersignRequired` kernel overlay through `RoleStandingQuery`; the
    `decisions.inbox` projection row/fold/rebuild/filter carrying the
    awaiting state, the forward-installed holder and the non-`standard`
    origin (live == projection == rebuild); **the two changed consumers'
    DURABLE contract versions bumped** — `webpush.notify` (`catalogVersion` 2
    → 3, for the two new claim families and `targetUserIds`) and
    `decisions.inbox` (2 → 3) — with the `OutboxConsumerCatalog` rows and
    `ProjectionGeneration.catalogVersion` migrated in 4d-ii's OWN
    catalog-data migration (the 4c-ii precedent,
    `20271116000000_phase6_t4c_ii_rollout_fence`), which ALSO registers
    `decisions.effects` (guarded as a whole on the consumer's catalog row
    being ABSENT, so a replay is a no-op) and joins `ALWAYS_EXECUTE` (a
    restored pre-4d-ii database would keep its catalog rows at version 2
    while the binaries declare 3, and `syncConsumerCatalog` would refuse
    EVERY upgraded process at startup), so a restarted or rolled-back
    pre-4d-ii process is refused at startup and can never claim the sole
    ordered delivery — that is what makes the drain DURABLE rather than a
    one-time observation; 4d-ii therefore carries this ONE catalog-data
    migration beside its service change and declares the seam inseparable in
    its packet for the reason 4c-ii did (the version and the code that
    declares it must move together); the socket consumer is not bumped.
    **4d-ii is a CATALOG CHANGE, staged as one**: its new push families and
    widened targeted entries change the sealed external-effect coverage
    hash, and the delivered `OutboxBootstrap` REFUSES to start in
    `OUTBOX_SENDER_MODE=outbox` while the persisted seal differs from the
    compiled catalog, so its staging follows `docs/RUNBOOK.md`'s
    catalog-change sequence, written into the packet as steps: drain the old
    fleet to zero instances → deploy 4d-ii in legacy/shadow sender mode →
    rebuild projections → `outbox:status` clean → `outbox:seal-external`
    recording the NEW coverage → restart in outbox mode, the startup
    validating the seal — BEFORE 4d-iii. **Still chain-off AND forward-off
    everywhere**, because the reservation stands on all four doors: the unit
    ships every reader and writer while no project can exercise them, which
    is what makes the previous-release drain a pure operational step. Its
    STATUS fold SETS `blocking_directive: phase-6-4d-previous-release-drained`.

  - **The drain attestation** — the operator states that every process older
    than the 4d-ii release is stopped or drained, as an `OPERATOR-ATTESTATION`
    on the controlling issue naming the directive and the minimum release,
    carrying no agent-generation marker — the attestation covers processes
    ALREADY RUNNING, which no code can observe; the bumped consumer contracts
    fence every process that STARTS, which keeps the attested state durable
    afterwards; browser tabs stand behind the `countersign-v1` boundary
    (§A.2). **BOARD DECISION carried from 4c** (2026-08-29, on PR #480): an
    operator-declared directive, NO automated drain actor. Why the drain
    matters for 4d, stated concretely: a pre-4d instance's Prisma client
    fails to READ any `Decision` row whose `status` is a value its generated
    enum does not know, and its zod `TokenRole` refuses to mint a JWT for an
    `architect` member — so a project whose chain activates while an old
    instance still serves is a split brain of exactly 4c's class. The
    reservation makes that state unreachable until the fleet is attested
    drained. Nothing an agent writes supplies the attestation (the #530
    lesson).

  - **4d-iii, the reservation retirement**: a migration-only unit that drops
    ALL FOUR reservation doors with their shared function, drops the two
    kept finality defaults (`finalized`, `revisionFinalized` — after the
    drain only writers that state the pin remain), installs the TRAILING
    INSERT-time seals — `sourceCommandId` required on every new
    `ChangeRequest` row whatever its origin, and `Notification.eventId`
    required on every new row carrying a `decisionId` — arms the feed-row
    arm of the no-chain approve's correspondence check (obligation 7's last
    row), and writes the sealed `RolloutRetirement` marker (`INSERT … ON
    CONFLICT (unit) DO NOTHING` under the `SET LOCAL` gate, so a later
    `ALWAYS_EXECUTE` replay over the immutable row neither aborts nor
    rewrites it, the closing verification requiring the row to EXIST);
    re-runnable — every replay re-drops the FOUR triggers AND their shared
    function `IF EXISTS` and then CHECKS the retirement complete exactly as
    4c-v's closing block does, raising if a trigger or the function remains —
    in `ALWAYS_EXECUTE` after 4d-i, with the mirror probes (P28b; the
    old-write-shape inserts of P42 now refused) and the proof's before/after
    structure exactly as 4c-v did for 4c-iii's seal. There is NO backfill
    (chain activation is a per-project product act by the PMC, never a
    database default) and NO preservation seal, so 4d has no analogue of
    4c-iii/4c-iv and no third gate: 4d-iii carries no rollout prerequisite of
    its own — an architect membership is written only by the new release, and
    once the old release is drained there is no reader that can be surprised
    by it. **4d is complete when 4d-iii merges**, and the §E handoff to the
    remaining decision-workflow scope (the master plan's post-4d items, none
    of which is authorized by this plan) follows it.

- **Deferred dependencies, named**: the frozen-audience `targetUserIds` is
  a platform `DispatchInput` extension shipped IN 4d-ii beside the families
  that use it (no unit depends on it earlier); `platform_tx_event`,
  `RoleStandingQuery` and `EventStreamQuery.latestPosition` are kernel
  primitives shipped in 4d-i (the SQL) and 4d-ii (the TypeScript queries),
  each registered on the platform manifest; no 4d unit depends on any
  contractor-capture unit, on the P3005 correction in the maintenance
  queue, or on any saved UX or performance work, and none of those is
  started by 4d.

- **Not in 4d, stated so the review can hold the line**: no rename (`room`
  → `space`), no external collaboration, no change to approval history (the
  register stays append-only in every respect but the one paired `finalized`
  flip), no UX or performance work beyond the surfaces §A.2 names, no
  contractor-capture unit (units 1–6 stay Board-gated), no automated drain
  actor, no repair engine, no PL/pgSQL emitter.

## What carries forward

- The binding ledgers of `docs/reviews/pr-335-convergence.md` and
  `docs/reviews/pr-340-convergence.md` — every decision above is carried from
  them, none reopened; and the sixteen closed PRs #537–#552 with their review
  threads, the record of every finding §A.4 answers.
- 4a's delivered seal network, audience rule, cancellation spine and
  linkability authority; 4b's delivered decider model, targeted push spine,
  §B.1/§B.2 primitives, holder freeze and orphan guards; 4c's delivered
  consultation register, the try-readiness protocol as a primitive, the
  command-provenance shape, the per-family push predicates and their
  archived-project rule, and the dark-migration → drain → enable rollout
  discipline — extended by reference, never rewritten.
- The rule this plan adds to the contract, for every unit after it: a seal
  verifies the bundle a writer must produce; it never produces the bundle
  for the writer.
- The owner's recorded intent: decisions decided by the right party, issues
  filed without ceremony, consultation that informs without gating, and an
  architect who countersigns without becoming a bottleneck nobody can route
  around.
