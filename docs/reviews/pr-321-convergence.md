# PR #321 — convergence audit (Phase 5 Task 7B-v)

Two finding-bearing heads, five findings, on a unit written specifically to end a root — and
**three of the five are that same root, twice inside the correction for it.**

| # | Head | Finding | Root |
|---|---|---|---|
| 1 | `3fcd9c7` | P1 — the approval CEILING was missing from `payableGrantActor` | **enumeration** |
| 2 | `3fcd9c7` | P1 — the post-create check could pass on an OLDER live grant | verify the thing, not a thing |
| 3 | `3fcd9c7` | P2 — a chosen actor no longer offered stayed selectable | coverage |
| 4 | `3fcd9c7` | P2 — the grant form compared status, not the REVISION | coverage (named in #316) |
| 5 | `1b25544` | P2 — the read still offered a candidate the command had started refusing | **enumeration**, in its own fix |

## The root: a shared predicate stops being shared the moment a caller adds a condition beside it

This unit exists because `pr-317-convergence.md` recorded the §I payment-rule surface failing four
times at the same thing — enumerating a rule's preconditions, each list looking complete from the
inside. 7B-v's answer was one predicate, `payableGrantActor`, derived from what `approve()` does.

**Finding 1 is that root, in the fix for it.** The predicate was derived from the first *three*
things `approve()` checks and missed the fourth: `assertApprovalAuthority` compares the actor's
cumulative approved total to their ceiling, so a certifier at or above their limit can never have
any positive amount accepted, and a grant naming them is exactly the unspendable authorisation the
unit was written to refuse. I wrote a predicate to stop listing preconditions, by listing
preconditions.

The repair was not a fourth clause, because that reproduces the shape. `approve()` accepts `a > 0`
iff `a <= remaining` AND `approvedSoFar + a <= ceiling`, so a positive amount exists iff
`min(remaining, ceiling - approvedSoFar) > 0`. **One number.** §G bound 4 and the §I ceiling stop
being two conditions side by side, and a third money bound narrows the same quantity instead of
needing another clause.

**Finding 5 is the root a third time, and it was created by finding 2's fix.** Round 1 taught the
COMMAND that a second authorisation can never be the one an approval selects — and did not teach
the READ. So the claim read kept offering a candidate the command had just started rejecting, and
the form enabled an action that failed after the write-ahead outbox reported it saved.

That is the sharpest lesson in this audit, because the code looked like it could not happen: the
whole point of `payableGrantActor` was that read and command share one answer. **They stopped
sharing it the moment a condition was added beside the predicate instead of inside it** — and
nothing about writing `if (...) throw` next to a call to a shared function looks like divergence.

**What replaces it.** The resolution — the folds, the certifier's approval authority, and whether an
authorisation already stands — now lives in ONE async `payableGrantOffer`, which both the command
and the claim read call. The bare `payableGrantActor` still exists but takes `liveGrantStands` as a
parameter it cannot compute, so a caller that wants to answer that question for itself has to go
through the function that answers it for everyone. A condition added inside reaches every consumer;
a condition added beside it in a caller is what this signature is shaped to make awkward.

## Root 2 — a check that verifies *a* thing rather than *the* thing

Finding 2, and a self-caught instance before it. The post-create check runs the spend path's own
resolver against the row just written — the design's best idea, since a pin added to
`resolveSodGrant` later is then enforced at issue automatically. Twice it verified the wrong object:

- **self-caught, pre-review**: it passed `row.versionId`, and the resolver *filters candidates by
  that versionId* — so it matched the row against itself and checked nothing. Fixed to the
  certificate's version, the one `approve()` resolves against.
- **finding 2**: `resolveSodGrant` returns the OLDEST live candidate and the live-scope uniqueness
  admits a second row when the approver differs, so an existing authorisation satisfied the check
  while the new row was never what an approval would select. Now the resolved grant must BE the row.

Both are the same shape: *a check is only as good as the identity it compares.* The first was
caught by asking what the assertion would still pass on; the second needed a reviewer.

## Root 3 — coverage, on the client, for the third time in this lineage

Findings 3 and 4 are `pr-316-convergence.md`'s root: *a rule reached the controls I was holding in
mind, not the set.* The disabled-guard checked the draft was non-empty but not that the chosen
person was still offered; the authoritative check compared the status copy but not the revision,
which every §F fold write moves without moving the label.

Both were fixed for **BOTH §I rules**, not only the payment one. Fixing only the rule a finding
names is how #310's audit records this root recurring inside the patch that closed it.

## Verification

Every finding reproduced RED before its fix, and **every probe mutation-tested** — the fix reverted,
the probe observed to fail, the fix restored. That step is not ceremony here: on this PR I wrote
fix and probe together, and a probe written alongside its fix has never been shown to fail. This
lineage has shipped a vacuous probe before (`pr-318-convergence.md`, finding 6).

- `phase5-t6a-payments.test.ts` **41/41** — PROBE 38/39 (round 0), PROBE 40 (ceiling, and RAISING
  the ceiling makes the same grant issuable, so the guard is precise not merely strict), PROBE 41
  (second authorisation refused; exactly one row survives and the approval consumes it).
- `phase5-t7bii-claim-read.test.ts` **28/28** — `7B-v-1` covers the read's agreement with the
  command on every arm, including that a SPENT authorisation returns the candidate.
- `commercial-screen.test.tsx` — the stale-candidate and stale-revision probes, both mutation-tested.
- `pnpm check` EXIT 0 (web 732/732, API unit 781/781).

## Process notes, recorded because they cost real time

- A piped command's exit code is the PIPE's. `pnpm check | grep` reported 0 while the real exit was
  2, and a task notification reported "exit code 0" for a `tail`. Gating runs capture `$?` directly.
- Never run a focused integration suite while the full one is running: they truncate the same
  tables and each corrupts the other. Twenty "failures" were mine, not the code's.
- A Python `str.replace` patches EVERY match. It duplicated a test helper into a block that did not
  use it; the type-checker caught it, not the tests.
