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
