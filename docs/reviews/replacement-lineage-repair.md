# The replacement-lineage rule: what is wrong with it, and what its repair must do

Status: **the repair is resuming.** An earlier record (#378) proposed parking it;
that framing was withdrawn by owner directive on 2026-08-20, and the programme
mandate is unchanged — autonomous, fail-closed convergence, with unresolved
findings carried forward rather than released.

**This unit replaces #386, and it discharges nothing else.** It does **not**
discharge #385, #384, #383, #379 or #378, which hold the same record scope
further back, and it does **not** discharge #377, which holds the lineage-repair
*implementation*.
Every pending unit keeps its `review-replacement-required` label, they discharge
one per merge, and no label is to be cleared by hand. §"Where things stand"
states the same thing; if the two ever disagree, that section is authoritative
and this paragraph is the stale one.

Every claim below about how `main` behaves was checked by **executing**
`assessReplacementLineage` and `assessReviewScope` at `5c2b739`, not by reading
them; the claims this head adds about git and pull-request metadata were checked
against `main` at `1449c82` on 2026-08-20, and each says what was run. Claims made
in earlier heads of this lineage that did not survive execution are corrected in
place, marked where they appear.

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

**This document is itself the running data point.** #378 was the record and was
exhausted; #379 replaced it and was exhausted; #381 replaced #379 and was
exhausted; **#382 replaced #381 and MERGED** on 2026-08-20, which is how this
text reached `main`; #383 carried it forward and was exhausted; #384, #385 and
#386 each did the same; this unit replaces #386. Each closure **at the round
limit**
added a label rather than moving one — and only those closures do. #380, a
parallel replacement for #378 opened and closed the same minute without reaching
the limit, left no label and added no obligation. The label marks an exhausted
unit, not a closed one, and that distinction is what keeps the queue finite.

**Where the rounds actually went, because the shape is the finding.** Seven on
#378, seven on #379, three on #381, none on #382 — then one and four on #383,
three and two on #384, three and two on #385, two and two on #386, and five on
#387's first head. The rise from #383 onward was
**entirely requirement 10**, the migration cutover: five formulations of one rule,
each found. Every other round in this lineage found contradictions between
sentences; those rounds found hazards in an operation, and no amount of rewriting
the paragraph closed them.

**Removing the requirement did not close them either**, and that is the part worth
recording. #385's review established that two surviving requirements — the bundle,
and owner equality — each depended on the record the removal had deleted, so the
narrowed repair was incoherent rather than smaller.

**#386's two rounds then settled both, and the four findings share two roots
worth more than the fixes.**

**Root one — naming a hole is not closing it.** Requirement 1 twice described an
exposure it had decided to live with: first a pre-merge window in which a
body-and-git rule could be edited from a reviewed singleton into a bundle, then
body settlement for single-source claims, "deliberately not improved" because
changing it would un-discharge #381. Both were written as honest disclosures and
both were live holes; the second review said so in as many words. The fixes were
available and ordinary — settle from git alone, and fence the change so it cannot
un-discharge what is already settled — so what stood in for the fix was the
disclosure. (The first fence written for it was by pull request number, on the
model of `REVIEW_SCOPE_ENFORCE_AFTER_PR = 246` and
`PRE_REVIEW_ENFORCE_AFTER_PR = 345`. #387's review found that wrong too: those
fence behaviour applied to a pull request, where a number fits, while this fences
evidence already written, where an unmerged lower-numbered unit like #363 walks
straight through. The fence is merge state, in requirement 1.)

**Root two — "cannot be authenticated" is not "cannot be used".** Owner equality
was first read from an editable body and called preserved (#381 found it), then
derived from a `claude/**` head ref and failed closed elsewhere (#386 found that
this repository had already refuted the derivation, and that failing closed jams
the queue forever), then removed outright on the reasoning that forgeable evidence
is no evidence — which #386's second round refuted in turn, because under bundles
the removal lets one claimant discharge another agent's scope wholesale. Then
#387's round showed the fourth statement was wrong as well, for a reason the third
had created. **The root is not that a forgeable check is worthless; it is that the
document kept asserting how much the check was WORTH without re-measuring after
the design around it changed.** Requirement 5 no longer claims a value it cannot
demonstrate: it asks only that the repair not make cross-owner discharge cheaper
than the live rule already makes it, and it names the authenticated record as the
thing that would turn that into a real rule.

**#387's first round then found four more, and one is the sharpest observation in
this lineage:** making settlement read git left the owner marker *cheaper to forge
than settlement*, so the justification carried forward from the previous head —
"the same capability already defeats settlement" — was falsified by the very change
that shipped beside it. A repair that fixes one leg and reuses the old measurement
for the other is measuring against a state it has just removed. The other three
were a fence by pull request number that the still-open #363 walks straight
through, a completeness check computed from the very enumeration it was meant to
bound, and a competition rule that refuses every claimant and frees nobody.

Nine finding-bearing heads across five units bought these roots — #383, #384,
#385 and #386 at two apiece, and #387's first — which is the count the rounds line
above adds up to. They are written down here so they are not paid a third time.

Nothing here is stuck; every entry is claimable, and the queue drains one per
merge.

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

**An earlier head of this lineage claimed `main` already fails closed on
truncated evidence. That is wrong.** `assessReplacementLineage` refuses only a *non-array*
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

**Scope narrowed by owner decision, 2026-08-20: the repair does NOT change how
lineage is stored.** Requirement 10 — the migration cutover — is removed, not
deferred. Five successive formulations of it drew findings, and the last two
eliminated two of its three possible trust roots: a one-time operator attestation
is a manual act inside an autonomous loop, and timeline provenance cannot recover
the correction owner, which lives in an editable body.

**That decision stands, and neither stranded requirement needs the record
restored.** Removing the cutover left the bundle and owner equality both resting
on a record that no longer existed, which is what #385's review found. #386's two
rounds settled how each stands without one:

| Requirement | Rests on | What it does not do |
| --- | --- | --- |
| **1** — the claim itself | `main`'s protected git history, for every candidate that merges after the repair ships | it does not settle from a body, at any size, except for candidates already merged when it shipped |
| **5** — cross-owner cost | the SHAPE of the rule: a bundle may not span declared owners | it does not authenticate an owner, and it does not preserve correction ownership |

Neither is a store, a migration or a backfill. Requirement 1's fence is a fact
about the repository at one instant — the already-merged set, which cannot gain a
member — and requirement 5 asks only that the repair not make cross-owner
discharge cheaper than the live rule already makes it.

**What multi-obligation carry costs — two earlier claims here were wrong, and
stay struck.**

An earlier version of this section said it was "one bounded change in one
function" and that it "adds no attack surface". Both were asserted rather than
executed:

- **It is four sites, not one, and that is still true.** `replacementDeclaration`
  must parse a set, but `replacementSource` returns a scalar, and
  `assessReplacementLineage` uses scalar equality in *both* `fulfilledSources` and
  its competing-claim detection. Executed: a two-line declaration makes
  `replacementSource` return `null`, so a parser-only change fulfils **nothing**
  and leaves the backlog exactly as blocked. Admission, competition and settlement
  all need updating together.
- **"Adds no attack surface" was false of the design as it then stood, and it is
  the design that changed.** A bundle read from a pull request body multiplies §2:
  today one edited merged body discharges exactly one obligation, because only one
  `Replaces:` line parses, whereas a bundle read from the same place would let a
  single edit discharge the whole backlog. Conflating "as forgeable per line" with
  "no new attack surface" was the error, and it was mine. Requirement 1 now
  settles a bundle only against evidence a later edit cannot reach, which is what
  makes the property that sentence merely asserted actually hold. The arithmetic
  and what was executed are in requirement 1; the struck sentence is not restored,
  because its reasoning was wrong even where its conclusion is now recoverable.

So the repair is now these, and only these. Requirements 1 and 5 each carry the
two wrong turns taken before them, because both wrong turns are ones a later
reader would take again:

1. **A replacement must be able to carry more than one obligation, as one
   DECLARED bundle — and every claim, of any size, settles only against evidence a
   later edit cannot reach.** This is what §1 actually asks for, and no attempt so far
   provides it. Today a unit declares at most one source, so an accumulated
   backlog costs one sequential merged unit per entry. The bundle is the set the
   claimant *declared* and the controller *admitted*; on merge it settles exactly
   its members, all of them or none. **It must not be implemented by waiving.**
   Discharge still requires a unit that carried the scope; what changes is how
   many obligations one such unit may carry, never whether an obligation can lapse
   unmet.

   **Settlement evidence is git, for every claim.** An earlier head of this
   requirement kept body settlement for a claim naming ONE source and called that
   "deliberately not improved", on the reasoning that changing it would
   un-discharge settlements already computed that way — #381's among them.
   #386's review named that for what it was: knowingly retaining a freely
   rewritable trusted claim. The constraint was real; treating it as a reason to
   keep the hole was not, because the constraint has a standard answer.

   **The fence is merge state at the cutover, not a pull request number.** An
   earlier head of this requirement fenced by number, on the model of
   `REVIEW_SCOPE_ENFORCE_AFTER_PR = 246` and `PRE_REVIEW_ENFORCE_AFTER_PR = 345`
   in `scripts/review-efficiency.mjs`. Those two fence *behaviour applied to a pull
   request*, where a number is exactly right. This fences *evidence already
   written*, where it is wrong: a lower-numbered pull request that has not merged
   yet can still merge later, and would then be on the body path permanently.
   **#363 is that case sitting in the open right now** — parked, numbered below any
   boundary this repair could pick, and expected to merge once the queue drains.
   A closed lower-numbered unit can also be reopened. So:

   - a candidate that had **already merged when the repair shipped** settles from
     its body, exactly as today;
   - **every other candidate settles from git** — merging later, whatever its
     number.

   That set is closed by construction: it cannot gain a member, because nothing
   can retroactively become already-merged. It preserves every discharge already
   computed, #381's among them, and it is a fact about the repository at one
   instant rather than a list to maintain — which is the distinction #374 got
   wrong when it hardcoded the numbers of the day.

   **Where the git evidence lives.** The declaration goes in a commit message on
   the claimant's branch, so it is inside the exact head the reviewer approved —
   there is no version of a claim that settles and was not reviewed. Two anchors,
   both required, because either alone has a hole:

   - the declaration appears in the message of a commit **belonging to the merged
     pull request** — a SHA the reviewed head fixes; and
   - the merged commit on `main` carries **the same set**, so what settles is also
     what protected history holds.

   Requiring both closes the merge-time override as well: a merge that supplies an
   invented commit message disagrees with the pull request's own commits, and
   disagreement settles nothing.

   **The second anchor must be CONSTRUCTED, not assumed, and both merge paths need
   changing.** Executed in `scripts/autonomous-review-gate.mjs`: `enableAutoMerge`
   passes only `mergeMethod: SQUASH` to `enablePullRequestAutoMerge`, and
   `mergeExactHead` sends only `merge_method` and `sha` to the REST merge
   endpoint. **Neither sets the squash commit body.** What `1449c82` contains is
   therefore GitHub's default formatting under this repository's current settings —
   an observation, not a guarantee, and a repair resting on it would rest on a
   setting this design does not control.

   Because settlement fails CLOSED, guessing wrong is not a silent loss but a jam:
   an admitted replacement whose branch carries the declaration merges into a
   commit that does not, settles nothing, and leaves its obligation pending with no
   unit able to take it. **So the repair must make both paths compose the merge
   commit message explicitly from the reviewed declaration**, rather than relying
   on either default.

   **An earlier head had settlement read body AND git, and that was a P1.** It
   named the gap between the reviewed head and the merge as a window it did not
   close. Executed as a threat rather than described: a claimant declares ONE
   source in its body, carries the bundle in its commit message, is reviewed and
   admitted on the singleton, and then edits the body to the bundle after the final
   policy check — the head SHA and every status unchanged — at which point body and
   git agree and the whole backlog settles on a review that saw one obligation.
   Documenting that window did not preserve the declared-and-admitted invariant; it
   only described losing it. Settlement reading git alone removes the window rather
   than narrowing it.

   **Admission checks the two against each other.** At review time the body's
   declared set must EQUAL the git set, so the reviewer is shown the claim that
   will actually settle and a mismatch is refused outright. After admission the
   body is not consulted again on this path.

   Executed on 2026-08-20 against `main` `1449c82`, the merge that discharged
   #381:

   - **`main` is a protected branch** (`protected: true`). A commit message is
     part of the commit's identity, so changing one replaces the commit, and on
     `main` that takes a history rewrite rather than a pull-request edit.
   - **That merge commit's message carries zero line-anchored `Replaces:`
     declarations**, while #382's body carries exactly one — and the body is what
     discharged #381. So the evidence the live rule settles on exists *only* in
     editable text, and git carries none of it today. This is also why the fence
     is necessary rather than merely convenient: applied retroactively, a git-only
     rule would un-discharge #381.
   - The squash merge that produced `1449c82` put the pull request's title in the
     subject and its branch commit messages in the body, and did not carry the
     pull request body at all. The title is editable after review, which is why
     the subject line is not the anchor.

   **The arithmetic, which is the whole point of the requirement:**

   | Settlement evidence | Obligations one edited merged body can discharge |
   | --- | --- |
   | Today | **1** — executed |
   | A bundle read from the body | the whole backlog, in one edit |
   | A bundle read from body AND git | the whole backlog — the pre-merge edit above |
   | Git, for a candidate merged after the repair | **0** |
   | Git, with an already-merged legacy candidate | **1** — a closed set that cannot gain a member |

   A claim whose git evidence is missing must settle **nothing at all**. It must
   never fall back to its first entry, or to its body: either reintroduces a row
   above one obligation at a time, which is the same defect at a slower rate.

2. **Conservation applies to claims the claimant never declared, and those are a
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

   **Overlapping claims need a WINNER, not a mutual refusal — the live rule
   deadlocks.** Executed against `assessReplacementLineage`: with #378 labelled and
   two open claimants #400 and #401 both declaring it, #400 is refused naming #401
   and #401 is refused naming #400. A third claimant #402 is refused naming #400.
   Nothing in the design frees #378: every claimant is blocked by another open one,
   and no transition removes a blocker except somebody closing a pull request by
   hand. "The source stays claimable" is not delivered by refusing everyone.

   So competition must **resolve deterministically**: exactly one open claimant
   holds a source and the rest are refused naming the holder. The order must not
   depend on when an evaluator happened to run — the earliest recorded admission
   where one exists, and otherwise the lowest-numbered open claimant, which every
   evaluator computes identically from the same listing. A raced claim outside the
   holder's bundle still settles nothing, which is the rule above; what changes is
   that the obligation always has exactly one claimant able to discharge it. This
   interleaving needs an explicit-barrier test asserting that one claimant is
   admitted, the other refused, and the obligation conserved.

3. **Distinguish a dead chain from missing evidence, and bound the enumeration
   from OUTSIDE it.** Unknown lineage must never admit work. `main` fails closed
   only on a non-array (§3), so a repair that "keeps the current behaviour"
   inherits the empty-response bypass.

   **A completeness check computed from the same query is worth nothing**, and an
   earlier head of this requirement asked for one anyway. If a permissions change
   or a wrong filter returns `200` with an empty page, then a count, a checksum or
   an expected-size derived from that same page is empty too, agrees with itself,
   and `Replaces: none` passes while obligations stand. The check must come from a
   source that cannot go empty for the same reason.

   **The repository already has one: git.** `docs/STATUS.md` is committed, names
   the pending set in prose today, and every change to it passes through a
   reviewed pull request. Making that enumeration machine-readable gives the gate
   a second, independently-sourced list, and the rule is a comparison:

   - the two agree → the enumeration is trusted;
   - they disagree, in either direction → **refuse**, naming both, because one of
     them is wrong and the gate cannot tell which;
   - the committed list is unreadable → refuse, exactly as a non-array does today.

   A hidden-label response now disagrees with a non-empty committed list and is
   caught. This is not the authenticated record §2 needs — a pull request can edit
   the committed list, and an attacker able to edit both stays ahead of it — but it
   closes the *accidental* evidence-loss case, which is the one §3 is about, and
   it costs a file this repository already maintains by hand.

4. **Revalidate the whole claimant at the authorization boundary, base included.**
   #377 revalidated head, body and state but not base, and a claimant retargeted
   to another or stale base after its claim was recorded still satisfied every
   other check — discharging its source with a replacement that does not contain
   the current-`main` unresolved unit. A timeline claim cannot be withdrawn once
   written, so base identity and ancestry must be checked *before* the write and
   again at every later evaluation, alongside head, body and state.

   **The revalidated set is the git set.** Requirement 1 settles from git alone
   after its boundary, whatever the claim's size, so what this revalidation must
   keep current is the git declaration and its agreement with the body at
   admission — not the body on its own. Revalidating only the body would re-open
   exactly the window requirement 1 closes: the two requirements have to name the
   same evidence, or the later one quietly undoes the earlier.

5. **The repair must not make cross-owner discharge cheaper than the live rule
   already makes it — and it must not claim to make it dearer.** A replacement
   should not discharge an exhausted unit owned by another agent: the repository
   routes a unit's corrections to its declared owner alone, and no agent may act on
   another's behalf. Three heads tried to turn that into an authorization rule and
   all three failed, each for a different reason. The fourth statement is not a
   fourth attempt at the rule; it is the constraint that survives without one.

   **What is available, and what each attempt got wrong.**

   - Read the owner from the source's body — #381's review: the body stays
     editable after the unit closes, so the check reads a forged value and agrees.
   - Derive it from a `claude/**` head ref and fail closed elsewhere — #386's first
     review: `scripts/correction-owner.mjs` refutes the derivation in its own
     header (#349 and #350, both `codex/**`, different owners), and failing closed
     makes every unresolvable source permanently unclaimable, jamming the queue.
   - Remove the requirement — #386's second review: under bundles one claimant then
     sweeps another agent's scope wholesale.
   - Read the body again and call it costless — **#387's review, and it is right.**
     That head argued the check "adds no forgery surface" because the same
     capability already defeats settlement. Requirement 1 makes that FALSE in the
     same document: once settlement reads git, a body editor can no longer rewrite
     the settling claim, so the source's owner marker becomes the *cheapest*
     remaining target rather than a redundant one. **Struck.** A repair that fixes
     one leg and reuses the old justification for the other is measuring against a
     state it has just removed.

   **So the owner marker is not an authorization basis here, and the document must
   not present it as one.** What can still be required is a property of the rule's
   SHAPE, which no marker has to be trusted for:

   - **A bundle may not span declared owners.** A claim naming several sources is
     refused unless every member's declared owner matches the claimant's. This is
     not proof of ownership; it is a refusal to build a NEW instrument that
     discharges several owners' scope at once.
   - **A single claim is left exactly as the live rule leaves it.** Executed: the
     live rule has no owner check at all, so a `claude` claimant discharges a
     `cursor` source today with no forgery whatsoever. The repair neither fixes
     that nor worsens it.

   The measurable requirement is the comparison: **after the repair, discharging
   another owner's scope must cost at least what it costs now.** Bundles would have
   made it cheaper — one claim, many owners — and the mixed-owner refusal is what
   keeps the cost where it was. Nothing here should be read as preserving
   correction ownership, because it does not.

   **Owner equality as authorization needs the authenticated record**, captured
   when the controller labels a unit exhausted, and that is item 6 of the preserved
   list. It is the largest thing this repair leaves undone, and it is undone
   because every basis available without a record has now been tried and found.

6. **Keep the malformed-declaration refusal.** It lives in `assessReviewScope`,
    not in the lineage function. A rewrite that touches only the lineage function
    must not assume it is inherited.

## What this repair deliberately leaves undone

**§2 is narrowed, not closed, and the remainder is stated precisely.** Settlement
reads git for every candidate that merges after the repair ships, so the forgery
that defines §2 — editing a merged body to discharge an obligation — stops working
from here on. What stays live is two things and no more: the candidates already
merged when the repair shipped, a **closed set that cannot gain a member**, and
every body read that is not settlement — admission among them, and the owner
marker requirement 5 explicitly declines to trust. An earlier head said "§2 stays
live" flatly and kept the singleton hole open on purpose; that was the wrong trade
and #386's review said so.

**What is true here is narrower than the sentence that used to stand in this
paragraph.** It said: "The exposure is unchanged from today, not increased: the
multi-obligation change reads the same bodies the current rule already reads." The
reason was false — a bundle read from bodies increases the exposure enormously —
and it was struck two sections above while this twin was left standing, which is
the fifth time in this lineage that a claim was corrected in one place and not in
the other. The conclusion is recoverable, but only because requirement 1 was
changed to make it so: a bundle settles from git, so the most one edited merged
body can discharge is still one obligation. That is a property of the requirement,
not of reading the same bodies.

**The window an earlier head left open is now closed, not documented.** That head
said requirement 1's evidence was immutable only *after* the merge, and named the
gap between the reviewed head and the merge as something it did not close.
#386's review showed what living with it costs: declare one source in the body,
carry the bundle in the commit message, get admitted on the singleton, edit the
body after the final policy check, and the whole backlog settles on a review that
saw one obligation. Requirement 1 now settles a bundle from git ALONE, so the body
plays no part in settlement and the window has nothing to act on. Naming a hole is
not closing it, and this document had done the former while claiming the latter.

**Owner equality is the largest thing this repair leaves undone.** Requirement 5
keeps cross-owner discharge no cheaper than it is today and says plainly that this
is not the same as preserving ownership: a body edit still misstates a source's
owner, and after requirement 1 that marker is the cheapest remaining target rather
than a redundant one. Four heads tried to make it an authorization rule; the
preserved list records what a record would have to provide.

**§3 is addressed but not by a new store** — requirement 3 above is a completeness
check on the enumeration the live rule already performs.

Anyone later deciding to take on §2 needs an authenticated record. What such a
record must satisfy was established by the six implementation attempts in the
table above — items 1 to 5 below — and item 6 was added by #386's review of this
document. (An earlier head said "five units" here; the number was carried from a
different count and then incremented mechanically when an item was added, which
is how a wrong number survives an edit. The list is the record, not its length.)
That learning is preserved rather than discarded with the cutover, because
rediscovering it would cost what it cost the first time.

### Preserved: what an authenticated record would have to satisfy

These are **not** requirements of the current repair. They apply only if the
representation is ever changed, and they are recorded because each cost a review
unit to learn.

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

5. **And the cutover into it is a design problem in its own right**, whose hazards
   are: settlement evidence and the obligation itself are both forgeable and must
   be authenticated or fail closed; settlement must preserve the
   `candidate.number > source.number` ordering; enumeration and cutover must be
   fenced, and a fence does not stop an evaluator already running (the
   `orchestrate` job checks out its script once and may run ninety minutes);
   in-flight admitted claims are part of the state and must be preserved or
   re-admitted. Above all — **every input such a bootstrap could read is
   forgeable**, so what it is allowed to trust must be decided before any
   mechanism is chosen. That question is what five formulations failed to answer,
   and it is the first thing to settle if §2 is ever taken on.

6. **Owner equality becomes an authorization rule instead of a cost comparison.**
   Requirement 5 does not preserve correction ownership and says so; all it asks is
   that the repair not make cross-owner discharge cheaper. Four heads tried to make
   it a real rule and each hit a different wall: the source's body is editable
   (#381); the branch prefix demonstrably does not carry ownership
   (`scripts/correction-owner.mjs` records #349 and #350, both `codex/**`, with
   different owners) and failing closed on the rest jams the queue (#386); removing
   the rule lets a bundle sweep another agent's scope (#386); and reading the body
   again is **cheaper to forge than settlement** once requirement 1 lands (#387).
   A label proves only that some workflow wrote it, by item 3 above.

   What is needed is the owner captured **when the controller labels the unit
   exhausted** — before any claimant exists, by a writer a claimant cannot
   impersonate. Two constraints on such a record, both learned the hard way: it
   must NOT fail closed on units it cannot resolve, since #386's review executed
   that consequence and the whole queue jams; and it must be written at labelling
   rather than read at admission, since anything read later reads whatever the body
   says by then.
### On the automatic release valve that was sketched here

An earlier version of this document proposed a watchdog that **released** an
obligation when no open unit claimed it and every unit that ever claimed it had
closed unmerged. **It is removed rather than repaired**, for two independent
reasons, and it should not be reintroduced in either form.

- **It waives unresolved scope.** A released obligation is scope whose findings
  were neither fixed nor carried, and after the release a fresh `Replaces: none`
  unit passes. Making the release "loud" records the waiver; it does not preserve
  the work. Recovery would have to transfer or recreate the obligation, never
  drop it — at which point it is requirement 1, not a release.
- **It addresses a state that does not occur.** §1 shows by execution that a dead
  claimant blocks nothing and the source stays claimable. There is no permanently
  dead chain to recover from.

An earlier sketch also omitted that the condition is vacuously true over an empty
set — a unit satisfied it the moment it was labelled, before any replacement was
opened. That is recorded here so the same rule is not re-derived and re-proposed
with the same hole.

## Where things stand

- `main`'s rule is unchanged. All three defects above are live.
- **Pending: #377, #378, #379, #383, #384, #385 and #386. Settled: #381, by
  merged #382** — which still carries the label, because discharge is computed
  rather than un-marked. This unit replaces #386 and carries the record forward.
  The record
  obligations are discharged by later units carrying the same scope; #377's only
  by a merged unit carrying its implementation scope and its unresolved findings.
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
  against was long rather than stuck. Requirement 1 is the remedy.
