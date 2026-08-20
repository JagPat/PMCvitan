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
them. Two claims in this document's first head did not survive that execution and
are corrected in place, marked where they appear.

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

### 1. Obligations accumulate faster than they can be discharged

**This section previously said a dead replacement strands its debt permanently.
That is wrong, and the correction changes what the repair has to do.** Executed:
after #354's only claimant #360 died unmerged, a new unit declaring
`Replaces: #354` is **admitted** — `competing` blocks only on an OPEN claimant, so
a dead one blocks nothing. It is still admitted after an intervening merge that
named #360. No obligation in this repository has ever been unclaimable.

The real defect is arithmetic. Every replacement that is itself exhausted adds a
second label, and **one merged unit can retire exactly one obligation**: two
`Replaces:` lines parse as `invalid` and are refused outright, so a unit cannot
name two sources however honestly it carries both. Clearing N accumulated labels
therefore takes N sequential merged units, and the backlog grows whenever
replacements are exhausted faster than they merge.

That is what happened. On 2026-08-18 #354 was exhausted, #360 replaced it and was
exhausted too, and #361 then declared `Replaces: #360` — discharging #360 and
leaving #354 owed, because a replacement names its immediate predecessor rather
than whatever is still outstanding. Executed: after #361 merges naming #360, a
fresh `Replaces: none` unit is refused naming #354, and #354 is still claimable.
The same shape recurred on 2026-08-19 at eight units, with unrelated work (#363)
refused for 38 hours, and again on 2026-08-20 with #377 and #378.

**Operational consequence:** the backlog is not stuck, it is *long*, and every
entry costs one sequential review unit. The remedy is not a release valve. It is
that a replacement must be able to carry more than one obligation, and that it
should name what is still owed rather than only what it directly followed.

**This document is itself the third data point, and the second in two days.**
#378 was the record of the repair and was exhausted; #379 replaced it and was
exhausted in turn; this unit replaces #379. Each closure added a label rather
than moving one. Executed against the live rule with #377, #378 and #379 all
labelled: this unit declaring `Replaces: #379` is admitted, a fresh
`Replaces: none` unit is refused naming #377, and **after this unit merges #377
and #378 are both still owed** — two further sequential units, for a chain whose
entire subject is that this happens. Nothing here is stuck; the queue is three
deep and drains one per merge.

### 2. Lineage is read from text anyone can rewrite

A pull request body is editable by anyone who can edit a pull request. One
consequence follows, and one that an earlier record claimed does not.

**The real one.** A MERGED pull request's body is editable. Editing an old merged
body to say `Replaces: #354` discharges #354 outright, with work that never
carried its scope. Executed: a labelled #354 plus a merged #372 whose body is
edited to name it returns `allowed: true` for a fresh `Replaces: none` unit. Any
merged pull request numbered above the target will do.

**The one that is not real, corrected.** #378 also claimed a transitive attack:
edit an unrelated exhausted unit X to say `Replaces: #354`, then merge Y saying
`Replaces: #X`, and #354 is discharged. **It is not.** `fulfilledSources` compares
each candidate's declaration *directly* against each labelled source, so Y fulfils
X and #354 stays pending. Executed: the fresh unit is still refused. The chain is
never walked.

Recording the wrong attack is worse than recording none, because a future
implementation would be built against a threat model the code does not have.

### 3. An empty enumeration reads as "nothing is owed"

**This document's first head claimed `main` already fails closed on truncated
evidence. That is wrong.** `assessReplacementLineage` refuses only a *non-array*
input — `requiredReplacements: null` returns `required replacement lineage could
not be read from GitHub`. A successful but **incomplete** response does not:
executed, `requiredReplacements: []` admits a fresh `Replaces: none` unit while
#354 is still labelled in reality.

Every ordinary evidence-loss shape lands in that gap — a paginated listing whose
second page was not fetched, a label query filtered wrongly, a permissions change
that hides issues, an API returning `200` with an empty page. None of them look
like an error, and all of them read as an empty obligation set.

**This surface is live on `main` today**, along with the editable-body one above.
Neither is introduced by anything that was attempted; the attempts were failed for
not closing them, which is a different thing.

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

The reviews converge on a set of requirements. Any design meeting them should get
further than these six did.

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
   sufficient. That is one of its known gaps, and one of the findings its
   replacement must carry.)
4. **Concurrency resolves by recorded order, not by locking.** Label writes cannot
   be made mutually exclusive; the earliest recorded claim wins, ties going to the
   timeline's order.
5. **A replacement must be able to carry more than one obligation, as one
   DECLARED bundle.** This is what §1 actually asks for, and no attempt so far
   provides it. Today a unit declares at most one source, so an accumulated
   backlog costs one sequential merged unit per entry. The bundle is the set the
   claimant *declared* and the controller *admitted*, recorded in a single write;
   on merge it settles exactly its members, all of them or none. **It must not be
   implemented by waiving.** Discharge still requires a unit that carried the
   scope; what changes is how many obligations one such unit may carry, never
   whether an obligation can lapse unmet.
6. **Conservation applies to claims the claimant never declared, and those are a
   different thing from a bundle.** These two requirements are the ones most
   easily written into contradiction — an earlier version of this document did
   exactly that, saying in one breath that a unit holding two claims settles
   neither and in the next that a unit must be able to discharge several. The
   distinction that resolves it is *declaration*, not count:

   - A claim **inside** the declared, admitted bundle is intended scope. It
     settles on merge, atomically with its siblings.
   - A claim **outside** it — acquired by a race, or by the declaration changing
     between two controller runs — is not scope anyone carried. It settles
     nothing, the unit holding it is refused, and **the source stays claimable**,
     or it becomes permanently stuck, which is the accumulation defect made
     permanent.

   An implementation that enforces only the second rule leaves the backlog
   exactly as it is; one that enforces only the first lets a raced claim discharge
   an obligation nobody carried. Both rules are needed, and the bundle boundary is
   what tells them apart.
7. **Distinguish a dead chain from missing evidence, and treat an incomplete
   enumeration as missing.** Unknown lineage must never admit work. `main` fails
   closed only on a non-array (§3), so a repair that "keeps the current
   behaviour" inherits the empty-response bypass. The repair needs an explicit
   completeness check — an authenticated or independently-bounded enumeration,
   or a recorded expected count — before an empty or partial result is treated as
   authoritative.
8. **Revalidate the whole claimant at the authorization boundary, base included.**
   #377 revalidated head, body and state but not base, and a claimant retargeted
   to another or stale base after its claim was recorded still satisfied every
   other check — discharging its source with a replacement that does not contain
   the current-`main` unresolved unit. A timeline claim cannot be withdrawn once
   written, so base identity and ancestry must be checked *before* the write and
   again at every later evaluation, alongside head, body and state.
9. **The claim must preserve the source's correction owner.** Every pull request
   here declares exactly one correction owner, and the repository routes a unit's
   corrections to that owner alone — a `claude/**` branch may only declare
   `claude`, and no agent may act on another's behalf. None of the requirements
   above bind that, so a `claude`-owned replacement could satisfy all of them and
   discharge a `cursor`-owned exhausted unit whose corrections Claude is
   explicitly forbidden to make. The exhausted source's declared owner must be
   bound into the claim at admission, and owner equality revalidated at the
   authorization boundary alongside head, body, state and base — a mismatched
   claimant is refused and settles nothing, and the source stays claimable by its
   own owner.
10. **Migrate the obligations that already exist, atomically and retry-safely.**
   #374 blocked the repository precisely here: it changed the representation and
   left the existing labels unreadable. Any new record starts with live debts
   against it — #377 and #378 today — and switching assessment without a bootstrap
   either omits them (admitting `Replaces: none` against real unresolved scope) or
   fails closed forever, because no claim in the new format can exist for a unit
   that was labelled before the format did. The repair needs a migration or
   read-compatibility path covering **every** already-labelled source, applied
   atomically and safe to re-run, before the new assessment is enabled.
11. **Keep the malformed-declaration refusal.** It lives in `assessReviewScope`,
    not in the lineage function. A rewrite that touches only the lineage function
    must not assume it is inherited.

### On the automatic release valve that was sketched here

An earlier version of this document proposed a watchdog that **released** an
obligation when no open unit claimed it and every unit that ever claimed it had
closed unmerged. **It is removed rather than repaired**, for two independent
reasons, and it should not be reintroduced in either form.

- **It waives unresolved scope.** A released obligation is scope whose findings
  were neither fixed nor carried, and after the release a fresh `Replaces: none`
  unit passes. Making the release "loud" records the waiver; it does not preserve
  the work. Recovery would have to transfer or recreate the obligation, never
  drop it — at which point it is requirement 6, not a release.
- **It addresses a state that does not occur.** §1 shows by execution that a dead
  claimant blocks nothing and the source stays claimable. There is no permanently
  dead chain to recover from.

An earlier sketch also omitted that the condition is vacuously true over an empty
set — a unit satisfied it the moment it was labelled, before any replacement was
opened. That is recorded here so the same rule is not re-derived and re-proposed
with the same hole.

## Where things stand

- `main`'s rule is unchanged. All three defects above are live.
- **#377, #378 and #379 all carry `review-replacement-required`, and all stay.**
  This unit replaces #379 and carries the record forward. #378's obligation is
  discharged by a later unit carrying the same record scope; #377's only by a
  merged unit carrying its implementation scope and its unresolved findings.
- Until those merge, `Replaces: none` work is refused. That is the rule working,
  not failing — the queue is long, not jammed, and every entry is claimable
  today.
- #363 (the schedule dependency graph, an unrelated track) is parked at its green
  head. It declares `Replaces: none` truthfully and will not be edited to claim an
  obligation it does not carry — declaring a false replacement discharges real
  scope with unrelated work, which is the failure this whole rule exists to
  prevent.
- The stale labels on #344, #357, #367, #373, #374, #375 and #376 were cleared by
  hand on 2026-08-19. That clearing is recorded here as history, and it is not a
  precedent: hand-clearing is waiving, and §1 shows the backlog it was used
  against was long rather than stuck. Requirement 6 is the remedy.
