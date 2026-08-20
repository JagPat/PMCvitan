# The replacement-lineage rule: what is wrong with it, and what its repair must do

Status: **the repair is resuming.** An earlier record (#378) proposed parking it;
that framing was withdrawn by owner directive on 2026-08-20, and the programme
mandate is unchanged — autonomous, fail-closed convergence, with unresolved
findings carried forward rather than released.

**This document does not discharge #377.** #377 carries the lineage-repair
implementation and its unresolved findings. A record of what remains undone is
not the doing of it. This unit replaces #378 — the record — and nothing else;
#377 keeps its `review-replacement-required` label, and the implementation
replacement that carries its scope is a separate review unit that follows this
one. Neither label is to be cleared by hand.

Every claim below about how `main` behaves was checked by **executing**
`assessReplacementLineage` and `assessReviewScope` at `5c2b739`, not by reading
them. Where an earlier record asserted something the code does not do, the
correction is marked and the executed result is given.

## What the rule does today

`scripts/review-efficiency.mjs` refuses a pull request until its replacement
lineage checks out. When a unit reaches the two-finding-head limit the controller
labels it `review-replacement-required`, and `assessReplacementLineage` decides
two things:

- a unit declaring `Replaces: #N` is admitted when #N is labelled, closed, and
  not already claimed by another OPEN pull request whose body names it;
- a unit declaring `Replaces: none` is refused while any labelled unit is
  undischarged, and discharge means: some MERGED pull request, numbered higher
  than the labelled unit, whose body says `Replaces: #<that unit>`.

Both readings come from pull request BODIES.

**The well-formedness check lives in a different function.** `REPLACES_DECLARATION`
is a global regex and `replacementDeclaration` returns `invalid` unless the body
carries *exactly one* `Replaces:` line. `assessReplacementLineage` does not act on
that: an `invalid` declaration falls through its `source` branch and is admitted
whenever nothing is pending, exactly like `none`. What refuses it is
`assessReviewScope`, separately — `the PR body needs exactly one Replaces: none or
Replaces: #<closed-pr> declaration`.

So the gate as a whole is fail-closed on a malformed declaration, and the lineage
function alone is not. That split matters to whoever rewrites the lineage
function: replacing it without keeping the scope-level check turns a refusal into
an admission.

## What is wrong with it

### 1. A dead replacement strands the debt permanently

Discharge requires a merged pull request naming the exhausted number *exactly*,
and each replacement names only its immediate predecessor. If a replacement dies
unmerged, the original is named by nothing that will ever merge.

This is not hypothetical. On 2026-08-18 #354 reached the limit, #360 replaced it
and reached the limit too, and #361 replaced #360 — so nothing would ever name
#354 again and every `Replaces: none` unit was refused. The label was cleared by
hand three times that night. It happened again on 2026-08-19 at eight units, with
unrelated work (#363, a different track) refused for 38 hours. It happened a third
time on 2026-08-20: #377 was exhausted, #378 was opened to replace it, #378 was
itself exhausted, and the repository blocked again — the record about the rule
consumed by the rule.

**Operational consequence:** every time a replacement chain dies mid-way, the
repository stops accepting fresh work until the chain is continued or an operator
intervenes.

### 2. Lineage is read from text anyone can rewrite

A pull request body is editable by anyone who can edit a pull request. One
consequence follows, and one that an earlier record claimed does not.

**The real one.** A MERGED pull request's body is editable. Editing an old merged
body to say `Replaces: #354` discharges #354 outright, with work that never
carried its scope. Executed against the live rule: a labelled #354 plus a merged
#372 whose body is edited to name it returns `allowed: true` for a fresh
`Replaces: none` unit. Any merged pull request numbered above the target will do.

**The one that is not real, corrected.** #378 also claimed a transitive attack:
edit an unrelated exhausted unit X to say `Replaces: #354`, then merge Y saying
`Replaces: #X`, and #354 is discharged. **It is not.** `fulfilledSources` compares
each candidate's declaration *directly* against each labelled source, so Y
fulfils X and #354 stays pending. Executed: the fresh unit is still refused, with
`exhausted PR #354 still requires a replacement`. The chain is never walked.

Recording the wrong attack is worse than recording none, because a future
implementation would be built against a threat model the code does not have. That
error was in #378 and is corrected here.

**This surface is live on `main` today.** It is not introduced by anything that
was attempted; the attempts were failed for not closing it, which is a different
thing. In a repository whose pull requests are authored by its owner and two
agents the exposure is small — but it is real, and it is why a future attempt
cannot re-derive lineage from bodies.

## What was attempted, and what each review found

Six implementation units, none merged. (#378 and this document are records, not
attempts.) The design changed three times; the reviews are the useful part.

| Unit | Design | What the review found |
| --- | --- | --- |
| #367 | Walk the claim chain over bodies | Any closed PR counted as a link, so an unrelated exhausted unit plus a merged replacement of it discharged a source it never carried |
| #373 | Require each link to be exhausted, then to have outlived its source | Ordering narrows the window but never proves *when* the declaration was written |
| #374 | Move one boolean label from source to claimant | Legacy labels unmigrated (repository blocked); one unit could absorb a second obligation; an interrupted two-call move is indistinguishable from absorption |
| #375 | Name the claim in a `review-replaces-N` label on the claimant | A label carries no proof of who applied it; two claims can race; targeting `main` is not being built on it |
| #376 | Read claims from the issue timeline actor | Merge-base *dates* reject valid replacements; following current labels means removing one erases the record |
| #377 | Record the claim on the exhausted unit's timeline | Containment settled once instead of per evaluation; a unit could hold two claims; same-second ties broke on PR number; then: promoting a fallback claim can overload the promoted unit; revalidation checked head/body/state but not base |

Two things carry forward more than the table:

- **The first three units patched a trust model the review had already rejected.**
  Two reviews said lineage derived from editable text cannot be trusted before
  the design changed. Narrowing a forgery window twice cost two units.
- **The last two units were no longer design failures.** They were second-order
  bugs in the fix — each fix creating the next one. That signals an intricate
  surface, not a wrong direction.

## What the repair must do

The reviews converge on a small set of requirements. Any design meeting them
should get further than these six did.

1. **The record must name both ends** — which obligation, and who took it on. A
   boolean cannot express an interrupted transfer versus a second obligation.
2. **It must be written where the controller can always find it again**, not
   through whatever labels currently exist. The exhausted units are enumerable;
   claimants are not.
3. **Provenance must be authenticated, and the timeline actor is not enough.**
   GitHub labels are writable by any collaborator, so the label set alone proves
   nothing; the issue timeline records the actor and cannot be edited, which
   rules out a human's self-applied label. It does NOT identify the controller:
   `auto-merge.yml` and `autonomous-handoff.yml` both run with the repository
   `GITHUB_TOKEN` and `issues: write`, so every workflow here shares one
   `github-actions[bot]` identity, and any write-capable workflow added later
   would be indistinguishable from the controller. The timeline actor is a
   necessary filter, not sufficient evidence. (#377's implementation treats it as
   sufficient. That is one of its known gaps, and it is one of the findings its
   replacement must carry.)
4. **Concurrency resolves by recorded order, not by locking.** Label writes cannot
   be made mutually exclusive; the earliest recorded claim wins, ties going to the
   timeline's order.
5. **Conservation must hold in both directions.** A unit holding two claims must
   settle neither — *and* the sources it raced into must stay claimable, or they
   become permanently stuck, which is the original defect again.
6. **Separate a dead chain from missing evidence, and fail closed on the latter.**
   An earlier version of this requirement said every gate must fail toward the
   loop continuing. **That is wrong as written and is corrected here.** When the
   timeline or label read is unavailable, truncated, or malformed, the lineage is
   unknown — and admitting a unit on unknown lineage can merge it while an
   exhausted obligation is still unresolved, which is the safety the gate exists
   for. `main` already fails closed there: unreadable evidence returns `required
   replacement lineage could not be read from GitHub`, executed and confirmed. A
   repair must keep that. Only a *provably* dead chain — evidence read
   successfully, and showing no live claimant — is a recoverable state.
7. **Keep the malformed-declaration refusal.** It lives in `assessReviewScope`,
   not in the lineage function (see above). A rewrite that touches only the
   lineage function must not assume it is inherited.

## If dead-chain recovery is built

The narrow version does not need the lineage rewrite at all. It is a watchdog: an
obligation is released — loudly, with a comment naming the unit and why — when

- the evidence was read successfully (requirement 6: never on a failed read), and
- **at least one unit has historically claimed it**, and
- no OPEN pull request claims it, and
- every unit that ever claimed it is closed unmerged.

**The historical-claimant condition is not optional.** Without it, a newly
exhausted unit satisfies the rule the moment it is labelled: nothing has claimed
it yet, so "every unit that ever claimed it is closed unmerged" is vacuously true
over an empty set. The watchdog would release brand-new obligations before their
replacement is even opened, bypassing the two-head replacement rule entirely
rather than recovering a dead chain. An earlier sketch omitted this and is
corrected here.

Its weakness is stated plainly: a released obligation is unresolved scope that
nobody is now tracking. That is why the release has to be loud, and why it is
bounded to chains that are provably dead.

## Where things stand

- `main`'s rule is unchanged. Both defects above are live.
- **#377 and #378 both carry `review-replacement-required`, and both stay.** This
  unit replaces #378. #377's obligation is discharged only by a merged unit
  carrying its implementation scope and its unresolved findings — the separate
  review unit that follows this one.
- Until that unit merges, `Replaces: none` work is refused. That is the rule
  working, not failing. Executed: with both units labelled, a fresh `none` unit is
  refused naming #377; a unit declaring `Replaces: #378` is admitted; after this
  one merges, a unit declaring `Replaces: #377` is admitted and `none` is still
  refused.
- #363 (the schedule dependency graph, an unrelated track) is parked at its green
  head. It declares `Replaces: none` truthfully and will not be edited to claim an
  obligation it does not carry — declaring a false replacement discharges real
  scope with unrelated work, which is the failure this whole rule exists to
  prevent.
- The stale labels on #344, #357, #367, #373, #374, #375 and #376 were cleared by
  hand on 2026-08-19. That clearing is recorded here as history. It is not a
  precedent: the remedy for a dead chain is the watchdog above, built and
  reviewed, not an operator deleting labels.
