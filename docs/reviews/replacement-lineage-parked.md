# The replacement-lineage rule, and why six attempts to fix it are parked

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

A pull request body is editable by anyone who can edit a pull request, and the
rule above reads discharge out of exactly one of them: the body of a MERGED pull
request. So the attack on `main` is direct — edit an already-merged body to say
`Replaces: #<a currently-labelled unit>` and that unit is discharged outright,
by work that never carried its scope.

Note what is NOT an attack on `main`, because an earlier version of this document
had it backwards. Editing an exhausted unit X to name #354 and merging something
that names X discharges **X**, not #354: `fulfilledSources` compares each merged
body directly against each labelled source and never follows a chain. That
transitive shape is a real hazard for designs that DO follow the chain — it is
what failed #367 — but describing it as live on `main` would hand a future repair
the wrong threat model.

**This surface exists on `main` today.** It is not introduced by anything that was
attempted; the attempts were failed for not closing it, which is a different
thing. Nobody has exploited it, and in a repository whose pull requests are
authored by its owner and two agents the exposure is small — but it is real, and
it is the reason a future attempt cannot simply re-derive lineage from bodies.

## What was attempted, and what each review found

Six units, none merged. The design changed three times; the reviews are the
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
should get further than these six did:

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
   `GITHUB_TOKEN` and `issues: write`, so every workflow in this repository
   shares one `github-actions[bot]` identity, and any write-capable workflow
   added later would be indistinguishable from the controller. The timeline
   actor is a necessary filter, not sufficient evidence; controller-specific
   evidence is still needed on top of it. (The parked implementation treats the
   actor as sufficient. That is one of its known gaps.)
4. **Concurrency resolves by recorded order, not by locking.** Label writes cannot
   be made mutually exclusive; the earliest recorded claim wins, ties going to the
   timeline's order.
5. **Conservation must hold in both directions.** A unit that ends up holding two
   claims must settle neither — *and* the sources it raced into must remain
   claimable, or they become permanently stuck, which is the original defect
   again.
6. **Distinguish a dead chain from missing evidence.** Four of the six units
   introduced a state where the repository blocked itself, and a rule that strands
   obligations differently is worse than none — so a provably dead chain must be
   recoverable without a human. That is NOT a licence to fail open in general:
   when the lineage evidence itself is unavailable, truncated or malformed,
   nothing is proven and the gate must stay closed, exactly as `main` already
   does (`required replacement lineage could not be read from GitHub`). Recover
   from a state you can read and prove; refuse one you cannot.

The last attempt's full implementation is on the closed pull requests, most
completely at #377 head `1e7a7c0`, with 21 reproduce-first probes in
`scripts/autonomous-replacement-lineage.test.mjs`. It is not proposed for merge as
it stands — two known findings are open against it — but it is a working starting
point rather than a blank page.

## The objection to parking, and where it stands

The review of this document raised one P1 against the decision itself, and it is
recorded here rather than argued away: **parking leaves the loop with no
autonomous recovery.** When a replacement chain next dies unmerged, the unchanged
gate refuses every fresh `Replaces: none` unit, and the only remedy named here is
a human deleting labels. With nobody standing by, unrelated work stalls
indefinitely — which is what happened on 2026-08-19, for 38 hours, to a pull
request on another track.

That is correct, and the decision to park was made with it in view: six units
spent trying to make the rule sound produced no merge and four repository-wide
stalls of their own. The owner's call was that a bounded, known manual step beats
continuing to pay that price tonight.

If the automatic recovery is built later, the reviews above suggest it does not
need the lineage rewrite at all. The narrow version is a watchdog rule: when a
labelled unit has been claimed AT LEAST ONCE, has no OPEN pull request claiming
it now, and every unit that ever claimed it is closed unmerged, the obligation is
released — with a comment recording which unit was released and why — rather than
blocking the repository. The historical-claimant condition is not optional: a
newly exhausted unit has no claimants at all, so without it the watchdog would
release every obligation the moment it was created and the two-head rule would
mean nothing.
It fails forward, needs no chain derivation, and its weakness is stated plainly:
a released obligation is unresolved scope that nobody is now tracking, so the
release has to be loud. That trade is the owner's to make, not the gate's.

## What this leaves in place

- `main`'s rule is unchanged: both defects above are live.
- The stale `review-replacement-required` labels on #344, #357, #367, #373, #374,
  #375 and #376 were cleared by hand so the repository accepts fresh work.
- **#377's obligation is unresolved, and this record does not discharge it.** It
  was cleared with the rest and the owner restored it, which was the correct
  call: that unit's scope is the only one still live, and releasing it silently
  would have been the same forgetting the rule exists to prevent. An earlier
  version of this document declared `Replaces: #377`, which was wrong — a
  documentation unit that records unfinished work does not carry it, and merging
  one under that declaration would have waived the scope while leaving #377's two
  findings and its implementation undone.
- So the obligation stands, and with it the block on fresh `Replaces: none` work.
  Resolving it takes a deliberate act, and there are only three: build the
  remaining scope, release the obligation explicitly and record the release, or
  leave it blocking. That choice belongs to the owner, and this document exists
  to make it an informed one rather than a silent one.
- When a replacement chain next dies mid-way, the labels will need clearing by
  hand again. That is the cost of parking, stated above with the objection to it.
  It is a known, bounded, manual step — but it is a manual step in a loop whose
  point is not to need one.
