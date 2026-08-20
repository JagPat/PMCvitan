# The replacement-lineage rule: what is wrong with it, and what its repair must do

Status: **the repair is resuming.** An earlier record (#378) proposed parking it;
that framing was withdrawn by owner directive on 2026-08-20, and the programme
mandate is unchanged — autonomous, fail-closed convergence, with unresolved
findings carried forward rather than released.

**This unit replaces #390, and it discharges nothing else.** It does **not**
discharge #389, #388, #387, #386, #385, #384, #383, #379 or #378, which hold the
same record scope further back, and it does **not** discharge #377, which holds
the lineage-repair *implementation*.
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
text reached `main`; #383 carried it forward and was exhausted; #384 through #390
each did the same; this unit replaces #390. Each closure **at the round limit**
added a label rather than moving one — and only those closures do. #380, a
parallel replacement for #378 opened and closed the same minute without reaching
the limit, left no label and added no obligation. The label marks an exhausted
unit, not a closed one, and that distinction is what keeps the queue finite.

**Where the rounds actually went, because the shape is the finding.** Seven on
#378, seven on #379, three on #381, none on #382 — then one and four on #383,
three and two on #384, three and two on #385, two and two on #386, five and five
on #387, three and two on #388, six and three on #389, six and four on #390, and
four on #391's first head. The rise from #383 onward was
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
no attestation, and is nine rows at today's scale.

**That reasoning was wrong too, and #389 is where it broke.** A file committed in a
reviewed diff is better than a body, but it is still not evidence about a moment
that predates it, it cannot be written atomically with the label that creates the
obligation, and it cannot bound its own bootstrap. Nor could the commit status that
replaced it: executed, statuses carry no creator filter and cannot be enumerated
without already knowing every SHA. The record was never available; what was
available was the trust root, and the table below states it.

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

**#389 is where the search ended, and the ending is the finding.** Its first round
killed the committed file five ways at once. Its second killed the commit status
that replaced it — executed, `GitHubClient.statuses(head)` applies **no creator
filter**, so any collaborator can write the obligation context or supersede a real
one with a refusal, and it requires a **known SHA**, so the set of SHAs still comes
from the label query it was meant to bound independently. It also refused the
post-write reread: verification proves a momentary match and nothing more, since
the body can be edited immediately afterwards.

**Five artifacts, five different correct refutations, and one line running through
all of them.** Body, head ref, label, committed file, commit status — every one is
writable by a repository collaborator or unenumerable without the query it was
supposed to bound. This document had already written the rule twice, in preserved
item 3 and item 5: *what the repair is allowed to trust must be decided before any
mechanism is chosen*. It then chose five mechanisms without deciding it. Answering
the question takes one table and was executable from the first head — the trust
root is `main`'s protected history and the content of a reviewed SHA, and nothing
else in GitHub's collaborator-writable surface qualifies.

Stating the boundary is the durable part. What #390 did next was not: it still
shipped the bundle, now described as fitting inside the trust root, and that
description is what its own second round took apart. What closing the rest takes is
an authority outside GitHub's collaborator-writable surface, which is an
infrastructure decision rather than another paragraph.

**#390 is where the answer stopped moving.** Its first round tested the boundary
rather than crossing it — six findings, none proposing an artifact, and two of them
establishing the rule this document now applies to itself: *a repair may not
describe a known fail-open as scope it chose to retain.* Its second round applied
that rule to the bundle and refused it outright, in three findings that each named
the same alternative — remain fail-closed; freeze in protected evidence or fail
closed; **authenticate the owner, or do not enable cross-unit bundles.**

**Three heads made the same trade and it was refused three times.** #388, #389 and
#390 each shipped a bundle whose safety rested on a fail-open the same document
disclosed a few paragraphs later. Disclosure is not consent, and stating a
limitation honestly does not make it safe to build on. That is the correction, and
it lands on the centrepiece rather than on a detail.

**So the bundle is not buildable and this document says so.** What remains is the
one requirement that needs no enumeration, no legacy evidence and no owner — base
revalidation at the authorization boundary, which #377 found and nothing since has
fixed — plus the malformed-declaration refusal a rewrite would otherwise drop. §1
stays unfixed, its cost is stated rather than softened, and what would unblock it
is an infrastructure decision named with its three shapes and their prices.

**#391's first round then caught two mistakes in the refusal itself**, and both are
worth keeping. The document claimed a docs-only unit "ships" base revalidation — a
diff touching two markdown files cannot change a gate, and reading it that way could
let a later handoff treat #377's live defect as delivered. And base revalidation
turned out not to be independently deliverable at all: the reviewed tree has no
claim write for it to precede, so it means something only alongside #377's
timeline-claim mechanism, whose shared-bot provenance is the OTHER unresolved P1.
Both #377 findings travel together or neither does.

**It also caught a human sign-off gate I had written into STATUS** — "that choice is
the owner's, and §1 is blocked on it" — which this repository forbids. The
correction is an autonomous default (the loop continues, the bundle stays disabled,
the queue drains one per merge) plus a machine-observable unblock condition
(verified-signature commits from a controller-held key, or a controller-written
record whose writer the gate can authenticate). Naming a decision is useful;
suspending the loop until someone makes it is not.

Seventeen finding-bearing heads across nine units bought the table and its
consequences — #383 through #390 at two apiece, and #391's first — which is the
count the rounds line above adds up to. It is written down here so the sixth
mechanism is not proposed, the trade refused three times is not offered a fourth,
and the loop is never again recorded as waiting on a person.

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

## What this repository is allowed to trust

This document asked itself the question twice — preserved item 3, and item 5's
"every input such a bootstrap could read is forgeable, so what it is allowed to
trust must be decided **before any mechanism is chosen**" — and then chose five
mechanisms without answering it. Each was found, each for a different and correct
reason. The answer is short, and every row of it was executed rather than argued.

| Candidate | Writable by a repository collaborator? | Enumerable independently of the label query? | Where it failed |
| --- | --- | --- | --- |
| pull request body | **yes** — plain edit, no review | n/a | #381 |
| head ref prefix | **yes** — the author picks the branch | n/a | #386; `scripts/correction-owner.mjs` already recorded #349/#350 on one prefix with different owners |
| label | **yes** | only via the label query itself | #375, #377 |
| committed file | only through a reviewed pull request | yes | #389 — two external writes cannot be atomic; cannot authenticate what predates it; cannot bound its own bootstrap |
| commit status | **yes** — executed: `GitHubClient.statuses(head)` applies no creator filter | **no** — executed: it requires a known SHA, so the set of SHAs still comes from the label query | #389 |
| **`main`'s protected history** | **no** — executed: `protected: true` | yes | — |
| **a reviewed commit SHA** | **no** — content is fixed by the hash | n/a | — |

**So the trust root is exactly two things: `main`'s protected history, and the
content of a reviewed head.** Anything a repository collaborator can write is not
evidence, however official it looks. Five mechanisms failed because they were all
on the wrong side of that line, and the line was verifiable from the first head.

## What a repair would require, and why none of it is buildable now

**Nothing in this section ships in the unit that carries this document.** This is a
record and a specification for a later implementation unit; merging it changes no
gate behaviour, adds no revalidation, and leaves every defect below live. An
earlier head said the open unit "ships" base revalidation, which a docs-only diff
cannot do — and reading it that way could let a later handoff treat #377's live
defect as delivered while this same document says #377 is still pending.

**The bundle cannot be enabled.** §1's remedy is a claim carrying several
obligations, and it needs three facts: a complete obligation enumeration,
settlement evidence for already-merged candidates, and the owner a source had at
exhaustion. None exists inside the trust root, and #390's review refused the trade
three times over — *remain fail-closed rather than ship this waiver path*; *freeze
in protected evidence or fail closed*; *authenticate the owner, or do not enable
cross-unit bundles.* Three heads shipped a bundle resting on a fail-open the same
document disclosed a few paragraphs later. Disclosure is not consent.

**And the one requirement that looked independent is not.** Base revalidation at
the authorization boundary — #377's second unresolved finding — reads: check base
identity and ancestry *before the claim write* and at every later evaluation. The
reviewed tree has **no claim write to precede**: `assessReplacementLineage` reads
live bodies on every evaluation, so a retarget is already caught the next time the
gate runs. The requirement only means something alongside #377's timeline-claim
mechanism, which records a claim that cannot be withdrawn.

That mechanism cannot be restored as it stands. This document's own preserved item
3 records why: it treats the timeline actor as sufficient provenance, and every
workflow here shares one `github-actions[bot]` identity, so the actor filter is
necessary and not sufficient. **Restoring it reintroduces that P1; omitting it
leaves base revalidation with nothing to guard.** Both of #377's unresolved
findings therefore travel together, and neither is separately deliverable:

1. **The claim record needs authenticated provenance** — a writer a claimant cannot
   impersonate. The shared bot identity is not one.
2. **The claimant must be revalidated whole at the authorization boundary, base
   included** — before the irrevocable write and at every later evaluation, since a
   claimant retargeted to another or stale base after its claim was recorded
   otherwise satisfies every other check.

**What survives is one preservation note**, and it is stated because a
reimplementation is likely to drop it by accident rather than by decision: the
malformed-declaration refusal lives in `assessReviewScope`, not in the lineage
function. A rewrite that touches only the lineage function must not assume it is
inherited. That is not a repair; it is a fence around behaviour `main` already has.

## What §1 costs while this stands, and what the loop does about it

The accumulation defect is unfixed. Each exhausted unit takes one merged
replacement to discharge, so a queue of N costs N sequential merged units — and
this document's own lineage is the demonstration: nine record units, one obligation
added per closure, the queue growing while the repair for its growth was written.

**That is a throughput cost, not an integrity failure**, and §1's executed
conclusion has stood since the first head: the backlog is **long, not stuck**.
Every entry is claimable, every entry drains on merge, no obligation is lost.

**The autonomous default is therefore to continue.** The loop is not blocked and
must not be recorded as blocked: with no authority available, the bundle stays
disabled, the queue drains at one unit per merge, and every other objective
proceeds normally. Nothing here waits on anyone. An earlier head ended on "that
choice is the owner's and §1 is blocked on it", which is a human sign-off gate and
this repository forbids one.

**The machine-observable condition that changes it** is the presence of an
authority the gate can verify without asking anybody:

- verified-signature commits on `main` attributable to a controller-held key, which
  `git log --show-signature` and the GitHub API both expose; or
- a controller-written record the gate can read and whose writer it can
  authenticate.

When either becomes observable, the three facts the bundle needs become obtainable
and §1's remedy is buildable — by a unit that reads the condition rather than a
person who announces it. Until then the default above holds, and no work stops.

**The prices are real and are recorded so the choice is informed rather than
blocking**: a signing key means the repository holds a secret; an external record
means a service and a credential in a loop that has neither; an accepted
attestation means a manual act inside an autonomous loop, which is what the owner
removed on 2026-08-20 for that exact reason. None of these is a precondition for
the loop to keep running.

## Preserved: what an authenticated record would have to satisfy

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
   owner equality becomes possible at all. It is not in this repair: no artifact
   inside the trust root carries an authenticated owner, and #389 executed the last
   candidate — commit statuses accept a write from any collaborator. Six heads
   reached for it and none shipped. What a record would add is the one thing review
   cannot substitute for: a fact about who owned a unit at the moment it was
   exhausted, written by someone a claimant cannot impersonate.

   Two constraints on any such record, and the first was stated backwards in an
   earlier head.

   **It must REFUSE a claim whose source ownership it cannot authenticate**, even
   though that leaves the obligation blocked until evidence for it exists. The
   alternative is admitting a claimant without owner equality or inventing an
   owner, and either lets a `claude` claimant discharge a `cursor`-owned unit —
   which the repository forbids outright. An earlier head wrote "it must NOT fail
   closed", citing #386.

   **That citation confuses two different jams, and the difference is whether
   there is a way out.** #386 refused a rule that derived the owner from a branch
   prefix and failed closed on every other shape: those sources could never be
   resolved by anything, so the queue jammed permanently with no exit. A record
   that refuses *unauthenticated* ownership jams a source only until the record
   carries evidence for it — and supplying that evidence is the record's whole
   purpose. Blocked-pending-evidence is a state with an exit; unclaimable-forever
   is not.

   **And it must be written when the controller LABELS a unit exhausted** rather
   than read when a claimant is admitted, since anything read later reads whatever
   the body says by then.

   Two constraints on any stronger record, both learned the hard way: it must NOT
   fail closed on units it cannot resolve, since #386's review executed that
   consequence and the whole queue jams; and it must be written when the controller
   LABELS a unit exhausted rather than read when a claimant is admitted, since
   anything read later reads whatever the body says by then.

## On the automatic release valve that was sketched here

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
- **Pending: #377, #378, #379, #383, #384, #385, #386, #387, #388, #389 and #390.
  Settled: #381, by merged #382** — which still carries the label, because
  discharge is computed rather than un-marked. This unit replaces #390 and carries
  the record forward. The record
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
