# The replacement-lineage rule: what is wrong with it, and what its repair must do

Status: **the repair is resuming.** An earlier record (#378) proposed parking it;
that framing was withdrawn by owner directive on 2026-08-20, and the programme
mandate is unchanged — autonomous, fail-closed convergence, with unresolved
findings carried forward rather than released.

**This unit replaces #388, and it discharges nothing else.** It does **not**
discharge #387, #386, #385, #384, #383, #379 or #378, which hold the same record
scope further back, and it does **not** discharge #377, which holds the
lineage-repair *implementation*.
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
text reached `main`; #383 carried it forward and was exhausted; #384, #385, #386,
#387 and #388 each did the same; this unit replaces #388. Each closure **at the
round limit**
added a label rather than moving one — and only those closures do. #380, a
parallel replacement for #378 opened and closed the same minute without reaching
the limit, left no label and added no obligation. The label marks an exhausted
unit, not a closed one, and that distinction is what keeps the queue finite.

**Where the rounds actually went, because the shape is the finding.** Seven on
#378, seven on #379, three on #381, none on #382 — then one and four on #383,
three and two on #384, three and two on #385, two and two on #386, five and five
on #387, three and two on #388, and six on #389's first head. The rise from #383
onward was
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
had created. Then #387's second round refused the retreat as well: admitting a
cross-owner single claim is not compatible with the workflow this repair exists to
serve, whatever the live rule does today.

**Two roots, and the second is the larger.** The first is that the document kept
asserting how much a check was WORTH without re-measuring after the design around
it changed. The second is that four heads treated "the owner removed the migration
cutover" as "no recorded truth is available", and spent themselves deriving
pre-repair facts from post-repair reads. What was removed was a STORE with a manual
attestation. A file committed in the repair's own reviewed diff is neither, needs
no attestation, and is nine rows at today's scale. Requirement 0 is that file, and
requirement 5 reads the owner from it — a real rule at last, for single claims and
bundles alike.

**#387's first round then found four more, and one is the sharpest observation in
this lineage:** making settlement read git left the owner marker *cheaper to forge
than settlement*, so the justification carried forward from the previous head —
"the same capability already defeats settlement" — was falsified by the very change
that shipped beside it. A repair that fixes one leg and reuses the old measurement
for the other is measuring against a state it has just removed. The other three
were a fence by pull request number that the still-open #363 walks straight
through, a completeness check computed from the very enumeration it was meant to
bound, and a competition rule that refuses every claimant and frees nobody.

**#387's second round then found five more, and together they name the thing four
heads had been walking around.** Two of them — owner evidence for every claim, and
freezing the legacy settlement mappings — both terminate in the same place: a fact
about a unit *as it stood before the repair*, which no later read can recover. Two
more were ordinary and should not have needed a reviewer: the live rule's
`candidate.number > source.number` ordering was dropped while settlement was being
rewritten, and the new per-source winner deadlocks partially overlapping bundles.
The fifth was the rollout — a controller run that started under the old rules can
merge under the new ones and be classified as violating a policy that did not
exist when it was admitted.

**The root, which is the one worth keeping: "we cannot have a record" was never
established — only "we cannot have a STORE".** The owner removed a migration with
a manual operator attestation, and four heads read that as removing every form of
recorded truth, then spent themselves trying to derive pre-repair facts from
post-repair reads. A file committed in the repair's own reviewed diff was available
the whole time, needs no attestation, and is **nine rows** at today's scale. The
argument cost more than the artifact.

**#388's first round then tested the snapshot rather than the idea of it, and all
three findings were about its edges.** A frozen list cannot bound a growing set, so
requirement 3's equality became a lower bound. A commit-message owner that nobody
checks against the body marker freezes an owner that never routed anything, so
admission now requires the two to agree on the reviewed head. And draining
controller runs misses a queued auto-merge, because the controller calls
`enableAutoMerge` and returns immediately — executed — leaving GitHub to merge with
no orchestration in flight to drain.

**#388's second round narrowed both of its own round-1 fixes by one step each, and
the shape of that is worth noting.** The lower bound left an interval — while only
the live query knows a new obligation, a later truncated query can omit it and
still pass — so the bound is now appended atomically with the obligation's
creation. And checking the owner declaration at review only was not enough, because
`enforceReviewConvergence` re-reads the pull request and marks it
replacement-required without re-running scope, so the body can change between the
two; the check runs again at the moment the obligation is created.

Neither finding was about whether the mechanism exists. Both were about an interval
inside it. That is a different class of finding from the ones #385 to #387 drew,
and it is the first sign in this lineage that the design is being tested rather
than the idea of it.

**#389's first round is where the two halves separated for good.** Six findings,
and five of them were one thing: a committed file cannot be the authority. It
cannot be written atomically with a label (two external writes, no transaction); it
cannot authenticate what happened before it existed; it cannot bound its own
bootstrap; it cannot be kept current against writers that predate it; and the
repair that installs it cannot itself satisfy the rule it installs.

**What broke the deadlock was an authority already in use and not looked at.** A
commit status is app-written, keyed to an exact SHA, superseded rather than edited,
and not reachable by whoever can edit the pull request — this repository has
trusted it for `codex-current-head` throughout. Making the obligation record a
status is one write, which is what atomicity needed, and closes the read-then-write
race by post-write verification rather than by proximity.

**And it separates cleanly from what cannot be fixed.** After the repair there is
real evidence. Before it there is none, and the document now says so instead of
manufacturing some: the re-baseline is a stated assumption reviewed on an exact
head, its residual is one reviewed enumeration, and no mechanism available here
improves on that. Six heads argued about which artifact could carry pre-repair
truth; the answer is that none can, and the useful move was to stop looking and
name the exposure.

Thirteen finding-bearing heads across seven units bought all of this — #383
through #388 at two apiece, and #389's first — which is the count the rounds line
above adds up to. It is written down here so it is not paid a third time.

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

**That decision stands, and it turned out not to be the obstacle.** Removing the
cutover left the bundle and owner equality resting on a record that no longer
existed, and four heads then tried to route around the gap: rest them on protected
git history, on a head ref, on nothing, on an editable body priced as costless.
Each was found. #387's review named what all four were missing — evidence about a
unit *as it stood before the repair*, which no post-hoc read can recover — and, in
the same breath, what it would take:

| Requirement | Reads the pre-repair fact from | Reads the post-repair fact from |
| --- | --- | --- |
| **1** — the claim | the re-baseline, authored and reviewed in the repair's own diff | a commit message inside the reviewed head |
| **5** — the source's owner | the re-baseline, with its limits stated | the obligation status the controller wrote at labelling |

**The record was never the problem; the shape assumed for it was.** A store with a
manual operator attestation is what the owner removed, and rightly. A file
committed in the repair's own reviewed diff is not that: no store, no migration, no
attestation, and no owner recovered from provenance nobody wrote. Executed, it is
**nine rows** — one merged candidate settles anything today (#382 → #381), plus the
labelled sources' owners. Requirement 0 states it; requirements 1, 3 and 5 read
from it — requirement 3 as a **lower** bound rather than an equality, because the
snapshot is frozen while the obligation set is not, and #388's review showed that
demanding equality jams the loop the first time a post-cutover unit is labelled.

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

So the repair is now these, and only these. #387's review produced the missing
piece and it belongs first, because four earlier heads failed for want of it.

0. **THE OBLIGATION RECORD — a commit status for everything after the repair, and
   an explicitly re-baselined snapshot for everything before it.** Requirements 1,
   3 and 5 all need a fact about a unit that a pull request author cannot rewrite.
   #389's review showed that a committed file cannot be that fact on its own, for
   three separate reasons, and the two halves have to be separated because only one
   of them can be made sound.

   **After the repair, the record is a COMMIT STATUS on the exhausted unit's head
   SHA**, written by the controller at the moment it labels the unit. This
   repository already trusts that mechanism — `codex-current-head` is a status,
   written only by the app, keyed to an exact SHA, superseded by writing a newer
   one with its history retained. It is not editable by whoever can edit the pull
   request, which is the whole difficulty with bodies, and it is **one write**,
   which is the whole difficulty with a committed file.

   An earlier head of this requirement said the controller would record the
   obligation in a committed file "atomically" with applying the label. That is not
   available: a file commit and a label are two external writes, and running them in
   one invocation does not make them atomic. Crash between them and the outcome is
   either a waiver window (label written, record missing) or a fail-closed jam
   (record written, label missing). Making the STATUS the record removes the
   second write from the trust path entirely — the label becomes a convenience for
   humans reading the pull request list, and carries no evidential weight.

   The status carries the obligation and its owner, and the owner it carries is the
   value the controller validated. To close the read-then-write race, the
   controller **re-reads after writing and supersedes with a refusal if the body
   moved** — post-write verification rather than temporal proximity.

   **Before the repair, no such record exists and none can be manufactured.** This
   is the part that must be stated plainly rather than engineered around:

   - no status was written for #377, #378, #379, #383, #384, #385, #386, #387 or
     #388 when they were exhausted, because nothing wrote one;
   - the timeline actor cannot supply it — every workflow here shares one
     `github-actions[bot]` identity, which the preserved list already records as
     "a necessary filter, not sufficient evidence";
   - the body has been editable throughout, so committing its **current** value
     freezes whatever it says today, not what it said at exhaustion. If a
     `cursor`-owned source were edited to `claude` before the snapshot is authored,
     the snapshot would freeze the forgery and a `claude` claimant would pass
     equality against it.

   So the pre-repair half is a **RE-BASELINE, and it is labelled as one**: a stated
   assumption about the repository's condition at a moment, authored in the repair's
   own diff and reviewed on the exact head that installs it. Codex asked for
   "authenticated historical evidence or an explicit trusted re-baseline"; the first
   does not exist here, and the second is what this is. It is not the manual
   operator attestation the owner removed — no human is asked to assert anything
   outside the review that already happens on every head.

   **What the re-baseline does not fix, stated exactly.** If the paginated label
   enumeration is already lossy when the baseline is authored, the baseline inherits
   the loss, and a later query with the same fault agrees with it. Review does not
   make an incomplete enumeration complete. What is available reduces the exposure
   without closing it: enumerate to exhaustion with the page count asserted rather
   than assumed, cross-check the label query against the closed-pull-request
   listing, and record the exact queries used so a disagreement later is
   attributable. **The residual is that the repair's trust in the pre-repair world
   is exactly as good as one reviewed enumeration, and no better.** Anyone who needs
   better needs evidence that was never written.

1. **A replacement must be able to carry more than one obligation, as one DECLARED
   bundle — and every claim, of any size, settles only against evidence a later
   edit cannot reach.** This is what §1 actually asks for, and no attempt so far
   provides it. Today a unit declares at most one source, so an accumulated backlog
   costs one sequential merged unit per entry. The bundle is the set the claimant
   *declared* and the controller *admitted*; on merge it settles exactly its
   members, all of them or none. **It must not be implemented by waiving.**
   Discharge still requires a unit that carried the scope; what changes is how many
   obligations one such unit may carry, never whether an obligation can lapse
   unmet.

   **Settlement evidence, in full:**

   - a candidate merged **after** the repair settles from **git** — the declaration
     in a commit message on its branch, inside the exact head the reviewer
     approved;
   - a candidate merged **before** the repair settles from **requirement 0's
     snapshot**, never from its body.

   An earlier head fenced the legacy set by pull request number, and #387's review
   broke that twice over. The still-open, lower-numbered #363 walks straight
   through a number fence. And leaving pre-repair candidates on their *bodies*
   leaves them editable forever — rewriting merged #382 from `Replaces: #381` to
   `Replaces: #377` would resurrect #381 and falsely discharge the implementation
   obligation with a record-only unit. The fence is merge state, and the legacy
   side reads the snapshot, which is what makes "existing discharges are preserved"
   true rather than merely intended.

   **The ordering invariant is RETAINED.** `main` requires
   `candidate.number > source.number`, and an earlier head dropped it while
   rewriting settlement — which would let the parked, older #363 be repurposed to
   name #386 and discharge an obligation that did not exist when #363 was opened.
   Every admitted and settled member must precede its claimant, exactly as today.

   **Two git anchors, both required**, because either alone has a hole:

   - the declaration appears in the message of a commit **belonging to the merged
     pull request** — a SHA the reviewed head fixes; and
   - the merged commit on `main` carries **the same set**.

   Requiring both closes the merge-time override: a merge that supplies an invented
   commit message disagrees with the pull request's own commits, and disagreement
   settles nothing.

   **The second anchor must be CONSTRUCTED, not assumed.** Executed in
   `scripts/autonomous-review-gate.mjs`: `enableAutoMerge` passes only
   `mergeMethod: SQUASH`, and `mergeExactHead` sends only `merge_method` and `sha`.
   **Neither sets the squash commit body**, so `1449c82`'s shape is GitHub's default
   under this repository's current settings — an observation, not a guarantee.
   Because settlement fails CLOSED, guessing wrong is a jam rather than a silent
   loss: branch evidence present, merge commit missing it, obligation pending with
   no unit able to take it. Both paths must compose the merge commit message
   explicitly from the reviewed declaration.

   **Admission checks the body against git.** At review time the body's declared
   set must EQUAL the git set, so the reviewer is shown the claim that will settle
   and a mismatch is refused. After admission the body is not consulted again.

   **The arithmetic, which is the whole point of the requirement:**

   | Settlement evidence | Obligations one edited body can discharge |
   | --- | --- |
   | Today | **1** — executed |
   | A bundle read from the body | the whole backlog, in one edit |
   | A bundle read from body AND git | the whole backlog — the pre-merge edit |
   | Git after the repair, snapshot before it | **0** |

   A claim whose evidence is missing settles **nothing at all** — never its first
   member, never its body.

2. **Conservation, and a winner defined over WHOLE BUNDLES.** A claim **inside**
   the declared, admitted bundle is intended scope and settles on merge, atomically
   with its siblings. A claim **outside** it — acquired by a race, or by the
   declaration changing between two controller runs — is not scope anyone carried:
   it settles nothing and the unit holding it is refused.

   **Competition must resolve, and resolve over the whole bundle.** Executed
   against `assessReplacementLineage` with #378 labelled: open claimants #400 and
   #401 refuse each other by name, and a third, #402, is refused too — nothing frees
   #378, so "the source stays claimable" is not delivered by refusing everyone.

   A per-source winner is not enough either. With #400 declaring `{#1,#2}` and #401
   declaring `{#2,#3}`, giving #2 to #400 leaves #401 refused *and still the sole
   holder of #3*, which all-or-none settlement means it can never discharge, while
   a third claimant for #3 loses to the still-open #401. Manual closure would be
   the only exit, which is the accumulation defect wearing a different hat.

   So competition resolves **among complete admissible bundles**: one bundle is
   admitted whole, and a bundle that loses any member **releases every holding it
   has**, leaving all of them claimable. The order must not depend on when an
   evaluator ran — earliest recorded admission where one exists, otherwise lowest
   claimant number, which every evaluator computes identically. This interleaving
   needs an explicit-barrier test asserting that one bundle is admitted, the other
   releases everything, and no obligation is lost or double-settled.

3. **Distinguish a dead chain from missing evidence, and bound the enumeration
   from OUTSIDE it — as a LOWER bound, never as an equality.** Unknown lineage must
   never admit work. `main` fails closed only on a non-array (§3), so a repair that
   "keeps the current behaviour" inherits the empty-response bypass.

   **A completeness check computed from the same query is worth nothing.** If a
   permissions change or a wrong filter returns `200` with an empty page, then a
   count or checksum over that page is empty too and agrees with itself. The bound
   must come from a source that cannot go empty for the same reason.

   **But an EQUALITY against a frozen list jams the loop**, and an earlier head of
   this requirement asked for exactly that. The snapshot is fixed at cutover; the
   obligation set is not. The first post-cutover unit to reach the round limit is
   in the label query and cannot be in the snapshot, so equality reads that as
   disagreement and refuses every review after it. Comparing only against snapshot
   entries fails the other way — the query could silently drop a new obligation and
   nothing would notice.

   **The bound is therefore monotone and one-directional:**

   - the live query must contain **every unsettled entry the obligation record
     knows about**. One missing → evidence has been lost → **refuse**, naming it.
   - the live query containing an entry the list does **not** know about means the
     bound is behind, and the entry must be **recorded before it is relied on**.

   **"Accept it and let the next unit update the list" is not good enough, and
   that is what an earlier head of this requirement said.** The interval is the
   defect: while only the live query knows about a new obligation #N, one complete
   query returns #N and is accepted, and a *later* truncated or wrongly filtered
   query can omit #N while still containing every entry the list knows — passing
   the lower bound, admitting `Replaces: none`, and waiving #N. The window between
   observing an obligation and recording it is exactly the window §3 exists to
   close, and leaving it open reproduces the empty-response bypass on a delay.

   So the bound is **the obligation record of requirement 0**, not a second list
   kept in step with the first. After the repair an obligation exists exactly when
   its status exists — one write, no interval between creating it and recording it,
   because they are the same act. Before the repair it is the re-baseline. An
   obligation the label query knows about and the record does not **blocks fresh
   `Replaces: none` work** until a status exists for it, which is fail-closed and
   is also the reconciliation path for anything a pre-repair writer left behind.

   That removes the window an earlier head left open — where a new obligation was
   accepted on the query's word and a later truncated query could omit it and still
   pass — and it catches the failure §3 is about, a query returning *fewer*
   obligations than exist, from both sides.

4. **Revalidate the whole claimant at the authorization boundary, base included.**
   #377 revalidated head, body and state but not base, and a claimant retargeted to
   another or stale base after its claim was recorded still satisfied every other
   check — discharging its source with a replacement that does not contain the
   current-`main` unresolved unit. A timeline claim cannot be withdrawn once
   written, so base identity and ancestry must be checked *before* the write and
   again at every later evaluation, alongside head, body and state.

   **The revalidated set is the git set**, since requirement 1 settles from git;
   revalidating only the body would re-open exactly the window requirement 1
   closes.

5. **The claim must preserve the source's correction owner — for EVERY claim, not
   only bundles.** A replacement must not discharge an exhausted unit owned by
   another agent: the repository routes a unit's corrections to its declared owner
   alone, and no agent may act on another's behalf.

   Four heads failed here, each differently, and the fourth is the one that
   mattered. Reading the owner from the source's body preserves nothing, because
   the body stays editable after the unit closes (#381). Deriving it from a
   `claude/**` head ref is refuted by `scripts/correction-owner.mjs` in its own
   header — #349 and #350, both `codex/**`, different owners — and failing closed on
   the rest jams the queue (#386). Removing the rule lets a bundle sweep another
   agent's scope (#386). And keeping the body check for single claims while calling
   it costless is false once requirement 1 lands, because settlement becomes the
   *dearer* target and the marker the cheaper one (#387).

   **Requirement 0 supplies what all four lacked.** The owner of a source is:

   - for a source labelled **before** the repair — the value in the re-baseline,
     with the limits requirement 0 states;
   - for one labelled **after** it — the value in its **obligation status**, which
     the controller wrote at labelling from a commit-message declaration it had
     verified equal to the body, and then confirmed by re-reading. The commit
     message is the unit's declaration; the status is the record of it, and only
     the record is consulted afterwards.

   **The commit declaration must be BOUND to the body declaration, or it authorizes
   the wrong thing.** The body marker is what routes corrections today: it is what
   `parseCorrectionOwner` reads and what every finding notice is derived from. A
   commit message saying `claude` on a unit whose body says `cursor` would freeze an
   owner that never controlled routing, and a `claude` claimant would then pass
   equality against it and discharge Cursor-owned scope. So the rule is: **exactly
   one owner declaration in the commit messages, equal to the body's owner, checked
   on the exact reviewed head before admission.** Unequal, absent or duplicated —
   refuse the unit at review, which is early enough that the question never becomes
   an obligation.

   **And it must be checked TWICE: at review, and again at the moment the
   obligation is created.** An earlier head put the commit declaration in place
   with no requirement that anyone verify it, which leaves one failure mode open —
   a unit carrying no marker in any commit becomes an obligation whose owner can
   never be established, and fails closed forever. Requiring it while the unit is
   still reviewable is what stops that.

   **Checking only at review leaves the other one open**, and the path is specific.
   Executed in `scripts/autonomous-review-gate.mjs`: `enforceReviewConvergence`
   calls `setDraftForCurrentHead` — which re-reads the pull request — and then
   `markReplacementRequired`, with **no** re-run of `assessReviewScope` between
   them. So a `claude` body/commit pair can pass scope, the body can be edited to
   `cursor` while Codex is still polling, and the obligation is then created for a
   source that ROUTES to Cursor while permanently freezing `claude` from its
   commit. Cursor could not replace it; a Claude claimant could discharge
   Cursor-routed scope.

   **Re-checking just before the write is not enough either, and an earlier head
   stopped there.** Read-then-write leaves its own window: the controller reads a
   matching pair, the body is edited, and the controller writes the record it
   already validated. Proximity is not exclusion. What closes it is
   **post-write verification**: the obligation status is written with the validated
   owner, the body is re-read afterwards, and a disagreement **supersedes the
   status with a refusal** — so the only durable outcomes are a record that matches
   routing, or no obligation at all. Requirement 0's record is what makes that
   possible, because a status can be superseded and a label cannot be un-applied
   with the same authority.

   A claimant may name only sources whose owner equals its own, for a single claim
   as much as a bundle, and a **bundle mixing owners is refused**. There is no
   "leave the single case as the live rule leaves it" exemption: #387's review was
   right that admitting a cross-owner single claim is not compatible with the
   workflow this repair exists to serve.

6. **The rollout must drain the controllers that predate it.** A controller run
   checks out its script once and may stay live for ninety minutes, so a run
   started under the old rules can admit a body-only replacement, remain in flight
   while the repair lands, and merge it afterwards through the old merge path — with
   no git evidence, because none was required when it was admitted. Classified by
   the new rule it is post-cutover, settles nothing, and forces a replacement for a
   unit that obeyed the policy in force when it started.

   **A queued auto-merge is the same hazard with no run to drain, and it is the
   harder half.** Executed in `scripts/autonomous-review-gate.mjs`: on the
   auto-merge path the controller calls `enableAutoMerge` and immediately
   `return 'queued'` — so it exits, no orchestration is in flight, and GitHub
   performs the squash later when the protection conditions clear. A rollout that
   drains only workflow runs sees nothing to drain and switches the fence on; the
   queued candidate then merges without the newly required commit body, is
   classified post-cutover, settles nothing, and its obligation becomes permanently
   unsettleable.

   So the rollout rule covers three things, not one: **stop old-version writers,
   drain or invalidate in-flight orchestrations, and cancel or grandfather every
   pre-cutover queued auto-merge — then reconcile the re-baseline immediately
   before classification begins.** Draining alone is not enough: an old controller
   can label a unit *after* the re-baseline head is authored and exit before
   rollout, so it is neither in flight nor a queued auto-merge when the drain runs,
   yet its unit is absent from the baseline and has no post-repair status. Stopping
   the writers first and reconciling last is what leaves no unit in that gap.

   **The repair's own merge is the boundary, not an exception to it.** The
   activation pull request is merged by the pre-repair controller, through merge
   paths that do not yet compose the squash body — so it cannot satisfy the rule it
   installs. It does not have to: the fence classifies a candidate by whether it
   merged before the repair did, and the repair's own merge is by definition the
   last one that did. Any settlement it performs is a re-baseline entry authored in
   the same diff. The alternative Codex offers — stage merge-message construction
   in a unit that lands *before* the fence — is also sound, and is the safer order
   if the two are ever separable; either way the activation merge must never be
   classified as post-repair while lacking evidence the pre-repair controller could
   not produce.

7. **Keep the malformed-declaration refusal.** It lives in `assessReviewScope`, not
   in the lineage function. A rewrite that touches only the lineage function must
   not assume it is inherited.

## What this repair deliberately leaves undone

**§2's settlement leg is CLOSED; its admission leg is not.** Settlement reads git
after the repair and the snapshot before it, so the forgery that defines §2 —
editing a merged body to discharge an obligation — stops working in both
directions. Three earlier heads left part of it open and each said so instead of
fixing it: the pre-merge window (documented, not closed), single-source body
settlement (kept on purpose), and pre-repair candidates left on their bodies
forever. All three are closed here.

What remains live is **every body read that is not settlement** — chiefly
admission, where the gate reads the claimant's declared set at review time and
compares it against git. That read is forgeable in the ordinary sense, but a body
edited after admission changes nothing, because nothing downstream consults it.

**A claim this document has made four times and got wrong three of them:** how much
a check is worth. It said the exposure was "unchanged from today" when a bundle
read from bodies would have multiplied it; it said the owner check "adds no forgery
surface" when requirement 1 had just made settlement the dearer target and the
marker the cheaper one. **The lesson is not that forgeable checks are worthless —
it is that a value asserted for one part of a design stops being true when another
part changes, and this document kept carrying the old figure forward.** Where a
value is claimed below it is claimed against the design as it now stands, and it
is stated as something to re-measure rather than as a fact.

**What is genuinely left undone is the PRE-REPAIR world, and only that.** After the
repair the record is a commit status: app-written, SHA-keyed, one write, not
editable by whoever can edit the pull request. Before it, there is no such record
and none can be manufactured — no status was written, the timeline actor is one
shared bot identity, and the body has always been editable. The re-baseline is a
stated assumption reviewed on an exact head, which is the strongest thing available
and is weaker than evidence. Its residual is precise: **the repair's trust in the
pre-repair world is exactly as good as one reviewed enumeration.** Anyone who needs
better needs evidence nobody wrote.

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

6. **The PRE-REPAIR owner gets evidence instead of an assumption.** After the
   repair, requirement 5 reads the owner from an app-written commit status and the
   check is real. Before it, the value comes from a re-baseline — a stated
   assumption, reviewed once, which cannot recover what a body said at exhaustion
   because nothing recorded it. What a fuller record would add is exactly that
   history, and it is the one thing review cannot substitute for. Five heads
   reached for the stronger property first and none shipped; the honest weaker one
   is what ships, with its limit written where the requirement is.

   Two constraints on any stronger record, both learned the hard way: it must NOT
   fail closed on units it cannot resolve, since #386's review executed that
   consequence and the whole queue jams; and it must be written when the controller
   LABELS a unit exhausted rather than read when a claimant is admitted, since
   anything read later reads whatever the body says by then.

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
- **Pending: #377, #378, #379, #383, #384, #385, #386, #387 and #388. Settled:
  #381, by merged #382** — which still carries the label, because discharge is
  computed rather than un-marked. This unit replaces #388 and carries the record
  forward. The record
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
