# 4d-iii — the additive staging (R0 … R4) and the inventory-to-unit map

Staging record of 2026-10-05, opened by the autonomous runner when 4d-iii became reachable: the drain
directive `phase-6-4d-previous-release-drained` cleared with #693 (`f301d44`), whose committed
`docs/rollout/phase-6-4d-drain-evidence.json` is a `drained` verdict at minimum release `f8274f4`
(A8b) and minimum catalog version 3. The owner chose additive staging for 4d-iii in the authoring
session (2026-10-05, after the Board's instruction to start 4d-iii from STATUS), and the Board's answers to
the two attribution questions R0 raises are recorded under R0; this record is that
disposition's vehicle, as `2026-09-21-4d-i-b-additive-units.md`, `2026-09-26-4d-ii-a-additive-units.md`
and `2026-09-30-4d-ii-b-additive-units.md` were for their units. Merging it records the staging;
closing it, or a coordination note on #482 choosing §D's single unit, reverses it before any R-unit
opens.

This document changes **how 4d-iii is staged, not what it contains**. Every item of §D's 4d-iii
inventory (`2026-09-07-decision-workflow-4d.md` lines 7390–7692) maps to exactly one of R1–R4 below, and
§A remains the specification for each item. R0 (R0a, R0b, R0c) adds no inventory item: it is the
writer work those items presuppose, which the audit found missing on `main`. R0b's admission of the
system pair is the one seal change that work needs before it can be written. Where the plan's text and the code on `main` disagree,
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

R0 (as R0a, R0b, R0c) completes the writers; R1, R2 and R3 install seals; R4 retires the doors. Installing every trailing
seal BEFORE the doors drop means that at no deployed state is the architect chain live while a seal
the plan pairs with the retirement is missing. Each R-unit is safe on its own:

- **R0 makes every delivered writer state the pins the seals will require** (the audit below found
  that several do not). It is the migration/service seam §D requires, run in the direction the trailing
  seals need: writers first, seals after. It is THREE units, because one of its writers is refused by a
  live seal today:
  - **R0a (service-only)** completes the human and org owner/admin writers. The 4d-i event seal already
    admits everything R0a writes: `phase6_t4d_actor_pair_true` (`20271220000000…/migration.sql:505`)
    judges the pair through `platform_user_holds_role_windowed`, which admits `pmc` for an org
    owner/admin with no membership on the project.
  - **R0b (migration-only)** ADMITS the system pair (#714 review, Codex 4181088585). Today the 4d-i event seal REFUSES any pair on a
    non-`human` actor (`20271220000000…/migration.sql:3576`), so a system event carrying Q1's attribution
    would abort at commit. R0b re-states that arm (`CREATE OR REPLACE`, marker-aware like every 4d replace)
    to admit, on a `system` actor only, the system role together with a name drawn from a registered set
    of automation identities, and nothing else. It also adds the nullable `ReleaseLease.serverGeneration`
    column (with its `schema.prisma` field; the lease writer is raw SQL naming its columns). It admits; it
    requires nothing, so every delivered writer still commits.
  - **R0c (service-only)** makes the system emitters write that pair and the lease record its generation.
    It opens only after R0b is deployed.
- **R1–R3 change nothing a delivered writer does once R0 is on `main`.** Each opens only after R0c has
  merged and DEPLOYED: the release carrying R0c is the oldest one that may serve when a seal lands, and
  each R1–R3 migration refuses to run while a live `ReleaseLease` predates it (the same SERIALIZED
  preflight R4 carries, step 1 below: the register locked against new leases and renewals before it is
  read, and held to commit). A one-time check cannot stop an older image from STARTING after the
  migration commits (#714 review, Codex 4181162627), so the fence is also PERSISTENT:
  - R0c raises the compiled `SERVER_GENERATION` (`src/platform/server-generation.ts:46`) from 2 to 3;
  - R1, the first seal, raises the persisted `ServerGeneration` minimum to 3 in its own transaction, under
    the serialized lease preflight, before installing its seal;
  - from then on, any R0a- or R0b-era build is REFUSED AT STARTUP by `judgeServerGeneration`
    (`server-generation.ts:87`), the existing mechanism migrations alone may raise;
  - neither of those stops an R0a- or R0b-era process that is ALREADY SERVING when R1 runs: every
    R0-era release compiles catalog version 3, so a catalog-only preflight cannot tell them from R0c
    (#714 review, Codex 4181245450). The lease therefore records its build's generation. R0b adds a
    nullable `ReleaseLease.serverGeneration` column (additive; the INSERT names its columns, so the
    delivered writer keeps committing and writes NULL), and R0c's `writeLease` records the compiled
    `SERVER_GENERATION`. Each R1–R3 preflight then refuses, under the same lock, while any LIVE lease has
    `serverGeneration IS NULL OR serverGeneration < 3`: that is, it requires every pre-R0c process to
    DRAIN first. A drained process cannot come back. `renewLease` never revives a lapsed lease, the
    lease fence terminates a process whose lease has lapsed, and the raised minimum refuses its restart.
    Proofs: a live NULL-generation lease and a live generation-2 lease each refuse R1. An expired one is
    admitted, and so is a live generation-3 lease;
  - R2, R3 and R4 each fail closed unless the persisted minimum is at least 3. Legacy and
  drain-window rows are untouched: every
  seal is INSERT- or transition-time, never a backfill. The doors still stand, so `rollout.phase6_4d`
  keeps reading `'reserved'`.
- **R4 is the retirement.** It is the only unit that makes the chain reachable, and it runs only after
  R1–R3 are on `main`. `readPhase6_4dRollout` reads `'open'` only once every door is gone, which R4's
  closing verification guarantees within its own transaction.
- **4d is complete when R4 merges** (§D's "4d is complete when 4d-iii merges"), and the §E handoff
  follows it.

## The units

### R0 — the writers state every pin (R0a service, R0b migration, R0c service)

The audit of `main` at `4b40830` against R1–R3's requirements found these writers non-compliant. R0
fixes each, under the Board's two answers of 2026-10-05 (relayed by PMCvitan Promote; first given in the
authoring session):

- **Decision 1 (Q1) — every event is attributed; every event carries the role and name pair.**
  - System events record a SYSTEM ROLE plus a NAMED AUTOMATION IDENTITY.
  - Org owner/admin actions record the `pmc` role.
  - No event is written without the pair.
- **Decision 2 (Q2) — a stale-session action is refused, with re-sign-in.** When the signed-in user's
  token role no longer stands on the project, the action is refused with a clear message, "your role on
  this project changed — sign in again", as the chain-active approve and the forward already refuse. It
  is never recorded with an empty or false attribution.

The non-compliant writers:

| Requirement | Site on `main` | Today | R0 change |
| --- | --- | --- | --- |
| `ChangeRequest` closure set | `decisions.service.ts:583` (re-approval) | writes 3 of 6 (no `resolvedByCommandId`, `resolvedByRole`, `resolvedByName`) | write all six from the command's receipt and the resolved envelope |
| `ChangeRequest` closure set | `decisions.service.ts:1826` (`withdrawChange`) | writes 3 of 6; resolves no envelope; `ctx.commandId` can be NULL (no `synthesizeKeyWhenAbsent`) | synthesize the key when absent, resolve the envelope, write all six |
| `ChangeRequest` requester pair | `decisions.service.ts:1729` (`requestChange`) | `pair?.x ?? null` | Decision 2 |
| `DecisionApprovalRevision` pair | `decisions.service.ts:610` (no-chain approve) | `envelope?.x ?? null` | Decision 2 |
| consultation request / response pairs | `decisions.service.ts:964`, `:1110` | `pair?.x ?? null` | Decision 2 |
| `DomainEvent` pair, human emitters | every `emitEvent` caller that passes a possibly-NULL pair, or none (decisions, members, and every other service and participant; the commercial human paths) | resolved inside `emitEvent`, NULL when the role does not stand | `emitEvent` refuses a human event whose pair does not resolve (Decision 2) |
| `DomainEvent` pair, org owner/admin | `orgs.service.ts` 518, 1164, 1182, 1198 and the participants it drives during project initialization | the actor carries the ORG role (`owner`/`admin`), which `ProjectUserStanding` never holds, so the pair is always NULL | **R0a:** record the `pmc` role, the project role the org authority grants and the windowed owner/admin arm already admits (Decision 1). An owner/admin who also holds a membership on the project records that membership's role, which is the role the windowed arm admits for them |
| `DomainEvent` pair, system actors | `decisions.effects.ts:145`, `commercial-activation.service.ts:85→199`, `commercial-reevaluate.cli.ts:144` | `emitEvent` throws on any envelope for a system actor, and the 4d-i seal refuses a pair on a non-`human` actor (`migration.sql:3576`); the pair is always NULL | **R0b** admits a system role plus a registered automation identity on `system` actors; **R0c** makes `emitEvent` accept that pair and each system emitter write it (Decision 1) |

Every row of the table not marked R0b or R0c is R0a's. The writers already compliant and left alone: `rejectProvisionalApproval` (`:1325`), every
`Notification` row carrying a `decisionId`, both `revisionId` payload emitters (`:691`, `:1233`), and the
pair-throwing chain paths (approve under an active chain, forward, countersign, disagree, the stranded
resolution, `members.factPair`). R0's proofs:
- **R0a:** each changed writer driven through the service, writing the complete pin; each stale-role
  command refused with the decision's state unchanged; the org owner/admin events carrying `pmc`.
- **R0b:** the system pair admitted on a `system` actor; refused on a `human` actor; refused with an
  unregistered or blank name; a human pair still judged by `phase6_t4d_actor_pair_true` exactly as before;
  a P3005 replay leaving the re-stated arm in place; the `ReleaseLease.serverGeneration` column present and
  the delivered `writeLease` still committing with it NULL.
- **R0c:** each system emitter committing its event with the pair; a registered lease recording
  `serverGeneration = 3`.

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
    - A `standard` withdrawal requires the resolver to be the requester, or to hold `pmc` per the
      WINDOWED predicate `platform_user_holds_role_windowed(projectId, resolvedById, 'pmc')` under
      `phase6_try_readiness` (#714 review, Codex 4181162631). The unwindowed `platform_user_holds_role`
      reads `ProjectUserStanding` alone. A membership-less org owner/admin is issued a `pmc` token and
      passes `withdrawChange`'s service authorization, but holds no `ProjectUserStanding` row until R4's
      re-projection, so the unwindowed predicate would roll back an authorized withdrawal. The windowed
      predicate is the one `phase6_t4d_actor_pair_true` already uses.
  - **RE-OPEN:** any return to `'open'` is refused.
  - **DELETE:** refused. The SANCTIONED RESET is the only exception.
- **The seed.** `prisma/seed.ts`'s DL-003 plant (lines 396–434) today disables `ChangeRequest_t4d_paired`
  alone; it is rewritten to disable the CLOSED set of two names (`ChangeRequest_t4d_provenance_required`
  and `ChangeRequest_t4d_paired`) in the existing `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …)`
  shape. The `changeRequest.deleteMany()` reset (line 143) becomes the second site of the provenance
  seal's name under the same protocol. No opening bundle is fabricated.
- **Every other direct teardown** (#714 review, Codex 4181088591). The DELETE arm refuses an ordinary
  delete, and fifteen integration suites delete `ChangeRequest` rows directly in their teardown:
  `change-control`, `command-ledger`, `decisions-projection`, `derived-readiness`, `phase1-baseline`,
  `phase2-consequences`, `phase6-t4a-withdraw`, `phase6-t4b-decider`, `phase6-t4c-ii-consultation`,
  `phase6-t4d-i-seal-stripped`, `phase6-t4d-ii-a2-request-change`, `phase6-t4d-ii-a5e-countersign-boundary`,
  `phase6-t4d-ii-a7a-kinded-notice-writers`, `platform-command-receipt` and `start-readiness-race` (all
  under `apps/api/test/integration/`). R1 converts every one to ONE sanctioned fixture reset in
  `test/integration/fixtures.ts`, which disables the provenance seal by name inside its transaction under
  the same `pg_trigger` protocol. A statement tripwire then pins the closed set of admitted
  `ChangeRequest` delete sites: the seed reset and that fixture. A new direct delete in any suite is RED.
- **Proofs:**
  - P33 gains the hostile arms: the fabricated row born closed; the pre-filled open row; the
    status-only closure; the crossed pairs; a stranger's `standard` withdrawal; a `countersign_rejection`
    withdrawal by a PMC with every column correct; the re-open; and the DELETE. Each is refused, with
    the decision's state unchanged.
  - A membership-less org owner/admin withdrawing ANOTHER user's `standard` request COMMITS, before
    any re-projection. This is RED against the unwindowed predicate.
  - The two delivered closures, as R0 completes them, still commit (`decisions.service.ts:583`, `:1826`).
  - P42's old-shape `ChangeRequest` insert (`UP4D-CR1`, `upgrade-proof.sh` near line 5209) is REFUSED,
    beside the delivered `requestChange` committing.
  - The serialized preflight refuses R1 while a live pre-R0c lease (NULL or generation 2) stands.
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

The `DomainEvent` arm requires the pair on BOTH actor kinds: the human pair R0a writes and the system
pair R0b admits and R0c writes. It adds a requirement only; the admission is R0b's.

The fixture plants that write these rows directly gain the new seal names in their existing bypass
lists, as named bypasses: `plantLegacyApprovalRevision` (`test/integration/fixtures.ts:327`),
`insertRawEvent`/`insertRawEventVia` (`:519`; its `system:seed` default must then carry the system
pair), `plantLegacyEvent` (`:575`) and `plantUnpairedDecisionState` (`:377`).

Two integration suites also write a LEGACY-shaped `Notification` directly: a row with a `decisionId` and
neither `kind` nor `eventId`, deliberately, to exercise the legacy feed (#714 review, Codex 4181162635):
- `phase6-t4d-ii-a7a-kinded-notice-writers.test.ts:186`;
- `phase6-t4a-withdraw.test.ts:2015`.

R2 routes both through one named legacy-notice fixture plant that disables the `Notification` presence
seal by name inside its transaction. A statement tripwire pins the closed set of admitted direct
`Notification` writers of that shape. Direct inserts that already carry both `kind` and `eventId` (the
a7a, a4c and seal-stripped hostile probes) are unaffected and keep testing the seals they target.

The pairing-matrix suite's raw writers (#714 review, Codex 4181245446). `phase6-t4d-i-b-pairing-matrix.test.ts`
simulates the CURRENT writers with raw inserts that omit the pins R2 requires: the APPROVAL revision
(lines 286, 299; no `approvedByName`/`approvedByRole`), the CONSULT request (line 311; no requester
pair) and the RESPOND response (line 324; no responder pair), plus the system `DomainEvent` (line 380;
no pair). R2 includes this suite and updates each simulated current writer to carry its pins, so the
matrix keeps testing the pairing seals it targets and is not refused by the presence seals first. A
row that is deliberately legacy-shaped keeps a named bypass instead, and only such a row.

Proofs (`apps/api/scripts/upgrade-proof.sh`, P42):
- P42's existing old-shape `Notification` insert (`UP4D-N1`, near line 5231) names no `decisionId`.
  The R2 seal applies only to decision-bound rows, so that insert stays COMMITTED and its assertion is
  unchanged (#714 review, Codex 4181245454).
- R2 ADDS a decision-bound old-write case: a `Notification` with a `decisionId` and neither `kind` nor
  `eventId`, now REFUSED, beside the delivered writer committing.
- P42's old-shape `ChangeRequest` insert (`UP4D-CR1`, no `sourceCommandId`, no requester pair) becomes
  REFUSED under R1's INSERT arm. It moves to R1's proofs, beside the delivered `requestChange`
  committing.

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

1. **Preflight on `ReleaseLease`, SERIALIZED with process registration** (#714 review, Codex 4181088588).
   The FIRST statement after the gates is `LOCK TABLE "ReleaseLease" IN SHARE ROW EXCLUSIVE MODE`, held to
   commit. That mode conflicts with the writer's `INSERT` and `UPDATE` (`release-lease.service.ts:89`,
   `:102`), so no process can register a lease, and no lease can be renewed, between the read and the
   commit. Without the lock, an old process could commit its lease after the check saw none and before the
   doors dropped. A serving process's renewal waits for the migration's commit, which is well inside the
   writer's 60-second fence margin. Under that lock, abort, with every door intact, if any lease has
   `catalogVersion` below the persisted catalog maximum (`max(OutboxConsumerCatalog.catalogVersion)`)
   AND `leaseUntil > clock_timestamp()`. This is the same minimum the drain record judged
   (`minimumCatalogVersion.source: "the persisted catalog maximum"`, value 3). The register is frozen and
   undeletable (`ReleaseLease_t4d_frozen`, the no-truncate seal), so a live old lease cannot be
   re-versioned or removed to pass this check. A process that STARTS after the commit is fenced by the
   bumped consumer contracts (`syncConsumerCatalog` refuses an older catalog; the `ServerGeneration`
   minimum), as §D's drain paragraph states. The lock is taken before step 3's fence, and step 3 does not
   include this table.
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
    defaults; raise if any remains; require the marker row. AND fail closed unless every R0b–R3 seal is
    present by name (#714 review, Codex 4181088593): the re-stated event-envelope arm, every
    `ChangeRequest_t4d_provenance_required` arm, every R2 presence seal, and the three R3 readiness
    triggers. So the doors cannot drop on a database where any of them is missing, whatever path brought
    it there.

**Registration and pinned suites:**
- EVERY migration of this staging is registered in `scripts/migrate.sh`'s `ALWAYS_EXECUTE`: R0b, R1, R2,
  R3 and R4, each in the unit that adds it (#714 review, Codex 4181088593). On the supported P3005 /
  `db push` baseline path, a migration outside that list is resolved as applied without running. Every
  column these seals judge already exists, so nothing else would force them to run, and a baseline
  replay would otherwise reach R4 with none of the seals installed. Each file is idempotent
  (`CREATE OR REPLACE`, `DROP … IF EXISTS`, marker-aware), as the list requires. Each unit also updates the
  three tests that pin that list (`phase6-t4b-decider.test.ts`, `phase6-4c-iiir-inbox-repair.test.ts`,
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
   a NULL pair; and that system events cannot carry one, because the 4d-i event seal refuses a pair on any
   non-`human` actor (`migration.sql:3576`; its own comment scopes 4d-iii's rule to "every new HUMAN
   event"). The Board's Q1 extends attribution to system events, so R0b admits the system pair before R0c
   writes it. R0 closes all of it before any seal lands.
5. **The service line numbers.** §D cites the two closures at `decisions.service.ts:492` and `:919`;
   on `main` they are at `:583` and `:1826`. The units cite `main`.

## Not in 4d-iii

As §D states: no backfill, no preservation seal, no third gate, no rename, no external collaboration,
no change to approval history, no UX or performance work, no contractor-capture unit, no automated
drain actor, no repair engine, no PL/pgSQL emitter. The drain's evidence is not re-run by these units;
R4's preflight is the runtime door beside it.
