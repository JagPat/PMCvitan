# PR #312 — convergence audit

Two finding-bearing heads, eight findings. The protocol says stop patching and say what is
actually going wrong. Three things are, and only one of them is new.

| Head | Findings |
|---|---|
| `0240338` | 5 — freeze the column · rerunnable `ADD COLUMN` · the payment resolver · the DB consume seal · the unrendered state |
| `a805d47` | 3 — the legacy diagnostic's predicate · a recycled status label · the version read outside its lock |

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
2. **One site the writers cannot opt out of.** `lifecycleVersion` is bumped by a BEFORE
   UPDATE trigger, not by a line in each service. There are **six** writers of
   `VendorBill.status` across four services; "remember to also bump the counter" is exactly
   the instruction this audit is about nobody remembering. A seventh writer added tomorrow
   inherits it without being told.

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

So the deferral is paid here rather than deferred again. `VendorBill.lifecycleVersion` is a
per-claim counter that only ever moves forward, and it is the second term of every reviewed
identity. It is available to the client work in 7B-iii-g and to 7B-iii-d without being
re-derived, because it is a server fact rather than an inference from timestamps.

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
