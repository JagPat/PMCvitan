# PR #257 — architectural convergence

**PR:** #257 · *Loop efficiency: docs-only fast CI + phase plan skeleton limit*
**Branch:** `claude/loop-efficiency-fast-path` · **Base:** `main` `a16e68c`
**Finding-bearing heads:** `c7913a9` (findings 1–4), `596fa99` (findings 5–8), `e9feaf7` (findings 9–10)
**Convergence head:** this commit, from `e9feaf7`

Two finding-bearing heads answered eight Codex findings with isolated patches.
Per `AGENTS.md`, ordinary patching stops there: this head is ONE batched
architectural correction. Every finding was re-verified against the code at
`752968f` rather than taken from the fix commits' claims.

**Five of the eight are genuinely closed at `752968f`.** They are recorded below
with the reason and are now pinned by tests, so a later edit cannot silently
reopen them — but they are not re-fixed, because nothing is wrong with them. The
remaining two open items are corrected here.

## The three concepts behind eight findings

Eight findings, three ideas. Each idea was reported through two or three
different symptoms, which is why patching symptom-by-symptom kept leaving one
site behind.

**Concept 1 — attempt coverage must be computed per required-check scope
(findings 1, 5, 7).** Once `automation` became a battery job, the two batteries
each emit *skipped* jobs for the other's checks. A single "did this attempt
produce any battery run?" question then lets one battery's skips vouch for the
other's evidence, in both directions.

**Concept 2 — the planner and the gate must agree which battery ran (findings 4,
6, 8).** If `battery-plan` launches products while the gate requires
`DOCS_FAST_CHECKS` (or the reverse), the head waits for a job that was never
started and times out with a green battery.

**Concept 3 — the plan cap must be enforced from data that is actually available,
and rechecked by the trusted side (findings 2, 3).**

## Finding-by-finding

### Finding 1 — P1, `c7913a9`: track automation in coverage watermarks

*Codex:* `automation` was treated as a battery product while watermarks were
still built only for `PRODUCT_CHECKS`, so stale automation evidence could clear
the docs-fast gate.

- **Status: CLOSED at `752968f`.** `BATTERY_CHECKS = [...PRODUCT_CHECKS,
  AUTOMATION_CHECK]` and `gateWatermarks` iterates `BATTERY_CHECKS`, so
  `automation` carries a watermark of its own.
- **Pinned by:** `C1c`.

### Finding 2 — P2, `c7913a9`: fail closed when plan diff stats are unavailable

*Codex:* returning an empty list on any `git diff` error made the 900-line cap
disappear, and `actions/checkout@v4` without `fetch-depth` commonly cannot
resolve `base...head`.

- **Status: CLOSED at `752968f`.** `planFileStatsFromDiff` returns
  `{ unavailable: true, stats: [] }` on error, `assessPullRequestScope` blocks
  when a post-#252 PR's plan stats are unavailable, and the `review-scope` job
  checks out with `fetch-depth: 0`.

### Finding 3 — P1, `c7913a9`: recheck the plan cap in the trusted gate

*Codex:* the cap ran only in the PR-side CLI; the trusted owner revalidated scope
without computing plan stats, so a spoofed or regressed PR-side check could still
be promoted.

- **Status: CLOSED at `752968f`.** `enforceReviewScope` calls
  `assessPullRequestScope` with `planStatsFromPullRequestFiles(files)` — the
  trusted side computes the plan stats itself, from the API, and fails closed when
  it cannot.

### Finding 4 — P2, `c7913a9`: keep planner and gate on the same CI path

*Codex:* swallowing a PR-files read failure left `docsOnly` false, so a docs-only
`synchronize` ran the five product jobs and skipped `automation`; a later
successful gate read then required `automation` and waited for a job the workflow
never launched.

- **Status: CLOSED at `752968f`.** The classification failure now sets
  `process.exitCode = 1`, writes `run_products=false; docs_fast_path=false`, and
  RETURNS before the outer catch — the job fails and no mismatched battery starts.

### Finding 5 — P1, `596fa99`: don't let automation skips mark product attempts covered

*Codex:* on a code PR `automation` is created skipped; counting it in
`attemptCharacters` classified the whole attempt as `skipping` and suppressed the
new attempt's product watermark, so attempt-600 products could vouch for a new
merge result.

- **Status: CLOSED at `752968f`.** `attemptCharactersFor(runs, scope)` is computed
  per scope: `[AUTOMATION_CHECK]` for automation, `PRODUCT_CHECKS` for products.
  A skipped `automation` is not in the product scope and cannot mark a product
  attempt as skipping.
- **Pinned by:** `C1` — attempt 700 with green gates and a skipped `automation`
  supersedes all five attempt-600 product successes.

### Finding 6 — P2, `596fa99`: let docs classification failures fail the plan job

*Codex:* the new throw was caught by the same outer handler that converted every
error back into product-only outputs.

- **Status: CLOSED at `752968f`.** Same early return as finding 4; the throw was
  replaced by an explicit failing plan that never reaches the outer catch.

### Finding 7 — P1, `596fa99`: don't let product skips preserve automation coverage

*Codex:* the mirror of finding 5 — on a docs-only retarget the five product jobs
appear skipped, classifying the attempt as `skipping` for every battery check and
clearing the automation watermark, so an older automation success could be
accepted before `pnpm test:automation` ran on the retargeted head.

- **Status: CLOSED at `752968f`.** The same per-scope split; product skips are not
  in the automation scope.
- **Pinned by:** `C1b` — attempt 700 with green gates and five skipped products
  supersedes attempt-600's automation success.

### Finding 8 — P2, `596fa99`: fail consistently when gate file classification is unreadable

*Codex:* an unreadable file list turned the classification into `undefined`, so
`requiredChecksForPullRequest` fell back to the full product battery and the gate
timed out waiting for product jobs the workflow had deliberately skipped.

- **Status: PARTIALLY closed at `752968f`, and the remedy left two problems.**
  `inferRequiredChecksFromRuns` correctly infers the battery from the head's
  check-run history, and `C2c` pins that. But:

  **8a — the product branch was reached through a synthetic file list.**
  `requiredChecksForPullRequest(pullRequestNumber, ['apps/api/src/x.ts'])` fed a
  made-up path to the docs-only classifier to make it answer "not docs". It
  produced the right answer for the wrong reason: the classifier is the wrong
  authority for a caller that has *already established* the head ran products, and
  any future path rule inside `isDocsOnlyDiff` would silently flip the gate to
  docs-fast for every code PR whose files it cannot read.
  **Correction:** `productChecksForPullRequest(pullRequestNumber)` states the
  intent directly and applies pre-policy grandfathering on its own;
  `requiredChecksForPullRequest` delegates to it, so the two cannot diverge.
  **Evidence:** `C2` (no synthetic input; equals the product battery), `C2b`
  (grandfathering survives the inference path).

  **8b — the gate could disagree with ITSELF about which battery ran.** This is
  concept 2 one level in, and it is the finding that was missed. The head's
  cumulative file list is immutable, but the gate read it from four places, each
  with its own `try/catch`: the check-wait loop, the CI-failure branch, the final
  verification, and the scope/convergence checks. A transient files-API failure
  could therefore be observed by some sites and not others *within one run* — the
  wait loop passing on `DOCS_FAST_CHECKS` while the final verification, which is
  what actually sets `codex-current-head`, required the full product battery and
  reported missing product checks. Exactly the planner-versus-gate mismatch
  findings 4/6/8 describe, with both parties inside the gate.
  **Correction:** `classifyHead(client, pullRequest)` resolves the classification
  ONCE per `(pull request, head)` and every consumer reads that one answer.
  An unreadable list is cached as unreadable for the remainder of the run —
  deliberately, so all consumers fail closed identically; a genuinely transient
  failure is retried by the next gate invocation, which builds a fresh client.
  **Evidence:** `C3` (one API call, identical result three times), `C3b` (a
  first-call failure is not silently repaired by a later success mid-run), `C3c`
  (a new head is classified afresh), `C3d` (separate clients do not share a
  cache).

### Finding 9 — P1, `e9feaf7`: infer the battery path from the current attempt

*Codex:* with the file list unreadable, `inferRequiredChecksFromRuns` treated any
non-skipped product run anywhere in the SHA's history as proof of the product
path. With attempt 600 green on products, attempt 700 docs-fast with green gates
and skipped products, and attempt 700's `automation` not yet finished, it returned
the product battery; `summarizeRequiredChecks` then accepted attempt-600 products
because 700's skips are intentional, so `codex-current-head` could go green while
current automation evidence was still missing.

- **Root cause: concept 2 again, at the attempt level.** The inference was scoped
  to the head but not to the attempt, so evidence from a merge result nobody is
  asking about answered a question about the current one.
- **Correction:** `currentBatteryAttempt` selects the newest attempt whose gates
  ALL passed — gates run first and launch the rest, so their completion dates the
  merge result the attempt tests, and an aborted attempt decides nothing.
  `inferRequiredChecksFromRuns` reads only that attempt's runs. Every undecided
  path lands on a required check the current attempt has not produced, so the
  summary reports missing/pending and the gate waits:
  current attempt has real products → product battery; skipped products →
  `DOCS_FAST_CHECKS` (whether or not its `automation` has appeared, because when it
  has not, `automation` is required and only older attempts have runs of it, which
  the automation watermark supersedes); no products at all → product battery, whose
  watermark is the current attempt's gate stamp; no attempt with passing gates →
  product battery.
- **Evidence:** `E1` (the finding's exact interleaving: `DOCS_FAST_CHECKS`, not
  success, awaiting `automation`), `E1b` (current attempt with real products →
  product battery), `E1c` (failed gate ⇒ no current attempt ⇒ fail closed), `E1d`
  (retarget window stays pending), `E1e` (a complete docs-fast attempt IS accepted,
  so the fix is precise and not merely strict).

## Reproduce-first evidence

`scripts/loop-efficiency-convergence.test.mjs`, 18 tests, all GREEN on this head.

### Finding 9 (this round)

Run against `e9feaf7` with `scripts/autonomous-review-gate.mjs` stashed to that
head, through a harness importing only surfaces that exist there:

```
not ok 1 - E1/RED: current-attempt inference must not accept older product evidence
# tests 1 / # pass 0 / # fail 1
```

and after restoring the correction:

```
ok 1 - E1/RED: current-attempt inference must not accept older product evidence
# tests 1 / # pass 1 / # fail 0
```

Directly observed on the same fixture: at `e9feaf7` the inference returns the
seven-check product battery and `summarizeRequiredChecks` reports **`success`**;
on this head it returns `DOCS_FAST_CHECKS` and reports **`pending`** with
`automation` missing.

The two open items are provable against the base source directly. With
`scripts/autonomous-review-gate.mjs` stashed back to `752968f`:

```
not ok 1 - C2/RED: selecting the product battery must not depend on a synthetic docs classifier input
not ok 2 - C3/RED: the PR file list must be fetched in exactly one place
not ok 3 - C3/RED: a per-head classifier is exported
ok   4 - sanity: requiredChecksForPullRequest still classifies a docs list
# tests 4 / # pass 1 / # fail 3
```

and after restoring the correction:

```
ok 1 - C2/RED: selecting the product battery must not depend on a synthetic docs classifier input
ok 2 - C3/RED: the PR file list must be fetched in exactly one place
ok 3 - C3/RED: a per-head classifier is exported
ok 4 - sanity: requiredChecksForPullRequest still classifies a docs list
# tests 4 / # pass 4 / # fail 0
```

The sanity assertion passing at base matters: it shows the base gate was not
broken outright, so the three failures are the specific defects and not a module
that fails to load.

### The five earlier findings — RED-before-fix proof

An earlier revision of this packet said the five findings closed at `752968f`
were "pinned rather than reproduced", and argued that manufacturing a RED for an
already-fixed defect would mean reverting the fix. Codex flagged that (P2 on
`e9feaf7`) and was right: **a green pin proves the current state is correct; it
does not prove the assertion discriminates.** A broken watermark or inference
correction could have been carried forward on the strength of a pin that would
have passed either way. That is exactly the hole reproduce-first exists to close.

`R1`, `R2` and `R3` close it without reverting anything. Each implements the
PRE-FIX algorithm and runs it against the SAME fixture the pin uses, asserting it
produces the unsafe answer, then asserts the shipped code produces the safe one.
The RED and the GREEN are in one test, so the discrimination is demonstrated
rather than asserted:

| Proof | Pre-fix behaviour demonstrated | Shipped behaviour |
| --- | --- | --- |
| `R1` (findings 1/5/7) | `legacyGateWatermarks` — one character set over all battery checks, watermarks for products only: no `automation` watermark exists at all; a skipped `automation` on a code PR leaves all five product watermarks `''` (attempt-600 products accepted); skipped products on a docs retarget leave attempt-600 automation unsuperseded | automation has its own watermark; both fixtures supersede at attempt 700's gate stamp |
| `R2` (findings 4/6) | the outer catch's `{ runProducts: true, docsFastPath: false }` — five product jobs launched, `automation` skipped, while a gate that reads the files successfully requires `automation`, a job that plan never started | the real `run()` with a failing fetch returns `{ runProducts: false, docsFastPath: false }`, writes both outputs, and fails the job |
| `R3` (findings 2/3) | `assessPlanDocumentScope([], …)` allows — an unreadable diff read as "no plan files", so the 900-line cap vanished; and a trusted path computing no plan stats promotes a 1,200-line plan | `planFileStatsFromDiff` returns `{ unavailable: true }`, `assessPullRequestScope` blocks a post-#252 PR on it, and the oversized plan is rejected with the cap message |

These three run on this head, not at `752968f` — they are differential proofs of
the algorithms, not of a repository state, so there is no base to run them
against. That is stated plainly rather than dressed up as a base-commit RED.

One existing structural pin in `autonomous-review-workflow.test.mjs` asserted the
old inline `pullRequestFiles = await client.pullRequestFiles(...)` line inside the
convergence check. It is updated to assert the stronger property the correction
establishes: the convergence check reads the shared classification, and the
endpoint is called in exactly one place in the file.

## Validation

| Gate | Result |
| --- | --- |
| `pnpm test:automation` | see PR body — includes the 10 new assertions |
| `pnpm check` | EXIT 0 |
| Migrations | none in this PR |

## Scope

11 files changed at `752968f`; this head adds the convergence packet and its
suite, edits `scripts/autonomous-review-gate.mjs`, updates one structural pin, and
widens the `test:automation` glob. No product code, no schema, no migration. The
CI workflow, `ci-battery-plan.mjs`, `check-run-coverage.mjs`, `review-scope.mjs`
and `review-efficiency.mjs` are unchanged from `752968f` — their findings are
closed and re-verified, not re-touched.

---

## Round 3 — the two P1 findings on `bd58504`

Both land in `scripts/autonomous-review-gate.mjs`, and both are one concept at two
places: **a battery is named by the merge result it was computed for, and only from
evidence that a job of that battery really ran.** They are corrected together
because fixing either alone leaves the other reachable.

### Finding 11 — P1: the classification cache was keyed by head, not by merge result

*Codex:* "Include the base SHA in the classification cache… a head classified
docs-only on base A can be retargeted to base B where the cumulative diff now
includes code; the old owner run still sees the same `number@head`, keeps requiring
only `automation`."

- **Root cause.** `pullRequestFiles` returns the cumulative diff against the
  *current base*, so the classification identifies a `(base, head)` pair. The cache
  key was `number@head`, which is not that pair.
- **Correction, at both its sites.**
  1. `classifyHead` keys on `number@base..head`, so a retarget is a cache MISS and
     the head is re-classified against the base that now applies.
  2. `waitForRequiredChecks` resolves the battery ONCE before polling, so the base
     it resolved against is part of what that run committed to. It now treats a
     base change exactly as it treats a head change — `superseded`, letting the
     retarget's own event re-evaluate from a fresh client.
- **Site audit.** The other `classifyHead` consumers (`enforceReviewScope`,
  `enforceReviewConvergence`) pass a refreshed pull request, so the widened key
  re-fetches for them without further change. Fixing only the cache would have left
  the wait loop polling with a battery resolved for a base that no longer exists.
- **Evidence.** `G1` (same head, two bases → two classifications; docs-fast against
  A, product battery against B), `G1b` (one merge result is still classified exactly
  once — the widened key does not defeat the one-classification rule), `G1c` (a
  retarget mid-wait returns `superseded`).

### Finding 12 — P1: docs-fast was inferred from product skips alone

*Codex:* "Don't infer docs-fast from product skips alone… skipped product jobs do
not prove the current attempt is docs-fast: a code PR metadata edit… sets both
`run_products=false` and `docs_fast_path=false`, so this workflow creates skipped
product jobs and a skipped `automation` job."

- **Root cause.** `ci.yml` runs `automation` only when `docs_fast_path == 'true'`
  and the products only when `run_products == 'true'`, and `ci-battery-plan.mjs`
  has metadata-edit branches emitting **both false**. Such an attempt skips
  everything, so "products were skipped" is true of it — and the inference read
  that as docs-fast, requiring only `automation` for a head carrying code. Because
  `summarizeRequiredChecks` lets an INTENTIONAL skip defer to older evidence, an
  `automation` run from earlier in the head's life then satisfied it.
- **A false claim in the prior comment, corrected.** That code asserted the
  automation watermark would supersede the older evidence. It does not: the
  watermark comparison is guarded by `isBatteryProductCheck(name)`, and
  `automation` is not a product check, so it never applied. The protection existed
  in the comment only. The comment is now accurate.
- **Correction.** The inference walks the gate-passing attempts newest-first and
  adopts the battery of the first one that actually RAN a job — a real product run
  means the product battery, a real `automation` run means docs-fast, and an
  all-skipped attempt declares nothing and is walked past. If no attempt on the
  head ever ran a battery job, the products are required and the gate waits.
- **Evidence.** `G2` (a head with real product runs plus a later all-skipped
  metadata attempt selects the product battery, and `automation` is not in the
  required set), `G2b` (a head that really ran `automation` still selects docs-fast
  — the fix is precise, not merely strict), `G2c` (no real product evidence on the
  current attempt stays pending).

### Two assertions revised, and why — not edited to fit

`E1` previously asserted this fixture selects `DOCS_FAST_CHECKS`: gates green,
products skipped, `automation` absent. That is **exactly** the shape a metadata edit
on a code PR produces, so the assertion was identifying a battery the evidence does
not establish — the defect itself, pinned. `E1` now asserts the product battery and
adds the property that actually holds: `automation` alone can never answer a code
head. Its original safety concern is preserved in `G2c`, where the current attempt
produced no product run of any name and the watermark keeps the head pending.

A first draft of `G2` also asserted the head "must not go green". That was my
over-reach and is removed rather than softened: attempt 600's product jobs really
ran on that exact SHA and passed, and the metadata attempt skipped its own only
after its plan verified that coverage — so green is correct once the *product*
battery is the one required. The hole finding 12 names is the opposite direction,
requiring the lesser battery for a head that owes the greater one.

### Reproduce-first transcripts

`G1`/`G2` with the inference and the cache key reverted to `bd58504` (the export
kept so the suite still loads):

```
not ok 19 - G1: a retarget re-classifies — the cache is keyed by base AND head (finding 11)
not ok 22 - G2: skipped products alone do NOT name the docs-fast battery (finding 12)
# tests 24 / # pass 21 / # fail 3
```

`G1c` with only the wait-loop base check reverted (`CHECK_TIMEOUT_MS=0`, so the poll
exits immediately instead of running out its ten-minute deadline):

```
not ok 21 - G1c: a retarget mid-wait is superseded, not answered from the old base (finding 11)
# tests 24 / # pass 23 / # fail 1
```

Restored, the suite is 24/24.

### Merge with `main`

`origin/main` (`3849f5c`, carrying merged PR #256) is merged into this branch. One
conflict, in `package.json`: both sides had extended the `test:automation` glob —
this PR with `loop-efficiency*`, #256 with `runner-continuation*`. Resolved as the
UNION of both, because dropping either silently stops running that suite.
