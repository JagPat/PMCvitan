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
