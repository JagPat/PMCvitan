# PR #276 — architectural convergence audit (Phase 5 Task 5A)

Three finding-bearing heads, eleven Codex findings, and three CI failures that were the same defect
class arriving through a different door. Per `CLAUDE.md`, this stops being another isolated patch:
it names the ROOT they share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `76eda23` | 5 | 2×P1, 3×P2 |
| `26af605` | 3 | 1×P1, 2×P2 — two of them the round-1 fixes, one level short |
| `d4d9773` | 3 | 1×P1, 2×P2 — one of them root A a THIRD time on the same set |

Plus, on the way: `upgrade-proof` and the `api` suite failed on `bd351e9`, and `api-e2e` failed on
`3e2e8d4`. Neither was a flake. Both belong in this audit because they are the same root.

---

## The fourteen

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

---

## Root A — the member, not the set (eleven of the fourteen)

Every one of findings 1, 2, 3, 4, 6, 8, 10, 11 and all three CI failures is the same sentence: **I
changed a member and not the set it belongs to.** ELEVEN instances, ten distinct sets, one increment.

Finding 10 is the sharpest, because it is the same set THREE TIMES. "Places that report a verdict"
has three members — the verify transition, the idempotency replay, and the read endpoint. Round 1
fixed the first, round 2 fixed the second, round 3 found the third. Each round I fixed the member the
finding named and left its siblings, in a set with only three members, having already written this
rule down twice.

Finding 11 is the same shape in a different dimension: the duplicate comparison was fixed twice — for
rejected predecessors (round 1) and for tax/freight components (round 2) — while the UNIT of
comparison stayed wrong. A claim is compared per line, so re-partitioning 60 + 40 against 100 hides a
twin. Two corrections to a predicate whose granularity was the actual defect.

The uncomfortable part is that this repository had already named it. The PR #274 audit closed with:

> if a finding names a status, a column, or a layer, the fix belongs to the SET that member came
> from, not the member.

I wrote that sentence, and then violated it nine times in the next increment. So the rule is not
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

## Root D — presence is not provenance (finding 9)

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
| Focused probe suite `phase5-t5a-verification.test.ts` | **21/21** — 11 of them the round-1..3 findings, each RED before its fix |
| `pnpm check` | EXIT 0 — web 543/543, API 722/722 |
| Full integration suite, pristine migrated DB | **77 files / 813 tests**, confirmed independently by CI |
| `upgrade-proof.sh` | PASSED — the verified arrow refused without a verdict and accepted with one, the verdict unrewritable, a self-contradicting verdict rejected, `certified` and beyond still closed |
