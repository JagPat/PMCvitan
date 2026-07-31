# Review packet — risk-based CI and the single required gate

> ## STATUS: the classifier described below was WITHDRAWN
>
> Everything from "The change" to "What this deliberately does not do" describes
> the risk-based path classifier as it stood at head 1 (`13135fc`). It is kept as
> the historical record of what was attempted and why.
>
> **It is not what ships.** After 14 findings across five heads — seven of them in
> the evidence plumbing that existed only to make skipping safe — the classifier
> was withdrawn and only `quality-gate` remains.
>
> For what actually ships, read `docs/reviews/pr-263-convergence.md`, which also
> records the blocking precondition for step 5: withdrawing the classifier removed
> the mitigation for finding N2, so branch protection must NOT narrow to
> `quality-gate` alone without first choosing one of the three options set out
> there.
>
> Claims below that are now false, and are retained only as history: that
> `classify` gates the product jobs; that the compatibility twins exist; the
> `R1`–`R22b` probe counts; and "this pull request runs the full battery because
> it touches `package.json`" (there is no classifier to widen).

**Replaces #257.** That pull request carried this concern together with review-unit
size limits; three correction rounds went by without either closing. This is the
first of its two replacements.

## The change

Every pull request currently runs the whole battery — web, e2e, api, api-e2e and
upgrade-proof, two PostgreSQL services and two Playwright installs — including a
pull request that edits only `docs/STATUS.md`. None of that can fail for a
Markdown edit.

Two independent questions now gate the product jobs, composing by AND:

| Question | Job | Existing? |
| --- | --- | --- |
| Has this exact head already been tested? | `battery-plan` | yes, unchanged |
| Can this **change** break the suite at all? | `classify` | new |

And one new required status, `quality-gate`, summarises everything.

## The safety argument

The asymmetry is the whole design. Skipping a suite that could have caught a
defect is the failure that matters; running a suite that could not possibly fail
is only waste. So the classifier is a **subtraction under certainty**:

> Any path that matches no classification rule makes the result UNCONFIDENT, and
> an unconfident result runs everything.

Checked before any suite logic, so one unrecognised path outweighs any number of
known-safe ones (`R7b`). A new top-level directory, a new root config, a tool
nobody has classified — all widen. `package.json` and the lockfile are
deliberately **not** classified, because they change what every suite installs
(`R8`). An empty or unreadable file list is "we could not tell", never "nothing
changed" (`R8b`).

`packages/shared` is cross-cutting, not web. Both apps import it at runtime, and
a shared contract edit is precisely the change that breaks the API typecheck —
classifying it as web was the first draft and `R6` now prevents it.

## The gate, and the four states it must tell apart

A product job can end up not-green for four reasons and only two are acceptable:

| Result | Cause | Verdict |
| --- | --- | --- |
| `success` | ran and passed | pass |
| `skipped` | the classification excluded it, **or** `battery-plan` found this head already covered | pass |
| `failure` | a real failure, or an upstream gate failing and skipping everything below | **fail** |
| `cancelled` | superseded or cancelled — never reached a verdict | **fail** |

So the rule is a **whitelist**: anything that is not an explicit success or an
explicit skip blocks, which means a result GitHub introduces later that this code
has never seen also blocks (`R14`). `if: always()` on the gate is load-bearing —
without it a failing job would *skip* the gate, and a skipped required check is
not a failing one, so the pull request would sit forever instead of being refused.

## Review unit

| | |
| --- | --- |
| Base SHA | `503b10c` (`main`) |
| Replaces | #257 (first of two) |
| Concern | one: which suites a change can break, and one status that says so |
| Migrations | none |
| Product surface | none — `.github/`, `scripts/`, `package.json` |

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | None — no auth, membership, org or project scoping touched. The `classify` job takes read-only `contents`/`pull-requests` scopes and reads one file list | No `apps/api` or `apps/web` source in the diff |
| civil-time-lifecycle | None — no dates, deadlines or civil-time logic. The classification is a pure function of path strings | `R1`–`R10b` are all path-only; no clock is read |
| concurrency-idempotency | The classifier runs per event and must give the same answer for the same change regardless of the order GitHub lists files | `R10b` pins order-invariance; the suite list is emitted in canonical order |
| data-integrity-conservation | The conserved property is COVERAGE: no suite that could fail may be skipped | `R7`/`R7b`/`R8`/`R8b` (unknown widens), `R6` (cross-cutting), `R5` (migrations reach the upgrade proof), `R13`/`R13b`/`R14` (the gate refuses anything unproven) |
| offline-reconciliation | None — no client outbox, IndexedDB or replay path touched | No `apps/web` source in the diff |
| ui-server-parity | None — no UI, API response, DTO or contract changes | `pnpm check` runs the full web (543/543) and API (680/680) suites unchanged |

## Verification

`scripts/ci-risk-classification.test.mjs` — **20/20**.

The suite is wired into `pnpm test:automation` in the same commit. It was written
before that wiring existed and would not have run in CI — a test nothing runs
proves nothing, so the glob change is part of the unit rather than a follow-up.

### Discrimination — each mechanism reverted in turn

| Reverted | Probes that failed |
| --- | --- |
| unknown paths no longer widen | `R7`, `R7b`, `R8` |
| `packages/shared` classified as web-only | `R6` |
| the gate accepts anything that is not an explicit failure | `R13`, `R14` |
| `quality-gate` drops `if: always()` | `R15` |
| a product job not gated on the classification | `R15` |
| the automation suite gated on the classification | `R15b` |
| — restored — | **20/20** |

| Gate | Result |
| --- | --- |
| focused suite | **20/20** |
| `pnpm test:automation` | **191/191** |
| `pnpm check` | **EXIT 0** (web 543/543, API 680/680) |
| Migrations | none |

**This pull request runs the full battery**, because it touches `package.json`,
which the classifier deliberately treats as unknown. That is the rule working on
its own change rather than an exception carved for it.

## Three pre-existing pins re-anchored, not weakened

Each asserted a property of a **text region** and broke when a correctly-gated job
was added to that region — while the property they protect was untouched.

| Pin | Was | Now |
| --- | --- | --- |
| battery-plan gating | matched the whole `job:\nneeds:\nif:` block verbatim; a second `if` condition made it multi-line | asserts the job *depends on* battery-plan and *consults* its output |
| battery-plan is cheap | asserted nothing between it and `web:` installs anything | scoped to the battery-plan job alone |
| review-scope ordering | asserted nothing between it and `web:` installs anything | scoped to review-scope itself, **plus** an explicit check that every expensive job declares `review-scope` in `needs` |
| product `needs` array | matched the literal `[review-scope, battery-plan]` | set membership, so a third dependency does not fail a pin about the first two |

Each is now anchored on the dependency relation it exists to protect, which is
strictly stronger than the positional form it replaces. This is the fourth time
in this workstream a position-coupled pin has broken on an unrelated edit; the
re-anchoring is the fix, not a workaround.

## What this deliberately does not do

- Does **not** change branch protection. `quality-gate` is published here;
  requiring it (and dropping the individual product checks) is the owner's step 5.
- Does **not** add `classify`/`automation`/`quality-gate` to `REQUIRED_CHECKS`.
  That is the ORCHESTRATOR's wait list, and names an older branch cannot emit
  would strand it. **Honest gap until step 5:** the orchestrator does not wait for
  the `automation` job, so a head could reach Codex with those tests still
  running. They take seconds and gate nothing the product jobs do not. An earlier
  draft did add them, needed a second rollout watermark, and broke eight
  orchestrator fixtures — a blast radius the concern does not justify inside this
  unit.
- Does **not** implement review-unit size limits. That is the second replacement
  for #257, and it must reconcile the 3-head code rule with the already-merged
  `RESTRUCTURE_AFTER_FINDING_HEADS = 5` rather than leaving two disagreeing caps.


---

# Correction round 1 — seven Codex findings on head `13135fc`

All seven confirmed. Reproduced before fixing; each fix discriminated by reverting it.

## What the findings say collectively

Three of them — F1 (`scripts/test-api-e2e.sh`), F3 (`.github/workflows/ci.yml`),
F5 (`apps/api/scripts/upgrade-proof.sh`) — are **one defect found three times**:
I hand-wrote a path→suite map from an unverified model of the build graph, and
it is wrong wherever a RUNNER lives outside the tree it drives.

That materially weakens the safety argument the first version led with. "Unknown
widens" is only as strong as the *known* set, and the known set was wrong in
three places. Worse, F2 showed the widening path itself was a narrowing
primitive: the unknown-path branch embeds a filename in an output, and a
filename containing a newline could redefine `suites`. **The exact case that must
run everything was the case that could be made to run nothing.**

## The fixes

| # | P | Finding | Fix |
| --- | --- | --- | --- |
| F1 | P1 | `scripts/` blanket-safe, but `test-api-e2e.sh` IS the api-e2e runner | Safety is now an ALLOWLIST: only `scripts/*.mjs` (covered by `test:automation`) is safe. Every `.sh` widens. |
| F3 | P2 | `.github/` blanket-safe, but `ci.yml` defines every product job | Only `.github/**/*.md` is safe. Workflows widen. |
| F5 | P1 | `apps/api/scripts/upgrade-proof.sh` missed `upgrade-proof` | Specific rule before the generic one; API scripts reach all three API suites. |
| F4 | P1 | Renames dropped `previous_filename` | Both sides classified — renaming API source to docs REMOVES API source. |
| F2 | P1 | Filename with newline could redefine `suites` in `$GITHUB_OUTPUT` | `reason` reduced to a safe alphabet, capped, emitted last. A filename cannot introduce a line break or an `=` at all. |
| F7 | P2 | >3000 files: the API cap looks like a short final page | Compared against the PR's declared `changed_files`; a short listing throws and widens. |
| F6 | P1 | A classification skip reads as MISSING to the orchestrator | Compatibility twins (below). |

F1/F3 are fixed **by subtraction**: two directory-wide safety claims removed and
replaced with the narrow claims I can actually prove.

## F6 — the one that blocked the whole change

`summarizeRequiredChecks` finds a `decider` — the newest completed run that is
not a deliberate skip. A classification skip HAS passing gates, so
`intentionalSkip` is true, no decider is found, and the check counts as
**missing**. The head then sits pending until timeout and never reaches the
exact-head Codex review: **a docs-only pull request could never merge.**

This means the unit boundary in the original packet was wrong. I wrote that not
touching the orchestrator kept the change small; in fact you cannot introduce
skips without teaching the waiter about skips.

Fixed with a **compatibility twin** per suite: a second job carrying
`name: <suite>`, running on exactly the negated condition. One of the two always
runs, so the check name is always published and every existing waiter is
unaffected — no orchestrator edit, no second rollout watermark, and narrowing
branch protection stays a separate change that can delete these twins.

The twin reports **"the suite did NOT run"** and prints the classification
reason. It does not claim the suite passed — that would be the dishonest version
of this fix, and `R16b` pins the wording.

## Verification

| Gate | Result |
| --- | --- |
| focused suite | **26/26** (was 20; +6 for the findings) |
| `pnpm test:automation` | **197/197** |
| `pnpm check` | **EXIT 0** (web 543/543, API 680/680) |

### Discrimination — each new fix reverted in turn

| Reverted to the defect | Probe that failed |
| --- | --- |
| `scripts/` blanket-safe (F1) | `R2a` |
| `.github/` blanket-safe (F3) | `R2b` |
| API scripts fall through to the generic rule (F5) | `R2c` |
| renames drop `previous_filename` (F4) | `R2d` |
| compatibility twin stops publishing the suite name (F6) | `R16` |
| — restored — | **26/26** |
