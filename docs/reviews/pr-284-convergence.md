# PR #284 convergence audit — Phase 5 Task 5C

Two finding-bearing heads: `0e9de59` (six findings) and `7c16afd` (eight). This
audit is due because the second head crossed the threshold, and it is written
before the third head rather than after it.

## The signal, stated plainly

Round 2 returned MORE findings than round 1, and four of the eight were on code
round 1 had just added. That is the same signature that ended PR #279 — "each
correction adds review surface faster than review retires it" — and the standing
instruction at that point is to escalate rather than push another head. I did,
and the owner chose to split.

Two of round 2's findings were about my own EVIDENCE, and checking them found the
problem was wider than the reviewer said.

## Root A — a rule reaching the artifact it creates, not the sibling already there

Named before this task, and it produced four findings across the two rounds.

| Head | Instance |
| --- | --- |
| R1 F1 | widened the DB arrow `paid → verified`; left the service guard at `=== 'certified'` |
| R1 F4 → R2 | locked the certificate in the withholding bound; left the release bound counting without a lock |
| R2 | guarded ENTERING `paid` with the fold; left the reverse arrow unguarded |
| R2 | re-read the released total under the bill lock; left the restatement check outside it |

The pattern is sharper than "fix the set, not the member". In each case the fix
had a **twin one step away** — the other side of an arrow, the other end of a
lock, the other half of the same question — and I fixed the side the finding
pointed at. The closure is not another checklist: when a fix names a direction, a
side, or a half, the next thing to write down is what the opposite one is.

## Root B — evidence asserted without checking that it discriminates

New, and mine.

Round 2 flagged two probes that would pass against the defect they claimed to
guard. Checking them found five more of the same shape:

- **five upgrade-proof assertions** referenced a certificate id the script never
  creates. Every one was rejected by a FOREIGN KEY before reaching the CHECK it
  named. They would have passed with every constraint dropped.
- **the concurrency probe** ran two independent transactions through
  `Promise.allSettled`, which does not force both to insert before either
  commits. Whichever committed first made its row visible and the second rejected
  sequentially — which the lock-free trigger also does.

I ran both and saw them pass, and reported them as evidence. Running a probe is
not the same as proving it discriminates.

**The closure is mechanical and is applied in this head:**

1. every hostile-insert group ACCEPTS a coherent row first, in the same fixture
   state, so a rejection that comes from the wrong rule shows up immediately —
   this is what caught the five vacuous assertions when I rewrote them;
2. every concurrency probe holds both writers open until both have written, then
   releases them, and is RED-proved by removing the lock from a live database
   before being restored.

Both proofs were run for this head: with `FOR UPDATE` stripped from the two bound
functions, PROBE 13 and PROBE 14 fail; restored, 17/17 pass.

The owner has asked for the same audit across every phase's upgrade-proof
assertions, since this is a class of defect that leaves no trace when it is
wrong. It is recorded in the STATUS maintenance queue as its own item.

## What the split changed

The §F status derivation and its three seal widenings leave 5C for Task 6, where
`APPROVED` and `PAID` — two of the three folds it reads — actually arrive.

That retires three of round 2's eight findings outright rather than fixing them,
because the code they were about no longer exists here. It also removes the
widenings of unit A's seals entirely: 5C now touches none of them.

The intermediate state is strictly stricter than the finished rule. A deduction
moves `NET_PAYABLE` and §J's `certified-payable`; the stored bill status does not
move at all, so there is no transition to be wrong about, and the "stranded with
no row that can advance it" case cannot arise because the rows that would advance
it are Task 6's too.

**The reason this was not seen at planning time is worth recording.** §H says the
insertion re-derives the status, so I implemented it. What §H does not say — and
what only shows up in the code — is that §F's derivation reads three folds, two
of which do not exist until Task 6. Deriving from one fold made `paid` reachable,
which forced the seal widenings, which needed fold-backed guards, which needed
guards of their own. The plan's task boundary was right and the section boundary
cut across it.

## A postscript, and it belongs to root B

The head that carried the split — `1faa7e8` — left the review packet describing
the design the split had just removed. It still listed the §F derivation and the
two seal widenings among the things this change ships, and its invariant matrix
cited a RED proof for widenings that no longer exist.

That is root B again, one level up. The packet is evidence: it is what a reviewer
reads to know what was checked and how. A packet that overstates what a change
does reads as verified where nothing was verified, in exactly the way an
assertion rejected by the wrong rule does. I corrected it in the following head
rather than leaving it to be found.

The generalisation worth keeping: **when a change removes something, the removal
is not finished until the documents that claimed it are corrected too.** Code and
tests fail loudly when they go stale; prose does not.

## Findings carried into this head

| Round 2 finding | Disposition |
| --- | --- |
| re-check restatement after the bill lock | FIXED — both halves re-read inside the lock |
| serialize the release bound | FIXED — `FOR UPDATE` on the deduction, RED-proved |
| derive status after restating | RETIRED by the split |
| guard `paid → certified` with the fold | RETIRED by the split |
| reject deductions on superseded certificates | FIXED — BEFORE INSERT trigger, with a probe |
| seal status derivation on ledger commits | RETIRED by the split |
| point the upgrade proof at a certified bill | FIXED — the block is anchored where a live certificate stands, and four more vacuous assertions beside it were found and fixed |
| add a barrier to the concurrency probe | FIXED — real barrier, RED-proved both ways |
