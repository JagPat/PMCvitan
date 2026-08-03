# PR #276 — architectural convergence audit (Phase 5 Task 5A)

Five finding-bearing heads, nineteen Codex findings, and three CI failures that were the same defect
class arriving through a different door. Per `CLAUDE.md`, this stops being another isolated patch:
it names the ROOT they share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `76eda23` | 5 | 2×P1, 3×P2 |
| `26af605` | 3 | 1×P1, 2×P2 — two of them the round-1 fixes, one level short |
| `d4d9773` | 3 | 1×P1, 2×P2 — one of them root A a THIRD time on the same set |
| `7e33e97` | 5 | 1×P1, 4×P2 — the same set a FOURTH and FIFTH time, plus two more round-N fixes one level short |
| `f9777f9` | 3 | 2×P1, 1×P2 — the provenance seal a THIRD time, one level DOWN; the firing set; and a workaround that outlived its cause |

Plus, on the way: `upgrade-proof` and the `api` suite failed on `bd351e9`, and `api-e2e` failed on
`3e2e8d4`. Neither was a flake. Both belong in this audit because they are the same root.

---

## The twenty-two

| # | Head | Sev | What was wrong | The SET it belonged to |
|---|---|---|---|---|
| 1 | `76eda23` | P1 | Verify moved a claim between the live and non-live billed folds without evaluating the budget heads | writers of `BILLED_AMOUNT` |
| 2 | `76eda23` | P1 | `verified` was assertable by raw SQL with no part of the §E verdict re-derived | statuses that must be the shadow of a fact |
| 3 | `76eda23` | P2 | Opening `verified` broke `amend`, which has always CASed `verified → submitted` | arrows OUT of a newly-opened state |
| 4 | `76eda23` | P2 | The duplicate scan implemented one of the two service-side cases §E names | cases §E enumerates |
| 5 | `76eda23` | P2 | An idempotency replay refolded — without the claim it had judged — and could answer `matched` over a dispute | — (see root B) |
| 6 | `26af605` | P1 | The packet claimed within-budget while the head was over both thresholds | documents asserting the same gate |
| 7 | `26af605` | P2 | Finding 5's fix keyed the replay to the CURRENT version, not the original command | — (see root B) |
| 8 | `26af605` | P2 | Finding 4's fix compared 2 of the 4 components that make a claim identical | components of "identical" |
| CI-a | `bd351e9` | — | The §F arrow was opened in the trigger and left asserted-closed in the upgrade proof and Task 4's probe | places asserting an arrow's state |
| CI-b | `bd351e9` | — | A new model reached CI with no declared owner | registries a model joins |
| CI-c | `3e2e8d4` | — | A new table with an FK into the reset set was missing from six TRUNCATE lists | tables closed under inbound FKs |
| 9 | `d4d9773` | P1 | The trigger trusted ANY `matched` row — a maintenance path could insert one and flip the status | — (see root D) |
| 10 | `d4d9773` | P2 | The verification READ refolded without the claim it was reporting on | places that report a verdict |
| 11 | `d4d9773` | P2 | The duplicate scan compared LINES, so re-partitioning 60+40 vs 100 hid a twin | the unit a claim is compared in |
| 12 | `7e33e97` | P2 | The read's FALLBACK recomputed over folds §0 excludes the subject claim from, so a claim disputed at submission read `matched` | computations over the billed fold that must count the subject |
| 13 | `7e33e97` | P2 | The read returned a recorded `matched` after a withdrawal guard disputed the bill without appending a verdict | places that report a verdict |
| 14 | `7e33e97` | P1 | The provenance seal checked the command's TYPE, not that the command PRODUCED this verdict | — (see root D) |
| 15 | `7e33e97` | P2 | `verified → submitted` was opened for `amend` without requiring the amendment | arrows opened with the evidence that makes them safe |
| 16 | `7e33e97` | P2 | `exceptions` accepted any text, so `['looks wrong']` was a recordable verdict | the §E exception vocabulary |
| 17 | `f9777f9` | P1 | The `resultRef` provenance rested on `CommandExecution`, which has no triggers at all — a receipt can simply be minted `succeeded` | — (see root D) |
| 18 | `f9777f9` | P1 | The deferred seal fired only from `VendorBill`, so superseding the live version under a `verified` bill escaped it | sites a seal must fire from |
| 19 | `f9777f9` | P2 | A recorded exception could never be neutralised by later live evidence — `contradicted()` was one-sided | — (see root E) |

---

## Root A — the member, not the set (sixteen of the twenty-two)

Every one of findings 1, 2, 3, 4, 6, 8, 10, 11, 12, 13, 15, 16, 18 and all three CI failures is the
same sentence: **I changed a member and not the set it belongs to.** SIXTEEN instances, thirteen
distinct sets, one increment.

Finding 18 is the shape at its most compact. The seal's predicate names two things — *the bill's
status* and *its live version* — and I hung the trigger on the first table only. The set was not
hidden in another file or another phase; it was inside the sentence I had just written. The fix is
one predicate in one function with two thin wrappers, because writing the check twice is the drift
§0 exists to prevent.

Findings 10, 12 and 13 are the sharpest, because they are the same set FIVE TIMES. "Places that
report a verdict" has three members — the verify transition, the idempotency replay, and the read
endpoint. Round 1 fixed the first, round 2 fixed the second, round 3 found the third, and round 4
found the third one's two remaining doors: its fallback and its record branch. Each round I fixed
the member the finding named and left its siblings, in a set with only three members, having
already written this rule down three times.

Finding 12 deserves its own sentence because the set it belongs to was already CLOSED elsewhere in
the same module. `CommercialBillService.evaluateBounds` carries a `countLinesAsLive` parameter,
added by a Task-4 round for exactly this reason: §0 excludes a non-live bill from every billed
fold, so a computation about that bill measures everything except the claim it is judging. §E's
triple is the second computation over the same fold and it did not carry the rule. Not a missing
idea — a missing SECOND SITE for an idea this repository had already had, written down, and shipped.

Finding 11 is the same shape in a different dimension: the duplicate comparison was fixed twice — for
rejected predecessors (round 1) and for tax/freight components (round 2) — while the UNIT of
comparison stayed wrong. A claim is compared per line, so re-partitioning 60 + 40 against 100 hides a
twin. Two corrections to a predicate whose granularity was the actual defect.

The uncomfortable part is that this repository had already named it. The PR #274 audit closed with:

> if a finding names a status, a column, or a layer, the fix belongs to the SET that member came
> from, not the member.

I wrote that sentence, and then violated it fifteen times in the next increment. So the rule is not
wrong, it is **insufficient** — and the reason is worth stating precisely, because it is the whole
value of this audit.

The rule tells you to look for the set *after* you know which member you touched. It does not tell
you how to FIND the set, and in practice the set is invisible from where the edit is made. Opening a
lifecycle arrow in `migration.sql` gives no hint that two other files assert that arrow's old state.
Adding a Prisma model gives no hint that two registries and six TRUNCATE lists exist. The
`evaluateClaimHeads` docblock is the sharpest case: it carries a hand-written enumeration of every
writer of `BILLED_AMOUNT`, added by the PR #274 round-4 correction *precisely* so a new writer would
be visible — and the writer that went missing was the very next one added. **A list only works if
the person adding a member reads it, and the person adding a member is looking at a different file.**

**Closure: derive the set from the system, do not remember it.**

The fix that actually worked this round is the one for CI-c. Rather than appending `BillVerification`
to six TRUNCATE lists, `truncate-closure.test.ts` derives from the Prisma DMMF every table holding a
foreign key into anything the seed truncates, and fails naming `Referrer → Target`. Nothing is
hand-kept, so a table added tomorrow is covered without anyone editing a list or reading a comment.
It was proven RED by removing `BillVerification` from the seed, and it carries its own precision half
— asserting the parsed set is substantial and every name is a real model — so a broken parse cannot
make it pass vacuously.

That is the shape to reach for. Where a set is derivable, derive it. The scoreboard as this PR
leaves it:

| Set | Derived or hand-kept? |
|---|---|
| tables closed under inbound FKs | **derived** (DMMF) — new this PR |
| the §E exception vocabulary (shared const ↔ PG CHECK) | **derived** (`pg_get_constraintdef` compared both ways) — new in round 4 |
| model → owning module | **derived** (DMMF vs manifests) — the boundary test already caught CI-b correctly |
| routes → policy | **derived** (controller reflection) |
| writers of `BILLED_AMOUNT` | hand-kept docblock — *this is the one that failed* |
| places asserting a §F arrow's state | hand-kept across trigger, proof, probe |
| documents asserting the review budget | hand-kept across PR body and packet |

The last three are the honest debt this audit leaves. Two are addressable and one is not:
the §F transition graph could be asserted from one exported table that the trigger, the proof and the
probes all read; the budget figure could be generated rather than typed. The `BILLED_AMOUNT` writer
set is harder — it is "every call site that changes which rows the fold sees", which no schema knows.
None is in 5A's scope, and inventing them here would be the budget mistake this PR was split to
avoid. They are named so 5B and 5C inherit the debt explicitly rather than rediscovering it.

## Root B — a replay is not a recomputation (findings 5, 7)

Finding 5 and its own correction, finding 7, are one idea approached twice and missed twice.

A verification is a JUDGEMENT made at a moment, over a specific claim version, by a specific person.
The first head treated it as a pure function of current state and recomputed it on replay — which is
wrong the instant the judgement CHANGES that state, and §0's live rule guarantees it does: a disputed
claim leaves the fold, so refolding without it answers `matched` over a dispute that actually
happened. The second head recorded the verdict but looked it up by the bill's *current* version,
which fails the moment an amendment lands between the lost response and the retry.

Both are the same misconception: **a replay owes the caller what THAT CALL concluded, not what the
world would conclude now.** Only the original command identifies it, which is why the verdict id is
now the command's `resultRef` and the replay reads it directly.

The general form, and the reason this is a root rather than a bug: any command whose result is a
JUDGEMENT rather than a mutation must persist the judgement and replay it by command identity.
Tasks 5B and 6 both have one — certification and payment approval — and each has the same trap.

## Root D — presence is not provenance (findings 9, 14, 17)

The trigger required a `matched` verdict to exist and did not ask where it came from, so a
maintenance path could insert one and flip the status in two statements — bypassing the §E check the
arrow exists to enforce.

The tempting fix is to re-derive the rate, tax, freight and duplicate checks inside the trigger. That
would be wrong for the reason §0 states plainly: restating a rule at a second site is the drift that
produces findings, because the two copies disagree the first time either changes. §E in PL/pgSQL
would be a second implementation of the verdict, in a language with none of the §0 set definitions.

So the seal is PROVENANCE — the verdict row must have been produced by `commercial.bill.verify`,
which is the four-FK shape Task 2 established for proving a PO line's terms came from the approved
comparison. Forging one now means forging a command-ledger entry, which carries its own seals.

Worth recording because it cost a cycle: the first version of this seal also required the source
command to be `succeeded`, which is UNSATISFIABLE — the trigger fires DURING the verify command,
while its own ledger row is still in flight, so it refused every honest verification. A seal that
can only ever refuse is not a seal, and the probe battery caught it immediately.

**And that unsatisfiability is what made finding 14 possible**, which is the part worth learning.
Having discovered that the ledger row is incomplete at trigger time, I dropped every clause that
depended on it and kept the one that did not — the command TYPE. The result was provenance-SHAPED
without being provenance: any verify-typed command satisfied it, including a spent one whose id was
copied onto a forged row. The correct response to "this cannot be checked HERE" is to ask *where it
CAN be checked*, not to settle for the residue. It is checkable at COMMIT, because `executeCommand`
writes the receipt inside the same transaction — so the seal is now two halves of one rule split by
WHEN each is knowable: the BEFORE trigger checks the type, and a DEFERRABLE INITIALLY DEFERRED
constraint trigger checks `resultRef = verification.id` and `status = 'succeeded'` at commit, with a
UNIQUE on `(projectId, sourceCommandId)` so one command can only ever produce one verdict.

**And finding 17 is the same root a third time, one level DOWN — which is where it stops.** Round 4
bound the verdict to the command's receipt. Round 5 asked what secures the receipt, and the answer
was nothing: `CommandExecution` carries no triggers at all, so the receipt this seal trusts can be
minted `succeeded` with any `resultRef` its author likes. Each round I secured the thing the last
finding named and did not ask what secured THAT.

The floor is the platform kernel, and it was not this PR's to move. Fifteen `sourceCommandId`
columns across Phases 3, 4 and 5 cite the same table, so sealing it inside a commercial PR would be
the same mistake one level up — a change every merged phase depends on, buried where its reviewer
is looking at §E. It shipped as its own PR — #277, merged at `5b0a54a` — and this branch now rests on it. That is
the general lesson worth more than the fix: **a provenance chain is exactly as strong as its floor,
and the floor is usually in someone else's module.**

Worth recording what that cost, because it is an argument for finding the floor EARLY rather than a
reason to avoid looking: #277 was one trigger and took three review rounds and eight findings of its
own. Two of those (the diagnostic diverging from the trigger; a guard that was itself a no-op) are
roots this branch inherits as review questions, and one of them found a latent bug nobody was
looking for — a backticked word inside an unquoted heredoc that had been executing on every
upgrade-proof run since it was written.

## Root E — a workaround outlived its cause (finding 19)

Round 3 found the read refolding without the claim it was reporting on, and I fixed it by preferring
the RECORDED verdict. Round 4 found the actual cause — the fold excluded the subject claim — and
fixed that. Nobody went back and asked whether the round-3 workaround was still needed.

It was not, and worse, it had become a defect of its own in the opposite direction: a recorded
exception could never be neutralised by later live evidence, because only a status change could
displace it. So finding 19's fix DELETES code. The read returns to §E's own opening sentence —
derived, never stored — and the record stays what it always should have been: the replay's answer
and history.

The rule this leaves behind: **when a finding turns out to have a deeper cause, revisit the shallow
fix.** A workaround is justified by the thing it works around; once that is gone the workaround is
just unexamined behaviour, and unexamined behaviour is where the next finding lives. Worth carrying
into 5B and 5C explicitly, because this increment has now produced several fixes-to-fixes and every
one of them is a candidate.

## Root C — a packet that contradicts the diff (finding 6)

Finding 6 is small as a defect and large as a signal. The PR body carried the `justified-large` marker
and its matrix; the packet still said "within the 20-file / 1,500-line budget" because it was written
when 5A was 14 files and never revisited.

A stale number is a mistake. A packet asserting a GATE WAS CLEARED when it was not is a document that
makes review worse than no document, because a reviewer who trusts it stops checking. The packet now
states the real figures and breaks the diff into what is implementation surface (~740 lines) and what
is its evidence and mandated carry-forward (~965), so the justification can be checked rather than
taken.

Closure: this is Root A again — the set is "documents asserting the same gate", currently two members
and hand-kept. Recorded in the table above.

---

## What this PR got right, and should not be re-litigated

**The split itself.** Task 5 was 2,333 lines before its controller, tripwires or a single probe. The
external review directed a split and it was the right call: 5A found eight findings in ~740 lines of
implementation, which is a density that would have been unreadable at 3,500.

**`BillVerification` as one structure for two findings.** Findings 2 and 5 arrived as separate
comments — a missing DB seal and a broken replay — and are one sentence: a status is the shadow of a
fact. Solving them together produced a smaller change than solving them apart would have.

**Refusing to reach for `CASCADE`.** CI-c would have gone away instantly with `TRUNCATE ... CASCADE`.
It would also have deleted rows nobody declared and hidden every future instance of the same coupling.

## Gate results at the convergence head

| Gate | Result |
|---|---|
| Focused probe suite `phase5-t5a-verification.test.ts` | **29/29** — 18 of them the round-1..5 findings, each RED before its fix |
| `pnpm check` | EXIT 0 — web 543/543, API 722/722 |
| Full integration suite, pristine migrated DB | **77 files / 813 tests**, confirmed independently by CI |
| `upgrade-proof.sh` | PASSED — the verified arrow refused without a verdict and accepted with one, the verdict unrewritable, a self-contradicting verdict rejected, `certified` and beyond still closed |
