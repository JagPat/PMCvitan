# PR #253 — convergence audit

Bounded docs-only review (`Review-Deferred-To-Probes`). Two finding-bearing heads, four
findings, all correct.

| Head | Finding | The question it was really asking |
|---|---|---|
| `dad37d4` | P2 the cap read the head commit, not the PR | which SCOPE of diff is being classified? |
| `dad37d4` | P2 `docs/.+` admitted `docs/schema.prisma`, `docs/probes/*.test.mjs` | what makes a path provable? |
| `dad37d4` | P2 removed files were filtered out before classification | which diff STATUSES count? |
| `2734013` | P2 a rename's previous path was never classified | how many PATHS does one entry touch? |

## Architectural cause

All four are one question — **which paths does this review unit touch, and which of them
are provable?** — answered four times by reaching for whichever field was nearest to hand:

- `commit.files`, because the gate already fetched it. That is one commit, and the unit
  under review is the PR. A code PR's convergence head is usually the packet alone, so the
  classifier saw documentation and demanded a deferral trailer meaningless for it. **This
  one is worth naming plainly: it was a defect I was introducing, and my fix would have
  been worse than no fix** — it would have blocked the ordinary code convergence flow the
  cap was never meant to touch.
- `^docs/.+`, because the plans live there. A directory is not a property of a file;
  `docs/schema.prisma` and `docs/probes/foo.test.mjs` run exactly as they would anywhere,
  and admitting them would have handed the deferral escape to a perfectly provable diff.
- `status !== 'removed'`, copied from the packet check next door, where it is correct
  (a deleted packet is not an audit) and here is not (a deleted script still changes what
  runs).
- `file.filename`, because most entries have exactly one path. A rename has two, and the
  surviving one was the documentation-looking half.

This is the same failure shape as PR #252's cause, one layer down: there it was "which rows
count?" answered locally at each fold; here it is "which paths count?" answered locally at
each read. In both cases each local answer was plausible and each was wrong in its own
direction.

## The remedy, stated once

Two definitions, and every site uses them rather than restating a filter inline.

**The path set** — `changedPaths(entry)` returns every path an entry touches: `filename`
and `previous_filename`, no status filter. A rename is a removal plus an addition and both
sides are classified. `isDocsOnlyDiff` folds that over the **PR's cumulative diff**
(`pullRequestFiles`, a paginated `/pulls/{n}/files` read), because provability is a property
of the review unit, not of its latest commit.

**Provable** — `isDocumentation(path)` requires BOTH a documentation extension and a
documentation location. The extension test is an **allowlist** (`.md`, `.mdx`, `.txt`,
`.rst`, and image/PDF assets): a blocklist of runnable extensions has to anticipate every
one that exists and silently admits the ones it missed, whereas an allowlist treats an
unrecognised extension as code — the direction that fails closed. Empty diff, unreadable
cumulative list, or unrecognised extension all fall to the code path.

`changedFiles` keeps its own narrower meaning for the packet check — does THIS head add the
audit — which is a per-head, per-surviving-name question. The two are deliberately not
merged, and `autonomous-review-workflow.test.mjs` pins that: `changedFiles: commit.files`
must hold and `changedFiles: pullRequestFiles` must never appear.

The rule that generalises: **a classifier reading one field of one entry of one commit is
answering a narrower question than the one it was asked.** Where the answer cannot be
expressed with `changedPaths` + `isDocumentation`, a definition is missing — not a licence
to add another inline filter.

## Probes

Reproduce-first, each RED at the head that carried the finding:

- runnable/schema/workflow/migration paths under `docs/` disqualify; real documentation
  under `docs/` still qualifies.
- a removed non-doc disqualifies; a removed doc does not.
- a rename out of a runnable path disqualifies (both directions), a doc→doc rename does not.
- a code PR whose head is packet-only keeps the ordinary protocol; a plan PR with a
  docs-only cumulative diff owes the deferral; an ABSENT cumulative list fails toward the
  code path.
- gate level: an unreadable cumulative read leaves a head with trailer + packet allowed,
  `deferralRequired: false`.

## What this does not do

Nothing here discounts, filters or downgrades a finding, and `codex-current-head` still
fails closed on every current-head finding. Past the cap the author owes MORE, not less: each
open question named as a probe plus the task whose review stop settles it. The finding-
dismissal engine built in PR #250 was withdrawn because on its first real case it would have
suppressed a correct finding; this is deliberately not that, which is also why #252's round-5
findings were fixed rather than deferred even though its head count was past the cap.

Gates: `pnpm test:automation` 118/118; `pnpm check` EXIT 0 (web 543/543, API 680/680).
`origin/main` (PR #254) is merged into this branch; the branch was behind, not conflicted.
