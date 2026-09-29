# 4d-ii-a — the additive redesign (A1 … A8) and the inventory-to-unit map

Owner disposition of 2026-09-26: 4d-ii-a is delivered as additive units, not as the one
`justified-large` PR that §D of `2026-09-07-decision-workflow-4d.md` stages. The owner chose
this after a gap map of that inventory against `main` at `3da889b` found almost none of the
server unit built, and after the monolithic `reform-1b` probe (#594, #614, #615) stopped at
repeated P1-bearing heads while the 4d-i-b additive split (U1, U2, U3:
`2026-09-21-4d-i-b-additive-units.md`) landed.

This document changes **how 4d-ii-a is staged, not what it contains**. Every item of §D's
4d-ii-a inventory is mapped to exactly one unit below. §A remains the specification for each
item. 4d-ii-b (the client unit), the drain attestation and 4d-iii are unchanged, except for the
drain's minimum release, which is restated in "The drain" below.

## One gap the map found: the activation register was never installed

§D (plan line ~7204) and the companion document
(`2026-09-09-outbox-consumer-activation.md`, line 18) both say "4d-i installs the register,
its seals and its baseline backfill". It does not exist on `main`: no `OutboxConsumerActivation`
model in `schema.prisma` and no table, seal or backfill in any `phase6_t4d` migration. 4d-ii-a
was to *read* the active set that register defines. **Unit A6 installs it**, exactly as the
companion document specifies it, with its catalog-INSERT baseline trigger. It must land before
A7 registers `decisions.effects`. Both documents keep their reviewed text. Each gains a dated
note at its top, in the same change as this record, pointing here and naming A6 as the
installer.

## A correction found building A2 (2026-09-26): the Project row lock mode

`phase6_project_operable` (4c-i) and `phase6_user_decision_authority` (4b) lock the project row
`FOR UPDATE` to read `archivedAt`. That also conflicts with the `FOR KEY SHARE` every ledgered
command's receipt holds on the row through `CommandExecution_tenant_fkey`, taken before the command
runs. So a command holding the readiness key that writes a fact whose seal reaches either function
deadlocks against any other command on the project that has reserved its receipt and waits for the key.
Every 4d fact seal reaches `phase6_project_operable` through `phase6_t4d_actor_bound`, so the first
unit to write a frozen pair under the ledger (A2's `requestChange`) meets it, and A3 and A8 would too.

A correction unit lands before A2: migration `20271225000000_phase6_project_row_lock_no_key`
redefines both functions with `FOR NO KEY UPDATE`, which still serialises with the archive (an UPDATE
of a non-key column) and with every other write to the row, and drops only the conflict with a
foreign-key check. The unit is SQL only, per the migration/service separation: the service-side twin,
`OrgsParticipant.isProjectOperable`, takes the same `FOR UPDATE` inside ledgered decision commands and
moves to `FOR NO KEY UPDATE` in A2, the service unit that depends on this one. The migration is on
`ALWAYS_EXECUTE` and carries the obligations below. It changes no seal's rule and no unit's content.

## Resequencing (owner disposition, 2026-09-27): the 4d-ii writers witness before A3b

4d-i's replay audits (`$dark_registers$` and `$legacy_shape_kernel$` in 20271220, `$dark_tables$`
and `$legacy_shape$` in 20271221, U3's foreign-generation audit) refuse to ADOPT 4d-shaped data
unless `phase6_t4d_ii_installed()`: the witness `platform_t4d_ii_writers_installed()` AND a
`ReleaseLease` row. This staging put both in A6, after the writer units, so A1 (the event envelope
pair) and A2 (the change request's provenance and frozen pair) already write data those audits
read as unvalidated. A P3005 baseline replay over a database that already holds what they wrote
aborts; ordinary ledger-backed deploys never replay 4d-i. The database that reaches that replay
with such rows is a normally migrated one restored without its `_prisma_migrations` ledger: a
`db push`-built database is refused before anything replays (t3c seals exit 5). A3b's
`MembershipTransition` facts would widen the gap.

What the unit closes is bounded (#646's review, finding 4114478871). From the first start of the
release carrying it, the database holds the witness and a lease, and a restore carries both, so the
replay stands the audits down. A restore from before that start holds no lease, and nothing the
unit installs can evidence that an A1/A2-era process served; a lease written by the deploy runner
ahead of the replay would be the deploying release attesting for itself, which 4d-i's round 40
refused. That restore recovers through its ledger (RUNBOOK §P6T4D, "A restored database that lost
its migration ledger"), and `scripts/upgrade-proof.sh` proves both arms on one A1-shaped event.

So one unit lands before A3b, taken from A6's inventory: the witness and the `ReleaseLease` startup
writer, in migration `20271226000000_phase6_t4d_ii_release_lease_writer` and
`src/platform/release-lease.service.ts`. It is `migration-scope: inseparable`: the witness opens the
lease table to INSERT, a lease is permanent, and a declaration with no writer reopens the window
#582's round 36 closed, while a writer with no declaration meets 4d-i's door at boot. The rest of
A6 (the activation register, rule columns, delivery seals and the server-generation fence) stays
in A6. A6's `rollout:drain-evidence` CLI also stays there.

## Why each unit is safe on its own

4d-ii-a was already specified to land **dark**. The six reservation doors keep every
architect shape unrepresentable, and no project can hold an active chain, so nothing a unit adds
can be reached by delivered traffic before 4d-iii retires the doors. The additive split keeps
that property per unit, with one extra rule: **nothing that changes a consumer's durable
contract version or the external-effect coverage hash lands outside A7**. That is §D's
"inseparable migration seam" — the catalog version and the code that declares it move together —
kept whole in one unit rather than spread across several.

- **A1–A5 carry no catalog effect.** They change no consumer `catalogVersion`, add no
  `ExternalEffectCatalog` row, and widen no push ceiling. A process built from any of them
  starts against the current seal.
- **A6** installs substrate — the register, the rule columns, the delivery seals and the
  registration barrier — while every consumer stays at its current contract version. Each
  pre-existing catalog row gets its `seq = 1` baseline MIRRORING ITS CURRENT `active` VALUE, exactly
  as the companion document specifies, so no consumer is activated or deactivated and delivery is
  unchanged (#640 Codex finding 4110816152). It also installs the server-generation fence (see "The
  drain"), whose persisted minimum it sets to the generation it compiles, so no running process is
  refused.
- **A7** is the catalog change, staged as one under `docs/RUNBOOK.md`'s catalog-change sequence
  exactly as §D writes it for 4d-ii-a.
- **A8a/A8b** add the four commands on top of A7's keys. They stay unreachable behind the doors.

## The inventory-to-unit map

Line and budget figures are estimates from the gap map. The standard budget is
`STANDARD_MAX_FILES = 20` and `STANDARD_MAX_CHANGED_LINES = 1500` (`scripts/review-policy.mjs`).
A unit that exceeds it declares `justified-large` with the six-row matrix, as §D already requires
of 4d-ii-a.

| Unit | Carries (§D 4d-ii-a inventory items) | Depends on | Estimate |
|---|---|---|---|
| **A1** actor and event envelope | kernel `EventActor` widened to the full `Actor`; `EmitInput.eventId`; `emitEvent` writing the envelope's `actorRole`/`actorName` only as a pair resolved INSIDE the transaction under §A.3 obligation 3 (the name from `UserIdentity` with the identity row `FOR UPDATE` after `Membership`, the role by the window disposition); `OrgsParticipant.resolveUserIdentity` returning the display name. Its probes show every delivered emitter still commits: a written pair is judged by 4d-i's envelope seal against the actor's standing, and an emitter whose actor §A.3 resolves no pair for leaves the envelope NULL, which that seal admits | — | ~15 files, ~700 lines |
| **A2** attribution seams | `AttributionActor` carrying the pair through the commercial, procurement, labour and inventory seams; `requestChange` recording `sourceCommandId` and the frozen `requestedByRole`/`requestedByName` pair resolved inside `executeCommand.run`, its receipt naming the created request row | A1 | ~15 files, ~800 lines |
| **A3** membership commands and lock order | `members.add`/`updateRole`/`remove` as ledger commands with `synthesizeKeyWhenAbsent: true`, each writing its `MembershipTransition` fact FIRST (the 4d-i seal's order) with the pair resolved in-transaction, the add's lookup AND create inside `executeCommand.run`; `lockOrgStanding`, taken by project creation (with the creator's owner/admin standing re-judged under the key before the insert) and by every owner/admin `OrgMembership` writer before the project keys; the four other `Membership` writers taking `lockProjectReadiness` (sign-in provisioning made one transaction); the owner/admin `OrgMembership` writers taking it over every project of the org in ascending id; `ensure-accounts` validating `ACCOUNTS_JSON` before the first write and refusing `architect` | A1 | ~12 files, ~900 lines |
| **A4** readers | the consultation cycle finalized-only at every producer and reader §A.2 names, `viewerIsConsultee` moving with its DTO field; `decisions.approvedRef` returning `revisionFinalized` and refusing an unfinalized head, the material and labour writers spreading it, the two cancellation copies and the writer sweep; the kinded feed as the two owner queries in one REPEATABLE READ transaction with the renderer tripwire and `decisionVisibleToViewer`; the kinded readers' actionable-kind suppression for a withdrawn decision; the reader enumeration of §A.2 and the shared status tripwire, server arms (the web arms are 4d-ii-b's); the withdraw's retirement narrowed to kind-less rows | — | ~14 files, ~1000 lines |
| **A5** role vocabulary and client boundary | the `architect` role fan-out of §A.1 on the server (mirrors, policy rows, DESIGNATION fan-out, `countPending`); the reservation-door 409s on `decisions.create`/`updateDraft`, `MembersService.add` and the role update; the SERVER side of the one `rollout.phase6_4d` value: the reservation state, baked from the same catalog read, exposed on the payload the shell already loads (the shell's read, and every web surface that follows it, remain 4d-ii-b's; #640 Codex finding 4110816148); the `countersign-v1` server interceptor, in-command refusals and completeness tripwire; the `countersignRequired` overlay through `RoleStandingQuery`; `effectiveRoleHolderUserIds` wrapping `platform_role_holder_user_ids` (for `architect`; `pmc`/`client` once the rollout reads `open`); the consultation predicates widened and the roster loaded on the consultation surface (server) | A3 | ~15 files, ~900 lines |
| **A6** delivery substrate | the `OutboxConsumerActivation` register per the companion document (the gap above), each pre-existing row's baseline mirroring its current `active` value; the rule columns with `syncConsumerCatalog` INITIALIZING a created row from the compiled contract and VERIFYING an existing row, refusing on drift, and A6's migration writing every EXISTING row's rule columns from literals a test pins to today's compiled contracts (otherwise the verify half would meet empty columns and refuse every process at startup); the `OutboxConsumerCatalog_t4d_registration_barrier`; `DomainEvent_t4d_deliveries`, `OutboxDelivery_t4d_bound`, `OutboxDelivery_t4d_frozen`; `deliveryRowsFor` called by `materializeDeliveries` and `expandMissingDeliveries`, `deliveryFor` retired, behaviour-preserving for every current consumer (A7 extends it with `targetUserIds`); the `ReleaseLease` writer and the `rollout:drain-evidence` CLI; the SERVER-GENERATION FENCE (a compiled, monotone server generation checked at startup against a persisted, migration-written minimum; see "The drain"). No consumer version changes | — | likely `justified-large` |
| **A7** the catalog unit (the inseparable seam) | both durable version bumps (`webpush.notify` 2→3, `decisions.inbox` 2→3) with the `OutboxConsumerCatalog` and `ProjectionGeneration` rows; the widened external-effect catalog at the new coverage version beside the old; the `architect` arms of `deciderPush`/`deciderPushTarget` and the widened targeted ceilings, `decision.consultation_responded` to `['pmc','architect']` with the `respond` emitter persisting the requester's role and `consultation.request` writing `requestedByRole`; `targetUserIds` in `DispatchInput`/`buildDispatchIntent`; the per-recipient pre-send hook and `cancelQueuedPushBySubject` narrowing; `consultationRespondedPushTarget`'s withdrawn arm; the `decisions.inbox` v3 projection row, fold, rebuild and filter; kinded notice writers minting their event id and stamping `eventId`/`kind` (the `Notification_t4d_binding_bound` same-transaction converse §D assigns to this migration is ALREADY installed by 4d-i, `20271220000000_phase6_t4d_i_dark_migration` line ~4157, so A7 owes only its hostile probe: the late kinded insert against a committed no-notice event), and the kinded green notice rendering from its event's revision; `decisions.effects` registered INACTIVE (its head from A6's catalog-INSERT trigger), `consumesEvents` gaining `membership.standing_changed` and `EventStreamQuery.latestPosition`, its activation handler recording a stale activation `noop`; `membership.standing_changed` emitted on an architect-standing flip; the `withdrawChange` refusal; `ALWAYS_EXECUTE` | A1–A6 | `justified-large` |
| **A8a** forward and approve | `decisions.forward` on the ledger with `lockProjectReadiness` in the canonical order, refusing 409 while the reservation stands; the approve CAS landing `awaiting_countersign` under a chain with the provisional notice, the frozen `approvedFrom`/`approvedByName`/`approvedByRole` and its `decider`/`forward` cancellations; the exact `revisionId` in `decision.approved`/`reapproved` from the direct approve | A7 | ~1200 lines |
| **A8b** countersign, disagree, stranded | `decisions.countersign`, `decisions.disagree` (both paths), `decisions.resolveStrandedCountersign` (both outcomes), each writing its fact with the in-transaction pair and emitting its event, audit row and feed row; the exact `revisionId` from the countersign and the `completed` resolution; the architect's Decision Log server controls; its migration RAISES the persisted server-generation minimum to A8b's, so every earlier build is refused at startup | A8a | ~1200 lines |

**A3 is delivered as three sub-units (2026-09-27)**, each inside the standard budget, with the same
items and no new ones:

- **A3a, the provisioning writers:** `ensure-accounts` validating `ACCOUNTS_JSON` (and its legacy
  backfill) before the first write and refusing `architect`; the three non-command `Membership`
  writers outside project creation (sign-in provisioning, made one transaction, `prisma/seed.ts` and
  `ensure-accounts`) taking `lockProjectReadiness`.
- **A3b, the member commands:** `members.add`/`updateRole`/`remove` as ledger commands with
  `synthesizeKeyWhenAbsent: true`, each writing its `MembershipTransition` first with the pair
  resolved in-transaction, the add's lookup and create inside `executeCommand.run`.
  4d-i's binding admits one shape per receipt (an add from nothing or `removed` to active, a re-role
  active to active with a new role, a removal from an existing standing to `removed`), and its
  fact-first seal demands a fact for EVERY membership write under a member receipt. So A3b refuses
  an add over an active member (409; one asking for exactly what they are records nothing), refuses
  a removed member's re-role (409), lets a repeated removal record nothing, and runs a change that
  keeps the role (a consultant's discipline) outside the member ledger, as the readiness-locked
  compare-and-set it was. None of this is new product behaviour beyond those refusals.
- **A3c, the org key:** `lockOrgStanding`, taken by project creation (with the creator's owner/admin
  standing re-judged under it, and the creator membership under the new project's key) and by every
  owner/admin `OrgMembership` writer before the project keys ascending, the seed's and
  `ensure-accounts`' org upserts included.
  As delivered: the creation's transaction is SERIALIZABLE, and its snapshot is fixed when the key
  statement starts, so a creation that waited on an org writer would still read the standing from
  before it. Each org writer therefore also writes a new version of the `Org` row under the key, and
  the creation locks that row `FOR SHARE` right after taking it; a writer that committed after the
  snapshot makes that a serialization failure, which the creation's runner retries on a fresh snapshot.

**A4 is delivered as sub-units (2026-09-27)**, each inside the standard budget, with the same items
and no new ones. The first is fixed here; the rest are recorded as each opens:

- **A4a, the consultation cycle:** the cycle counts FINALIZED approvals at every producer and reader
  of §A.2's cycle trace (the request freezing `openCycle`, the response check, the claim-time push
  predicate, the DTO's `approvalCycle` that `viewerIsConsultee` and the projection read), with the
  withdraw's evidence count and the next approval's version deliberately unchanged. **One site the
  trace does not name moves with them:** the two consultation seals 4d-i re-issued
  (`phase6_t4c_consultation_request_seal`, `phase6_t4c_consultation_response_seal`) re-count the
  cycle under the decision lock, so with the service on the finalized count and the seals on the
  total, a question asked beside a provisional approval would be refused by the database as a
  closed cycle. A4a therefore ships a migration
  (`20271227000000_phase6_t4d_ii_consultation_finalized_cycle`) re-issuing both with the finalized
  count, carrying every obligation below. It leaves a retired database's bodies alone, asking the
  durable `phase6_t4d_retired()` (4d-i's transaction-local snapshot is unset in a later file's
  transaction; #649's review, finding 4116369412), so **4d-iii's re-issued bodies (the request
  seal's requester arm re-pointed) owe the same finalized count.**
  §C's P25d sequences end to end need the provisional approve and the countersign, so they travel
  with A8b; A4a proves the rule at each site over a planted provisional revision.
- **A4b, the finality key's writers:** `decisions.approvedRef` refuses a provisional head and returns
  the head's `finalized` as `revisionFinalized`; every spec writer states it (material and labour
  create and revise from the widened reference, both cancellation copies carrying it verbatim, a
  spec with no decision stating `true`), and the writer sweep pins the four INSERT sites. **One
  measured correction to P42's wording, for 4d-iii:** the delivered three-field writers do NOT fail
  when only the DATABASE defaults are dropped, because the Prisma client sends the schema's
  `@default(true)` itself. They fail only once 4d-iii also removes that `@default` from
  `schema.prisma`, where the field becomes required, so 4d-iii's default drop must take both. A4b's
  RED evidence is the static writer sweep and the provisional-head refusal; its live arms record
  that every shipped writer's rows carry the column with the database defaults dropped.
- **A4c, the kinded feed readers:** the snapshot (the ONE feed reader: `decisions.inbox` folds
  decisions, not notices) reads the viewer's decision slice and the notification feed, with the
  events its kinded notices are bound to, in one REPEATABLE READ transaction through the owners'
  queries; a kinded notice is rendered from its kind and event (never its stored text), served only
  when its decision is in the viewer's slice, its ACTIONABLE kinds suppressed once the decision is
  withdrawn; the renderer tripwire pins the rendering to the writers' own strings and colours; and
  the withdraw's retirement deletes kind-less rows only. **Renderer arms land with what they need:**
  A4c renders `decision.published` (pending and record) and `decision.withdrawn`, whose events carry
  every word of the notice; the green approved notice renders from the revision its event names (A7,
  with A8a's `revisionId`), and the forwarding, countersign and change-request notices with their
  writers. A kind with no arm is omitted, never served from its cache. A kinded pending demand keeps
  the kind-less audience (pmc and the decider), so a consultee who may see the decision gets no
  demand.
- **A4d, the reader enumeration and the status tripwire (server and shared arms):**
  `awaiting_countersign` joins the shared `DecisionStatus` (with a runtime `DECISION_STATUSES` held
  equal to the type and, by the tripwire, to the database enum); the shared chip, label and rail
  maps and `deriveDecisionReading` answer it explicitly (`wait`, "Approved by <decider noun> —
  awaiting the architect's countersign"); the API's lagging `DecisionStatus` copy and the snapshot's
  string union point at the shared type. The tripwire walks every value against every registered
  map and predicate and scans shared, API and web for status-keyed literals, each of which must be
  registered. The web's `locationTree` counter answers (it had to, to compile); its label and rank,
  and the other web readers §A.2 names, are registered as OWED BY 4d-ii-b, the client unit.
  #652's review widened the tripwire to EVERY status predicate in shared, API and web, registered
  per occurrence with a verdict the predicate must bear out (names the value, rightly excludes it,
  owed by a named unit, or another entity's status). A4d answers three server predicates itself: the
  consultation open set (`CONSULTATION_OPEN_STATUSES`, read by the eligibility carve-out and the
  request push's claim, pinned to the database seals' set) and the withdraw's refusal. So A5's
  consultation item shrinks to the architect requester and the roster. The arms the registry names
  as owed: A5 the open-holder answer, `countPending`'s filter and the shell summary that should
  read it; A7 the decider push target; A8a an awaiting decision's audience and whether an awaiting
  sibling still carries the legacy pending text the withdraw retires; 4d-ii-b every web reader.
  **With A4d, A4 is complete.**

**A5 is delivered as five sub-units (2026-09-28)**, with the same items and no new ones. A gap map
against `main` at `9d58b44` put A5 at 1,400–1,800 lines (the table's ~900 predates it), and one piece
of it cannot land alone: widening the zod role enums makes an `architect` request reach the services,
so the enums move with the 409 refusals, never before them.

- **A5a, the role vocabulary:** `architect` in the shared `TokenRole` (a runtime `TOKEN_ROLES` beside
  it), the API's `Role`, `PushRole` (the type; the targeted ceilings are A7's), the registry's
  `KNOWN_ROLES`, the decisions manifest's permissions, the audit label and the membership comment;
  `ROLE_POLICY` grants the eight of §A.1's eleven actions that have routes, pinned by equality (P28;
  `decision.forward` joins with A8a, `decision.countersign` and `decision.disagree` with A8b); the web
  answers the role in its maps and holds the persona back (`PERSONAS_OWED`); a role tripwire registers
  every role vocabulary in shared, API and web with a verdict. Nothing is reachable: no token can carry
  the role while 4d-i's doors stand, and the zod enums still refuse it.
- **A5b, the doors on the service path:** both zod role enums and `DECIDER_KINDS` widened together
  with the 409 refusals naming `phase-6-4d-previous-release-drained` (`decisions.create`/`updateDraft`
  naming the architect designation, under the readiness lock; `MembersService.add` and the role update
  before any write; `AuthService.session` before either branch, its synthetic fallback never minting the
  role), all judged by one service-side catalog read of the reservation trigger, and the same read's
  `rollout.phase6_4d` on the shell payload.
- **A5c, the kernel standing reads:** `RoleStandingQuery` and the `countersignRequired` overlay;
  `effectiveRoleHolderUserIds` wrapping `platform_role_holder_user_ids`; the architect as consultation
  requester, through the kernel read.
- **A5d, the designation fan-out:** the open-holder answer and the holder-orphan rule's register arm;
  `countPending`'s architect arm and countersign obligations, with the shell summary reading it; the
  roster on the consultation surface (server). (The shared `DeciderKind`, `viewerIsDecider` and
  `deciderNoun` answer the designation from A5b, which widened the type with `DECIDER_KINDS`.)
- **A5e, the client boundary:** the `countersign-v1` interceptor, its in-command refusals and its
  completeness tripwire.

**A6 is delivered as five sub-units (2026-09-28)**, with the same items and no new ones, on A5's
precedent. The table's own estimate is `justified-large`; the items separate cleanly along their
dependency, and each sub-unit is additive and dark on its own.

- **A6a, the activation register:** the `OutboxConsumerActivation` table, its CHECKs and the triple
  uniqueness; `OutboxConsumerCatalog.activationSeq`; the head lock, the apply that is the mirror's only
  writer, the append-only and no-truncate seals; the catalog-INSERT baseline trigger and the backfill;
  `ALWAYS_EXECUTE`, `TRUNCATE_SEALS`, the seal inventories; the row-scoped `sanctionedConsumerRemoval`
  and the eleven catalog-delete teardowns through it (companion document, P-A1, P-A6's register and
  seam arms, P-A7, P-A8). The catalog's `active` is NOT yet frozen: the delivered direct UPDATE still
  works, so no delivered writer or fixture changes behaviour.
- **A6b, the mirror's sole writer and the operator protocol:** `OutboxConsumerCatalog_t4d_rules`
  freezing `active`, `activationSeq` and `registeredAt` with the depth-and-marker seam; the
  `outbox:consumer` operator service and CLI with the request-token protocol and the reserved `sys:`
  prefix; the five direct `active` UPDATE fixtures converted (P-A2–P-A5, P-A6's freeze arms, P-A9–P-A11).
- **A6c, the persisted rules and the registration barrier:** `dispatchRule` / `subscribedEventTypes`
  on the catalog, written for every existing row by the migration from literals a test pins to the
  compiled contracts, frozen by the rules trigger under the `SET LOCAL` gate; `syncConsumerCatalog`
  INITIALIZING a created row's rule and VERIFYING an existing row's, refusing on drift;
  `OutboxConsumerCatalog_t4d_registration_barrier`.
- **A6d, the delivery rows and their seals:** `deliveryRowsFor(event, catalogRows)` called by
  `materializeDeliveries` and `expandMissingDeliveries`, every `OutboxConsumerCatalog` row locked
  `FOR SHARE` before the `active` filter, `deliveryFor` retired from the consumer contract;
  `DomainEvent_t4d_deliveries` (deferred, taking the registration key in SHARE mode itself),
  `OutboxDelivery_t4d_bound` and `OutboxDelivery_t4d_frozen`; P37 and P38's barrier arms in both
  orderings, through the emitter and through a direct receipt-backed writer.
- **A6e, the server-generation fence and the drain evidence:** the compiled monotone server
  generation checked at startup against a persisted, migration-written minimum ("The drain"), and the
  `rollout:drain-evidence` CLI. Independent of A6b–A6d.

Order: A6a → A6b → A6c → A6d; A6e after A6a. A7 starts after A6d and A6e are on `main`.

**A7 is delivered as four sub-units (2026-09-29)**, with the same items and no new ones, on A5's and
A6's precedent. The table's own estimate is `justified-large`; the items separate along their
dependency, the catalog change (the inseparable seam that reseals the cutover) last, so each earlier
sub-unit is additive, dark and reviewable on its own.

- **A7a, the kinded notice writers:** every decisions notice writer (the one-step issue, publish,
  approve, withdraw) mints its event id up front, emits the event FIRST (the notice's binding key is
  a NOT DEFERRABLE foreign key onto it) and writes the notice bound to it (`eventId`, `kind` = the
  event's type) in the same transaction, as 4d-i's `Notification_t4d_binding_bound` demands; the
  hostile probe A7 owes, the late kinded insert against a committed no-notice event; the green
  approved notice rendered from the event's frozen actor envelope and the REVISION its event names
  (`payload.revisionId`, never the head), the revisions read by the decisions module in the
  snapshot's one REPEATABLE READ transaction; the direct approve's `decision.approved`/`reapproved`
  payload carries the exact `revisionId` (moved here from A8a's row, which keeps the countersign's
  and the `completed` resolution's; §A.3's P2 correction names the direct approve too), with the
  title and the holder kind the text needs, and the approve resolves the envelope itself (A2's seam)
  so the cached text and the event are one reading. The withdraw's retirement stays kind-less-only
  (A4c): the kinded pending notice of a withdrawn decision is hidden by the readers and kept as
  evidence, so the suites that deleted notices by row after a withdrawal reset them by the
  sanctioned TRUNCATE instead. One migration (`20280102000000_phase6_t4d_ii_a7a_revision_named`,
  #665's review round 1): 4d-i-b U3's revision claimant re-issued with the arm §A.3's P2 correction
  names — the green event's `payload.revisionId`, when present, must be the same-transaction head
  the claimant is claiming for (another decision's revision, an older one of this decision, or one
  that does not exist, refused at commit); absent, admitted through the drain and required at
  4d-iii. Every other seal this unit writes against is 4d-i's.
- **A7b, the send boundary:** the per-recipient pre-send hook in `makePushConsumer`;
  `deciderPushTarget`'s decision-row lock; `consultationRespondedPushTarget`'s withdrawn-audience
  arm (the requesting set widened to the architect, A5c's rule); `cancelQueuedPushBySubject`
  narrowing by `targetUserIds`; the `respond` emitter persisting the requester's role (read from the
  request's frozen `requestedByRole`) and both consultation writers stating their frozen pair;
  the `withdrawChange` refusal of a `countersign_rejection`, and `withdrawChange`'s cancellation of
  the queued consultation requests of the decision it closes (§A.4 (i): the standard `withdrawChange`
  leaves the consultation-open set); the withdraw's target-aware response cancellation, with every
  queued consultation request cancelled beside it. The catalog is untouched: the responded ceiling
  stays `['pmc']` until A7d, and no architect can hold standing before 4d-iii, so the frozen
  requester role is `pmc` on every row this unit can write.
- **A7c, `decisions.inbox` v3:** the projection row, fold, rebuild and filter for the awaiting
  state, the forward holder and the non-standard origin; `catalogVersion` 3, the writer fence's
  GUC and function; the `ProjectionGeneration` row; `ALWAYS_EXECUTE`. Delivered as: the compiled
  contract and the writer's declaration stated by ONE constant (`DECISIONS_INBOX_CATALOG_VERSION`);
  one catalog-data migration (`20280103000000_phase6_t4d_ii_a7c_inbox_v3`, the 4c-ii and
  inspections-v2 precedents) moving the persisted row 2 → 3 guarded on the version it moves from,
  re-issuing the fence's two functions (`$fence$`, `$truncate$`) to read `'3'` with bodies otherwise
  byte-identical to 20271126000000's, and verifying its own installation (the three triggers standing,
  both bodies reading `3`, the row at 3) — the stamp seal is not re-issued; the repair-seal verifier
  reads the two re-issued bodies from the RE-ISSUING file and the stamp seal's from the installing
  one, with a unit pin holding the constant, the migration literal and that name to one another.
  Existing `ProjectionGeneration` rows keep the version they were built at (a version-2 generation is
  refused at the read and the canonical slice serves until the ordinary `projection:rebuild`). The
  fold's three meanings are proven on PLANTED canonical rows (no shipped writer exists before A8a and
  A8b): live == projection == rebuild for a `countersign_rejection` origin, a moved holder and an
  `awaiting_countersign` status, each generation stamped 3. The filter's awaiting-audience arm stays
  A8a's (the status tripwire's registration). `webpush.notify` stays at 2 until A7d.
- **A7d, the catalog change:** the widened external-effect catalog at the new coverage version
  beside the old (the architect in the targeted entries, `decision.consultation_responded` to
  `['pmc','architect']`, the frozen-audience families, `membership.standing_changed`); `PushRole`,
  `pushFamily`, `targetUserIds` in `DispatchInput`/`buildDispatchIntent`; the `architect` arms of
  `deciderPush`/`deciderPushTarget` and the new families' claim predicates; `webpush.notify` 2→3
  with its `OutboxConsumerCatalog` row; `decisions.effects` registered INACTIVE (its head from A6's
  catalog-INSERT trigger), `consumesEvents` gaining `membership.standing_changed` and
  `EventStreamQuery.latestPosition`, its activation handler recording a stale activation `noop`;
  `membership.standing_changed` emitted on an architect-standing flip; `ALWAYS_EXECUTE`; the
  reseal sequence in the packet.

Order: A7a → A7b → A7c → A7d. A8a starts after A7d is on `main`.

Each unit's probes are the arms of §C's table that test its own items (the P29b no-header arms
travel with A3, the late-kinded-insert hostile probe with A7, and so on). A unit states in its
packet which §C arms it carries. None may leave an arm unowned: the last 4d-ii-a unit to merge
lists any arm not yet carried, which must be empty.

## Every migration an A-unit ships

§D states these obligations for 4d-ii-a's one migration, and splitting the unit does not narrow them to
A7 (#640 Codex finding 4111028101). Any A-unit that ships a migration carries all of them for it. A6,
A7 and A8b are expected to; A1–A5 and A8a are not, and one that does carries them too:

- **It joins `ALWAYS_EXECUTE` in `apps/api/scripts/migrate.sh` in the same unit.** On a P3005/db-push
  baseline the runner resolves every other migration as applied without running its raw SQL, so a
  migration left off the list would leave its triggers, seals, functions and backfills permanently
  absent on that deployment. That is why every 4d migration so far (4d-i's two halves, U1, U2 and U3)
  is on the list. For A6 this is what guarantees the activation register, its seals, its
  catalog-INSERT baseline trigger and its backfill exist before A7 registers `decisions.effects`.
- **It is re-runnable**, on the terms the list already demands: `CREATE ... IF NOT EXISTS`,
  `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION`, and guarded
  constraints, indexes and data steps. §D's own example is A7's `decisions.effects` registration,
  guarded as a whole on the consumer's catalog row being ABSENT. A6's backfill writes a baseline only
  for a catalog row that has none, and the server-generation minimum is only ever raised
  (`GREATEST`), never lowered, so re-running A6's migration after A8b's cannot undo A8b's fence.
- **Its probes travel with it.** For A6 these are the companion document's P-A arms for the register,
  including P-A1: a baseline for every catalog row over a database holding history and over a fresh
  one, and for a consumer created after the migration by `syncConsumerCatalog()`. The unit also
  carries a re-application of its migration against an already-migrated database.
- **Its packet declares the migration seam** with the `migration-scope` marker, as every 4d unit does.

## Order and what a unit may not do

Sequence: A1 → {A2, A3} → A5; A4 and A6 independently; then A7; then A8a → A8b. A unit starts
only after its dependencies are on `main`. No unit may:

- change a consumer's `catalogVersion`, add or retire an `ExternalEffectCatalog` row, or widen
  a push ceiling, **except A7**;
- retire a reservation door or activate `decisions.effects` (both remain 4d-iii's);
- ship a web surface (4d-ii-b's).

## The drain

§D sets the drain's minimum release at "4d-ii-a's, the server release carrying the bumped
consumer contracts". With 4d-ii-a split, **the minimum release is the release carrying A8b**,
the last server unit. It is at least A7's (the bumped contracts), and any earlier release lacks
server code that an activated chain relies on. 4d-ii-b's STATUS fold still sets
`blocking_directive: phase-6-4d-previous-release-drained`, naming that release.

**The fence that makes that minimum durable** (#640 Codex finding 4110816159). §D makes the drain
durable by bumping consumer contract versions, which `syncConsumerCatalog` compares at startup, so a
restarted or rolled-back older process is refused. Under this staging those bumps land in A7, before
A8a and A8b, so they alone would still admit an A7 image restarted after A8b: a server that lacks the
four commands and their effects, reachable once 4d-iii retires the doors. A second fence covers that:

- **A6 installs it.** Every build compiles a monotone server generation. At startup, a process reads the
  persisted minimum, written only by migrations, and refuses to start when that minimum is greater than
  its own generation. A6's migration sets the minimum to A6's generation, so nothing running is refused.
- **A8b raises it.** A8b's migration raises the minimum to A8b's generation. From then on every A6-to-A8a
  build, including an A7 image, is refused at startup, exactly as a stale `catalogVersion` is.
- **Why A6 and not A8b.** The check has to be compiled into every build it must refuse. A check first
  shipped in A8b could not stop an A7 image, which would not contain it.
- **Builds older than A6** carry no fence check, but they are also older than A7, so A7's consumer
  contract bumps already refuse them. Between the two fences, every build older than A8b is refused.

This fence is not a consumer contract version, so the staging rule that only A7 changes consumer
versions still holds.
