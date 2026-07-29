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
