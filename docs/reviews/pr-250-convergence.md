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

---

# Outcome: the gate-side rule is withdrawn

Rounds 3, 4, 5 and 6 all landed on precondition (a) — *is this 40-hex token a commit citation?* —
and round 6 asked to **reverse** what round 5 had asked to tighten:

| Round | Direction | Asked for |
| --- | --- | --- |
| 2 | tighten | remove `object` from the commit vocabulary |
| 3 | tighten | bind a commit word to the SHA it introduces, not the whole window |
| 4 | loosen | recognise plural citations (`commits <a> and <b>`) |
| 5 | tighten | drop bare `git`; a data word must veto; adjacency not proximity |
| 6 | loosen | allow `id` in "commit id", allow `git cat-file`, allow `Head: <sha>` |

Each round's fix created the next round's finding. That is not convergence, and no further
tightening of a natural-language heuristic was going to end it: deciding from English prose
whether a hex token denotes a commit is not decidable, and every boundary this rule drew was
wrong in one direction or the other.

## The decisive evidence

On PR #248, Codex raised two findings on head `b541768`. One was a phantom trailer claim citing
`4f5ec0f`. The other was **correct**: the packet's Verification section claimed the PR was
docs-only when the diff also contains `scripts/autonomous-status-state.mjs`, its test, and
`AGENTS.md`. That false claim was mine, and it had stood since round 1.

The correct finding cites the same absent `4f5ec0f` as its evidence. **This rule would have
discounted a true finding about a false claim in a review packet** — at the first real
opportunity it had. That is the "Remaining Risk" this document already named, and it is not
theoretical.

A rule whose failure mode is "suppresses a correct finding" is not worth six rounds and a
standing risk to catch a reviewer defect that an instruction can prevent outright.

## What ships instead

Only the `AGENTS.md` scope exclusion:

- do not review the convergence trailer or CI state — the trusted gate enforces both fail-closed
  on the exact head, so a finding about either adds no safety;
- do not assert anything requiring git-object access you do not have;
- a commit SHA you did not read from the diff or the review request is not evidence, with the
  measured record of what citing one has cost.

`scripts/autonomous-review-state.mjs`, `scripts/autonomous-review-gate.mjs`,
`scripts/review-efficiency.mjs` and their tests are restored to `main` byte-for-byte
(`git checkout origin/main --`). The gate keeps exactly the powers it had before this PR: it
counts every current-head Codex finding, and it fails closed. Nothing is discounted, so no
correct finding can be lost.

`pnpm test:automation` 75/75 — the pre-PR baseline, since no gate code remains changed.

## What this does not solve, stated plainly

The instruction asks the reviewer not to fabricate citations. It cannot make that impossible. If
phantom trailer findings continue after this merges, the remaining levers are the repository
owner's: temporarily dropping `codex-current-head` from required checks for a blocked PR, or
raising the defect with the review provider. Both are recorded as open with the owner; the
27-citation evidence set is being written up for the second.

The three genuinely orthogonal defects round 6 found in the withdrawn engine — an aggregate
lookup cap that zeroes the whole missing set, body-only reviews never being dismissed, and a
repeated occurrence of an already-cited SHA landing in the bare set — are moot: the code they
describe no longer exists. They are recorded here so the reasoning is not lost if the approach is
ever revisited.
