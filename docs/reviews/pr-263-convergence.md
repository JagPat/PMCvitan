# Convergence audit — PR #263 (risk-based CI)

Required by `CLAUDE.md` after two distinct finding-bearing heads. This is an
architectural audit, not a third isolated patch.

| Head | Findings |
| --- | --- |
| `13135fc` | 7 (F1–F7) |
| `50ef5e0` | 3 (N1–N3) |

## Ten findings, two root causes

Seven of the ten are two recurring mistakes, not ten independent bugs.

### Root cause A — "safe by location, not by consumer" (4 instances)

| Finding | Path called safe | What actually consumes it |
| --- | --- | --- |
| F1 | `scripts/` | `scripts/test-api-e2e.sh` **is** the api-e2e runner |
| F3 | `.github/` | `ci.yml` defines every product job's commands |
| F5 | `apps/api/` (generic) | the upgrade-proof job runs `apps/api/scripts/upgrade-proof.sh` |
| N3 | `docs/**.md` | an API integration test reads `docs/RUNBOOK.md` |

Each time I asserted safety from **where a file lives** rather than **what reads
it**, and each fix was a point correction that left the method intact — so the
method produced the next instance. F1/F3 were already "fixed by subtraction" in
round 1, and N3 still appeared, because `docs/` was never re-examined under the
same lens.

**Structural fix (this head):** the safe set is now *self-verifying*. `R18`
scans the real product test sources for reads of any path the classifier calls
safe and fails if one is not in the `DOCS_CONSUMERS` register. Instance five
fails CI instead of shipping. The register currently holds exactly one entry —
verified against the tree, not asserted.

This converts a claim I kept getting wrong into a claim the build checks.

### Root cause B — composition with the existing gate machinery (3 instances)

| Finding | What I reasoned about in isolation |
| --- | --- |
| F6 | a classification skip reads as MISSING to `summarizeRequiredChecks` |
| N1 | a base retarget forces the full battery — and my `&&` silently narrowed it |
| N2 | `battery-plan` counts a FAILED run as coverage; all-skips then reads green |

`classify` does not stand alone: it composes with `battery-plan` (which decides
whether this head is covered) and with the orchestrator (which decides what
"covered" means). I designed the new gate against each of those separately.

**Structural fix (this head):** the three composition points are now explicit
and each has a probe — `R16` (twin publishes the name), `R17` (retarget forces
all, and the twins stand down), `R19` (a battery-plan skip cannot mask a red
head). The remaining three findings (F2 injection, F4 renames, F7 truncation)
are input-pipeline hardening and share no root cause.

## The honest status of the original safety claim

The first packet led with: *unknown widens, so cheaper CI never means weaker CI.*

That claim was **overstated**, twice over:

1. It is only as strong as the *known* set, and the known set was wrong four times.
2. F2 showed the widening path was itself a narrowing primitive — an unknown
   filename containing `\nsuites=` could blank the output.

Both are now closed, and the claim is no longer a matter of my judgement: the
safe set is enforced by `R18` against the real tree, and the output is
unforgeable by construction. That is the difference between this head and the
previous two.

## Was abandoning the right call instead?

Considered seriously, because the alternative to converging is stopping.

Against: statically deciding test impact is a genuinely hard problem, normally
solved with dependency analysis rather than a hand-written map — and my map was
wrong four times.

For continuing: the consumer-scan makes the failure mode *loud* rather than
silent, which is the property that was missing. A wrong map that fails CI is
categorically different from a wrong map that skips a suite quietly. With that
in place the residual risk is bounded by something the build checks, not by my
inspection.

If the next review is still finding-bearing on the classifier's *safety* (rather
than its plumbing), the recommendation flips to abandoning path-based
classification and keeping only the `quality-gate` consolidation, which has
been finding-free since it was introduced.

## Verification

| Gate | Result |
| --- | --- |
| focused suite | **29/29** (20 → 26 → 29 across the three heads) |
| `pnpm test:automation` | **200/200** |
| `pnpm check` | see the commit; EXIT 0 |

Each of the three new fixes reverted in turn fails its own probe (`R17`, `R18`,
`R19`); the five from round 1 remain discriminated.

---

## Head 3 (`e55f17f`) — one finding, and it belongs to root cause B

| Head | Findings |
| --- | --- |
| `13135fc` | 7 |
| `50ef5e0` | 3 |
| `e55f17f` | **1** |

The finding is in `ci-prior-evidence.mjs` — code introduced by the round-2 fix
for N2. `battery-plan` also skips the products when the first battery for this
head is still QUEUED or IN PROGRESS ("coverage already in flight"). The reader
filtered to completed runs only, reported `no completed run`, and the gate
published a **terminal failure** while those very jobs were still going green —
blocking exact-head review until some unrelated event fired.

**This is root cause B again, and it is a pointed one.** `assessQualityGate`
exists precisely to separate *never reached a verdict* from *failed* — that
distinction is the reason `cancelled` blocks and `skipped` does not. I then
wrote its evidence reader, in the same change, with a two-state model that
collapses exactly that distinction. The principle was stated correctly one file
away from where it was violated.

**Fix:** `pending` is a first-class outcome, and the runner WAITS it out rather
than converting it into a verdict:

| Evidence | Outcome |
| --- | --- |
| every product green | pass |
| any product red | **fail immediately** — a sibling finishing cannot turn a red check green |
| any product queued/in-progress (none red) | **pending** → poll until it lands |
| still pending after the bounded wait | fail closed, saying it is undecided |
| history unreadable | fail, not pending |

Probes `R20` (three-state), `R20b` (polls, then reports what the battery
actually concluded), `R20c` (bounded wait fails closed). Each of the three
mechanisms reverted in turn fails its own probe.

### Trend

Findings per head: **7 → 3 → 1**, with the root causes now closed by enforcement
rather than by inspection (`R18` for A; `R16`/`R17`/`R19`/`R20` for B). The rate
is declining and each round has been strictly narrower than the last, which is
the convergence signal the protocol looks for. The abandonment condition
recorded above — a finding against the classifier's *safety* rather than its
plumbing — has not triggered: head 3's finding is in the gate's evidence
plumbing, not in path classification.

---

## Head 4 (`31aa615`) — two findings, one omission

Findings per head: **7 → 3 → 1 → 2**. The "declining" trend I asserted after
head 3 was premature, and this section corrects it.

Both findings are the same omission: `classify` became a third upstream gate in
the workflow, and I never registered it in the shared coverage model
(`check-run-coverage.mjs`).

| # | P | Defect | Fix |
| --- | --- | --- | --- |
| N5 | P1 | `GATE_CHECKS` knew only `review-scope`/`battery-plan`, so an attempt where **classify failed** still counted as "gates passed" — its skipped products read as a deliberate covered-head skip, and a later metadata edit accepted the OLD base's successes as evidence | `classify` registered as a gate |
| N4 | P2 | `assessPriorEvidence` asked "is any run unfinished?" *before* ordering by attempt currency, so one hung job from a superseded attempt pinned the suite `pending` forever | decider chosen by `coverageOrder` first; only unfinished runs from the decider's attempt or newer count |

Registering the gate surfaced a **third defect that neither finding named**:
`attemptsWithPassingGates` required every gate to be *present* (`=== true`), so
adding `classify` marked every pre-classify attempt aborted — five existing
tests failed, and they were right to. The invariant its own comment states is
"a gate that FAILED aborts the attempt", so the check is now `!== false`:
presence-tolerant, failure-strict. Same stranding shape that kept the new jobs
out of `REQUIRED_CHECKS`, caught here by the existing suite rather than in
production.

Probes `R21`/`R21b` (currency both directions), `R22` (classify gates,
fail/cancel/green), `R22b` (legacy attempt not stranded). Each of the three
mechanisms reverted in turn fails its own probe.

### Where this leaves the abandonment question

The condition recorded above — a finding against the classifier's *safety*
rather than its plumbing — still has not triggered. But the honest pattern is
now visible: **six of the last seven findings are in the evidence/gate plumbing
that exists only to make skipping safe**, and that plumbing is being fitted to a
coverage model written before skips existed. Each round has found another seam.

This head closes the seam at its source: `classify` is now a first-class gate in
the shared model rather than a workflow-only condition, which is what made N4,
N5 and the presence regression all expressible at once. If the next round finds
another plumbing seam, the recommendation flips to shipping `quality-gate`
alone — it has drawn zero findings as a summariser across four heads — and
dropping the classification skip until it can be built against a coverage model
that understands it.

---

## Head 5 (`c1a9426`) — the pre-registered rule fires; the classifier is withdrawn

| Head | Findings | |
| --- | --- | --- |
| `13135fc` | 7 | classifier map + input pipeline + gate composition |
| `50ef5e0` | 3 | classifier map + gate composition |
| `e55f17f` | 1 | evidence plumbing |
| `31aa615` | 2 | evidence plumbing |
| `c1a9426` | **1** | evidence plumbing |
| **total** | **14** | **7 in plumbing that exists only to make skipping safe** |

Head 5's finding: a newer in-flight RERUN of a failed check is treated as
coverage by `battery-plan`, but the reader picks the completed decider and
finalises the old failure. It is the direct consequence of head 5's own fix,
which moved the currency check ahead of the in-flight check.

That is the third consecutive round where **my previous round's fix caused the
next finding**. The condition recorded after head 4 — "if the next round finds
another plumbing seam, ship `quality-gate` alone" — is met exactly, so it is
executed rather than re-argued. Re-arguing is what the pre-registration exists
to prevent: "the remaining fix is small" was equally true at heads 3, 4 and 5.

### What ships

`quality-gate`, the single required status. **Zero findings across five heads.**
It has no classifier, no evidence reader and no notion of a suite that cannot be
affected — it summarises what the jobs actually reported, on a whitelist where
anything that is not an explicit success or explicit skip blocks. This is the
half of step 4a that step 5 (narrowing branch protection) actually depends on.

Also kept: the `automation` job, and four pre-existing pins re-anchored from
text position onto the dependency they protect.

### What is withdrawn

`classify`, the five compatibility twins, `ci-risk-classify.mjs`,
`ci-prior-evidence.mjs`, the `force_all` retarget override, and the `classify`
entry in `GATE_CHECKS` — reverted to its original two, since the third gate no
longer exists. `G8` asserts the removal is real: a leftover reference fails,
because half-removed plumbing that is still reachable while its probes are gone
is worse than either shipping or removing it.

**All seven plumbing findings become inexpressible rather than fixed.**

### Why this is not simply "it was too hard"

The classifier's own findings (F1/F3/F5/N3 — safe-by-location) were closed
properly, and `R18`'s enforced consumer scan was a real structural fix. What did
not converge is the *seam*: skipping is being fitted to a coverage model
(`check-run-coverage.mjs`) that predates it and encodes "a product check either
ran or did not". Every plumbing finding is a state that model has no word for —
in-flight, superseded, rerun-in-progress.

### What a future attempt needs

Not a better path map. A coverage model that carries per-suite *applicability*
as a first-class state alongside ran/skipped/failed, so "not applicable to this
change" is expressible in the same vocabulary the orchestrator already reasons
in. Built there, the seven findings above do not arise. Built on top, as here,
each one is a separate patch and the next is always one round away.

The work is preserved in this branch's history (`13135fc`..`c1a9426`) and in the
probes `R1`–`R22b`, which remain a correct specification of what a classifier
must satisfy.

---

## Blocking precondition for step 5 (branch protection)

The withdrawal removed the evidence check that mitigated finding **N2**, so N2
is live again in what ships. It is **safe today and unsafe the moment branch
protection narrows to `quality-gate` alone.**

The mechanism, verified in `ci-battery-plan.mjs`:

```js
if (decider.status !== 'completed') return true;
if (decider.conclusion === 'cancelled') return false;
// a FAILED run falls through here and counts as coverage
```

`coveredBy` deliberately excludes `cancelled` and deliberately does **not**
exclude `failure`. So after a red product run, a later title/body edit yields
`run_products=false`, every product job skips, and `assessQualityGate` — which
accepts a deliberate skip — reports **green**.

That is coherent **only while the five product checks are individually
required**: the red `api` check blocks the merge on its own, and re-running it
would be waste. `battery-plan`'s semantics assume exactly that.

**So step 5 must do one of these, not merely swap the required set:**

1. Keep the five product checks required alongside `quality-gate` — smallest
   change, keeps `battery-plan`'s assumption true, loses the "one required
   status" simplification.
2. Make `coveredBy` treat a FAILED decider as not-covering, so a red head always
   re-runs. One condition, but it changes behaviour an existing battery test
   pins deliberately, and costs a full battery on every edit after a failure.
3. Reinstate an evidence check in `quality-gate`. This is what heads 3–5 kept
   getting wrong; do not attempt it without the applicability-aware coverage
   model described above.

Option 1 is the recommendation for step 5 as a standalone change: it is the only
one that adds no new state, and `quality-gate` still becomes the status the
orchestrator and humans read.

This is recorded here because the previous head's summary claimed step 5 was
unaffected. It is not — it is gated on this choice.


---

## Head 8 (`0f480c1`) — Codex independently reaches the same N2 exposure

Codex found the exposure the previous head had already documented, and proposed
the gate verify preserved evidence or force a rerun. Both remedies were examined
against the code rather than accepted or dismissed on principle.

**Force a rerun** contradicts a deliberate, well-reasoned pin in
`autonomous-ci-battery.test.mjs`:

> failed runs are still REAL runs — a body edit re-runs nothing; the fix for red
> products is a new SHA (with its own battery), not a metadata edit

That reasoning is correct: re-running an unchanged tree reproduces the same red.
Changing it would burn a full battery on every metadata edit after a failure.

**Verify preserved evidence** is what heads 3, 4 and 5 attempted; three
consecutive rounds where each fix caused the next finding. Not re-attempted
without the applicability-aware coverage model.

**What Codex is right about** is narrower and real: the pull request advertised
this check as *"the ONE required status"* while it cannot safely be that. The
defect is in the CLAIM, so the claim is what changed — in the code, not only in
the docs.

The gate is now a SUMMARY status. When `run_products` is false it still passes,
because the standing product checks are the authority and a red one blocks the
merge on its own — but it says exactly that:

> `the product jobs were not re-run because this head is already covered, so the
> standing product checks remain the authority — this gate has NOT verified them`

Nobody reading a pass can now take it as "the suites were verified on this
event", and the deferral is a first-class field (`deferred`) rather than prose,
so a future consumer can branch on it. `G10` pins the message, the field, that a
failure in the current run still blocks regardless, and that the CLI surfaces it.

This does not make the check sufficient on its own. It makes it honest about not
being sufficient, which is the most that is available without the coverage model.
The step-5 precondition above is unchanged and is now also enforced by what the
gate prints on every deferred run.
