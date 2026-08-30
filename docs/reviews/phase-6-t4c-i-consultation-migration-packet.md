# Phase 6 unit 4c-i — consultation, deployed dark (implementation packet)

- **Plan:** `docs/superpowers/plans/2026-08-29-decision-workflow-4c.md` §A and §D ("4c-i, the
  migration unit") under the family plan `docs/superpowers/plans/2026-08-13-decision-workflow.md`.
- **Base:** `881002bb` (the merged 4c-0 sanctioned-reset centralization) · **Branch:**
  `claude/phase6-4c-i-consultation-migration`
- **Red anchor:** the whole probe suite. `phase6-t4c-consultation.test.ts` cannot pass at
  `881002bb` — neither table exists there — and `phase6-t4c-migration-proof.sh` has no migration
  to apply. That is the honest statement of the anchor and it is stated rather than dressed up as
  per-arm reproduction: this unit CREATES the facts it seals, so "red before" is structural.
  What is NOT structural, and is therefore proven arm by arm below, is that each seal refuses the
  specific forgery it claims to and ACCEPTS the coherent shape.

## Vision alignment

One user workflow: a PMC asks a named member a question about an open decision, and that member
answers — advice that informs without gating. Consultation moves no status and changes no gate
verdict; it widens visibility exactly one way, and only for the cycle it was asked in.

One fact, one canonical owner. `decisions` owns both new facts and read-encapsulates them from
birth. The two cross-module questions they ask — is this membership ACTIVE and who is it, and is
this project OPERABLE — are answered by `orgs`, which owns `Membership` and `Project`, through
two NEW owned SQL primitives registered exactly as the delivered three were, over the
already-declared decisions → orgs boundary. No seal reads another module's table directly.

Preserve attributable human approvals. The unit does not touch the approval path, but it does
make the approval REGISTER load-bearing (its row count is the cycle a consultation is frozen to),
so it seals that register against the erasure that would silently revive closed threads.

Additive migration, tenant isolation proven against PostgreSQL. Every containment key is a
COMPOSITE foreign key, and the packet proves the columns rather than asserting them.

## Review unit

<!-- review-size: justified-large -->
<!-- migration-scope: inseparable -->
<!-- correction-owner: claude -->

**Justified-large (12 files, ~2,360 changed lines).** The overage is the migration (648) plus its
probes (1,122) plus its two executable proofs (394). Splitting them is the one thing the plan
forbids by name: *"no invariant this migration installs is probed later than the PR that installs
it"* (§D, review round 2) — a DB invariant whose first probe waits for 4c-ii can merge wrong and
become **immutable history** before anything detects it. The remaining eight files are one to
three lines each: the manifest, two tripwire pins, the reset registry, the corpus pin, the CI
step, and the runbook.

**Migration scope: inseparable.** There is no service or UI work to separate FROM — the unit is
deliberately dark. The migration IS the unit.

### What this unit delivers

- **The two append-only facts.** `DecisionConsultation` (its own `projectId`, the decision, the
  requester, the consultee BY MEMBERSHIP, the decisions-owned canonical `consulteeUserId`
  audience, the frozen `openCycle`, the question, and `sourceCommandId`) and
  `DecisionConsultationResponse` (bound to its consultation by `(projectId, id, decisionId)`, the
  responder, the advice, an optional same-decision option REFERENCE, and its own
  `sourceCommandId`). At most one response per consultation, enforced by a UNIQUE.
- **Containment as COMPOSITE keys.** Nine foreign keys, each pinned column-for-column by a
  structural probe read from `pg_constraint` — including the three-column parent key that stops a
  same-project writer attaching a consultation to a DIFFERENT decision, and the project-less
  `(decisionId, id)` option key the unit adds to `DecisionOption` (additive and vacuously
  satisfiable: `id` alone is already unique).
- **Two NEW orgs-owned SQL primitives.** `phase6_membership_active_user` locks the membership row
  and returns its `userId` when ACTIVE — standing and identity in one owned call, serialized
  against the ACTIVE→removed transition a split check-then-read would race.
  `phase6_project_operable` locks the `Project` row BEFORE reading `archivedAt`, so lock-before-read
  is the primitive's contract rather than each trigger's private SQL.
- **Two INSERT eligibility seals**, in the canonical lock order — readiness key (try-acquire, never
  wait inside a trigger) → `Project` → `Membership` → `Decision` — chosen to agree with the
  delivered writers so no consultation write can deadlock `decisions.approve`.
- **§C rule-ii provenance in BOTH moments.** At INSERT: same project, matching `commandType`, still
  `reserved`, actor equal to the fact's own recorded actor, receipt ONE-USE. At COMMIT: a
  DEFERRABLE INITIALLY DEFERRED trigger requiring that receipt to be `succeeded` with `resultRef`
  equal to this row's id. So a row appended with no event — invisible to a projection that
  classifies its generation as caught up — is unrepresentable rather than merely recoverable.
- **Append-only meaning UPDATE, DELETE *and* TRUNCATE.** Row seals on both tables plus named
  statement-level seals, registered in `prisma/sanctioned-reset.ts` in this same unit — and the
  same treatment for `DecisionApprovalRevision`, because 4c makes its COUNT the cycle evidence.
- **The capability reservation**, installed BEFORE its own audit reads, covering both the INSERT
  and the UPDATE door, with the diagnostic-first abort naming the offending projects.
- **The STAGED approval-provenance column** — nullable, enforced by nothing, so a still-serving 4b
  instance keeps approving.

## Pre-review checks (the template's five)

1. `pnpm check` — **EXIT 0**: automation 296/296 (the pg-parse corpus pin advanced 92→93 — the new
   migration is the visible diff, and it parses); web 976/976 across 61 files; API 804/804 across
   58 files; lint, typecheck and both builds clean.
2. Focused reproduce-first tests — `test/integration/phase6-t4c-consultation.test.ts` **58/58**
   against live PostgreSQL, GREEN on three consecutive runs. The suite cannot run at `881002bb`
   (the tables do not exist), which is this unit's red anchor.
3. Full integration battery on a pristine migrated database — see Gates.
4. `scripts/upgrade-proof.sh` — extended with a 4c-i section, PASSED, plus the new
   `scripts/phase6-t4c-migration-proof.sh` (five states) PASSED and wired into CI.
5. Tripwires advanced IN THIS UNIT: the decisions manifest `ownsModels` + `readEncapsulated` gain
   both new models (with the `boundary.test.ts` encapsulation pin), `sanctioned-reset-coverage`
   `PROBE_FILES` gains this suite's four deliberate raw truncates, `TRUNCATE_SEALS` gains three
   entries, and the pg-parse corpus pin 92→93.

## Invariant matrix (six rows)

| Invariant | Where enforced | Proven by |
|---|---|---|
| A consultation exists only on a decision whose question is genuinely OPEN — published, `pending`/`change`, on an operable project, naming a consultee who currently STANDS | `phase6_t4c_consultation_seal` (readiness key → `phase6_project_operable` → `phase6_membership_active_user` → the `Decision` row under FOR SHARE) | the unpublished-draft, approved, withdrawn, record, removed-consultee and archived-project arms; the P41 archive barrier in BOTH orderings, with the loser OBSERVED waiting in `pg_stat_activity` |
| The recorded audience is the membership's real user — a forged read grant is unrepresentable | the same seal's `consulteeUserId` arm against the orgs-owned resolution | the WRONG-AUDIENCE arm (a consulteeUserId that is not the user the membership resolves to), refused at both the DB and the upgrade proof |
| A consultation is bound to the cycle it was asked in: an approval closes it permanently and a reopen never revives it | `openCycle` frozen at INSERT against the live revision count under the decision row lock, re-compared at RESPONSE, with the register sealed against TRUNCATE | the current−1 and current+1 request arms; the request → approve → reopen → late-response refusal; the approval-register TRUNCATE refusal; and the mirror arm — a NEW consultation in the reopened cycle is ACCEPTED |
| Only the NAMED consultee answers, exactly once, and only about their own decision's options | the response seal's responder arm + the `consultationId` UNIQUE + the `(decisionId, recommendedOptionId)` composite FK | the non-consultee arm, the second-response arm, the foreign-option arm, and the three-column parent-key arm that catches a same-project mis-attachment |
| No ACCEPTED write is invisible to the projection: every row is the RESULT of a completed command by its own recorded actor | the INSERT provenance arm + the DEFERRABLE commit-time result binding + the `(projectId, sourceCommandId)` one-use UNIQUE | the fabricated / foreign-project / spent / succeeded / wrong-type / wrong-actor arms, and the two commit-time arms (never-completed, and a `resultRef` naming another row) |
| The previous release runs UNCHANGED against this schema, and the gate cannot be opened before 4c-ii | nothing reads or writes the new tables; the approval-provenance column is nullable and unenforced; the reservation trigger covers both the INSERT and UPDATE doors | the previous-release approval arm (DB + upgrade proof); the migration proof's ABORT state, BOTH race orderings with terminal assertions, and the row-free clean deploy |

## Executable proofs

`apps/api/scripts/phase6-t4c-migration-proof.sh` (new, wired into CI beside `upgrade-proof.sh`)
proves what the MIGRATION does, which only remains provable while the file is still being written:

| State | Claim | Result |
|---|---|---|
| 1 — ABORT | a pre-existing `consultation` capability row makes the deploy refuse, NAMING the project, with neither table created | ok |
| 2 — BARRIER A | a concurrent `capability:enable` in flight: the migration is OBSERVED waiting on `ProjectCapability`, the enable lands first, the migration ABORTS, and it NEVER commits with the row present | ok |
| 3 — BARRIER B | the same race the other way: the migration lands first and the enable is REJECTED — by the INSERT door and by the UPDATE re-key door | ok |
| 4 — RETRY | a PARTIAL apply (killed after the tables exist, 2/10 seals armed) COMPLETES on re-run with all ten armed | ok |
| 5 — CLEAN | fresh deploy: ten seals armed, both tables ROW-FREE, and the migration replays cleanly over its own completed state | ok |

`scripts/upgrade-proof.sh` gains a 4c-i section: the tables land row-free over the legacy fixture
with every seal armed and no legacy approval given invented provenance; a COHERENT command-path
request and response are **ACCEPTED** (precision — a seal that refuses everything is an outage);
and eleven hostile shapes are EXECUTED and refused, each matched against its own message so a
refusal by the wrong layer fails the proof.

## What this unit deliberately does NOT do, and where it lands instead

- **No CHECK on `ProjectCapability.capability`** — Board decision, 2026-08-29 on PR #480, not
  re-litigable. Restricting an existing free-text column would break the previous release's
  generic `capability:enable` writer during exactly the window this unit must survive.
- **No enforcement of `DecisionApprovalRevision.sourceCommandId`.** The delivered
  `DecisionsService.approve` writes no receipt; requiring one here would reject every approval
  performed by a still-serving 4b instance. The column is staged nullable; the trigger lands in
  4c-ii, after the drain-first cutover. The hostile arm that proves the trigger works therefore
  lands with the trigger — 4c-i proves only the compatibility direction, and says so in the suite.
- **No contracts, commands, routes, projection thread, push families or UI.** Those are 4c-ii,
  red-anchored against a base that already carries this migration.

## Gates

- `pnpm check` — **EXIT 0** (automation 296/296; web 976/976 across 61 files; API 804/804 across
  58 files).
- Focused: `phase6-t4c-consultation.test.ts` **58/58**, three consecutive runs.
- Tripwires: `src/platform/module-registry` **59/59**.
- `scripts/phase6-t4c-migration-proof.sh` — **PASSED** (all five states).
- `scripts/upgrade-proof.sh` — **PASSED**, including the new 4c-i section.
- Full integration battery on a pristine migrated database — recorded in the PR body.
