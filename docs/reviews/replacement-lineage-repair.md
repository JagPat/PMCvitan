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
three and two on #384, three and two on #385, and two and two on #386. The rise
from #383 onward was
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
available and ordinary — settle from git alone, and put the change behind an
enforcement boundary of the kind `scripts/review-efficiency.mjs` already uses
twice (`REVIEW_SCOPE_ENFORCE_AFTER_PR = 246`, `PRE_REVIEW_ENFORCE_AFTER_PR = 345`)
— so what stood in for the fix was the disclosure.

**Root two — "cannot be authenticated" is not "cannot be used".** Owner equality
was first read from an editable body and called preserved (#381 found it), then
derived from a `claude/**` head ref and failed closed elsewhere (#386 found that
this repository had already refuted the derivation, and that failing closed jams
the queue forever), then removed outright on the reasoning that forgeable evidence
is no evidence — which #386's second round refuted in turn, because under bundles
the removal lets one claimant discharge another agent's scope wholesale. The
resolution is the smallest of the four: read the declared owner, refuse a bundle
that mixes owners, bind nothing where no owner is declared, and say plainly that
the check fails against an editor who could forge the claim anyway.

Eight finding-bearing heads across four units bought those two sentences — #383,
#384, #385 and #386, two apiece, which is the count the rounds line above adds up
to. They are written down here so they are not paid for a third time.

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
| **1** — the claim itself | `main`'s protected git history, for every candidate merged after a stated enforcement boundary | it does not settle from a body, at any size, after that boundary |
| **5** — the source's correction owner | the owner declared in the source's body, which is available for every unit | it does not *authenticate* that owner, and it says so |

Neither is a store, a migration or a backfill. Requirement 1's boundary is a
constant of the kind this repository already uses twice, and requirement 5 is a
check whose evidence is forgeable by exactly the capability that already defeats
settlement — so it adds no surface while stopping the case that would really
occur.

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

   **The answer is an enforcement boundary, and this repository already uses
   one twice.** Executed in `scripts/review-efficiency.mjs`:
   `REVIEW_SCOPE_ENFORCE_AFTER_PR = 246` and `PRE_REVIEW_ENFORCE_AFTER_PR = 345`,
   each applied as a plain comparison on the pull request number. Settlement takes
   the same shape:

   - a candidate merged **after** the boundary settles from git, whatever its size
     — one source or many;
   - a candidate at or below it settles from its body, exactly as today.

   That preserves every discharge already computed, #381's included, without
   preserving the hole for anything new. It is a constant, not a data migration:
   nothing is backfilled and no store is built.

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
     editable text, and git carries none of it today. This is also why the
     boundary is necessary rather than merely convenient: applied retroactively,
     a git-only rule would un-discharge #381.
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
   | Git, after the boundary | **0** |
   | Git, with a pre-boundary candidate | **1** — a finite, non-growing set |

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

3. **Distinguish a dead chain from missing evidence, and treat an incomplete
   enumeration as missing.** Unknown lineage must never admit work. `main` fails
   closed only on a non-array (§3), so a repair that "keeps the current
   behaviour" inherits the empty-response bypass. The repair needs an explicit
   completeness check — an authenticated or independently-bounded enumeration,
   or a recorded expected count — before an empty or partial result is treated as
   authoritative.

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

5. **The claim must preserve the source's correction owner, and a bundle may not
   mix owners.** A replacement must not discharge an exhausted unit owned by
   another agent: the repository routes a unit's corrections to its declared owner
   alone, and no agent may act on another's behalf. Under bundles the stake rises
   — one claimant could declare a mixed bundle and discharge a `cursor`-owned unit
   alongside its own.

   **Two earlier heads got this wrong in opposite directions, and the root is one
   sentence.** The first read the owner from the source's body and called it
   preserved; #381's review showed the body stays editable after the unit closes,
   so the check reads a forged value and agrees with it. The second concluded that
   because the owner cannot be *authenticated* it cannot be *used*, derived it
   from a `claude/**` head ref instead, and failed closed on every other prefix —
   which `scripts/correction-owner.mjs` refutes in its own header ("the branch
   prefix does not carry it (both PRs were on `codex/**`)", #349 and #350 being
   loop pull requests on one prefix with different owners), and which #386's
   review showed would make a `cursor`-owned exhausted unit permanently
   discharge-ineligible — the pending set never empties, every `Replaces: none`
   unit refused for good, exactly the state requirement 2 forbids.

   **"Cannot be authenticated" is not "cannot be used", and that conflation is the
   error both times.** The rule is:

   - the owner of a source is what `parseCorrectionOwner` reads from its body —
     available for every unit, and forgeable;
   - a claimant may name only sources whose owner equals its own, so a **bundle
     mixing owners is refused**; a claimant that owns both halves opens one unit
     per owner;
   - a source whose declaration is missing, invalid or contradictory — the units
     predating the contract — **binds nothing**, and stays claimable by anyone.
     That is today's behaviour and it is what keeps the rule from deadlocking.

   **What this defends against, stated exactly.** It stops cross-owner discharge
   by accident and by ordinary means, which is how it would actually happen. It
   does not stop an attacker who can edit pull request bodies — but that attacker
   can already rewrite the `Replaces:` claim itself, so the check **adds no
   forgery surface**: the capability it fails against is the capability that
   defeats settlement anyway. A forgeable check is worth more than no check when
   it costs nothing, and the second head removed one on the reasoning that
   imperfect evidence is no evidence. The preserved list below records what an
   authenticated record would add here, which is authentication — not the check.

6. **Keep the malformed-declaration refusal.** It lives in `assessReviewScope`,
    not in the lineage function. A rewrite that touches only the lineage function
    must not assume it is inherited.

## What this repair deliberately leaves undone

**§2 is narrowed, not closed, and the remainder is stated precisely.** Settlement
after requirement 1's boundary reads git, so the forgery that defines §2 — editing
a merged body to discharge an obligation — stops working for anything merged from
here on. What stays live is two things and no more: candidates merged at or below
the boundary, a **finite set that cannot grow**, and every body read that is not
settlement, admission among them. An earlier head said "§2 stays live" flatly and
kept the singleton hole open on purpose; that was the wrong trade and #386's
review said so.

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

**Owner equality is kept, unauthenticated, and the gap is named where the
requirement is.** What this repair gives up is not the check but its proof: a body
edit can still misstate a source's owner. The preserved list records what an
authenticated record adds there — authentication, not the rule.

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

6. **Owner equality gets its proof.** Requirement 5 keeps the check without it:
   the owner is read from the source's body, which is available for every unit and
   forgeable by whoever can edit it. Nothing available today can do better — the
   branch prefix demonstrably does not carry ownership
   (`scripts/correction-owner.mjs` records #349 and #350, both on `codex/**`, with
   different owners), and a label proves only that some workflow wrote it, by item
   3 above. A record naming the owner at the moment a unit is labelled exhausted
   is what would make the check hold against an editor, rather than only against
   accident. Note what it must NOT do: fail closed on units whose owner it cannot
   resolve. #386's review executed that consequence — those sources become
   permanently unclaimable and the whole queue jams — so an authenticated record
   has to carry an unrestricted state for units predating it.
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
