# PR #253 — convergence audit

Bounded docs-only review (`Review-Deferred-To-Probes`). Three finding-bearing heads, five
findings, all correct.

| Head | Finding | The question it was really asking |
|---|---|---|
| `dad37d4` | P2 the cap read the head commit, not the PR | which SCOPE of diff is being classified? |
| `dad37d4` | P2 `docs/.+` admitted `docs/schema.prisma`, `docs/probes/*.test.mjs` | what makes a path provable? |
| `dad37d4` | P2 removed files were filtered out before classification | which diff STATUSES count? |
| `2734013` | P2 a rename's previous path was never classified | how many PATHS does one entry touch? |
| `44f88bf` | P2 the deferral trailer was accepted without its packet ledger | what EVIDENCES the obligation? |

## Architectural cause

The first four are one question — **which paths does this review unit touch, and which of them
are provable?** — answered four times by reaching for whichever field was nearest to hand
(the fifth is a different shape and has its own section below):

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

## Round 3 — enforcing the whole obligation, not half of it

The fourth finding is not about classification at all, and it is correct against this
repository's own stated rule. AGENTS.md and this packet both say the deferral is **the trailer
AND a ledger in the convergence packet recording each question with the probe that adjudicates
it**. The gate enforced the trailer and the existence of a packet FILE. It never read the
packet, so a head carrying `Review-Deferred-To-Probes: phase-5-task-1` plus an unrelated packet
edit passed — the bare marker wearing a task name, with nothing actually scheduled. That is the
exact failure the bare-marker refusal was written to stop, one level up.

`assessConvergence` now takes `packetText`, and the gate fetches the packet's content at the
exact head (a new `client.fileText`) when this head carries one.

**What is checked, and deliberately what is not.** `packetRecordsDeferral` verifies the two
ARTIFACTS AGREE: the packet names the task the trailer defers to, and it says the handoff is to
probes. It does not score whether the ledger is a good ledger. That line is drawn on purpose —
PR #250 built a mechanism that judged the substance of findings and was withdrawn because on
its first real case it would have suppressed a correct one. A packet naming a different task
than the trailer, or never mentioning a probe, is not a judgement call: the two documents
describe different handoffs, or none. Anything past that stays with the reviewer.

An unreadable packet reports "unverified", not "missing", and says so in the refusal text — it
is not evidence of an absent ledger, and the gate re-runs on the next event, so a transient API
failure self-heals rather than stranding a head on a claim about content nobody read.

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
- a deferral trailer with a packet that records no handoff is refused, naming the task the
  trailer claimed; a packet naming the task but never mentioning a probe is refused; both
  together pass; an unreadable packet is refused as UNVERIFIED with that word in the message;
  below the cap none of it applies.
- gate wiring: the packet's content is fetched at the exact head via `fileText`, and
  `changedFiles` remains `commit.files`.

## What this does not do

Nothing here discounts, filters or downgrades a finding, and `codex-current-head` still
fails closed on every current-head finding. Past the cap the author owes MORE, not less: each
open question named as a probe plus the task whose review stop settles it. The finding-
dismissal engine built in PR #250 was withdrawn because on its first real case it would have
suppressed a correct finding; this is deliberately not that, which is also why #252's round-5
findings were fixed rather than deferred even though its head count was past the cap.

Gates: `pnpm test:automation` 119/119; `pnpm check` EXIT 0 (web 543/543, API 680/680).
`origin/main` (PR #254) is merged into this branch; the branch was behind, not conflicted.
