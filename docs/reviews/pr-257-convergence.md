# PR #257 — architectural convergence

**PR:** #257 · *Loop efficiency: docs-only fast CI + phase plan skeleton limit*
**Branch:** `claude/loop-efficiency-fast-path` · **Base:** `main` `a16e68c`
**Finding-bearing heads:** `c7913a9` (findings 1–4), `596fa99` (findings 5–8)
**Convergence head:** this commit, from `752968f`

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

## Reproduce-first evidence

`scripts/loop-efficiency-convergence.test.mjs`, 10 tests, all GREEN on this head.

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

The five closed findings are pinned rather than reproduced. Writing a RED
fixture for a defect that is already fixed would mean reverting the fix to
manufacture one; the honest artifact is a test that fails if the fix is ever
removed, which is what `C1`, `C1b`, `C1c` and `C2c` are.

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
