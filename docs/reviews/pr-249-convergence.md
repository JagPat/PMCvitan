# PR #249 Review Convergence

## Objective

Converge the PR #249 review (one product-CI battery per SHA). Two heads received Codex
findings — `86a972b` (3) and `d894a56` (3) — so per the PR-#247 protocol this head is the ONE
batched architectural correction: map every finding to its shared cause, show the remedy is an
invariant rather than a point patch, and state the remaining risk honestly.

## Finding Map

| Head | Round — findings | Cause → batched remedy and proof |
| --- | --- | --- |
| `86a972b` | R1 — 3 (1×P1, 2×P2) | Splitting `edited` into a second workflow broke the owner's wake path (`auto-merge.yml` listens for `CI` runs only), lost the base-retarget case, and left duplicate `review-scope` runs that the gate misread as failures → the split is reverted: ONE workflow, a plan job gating the products, and a newest-real-run check summary |
| `d894a56` | R2 — 3 (1×P1, 2×P2) | The skip path trusted evidence it could not actually see or bound: `?filter=latest` hid the older real run the fallback needed, in-flight runs were counted as absence, and "has ever really run" accepted product runs from a pre-retarget base → the client pages `?filter=all`, in-flight non-skipped runs count as coverage, and a failed newest-completed `review-scope` invalidates prior product evidence |
| `0698ae8` | R3 — 3 real (3×P2) + 1 invalid | The SAME cause surviving in three places the R2 pass did not reach: the battery-plan's OWN fetch still used the default `filter=latest` (R2 fixed only the gate client), coverage was still `some(run ⇒ …)` so a NEWER cancelled run was masked by an older success, and both recency orderings keyed on `started_at` when GitHub's `latest` is defined by `completed_at` → the plan pages `filter=all` too, coverage is decided by the NEWEST non-skipped run (cancelled ⇒ not covered), and both orderings key on `completed_at` |

## Architectural Convergence

Both rounds reduce to ONE cause: the first design decided "has this SHA been tested?" from an
incomplete, unbounded view of the check history — a second workflow whose completions the owner
never saw, a partial API result, a notion of "ran" that ignored both time and the base under
test. Every remedy is the same correction applied at a different layer, and each is now an
invariant rather than a special case:

1. **One workflow owns every PR event.** `edited` is handled in `ci.yml` alongside the code
   events, so a completed CI run always wakes the trusted owner. A second workflow can never
   again complete unseen — pinned by `autonomous-ci-battery.test.mjs` ("the edited event
   reaches exactly one workflow", "exactly one workflow can launch each product job").
2. **The battery decision is a pure, total function.** `assessBatteryPlan` takes the action,
   the base-change flag and the check history and returns a decision with a reason for every
   input, including the unknown ones — missing payload or unreachable history fails toward
   running the battery. It is unit-tested per branch rather than inferred from workflow YAML.
3. **Coverage means "covers THIS head, against THIS base, now".** A run counts when it is
   executing or has executed (not skipped, not cancelled); a completed failure is coverage
   (red products need a new SHA, not a metadata edit); and product evidence is discarded when
   the newest completed `review-scope` did not pass, which is exactly the state a retarget or a
   too-large first attempt leaves behind.
4. **The gate reads whole history, newest real run wins.** `checkRuns` pages `?filter=all`, and
   `summarizeRequiredChecks` resolves each required name by its newest non-skipped run — so a
   skipped run defers to the evidence it deliberately kept, a stale failure never outlives a
   newer pass, and a name with only skipped runs is missing (fail closed).

## Evidence

Reproduce-first at each round, both probes RED at the prior head and GREEN here:

| Finding | RED at | Probe | Regression surface |
| --- | --- | --- | --- |
| R1 owner wake / two workflows | `86a972b` | `autonomous-ci-battery.test.mjs` — `edited` reaches exactly one workflow; each product job has exactly one launcher | Structural over every file in `.github/workflows/`, so re-splitting is red |
| R1 base retarget | `86a972b` | `assessBatteryPlan` base-change branch | Pure-function branch test |
| R1 stale scope failure | `86a972b` | `summarizeRequiredChecks` newest-real-run probes | Gate unit tests |
| R2 `filter=latest` | `d894a56` | workflow test asserts the paged `filter=all` URL and asserts `filter=latest` is ABSENT | Any revert to the partial fetch is red |
| R2 in-flight coverage | `d894a56` | two `assessBatteryPlan` probes (all in-flight; mixed queued/completed) | Pure-function branch test |
| R2 pre-retarget products | `d894a56` | probe pair differing ONLY in the newest completed `review-scope` verdict — failure runs the battery, success keeps the skip | Proves the fix does not defeat the PR's own purpose |
| R3 plan's own `filter=latest` | `0698ae8` | a source test asserts the plan's paged `filter=all` URL and that a bare `?per_page=100` fetch is ABSENT | Both fetch sites are now pinned, not just the gate's |
| R3 cancelled masked by older success | `0698ae8` | probe pair: a NEWER cancelled run runs the battery, an OLDER one below a newer success does not | Removes the gate/plan deadlock (gate red, plan refusing to re-run) |
| R3 `started_at` vs `completed_at` | `0698ae8` | plan probe (started-first/finished-last cancelled decides) + gate probe (10:00→10:30 failure outranks 10:05→10:20 success) | Both orderings share the same rule as GitHub's own `latest` filter |

The R3 round is itself evidence for the convergence claim: two of its three findings are the R2
remedy applied at sites the R2 pass missed (the second fetch, the second ordering). That is the
cost of fixing a systemic cause one call-site at a time, and it is why every remedy above is now
stated as a rule over ALL sites rather than a patch at one.

`pnpm test:automation` 80/80; `pnpm check` EXIT 0 by exit code on each head. No product code,
schema, migration, event or lock is touched by this PR.

## Remaining Risk

The plan reads GitHub's check history, which is eventually consistent: a product run created
microseconds after the plan's read would not be seen. The consequence is bounded and safe in
one direction only — it can cause a redundant battery, never a skipped one — because every
uncertain input (absent payload, unreachable history, unfinished scope verdict) returns
`runProducts: true`. The `codex-current-head` gate remains fail-closed throughout; nothing in
this PR can promote a head whose product jobs did not run.
