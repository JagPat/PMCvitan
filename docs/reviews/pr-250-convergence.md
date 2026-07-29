# PR #250 Review Convergence

## Objective

Converge the PR #250 review. Two heads received findings — `93d5a08` (4) and `a8333e0` (3) —
and all seven are correct. This head maps them to their one shared cause, states the batched
remedy, and records the reproduce-first proof for each.

## Finding Map

| Head | Finding | Precondition it found unestablished |
| --- | --- | --- |
| `93d5a08` | P1 hex tokens sent to `commitExists` | (a) the token is a COMMIT citation — shape alone does not establish it |
| `93d5a08` | P2 `CHANGES_REQUESTED` cleared by comment filtering | (c) the head's whole evidence is its inline comments |
| `93d5a08` | P2 convergence counted unfiltered heads | (d) the same test governs every place a finding is counted |
| `93d5a08` | P2 422 treated as absence | (b) GitHub CONFIRMED the commit is absent |
| `a8333e0` | P1 `object` in the commit-context list | (a) again — the round-1 fix reintroduced it |
| `a8333e0` | P2 markdown link text stripped with the URL | (a) in the opposite direction: a real citation lost |
| `a8333e0` | P2 paired `COMMENTED` record restored a discounted head | (c)+(d) composed |
| `2c51301` | P1 commit context bled onto later hex on the same line | (a) again — the word was not BOUND to the SHA it introduces |
| `2c51301` | P2 standalone `COMMENTED` review suppressed with the container | (c) — suppression was inferred from the head, not matched to the record |

## Architectural Cause

The rule this PR adds is a single sentence: *discount a finding that argues only from commits
this repository does not contain*. That sentence has four independent preconditions, and the
implementation established each in a different place:

- **(a)** the cited token really is a commit citation;
- **(b)** its absence was definitively confirmed by GitHub;
- **(c)** the finding's whole substance rests on those commits;
- **(d)** the same test governs every surface where a finding is counted.

Each round found one precondition the code had assumed rather than checked. That is why the
findings look scattered — hex parsing, review states, HTTP codes, convergence counting — while
being one defect: a conjunction implemented as four separate, individually-plausible steps.

Every one of them fails in the same direction if left unfixed: the gate discards a real finding.
That is the only outcome this rule must never produce, which is why all seven are P1/P2 and why
none was deferred.

## Batched Remedy

The preconditions are now explicit, named, and shared rather than distributed:

- **(a)** `citedCommits` extracts only tokens the prose introduces AS commits, and `citesBareHex`
  reports 40-hex the body reasons about outside that context. `object` is deliberately absent
  from the context vocabulary, with the reason recorded at the regex so it cannot be re-added by
  the same reasoning that added it. Markdown link TEXT is preserved; only the URL target is
  dropped, so a permalink still cannot disguise a fabricated citation while a genuine
  `[commit <sha>](…)` still counts.
- **(b)** `commitExists` returns `false` only on 404. 422, 403, 5xx and network failures return
  `null`, and an unresolved lookup always keeps the finding.
- **(c)** `isUnfoundedFinding` refuses to dismiss a body carrying any bare hex, and judges each
  comment against its OWN posted head rather than an ambient expected head.
- **(d)** one `isUnfoundedFinding` serves both the current-head classifier and convergence
  counting; `resolveMissingCommits` spans every Codex comment, not just the current head's; and
  review records are classified by state identically in both places — `CHANGES_REQUESTED` is
  evidence in its own right and always counts, a `COMMENTED` record is the container GitHub
  posts alongside inline comments and does not outlive their dismissal, and a record with no
  inline comments at all still blocks.

Dismissals are never silent: the count rides on the `codex-current-head` status and the sticky
comment in every branch.

## Evidence

| Finding | RED via | Probe |
| --- | --- | --- |
| hex tokens | `INJECT_ANY_HEX` | `bare hex data is not a commit citation and never permits a dismissal` |
| `CHANGES_REQUESTED` | `INJECT_CLEAR_FIRST` | `a CHANGES_REQUESTED review outlives the dismissal of its comments` |
| convergence counting | `INJECT_COUNT_ALL` | `heads whose findings cite only absent commits are not finding heads` |
| 422 | `INJECT_422` | `only a 404 proves a commit is absent` |
| `object` context | `INJECT_OBJECT_CONTEXT` | `bare hex data …` (object-key case) |
| link text | `INJECT_DROP_LINK_TEXT` | `a commit named in markdown link text is still a citation` |
| paired record | `INJECT_ALL_REVIEWS` | `a paired COMMENTED review does not restore a discounted head` |

Each injection reverts exactly one fix and turns exactly its own probe RED. `pnpm
test:automation` 86/86.

`pnpm check` fails only on `apps/web/tests/labour.test.ts` — the documented `onboardLabourWorker`
key-timing flake, which reproduced 2 of 3 local runs and passed 543/543 on the third, and passed
in CI on the previous head. This PR is confined to `scripts/` and `AGENTS.md`, and `apps/web`
contains no reference to any changed file, so the failure has no path to this change. It is
flagged rather than dismissed: the local rate deserves its own maintenance item.

## Invariant Audit

No product, schema, migration, dependency or deployment surface changes. Exact-head
serialization and all required product checks remain mandatory. The gate's only new power is to
decline to count a finding whose every cited commit GitHub confirms is absent; every ambiguity —
no SHA, the reviewed head cited, bare hex present, an unresolved lookup, an over-long citation
list — keeps the finding in full.

## Remaining Risk

The rule cannot distinguish a fabricated commit citation from a correct finding that happens to
cite a commit deleted after the review was written (a force-pushed branch, a GC'd object). Such a
finding would be discounted. This is accepted deliberately: the loop records the dismissal on the
status and in the sticky comment, so the case is visible and recoverable by re-review, whereas
the failure it replaces — twenty-two fabricated citations across four PRs, each costing a full
product CI battery and a draft round-trip — was neither visible nor bounded.

## Round 3 (head `2c51301`) — precondition (a) again, and (c) made exact

Both findings are correct, and both are the same two preconditions the packet already names —
which is itself the evidence that the cause was correctly identified rather than the symptoms.

**(a) the word must bind to the SHA it introduces.** Removing `object` from the context
vocabulary in round 2 was necessary but not sufficient: the check still scanned the whole
preceding window, so "on commit `<a>`, the object key `<b>` was deleted" reused the earlier
`commit` for `<b>`. Both tokens read as citations, `citesBareHex` saw none, and a real finding
about the key could be discounted. Each token's context window now starts at the END of the
previous token, so a commit word reaches forward only to the SHA that follows it. This is the
general fix; round 2's vocabulary edit was the instance.

**(c) suppression must be matched, not inferred.** A `COMMENTED` record was discounted whenever
its head had any dismissed comment, which discarded a standalone review note whose body cited no
absent SHA at all. GitHub links a review comment to the record that carried it via
`pull_request_review_id`, so the container is now identified by id: only the record that actually
carried the dismissed comments is discounted with them. Any other record on the head — a second
`COMMENTED` note, or one whose link is absent so nothing can be matched — survives and blocks.
The unlinked case fails closed rather than guessing.

Reproduce-first: `a commit word binds only to the SHA it introduces` and `a COMMENTED review that
carried nothing dismissed still blocks` (which also pins the unlinked fail-closed case).
`pnpm test:automation` 88/88; `pnpm check` exit 0.

The round-2 fixture for the container case had to be corrected too: it asserted a `COMMENTED`
record was discounted while carrying no `pull_request_review_id`, which the exact rule now
refuses. That was a fixture modelling GitHub's payload incompletely, and the stricter rule caught
it — recorded here rather than quietly amended.


## Round 4 (head `d4ff71f`) — three findings, one shared rule

All three are correct. Two of them are the same precondition (d) the packet already names —
*one test must govern every counting surface* — arriving through the two places that had not yet
been made to share it. That is the argument for fixing the cause rather than the instances.

**(d) the classifier and the convergence counter must ask the same question.** Round 3 matched
the container by `pull_request_review_id` in `classifyCodexState`, but `codexFindingHeads` still
suppressed by HEAD: any head with a dismissed comment lost every `COMMENTED` record on it, so a
standalone review note vanished from convergence history even though the gate itself would have
counted it. The two surfaces now call the same exported pair — `discountedReviewIds` and
`reviewSurvivesDismissal` — so they cannot answer differently. This is the structural remedy;
round 3's fix to one caller was the instance.

**(c) a container is discounted for what it carried, not for existing.** Even matched by id, a
review record was dropped whole without reading `body`. Codex writes findings there directly, and
those cite no absent SHA at all. `reviewCarriesOwnFinding` strips only the known boilerplate — the
`<details>` block, the "Codex Review" heading, the standard preamble, the `Reviewed commit:` line
— and treats anything left as substantive. An unrecognised body is evidence, so the failure mode
is a finding that blocks when it need not, never one that disappears.

**(a) a plural word introduces a list.** `\bcommit\b` does not match "commits", so
"the trailer is missing on commits `<a>` and `<b>`" — the natural way to name two — left `<b>`
bare, and `citesBareHex` then kept the whole finding blocking on a citation nobody could inspect.
Pluralising the vocabulary alone does not fix it: round 3's window reset starts each token's
context after the previous token, so `<b>`'s window is just " and ". The rule is therefore about
the text BETWEEN two tokens — punctuation and a conjunction and nothing else is a list, and the
classification carries forward. A noun phrase ("on commit `<a>`, the object key `<b>`") is not,
so round 3's binding survives intact, and the continuation is symmetric: "the digests `<a>` and
`<b>`" keeps both halves as data.

Pluralising also widened the proximity window enough to reach across a sentence break, which the
existing bare-hex probe caught: "…the two recorded finding heads report X. The digest `<hex>` is
stale." read the digest as a commit. The window now stops at the last sentence terminator. That
cut errs the safe way — a token that loses its context becomes bare hex, which BLOCKS a dismissal
rather than permitting one.

### Reproduce-first

Each fix was removed in isolation and only its own probe failed:

| Finding | Fix removed | RED probe |
|---|---|---|
| P1 container body | `reviewCarriesOwnFinding` arm | `a discounted container keeps the finding its own body carries` |
| P2 standalone COMMENTED | `reviewSurvivesDismissal` in `codexFindingHeads` | `a paired COMMENTED review does not restore a discounted head` + `finding history includes blocking Codex review records without inline comments` |
| P2 plural citations | plural vocabulary + list continuation | `plural commit words introduce every SHA they name` |

`scripts/autonomous-review-state.test.mjs` 24/24 and `scripts/review-efficiency.test.mjs` 17/17
(41 together); `pnpm test:automation` 90/90, up from 88; `pnpm check` exit 0.

The round-2 convergence fixture needed the same correction round 3 recorded for the classifier
fixture: it modelled paired review records with no `id` and comments with no
`pull_request_review_id`, which the id-matched rule refuses. GitHub sends both. Corrected here
and recorded rather than quietly amended, and a third case pins the behaviour the finding asked
for — an unlinked record keeps its head.

## Round 5 (head `a68c48f`) — the heuristic was the defect, not its width

Five findings, all correct. Two of them (F1 comma-as-list, F5 nearby-word-binds) are the SAME
cause as round 3 and round 4: a proximity rule over English prose deciding whether a hex token
denotes a commit. Rounds 3, 4 and 5 each supplied another sentence shape it got wrong. Widening
the window admits more of them; narrowing it drops real citations. That oscillation is the
evidence that the rule's SHAPE was wrong, so this correction replaces it rather than tuning it
again.

**The rule is now two-sided, and the data side wins.**

1. **A data word adjacent to the token vetoes it outright.** `digest`, `checksum`, `hash`,
   `object`, `blob`, `tree`, `key`, `fingerprint`, `id`, `value`, `constant`, `string` — the
   finite, enumerable set of things a 40-hex value actually is when it is not a commit. Checked
   FIRST, so no positive rule can override it.
2. **Otherwise the commit word must be ADJACENT**, with only quoting and whitespace between —
   not "somewhere in the sentence". The 80-character window and the sentence-boundary cut are
   both gone; neither was doing honest work.
3. **A list carries only across an actual conjunction.** A bare comma is not list glue, because
   "on commit `<a>`, `<b>` is the object key" separates a citation from data with exactly that
   comma.
4. **Bare `git` no longer introduces anything.** Only a command that TAKES a revision
   (`show`/`log`/`cat-file`/`rev-parse`/`interpret-trailers`) may, and that arm is the one place
   bounded proximity stays sound — a git command's argument is a revision by construction.

Everything else is bare hex, and bare hex BLOCKS a dismissal. Every remaining ambiguity therefore
keeps the finding, which is the direction this rule must fail in.

**F3 — the same test now reaches review bodies.** A review body argues from commits exactly as an
inline comment does, but `reviewCarriesOwnFinding` returned true for any non-boilerplate text and
`resolveMissingCommits` scanned only comments. The wrapper therefore kept blocking on the very
citation its comments had been discounted for, and the body's SHAs were never even looked up. The
predicate is extracted as `isUnfoundedText(body, ownHead, missingCommits)` and both envelopes call
it; `resolveMissingCommits` now collects from bodies too.

**F4 — boilerplate is the KNOWN wrapper, not any `<details>`.** The blanket strip removed a
collapsed finding along with Codex's "About Codex in GitHub" block, so a head could clear on a
body that cited no SHA at all. The pattern is pinned by its summary text.

### Reproduce-first

Each fix removed in isolation fails its own probe:

| Finding | Fix removed | RED probe |
|---|---|---|
| F1 comma-as-list · F5 nearby word binds | adjacency + conjunction-only glue | `a data word adjacent to the token vetoes any commit reading` |
| F2 bare `git` swallows object ids | narrowed git arm | `a data word adjacent to the token vetoes any commit reading` (the unlisted-subcommand case) |
| F3 body skips the absent-SHA test | `isUnfoundedText` in `reviewCarriesOwnFinding` | `a review body is subject to the same absent-SHA test` |
| F4 blanket details strip | summary-pinned wrapper pattern | `only the known Codex wrapper details block is boilerplate` |

**Stated honestly about F2:** restoring the bare-`git` arm alone does NOT fail the three phrases
the finding named (`git object` / `git blob` / `git tree`) — the data veto defends those, and it
fires first. Narrowing the arm is still required, and it now has a probe that isolates it: a git
subcommand the list does not know followed by a noun the veto does not know
(`git verify-pack summary reported <hex>`) must introduce nothing. Without that probe the
narrowing would have been unverified code.

`scripts/autonomous-review-state.test.mjs` 28/28, `scripts/review-efficiency.test.mjs` 17/17;
`pnpm test:automation` 94/94; `pnpm check` exit 0.

### Where this stops

Three rounds of prose-parsing findings is the signal that the gate-side dismissal is the
expensive half of this change. The AGENTS.md scope exclusion — which stops the finding being
written at all — costs nothing and carries no risk of discounting a real finding. If a further
round produces more sentence-shape findings, the correct response is not a sixth tightening: it
is to ship the instruction alone and drop the dismissal engine. That call belongs to the
repository owner and is recorded here rather than taken unilaterally.
