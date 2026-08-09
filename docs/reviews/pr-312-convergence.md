# PR #312 — convergence audit

Five finding-bearing heads, nineteen findings. The protocol says stop patching and say what is
actually going wrong. Four roots are — A (fix the class, not the instance), B (a description is not
an identity), C (a rule holding by accident elsewhere is not enforced) and D (a guard on the
transitions of a row is not a guard on the row) — plus one narrower lesson about lock order that
round 3 bought the hard way, and one about the axis an enumeration is written on.

Root D and the round-6 early-return table are at the end of this document; they are the ones a
reader short of time should start with. Round 4's enumeration was the artifact meant to prevent
round 5, and round 5's class sweep was the artifact meant to prevent round 6. Both were sound and
both missed, and why they missed is more useful than any single fix in this PR.

| Head | Findings |
|---|---|
| `0240338` | 5 — freeze the column · rerunnable `ADD COLUMN` · the payment resolver · the DB consume seal · the unrendered state |
| `a805d47` | 3 — the legacy diagnostic's predicate · a recycled status label · the version read outside its lock |
| `d5753e9` | 4 — the counter tracked labels not money · the server recorded its own "now" · the consume seal never compared revisions · the abort ran before its own guards |
| `5af64d6` | 5 — the counter could be born negative · the act's check held nothing · retirement was unscoped · the grant seal ignored issue · the certify boundary never asked for the pin |
| `b142501` | 2 — the act's NULL exemption applied to NEW rows · the retirement reason accepted whitespace |

---

## Root A — fix the CLASS, not the instance a finding names

This is PR #310's root, recorded in `docs/reviews/pr-310-convergence.md`, and it has now
recurred **four more times inside the PR that was supposed to have learned it.**

| Recurrence | The instance I fixed | The class I did not |
|---|---|---|
| #310 r1→r2 | the one call site a finding named | every consumer of the same rule |
| #312 r1, F1/F3/F4 | the COLUMN — `SodGrant` gained `reviewedStatus` | every guard already surrounding that row: the append-only freeze, the commit-time consume seal, and the sibling resolver in the next file |
| #312 r2, R2-1 | the `ADD COLUMN` statement, made rerunnable exactly as F2 asked | the FILE's replay safety — the diagnostic four lines below aborts on any live grant, so the repair the abort instructs destroys itself the moment it succeeds |

The shape is identical every time, and it is not carelessness about *whether* to fix
something. It is that **I keep treating a finding's example as its scope.** Codex writes
"freeze `reviewedStatus` in the grant trigger" and I freeze `reviewedStatus` in the grant
trigger. The sentence is satisfied; the property is not.

R2-1 is the sharpest instance because the two statements are **nine lines apart in one
file**, both about the same requirement — this migration must survive a replay — and I read
the finding as being about one of them.

### What actually changes, rather than a promise to be careful

Two structural things in this head, chosen because they remove the possibility rather than
warn about it:

1. **One implementation, not two.** `commercial-sod.ts` now holds the §I resolution rule and
   both halves read it. The reason R2-2 could not repeat the F3 shape is that there is no
   longer a second copy to forget — the fix landed in the only place there is.
2. **One site the writers cannot opt out of.** The claim's revision is advanced by triggers,
   not by a line in each service. There are **six** writers of `VendorBill.status` across four
   services and **six** tables feeding the payment folds; "remember to also bump the counter"
   is exactly the instruction this audit is about nobody remembering. A seventh writer added
   tomorrow inherits it without being told.

The rule I am extracting for myself, stated so it is checkable rather than aspirational:
**when a finding names an artifact, enumerate every other thing that already surrounds that
artifact and answer for each of them in the same head.** For a database column that means
the CHECKs, the triggers, the indexes, the readers and the writers — as a list, written
down, before the fix is called done.

---

## Root B — a description is not an identity

New in this PR, and it is the load-bearing finding of round 2 (R2-2, P1).

Round 1 recorded the claim STATE a grant was justified against, because the claim VERSION
had proved insufficient — one version walks the whole lifecycle. The correction was right
and it was still a level too shallow: I replaced one insufficient identity with another
without asking the question that had just been forced on me — *is this thing an identity at
all?*

It is not. §F **derives** the payment status from the folds, and the derivation genuinely
returns to a label it has left:

```
certify ₹100, withhold ₹10   → certified   (₹90 payable, nothing approved)
approve ₹90, pay ₹90         → paid
release ₹5 of the withholding → certified   (the SAME label, ₹90 gone)
```

An authorisation given at the first `certified` matches the label at the second. Comparing
labels brings a spent-past authority back to life over money the approver never saw.

**This was already known.** JagPat's directive on PR #306 said it in general form:

> Do not impose a total order on equal-time, different-status copies. Either expose a
> monotonic server lifecycle version, or treat equal timestamp + differing status as
> ambiguous and reconcile/refuse transitions until a canonical read resolves it.

That was carried as a deferral — "a monotonic per-bill lifecycle version from the server" —
and then I reached for a status label anyway the next time I needed a claim identity. Codex
arrived at the same requirement independently ("the reviewed identity needs to include a
monotonic payment-state fact, not just the reusable status string"), which is two
independent readers naming one missing primitive.

So the deferral is paid here rather than deferred again. The claim's REVISION
(`VendorBillRevision`) is a counter that only ever moves forward, and it is the second term of
every reviewed identity. It is available to the client work in 7B-iii-g and to 7B-iii-d without
being re-derived, because it is a server fact rather than an inference from timestamps.

**Checkable form:** before pinning "what someone was looking at", ask whether the pinned
value can ever be true twice. If it can, it is a description; pin a monotonic fact beside it.

---

## Root C — a rule that holds by accident elsewhere is not enforced

R2-3 (P2). The live-version lookup sat above `lockBill`, so a version pin was compared
against a row read before the lock was held.

Stated honestly, because the alternative is claiming more than I fixed: **the interleaving
Codex describes is not reachable today.** `grantSodException` and `amend` both take
`lockProjectReadiness` first and are already serialized against each other. What was wrong
is that the pin's correctness rested on a lock taken somewhere else for a different reason,
and nothing in the code said so. The next command added beside it would inherit the
accident, not the rule.

The repository has said this before, about a different mechanism:

> a predicate checked at one writer is unchecked at every other

Same sentence, one level up: a predicate *protected* by a lock taken for another purpose is
protected until that other purpose changes.

**Checkable form:** every read whose freshness a decision depends on happens under the lock
that decision names — not under a lock that happens to be held.

---

## Round 3 — root B was right and my answer to it was one level too shallow

Four more P1s, and they are all the same sentence: **the counter I added tracks the label, and
the label is not the money.**

| Finding | What it showed |
|---|---|
| R3-1 | the counter advanced only on status transitions — but §F's first two arms mean a claim with nothing approved reads `certified` at ANY payable, so a retention release moves ₹90 to ₹95 and the counter does not move at all |
| R3-4 | the command compared the caller's version/status pins and then recorded the DATABASE'S CURRENT counter — the server agreeing with itself about a number the approver never saw |
| R3-2 | the consume seal checked the admissible reviewed *state* and never the revision, so a claim returning to `verified` at a later revision still satisfied it |
| R3-3 | the aborting diagnostic ran BEFORE the guards, so the legacy path could commit the evidence columns with neither the widened index nor the freeze installed |

Root A's rule — *fix the class, not the instance* — is what R3-1 and R3-4 violate, one more
time and in a new costume: I answered "the label recycles" with "count the label's
transitions", and I answered "pin what was reviewed" with "record what is current". Both
times the finding's example got fixed and the property behind it did not.

Root B's rule, restated after round 3, is the one that actually generalises:

> **The reviewed identity must advance whenever anything a reviewer would have seen changes.**

Not when a label changes. Not when the server happens to look. The counter is now the claim's
COMMERCIAL REVISION, advanced by a trigger on every one of the six tables that feed §F's three
folds — so a seventh fold source added tomorrow is a visible omission in one enumerated list
rather than a silent hole in an authority check. `PROBE 30` is that list, asserted.

### …and the fix's FIRST shape re-opened a decision an earlier round had already made

Worth recording, because the probe that caught it is the point of having probes.

The first spelling advanced the counter with a trigger that UPDATEd `VendorBill`. That takes the
CLAIM'S row lock — from a writer that may hold no other lock at all. Task 5C's Codex round 6 had
already **removed** a certificate-side bill lock for exactly this reason: the honest withholding
path runs `bill → certificate`, so a certificate-side write reaching back for the bill is ABBA,
and PostgreSQL answers an ABBA cycle by aborting somebody with a deadlock rather than by the
refusal the seal was written to give. That decision left two probes standing over it, and PROBE 20
failed the moment my trigger re-introduced the inversion.

So the counter lives on its OWN row (`VendorBillRevision`), taken LAST by everybody —
`bill → certificate → revision`, `certificate → revision`, `deduction → revision` — and forms a
cycle with nothing. This is not a workaround for one probe: the same inversion existed for every
one of the six fold sources, because a bypass writer touching only that table would have reached
for the bill from a lock position the honest path never uses.

The lesson is narrower than the roots above and worth its own line: **a new trigger is a new lock
order.** Adding one to a table that other transactions already reach through is a concurrency
change, not a bookkeeping change, and this repository has already paid to learn where its cycles
are.

Two more things this round makes structural rather than promised:

- **The act carries what it saw.** `BillCertificate.reviewedLifecycleVersion` and
  `PaymentApproval.reviewedLifecycleVersion` let the consume seal compare two frozen columns
  instead of inferring what the counter was before the act moved it. Round 2's packet argued
  the seal *could not* check the revision; that argument was true only for the shape I had,
  and Codex was right that the conclusion did not follow.
- **The resolver is told what it is judging.** `resolveSodGrant` now takes the claim state the
  caller is acting on. That is not plumbing: `certify` inserts its certificate — a fold source —
  before it asks the §I question, so reading "now" made every certification refuse its own
  valid authorisation. My own probes caught that within a minute of the fix, which is the
  argument for the probes existing.

## What this head does NOT do

It does not touch the round-1 fixes that Codex accepted; they are unchanged. It does not
widen the unit's scope — no new §I surface, no client work, nothing from the parked branch.
Every change here answers one of the three findings or is the audit itself.

One thing is deliberately left alone and named rather than silently skipped: the DB consume
seal still checks the admissible reviewed *state*, not the lifecycle version. It cannot
check the version, because by COMMIT the act being sealed has already moved the claim on.
The division stays what it has been all phase — **the seal states what is invariant, the
service states what is fresh** — and the service is where the recycling defence lives, with
PROBE 27 proving it against live PostgreSQL and a mutation proving the version term is what
makes it pass.

---

## Round 4 — the enumeration I kept not doing

Five P1s (one of the six posted comments is a re-post of round 3's, already fixed at line 281).
Four heads, seventeen findings, and root A's "checkable form" — *enumerate every guard that
already surrounds the artifact* — has been sitting in this document unused since round 2. So it
is done here, as a table, before any code.

Every artifact this unit introduces, and every guard that must answer for it. **✗ = gap on head
`1024c4b`**; the four unmarked by Codex are ones this enumeration found.

| Artifact | Frozen | True-at-write | Identity | Live-scope | Boundary pin | Resolver | Reset/ownership |
|---|---|---|---|---|---|---|---|
| `SodGrant.reviewedStatus` | ✓ | n/a | n/a | ✓ | ✓ grant | ✓ | n/a |
| `SodGrant.reviewedLifecycleVersion` | ✓ | n/a | n/a | ✓ | ✓ grant | ✓ | n/a |
| `VendorBillRevision` | ✓ forward-only | n/a | **✗ R4-5** + **✗ DELETE guard (mine)** | PK ✓ | n/a | n/a | ✓ |
| `BillCertificate.reviewedLifecycleVersion` | **✗ R4-3** | **✗ R4-4** | n/a | n/a | **✗ R4-6 certify** | n/a | n/a |
| `PaymentApproval.reviewedLifecycleVersion` | **✗ mine** | **✗ R4-4** | n/a | n/a | **✗ mine, approve** | n/a | n/a |
| legacy NULL grants | n/a | n/a | n/a | n/a | n/a | ✓ unusable | **✗ R4-2 retirement** |

Nine gaps. Five Codex named; four this table found — which is the point of writing it, and the
reason the previous three rounds each shipped one level short.

**R4-4 is the deepest and it invalidates round 3's premise.** The consume seal compared the
grant's revision to the ACT's, and I argued that was "two frozen columns, no inference". It is two
**self-authored** columns: a bypass writer inserts the certificate with whatever revision matches
the stale grant. The seal proved the writer agrees with itself. What makes the act's number true
is a BEFORE INSERT check against the claim's actual revision — before the act's own AFTER trigger
advances it — which is available, cheap, and takes no lock (a plain read).

**R4-2 and round 3's R3-3 are in direct tension, and resolving it changes the design.** R3-3 said
install the guards before the abort; R4-2 observes that once they are installed a legacy NULL
grant can be neither filled nor consumed nor retired, so the documented repair ("re-issue, then
redeploy") never clears the count and the migration is not rerunnable at all. Codex names both
exits. The right one is that **an abort was the wrong instrument**: the migration RETIRES legacy
grants with an attributable stamp instead of stopping the deploy. That is not the silent
revocation the abort existed to prevent — the row is retained, marked, and named in the runbook —
and it is the only shape where the remedy terminates.

---

## Round 5 — the enumeration was on the wrong axis

Five findings on `5af64d6`. Round 4 wrote a table specifically to stop this, and the table did
find four gaps Codex had not named — so the practice works. It still missed these five, and the
reason is worth more than the fixes.

**Round 4 enumerated ARTIFACT × GUARD: "does a guard exist for this fact?"** Every cell it marked
✓ was true. A guard existed in every one of them. What it never asked was the two questions that
decide whether an existing guard is worth anything:

1. **On which EVENTS does it fire?** A trigger declared `BEFORE UPDATE OR DELETE` is invisible on
   the way a row is born.
2. **Does it HOLD what it reads?** A comparison against a number another session is moving is a
   guess with good manners.

Three of the five findings are question 1, one is question 2, and one is the same question at the
HTTP boundary. Read on the right axis they are nearly one finding.

### The sentence round 4 wrote that round 5 refuted

Round 4's own text, above, closing the R4-4 argument:

> What makes the act's number true is a BEFORE INSERT check against the claim's actual revision —
> before the act's own AFTER trigger advances it — **which is available, cheap, and takes no lock
> (a plain read).**

That parenthesis is finding `migration:228` verbatim, written by me, in this document, as a
reassurance. I reasoned about *when* the check runs and never about *what else could be running*.
A guard's correctness is not a property of the guard; it is a property of the guard **and every
concurrent writer of the thing it reads**, and only the second half needs the lock.

### Root D — a guard on the transitions of a row is not a guard on the row

The three event-coverage findings are one root, and it is distinct from root A. Root A is *the fix
did not travel to the siblings*. This is *the fix did not cover the way in*:

| Guard | Covered | Open | What walked through |
|---|---|---|---|
| `VendorBillRevision_forward_only` | UPDATE, DELETE | **INSERT** | a row born at `-1`; the next fold write lifts it to `0` and revives every authority pinned there |
| `phase5_t7biiih_grant_reviewed_state_sealed` | consumption | **issue** | a grant post-dated to a passage the claim has not reached — later it arrives, every column matches, and the consume seal is satisfied |
| `phase5_t5_grant_append_only` retirement | the direction (one-way) | **the population** | an escape hatch cut for evidence-less legacy rows, silently revoking live evidenced ones |

The third is the same shape seen from the other side: a transition made one-way without ever
asking *which rows may take it*. One-way is about direction; scope is about membership; and
policing one is not policing the other.

### Re-enumerated on the axis that would have caught them

**✗ = gap on head `5af64d6`.** The columns are now events and serialization, not existence.

| Guard | INSERT | UPDATE | DELETE | Holds what it reads | Population scoped |
|---|---|---|---|---|---|
| `VendorBillRevision_forward_only` | **✗ R5-1** | ✓ | ✓ | n/a (row-local) | n/a |
| `VendorBill_opens_revision` | **✗ absent (this table)** | n/a | n/a | n/a | n/a |
| `*_reviewed_revision_true` (both acts) | ✓ | ✓ freeze | n/a (append-only) | **✗ R5-2** | n/a |
| `grant_reviewed_state_sealed` | **✗ R5-4** | ✓ consumption | n/a | **✗ R5-4** (issue arm) | n/a |
| `grant_append_only` retirement | n/a | ✓ one-way | n/a | n/a | **✗ R5-3** |
| certify HTTP contract | **✗ R5-5** | n/a | n/a | n/a | n/a |
| approve HTTP contract | ✓ | n/a | n/a | n/a | n/a |
| grant HTTP contract | ✓ | n/a | n/a | n/a | n/a |

Six gaps; five Codex named, and one — `VendorBill_opens_revision` — this table found.

**That sixth is the premise the other two rest on**, which is why it is a design change rather
than a patch. The counter read `COALESCE((SELECT revision …), 0)`: a claim that had never moved
money had **no row**, and read zero *by absence*. An absence cannot be locked (`SELECT … FOR
UPDATE` over nothing locks nothing) and cannot be constrained (no CHECK polices a row that is not
there). Adding `FOR UPDATE` to the act check and to the issue seal would have been theatre on
exactly the claims where an authority is most likely to be issued — the quiet ones. So the row is
now opened **with the claim** and can never be deleted, and the implicit zero stops being a state
the system can be in.

Lock order is unchanged and deliberately so: `VendorBillRevision` is still taken LAST by every
path (`bill → certificate → revision`), so the two new acquisitions close no cycle with the claim
lock. The ABBA constraint round 3 bought the hard way still holds, and PROBE 20/21 still stand
over it.

### The review-lifecycle signal, and why this head is not a split

The orchestrator flagged this unit at its finding-bearing-head limit and suggested splitting it. I
did not, and the reasoning belongs on the record rather than in a commit message.

A split here is available and coherent — unit A (the monotonic claim revision, the act pins, the
optimistic-concurrency refusal) genuinely precedes unit B (the §I grant's reviewed-state record),
and B depends on A rather than the reverse. What decided against it is that **all five open
findings are sealing gaps in one trigger set in one file**, four of them in guards that exist only
to serve the seal, and splitting would have meant surgery on a branch with ten green checks to
spread one mechanism's seals across two migrations — making the seal set harder to audit as a
whole, which is the thing review size is a proxy for.

The reviewability problem in this PR was measured instead of assumed. It was **1,215 lines of
`prisma format` realignment** in `schema.prisma` — 672 insertions and 611 deletions of column
whitespace, carrying no meaning and drowning 68 lines that do. That churn is reverted here and the
schema diff is now additions only. The PR drops from 3,546 changed lines to roughly 2,300, of
which the required packet, convergence audit and probes are the majority.

If a sixth finding-bearing head arrives, the split is the answer and unit A above is its seam.

### What this head does NOT do

- It does not add a command to withdraw a live authority. Round 5's F3 makes retirement unable to
  serve as one; building the real thing needs its own author, its own evidence and its own
  attribution, and inventing it inside a correction is how the unscoped hatch got here.
- It does not weaken `phase5_t5b`'s R8-F1 probe, whose forged grant now carries a truthful reviewed
  state. The opposite: without that, the new issue seal would refuse the row first and the
  authorship rule R8-F1 exists to test would have gone unexercised behind a green tick.

---

## Round 6 — the sweep I wrote down and then did not run

Two P2s. Both real; both small in code. The first is the one that matters, and it is **root D a
third time, nine lines away from where I fixed it the second time.**

Round 5's own text, closing the retirement fix:

> An escape hatch cut for one population applies to all of them unless it says otherwise.

`phase5_t7biiih_act_reviewed_revision` had the *same* hatch and I did not look at it. `NULL` meant
"legacy" — a row written before the column existed — and the trigger returned early on it. But a
legacy row is never INSERTED again; it can only be updated, and the freeze arm already refuses
every change to one. So on INSERT, NULL was never legacy: it was a post-migration writer declining
to say which passage of the claim they acted on, at a boundary that had just been made to require
the answer. Nothing downstream would have asked — the consume seal reads that column only when a §I
authority is spent, so an act consuming no grant carried no reviewed passage at all.

| Finding | Root | Fix |
|---|---|---|
| R6-1 (P2) | **D**, third instance — a hatch cut for the legacy population applying to the new one | on INSERT the column is required; the value is refused, never derived, because deriving it is the server recording its own "now" (rounds 3 and 4) |
| R6-2 (P2) | a repository convention not applied | bare `btrim()` strips only spaces, so a tab or newline reads non-blank to the check and blank to a human; the full ASCII-whitespace trim this repository settled for `manualReason` in Phase 4 |

### Why the class sweep did not catch R6-1 — and what did

After pushing `b142501` I ran a class sweep for root D over the commercial trigger set: every
non-internal trigger on the eleven §F/§I relations that does **not** fire on INSERT. Twelve hits,
all correctly scoped — nine `*_append_only` (where not firing on INSERT is the definition),
`VendorBill_lifecycle_version` (a status *transition*), and `BillCertificate_paid_bound_sealed` (a
supersession-time rule). I concluded: no further instances.

The sweep was sound and its conclusion was wrong, because **it asked the wrong question again.**
`*_reviewed_revision_true` DOES fire on INSERT — so it never appeared in the sweep — and inside
that INSERT arm it returned early on NULL. The gap was not a missing event; it was a **conditional
exemption inside a covered event.** A sweep that enumerates triggers by their event mask cannot see
one.

The checkable form, which is what this round adds and the two before it lacked: **for every
guard, list its early returns and name the population each one is for.** An early return is an
exemption, and an exemption that does not say who it is for is an exemption for everybody.

Applied here, and run to completion rather than described: the migration's six trigger functions
contain **twelve** `RETURN` statements. Eight are terminal — the end of a function that has already
made every check it makes — and four are conditional exemptions. All four, with the population each
is for:

| Guard | Early return | Population it is for | Is it scoped? |
|---|---|---|---|
| `act_reviewed_revision` | `TG_OP = 'UPDATE'` → freeze only | any row whose revision is already recorded | ✓ — it refuses every change |
| `act_reviewed_revision` | `reviewedLifecycleVersion IS NULL` | rows predating the column | **✗ R6-1** → now INSERT-only refusal |
| `grant_reviewed_state_sealed` | `consumedAt IS NULL` | grants not yet spent | ✓ round 5 — the issue arm judges them |
| `grant_append_only` | retirement transition | evidence-less legacy rows | ✓ round 5 — scoped explicitly |

### The split, decided on evidence rather than on the head count

Six finding-bearing heads against a limit of five. Round 5 recorded a commitment: *"if a sixth
finding-bearing head arrives, the split is the answer and unit A is its seam."* That commitment is
not being kept, and the reason is specific rather than convenient.

The split's seam runs between unit A (the monotonic claim revision and the act pins) and unit B
(the §I grant's reviewed-state record). **R6-1 is in unit A.** Its fix required updating 22 cleared
bypass-writer probes across five suites — measured, not estimated: the change was implemented and
the suites run before this paragraph was written. Every one of those 22 edits lands in unit A
whichever way the PR is cut. So a split would buy nothing on this round's work and would add branch
surgery on top of it.

The other half of the evidence is direction. Round 5: five findings, four of them P1. Round 6: two
findings, zero P1. The premise behind the head-count limit is a unit that is not converging; this
one is. The limit is a good default and this is a case where the specific evidence contradicts it,
so it is recorded here rather than silently ignored.

What the 22 edits bought is worth stating, because it is not merely compliance: those probes now
construct **fully coherent** acts and omit only the thing under test, so each refusal they assert is
unambiguously the seal they name. That is the same correction round 5 applied to PROBE 34 and to
`phase5-t5b`'s R8-F1 — a probe that is refused by a neighbouring seal proves nothing about its own.
