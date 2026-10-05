# 4d-iii — the additive staging (R0 … R4) and the inventory-to-unit map

Staging record of 2026-10-05, opened by the autonomous runner when 4d-iii became reachable: the drain
directive `phase-6-4d-previous-release-drained` cleared with #693 (`f301d44`), whose committed
`docs/rollout/phase-6-4d-drain-evidence.json` is a `drained` verdict at minimum release `f8274f4`
(A8b) and minimum catalog version 3. The owner chose additive staging for 4d-iii in the authoring
session (2026-10-05, after the Board's instruction to start 4d-iii from STATUS); this record is that
disposition's vehicle, as `2026-09-21-4d-i-b-additive-units.md`, `2026-09-26-4d-ii-a-additive-units.md`
and `2026-09-30-4d-ii-b-additive-units.md` were for their units. Merging it records the staging;
closing it, or a coordination note on #482 choosing §D's single unit, reverses it before any R-unit
opens.

This document changes **how 4d-iii is staged, not what it contains**. Every item of §D's 4d-iii
inventory (`2026-09-07-decision-workflow-4d.md` lines 7390–7692) maps to exactly one of R1–R4 below, and
§A remains the specification for each item. R0 adds no inventory item: it is the writer work those
items presuppose, which the audit found missing on `main`. Where the plan's text and the code on `main` disagree,
the section "Plan-versus-main reconciliation" states the disagreement and which side the unit follows.

## Why additive

§D stages 4d-iii as one migration-only unit. Against `main` at `4b40830` it is not one review unit's
worth of change: the fenced retirement itself, four families of trailing seals, the seed's named
bypass, the six-door inventory pinned by roughly ten integration suites, the `ALWAYS_EXECUTE`
registration pinned by three more, and the matching sections of `scripts/upgrade-proof.sh`. The
retirement must stay ONE transaction — the `LOCK TABLE` fence is held to commit and the marker is
written under it — but the trailing seals do not depend on that fence. They depend only on the drain,
which has cleared. Staged separately, each family gets a full exact-head review, and a finding on one
family does not hold the others.

## The order, and why the retirement is LAST

R0 completes the writers; R1, R2 and R3 install seals; R4 retires the doors. Installing every trailing
seal BEFORE the doors drop means that at no deployed state is the architect chain live while a seal
the plan pairs with the retirement is missing. Each R-unit is safe on its own:

- **R0 is service-only and changes no schema.** It makes every delivered writer state the pins the
  seals will require (the audit below found that several do not). It is the migration/service seam §D
  requires, run in the direction the trailing seals need: writers first, seals after.
- **R1–R3 change nothing a delivered writer does once R0 is on `main`.** Each opens only after R0 has
  merged and DEPLOYED: the release carrying R0 is the oldest one that may serve when a seal lands, and
  each R1–R3 migration refuses to run while a live `ReleaseLease` predates it (the same preflight R4
  carries, at the R0 release's catalog version or, if R0 does not bump the catalog, a release-identity
  check against the R0 merge, stated in R1's packet). Legacy and drain-window rows are untouched: every
  seal is INSERT- or transition-time, never a backfill. The doors still stand, so `rollout.phase6_4d`
  keeps reading `'reserved'`.
- **R4 is the retirement.** It is the only unit that makes the chain reachable, and it runs only after
  R1–R3 are on `main`. `readPhase6_4dRollout` reads `'open'` only once every door is gone, which R4's
  closing verification guarantees within its own transaction.
- **4d is complete when R4 merges** (§D's "4d is complete when 4d-iii merges"), and the §E handoff
  follows it.

## The units

### R0 — the writers state every pin (service-only)

The audit of `main` at `4b40830` against R1–R3's requirements found these writers non-compliant. R0
fixes each, with the owner's two decisions of 2026-10-05 (recorded in the authoring session):

- **Decision 1 — every event is attributed.** System actors and org owner/admin actions record a
  truthful role and name rather than none.
- **Decision 2 — a stale role is refused, not recorded empty.** When the signed-in user's token role no
  longer stands on the project, the command is refused with a re-sign-in message ("your role on this
  project changed — sign in again"), as the chain-active approve and the forward already do. Nothing is
  recorded with a NULL or false pair.

The non-compliant writers:

| Requirement | Site on `main` | Today | R0 change |
| --- | --- | --- | --- |
| `ChangeRequest` closure set | `decisions.service.ts:583` (re-approval) | writes 3 of 6 (no `resolvedByCommandId`, `resolvedByRole`, `resolvedByName`) | write all six from the command's receipt and the resolved envelope |
| `ChangeRequest` closure set | `decisions.service.ts:1826` (`withdrawChange`) | writes 3 of 6; resolves no envelope; `ctx.commandId` can be NULL (no `synthesizeKeyWhenAbsent`) | synthesize the key when absent, resolve the envelope, write all six |
| `ChangeRequest` requester pair | `decisions.service.ts:1729` (`requestChange`) | `pair?.x ?? null` | Decision 2 |
| `DecisionApprovalRevision` pair | `decisions.service.ts:610` (no-chain approve) | `envelope?.x ?? null` | Decision 2 |
| consultation request / response pairs | `decisions.service.ts:964`, `:1110` | `pair?.x ?? null` | Decision 2 |
| `DomainEvent` pair, human emitters | every `emitEvent` caller that passes a possibly-NULL pair, or none (decisions, members, and every other service and participant; the commercial human paths) | resolved inside `emitEvent`, NULL when the role does not stand | `emitEvent` refuses a human event whose pair does not resolve (Decision 2) |
| `DomainEvent` pair, org owner/admin | `orgs.service.ts` 518, 1164, 1182, 1198 and the participants it drives during project initialization | the actor carries the ORG role (`owner`/`admin`), which `ProjectUserStanding` never holds, so the pair is always NULL | record the project role the org authority grants (`pmc`), the windowed owner/admin arm the readiness functions already read (Decision 1) |
| `DomainEvent` pair, system actors | `decisions.effects.ts:145`, `commercial-activation.service.ts:85→199`, `commercial-reevaluate.cli.ts:144` | `emitEvent` throws on any envelope for a system actor; the pair is always NULL | an explicit system role and a named automation identity, and `emitEvent` accepts that pair for system actors (Decision 1) |

The writers already compliant and left alone: `rejectProvisionalApproval` (`:1325`), every
`Notification` row carrying a `decisionId`, both `revisionId` payload emitters (`:691`, `:1233`), and the
pair-throwing chain paths (approve under an active chain, forward, countersign, disagree, the stranded
resolution, `members.factPair`). R0's proofs: each changed writer driven through the service, writing
the complete pin; each stale-role command refused with the decision's state unchanged; the system and
org owner/admin events carrying their pair.

### R1 — `ChangeRequest_t4d_provenance_required` and the seed's named bypass

Plan §D lines 7434–7614 (rounds 8, 10–13, 16, 24 of #572).

- The seal's four arms (it opens only after R0):
  - **INSERT:**
    - `sourceCommandId` and the frozen `requestedByRole`/`requestedByName` pair are required;
    - `status <> 'open'` is refused outright;
    - the closure set (`resolvedById`, `resolvedAt`, `resolution`, `resolvedByCommandId`,
      `resolvedByRole`, `resolvedByName`) must be EMPTY.
  - **CLOSURE:** keyed on `status` LEAVING `'open'`, never on `resolvedById`.
    - The set must go NULL → COMPLETE in the closing statement.
    - `status` is bound to its own `resolution`: only `('resolved','reapproved')` and
      `('withdrawn','withdrawn')` are admitted, so both crossed pairs are refused.
    - `open → withdrawn` on a `countersign_rejection` request is refused by ORIGIN, before any
      authority check.
    - A `standard` withdrawal requires the resolver to be the requester, or to hold `pmc` per
      `platform_user_holds_role(projectId, resolvedById, 'pmc')` under `phase6_try_readiness`.
  - **RE-OPEN:** any return to `'open'` is refused.
  - **DELETE:** refused. The SANCTIONED RESET is the only exception.
- **The 4d-i event seal's system arm.** The 4d-i seal admits the envelope pair only on a human actor.
  Decision 1 needs the pair on system events too, so R2 (not R1) re-states that arm to admit the system
  pair R0 writes; see R2.
- **The seed.** `prisma/seed.ts`'s DL-003 plant (lines 396–434) today disables `ChangeRequest_t4d_paired`
  alone; it is rewritten to disable the CLOSED set of two names (`ChangeRequest_t4d_provenance_required`
  and `ChangeRequest_t4d_paired`) in the existing `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …)`
  shape. The `changeRequest.deleteMany()` reset (line 143) and the fixtures' equivalent become the second
  site of the provenance seal's name under the same protocol. No opening bundle is fabricated.
- **Proofs:**
  - P33 gains the hostile arms: the fabricated row born closed; the pre-filled open row; the
    status-only closure; the crossed pairs; a stranger's `standard` withdrawal; a `countersign_rejection`
    withdrawal by a PMC with every column correct; the re-open; and the DELETE. Each is refused, with
    the decision's state unchanged.
  - The two delivered closures still commit (`decisions.service.ts:492`, `:919`).
  - P28b's seed arm runs the FULL seed on a fresh and on a mature database with every seal enabled
    afterwards. The same plant with ONLY the provenance seal disabled is refused at commit by
    `ChangeRequest_t4d_paired`.

### R2 — the trailing INSERT-time presence seals

Plan §D lines 7614–7626 (#561 round 2, finding 8; round 19; P42).

Every new row of each kind must carry its pin; legacy and drain-window NULL rows are untouched:

- `Notification.eventId` AND `kind`, on every new row carrying a `decisionId`;
- `DecisionApprovalRevision.approvedByName` AND `approvedByRole` — this also arms the feed-row arm of the
  no-chain approve's correspondence check (obligation 7's last row);
- `DomainEvent.actorRole` AND `actorName`, on every new event of either kind;
- the `revisionId` payload field, on every new `decision.approved`/`reapproved` event;
- `DecisionConsultation.requestedByRole`/`requestedByName`, on every new request;
- `respondedByRole`/`respondedByName`, on every new response.

The `DomainEvent` arm needs one more change: today's 4d-i event seal admits the pair only on a
`human` actor, so R2 re-states that arm (`CREATE OR REPLACE`, marker-aware like every 4d replace) to
require the pair on BOTH actor kinds, the system pair being the one R0 writes.

The fixture plants that write these rows directly gain the new seal names in their existing bypass
lists, as named bypasses: `plantLegacyApprovalRevision` (`test/integration/fixtures.ts:327`),
`insertRawEvent`/`insertRawEventVia` (`:519`; its `system:seed` default must then carry the system
pair), `plantLegacyEvent` (`:575`) and `plantUnpairedDecisionState` (`:377`).

Proofs: P42's old-write-shape inserts become REFUSED (the arms `scripts/upgrade-proof.sh` marks "admits
until 4d-iii", near line 5235), each beside the delivered writer committing.

### R3 — the three orgs-owned standing-writer seals

Plan §D lines 7626–7632; §A.2's push families.

- `Membership_t4d_readiness`, on every `Membership` row write;
- `OrgMembership_t4d_readiness`, on every owner/admin `OrgMembership` write: it tries
  `phase6_try_org_readiness`, then the org's project keys in ascending order;
- `Project_t4d_org_readiness`, on every `Project` insert, trying the org key.

These are installed after the drain, so no legacy two-write path ever meets them. Proofs: P28b's
direct-write arms.

### R4 — the fenced retirement (LAST)

Plan §D lines 7390–7434 and 7632–7692.

One transaction, in this order:

1. **Preflight on `ReleaseLease`.** Abort, with every door intact, if any lease has
   `catalogVersion` below the persisted catalog maximum (`max(OutboxConsumerCatalog.catalogVersion)`)
   AND `leaseUntil > clock_timestamp()`. This is the same minimum the drain record judged
   (`minimumCatalogVersion.source: "the persisted catalog maximum"`, value 3). The register is frozen and
   undeletable (`ReleaseLease_t4d_frozen`, the no-truncate seal), so a live old lease cannot be
   re-versioned or removed to pass this check.
2. **The `SET LOCAL` gates**, `vitan.phase6_4d_retire` among them.
3. **The fence.** `LOCK TABLE "Project", "OrgMembership", "Membership" IN SHARE ROW EXCLUSIVE MODE`, in
   that order, held to commit. No org key is taken.
4. **The re-projection.** Under `vitan.phase6_4d_standing_reprojection`, `ProjectUserStanding` and
   `OrgUserAuthority` are re-projected from the orgs truth, org by org in ascending id. The diff is
   reported as `NOTICE`s, and the closing report carries the counts.
5. **The consultation request seal's requester arm** is re-pointed onto
   `platform_user_orchestration_authority` with `CREATE OR REPLACE`. The body is otherwise A4a's live
   body, KEEPING the finalized cycle count (`2026-09-26-4d-ii-a-additive-units.md` lines 155–160).
6. **The doors.** All SIX reservation triggers are dropped `IF EXISTS`:
   `Decision_t4d_architect_reserved`, `Decision_t4d_awaiting_reserved`,
   `Membership_t4d_architect_reserved`, `User_t4d_architect_reserved`, `DecisionForward_t4d_reserved` and
   `DecisionEvent_t4d_kind_reserved`. So is their shared function `phase6_t4d_reserved()`.
7. **The two kept finality defaults** are dropped: `DecisionApprovalRevision.finalized` and both
   `revisionFinalized` columns, in the database AND as the Prisma `@default` (`schema.prisma` lines
   1628, 2487 and 3443).
8. **`DecisionEvent_t4d_correspondence`** gets the FULL converse of §A.3 via `CREATE OR REPLACE` of its
   function: the eight listed audit kinds (`countersign_renotified` among them), each requiring its
   fact, its transition and its `DomainEvent` in the same transaction. It is judged AT COMMIT, with the
   (kind, committed status) table §A.3 closes.
9. **The old catalog version.** The pre-4d-ii coverage version's `ExternalEffectCatalog` rows are
   retired with the gated `retiredAt` stamp, never deleted.
10. **`decisions.effects`.** Its catalog row is taken `FOR UPDATE`. Then:
    - with the `RolloutRetirement` marker ABSENT: if the head is inactive, append its activation at
      `activationSeq + 1` under the gate, then VERIFY the head is active, aborting otherwise;
    - with the marker PRESENT: neither append nor require an active head; assert only that the
      migration activation fact EXISTS.
11. **The marker.** `INSERT … ON CONFLICT (unit) DO NOTHING` under the gate.
12. **The closing verification**, exactly as 4c-v's: count the six triggers, the function and the
    defaults; raise if any remains; require the marker row.

**Registration and pinned suites:**
- R4's file is registered in `scripts/migrate.sh`'s `ALWAYS_EXECUTE`, together with the three tests
  that pin that list (`phase6-t4b-decider.test.ts`, `phase6-4c-iiir-inbox-repair.test.ts`,
  `phase6-t4c-v-seal-retirement.test.ts`).
- The suites that pin the six doors move to the retired state:
  - the inventories, `phase6-t4d-i-seal-inventory.test.ts` and `phase6-t4d-i-seal-contract.test.ts`;
  - the rehearsals in `phase6-t4d-i-seal-stripped.test.ts`;
  - the capture/drop/restore suites (A5c, A7d, A8a, A8b, the pairing matrix);
  - the A4b defaults arm.
- The matching sections of `scripts/upgrade-proof.sh` move too.

**Proofs:**
- the preflight refusing a live version-2 lease and admitting an expired one;
- the fence order;
- the re-projection repairing a planted drift;
- the doors, the function and the defaults gone, and the marker written;
- an `ALWAYS_EXECUTE` replay committing as a no-op;
- P28b's mirror probes and P42's old-write refusals;
- P38's activation arm: the replay over a deliberately deactivated consumer COMMITS, appends nothing,
  reuses no token, and the deactivation still stands.

R4 declares `<!-- migration-scope: separated -->`. It is migration-only in §D's sense: its `src/` edits
are limited to the declarative mirrors the tripwire suites pin to the Prisma DMMF. It declares
`justified-large` if it exceeds the standard budget.

## Plan-versus-main reconciliation

1. **The correspondence trigger's marker-aware create.** §D (line 7419) says 4d-i's marker-aware create
   INSTALLS the full body when `RolloutRetirement` is present. The shipped 4d-i
   (`20271221000000_phase6_t4d_i_decision_facts`, around lines 3483–3503) instead LEAVES the existing
   trigger and function untouched when the marker is present, and installs the weak body only when it
   is absent.
   - The property §D wants is that a P3005 baseline replay of a mature database cannot downgrade the
     live seal. Leaving the trigger untouched holds that property: whatever R4 installed survives the
     replay.
   - R4 therefore installs the full body itself, and proves the property directly: a 4d-i replay after
     R4 leaves the full body in place.
   - 4d-i is not edited (a deployed migration's bytes do not change).
2. **The migration preflight does not exist on `main`.** The register, its seals and its index shipped
   in 4d-i; the writer shipped in 4d-ii (`20271226000000_phase6_t4d_ii_release_lease_writer`,
   `src/platform/release-lease.service.ts`). The preflight itself is referenced only in comments (the
   dark migration around lines 2764, 4342, 4452 and 4494; RUNBOOK 1230, 1370 and 1628). R4 builds it as
   step 1.
3. **"Five" doors versus six.** Parts of the plan, STATUS and the RUNBOOK say "five" reservation doors.
   The replay contract (plan line 7673) and `PHASE6_4D_RESERVATION_DOORS`
   (`src/platform/phase6-4d-rollout.ts:27`) name SIX, since `DecisionEvent_t4d_kind_reserved` joined in
   #582's round 15; R4 drops six. A seventh, `ReleaseLease_t4d_insert_reserved`, was already dropped by
   4d-ii (`20271226000000…/migration.sql:47`) and is not R4's.

4. **The writers the trailing seals assume.** §D says "after the drain only writers that state the pin
   remain" and that the delivered `ChangeRequest` writers "already comply". The audit above found that
   neither closure writes the resolver's command, role or name; that the requester, revision,
   consultation and most event pairs are written conditionally; that org owner/admin events always carry
   a NULL pair; and that system events cannot carry one. R0 closes all of it before any seal lands.
5. **The service line numbers.** §D cites the two closures at `decisions.service.ts:492` and `:919`;
   on `main` they are at `:583` and `:1826`. The units cite `main`.

## Not in 4d-iii

As §D states: no backfill, no preservation seal, no third gate, no rename, no external collaboration,
no change to approval history, no UX or performance work, no contractor-capture unit, no automated
drain actor, no repair engine, no PL/pgSQL emitter. The drain's evidence is not re-run by these units;
R4's preflight is the runtime door beside it.
