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
| `36a5377` | R9 — 1 real (1×P1) + 2 invalid | The shared rule was written per ATTEMPT when the quantity it governs is per PRODUCT NAME: `gateWatermark` asked "did this attempt produce any products?", so an attempt with `web` visible and its other four check runs not yet created vouched for all five, and those four fell back to the previous base's successes → the watermark is computed PER NAME (`gateWatermarks`), so an attempt vouches only for the names it actually produced; both the plan and the gate index it by name. The two invalid findings are phantom-SHA trailer claims, recorded below |
| `0f4f19a` | R10 — 2 real (2×P2) + 1 invalid | The R9 per-name watermark fixed one half of a symmetry and introduced the other: a SKIPPING attempt's five skipped runs need not be visible at once either, so per-name alone treated its not-yet-visible names as "produced no run", raised the watermark and rejected the evidence that attempt deliberately preserved → the watermark now reads the CHARACTER of the runs an attempt does have (skipping preserves for every name, running supersedes the names it lacks, no products at all is the retarget window), and `belongsToRun` inspects BOTH URLs rather than `html_url ?? details_url` |

## Architectural Convergence

All nine rounds reduce to ONE cause: the first design decided "has this SHA been tested?" from an
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
| R9 watermark broke deliberate skips (regression) | `63e46f5` | probe: attempt 600 real green, attempt 700 a deliberate skip → the SECOND metadata edit still skips; a gates-only attempt 800 still forces the battery | The rule now distinguishes "no products yet" from "products deliberately skipped", so it cannot re-break the invariant it protects |
| R9 gate had no watermark | `63e46f5` | gate probe: attempt A green, attempt B's gates green with no products → `pending` (not success, not failure); B's products land → success; a deliberate skip stays success. RED with the watermark disabled | The same rule now runs on BOTH sides from ONE shared module, so plan and gate cannot drift |
| R8 product evidence older than its gates | `9fc815b` | probe triad: base-A gates+products green → skip; a retarget's gates pass with no products yet → run (`from the current attempt`); the new attempt's products land → skip again | Closes the last window in which one attempt's gates could be paired with a superseded attempt's product evidence |
| R7 unactionable gate message | `88ea653` | three `assessConvergence` probes: a marker demoted by a blank line, a marker in a final block spoiled by a prose line, and a genuinely absent one — the first two now name the parsing rule, the third still reads plainly `trailer` | The gate's refusal is unchanged; only the reason improves, so no head can pass that could not pass before |

The R3 round is itself evidence for the convergence claim: two of its three findings are the R2
remedy applied at sites the R2 pass missed (the second fetch, the second ordering). R6 is the same
shape once more — the R5 rule was written about both gates but wired for one — which is why
invariant 7 above is stated over the gate SET rather than at each call site.

### R9: the watermark had to distinguish two kinds of gate attempt — and one rule now serves both sides

Round 8's watermark was too blunt, and the review caught a regression I introduced with it. After a
normal metadata-only edit, the history holds that skip attempt's green gates plus its SKIPPED
product runs. On the next edit my watermark came from those gates, the skipped runs were ignored,
and the older real successes were rejected as too old — so **every second metadata edit relaunched
the full battery**, which is precisely the duplication this PR exists to prevent.

The distinction the rule was missing: a gate attempt that produced NO product runs at all is the
retarget window and must invalidate older evidence; a gate attempt whose products are SKIPPED
deliberately chose to keep that evidence and must not. `gateWatermark` now takes the newest
completion only from attempts with no products of their own.

The second finding was the same hole on the gate side: an older owner polling a green SHA could
see a newer attempt's green gates with no products yet and publish `codex-current-head` success.
Rather than write the rule twice — which is how rounds 4–9 kept producing paired findings — the
shared rules moved into `scripts/check-run-coverage.mjs`, and the plan and the gate both import
them. Not-yet-run products read as `pending`, never `failure`.

Both probes are reproduce-first: the gate probe is RED with the watermark disabled and GREEN with
it, and the skip-regression probe fails against round 8's rule.

### R8: an attempt's gates cannot be paired with an earlier attempt's products

Rounds 4–7 progressively tightened "does this head have coverage?" — whole history, newest real
run, cancelled is not coverage, either gate failing invalidates what is below it, an unfinished
gate forces the battery. One window survived all of it: a retarget attempt whose `review-scope`
AND `battery-plan` have both COMPLETED SUCCESSFULLY, but whose five product jobs have not been
created yet. Every earlier guard passes, and the only product runs visible belong to the old base.

The rule that closes it is the ordering the workflow itself guarantees: product jobs are created
after the gates that launch them, so within one attempt a product always completes later than its
gates. Coverage older than the newest completed gate therefore belongs to a superseded attempt.
`coveredBy` now takes that watermark and refuses anything below it.

This subsumes the earlier special cases rather than adding another: a failed or unfinished gate is
still caught by its own guard, and the watermark independently catches the case where the gates
look perfect and the products simply are not there.

One existing fixture had to become realistic to express its own intent — its product runs carried
no completion time at all, which under the new rule reads as infinitely old. Real check runs always
have `completed_at`, and a product always completes after its gates, so the fixture now says so.

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

## Round 9 (head `36a5377`) — the watermark's unit was wrong

R9's real finding is the same architectural cause this packet has tracked throughout, in its
last place: a rule stated over the wrong unit. The check-run coverage question is always asked
*per product name* — "has THIS job run on the current attempt?" — but `gateWatermark` answered
it per attempt. GitHub creates an attempt's five product check runs one at a time, so the
window in which `web` exists and `api` does not is ordinary, not exotic. In that window the
per-attempt rule cleared the watermark for all five names, and the four with no run of their
own resolved to the previous base's successes.

`gateWatermarks` now returns a name-keyed map: for product name N, the watermark is the newest
completed gate from any attempt that produced no run *named N*. The two properties the earlier
rounds established are preserved by construction — an attempt whose products are all SKIPPED
has a run for every name, so it still vouches for all five and cannot invalidate the evidence
it deliberately kept (the round-8 regression stays fixed); an attempt with no product runs at
all vouches for none, so the retarget window still forces the battery.

Reproduce-first: `a partially visible attempt vouches only for the products it produced` is RED
with the per-attempt rule injected and GREEN with the per-name rule — both the plan
(`runProducts: true`) and the gate (`pending: [api, api-e2e, e2e, upgrade-proof]`, `failed: []`,
`web` genuinely covered). `pnpm test:automation` 86/86.

### Invalid reviewer evidence (round 9)

Two of R9's three findings were the phantom-SHA trailer claim, citing
`cdb23e72e758d0eb995f3588066396c10f3e4abe` — twice, once with the AGENTS.md permalink and once
without. That object does not exist in this repository (`git cat-file -t` fails) and is not
`refs/pull/249/head`; the reviewed head `36a5377` carries a git-parsed
`Review-Convergence: complete`. This is the same defect recorded on PR #246, #247 and #248: 21
such claims across four PRs, none naming a real object, every real head carrying the trailer.
It is now addressed at the source rather than re-recorded per round — PR #250 puts the trailer
and CI state out of a review's scope and has the gate discount a finding whose every cited
commit is absent from the repository.

## The defect, observed on this PR (head `68f2e2c`)

Between the round-9 push and this head, PR #249 reproduced its own target defect in
production. The record is worth keeping because it is the clearest possible statement of
what this PR is for.

Head `68f2e2c` accumulated two CI attempts:

| Attempt | `review-scope` | `battery-plan` | products |
| --- | --- | --- | --- |
| `30448858798` (push) | **failure** 11:46:35 — the PR had grown to 1,531 changed lines with no `justified-large` marker | success | 5× **skipped** (correctly — gated behind the failed scope check) |
| `30448995571` (body edit adding the marker) | **success** 11:48:41 | success | 5× **success** 11:49:25–11:54:32 |

Every check on the head was green. The trusted gate published
`ci: Failed checks: review-scope, web, api, e2e, api-e2e, upgrade-proof` — all six false.

The cause is the check-summary semantics this PR replaces. The gate that judged the head is
the DEFAULT-BRANCH copy (`auto-merge.yml` checks out
`${{ github.event.repository.default_branch }}`), and on `main` `summarizeRequiredChecks` reads:

```js
if (runs.some((run) => run.conclusion !== 'success')) failed.push(name);
```

Any non-success run for a name marks that name failed, so the superseded 11:46 scope failure
poisoned `review-scope` and each deliberate `skipped` poisoned its product name — exactly the
R1-F3 and R5 findings. This head's `summarizeRequiredChecks` resolves each name by its newest
non-skipped run and defers a skip only to evidence a green-gated attempt deliberately kept, so
it reads the same history as `success`.

That produces a bootstrapping constraint worth stating plainly rather than discovering again:
**a PR that repairs the merge gate is judged by the unrepaired gate.** Until this merges, any
head needing two CI attempts on one SHA — a scope failure fixed by a body edit is the common
case — is unmergeable regardless of its actual CI result. The mechanical consequence is that
this correction had to be delivered on a fresh SHA, whose single-attempt history the old gate
reads correctly. No evidence was weakened and no check was bypassed to achieve that; the head
below carries a complete, genuinely green battery of its own.

## Round 10 (head `0f4f19a`) — the same cause, one level up

R9 corrected the watermark's UNIT (per attempt → per product name). R10 shows the unit was
still not the whole answer, and the residue is the same architectural cause this packet has
tracked throughout: a rule stated over a quantity that does not determine the outcome.

"Does attempt X have a run named N?" is ambiguous whenever X's product check runs are not all
visible yet, and it is ambiguous in BOTH directions. R9 fixed the running case: a partially
visible RUNNING attempt must not vouch for the names it has not produced. R10 is its mirror: a
partially visible SKIPPING attempt must not INVALIDATE the names it has not produced, because a
skip is precisely the decision to keep the previous attempt's evidence.

What actually settles it is not which names an attempt has, but what KIND of runs it has:

| Runs the attempt shows | Character | Watermark effect |
| --- | --- | --- |
| none | unknown — the retarget window | raises for every name |
| at least one, all `skipped` | skipping — it kept older evidence | raises for no name |
| at least one non-`skipped` | running — it is producing its own | raises for the names it lacks |

A mixed attempt is classified `running`, which is the conservative reading. Both earlier
properties now hold by construction rather than by separate rules: the round-8 deliberate-skip
regression and the R9 partial-visibility case are two instances of one table.

The second finding is unrelated and simple: `belongsToRun` used `html_url ?? details_url`, and
`??` only falls through on null/undefined — a populated non-Actions `html_url` hid an Actions
job URL sitting in `details_url`, so the current attempt's own in-flight gates escaped the
exclusion and forced a duplicate battery. It now inspects both, which is what `attemptOf`
already did.

Reproduce-first: `a partially visible skip still preserves the evidence it kept` is RED with
the character rule disabled and GREEN with it, and asserts the R9 running case is unchanged in
the same probe; `the current-run exclusion reads both URLs` is RED with the `??` form restored.
`pnpm test:automation` 88/88.

### Invalid reviewer evidence (round 10)

The round's third finding cites `529beeff767804aef8479c9cd22943569d7f28b1`, which is not an
object in this repository and is not `refs/pull/249/head`. The reviewed head `0f4f19a` carries a
git-parsed `Review-Convergence: complete`. Twenty-second such citation across PRs #246–#249;
recorded, not acted on. PR #250 addresses the class at the source.

## Round 11 (head `278c44f`) — where this converges, and where it stops

R11's one real finding is the same ambiguity for the third time, and this round answers it by
declining to add a fourth rule rather than by adding one.

The finding: when an attempt's gates have completed but none of its product check runs exist
yet, `attemptCharacters` has nothing to classify, the attempt reads as the retarget window, the
watermark rises, and a second metadata edit relaunches the battery.

That observation is real. It is also **undecidable from check-run data**, because it is exactly
the same observation in two cases that require opposite responses:

| Actual case | What the plan should do | What the gate should do |
| --- | --- | --- |
| the plan chose to skip; skipped runs are seconds away | reuse the older evidence | reuse the older evidence |
| the base changed; real runs are seconds away | run the battery | withhold promotion |

A consumer-split was implemented and then withdrawn: it looked like the plan could always take
the optimising side, but it cannot. Assuming "skip" after a retarget accepts the previous base's
products as coverage for a merge result they never tested — the exact defect rounds 4–9 closed.
The plan needs opposite answers in two states it cannot tell apart, so there is no sound rule to
write, and writing an unsound one is how this ambiguity reached round 11 in the first place.

The window therefore resolves toward RUNNING, and that choice is now pinned by a test rather
than left as an oversight (`the undecidable gates-only window resolves toward running, not
toward trust`). The cost is one redundant battery inside a window measured in seconds — the
attempt's five product check runs are created together the moment its gating job completes. The
cost of the alternative is promoting untested code. The same test asserts the window is
transient: once the skipped runs appear the attempt is recognised as skipping and the older
evidence stands again.

This is stated as a deliberate limit of the design, not a defect left unfixed. Every remaining
uncertainty in this PR resolves toward running or toward pending; none resolves toward trusting
evidence that may be superseded.

### Invalid reviewer evidence (round 11)

Two of the round's three findings are the same phantom-SHA trailer claim, citing
`335c20294b159a6fba0bc1b9382ba2f814011519` — posted twice, once with the AGENTS.md permalink and
once without. That object is not in this repository and is not `refs/pull/249/head`; the reviewed
head `278c44f` carries a git-parsed `Review-Convergence: complete`. Twenty-third such citation
across PRs #246–#249. PR #250 addresses the class at the source.


## Base merge (head after `main` advanced)

This head is a merge of `origin/main` requested by the conflict bot after PR #251 merged. It
carries **no correction content**: the only incoming change is
`apps/web/tests/labour.test.ts` (the labour onboarding probe's load-dependent wait), and the
merge is conflict-free.

It is recorded here because the convergence gate cannot distinguish a base merge from a
correction head — with 12 finding heads behind this PR, every subsequent head is required to
carry the trailer and a changed packet, including one that fixes nothing. The trailer on this
commit therefore asserts only what remains true: the batched architectural audit for this PR is
complete and is the document you are reading. It does not claim this head is that audit.

The gate should exempt a head whose diff against its first parent is empty — a pure base merge
introduces no reviewable change of its own. That is a defect in the gate, not in this PR, and is
raised separately rather than worked around silently.

Validation on the merged tree: `pnpm check` EXIT 0 (web 543/543, API 680/680);
`pnpm test:automation` green.

## Round 10 (head `60f8431`) — evidence is dated by its attempt, not its clock

Two findings. One is acted on; one is unfounded and is recorded rather than patched.

### Acted on (P1): tie product coverage to the gate attempt

Correct, with a concrete interleaving. The watermark compared a product run's own `completed_at`
to the newest superseding gate. That dates evidence by when it *finished*, but what makes evidence
current is the attempt that *launched* it — gates run first and start the products, so the gate
completion dates the merge result the whole attempt tested.

The hole: attempt 800 runs on base A and its `api` job is slow. A retarget to base B lands and
attempt 900's gates pass at 11:00 with no product jobs created yet. The stale base-A `api` then
finishes at 11:05 — newer than base B's gates by clock, but it tested base A. A timestamp-only
comparison accepts it, and `codex-current-head` can publish success for a merge result four of
whose five product jobs never ran.

Fix: `attemptGateStamps` records when each attempt's gates completed, and `coverageStamp` dates a
product run by its own attempt's gates instead of its completion. A run whose attempt has no
visible completed gate falls back to its own recency — being unable to date an attempt should not
stall a head over missing history.

Reproduce-first: `a straggling product run from a superseded attempt is not coverage`, RED at
`60f8431` with the exact assertion the finding predicts, GREEN after. The probe also pins the
converse — with no retarget, the same late `api` still counts, so the fix supersedes rather than
simply rejecting late runs.

### Recorded, not patched: the trailer finding is unfounded

The second finding asserts this head lacks the convergence trailer, quoting
`git show -s --format=%B 62b4485c… | git interpret-trailers --parse`. Checked directly:

```
git cat-file -t 62b4485c55469f75beea19af1d5e42617357ac20
  → fatal: git cat-file: could not get object info   (absent, incl. refs/pull/249/head)

git log -1 --format='%(trailers:key=Review-Convergence,valueonly)' 60f8431
  → complete
```

The cited commit is not an object in this repository, and the head it was posted against carries
the trailer. There is nothing to correct, so no correction is made. The repository owner has
authorised recording such findings as unfounded rather than spending a round on them; the
measured record is in `docs/reviews/codex-fabricated-citations.md` and the standing instruction
now lives in `AGENTS.md` (PR #250, merged).

Gates: `pnpm test:automation` 90/90; `pnpm check` EXIT 0.

### Base merge after PR #250

`origin/main` merged again after PR #250 landed (`e416d7d`), at the conflict bot's request.
Conflict-free; the incoming change is the `AGENTS.md` review-scope instruction and its packet.
No correction content. As before, the trailer on this commit asserts only that this PR's
batched architectural audit is complete and is this document — not that a base merge is that
audit.

### Base merge after PR #248

Third base merge, after PR #248 landed. Conflict-free, no correction content — the incoming
change is the Phase-4 STATUS flip and its packet. Recorded for the same reason as the previous
two: the convergence gate requires the trailer on every head, including one that fixes nothing.

## Round 11 — `ab0da64`

Two findings. Both are correct, and one of them is a defect this PR introduced.

### F1 (P1): the decider was selected before currency was considered

Round 10 dated a product run by its attempt's gates, but only in the *comparison* against the
watermark. The run being compared was still picked by `newerRunFirst` — completion time, across
attempts — so the fix could never see the run it should have judged.

The interleaving: attempt 800 runs on base A with a slow `api`. A retarget lands, attempt 900's
gates pass at 11:00, and its own `api` **fails** at 11:02. The stale base-A `api` then succeeds at
11:05. Completion-ordered selection picks the 11:05 success, the watermark comparison passes it
(both attempts produced an `api`, so the watermark for that name is empty), and the gate reports
success while the current attempt's `api` is red.

Fix: `coverageOrder(stamps)` in `check-run-coverage.mjs` orders a name's runs by attempt currency
first and completion second, and `summarizeRequiredChecks` sorts with it. Within one attempt the
ordering is unchanged, so a `rerun-failed-jobs` success still masks the failure it repaired — that
rerun shares the check suite, hence the same coverage stamp. The deliberate-skip fallback is also
unchanged: the `find` still walks past an intentional skip to older evidence, now in attempt order.

Filtering to the newest attempt outright was rejected. Rounds 4–9 established that a skipping
attempt must be able to defer to the evidence it deliberately kept; a newest-attempt filter would
discard exactly that evidence and relaunch the battery on every second metadata edit.

Probe: `a current-attempt failure outranks a stale straggling success`, RED at `ab0da64`.

### F2 (P2): the planner and the gate dated evidence differently

This one is mine. Round 10 changed how the **gate** dates coverage and left the **planner** on
`recency`. The two then disagree, and the disagreement deadlocks the head rather than merely
being untidy.

The interleaving: attempt 800's five product runs all finish at 11:05, after attempt 900's
retarget gates at 11:00. The gate dates them to 800's gates (10:00), holds all five superseded,
and reports pending. The planner dates them to 11:05, finds them newer than the watermark, and
skips the battery. Nothing relaunches the products; the gate waits forever on evidence that will
never be produced.

Fix: `coveredBy` takes the attempt stamps and compares `coverageStamp(decider, stamps)` to the
watermark, and selects its decider with the same `coverageOrder`. Both sides now read one rule
from `check-run-coverage.mjs` — which is the entire reason that module exists, per its own header
comment about rounds 4–9 finding the same defect implemented differently on each side.

Probe: `the planner and the gate date coverage identically` — it asserts the two never reach
opposite conclusions about the same history, so it stays meaningful if either side's policy is
revised later. RED at `ab0da64`.

### Gates

`node --test scripts/autonomous-ci-battery.test.mjs` 15/15 (both new probes RED before the fix).
`pnpm test:automation` 104/104. `pnpm check` EXIT 0 — web 543/543, API 680/680; the
`onboardLabourWorker` key-timing flake noted in earlier rounds did not recur, its fix having
merged as PR #251.

## Round 12 — `2003ee9`

Five comments, three distinct findings. All three are correct, and all three are in the same
place the round-10 and round-11 findings were: **the boundary between an attempt's identity and
its evidence's timestamps.**

### F1 (P2): the planner's in-flight fast path skipped the currency test

`coveredBy` returned `true` for any non-completed run before comparing it to the watermark. A
base-A `api` job still executing when base B's gates pass is not coverage in progress for base B —
whatever it eventually reports describes the old merge result. The planner then emits
`run_products=false`, the new workflow creates only skipped products, and base B gets no `api` run
at all.

Fix: the supersession test moves ahead of the fast path in `coveredBy`. A superseded run is not
coverage whether it has finished or not.

Probe: `an in-flight product from a superseded attempt is not coverage`.

### F2 (P2): a gate rerun retroactively blessed the skips its failure caused

`intentionalSkip` asked whether the attempt held *some* successful run of each gate. The bounded
`rerun-failed-jobs` retry reruns a failed gate inside the SAME workflow run, so a later
`battery-plan` success made the products that skipped *because that gate failed* look deliberate.
Their attempt is then classed `skipping`, its gates drop out of the watermark, and the previous
base's successes speak for this head — while the retry's own product reruns do not exist yet.

Fix: `every` run of every gate in the attempt must have passed. A gate that failed at any point
means the attempt aborted, and its skips prove nothing. This is the fail-closed reading and needs
no timestamp reasoning: `review-scope` and `battery-plan` have no `needs` between them, so a
healthy attempt has exactly one successful run of each.

Probe: `a gate rerun does not bless the skips its earlier failure caused`.

### F3 (P2): a stale unfinished run held a passed current attempt pending

`summarizeRequiredChecks` marked a check pending if ANY run of that name was unfinished. Since the
gate reads `filter=all`, that includes every historical run, so a superseded attempt's still-running
job held the head pending until timeout and returned it to draft — even though the current attempt
had already passed that exact check.

Fix: the newest evidence decides whether we are waiting, not the existence of any unfinished run.
The name's runs are ordered by `coverageOrder`, and only if the FIRST is unfinished is the check
pending. The decider search then runs over completed runs only, so a deliberate skip cannot fall
through onto an unfinished older run and read its null conclusion as a failure; if a skip defers to
evidence that is itself still running, that is `pending`, not `missing`.

The converse is pinned in the same probe: the CURRENT attempt's own unfinished job is still
pending, even with an older completed success on the same name.

Probe: `a stale in-flight run does not hold a passed current attempt pending`.

### Why these keep arriving

Rounds 10, 11 and 12 have all found the same shape: a rule that must judge *which attempt* a run
belongs to, implemented somewhere as a comparison of *when it finished*. Round 10 fixed the
watermark comparison; round 11 fixed decider selection and the planner's copy of the rule; round 12
fixes the three remaining places that never consulted attempt identity at all — the in-flight fast
path, the skip attribution, and the pending test.

Every one is now expressed through `check-run-coverage.mjs` (`coverageStamp`, `coverageOrder`,
`gateWatermarks`, `attemptGateStamps`) or through the attempt key directly. The residual risk is
the same one that module already documents: a run whose attempt cannot be identified falls back to
its own recency, and the skip-attribution rule fails closed on it.

### Gates

`node --test scripts/autonomous-ci-battery.test.mjs` 18/18 — the three new probes RED at
`2003ee9`, GREEN after, and the five pre-existing coverage probes unchanged.
`pnpm test:automation` 107/107. `pnpm check` EXIT 0 — web 543/543, API 680/680.

## Round 13 — `fd73ba9`

Codex's review arrived AFTER the two review attempts timed out, so the head carries a
`timed_out` status alongside two genuine current-head findings. Both are correct and are fixed
here; the new head re-enters the gate normally, which is the ordinary recovery for a late review.

### F1 (P2): the shared watermark still trusted an aborted attempt's skips

Round 12 taught the GATE that an aborted attempt's skips prove nothing. It did not teach
`gateWatermarks`, which still classified an attempt as `skipping` whenever its visible product
runs were skipped — regardless of whether one of its gates had failed.

The two then deadlock. Attempt 900's `battery-plan` fails, its five products skip, the retry makes
`battery-plan` succeed. The gate reads those skips as a real non-success and fails the head. The
planner reads them as "attempt 900 deliberately preserved attempt 800's evidence", drops 900's
gates from the watermark, finds 800's successes current, and returns `run_products=false`. The
next attempt creates only skipped products. Nothing ever launches the battery that would clear it.

Fix: `attemptsWithPassingGates` is now the single shared definition of "this attempt's gates all
passed", exported from `check-run-coverage.mjs`. `gateWatermarks` filters out skipped product runs
from attempts that fail it — such a run neither produces coverage of its own nor preserves anyone
else's, so the aborted attempt's gates become a watermark and the older evidence is correctly
superseded. `intentionalSkip` on the gate side now reads that same set instead of recomputing its
own copy, so the two cannot disagree again.

Probe: `an aborted attempt's skips neither produce nor preserve coverage` — it asserts the plan
launches the battery AND that the two sides never reach opposite conclusions, which is the
deadlock condition itself.

### F2 (P2): one hung gate forced a duplicate battery forever

The unfinished-gate guard fired for ANY pending gate anywhere in the history. If attempt 800's
`review-scope` hangs, every later metadata edit runs the full five-job battery — even after
attempt 900 has completed its gates and all five products for the same SHA. That is exactly the
duplication this job exists to prevent, and it never stops.

Fix: only the FRONTIER's unknown verdict is a reason to run. A pending gate whose attempt has a
completed-gate stamp older than the newest attempt's cannot change what is current — whatever it
decides, its products would be older than the evidence a newer attempt has already produced. An
attempt with no completed gate at all cannot be dated, so it still counts as the frontier and
still forces a run; the probe pins that converse.

Probe: `a hung gate from a superseded attempt does not force a duplicate battery`.

### Gates

`node --test scripts/autonomous-ci-battery.test.mjs` 20/20 — both new probes RED at `fd73ba9`,
GREEN after, and the eighteen earlier coverage probes unchanged. `pnpm test:automation` 109/109.
`pnpm check` EXIT 0 — web 543/543, API 680/680.

## Round 14 — `c9e43cf`

Two findings, both correct. The P1 is a hole round 11 opened.

### F1 (P1): attempt-currency ordering was applied to gate checks too

Round 11 made the decider selection order by attempt currency. `coverageStamp` dates a run by the
completion of its attempt's gates — which is exactly right for a product job, because the gates
LAUNCHED it, and circular for a gate, which dates itself.

The consequence: a gate borrows its sibling's timestamp. Attempt 900's `review-scope` passes at
11:00 while its `battery-plan` is slow; a body edit starts attempt 1000, whose `review-scope`
FAILS at 11:05; attempt 900's `battery-plan` then finishes at 11:10. `attemptGateStamps` gives
attempt 900 an 11:10 stamp, so its 11:00 scope success outranks the 11:05 failure and this gate
publishes success over a red current scope check.

Fix: `summarizeRequiredChecks` selects the ordering per name — `coverageOrder` for the five
product checks, plain `newestFirst` for the gates. Attempt currency is reserved for runs whose
attempt genuinely dates them.

Probe: `a gate check is ordered by its own completion, not its sibling's`.

### F2 (P2): the undatable sentinel outranked a completed newer attempt

`recency` dated every unfinished run as "newer than everything". Round 12 fixed the case where a
stale unfinished run's attempt could be dated by its gates; this is the case where it cannot,
because ALL of that attempt's jobs are still queued. Attempt 800 queues both gates and hangs,
attempt 900 completes every check for the same SHA — and 800's undatable runs still sorted first,
so `review-scope` and `battery-plan` stayed pending until timeout and the head returned to draft.

Fix: an unfinished run is dated by when it STARTED. A run that began at 09:00 and is still going
is not more recent activity than one that finished at 11:00. Only a run with no timestamp at all
keeps the sentinel — it cannot be placed, and first is the safe placement for an unfinished run,
since the gate then waits rather than publishing a verdict for a check that is still moving.

The converse is pinned in the same probe: a gate that STARTED after the newest completion is live
activity and does hold the head pending.

That change makes `recency` agree with the gate's own local `newerRunFirst` helper, which already
dated by `completed_at || started_at`. The two were byte-equivalent afterwards, so the local copy
is deleted and the gate imports `newestFirst`. Duplicated ordering rules across these two files
are what produced the round-11 and round-13 findings; this removes the last one.

### Gates

`node --test scripts/autonomous-ci-battery.test.mjs` 22/22 — both new probes RED at `c9e43cf`,
GREEN after, twenty earlier coverage probes unchanged. `pnpm test:automation` 111/111.
`pnpm check` EXIT 0 — web 543/543, API 680/680.
