# The replacement-lineage rule, and why seven attempts to fix it are parked

Status: **parked by owner decision on 2026-08-19.** Nothing here changes the
gate. `main` behaves exactly as it did before the attempt began, and the record
below is what a future attempt needs so it does not start from the same place.

## What the rule does today

`scripts/review-efficiency.mjs` refuses every pull request in this repository
until its replacement lineage checks out. When a unit reaches the two-finding-head
limit the controller labels it `review-replacement-required`, and
`assessReplacementLineage` then decides two things:

- a unit declaring `Replaces: #N` is admitted when #N is labelled, closed, and not
  already claimed by another OPEN pull request whose body names it;
- a unit declaring `Replaces: none` is refused while any labelled unit is not
  discharged, and discharge means: some MERGED pull request, numbered higher than
  the labelled unit, whose body says `Replaces: #<that unit>`.

Both readings come from pull request BODIES.

## What is wrong with it

### 1. A dead replacement strands the debt permanently

Discharge requires a merged pull request naming the exhausted number *exactly*.
Each replacement names only its immediate predecessor, so if a replacement dies
unmerged, the original is named by nothing that will ever merge.

This is not hypothetical. On 2026-08-18 #354 reached the limit, #360 replaced it
and reached the limit too, and #361 replaced #360. Nothing would ever name #354
again, so every `Replaces: none` unit in the repository was refused. The label was
cleared by hand three times that night to keep the loop moving. It happened again
on 2026-08-19 at a larger scale: eight units carried the label, unrelated work
(#363, a different track) was refused for 38 hours, and the labels were cleared by
hand again — the clearing recorded in this same commit.

**Operational consequence:** every time a replacement chain dies mid-way, someone
must delete labels by hand or the whole repository stops accepting fresh work.

### 2. Lineage is read from text anyone can rewrite

A pull request body is editable by anyone who can edit a pull request. Two
consequences follow directly from the rule above:

- An unrelated unit that exhausted its own review rounds can have
  `Replaces: #354` written into it afterwards. If a merged pull request names
  *that* unit, #354 is discharged by work that never carried its scope.
- A MERGED pull request's body is editable too, so editing an old merged body to
  name a currently-labelled unit discharges it outright.

**This surface exists on `main` today.** It is not introduced by anything that was
attempted; the attempts were failed for not closing it, which is a different
thing. Nobody has exploited it, and in a repository whose pull requests are
authored by its owner and two agents the exposure is small — but it is real, and
it is the reason a future attempt cannot simply re-derive lineage from bodies.

## What was attempted, and what each review found

Seven units, none merged. The design changed three times; the reviews are the
useful part.

| Unit | Design | What the review found |
| --- | --- | --- |
| #367 | Walk the claim chain over bodies | Any closed PR counted as a link, so an unrelated exhausted unit plus a merged replacement of it discharged a source it never carried |
| #373 | Require each link to be exhausted, then to have outlived its source | Ordering narrows the window but never proves *when* the declaration was written |
| #374 | Move one boolean label from source to claimant | Legacy labels unmigrated (repository blocked); one unit could absorb a second obligation; an interrupted two-call move is indistinguishable from absorption |
| #375 | Name the claim in a `review-replaces-N` label on the claimant | A label carries no proof of who applied it; two claims can race; targeting `main` is not being built on it |
| #376 | Read claims from the issue timeline actor | Merge-base *dates* reject valid replacements; following current labels means removing one erases the record |
| #377 | Record the claim on the exhausted unit's timeline | Containment settled once instead of per evaluation; a unit could hold two claims; same-second ties broke on PR number; then: promoting a fallback claim can overload the promoted unit; revalidation checked head/body/state but not base |

Two things are worth carrying forward more than the table:

- **The first three units patched a trust model the review had already rejected.**
  Two reviews said lineage derived from editable text cannot be trusted before the
  design changed. Narrowing a forgery window twice cost two units.
- **The last two units were no longer design failures.** They were second-order
  bugs in the fix — each fix creating the next one. That is a signal the surface
  is intricate, not that the direction was wrong.

## What a future attempt needs

The reviews converge on a small set of requirements. Any design that meets them
should get further than these seven did:

1. **The record must name both ends** — which obligation, and who took it on. A
   boolean cannot express an interrupted transfer versus a second obligation.
2. **It must be written where the controller can always find it again**, not
   through whatever labels currently exist. The exhausted units are enumerable;
   claimants are not.
3. **Provenance must be authenticated.** GitHub labels are writable by any
   collaborator; the issue timeline records the actor and cannot be edited, which
   is the only reading of a label that proves the controller wrote it.
4. **Concurrency resolves by recorded order, not by locking.** Label writes cannot
   be made mutually exclusive; the earliest recorded claim wins, ties going to the
   timeline's order.
5. **Conservation must hold in both directions.** A unit that ends up holding two
   claims must settle neither — *and* the sources it raced into must remain
   claimable, or they become permanently stuck, which is the original defect
   again.
6. **Every gate must fail toward the loop continuing.** Four of the seven units
   introduced a state where the repository blocked itself. The rule exists to stop
   obligations stranding; a rule that strands them differently is worse than none.

The last attempt's full implementation is on the closed pull requests, most
completely at #377 head `1e7a7c0`, with 21 reproduce-first probes in
`scripts/autonomous-replacement-lineage.test.mjs`. It is not proposed for merge as
it stands — two known findings are open against it — but it is a working starting
point rather than a blank page.

## What this leaves in place

- `main`'s rule is unchanged: both defects above are live.
- The stale `review-replacement-required` labels on #344, #357, #367, #373, #374,
  #375, #376 and #377 were cleared by hand so the repository accepts fresh work.
- When a replacement chain next dies mid-way, the labels will need clearing by
  hand again. That is the cost of parking, and it is a known, bounded, manual
  step rather than an unbounded one.
