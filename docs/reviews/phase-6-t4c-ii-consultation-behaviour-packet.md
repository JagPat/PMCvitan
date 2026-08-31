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

1. `pnpm check` — **EXIT 0**: automation 296/296 (the pg-parse corpus pin 93→94), web **985/985**
   across 62 files (+9 for the F4 write-ahead probes), API 804/804 across 58 files,
   lint/typecheck/builds clean.
2. Focused reproduce-first — `test/integration/phase6-t4c-ii-consultation.test.ts` **26/26**
   against live PostgreSQL, traversing the ACTUAL guarded HTTP routes (+4 for the corrections:
   the F1 spent-receipt replay, the F1 partiality arm, the F3 present/absent pair and the F3
   gate-OFF approved arm, the F5 deterministic AB-BA). Plus `apps/web/tests/consultation-write-ahead.test.ts`
   **9/9** for F4, and the adjacent decision suites (`phase6-t4c-i`, `phase2-snapshot-shape`,
   `phase6-t4a-withdraw`, `command-ledger`, `projection-rebuild-upgrade`) **158/158** together.
3. Full integration battery on a pristine migrated database — recorded in the PR body.
4. `scripts/upgrade-proof.sh` — **PASSED**, with the superseded arm replaced as described above and
   three F1 arms added (a SPENT receipt replayed onto a second revision is refused; the register
   still holds exactly one revision for it; legacy NULL-provenance rows still coexist, proving the
   index is partial).
5. Tripwires advanced IN THIS UNIT: dispatch sites 82→84 and `decisions.service` 7→9, controller
   routes 7→9 and mutating routes 170→172, the manifest event/command/query/route lists, the
   policy matrix (+2 actions), the boundary route pin, the pg-parse corpus 93→94.

## Invariant matrix (six rows)

| Invariant | Where enforced | Proven by |
|---|---|---|
| Consultation INFORMS and never gates: no status moves, no gate verdict changes | neither command writes `Decision`; both are additive appends | the full suite — every decision status assertion after an ask/answer is unchanged; the register's own approve/withdraw arms still behave identically |
| Only the NAMED consultee answers, exactly once, and only while the question is genuinely open in the cycle it was asked in | the service's re-locked membership resolve + the eligibility assert + the cycle compare, mirrored by 4c-i's INSERT seals at the DB | the non-consultee 403, the second-answer 409, the withdraw-then-answer 409, the approve-reopen-answer 409 with the NEW-question mirror accepted |
| The widening is exactly one way and cycle-bound: a consultee sees THAT decision while their consultation stands, and nothing more | the ONE `viewerIsConsultee` predicate in `decisionVisibleToViewer`, the projection read-path filter and both web selectors | the consultee-sees / same-role-non-consultee-does-not pair; the withdrawn decision staying pmc-only for a consultee |
| Live == projection == rebuild, including for a generation materialized BEFORE this unit | the ONE `serializeDecision` feeding both paths; absent-when-empty makes a stored pre-4c DTO byte-EQUAL to live rather than merely compatible | the drained-projection equality probe; the stripped-DTO probe asserting the served row carries NEITHER key and its key set matches the live row's exactly |
| A queued push never delivers decision content to someone who has lost standing, and never invites an action the server now refuses | both claim predicates: operability first, then the locked decision, then cycle/answer/standing | approve-before-claim cancelled; already-answered cancelled; removed consultee cancelled; archived project cancels BOTH; demoted requester dropped |
| The approval register's COUNT is trustworthy, because a revision is the product of an approval COMMAND — and each command produces exactly ONE | `approve`'s receipt + the deferred provenance trigger + the one-use partial unique on `(projectId, sourceCommandId)` | the receipt assertion on a real approval; the bare-revision forgery REFUSED with the open consultation still answerable afterwards; the SPENT-receipt replay refused (F1); legacy NULL rows still coexisting; the upgrade proof's accept/refuse pair |

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

   **Recorded honestly: head `d117f140` did NOT do this.** JagPat's direction on this PR was to
   leave the dispute for the reviewer and not reshape the product surface unilaterally, so that
   head shipped the always-emit form with BOTH positions written into `serializeDecision` and this
   section describing the ported one — a real disagreement between packet and code. The reviewer
   settled it in #496's favour (F3), and the correction head implements it, including the
   consequence #496 did not draw: `approvalCycle` must travel WITH the collection rather than on
   its own zero test, because it is non-zero on any approved decision and would otherwise add a key
   to gate-OFF projects by itself.

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

## Review corrections on head `d117f140` (one batched head)

The independent review of `d117f140` returned five findings. All five are corrected in ONE head —
this is the unit's FIRST finding-bearing head, so one further correction head remains before the
replacement rule applies. Every fix was reproduced RED first.

### F1 (P1) — an approval receipt was reusable

The deferred provenance trigger proves the cited receipt exists, belongs to this project, is a
SUCCEEDED `decisions.approve`, and names THIS decision. Every one of those predicates stays true
however many times the same receipt is cited, and `DecisionApprovalRevision` carried no uniqueness
on `sourceCommandId` — so ONE genuine approval was enough to mint arbitrarily many revisions and
inflate the COUNT every open consultation is frozen against. That is the same denial the
forged-revision arm refuses, reached with a real receipt instead of a forged one.

**Fix.** A partial unique index `DecisionApprovalRevision_source_command_key` on
`("projectId", "sourceCommandId") WHERE "sourceCommandId" IS NOT NULL`, added to
`20271115000000` — the exact shape the two consultation facts already carry
(`DecisionConsultation_source_command_key`, `DecisionConsultationResponse_source_command_key`);
the approval register was the one provenance seal of the unit that lacked it. PARTIAL because
4c-i staged the column nullable so a pre-4c approval keeps its honest NULL, and because saying so
in the index definition is better than relying on the reader knowing PostgreSQL treats NULLs as
distinct. Diagnostic-first: a bare `CREATE UNIQUE INDEX` over duplicates fails with PostgreSQL's
own opaque message (the §T45 F3.1 defect), so the offending receipts are NAMED first. That abort
cannot fire on any database today — nothing has ever written a non-NULL `sourceCommandId` — and
exists so the claim is checked rather than asserted; operator repair is `docs/RUNBOOK.md §P6-4C`.

**Migration handling.** `20271115000000` is edited IN PLACE rather than followed by a third
migration. It is unmerged, belongs to this same unit, and has never been applied outside CI's
throwaway service containers and local scratch databases — the "byte-for-byte unchanged" discipline
protects migrations that have LANDED, and splitting one unit's single seal across two files to
honour it against an unmerged file would make the artifact worse, not safer.

**Probes.** A spent receipt replayed onto a second revision is refused with `23505` naming
`("projectId", "sourceCommandId")` — asserted by the constraint that actually fires, not by the
index name a driver may or may not echo — with the register still holding ONE approval and the
consultee's late answer still refused for the RIGHT reason. Plus a partiality probe: two legacy
NULL-provenance revisions still coexist. RED before the index (verified by dropping it and
re-running), GREEN after.

### F2 (P1) — a barrel import cycle

`ConsultationThread.tsx` imported `Button` from `@/components`, the same barrel that exports
`ConsultationThread` — an `index → ConsultationThread → index` cycle. Fixed to the leaf module
`./Button`, the convention `LocationPicker` already follows (the only other component in that
directory importing a sibling).

### F3 (P2) — the DTO emitted the consultation keys unconditionally

Settled as described under "Ported from #496" above, with one addition the finding forced into the
open: `approvalCycle` cannot be hidden behind a zero test, because the approval register exists for
every project and any approved decision has a non-zero cycle. It therefore travels WITH the
collection — a decision with no thread emits neither key, which is what makes §D byte-identity
total rather than approximate. `hydrateStoredDecisionDto` correspondingly stops backfilling the two
fields (it now handles `deciderKind` only): under absent-when-empty a stored pre-4c DTO and a live
serialization of a consultation-free decision are ALREADY identical, and adding `consultations: []`
would make the projection answer DIFFER from live for exactly the quiet projects the hydration
exists to protect — the equality defect inverted rather than fixed.

Three probes: the stripped stored DTO is served with neither key and with a key set equal to the
live row's; a decision that gains a thread carries both keys with the cycle as the comparand; and
the sharpest arm — a gate-OFF project's APPROVED decision (register genuinely advanced) gains
neither key. The two `phase6-t4a-withdraw` comparisons drop their now-wrong 4c normalization, and
the `phase2-snapshot-shape` contract note is rewritten to describe what is actually emitted.

### F4 (P1) — the consultation commands were not write-ahead

Both store actions used `runRemoteOrQueue`, which persists only when OFFLINE and, when online,
mints the idempotency key in memory and fires a bare call. For an append-only FACT that is the
wrong shape: a lost or uncertain response strands the command together with its key, and the only
recovery a user has is to ask again — which arrives under a DIFFERENT key and appends a SECOND
consultation to a thread that is permanent by design. Both now take `runWriteAhead`.

`apps/web/tests/consultation-write-ahead.test.ts` (9 probes, both commands): a lost online response
retains the op and the retry transmits the IDENTICAL key; a reload re-hydrates the op with its key;
confirmed success removes it exactly once; offline it waits and syncs under the same key; blank
evidence records nothing at all. Four of the nine FAIL on the reviewed head's shape (verified by
reverting the two call sites and re-running).

### F5 (P1) — the claim paths inverted the canonical 4c lock order

Both push-claim predicates read the `Decision` row `FOR SHARE` and only then locked the
consultee's (or requester's) `Membership`. Approval takes the opposite order — readiness key →
`Membership` → update `Decision` — so when the push target is also the named decider the two
transactions hold exactly what the other waits for and PostgreSQL must abort one side.

**Fix.** Both paths now lock MEMBERSHIP before DECISION. In the requested family the unlocked
consultation lookup is demoted to choosing WHICH membership to lock — it decides nothing — and
every predicate the verdict rests on (status, cycle, standing, answered-ness) is re-read under the
decision lock afterwards, so nothing is judged on an unlocked read.

**Probe.** A deterministic AB-BA reproduction, not a timing loop: a dedicated session takes the
membership lock an in-flight approval would hold and signals from INSIDE its transaction (a Prisma
interactive transaction starts asynchronously — dispatching both and hoping is a race, not a
probe); the claim is dispatched and OBSERVED waiting on that lock via `pg_stat_activity`,
condition-based, never a sleep; the holder then takes `Decision FOR UPDATE`, which must SUCCEED
while the claim is still pending — it can only be granted if the claim holds no `FOR SHARE` on
that row, which IS the ordering. Run against the reviewed head's order (both reads moved back
above their locks) the probe fails with PostgreSQL's own `40P01 deadlock detected`. Both families
are covered.

## What this unit does NOT do

- **It does not enable the capability anywhere.** `consultation` stays off on every project; 4c-iii
  is the controlled enablement. The probe suite enables it on its own fixture project only.
- **It does not add the `architect` requester or the `awaiting_countersign` eligibility arm.** Both
  arrive in 4d WITH the role and the status they belong to.
- **It does not perform the drain/reseal.** That is the operational cutover §A specifies and the
  RUNBOOK already documents; this unit's catalog change is what makes it required.
