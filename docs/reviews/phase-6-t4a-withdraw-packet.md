# Phase 6 unit 4a — `decisions.withdraw` (implementation packet)

- **Plan:** `docs/superpowers/plans/2026-08-13-decision-workflow.md` §A (merged PR #335, `main` `27c484b`; the flip PR #336, `main` `4664da3`)
- **Base:** `4664da3` · **Branch:** `claude/phase6-task4a-withdraw`
- **Staged-red commit (the probes' honest baseline):** `afcf611` — the SHAPE (enum value, evidence columns, seals migration, widened shared types, notice helpers, probe files) with every behavior deliberately absent, per the `2026-08-12-nested-locations.md` §D staging discipline.

## Vision alignment

One user workflow: the PMC takes back a wrongly-published decision — the owner's live defect
(`docs/STATUS.md` task 4; task #62). The design is plan §A verbatim: attributable, reasoned,
TERMINAL `withdrawn` kept as register history; the client's pending surfaces clear by themselves
(status-derived); the pending bell notice is retired (a stale approval demand is a false
instruction, not history); a queued `decision.published` push is cancelled by subject so a lagging
relay cannot announce a decision every surface has since hidden; and the audience never widens —
a withdrawn decision reaches no one but the pmc. One fact, one owner: the decision row carries the
withdrawal evidence, the `DecisionEvent` register carries the explanation, the platform outbox
carries only its own cancellation mark.

## Review unit

<!-- review-size: justified-large -->
**Justified-large** (round 2, Codex F3 — the marker belongs HERE with the matrix, not only in
the PR body): the diff exceeds 20 files / 1,500 lines because the plan's §F pre-authorizes it —
"a status is an interface; the breadth IS the correctness", and the enum and its readers are
indivisible (a SHARED `DecisionStatus` whose web `as const` maps are the very §A.3 readers), so
the split line cannot run between API and web. The pre-declared enum-independent split was
available and not needed. All six invariant-matrix rows are complete below.

- The `withdrawn` enum value + write-once evidence columns (`withdrawnAt`/`withdrawnById`/
  `withdrawnByName`/`withdrawReason`) with a Membership-backed attribution FK.
- `DecisionsService.withdraw` on the standard command spine (`resolveActor → hashRequest →
  peekReplay → executeCommand`), under `lockProjectReadiness` (by class: a decision-status
  writer), CAS from published-`pending` only, with the notice retirement (stamp-based +
  multiplicity-guarded legacy text shape), the appended pmc-only withdrawal notice, and the
  same-tx push cancellation.
- The two neighbour repairs plan §A names: `publish` gains its missing CAS (P7), and `approve`
  validates `prior ∈ {pending, change}` BEFORE its CAS so a stale replay against a withdrawn
  decision is a deliberate 409 with no side effects (P3).
- The reader closure (§A.3): `deriveDecisionReading` honest withdrawn branch;
  `decisionVisibleToViewer` pmc-only arm; the serialized DTO carries the evidence (P14 pins the
  API response); snapshot notice stripping via `isWithdrawnDecisionNotice`; web selectors, chip
  maps, register UI, store action + durable outbox op.
- The platform half (§A.4): `OutboxDelivery.subject` stamped at materialization (+ backfill for
  pre-4a undelivered `decision.published` rows), the narrow tx-scoped
  `cancelQueuedPushBySubject` (cancelled and recorded, never deleted; not a new status value),
  and the sender's final pre-send re-check of its own row in `dispatchExternal` — covering both
  the relay and the immediate dispatcher, which funnel through `dispatchOne`.
- ONE additive, diagnostic-first, RERUNNABLE-BY-DESIGN migration
  (`20270810000000_phase6_t4a_withdraw`).

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | the withdrawal (title + reason) leaking to roles that never saw the decision; a forged withdrawer | P5 (route policy, real per-role members), P10 (row + notice invisible to client/contractor/engineer/consultant at the serializer AND the snapshot HTTP read), P8 (the Membership FK refuses a ghost actor); upgrade-proof forged-member rejection |
| civil-time-lifecycle | none — no civil-date arithmetic; `withdrawnAt` is evidence, not scheduling | n/a |
| concurrency-idempotency | double withdraw; double publish; withdraw racing a hostile approval-revision insert; keyed replays | P6 (exactly one winner), P7 (publish CAS), P8 both barrier orderings (pg_stat_activity condition-gated, exactly one side commits), P1 (replay appends nothing) |
| data-integrity-conservation | a resurrected or re-attributed withdrawal; entry from an approved decision (incl. the PR-#192 legacy approved-with-empty-register class); an approval recorded after withdrawal; a stale queued push announcing a hidden decision | P8 (terminal + freeze + coherence + both never-approved arms), P10 push orderings (claim-after-withdraw; cancelled-during-lease), upgrade-proof (9 hostile rejections + the coherent acceptance + the subject backfill) |
| offline-reconciliation | the withdraw op replaying twice or losing its reason | P14 web half (fresh key per action, persisted op replays under the SAME key exactly once, the reason travels with the op) |
| ui-server-parity | the web selectors leaking what the server hides; a WITHDRAWN chip with no API data behind it | P10 selector mirror (the negative-filter leak fixed), P14 (DTO evidence + rendered register + action gating), P13 (live == projection == rebuild) |

## Design deltas from plan §A — each named, none silent

1. **`withdrawnByName` (denormalized display identity).** §A.5 requires the serialized decision
   to carry "the withdrawer's display identity"; §A.6 lists three evidence columns. Resolving the
   name by JOIN at serialize time would break P13: the projection stores the serialized DTO and
   refreshes only on `decision.*` events, so a later user rename would split live from projection.
   The name is therefore FROZEN at withdraw time as a fourth evidence column — the exact
   `Decision.approver` / `Activity.completionRequestedByName` precedent — and joins seal 1's
   freeze and seal 2's coherence (evidence is evidence).
2. **Trigger names encode firing order** (`Decision_t4a_a_terminal` / `_b_entry` /
   `_c_coherent`): PostgreSQL fires same-event triggers in name order, and without this a
   transition out of `withdrawn` would be refused by the coherence trigger with an
   evidence-shaped message instead of the terminal seal's.
3. **The stamped-notice retirement deletes ALL notices stamped with the decision**, not only
   pending-shaped ones: eligibility (never approved — service belt + DB seal) proves the only
   stamped notices a withdrawable decision can carry ARE its pending notices.
4. **Two web probes are GREEN at the staged baseline by design** (`selectPending`/
   `selectReapproval`/action-items and the nav badge): they assert the plan §A.3 rows that read
   "drops it automatically — asserted by probe, not assumed". They are invariant assertions, not
   defect reproductions; the LEAK probe (the register selector's negative filter) was properly red.
5. **P8's red was captured on the stage-1 shape with the four seals DROPPED on the scratch DB.**
   The staged commit legalizes the fixture (the enum + columns must exist for the hostile SQL to
   be well-formed); the dropped-seal database is the §E-named defect state ("the three triggers
   absent — hostile SQL accepted"). The seals were restored by re-running the migration file —
   which is rerunnable by design, and that property is itself proven again in the upgrade proof.

## Probes (plan §E) — staged RED at `afcf611` → GREEN at this head

API: `apps/api/test/integration/phase6-t4a-withdraw.test.ts` — **21 probes, 21/21 RED at the
staged baseline** (route 404s; `svc.withdraw` absent; the publish double-stamp; hostile SQL
accepted with the seals dropped; the selector/serializer/notice leaks; the queued push delivered)
→ **21/21 GREEN**. Web: `apps/web/tests/decision-withdraw.test.tsx` — **8 probes, 6/8 RED**
(the two greens are delta 4 above) → **8/8 GREEN**.

| probe | result |
|---|---|
| P1 command + evidence + register event + appended notice; keyed replay appends nothing; the emitted `decision.withdrawn` intent is invalidate-only (P12's runtime half) | GREEN (red: 404) |
| P2 draft refused 409 | GREEN (red: withdraw absent) |
| P3 approved/change refused naming the change request; stale approve vs withdrawn = deliberate 409, zero side effects | GREEN (red: withdraw absent / approve guard absent) |
| P4 blank / whitespace-only / absent reason = 400 at the contract | GREEN (red: 404 not 400) |
| P5 four roles 403 as REAL members (the policy, not a membership mismatch); pmc succeeds | GREEN (red: 404 for pmc) |
| P6 two concurrent withdraws admit exactly one; single event/notice | GREEN (red: withdraw absent) |
| P7 double publish admits exactly one | GREEN (red: both succeeded / double side effects on the plain update) |
| P8 terminal; evidence freeze; coherence (unattributed, whitespace-only reason, forged FK actor, orphaned evidence, born-withdrawn); never-approved BOTH arms incl. the legacy approved-with-empty-register class; the reverse-arm barrier race in BOTH orderings, exactly one side committing | GREEN (red: hostile SQL accepted with seals dropped on the staged shape) |
| P9 countPending drops the decision | GREEN (red: withdraw absent) |
| P10 row + notice invisible to every non-pmc role (serializer + snapshot HTTP); pending notice retired (stamp; legacy text shape; the ambiguous-title guard leaves rows + reports in the register event); queued push: claim-after-withdraw finds the intent cancelled-and-recorded, cancelled-during-lease dropped by the pre-send re-check with the push service provably never invoked; the check→send residual is the DOCUMENTED §A.4 boundary, asserted as documentation | GREEN (red: withdraw absent; selector leak red in the web half) |
| P11 `deriveDecisionReading('withdrawn')` = `wait` + "The linked decision was withdrawn — re-issue or relink"; a gated activity refuses to start with that reason | GREEN (red: the else-branch's "Awaiting the client's approval") |
| P12 catalog membership end-to-end: shared `DOMAIN_EVENT_TYPES`, `EXTERNAL_EFFECTS` (invalidate-only), manifest `producesEvents`, `DECISION_COMMANDS`, the manifest⇄contract equality and catalog-membership unit pins | GREEN (the unit pins were RED against the stale lists and advanced in this diff) |
| P13 live == projection == rebuild across a withdraw on a fresh project; the rebuild emits zero events | GREEN (red: withdraw absent) |
| P14 web: fresh key per action; ONE op carrying the reason; replay under the persisted key exactly once; blank reason never dispatches; the API response carries `withdrawnAt`/`withdrawnBy`/`withdrawReason` (pmc-only); the register renders the evidence; the action offered only to pmc on an eligible row; an engineer render shows no withdrawn row | GREEN (red: op/action/render absent; the DTO carried no fields) |

The effect-coverage re-seal is OPERATIONAL by construction: `effectCoverageVersion()` is a
SHA-256 over the canonical catalog, pinned at `outbox.bootstrap.ts` (outbox mode refuses a stale
seal) and re-derived in `external-effects.test.ts` — the new `decision.withdrawn` entry changes
the version, and the catalog-membership tests pin the entry itself.

## Gates

- `pnpm check` **EXIT 0** (scripts guards 207/207; API unit suites incl. the advanced tripwires;
  web lint + typecheck + tests + build).
- Focused integration: `phase6-t4a-withdraw.test.ts` **21/21** on the migrated test DB.
- Adjacent integration: `decisions-projection`, `command-ledger`, `schema-migration-drift`,
  `global-route-authz`, `event-catalog`, `start-readiness-race` — **35/35**.
- Web focused: `decision-withdraw` 8/8, `policy` + `changeControl` with it — **22/22**.
- `upgrade-proof.sh` **PASSED**, extended with the 4a section: the legacy DB upgrades ROW-FREE
  with all four triggers + the FK installed; a COHERENT withdrawal is ACCEPTED (the seals are
  precise, not blanket); NINE hostile forgeries rejected (terminal exit, evidence rewrite,
  unattributed entry, whitespace-only reason, forged member, orphaned evidence, the legacy
  approved-with-empty-register rewrite, born-withdrawn, revision-after-withdrawal); and the
  SUBJECT BACKFILL is proven by planting a pre-4a subjectless undelivered `decision.published`
  push and RE-RUNNING the migration file (also proving rerunnable-by-design end-to-end).
- The FULL integration battery is delegated to the required `api` CI check (the standing
  container-restart constraint on local full runs).

## Tripwires advanced in this diff

§A lock-coverage `SECTION_A_COMMANDS` 37→38 (`decisions.withdraw`); external-effect dispatch
sites 80→81; mutating routes 167→168 with the decisions controller's ordered signature pin;
manifest⇄contract equality (`decision.withdrawn` + `decisions.withdraw` + the route); the
registry unit pin on the push delivery's `subject`; the web `ROLE_POLICY` matrix pin
(`decision.withdraw: ['pmc']`); the decisions service unit harness (CAS-aware `updateMany`
stand-in + the stamped-notice pin).

## Round 1 — the five Codex P2 findings on head `ea3391d`, each reproduced RED before its fix

One batched corrective head. Reproduce-first: F1/F3/F4/F5 as new probes in
`phase6-t4a-withdraw.test.ts` (`round 1` describe — 4/4 RED at the finding head → GREEN); F2 as a
new upgrade-proof STAGE (RED: the proof run against the finding head's migration exits 1 with
"the migration ACCEPTED a withdrawn row with no evidence" → GREEN: the abort names the row).

| # | finding | fix |
|---|---|---|
| F1 | the relay RECOVERY scanner (`expandMissingDeliveries`) re-created crash-gap delivery rows copying only `payload` — a recovered `decision.published` push was born `subject = NULL`, unreachable by cancel-by-subject | the scanner persists `plan.subject` exactly like the emit-time materializer; probed end-to-end (delete the delivery → recover → subject present → withdraw cancels it) |
| F2 | the migration's diagnostics were GATED on the evidence columns existing, so a partial/manual apply (enum value + a withdrawn row, no columns) slid through and gained NULL evidence the seals never judge | the additive shape (enum value + four nullable columns — nothing enforced, nothing edited) installs FIRST and the diagnostics run UNCONDITIONALLY after it, aborting before any SEAL installs; proven by a new upgrade-proof stage that plants exactly that state, sees the named abort, repairs, and lets the real apply proceed |
| F3 | cancellation touched only `pending`/`leased` rows — a `dead` push redriven by an operator would resurrect the stale announcement | the mark reaches `dead` rows too (status kept — the dead history stands); probed: withdraw marks the dead row, a redrive to `pending` is dropped by the pre-send re-check with the push service provably never invoked |
| F4 | an org owner/admin operating as pmc WITHOUT a project membership (the project-access super-admin path) hit the attribution FK and rolled back with a raw error | the `activities.complete` precedent verbatim: the membership row is read LOCKED in the withdraw transaction and a missing/inactive membership refuses with an answer (400 naming the constraint and the escape) before any side effect |
| F5 | the baked readiness reason ("The linked decision was withdrawn…") leaked the withdrawal to roles that cannot see withdrawn decisions | `deriveDecisionReading` takes `withdrawnReasonVisible` (FAIL-CLOSED: an unlabelled caller gets the redacted wording) threaded viewer-aware through the snapshot bake, the module GET, `activities.start`'s refusal (follows the STARTER), and the web demo derivation; non-pmc viewers read "Awaiting the PMC on the linked decision" — same verdict, same next step, no disclosure |

Round-1 gates: probe file 25/25 (incl. the 4 new); `pnpm check` EXIT 0; `upgrade-proof.sh` PASSED
with the F2 stage; the full integration battery re-run on the corrective head.

## Round 2 — the four Codex findings on head `1fb4e54` (1×P1, 3×P2), one batched head + the owed convergence audit

The second finding-bearing head: the architectural audit is `docs/reviews/pr-337-convergence.md`
and the correction commit carries `Review-Convergence: complete`.

| # | finding | fix |
|---|---|---|
| R2-F1 (P2) | the diagnostics scanned only `status='withdrawn'` rows — a partial apply that already added the columns could leave ORPHAN withdrawal evidence on a pending/approved row, which future-write triggers never revisit | a third unconditional diagnostic aborts on any NON-withdrawn row carrying any withdrawal evidence; proven by a new proof stage planting exactly that state (RED: the round-1 migration ACCEPTED it → GREEN: the named abort, repair, real apply) |
| R2-F2 (P2) | the seals did not require/freeze `publishedAt` — hostile SQL clearing it on a withdrawn row dropped the permanent record into the draft filter's author-private arm, hiding it from the pmc register | seal 2 requires `publishedAt IS NOT NULL` with the status; seal 1 freezes it on a withdrawn row; a fourth diagnostic quarantines pre-existing violations; probed (hostile clear refused; the pmc slice keeps the row) |
| R2-F3 (P1) | the PACKET lacked the `justified-large` marker (it was only in the PR body) | the marker + justification added to the packet's Review unit beside the complete matrix |
| R2-F4 (P2) | the subject backfill covered `pending`/`leased` only — a pre-4a DEAD push stayed subjectless, so a post-deploy withdrawal could not mark it and an operator redrive would send the stale announcement | `dead` joins the backfill; the proof's backfill plant gains a dead row and asserts both subjects |

Round-2 gates: probe file 26/26; `upgrade-proof.sh` PASSED with both new stages; `pnpm check`
EXIT 0; the api CI battery on the corrective head.

## Round 3 — the three Codex P2 findings on head `74af426`, one batched head

The third finding-bearing head: the convergence audit's head table and closing enumeration are
extended in `docs/reviews/pr-337-convergence.md`, and this correction commit again carries
`Review-Convergence: complete`. Reproduce-first: R3-F1/R3-F3 as new probes in
`phase6-t4a-withdraw.test.ts` (`round 3` describe — 2/2 RED at `74af426` → GREEN); R3-F2 as the
new raw-`Membership` ratchet in `cross-module-graph.test.ts` (RED at `74af426`: the decisions
service is flagged as a raw reader outside the owner → GREEN).

| # | finding | fix |
|---|---|---|
| R3-F1 (P2) | the terminal seal fired only on UPDATE — hostile SQL that cleared the children could DELETE a withdrawn row, erasing the write-once register entry | seal 1 gains its DELETE arm (`Decision_t4a_d_no_delete`, BEFORE DELETE — fires before FK evaluation, so the refusal never depends on surviving children); a non-withdrawn decision stays deletable (precision probed); the two destructive resets that wipe decisions (seed; the t4a suite cleanup) disable the named trigger under the same sanctioned contract as their DomainEvent TRUNCATE; upgrade-proof adds the hostile DELETE rejection and pins the trigger installed |
| R3-F2 (P2) | the round-1 attribution fix put a raw orgs-owned `Membership` read inside the decisions service — an UNDECLARED synchronous decisions→orgs edge (orgs already depends on decisions) | the OWNER answers: `OrgsParticipant.lockActiveMembership` (attribution, not authority — deliberately no org arm, because the FK needs a `Membership` row to bind) called in the withdraw transaction; `decisions.workflowParticipants` declares `orgs` (cycle-exempt channel, pinned in module-registry); a new cross-module-graph RATCHET pins raw `Membership` SQL to the orgs module plus the three pre-existing legacy sites (activities.complete / requirements.responsible / inspections.assign — the very precedent the withdraw check copied), so the list can only shrink and a new raw read fails immediately; routing the legacy trio through the owner is tracked maintenance work |
| R3-F3 (P2) | a `decision.published` event with NO delivery row yet (the rolling-deploy/crash gap the recovery scanner repairs) made the withdrawal's cancel match zero rows — a later recovery pass materialized the missing push as PENDING and sent the stale announcement | the cancellation materializes the missing row ITSELF, already cancelled (`succeeded`/`noop`, `cancelledAt`, subject; no payload was ever built — the durable dispatch intent stays on the event row): one set-based `INSERT … SELECT … NOT EXISTS … ON CONFLICT DO NOTHING` over the platform's OWN tables, complete by ordering (publication precedes withdrawal, so every event the arm must cover exists when it runs), single-winner against a concurrent scanner in both orders via the `(eventId, consumer)` unique; recovery itself stays domain-blind — the DOMAIN closes the gap at the only moment it knows the announcement went stale; the tombstone counts in the withdrawn event's `pushIntentsCancelled`; declared as the third raw-write waiver (own-module write, delegate-inexpressible statement) |

Round-3 gates: probe file 28/28 (incl. the 2 new); the ratchet + registry/graph pins GREEN;
`pnpm check` EXIT 0 (web 760/760, API 791/791); `upgrade-proof.sh` PASSED with the delete-arm
rejection; the full integration battery via the required `api` CI check.

## Round 4 — the four Codex P2 findings on head `31f3fba`, one batched head

The fourth finding-bearing head (`e759832`/`31f3fba` are one tree; the re-push placed the
`Review-Convergence: complete` trailer in the commit's final trailer block, where git parses
it). The convergence audit's head table, root analysis and closing enumeration are extended
again, and this correction commit carries the trailer. Reproduce-first: R4-F1/R4-F2/R4-F3 as
new probes in `phase6-t4a-withdraw.test.ts` (`round 4` describe — 3/3 RED at `31f3fba` →
GREEN, the F3 interleave under a deterministic pg_stat_activity barrier); R4-F4 + the F2
hostile update as upgrade-proof stages (RED at `31f3fba`: the moved register entry was refused
only by the FK — which a destination membership defeats — and the pre-withdrawn pushes stayed
uncancelled → GREEN).

| # | finding | fix |
|---|---|---|
| R4-F1 (P2) | during a migration-first rolling deploy an OLD API instance materializes a `decision.published` push AFTER the one-time backfill, writing `subject = NULL`; the subject-keyed cancel misses it and the tombstone is suppressed by the existing `(eventId, consumer)` row — the stale push survives | each cancellation pass first STAMPS the subject onto any matching-event row that lacks it (copied from the row's OWN event identity, never invented), and the status arms then see it — pending is neutralized, leased/dead marked; probed by nulling a materialized row's subject and asserting stamp + neutralize + the `pushIntentsCancelled` count |
| R4-F2 (P2) | the terminal seal froze the withdrawal evidence but not the row's PROJECT identity: hostile SQL could re-point `projectId` at another project where the withdrawer holds an active membership — the FK passes while the permanent record vanishes from the original project's register | `projectId` joins the write-once set in `phase6_t4a_withdrawn_terminal` (round-4 arm); probed with a real destination membership so the RED capture demonstrates the FK alone did NOT refuse; upgrade-proof adds the hostile move rejection by the named rule |
| R4-F3 (P2) | a recovery-scanner row COMMITTING between the cancellation's update passes (which cannot see it) and the tombstone insert (which resolves to its handled conflict) survives as `pending` with `cancelledAt = NULL` — the next relay pass sends the stale push | the stamp+neutralize+mark passes RUN AGAIN after the tombstone insert: a row that landed in the window is committed and visible by then and is neutralized; a row landing after the insert executed blocks on the in-flight unique conflict and resolves to the scanner's handled P2002 after the cancelling transaction commits — every interleaving ends cancelled-or-never-created, proven by a deterministic two-session barrier (the scanner's create held open, the cancellation provably BLOCKED on it via pg_stat_activity before release) |
| R4-F4 (P2) | a decision ALREADY withdrawn when the migration runs (the coherent partial/manual-apply shape the diagnostics deliberately accept) will never see a future `decisions.withdraw` command — the backfill stamped its old pushes' subjects but nothing ever cancelled them, so a relay pass or operator redrive could still send the stale approval request | the migration performs the command's cancellation itself for already-withdrawn subjects, with the command's exact semantics (pending → neutralized in place, payload preserved; leased/dead → marked only), compared as `::text` (vacuous on a first apply — no row can hold the value), idempotent via the `cancelledAt IS NULL` guard; upgrade-proof plants pending+dead pushes about the withdrawn `UP4A-D1` and asserts cancellation after the re-run, plus the PRECISION assert that the live decision's pushes stay uncancelled |

Round-4 gates: probe file 31/31 (incl. the 3 new); `pnpm check` EXIT 0 (API 791/791 across 57
files; web unchanged); `upgrade-proof.sh` PASSED (558 assertions — the two new round-4 stages
and every prior rejection); the full integration battery via the required `api` CI check.

## Round 5 — the two Codex P2 findings on head `b24d36e`, one batched head

The fifth finding-bearing head (the orchestrator's review-lifecycle limit). Both findings are
deployment-harness completions of rounds 3–4's arms — neither touches runtime behaviour: the
MIGRATION must carry every arm the runtime cancellation carries (round 5 adds its last one,
the recovery-gap tombstone), and the destructive seed's wipe order must respect the FK graph
the withdrawal evidence joined.

| # | finding | fix |
|---|---|---|
| R5-F1 (P2) | the round-4 migration cancellation only UPDATEs delivery rows that EXIST — an already-withdrawn decision's `decision.published` event sitting in the recovery gap (no `webpush.notify` row at all) got no tombstone, so the next relay recovery pass would materialize it PENDING and no future `decisions.withdraw` command exists to cancel it | the migration writes the same cancelled tombstone the runtime cancellation writes (succeeded/noop, `cancelledAt`, subject from the event's own `entityId`, no payload), catalog-guarded, idempotent via NOT EXISTS + ON CONFLICT DO NOTHING; a LIVE decision's gap event is deliberately untouched — recovery legitimately owes it a pending delivery; upgrade-proof plants BOTH gap events (about the withdrawn `UP4A-D1` and the live `UP4A-D2`) and asserts tombstone-for-withdrawn + no-tombstone-for-live (RED at `b24d36e` → GREEN, 560 assertions) |
| R5-F2 (P2) | the round-3 seed bypass sat at the decision wipe's ORIGINAL position — AFTER `membership.deleteMany()`, which the new `Decision.withdrawnById → Membership(projectId,userId)` ON DELETE NO ACTION FK now refuses while a withdrawn decision exists, so a post-withdrawal database could not be reseeded at all | the guarded decision wipe moves ahead of the membership wipe (every Decision child is already cleared above it); reproduced by running the REAL seed against a database holding a withdrawn decision — RED at `b24d36e` (P2003 on `Decision_projectId_withdrawnById_fkey` at `membership.deleteMany`, scratchpad `r5-seed-red.log`) → GREEN over the same failed state (`r5-seed-green.log`); a durable source-order pin in the probe file (RED at `b24d36e` → GREEN) keeps the ordering from regressing |

Round-5 gates: probe file 32/32 (incl. the ordering pin); `pnpm check` EXIT 0 (web 760/760,
API 791/791); `upgrade-proof.sh` PASSED — **560 assertions** incl. the two new round-5 stages;
the full integration battery via the required `api` CI check.

## Round 6 — the four Codex P2 findings on head `2e15eba`, one batched head

The sixth finding-bearing head — past the orchestrator's advisory review-lifecycle limit. The
unit stays whole deliberately: plan §F pre-authorizes it (the enum and its readers are
indivisible), these findings are again the enumeration's TAIL (a diagnostic completion, a
deployment-model boundary, one web selector class, one harness hardening — none touch the
command, the seals' semantics, or the §A.4 runtime arms), and a split now would separate the
readers from the status they read. Codex's attempt-2 review arrived 43s AFTER the orchestrator's
timeout verdict; the findings are treated as the review of record for `2e15eba` and this head
answers them — a new head restarts the loop, mooting the stale timeout status.

| # | finding | fix |
|---|---|---|
| R6-F1 (P2) | the diagnostics accepted a pre-existing withdrawn row whose approval evidence is the LEGACY class — an EMPTY `DecisionApprovalRevision` register but `approved`/`reapproved` `DecisionEvent` rows and/or the approval columns (the PR-#192 backfill shape); the entry trigger cannot recover a hand-flipped source status, so the seals would install around an approval-bearing withdrawn decision | a fifth unconditional diagnostic quarantines any withdrawn row carrying `approvedById`/`approver`/`approvedOption` OR an approved/reapproved event; upgrade-proof stage (the plant passes every OTHER diagnostic and holds a REAL membership so nothing aborts incidentally): RED at `2e15eba` — the migration fully ACCEPTED the row — → GREEN, abort by the named diagnostic (561 assertions) |
| R6-F2 (P2) | mixed-version senders: an OLD relay process (no pre-send re-check) holding a lease sends the stale push regardless of the mark | the finding's own first remedy, made concrete: the DEPLOYMENT model is the gate — this platform deploys as one service whose old process stops before `migrate.sh` runs and the new process starts, so no pre-4a sender is alive by the first moment `decisions.withdraw` exists; stated in the §A.4 boundary (`cancellation.ts` docstring) and operationalized as `docs/RUNBOOK.md §P6-4a` (do not overlap pre/post-4a processes for this one rollout); if ever run multi-instance, the exposure is bounded to the one 4a rollout window — the same already-sent class as the accepted check→send residual |
| R6-F3 (P2) | not every web reader went through `selectLogDecisions`: the Site Map (`PlacesScreen`) — and, same class, the Schedule/Daily-Log pickers and Portfolio — filtered `s.decisions` ad hoc, so a persona switch over a still-loaded store (or demo mode, which never refetches) rendered a withdrawn decision's title/location to roles the server filters it from | ONE shared audience rule `selectVisibleDecisions` (withdrawn is pmc-only; drafts excluded) with all four screens routed through it; the two PICKERS additionally exclude withdrawn for EVERY role — a terminal decision is not linkable/matchable; web tests RED at `2e15eba` → GREEN: the selector behaviour per role + a `?raw` source pin that the four screens contain no ad-hoc `s.decisions` row filter |
| R6-F4 (P2) | the seed's disable → wipe → enable trio was three independent round-trips — a wipe that throws leaves `Decision_t4a_d_no_delete` DISABLED, weakening the write-once evidence outside the sanctioned reset | the trio is ONE `prisma.$transaction`: PG DDL is transactional, so any failure rolls the DISABLE back with it — no failure path can leave the seal off; the probe file's ordering pin gains the atomicity assertion (one transaction, no awaited statement between open and re-enable), RED at `2e15eba` → GREEN |

Round-6 gates: probe file 33/33; web `decision-withdraw` 10/10; `pnpm check` EXIT 0 (web
762/762, API 791/791); `upgrade-proof.sh` PASSED — **561 assertions** incl. the R6-F1
plant/abort stage; the full integration battery via the required `api` CI check.

## Round 7 — the two Codex P2 findings on head `fbe760d`, one batched head

The seventh finding-bearing head. Both findings are ENTRY-TRANSITION twins of arms already
sealed on other paths — the same coat, one transition earlier: a freeze that guards an
already-withdrawn row must also guard the single statement that CREATES the withdrawn state.

| # | finding | fix |
|---|---|---|
| R7-F1 (P2) | the round-4 projectId freeze fires only when `OLD.status` is already `withdrawn` — ONE statement could flip a published pending row to `withdrawn` AND move `projectId` to a project where the withdrawer holds a membership; entry/coherence/FK all pass and the permanent record vanishes from the original register | the ENTRY arm (`phase6_t4a_withdraw_entry`) refuses `NEW.projectId IS DISTINCT FROM OLD.projectId` on the pending→withdrawn transition; probed with a real destination membership (RED at `fbe760d`: the move succeeded) and an upgrade-proof hostile rejection |
| R7-F2 (P2) | the entry guard judges the OLD row and the register — a single statement could ADD `approvedById`/`approver`/`approvedOption` while entering withdrawal, and the terminal freeze covers only the withdrawal columns, leaving a terminal row carrying the approval contradiction the seals exist to make unrepresentable | the COHERENCE seal (`phase6_t4a_withdrawn_coherent`) refuses approval signals on EVERY withdrawn NEW row — entry and any later write to an already-withdrawn row alike (probed both ways; RED at `fbe760d`), mirroring in trigger form the same signals the round-6 diagnostic quarantines in pre-existing data; upgrade-proof hostile rejection added |

Round-7 gates: probe file 35/35; `pnpm check` EXIT 0 (web 762/762, API 791/791);
`upgrade-proof.sh` PASSED — **563 assertions** incl. both round-7 rejections; the full
integration battery via the required `api` CI check.

## Round 8 — the four Codex P2 findings on head `f1700af` (three fixed, one refuted with evidence)

The eighth finding-bearing head. Codex's attempt-2 review again landed AFTER the orchestrator's
two-timeout verdict (7.5 minutes this time) and is treated as the review of record. Three
findings extend accepted arms to the last untouched surfaces (the demo store, the migration's
notice/projection duties for pre-withdrawn rows); the fourth describes an attack a Phase-3 seal
already makes unrepresentable, and is answered with EVIDENCE rather than code.

| # | finding | resolution |
|---|---|---|
| R8-F1 (P2) | the LOCAL (demo/no-API) withdraw flipped the status but left the local pending bell notice — demo mode never refetches, so the feed kept sending the viewer to a decision the selectors now hide | the local mutation mirrors the server's retirement exactly: the canonical text shape is removed, multiplicity-guarded (a still-pending decision sharing the title leaves the text ambiguous and the row is LEFT); web test RED at `f1700af` → GREEN covering both arms |
| R8-F2 (P2) | the migration accepted a pre-withdrawn row but left the servable `decisions.inbox` generation claiming it pending (the partial apply emitted no DomainEvent, so `readServableGeneration` still called it caught-up) | the migration RETIRES the active generation for affected projects — `readServableGeneration` returns null and every read falls back to canonical truth until the next delivery/rebuild; rows retired, never edited; upgrade-proof plants a servable generation and asserts it retired (RED → GREEN) |
| R8-F3 (P2) | the migration never retired a pre-withdrawn decision's pending bell notices — stamped or legacy — and no future command will | the migration mirrors the command's retirement: stamped rows by IDENTITY, legacy rows by the canonical `pendingDecisionNotice` text shape with the exact multiplicity guard; upgrade-proof plants all three shapes and asserts stamped+unambiguous deleted, ambiguous SURVIVES (RED → GREEN) |
| R8-F4 (P2) | claimed: an approval revision minted against a dummy decision can be UPDATEd onto a withdrawn decision, bypassing the INSERT-only reverse arm | **REFUTED WITH EVIDENCE** — `DecisionApprovalRevision_append_only` (Phase 3, `20261212000000`) fires BEFORE UPDATE OR DELETE and refuses every register update unconditionally; the register's composite FK `(decisionId, optionKey)` → `DecisionOption` is a second pre-existing seal. The probe executes the exact attack (mint on a dummy, re-point at the withdrawn row) and asserts the `append-only` rejection; an upgrade-proof rejection proves it over the migrated legacy DB; replied on the thread |

Round-8 gates: probe file 36/36; web `decision-withdraw` 11/11; `pnpm check` EXIT 0 (web
763/763, API 791/791); `upgrade-proof.sh` PASSED — **566 assertions**; the full integration
battery via the required `api` CI check.

## Round 9 — the four Codex P2 findings on head `b99f792`, one batched head

The ninth finding-bearing head — the late-landing review of record again (7 minutes after the
two-timeout verdict). All four verified as REAL gaps against the existing seals before fixing.

| # | finding | fix |
|---|---|---|
| R9-F1 (P2) | the frozen set omitted the QUESTION identity — `title`/`room`/`nodeId` stayed editable on a withdrawn row and in the withdrawing statement, attaching the frozen actor/reason to a different register entry | both arms freeze the identity: the terminal seal refuses any change on a withdrawn row, the entry seal refuses it in the withdrawing statement (no service path updates these columns post-create, so nothing legitimate breaks); probed three ways + two upgrade-proof rejections |
| R9-F2 (P2) | the attribution FK proves the membership ROW, not its standing — a withdrawal could be hand-attributed to a `removed` membership, and the migration accepted pre-existing rows so attributed | the entry seal requires an ACTIVE membership (guarded on NOT NULL so evidence-less withdrawals keep coherence's own message; the ghost-actor forgery now gets the seal's answer BEFORE the FK, which stays the structural backstop — the P8 probe and the proof assert updated to the stronger refusal); a new unconditional diagnostic quarantines pre-existing withdrawn rows attributed to non-active memberships, stated honestly for repair re-runs; partial-apply stage 4 plants the ghost attribution (RED at `b99f792`: the migration ACCEPTED it → GREEN, abort by name) |
| R9-F3 (P2) | the round-6 picker rule was client-only — `assertRefs` validated decision references with bare existence, so a stale client or direct API call could pin a NEW activity to a terminal decision | the decisions contract gains `decisions.linkableInProject` (`linkable`/`withdrawn`/`missing` — existence is not linkability), declared in the shared contract + manifest + contract-test pins; `assertRefs` refuses the withdrawn case with the honest pmc-facing reason (`activity.manage` is a pmc authority); probed both ways (withdrawn refused with no write; a live decision still links) |
| R9-F4 (P2) | the entry/reverse seals counted only register revisions, but the round-6 diagnostic itself establishes legacy `approved`/`reapproved` DecisionEvents as approval evidence — a legacy-approved published-pending row could be withdrawn, and a legacy approval event could be recorded against a withdrawn row | the entry seal and the SERVICE belt count the legacy events exactly like the register; a new reverse trigger (`DecisionEvent_no_withdrawn_approval`, same FOR UPDATE serialization as the revision arm) refuses approval-event inserts against withdrawn rows while every other event type — the register's own `withdrawn` entry included — passes; probed at the service (409) and both DB directions + two upgrade-proof rejections |

Round-9 gates: probe file 41/41; `pnpm check` EXIT 0 (web 763/763, API 791/791; the shared
`DECISION_QUERIES` contract advanced with the manifest); `upgrade-proof.sh` PASSED — **572
assertions** incl. the five new rejections and the fourth partial-apply stage; the full
integration battery via the required `api` CI check.

## Round 10 — the five Codex P2 findings on head `f841907`, four fixed + one REFUTED

The tenth finding-bearing head — and the first review the orchestrator classified IN-WINDOW
(attempt 2/2, no late-landing verdict). Every finding verified against the existing seal
network before any fix; one is refuted by execution.

| # | finding | resolution |
|---|---|---|
| R10-F1 (P2) | the round-9 `linkableInProject` guard ran BEFORE the command transaction — a `decisions.withdraw` committing between the pre-check and the activity write left NEW work pinned to a terminal decision | the pre-tx check stays as fast-fail UX; the AUTHORITY moves in-tx — `linkableInProject` gains a tx-bearing form taking `FOR SHARE` on the decision row (serializing with withdraw's CAS), and `activities.create`/`update` re-check inside `executeCommand` (update: after `lockProjectReadiness`, which withdraw also holds). Probed with a deterministic interleave driver (the pre-tx call triggers the full withdraw before returning its stale `linkable`) for BOTH create and update — RED at `f841907` (the link committed) → GREEN (400, no write) |
| R10-F2 (P2) | claimed: the runtime recovery-gap tombstone writes `gen_random_uuid()` (uuid) into the TEXT `OutboxDelivery.id` without `::text`, so the withdrawal rolls back exactly in the missing-delivery case | **REFUTED WITH EVIDENCE** — PostgreSQL applies its automatic I/O-conversion cast in assignment context for string-type targets: `pg_cast` holds NO `uuid→text` row, yet `INSERT INTO t(text_col) SELECT gen_random_uuid()` succeeds (verified live), landing the canonical 36-char uuid text. The R3-F3 probe exercises this exact INSERT on every run (a type error would be raised at PLAN time and fail every withdraw probe); the new R10-F2 probe pins the landed id's uuid-text form so the claim stays refuted by execution. The migration's `::text` is explicit but not required. Thread reply posted |
| R10-F3 (P2) | `selectVisibleDecisions` removed only withdrawn/draft for non-pmc, but the server hides PENDING from everyone except pmc/client (AUTH-02) — a persona switch before refetch, or demo mode, rendered pending rows the server filters | the shared selector now mirrors `decisionVisibleToViewer` COMPLETELY: drafts excluded, withdrawn pmc-only, pending pmc/client-only, everything else project-wide. The R6-F3 web test — whose old assertion ENCODED the incomplete rule (`contains DL-P` for contractor/engineer) — is rewritten to the full rule and was the RED capture; client keeps the pending row (they are the approval audience), approved rows stay visible to all roles |
| R10-F4 (P2) | the round-9 ACTIVE-membership entry seal read `Membership.status` without a lock — a concurrent removal could commit mid-withdrawal, attributing the permanent record to a member already removed at commit time | the trigger's `PERFORM` takes `FOR UPDATE` on the membership row: a removal now either waits for the withdrawal (attribution was active AT commit) or, having won the lock, makes the re-evaluated read see `removed` and refuse. Ordering A (removal first → refusal) is round 9's R9-F2; the new ordering-B probe holds the withdrawal open UNCOMMITTED and proves the concurrent removal BLOCKS (pg_stat_activity, condition-based) until the withdrawal commits — RED at `f841907` (it committed straight through) → GREEN. The service path already held this lock (`OrgsParticipant.lockActiveMembership`), so no service change |
| R10-F5 (P2) | `DecisionEvent_no_withdrawn_approval` fired only on INSERT and `DecisionEvent` has NO append-only seal (unlike the register the refuted R8-F4 relied on) — an existing benign event could be RE-POINTED (`decisionId`/`type`) into approval evidence against a withdrawn decision | the trigger now fires `BEFORE INSERT OR UPDATE`; the NEW-row check is the single rule for both verbs. Probed both re-point shapes (decisionId+type flip; in-place type flip of the register's own `withdrawn` entry) + benign-update precision — RED at `f841907` (both updates succeeded) → GREEN; two upgrade-proof rejections + a precision pass added at the battery END (lesson: plants change later messages) |

Round-10 gates: probe file 46/46 (r10-red: 4 failed / 1 refutation-passed at `f841907`); web
`decision-withdraw` 11/11 (RED: the rewritten R6-F3 assertion failed at `f841907`);
`upgrade-proof.sh` PASSED with the three new battery lines; `pnpm check` EXIT 0; the full
integration battery via the required `api` CI check.

## Round 11 — the three Codex P2 findings on head `3a972ae`, one batched head

The second consecutive IN-WINDOW verdict (attempt 1/2, 14 minutes — the PR-#339 orchestrator
windows working). All three verified REAL before fixing.

| # | finding | fix |
|---|---|---|
| R11-F1 (P2) | the frozen question excluded its CHOICES — `DecisionOption` rows of a withdrawn decision stayed mutable/deletable/insertable (the R3-F1 probe itself deleted them as "children cleared"), so the frozen withdrawer/reason could later display against a different set of options | seal 5: `DecisionOption_t4a_frozen` (BEFORE INSERT OR UPDATE OR DELETE; a cross-decision re-point is judged on BOTH parents; same FOR UPDATE serialization). The sanctioned destructive resets extend their named-trigger bypass to it (probe cleanup, P13-finally, R3-F1/R4-F2 child-clearing, and the seed's guarded wipe — the option wipe joins the SAME atomic transaction, preserving the R5-F2 ordering and R6-F4 atomicity pins). Probed all three verbs + live-decision precision; three upgrade-proof rejections + a benign live-option pass |
| R11-F2 (P2) | `activities.update` revalidated the CURRENT decision link — the Plan Activity modal re-sends `decisionId` on every edit, so editing an unrelated field on an activity already carrying the (allowed) link-then-withdraw state got a 400 | only a NEWLY introduced link (`input.decisionId != null && !== a.decisionId`) passes through the pre-tx check and the in-tx authority; the unchanged link needs no revalidation (it is the stored, FK-valid reference) and explicit null still clears. Probed: same-link re-send with a rename succeeds; a NEW withdrawn link still 400s; null clears |
| R11-F3 (P2) | the BAKED readiness reason is viewer-specific, but a cached PMC DTO survives a persona switch (or a pending refetch), so the pmc-only text `The linked decision was withdrawn — re-issue or relink` could render to client/engineer via the Schedule tooltip | the two texts move to shared constants (`WITHDRAWN_REASON_HONEST`/`REDACTED` — one source, no drift) and `redactWithdrawnReadinessForViewer` re-redacts at read time in the web's single readiness funnel (`readinessFor`): verdict/source untouched, only the sentence swaps; pmc keeps the honest text; the demo derivation was already viewer-correct. Probed for all four non-pmc roles + pmc |

Round-11 gates: probe file 48/48 (RED at `3a972ae`: 2 failed API + 1 failed web); web
`decision-withdraw` 12/12; `pnpm check` EXIT 0; the full battery via the required `api` CI check.

## Round 12 — the six Codex P2 findings on head `c2d3a1a`, one batched head

The third consecutive in-window verdict (attempt 1/2, 14 minutes). All six verified REAL before
fixing — the widest round since round 1, and the round that completes the durability story:
the projection repair now heals instead of wedging, and every component of the frozen question
(id, options, evidence events, standing) is sealed.

| # | finding | fix |
|---|---|---|
| R12-F1 (P2) | the round-8 projection retirement left NO active generation — the next delivery bootstrapped `appliedPosition = NULL` (expecting position 0) against a stream at head+1 and was released `wait` forever: the consumer wedged until an operator rebuild | the migration now retires AND REPLACES in one step: the replacement copies the retired generation's rows and its `appliedPosition` VERBATIM (the silent withdrawal emitted no event, so the checkpoint is still exact) and corrects ONLY the withdrawn rows — the same three-key dto extension `serializeDecision` writes, in SQL. Scoped to STALE pairs, so re-runs and healthy databases are no-ops (this also fixes the arm re-retiring healthy generations on operator re-runs). Pinned end-to-end on a fresh project: checkpoint preserved, projection == live slices for pmc AND engineer, and the post-migration delivery APPLIES (RED: it waited forever) |
| R12-F2 (P2) | option writes are judged at write time, so ONE transaction could edit a published pending decision's options and then withdraw — freezing the actor/reason onto a question that was never published | the WITHDRAWING transaction can no longer touch the question: every option write leaves a per-transaction touch note (`DecisionOption_t4a_touch`, an ON COMMIT DROP temp table written via dynamic SQL — the static-plan temp-table footgun is documented in the trigger) and the withdrawal-entry seal refuses a decision whose options were touched in the SAME transaction — UPDATE, INSERT and DELETE alike (xmin could never see deletes). Ordinary transactions never withdraw, so nothing else trips it: create-with-options, fixtures and resets are untouched (a publication-wide freeze was prototyped and rejected — it broke twelve suites' sanctioned resets). The scope is stated honestly: a pre-withdrawal edit in an EARLIER transaction is tampering with a LIVE client-visible pending question — its own problem, outside the withdrawal seal — and the round-11 withdrawn freeze still guarantees post-withdrawal immutability |
| R12-F3 (P2) | `introducedDecisionId` was computed from the PRE-transaction activity read — a concurrent update could clear/relink between the read and the lock, making the re-sent id a silent REINTRODUCTION validated as "unchanged" | the current link is re-read UNDER `lockProjectReadiness` (every activity update holds it) and only a genuinely new link is validated; the pre-tx check stays as fast-fail UX. Probed with a deterministic interleave driver (clear + withdraw during the pre-tx phase) — RED: the stale link was rewritten; GREEN: 400, link stays null |
| R12-F4 (P2) | the identity freeze omitted the primary `id` — every child FK is ON UPDATE CASCADE, so re-keying a withdrawn row dragged the children along and the register lost the entry under its issued id | `id` joins BOTH freeze arms (terminal + entry); probed both ways + an upgrade-proof rejection |
| R12-F5 (P2) | approval events are evidence the entry seal COUNTS, yet they could be DELETED or type-downgraded before withdrawing — laundering a PR-#192 legacy approval away | the event trigger now covers DELETE (an approval event cannot be deleted) and UPDATE-away-from-approval (no type downgrade); the laundered withdrawal stays refused; non-approval events remain deletable; the destructive resets extend the sanctioned bypass — the probe cleanup, the P13/R12-F1 finallys, the seed's guarded atomic transaction (ordering/atomicity pins hold), and a shared `wipeDecisionEvents` fixtures helper adopted by the seven approving suites whose event wipes the seal would otherwise refuse |
| R12-F6 (P2) | the ACTIVE-membership seal proved membership, not AUTHORITY — an active contractor/engineer could be hand-attributed as the withdrawer | the entry seal and the standing diagnostic require ACTIVE **pmc** standing (live authz derives the token role from the membership row, so the service path is untouched); probed + proof-planted (an active contractor attribution refuses) |

Round-12 gates: probe file 54/54 (RED at `c2d3a1a`: 6/6 via the c2d3a1a file-copy swap);
`pnpm check` EXIT 0 (web 764/764, API 791/791); the full battery via the required `api` CI check.
