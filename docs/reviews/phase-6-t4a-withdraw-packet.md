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
