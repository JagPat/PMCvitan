# Phase 6 unit 4c-ii — consultation, the behaviour unit (implementation packet)

- **Plan:** `docs/superpowers/plans/2026-08-29-decision-workflow-4c.md` §A, §B (P25c, P25d,
  P38c/P40c) and §D ("4c-ii, the behaviour unit"), under the family plan
  `docs/superpowers/plans/2026-08-13-decision-workflow.md`.
- **Base:** `1d6c4ff1` (4c-i merged and cleared at `d4e2ddf5`) · **Branch:**
  `claude/phase6-4c-ii-consultation-behaviour`
- **Scheduled by:** the Board's 2026-08-31 03:45 IST direction on #495. The 30 August sequence
  authorized 4c-0 through 4c-v; no unit of 4c waits on a fresh GO.

## Vision alignment

A PMC asks the person best placed to know, that person answers, and the decision is decided by
whoever was always going to decide it. Consultation INFORMS: nothing here moves a status or
changes a gate verdict. It widens exactly one thing — a consultee's sight of the decision they
were asked about, for the cycle they were asked in.

One fact, one canonical owner: `decisions` owns both consultation facts and read-encapsulates
them; the two cross-module questions (is this membership active and who is it; is this project
operable) go to `orgs` through the delivered participant edge and the two owned SQL primitives
4c-i installed. Preserve attributable human approvals: this unit makes the approval register
PROVABLE, because 4c turns its row count into cycle evidence.

## Review unit

<!-- review-size: justified-large -->
<!-- migration-scope: inseparable -->
<!-- correction-owner: claude -->

**Justified-large (33 files, ~1,800 changed lines).** The plan defines 4c-ii as one unit and gives
the reasons by name. Round 26: the capability must be read by the client AND the server in the
same change, or the gate-off window renders controls whose every request 404s — "a visibly broken
state", and the §D inertness claim would be false for the client while true for the server. Round
5: the web audience mirrors must widen WITH the server, or the API carries the consulted decision
while the rendered UI still hides it from the very consultee the HTTP layer admits. Round 2: no
invariant may be probed later than the PR that installs it. Splitting on any of those seams
produces a PR that is individually green and jointly wrong. The probe suite is 523 of the lines.

**Migration scope: inseparable.** The one migration this unit carries
(`20271115000000_phase6_t4c_ii_approval_provenance`) is a single deferred constraint trigger whose
whole justification is the writer in this same PR: 4c-i staged the column nullable precisely so
the previous release could keep approving, and the trigger may only land once `approve` writes the
receipt. Separating them would ship either a requirement with no writer (breaking every approval)
or a writer with no requirement (the gap this closes).

### What this unit delivers

- **Two commands, on the canonical lock order.** `consultations.request` and
  `consultations.respond` take readiness key → `Project` → `Membership` → `Decision`. That is
  APPROVAL's order, not a tidier one: `decisions.approve` locks the named decider's membership
  before updating the decision row, so when the consultee IS the decider — an ordinary case — a
  decision-first order here would deadlock a live command against a new one.
- **Both commands REQUIRE an `Idempotency-Key`**, refusing without one with a deliberate 400. The
  unkeyed kernel branch reserves no ledger row, and both facts need one; without the refusal the
  write reaches PostgreSQL and surfaces as a 500 where the honest answer is that this command
  needs a key.
- **The route ceilings, widened-and-narrowed.** Asking is `pmc`. ANSWERING admits every role a
  consultee can hold, with the service narrowing to the one named consultee — because a ceiling
  tighter than the eligible set makes `RolesGuard` reject a legitimately named contractor
  consultee before the service's own check can admit them.
- **The audience widening, on both sides.** `decisionVisibleToViewer` gains a consultee arm beside
  the decider arm, and the web store's `selectLogDecisions`/`selectVisibleDecisions` gain the same
  one through the SAME shared predicate. It is a CYCLE test, not a status test: an approval closes
  the thread it ended, and a `requestChange` reopen starts a cycle the old consultation can never
  re-enter. `withdrawn` stays above the line — withdrawal never widens, and a consultation there
  would leak the pmc-only title and reason 4a hides.
- **The P25c projection thread.** `DECISION_INCLUDE` and the live slice both carry the thread and
  the approval-register count, so the ONE serializer feeds live, projection and rebuild alike. The
  audience is a canonical COLUMN, never a payload field, because `rebuildSeed` replays no
  payloads. And a stored PRE-4c DTO is HYDRATED at read time to the empty shape — widening the
  include rewrites no stored JSON, and a catalog bump triggers no rebuild, so a quiet project
  would otherwise serve `source: 'projection'` DTOs with no collection at all.
- **Two push families with claim-time predicates.** Both check PROJECT OPERABILITY first, then
  lock the decision before judging status and cycle. `consultation_requested` additionally drops
  when the consultee has already answered, when the decision has left the open set, and when the
  membership is no longer active; `consultation_responded` drops when the requester has lost
  requesting standing. Every drop is the recorded cancellation mark, never a silent skip.
- **The approval register becomes PROVABLE.** `approve` now reserves a receipt even unkeyed
  (`synthesizeKeyWhenAbsent`, the delivered inventory pattern — legacy semantics preserved
  exactly) and records it on the revision; the new deferred trigger requires that receipt to have
  SUCCEEDED at commit with its `resultRef` naming this decision.

## Two reconciliations with delivered reality

Both are recorded rather than quietly absorbed, because each is a place where the plan's prose and
the merged code disagree and the merged code won.

1. **The ledger command types are `consultations.request` / `consultations.respond`**, breaking
   this module's usual `decisions.*` prefix. The merged 4c-i provenance seal checks those exact
   strings, and that migration is immutable history. The alternative — a manifest name that
   differs from the ledger type — would be two names for one fact, which is the drift the manifest
   exists to prevent. Found by the probe suite failing with the seal's own message, not by reading.
2. **4c-i's upgrade-proof compatibility arm is DELIBERATELY SUPERSEDED.** "A previous-release
   approval still records with no source command" was 4c-i's own claim and was true for 4c-i; this
   unit runs after the drain-first cutover, which is the one moment the plan guarantees no old
   writer exists, so the arm is replaced by the pair that matters afterwards: the bare revision is
   REFUSED, and the shape the real writer produces is ACCEPTED. This follows the 4b precedent the
   same file already records for the option writes 4b moved the goalposts on.

Additionally, the 4c-i retry probe's trigger COUNT is now pinned BY NAME to 4c-i's own nine. The
count was right while 4c-i was the only unit in the family; this unit adds a tenth `%t4c%` trigger
that the retry probe is not about, and naming them is strictly more precise — a missing 4c-i
trigger still fails, and a RENAMED one now fails too, where a count would hide it.

## Pre-review checks (the template's five)

1. `pnpm check` — **EXIT 0**: automation 296/296 (the pg-parse corpus pin 93→94), web 976/976
   across 61 files, API 804/804 across 58 files, lint/typecheck/builds clean.
2. Focused reproduce-first — `test/integration/phase6-t4c-ii-consultation.test.ts` **22/22**
   against live PostgreSQL, traversing the ACTUAL guarded HTTP routes.
3. Full integration battery on a pristine migrated database — recorded in the PR body.
4. `scripts/upgrade-proof.sh` — **PASSED**, with the superseded arm replaced as described above.
5. Tripwires advanced IN THIS UNIT: dispatch sites 82→84 and `decisions.service` 7→9, controller
   routes 7→9 and mutating routes 170→172, the manifest event/command/query/route lists, the
   policy matrix (+2 actions), the boundary route pin, the pg-parse corpus 93→94.

## Invariant matrix (six rows)

| Invariant | Where enforced | Proven by |
|---|---|---|
| Consultation INFORMS and never gates: no status moves, no gate verdict changes | neither command writes `Decision`; both are additive appends | the full suite — every decision status assertion after an ask/answer is unchanged; the register's own approve/withdraw arms still behave identically |
| Only the NAMED consultee answers, exactly once, and only while the question is genuinely open in the cycle it was asked in | the service's re-locked membership resolve + the eligibility assert + the cycle compare, mirrored by 4c-i's INSERT seals at the DB | the non-consultee 403, the second-answer 409, the withdraw-then-answer 409, the approve-reopen-answer 409 with the NEW-question mirror accepted |
| The widening is exactly one way and cycle-bound: a consultee sees THAT decision while their consultation stands, and nothing more | the ONE `viewerIsConsultee` predicate in `decisionVisibleToViewer`, the projection read-path filter and both web selectors | the consultee-sees / same-role-non-consultee-does-not pair; the withdrawn decision staying pmc-only for a consultee |
| Live == projection == rebuild, including for a generation materialized BEFORE this unit | the ONE `serializeDecision` feeding both paths + read-time hydration of a stored pre-4c DTO | the drained-projection equality probe and the stripped-DTO hydration probe (which asserts the EMPTY shape, not a missing field) |
| A queued push never delivers decision content to someone who has lost standing, and never invites an action the server now refuses | both claim predicates: operability first, then the locked decision, then cycle/answer/standing | approve-before-claim cancelled; already-answered cancelled; removed consultee cancelled; archived project cancels BOTH; demoted requester dropped |
| The approval register's COUNT is trustworthy, because a revision is the product of an approval COMMAND | `approve`'s receipt + the deferred provenance trigger | the receipt assertion on a real approval; the bare-revision forgery REFUSED with the open consultation still answerable afterwards; the upgrade proof's accept/refuse pair |

## Ported from the closed parallel PR #496

A second 4c-ii was built independently in another session (#496, branch `claude/phase6-4c-ii`,
same base). JagPat closed it as superseded and kept this PR as the sole open work. Three things it
held that this PR lacked have been PORTED rather than discarded, because each is plan-mandated:

1. **The 4c-i `ProjectCapability` obligation, discharged.** §D (rounds 13/19/21/24) places the
   reservation trigger AND the diagnostic-first abort in 4c-i; the merged `20271101000000` ships
   neither, so the hole is live on `main` — the generic `capability:enable` CLI accepts any string,
   an operator could open the gate today, and the first upgraded instance would emit while old
   workers could still claim. This unit's compatibility story rests on it, so the obligation is
   carried here rather than left to a unit that runs after the risk has passed. Round-24 order:
   the trigger is created BEFORE the audit reads, because `CREATE TRIGGER` takes `ACCESS EXCLUSIVE`
   and an audit that reads first can be overtaken by a concurrent enable. Both doors are sealed
   (INSERT and re-key) and both are hostile-probed, alongside a PRECISION probe proving every other
   capability still enables through the unchanged generic writer — the Board's free-text decision
   is not quietly reversed.
2. **The rollout fence, both halves.** The compiled `catalogVersion` bump on `decisions.inbox` and
   `webpush.notify` (the socket consumer is not bumped — it carries no consultation contract), plus
   the catalog-data migration that arms it: `syncConsumerCatalog` asserts and never updates, so a
   code-only bump would leave the persisted rows behind and abort every upgraded process at
   bootstrap — the fence pointed the wrong way. And `ProjectionGeneration.catalogVersion`, NOT NULL
   with NO DEFAULT, added in three steps with an explicit backfill from the persisted pre-4c-ii
   catalog. That column is the only thing that stops the standalone rebuild CLI, which registers
   consumers directly and never calls sync: a previous release's CLI run would otherwise rebuild
   `decisions.inbox` with the v1 serializer and ACTIVATE it — a register with no thread and no
   widened audience, swapped in by a supported command, at exactly the moment something already
   looks wrong.
3. **Absent-when-empty serialization.** #496's objection is correct: always emitting
   `consultations: []` would add the key to every decision of every project, including the gate-OFF
   ones §D requires to be byte-identical to today. Omitting it when there is no thread satisfies
   both obligations at once and makes a pre-4c projection row byte-EQUAL to live rather than merely
   compatible — which also removes the need for the round-18 hydration step rather than skipping it.
   Probed directly.

**What was NOT taken, and why.** #496's approval-provenance seal is a BEFORE INSERT null-check.
This PR already carries the strictly stronger DEFERRED commit-time binding round 29 requires: the
cited receipt must have SUCCEEDED with its `resultRef` naming this decision. A null-check alone is
satisfied by a receipt left `reserved` and inserted in the same transaction — precisely the shape
round 29 identified, which would advance the cycle without approving anything. Two seals on one
table would be a second answer to one question, so the weaker one is not ported.

**One process note carried across.** #496 recorded that `npx tsc` was resolving a newer TypeScript
that bailed on the tsconfig before compiling, and that `apps/web/tsconfig.json` is a solution file
with `files: []` — both reporting clean while checking nothing. Every gate figure in this packet
comes from `pnpm check` by exit code, which runs the repo's own tooling.

## What this unit does NOT do

- **It does not enable the capability anywhere.** `consultation` stays off on every project; 4c-iii
  is the controlled enablement. The probe suite enables it on its own fixture project only.
- **It does not add the `architect` requester or the `awaiting_countersign` eligibility arm.** Both
  arrive in 4d WITH the role and the status they belong to.
- **It does not perform the drain/reseal.** That is the operational cutover §A specifies and the
  RUNBOOK already documents; this unit's catalog change is what makes it required.
