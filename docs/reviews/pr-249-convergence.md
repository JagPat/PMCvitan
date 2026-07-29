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
| `ecbc4d7` | R4 — 2 real (2×P2) + 1 invalid | The same cause in its last two hiding places: the retarget guard read only the newest COMPLETED scope run, so a scope still RUNNING from another attempt left old-base products looking like coverage; and a `filter=all` page that failed mid-read left a partial prefix in play, which can look clean while the unread page holds the cancelled product → an unfinished scope run from another attempt forces the battery, and only a COMPLETE pagination may become the history |
| `2016f41` | R5 — 2 real (2×P2) + 1 invalid | The two sides of one ambiguity: a SKIPPED product run means either "the plan deliberately found this head covered" or "an upstream gate failed and this attempt aborted", and the gate treated both as deferrable → a skip may now defer to older evidence ONLY when its own workflow run has BOTH `review-scope` and `battery-plan` green (the only state in which the skip can be the plan's `run_products=false` decision); any other skip is a real non-success and fails closed |
| `8b2f2de` | R6 — 2 real (1×P1, 1×P2) + 1 disproved premise | The R5 rule was stated over the two gates but only HALF-wired: `battery-plan` was not a required check, so its own failure was invisible to the gate and its verdict was not consulted where `review-scope`'s was → `battery-plan` joins `REQUIRED_CHECKS` (and the legacy-PR filter), and both the in-flight guard and the newest-completed-verdict loop iterate `['review-scope','battery-plan']` uniformly. Attempt attribution is hardened to `check_suite.id` with the URL parse as fallback (the P1's stated premise — that `html_url` is `/runs/{check_run_id}` — is false for this repo, see below) |

## Architectural Convergence

All six rounds reduce to ONE cause: the first design decided "has this SHA been tested?" from an
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
   skipped run defers to the evidence it deliberately kept (see 5), a stale failure never
   outlives a newer pass, and a name whose only runs are unattributable skips fails closed.
5. **A skip must prove it was deliberate.** Skipped product runs are ambiguous evidence; only a skip from an attempt whose scope AND plan both succeeded may defer to older runs. An aborted attempt's skips fail closed, so a failed planner can never launder stale coverage.
6. **Only complete, attributable history decides.** A partially-read page is discarded rather
   than trusted, an unfinished scope verdict from another attempt forces the battery, and the
   current workflow run's own checks are excluded so the guard reads other attempts only.
7. **The two gates are ONE set, everywhere.** `review-scope` and `battery-plan` both gate the
   products through `needs`, so every rule that reads a gate reads BOTH: the gate requires both
   names, the in-flight guard waits on both, and a non-success from either invalidates the
   product evidence below it. `battery-plan` being required is what makes its own failure
   visible instead of silently green with five skipped products beneath it.

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
| R4 in-flight scope from another attempt | `ecbc4d7` | probe with a completed old-base success PLUS an in-progress scope run; the old logic returns `runProducts: false` and the new one `true` (demonstrated by importing both modules side by side) | The current run's own checks are excluded by `belongsToRun`, pinned by its own unit test, so this can never fire merely because THIS edit's scope is queued |
| R4 partial pagination | `ecbc4d7` | source test asserts `if (complete) checkRuns =` — a prefix never becomes the decision input | Failing toward a full battery is the only outcome of an incomplete read |
| R3 `started_at` vs `completed_at` | `0698ae8` | plan probe (started-first/finished-last cancelled decides) + gate probe (10:00→10:30 failure outranks 10:05→10:20 success) | Both orderings share the same rule as GitHub's own `latest` filter |
| R6 `battery-plan` not required | `8b2f2de` | gate probes: an aborted attempt (`battery-plan` failure + five product skips over older successes) now reports `battery-plan` AND all five products failed; the `REQUIRED_CHECKS` pin and the legacy-PR filter both list it | A failing planner can no longer be invisible to the gate |
| R6 `battery-plan` verdict not consulted | `8b2f2de` | `assessBatteryPlan` iterates both gates in the in-flight guard and the newest-completed-verdict loop | The R5 rule is now stated over the gate SET, not one member of it |
| R7 unactionable gate message | `88ea653` | three `assessConvergence` probes: a marker demoted by a blank line, a marker in a final block spoiled by a prose line, and a genuinely absent one — the first two now name the parsing rule, the third still reads plainly `trailer` | The gate's refusal is unchanged; only the reason improves, so no head can pass that could not pass before |

The R3 round is itself evidence for the convergence claim: two of its three findings are the R2
remedy applied at sites the R2 pass missed (the second fetch, the second ordering). R6 is the same
shape once more — the R5 rule was written about both gates but wired for one — which is why
invariant 7 above is stated over the gate SET rather than at each call site.

### R7: the gate refused this PR's own head, correctly, and the message was not actionable

The R6 head `88ea653` failed its own convergence gate with `missing trailer`. The line was in the
commit message — but with a blank line above it, which demotes it to body text, because git reads
trailers from the last paragraph only. The gate was right and I was wrong; the head was amended.

`missing trailer` is accurate and still reads as "you forgot it" when the line is visibly there.
`convergenceTrailerHint` now distinguishes absent from present-but-unparsed and states the rule
(final block; every line a `Key: value` trailer) rather than guessing which of the two mistakes it
is — an earlier draft asserted "remove the blank line above it", which is wrong for the
prose-line-in-the-final-block case and was caught by an existing test. The gate decision is
untouched: `hasTrailer`, `allowed` and the refusal itself are identical, so nothing that was
blocked can now pass.

### One R6 premise was disproved, and the code still changed

The R6 P1 argued that attempt attribution is unsound because a check run's `html_url` is
`/actions/runs/{check_run_id}`, so the parse would extract a check-run id and never match a
workflow run. That premise does not hold for this repository: a real check run read from the API
during this session carries
`https://github.com/JagPat/PMCvitan/actions/runs/30432752540/job/90514686877`, and the regex
`/\/actions\/runs\/(\d+)\//` extracts `30432752540` — the workflow run id, exactly as intended.
Recording it as fact would have been wrong.

The finding's underlying concern — that attribution rests on URL string shape at all — is sound
regardless, so `attemptOf` now keys on `check_suite.id` (the API's own grouping of a workflow
run's check runs) and falls back to the URL parse only when the suite is absent. The behaviour is
unchanged where the parse already worked; it no longer depends on the parse where it did not.

`pnpm test:automation` 82/82; `pnpm check` EXIT 0 by exit code on each head. No product code,
schema, migration, event or lock is touched by this PR.

## Remaining Risk

The plan reads GitHub's check history, which is eventually consistent: a product run created
microseconds after the plan's read would not be seen. The consequence is bounded and safe in
one direction only — it can cause a redundant battery, never a skipped one — because every
uncertain input (absent payload, unreachable history, unfinished scope verdict) returns
`runProducts: true`. The `codex-current-head` gate remains fail-closed throughout; nothing in
this PR can promote a head whose product jobs did not run.
