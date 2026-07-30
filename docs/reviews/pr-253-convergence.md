# PR #253 — convergence audit

Bounded docs-only review (`Review-Deferred-To-Probes`). Five finding-bearing heads, nine
findings, all correct.

| Head | Finding | The question it was really asking |
|---|---|---|
| `dad37d4` | P2 the cap read the head commit, not the PR | which SCOPE of diff is being classified? |
| `dad37d4` | P2 `docs/.+` admitted `docs/schema.prisma`, `docs/probes/*.test.mjs` | what makes a path provable? |
| `dad37d4` | P2 removed files were filtered out before classification | which diff STATUSES count? |
| `2734013` | P2 a rename's previous path was never classified | how many PATHS does one entry touch? |
| `44f88bf` | P2 the deferral trailer was accepted without its packet ledger | what EVIDENCES the obligation? |
| `1c9f201` | P2 the ledger check tested vocabulary, so prose passed | what makes a ledger a LEDGER? |
| `9ef1d0c` | P2 a table HEADER satisfied the ledger | is a ROW an entry, or a LABEL? |
| `9ef1d0c` | P2 `phase-5-task-10` satisfied `phase-5-task-1` | where does a task NAME end? |
| `9ef1d0c` | P2 the first convergence file on the head was verified | WHOSE packet evidences this PR? |

## Architectural cause

The first four are one question — **which paths does this review unit touch, and which of them
are provable?** — answered four times by reaching for whichever field was nearest to hand
(the last two are a different shape and have their own sections below):

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
ARTIFACTS AGREE: the packet names the task the trailer defers to, and it records the handoff as
probes (round 4 below tightens *records* from "mentions the word" to "carries a ledger entry").
It does not score whether the ledger is a good ledger. That line is drawn on purpose —
PR #250 built a mechanism that judged the substance of findings and was withdrawn because on
its first real case it would have suppressed a correct one. A packet naming a different task
than the trailer, or never mentioning a probe, is not a judgement call: the two documents
describe different handoffs, or none. Anything past that stays with the reviewer.

An unreadable packet reports "unverified", not "missing", and says so in the refusal text — it
is not evidence of an absent ledger, and the gate re-runs on the next event, so a transient API
failure self-heals rather than stranding a head on a claim about content nobody read.

## Round 4 — a ledger is a mapping, not a vocabulary

Round 3's check was `names the task && mentions "probe"`, so `phase-5-task-1 has probes
elsewhere` passed. The finding is correct and the fix does not cross the line drawn above,
because it was never a substance question: **a ledger is a MAPPING** — one entry per deferred
question, each pointing at the probe that adjudicates it — and telling a table row or list item
apart from a paragraph needs no opinion about what the row says. Round 3 checked words where it
could have checked structure. That is under-delivery, not a boundary.

So `packetRecordsDeferral` now requires the packet to name the task AND to carry at least one
LEDGER ENTRY: a line that is a table row, a bullet, or a numbered item, and that names a probe.
All three formats count — pinning one markdown shape would refuse an author who wrote a
perfectly good ledger the other way, which is a false block and the same class of defect as
this PR's very first finding.

**The check bites on my own packet, which is the evidence it is not a formality.**
`docs/reviews/pr-252-convergence.md` names `phase-5-task-1` and contains ZERO ledger entry
lines: its "deferral ledger" is the sentence *"the deferral ledger for this plan is the probe
list itself: 5g–5ac are executable the moment Task 1 exists."* That is a pointer, not a
mapping — it never says WHICH question each probe settles. Verified mechanically at
`claude/phase5-planning`: task named `true`, entries `0`. So #252 could not take the deferral
route as written. It is not taking it today (every round-6 finding was fixed, and that head
carries no deferral trailer), so nothing is broken right now — but when it does defer, the
packet owes a real per-question table. That obligation is recorded here deliberately rather
than fixed in this PR, whose scope is the gate.

**Update (round 5):** the obligation has since been discharged on `claude/phase5-planning` —
`pr-252-convergence.md` now carries a 13-row table, one row per deferred question, each naming
the probe that adjudicates it and the task whose review stop settles it. Re-verified against
the TIGHTENED round-5 check (header rows excluded, task matched as a token): 13 ledger entries,
`allowed: true`. So #252 can take the deferral route once this PR merges, and it earns it with a
mapping rather than a pointer.

## Round 5 — the boundary of an entry, of a name, and of a packet

Three findings, all correct, and the first of them is one I had already found and reported
myself before this review round ran — I recorded it as a known weakness rather than opening a
fifth round mid-flight, and the reviewer raised it independently. That is the honest sequence
and worth stating: self-reporting a defect is not the same as fixing it.

**A row is not an entry.** `| Open question | Probe | Settled by |` is structurally a table row
and contains the word "Probe", so round 4's check accepted a table consisting of nothing but a
header and a `| --- |` separator. The header LABELS the column; it records no mapping. The fix
keeps the structural line drawn in round 4 and sharpens what "names a probe" means: the probe
reference must carry an IDENTIFIER — strip the word `probe`/`probes` from the cell and something
must remain (`probe 5w` → `5w`; a bare `Probe` → nothing). Separator rows are excluded on the
same reasoning. This is still structure, not substance: it does not ask whether `5w` is a good
probe, only whether a probe was named rather than a column titled.

**A prefix is not a name.** The task match was `packetText.includes(target)`, so a packet whose
ledger settles everything at `phase-5-task-10` satisfied a trailer deferring to
`phase-5-task-1`. The two documents then describe different review stops while the gate reports
agreement — exactly the disagreement round 3 was built to detect, defeated by a missing token
boundary. `namesTarget` now requires the task to appear as its own token, with `-` treated as
part of the token so a hyphenated suffix cannot slip through.

**A convergence file is not necessarily THIS PR's packet.** The gate took the FIRST
`docs/reviews/*convergence*.md` name on the head. A head touching two of them (this session has
had two convergence packets open at once — #252's and #253's) could be verified against an
unrelated older packet that happens to name the same task and carry a probe row, while the PR's
own packet records no ledger at all. The gate now prefers `docs/reviews/pr-<number>-convergence.md`,
accepts a single unambiguous candidate otherwise, and falls to `undefined` — reported as
UNVERIFIED, never as satisfied — when several candidates match and none is this PR's.

**The shape, again.** All three are the same failure as this PR's first four findings, now
applied to the check I wrote to close them: a boundary asserted by the nearest convenient
test — a row by its pipes, a name by substring containment, a packet by first match. Each was
plausible and each admitted something it was written to refuse. The generalisation is narrower
than the round-2 remedy and worth stating separately: **a structural check must be bounded on
every side it is claimed to bound.** Structure was the right line to draw; drawing it loosely
is not a licence to move to substance, it is an obligation to draw it exactly.

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
- prose naming the task and the word "probes" is REFUSED (no mapping); a structurally-valid row
  that names no probe is refused; table, bullet and numbered ledger entries all pass.
- a table of header + separator only is REFUSED (a header labels a column, it records no
  mapping); `phase-5-task-10` does not satisfy a trailer deferring to `phase-5-task-1`.
- gate wiring: the packet's content is fetched at the exact head via `fileText`, and
  `changedFiles` remains `commit.files`.

## What this does not do

Nothing here discounts, filters or downgrades a finding, and `codex-current-head` still
fails closed on every current-head finding. Past the cap the author owes MORE, not less: each
open question named as a probe plus the task whose review stop settles it. The finding-
dismissal engine built in PR #250 was withdrawn because on its first real case it would have
suppressed a correct finding; this is deliberately not that, which is also why #252's round-5
findings were fixed rather than deferred even though its head count was past the cap.

Gates (re-run at this head): `pnpm test:automation` 119/119; `pnpm check` EXIT 0 (web 543/543,
API 680/680). The suite count is unchanged because round 5's two new probes are assertions
inside the existing deferral-ledger test, not new test blocks.
`origin/main` (PR #254) is merged into this branch; the branch was behind, not conflicted.
