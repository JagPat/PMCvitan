# PR #256 — architectural convergence

**PR:** #256 · *Autonomous handoff hygiene: runner continuation + daily-log flake fix*
**Branch:** `claude/runner-handoff-hygiene` · **Base:** `main` `a16e68c`
**Finding-bearing heads:** `b967f29` (findings 1–3), `2919e32` (findings 4–5), `ab7f4dc` (finding 6)
**Convergence head:** this commit, from `ab7f4dc`

Two finding-bearing heads answered five Codex findings with isolated patches.
Per `AGENTS.md`, ordinary patching stops there: this head is ONE batched
architectural correction. Nothing is dismissed — all five findings were
verified against the code at `baa919a` rather than taken from the fix commits'
claims, and three of them turned out to be incompletely closed.

## What the isolated patches got wrong, structurally

Three root causes account for every open item. Each is a case of a rule being
applied at one site while the concept it belongs to lives at several.

**Root cause A — one `now` served two authorities with different sources.**
`loadContinuationContext` substituted the *last* open PR head's STATUS for the
default branch's and handed that single value to both the post-merge handoff and
the drift detector. These are different questions: the post-merge handoff asks
"given the STATUS that merged into `main`, what is next?" (only the default
branch answers that); drift asks "does the default branch disagree with live
GitHub state, uncorrected?" (that needs the open heads too). Collapsing them left
finding 1 half-closed and introduced a new defect in the post-merge path.

**Root cause B — the live PR set and STATUS were confused as the shepherd
authority.** Findings 2 and 5 were patched in opposite directions. Finding 5's
remedy (`!hasOpenPrs → false`) is correct and sufficient on its own; the extra
`open_pr`-must-match condition re-opened finding 2 for exactly the drifted case.

**Root cause C — a recovery path keyed to nothing.** Finding 4's fix used a
constant marker, making the no-live-PR shepherd one-shot for the repository's
lifetime.

## Finding-by-finding

### Finding 1 — P2, `b967f29`: drift flagged from default-branch STATUS only

*Codex:* the hourly `schedule` checkout is pinned to the default branch, so it
cannot see the STATUS update the open PR's own head already contains; a draft PR
that sets `open_pr` in its head while `main` still says `none` produces a false
drift shepherd, repeated after each pushed fix.

- **Root cause:** A. The correction at `baa919a` read STATUS from the PR head —
  but only from `openPullRequests[length - 1]`, the highest-numbered PR. With
  #252, #256 and #257 all open, a STATUS fix in flight on #252 is invisible and
  the cron still posts false drift. The finding's *example* (one open PR) became
  the specification; the rule it exemplified (the default branch legitimately lags
  in-flight work) was not applied generally.
- **Correction:** `detectStatusDriftAcrossHeads({ defaultBranchNow, headStatuses,
  openPullRequests })` evaluates the default branch first, then suppresses the
  drift if **any** open head's STATUS already records reality, reporting which PR
  carries the correction. `openHeadStatuses` reads every open head, not one.
- **Evidence:** `A1` (three-PR case, correction on the non-newest head, asserts
  `drift: false` + `correctingPullRequest: 252`), `A1b` (`buildDriftHandoff`
  returns `null`), `A1c` (drift still fires when no head records reality — the
  fix suppresses false positives without going blind).

### Finding 2 — P2, `b967f29`: do not request a new branch when a PR is already active

*Codex:* with `openPullRequests` non-empty the post-merge comment reports an open
PR and then unconditionally tells Claude to create the next `claude/**` branch,
which can start a competing branch instead of shepherding the active PR.

- **Root cause:** B. `baa919a` gated shepherding on STATUS agreeing with the live
  set, so when `open_pr` drifts to `none` while PRs are live — precisely the state
  the drift detector exists to catch — the message still said "create the next
  branch". The fix removed the competing-branch instruction for the coherent case
  and left it for the incoherent one.
- **Correction:** `shouldShepherdOpenPullRequests({ openPullRequests })` returns
  true iff at least one live open autonomous PR exists. The live PR set is the
  only authority on whether something exists to shepherd; STATUS disagreement is
  reported as drift, never as a reason to open a competing branch.
- **Evidence:** `B1` (predicate), `B1b` (live PRs + `open_pr: none` ⇒ shepherd
  text present, "Create the next same-repository" absent, drift still reported).

### Finding 3 — P2, `b967f29`: detect stale non-none `open_pr` values

*Codex:* the drift check exited "no drift" for any non-empty `open_pr` without
checking it is one of the live autonomous PRs, so `open_pr: 251` after #251 closed
kept the shepherd silent and post-merge messages resolving to `pr:251`.

- **Root cause:** the original omission; correctly closed at `2919e32`.
- **Correction:** none needed. `detectStatusDrift` compares `open_pr` against the
  live PR numbers and reports staleness. Retained unchanged and now composed
  inside `detectStatusDriftAcrossHeads`, so the same comparison governs both the
  default branch and every head.
- **Evidence:** the pre-existing `detectStatusDrift flags stale non-none open_pr
  values` test still passes; `A1c` exercises the composed path.

### Finding 4 — P2, `2919e32`: handle stale `open_pr` when no PR is live

*Codex:* with a closed PR recorded and no live `claude/**` PRs, `buildDriftHandoff`
returns a body while `openPullRequests` is empty, then `primary.head.sha` is
dereferenced and the hourly workflow crashes before posting any correction.

- **Root cause:** the crash itself was closed at `baa919a` (`if (!primary)` posts
  to the state issue instead). Root cause C remained: the marker was the constant
  `<!-- autonomous-status-drift:status-only:`, so the dedupe matched on *any*
  prior status-only shepherd. The first occurrence in the repository's life
  silenced every later one, including a different stale value months later. The
  loop would stay pointed at stale work with no recovery — the same class of
  failure the finding was about, one step downstream.
- **Correction:** the marker is keyed to the drifting state
  (`status-only:<stale open_pr>`), matching the discipline the live-PR path already
  used (keyed to head SHA). Same state ⇒ one shepherd; different state ⇒ a fresh one.
- **Evidence:** `C1` (marker contains `status-only:251`), `C1b` (same value
  deduplicated; a later `263` drift posts rather than being swallowed), `C1c`
  (the live-PR path still posts on the PR keyed to its head SHA).

### Finding 5 — P2, `2919e32`: do not treat stale `open_pr` as a live branch

*Codex:* after a clean merge the just-merged STATUS can still say `open_pr: <that
PR>` while `openPullRequests` is empty; `assessRunnerState` returns `pr:<that PR>`
and the message says "shepherd it" though its own open-PR list is `none`,
stalling the runner instead of advancing.

- **Root cause:** the original omission; closed at `baa919a` by the `!hasOpenPrs`
  guard, which the new predicate preserves as its whole body.
- **Correction:** behaviour retained. The stale-`open_pr` note in the
  advance branch is kept, so the runner is told to clear it before starting work.
- **Evidence:** `B1c` (no live PRs + `open_pr: 251` ⇒ advance text, no shepherd
  text, explicit "clear stale `open_pr: 251`").

### Additional defect found by the audit (not Codex-reported)

**The post-merge next step could be computed from an unrelated branch's STATUS.**
Introduced by finding 1's patch: because `authoritativeStatusForDrift` replaced
`now` wholesale, a merged PR's continuation comment derived its next step from
whatever the newest open PR's head happened to say. After #252 merged with #257
open, the runner could be handed a next step that never merged.

- **Correction:** root cause A's split. `loadContinuationContext` returns
  `defaultBranchNow` (used by the post-merge handoff) alongside `headStatuses`
  (used only for drift suppression).
- **Evidence:** `A2` (main says `open_pr: none`/`merged`, head #257 says
  `open_pr: 999`; asserts `defaultBranchNow.open_pr === 'none'`, the head status is
  captured separately, and the rendered message does **not** carry
  `Runner next step: pr:999`), `A2b` (an unreadable head degrades to `now: null`
  and cannot suppress drift — the fail-safe direction).

### Finding 6 — P2, `ab7f4dc`: derive the next step after clearing stale `open_pr`

*Codex:* with `open_pr: 251` recorded and no live autonomous PRs,
`assessRunnerState()` still returns `pr:251`, so the handoff publishes
`Runner next step: pr:251` even though the same comment says the open-PR list is
`none` and to create the next branch — sending the runner back to a closed PR
instead of advancing STATUS after a clean merge.

- **Root cause: D — the displayed next step was assessed from a record the drift
  detector had just declared wrong.** The convergence head made the drift
  *detection* authoritative and the shepherd *decision* authoritative, but left
  the next-step *display* reading raw `statusNow`. `assessRunnerState` checks
  `open_pr` before anything else, so a stale value wins there regardless of what
  the rest of the comment concludes. One message then carried two contradictory
  instructions, and the contradictory one was the actionable line.
- **Reproduced at `ab7f4dc`** before fixing, rendering the real message:

  ```
  **Runner next step:** `pr:251` — an open PR is the current work item until it merges or closes
  **Open autonomous PRs:** none
  **STATUS drift:** docs/STATUS.md records open_pr: 251 but that PR is not among the live autonomous PRs.
  Create the next same-repository `claude/**` branch and draft PR with Auto-fix enabled.
  **Note:** clear stale `open_pr: 251` in STATUS before starting new work.
  ```

- **Correction:** `assessDriftCorrected(statusNow, maintenanceQueue, drift)` assesses
  from `{ ...statusNow, open_pr: drift.suggestedOpenPr }` — the value the drift
  correction already computed — and returns the raw assessment separately so it can
  be shown, explicitly labelled stale, without being the instruction. The finding
  offered either remedy ("compute from the drift-corrected state **or** label this
  value as stale"); both are applied, because an operator still needs to see what
  STATUS currently claims. The label is emitted only when correcting actually
  changes the answer, so it is never noise. Applied to `buildDriftHandoff` too,
  where drift is true by construction and the same contradiction existed under the
  softer `Recorded next step:` heading.
- **The corrected state gives the right answer in all three shapes**, verified
  directly against `assessRunnerState`: stale-cleared + `merged` →
  `next_task:phase-5-planning` (agrees with "create the next branch"); correction
  pointing at a live PR → `pr:<that PR>` (agrees with "shepherd it"); `in_review`
  with no PR → not actionable, with the honest reason that STATUS defines that
  state by its open PR. The last case matters: the record IS broken there, and the
  comment now says so instead of naming phantom work.
- **Evidence:** `D1` (stale + no live PR: corrected step published, `pr:251`
  absent from the instruction, present as stale, consistent with the branch
  advice), `D1b` (correction points at a live PR), `D1c` (no drift ⇒ assessment
  untouched, nothing labelled stale), `D1d` (broken record reported honestly),
  `D2` (the drift handoff derives the same way and the old unqualified
  `Recorded next step:` label is gone).

## Reproduce-first evidence

`scripts/runner-continuation-convergence.test.mjs`, 16 tests, all GREEN on this
head.

### Finding 6 (this round)

The five `D*` assertions were run against `ab7f4dc` with
`scripts/runner-continuation.mjs` stashed back to that head:

```
not ok 1 - D1: a stale open_pr with no live PR does not publish the stale next step
not ok 2 - D1b: the corrected step names a live PR when the drift correction points at one
ok   3 - D1c: with no drift the assessment is untouched and nothing is labelled stale
not ok 4 - D1d: correcting a broken record reports it honestly rather than inventing a step
not ok 5 - D2: the drift handoff also derives its step from the corrected state
# tests 5 / # pass 1 / # fail 4
```

`D1c` passing at base is correct and is stated rather than hidden: it is the
no-drift control, which was already right and must stay right — the fix must not
start labelling things stale when nothing drifted.

### Findings 1–5 (earlier rounds)

Three assertions use only surfaces that exist at `baa919a`, so they run against
the base source unmodified and are genuinely RED there. Reproduction, with the
two changed sources stashed back to `baa919a`:

```
not ok 1 - A1b: correction in flight on a non-newest head is not drift
not ok 2 - B1: shepherd whenever a live autonomous PR exists
not ok 3 - B1b: a live PR with drifted open_pr:none is never answered with a competing branch
# tests 3 / # pass 0 / # fail 3
```

and after restoring the correction, the same three assertions:

```
ok 1 - A1b: correction in flight on a non-newest head is not drift
ok 2 - B1: shepherd whenever a live autonomous PR exists
ok 3 - B1b: a live PR with drifted open_pr:none is never answered with a competing branch
# tests 3 / # pass 3 / # fail 0
```

The remaining eight assertions exercise capabilities that do not exist at
`baa919a` at all (`detectStatusDriftAcrossHeads`, and `loadContinuationContext` /
`handOffStatusDrift` as testable seams). Their reproduction is the absence of the
surface: at base the module cannot answer the question, which is the defect. This
is stated rather than dressed up as a behavioural RED.

`loadContinuationContext` gained one narrow seam — an injectable `loadStatus` — so
the default-branch-versus-head authority is testable without reading the real
`docs/STATUS.md` from disk. `handOffStatusDrift` and `loadContinuationContext` are
now exported for that purpose; no production call site changed.

## Validation

| Gate | Result |
| --- | --- |
| `pnpm test:automation` | see PR body — includes the 11 new assertions |
| `pnpm check` | EXIT 0 |
| Migrations | none in this PR |

## Scope

8 files changed at `baa919a`; this head adds the convergence packet, the
convergence suite, and edits two automation scripts plus the `test:automation`
glob. No product code, no schema, no migration. The `daily-log-lost-response`
e2e settle-wait and the CLAUDE.md / AUTONOMOUS_LOOP.md documentation from earlier
heads are unchanged and were not the subject of any finding.
