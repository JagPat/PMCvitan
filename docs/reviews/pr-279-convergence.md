# PR #279 — architectural convergence audit (Phase 5 Task 5B, certification)

Five finding-bearing heads, twenty-four findings. Per `CLAUDE.md` this stops being another isolated
patch: it names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `32b1ca2` | 6 | 2×P1, 4×P2 |
| `bf50d27` | 4 | 4×P2 — all four the same shape: a row seal cannot see an absence |
| `9a482b7` | 6 | 1×P1, 5×P2 — **every one of them the FIX FROM AN EARLIER ROUND, not generalized** |
| `04c110e` | 4 | 1×P1, 3×P2 — the lock order one pair along; two seals unserialized; a read without its predicate |
| `42f1b2b` | 4 | 4×P2 — **the append paths of a rule I had only sealed on the coherence path, and the SQL half of a rule round 3 fixed in TypeScript** |

| # | Head | Sev | What was wrong |
|---|---|---|---|
| 1 | `32b1ca2` | P1 | Bill-before-lots deadlocked against `stock.reverse`, which takes the lot then disputes the bill |
| 2 | `32b1ca2` | P1 | A standalone supersession left `status = 'certified'` with no live certificate |
| 3 | `32b1ca2` | P2 | The acceptance FK proved a row EXISTS, not that it is an `acceptance` on a line this bill claims |
| 4 | `32b1ca2` | P2 | Same on the labour side: a CORRECTION row could be frozen as evidence |
| 5 | `32b1ca2` | P2 | §I read every accepted row on the line while the certificate drew on a subset |
| 6 | `32b1ca2` | P2 | Approver standing read the orgs-owned `Membership` directly |
| 7 | `bf50d27` | P2 | A certificate could commit freezing NO evidence at all |
| 8 | `bf50d27` | P2 | A certificate by the evidence recorder could commit with NO `SodException` |
| 9 | `bf50d27` | P2 | `consumedQty` was never compared with the evidence that exists — freeze 100 against a 1-unit row |
| 10 | `bf50d27` | P2 | `versionId` could name a SUPERSEDED version of its own bill |
| 11 | `9a482b7` | P1 | The round-1 lock-order fix was applied to MATERIAL lots and not to LABOUR measurements — the same deadlock, one evidence family along |
| 12 | `9a482b7` | P2 | The SoD seal accepted an exception for ANY rule |
| 13 | `9a482b7` | P2 | …and from an approver with NO standing |
| 14 | `9a482b7` | P2 | Completeness was `>=`, so the frozen set stayed append-OPEN after the certificate committed |
| 15 | `9a482b7` | P2 | The quantity bound ran on consumption INSERT only — never when the evidence beneath it was withdrawn |
| 16 | `9a482b7` | P2 | The SoD actor set took the ORIGINAL measurement's taker and not the author of a positive CORRECTION |
| 17 | `04c110e` | P1 | The activity/measurement lock PAIR was taken in the opposite order to the correction path |
| 18 | `04c110e` | P2 | The quantity bound counted without locking the evidence row, so two freezes could both commit |
| 19 | `04c110e` | P2 | The LIVE certificate read resolved liveness, then re-read by id without it |
| 20 | `04c110e` | P2 | The SQL standing predicate used `OR` where the orgs rule uses membership PRECEDENCE |
| 21 | `42f1b2b` | P2 | The whole-certificate seal returns early for history, and the append paths read that as "history is unguarded" |
| 22 | `42f1b2b` | P2 | `SodException` had an immutability trigger and NO insert-side seal — a late override, forever |
| 23 | `42f1b2b` | P2 | The DB SoD seal still read `Measurement.takenById` alone — round 3's finding 16, in the other language |
| 24 | `42f1b2b` | P2 | `certified` became reachable and the §J bucket still counted certified claims as awaiting certification |

---

## The root: a row seal cannot see an absence

Findings 7, 8, 9 and 10 are one defect wearing four hats, and round 1 is what created it. Round 1's
findings 3 and 4 said "the FK proves the row exists, not that it is the right row", and I answered
them exactly — `phase5_t5_consumption_evidence_check`, fired per consumption row, proving each row
is the right KIND on the right LINE. That closed the members it named and left the set untouched:

- a row seal fires on INSERT, so it never runs when there are **no rows** (finding 7);
- it validates the row it is handed, so it never asks about the **certifier** (finding 8);
- it proves identity, so it never asks **how much** (finding 9);
- it reads the certificate's bill, so it never asks whether the certificate names the bill's
  **live version** (finding 10).

**A validator that runs per row can only ever answer questions about a row that exists.** Every
question about the certificate AS A WHOLE — is it complete, is it attributable, is it about the
current claim — was structurally unaskable in the place I had put the check, and no amount of
strengthening the row seal would have reached them.

The closure is one deferred function that asks the whole question once:
`phase5_t5_certificate_complete_check(project, certificate)`, fired at COMMIT from `BillCertificate`
AND from `VendorBillVersion` (the claim side can invalidate a certificate without touching it). It
answers all three of the certificate-scoped findings in one place, so a fifth question of the same
kind lands beside them rather than needing a fifth trigger.

This is root A from the 5A audit — *fix the SET, not the member* — at the database layer, and it is
the third consecutive PR in which that root has produced findings. What is new here, and worth
carrying forward, is the DIAGNOSTIC: **when a finding says "this check does not prove X", ask
whether the check is even in a position to prove X.** If the check runs per row and X is a property
of the aggregate, strengthening it is wasted work. Findings 3/4 and 7/8/9/10 are the same finding
asked at two altitudes, and I answered the low one twice.

## Round 3: the same root, now visible as a HABIT

Round 3's six findings are not new subject matter. Every one of them is a fix I had already made,
left un-generalized:

| Round 3 finding | The earlier fix it failed to generalize |
|---|---|
| labour evidence locked after the bill (11) | round 1's material lock-order fix |
| exception ignores its `rule` (12) and its approver's standing (13) | round 2's SoD seal, which checked only that an exception EXISTS |
| frozen set append-open (14) | round 2's completeness seal, written as `>=` rather than `=` |
| no recheck when evidence is withdrawn (15) | round 2's quantity bound, fired from one writer of two |
| correction authors absent from SoD (16) | round 1's draw-based SoD, which took the frozen row's `takenById` |

Three rounds, and the pattern is the same each time: **I fix the instance the finding names, at the
altitude the finding names it, and the sibling instance survives.** Round 1 named lots, so I fixed
lots. Round 2 named "an exception exists", so I checked existence. Round 2 named "covers", so I
wrote `>=`.

A resolution to be more careful will not fix this — it has now failed three times. What is needed is
a MECHANICAL question asked before every correction is pushed, and it has three parts:

1. **What is the SET this finding's subject belongs to?** Lots belong to EVIDENCE, and evidence has
   two families. An exception has a rule, an actor and an approver; checking one of three is
   checking a third of the rule.
2. **Which WRITERS can break this invariant?** A bound checked at one writer is unchecked at the
   others — the shape §G's bounds already have, and the shape I keep failing to copy. Round 3's
   findings 14 and 15 are both this question unasked.
3. **Is the predicate an EQUALITY or a BOUND?** "The certificate rests on the evidence it claimed"
   is an equality. Writing it as `>=` leaves the other direction open, and the other direction is
   where the append attack lives.

Those three questions, asked of every finding, would have produced round 3's six fixes during
round 1. They are the closure this audit leaves — not a list of the sites, which goes stale, but
the question that finds the sites.

## The same root in the EVIDENCE: a packet drifts from the code it describes

Found while waiting on a review rather than by a finding, and it belongs here because it is the
identical shape. Round 3 moved the labour evidence above the bill, and
`docs/reviews/phase-5-t5b-certification-packet.md` went on describing the pre-round-3 order —
measurements at steps 5–6, after the bill at step 3, when the code takes them at step 2 beside the
lots. A reviewer checking the implementation against the packet would have been reading a document
about an order the service no longer used, on the very subject of two P1 findings.

**A description of a rule is a COPY of that rule**, and it drifts exactly like a duplicated
predicate does — for exactly the same reason: the second site is invisible from the first when the
first changes. The three questions above apply unchanged, and the first of them answers this one:
the SET a lock-order fix belongs to includes the document that states the lock order.

## What the convergence gate itself taught

The head that carried this packet correction was refused by `review-scope` with "missing trailer and
packet", and the refusal is correct. `assessConvergence` reads the CURRENT head's commit message and
the CURRENT head's changed files — so past the cap, convergence evidence is not something a branch
acquires once and keeps. Every head must carry it, because every head is the one a reviewer would
land on.

That is the exact-head discipline the `codex-current-head` status already enforces for review,
applied to the audit. A branch is not a state; a head is. Recorded because the instinct that
produced the refused head — "the audit is already on the branch" — is the same instinct that
produces a stale packet: reasoning about history rather than about what is true now.

## Root A pointing outward: a lock order belongs to the system

Finding 1 is the same shape in a different medium. §0b says "the BILL is taken FIRST, before any
foreign row", and I implemented that rule faithfully — inside commercial. But `stock.reverse` locks
the LOT and then disputes the bill, and it was written first and is cleared. Two modules each
following a locally-correct order is a deadlock, and PostgreSQL says so in 2.7 seconds: `40P01`.

**A total lock order is a property of the SYSTEM, not of a module.** The module that arrives later
adopts the established order, and if that costs something it pays it explicitly — here, the lot set
is now chosen from an unlocked read, so the claim is re-derived under the bill lock and a divergence
is a 409 rather than a late lock. Locking the difference late is how the deadlock comes back.

## The gap between a docblock and its code (finding 5)

`assertSegregation`'s own comment said: *"The rows consulted are exactly the ones this certificate is
about to freeze — not every acceptance or measurement on the line."* The code consulted every
positive row on the line. The comment was not aspirational; it was written in the same commit, and
it described the intended design correctly while the code beside it did something strictly larger.

The fix is not "make the loop match the comment" — it is to make the question have ONE answer:
`drawAcceptances` DECIDES the draw, §I READS that decision, and the freeze WRITES it. Three readers,
one decision. When a rule is computed in the writer, every earlier consumer has to approximate it,
and an approximation of a set is a different set.

**Closure: if a docblock states a set, the set should be a value, not a description.**

## Ownership is not about representability (finding 6)

Reading `Membership` directly worked and returned a plausible answer — it just wasn't the owner's
answer, missing the org owner/admin PMC standing the orgs module actually grants. This repository
has stated the rule for three phases: *a read being representable is not the same as it being
legitimate; the OWNER states the rule.* `OrgsParticipant` existed, `commercial.workflowParticipants`
already declared the edge, and I still wrote the query.

The boundary analyzer caught a sibling instance in the same file — `assertSegregation` reading
`StockTransaction` — and the fix there was better than a waiver: the recorder now travels WITH the
evidence the participant already returned, so the second read does not exist to be wrong.

## Four probes that passed while proving nothing

Recorded because it is the discipline this phase keeps rediscovering, and this PR produced four
instances in one unit:

1. **The deadlock probe with a sleep.** 300 ms, then release the holder. It passed against the
   *broken* order, because certification had not yet reached its lock when the holder released. Now
   condition-based (`pg_stat_activity`) with an explicit acquisition signal — and it needed BOTH:
   the poll alone still raced, because session A's transaction callback had not started.
2. **PROBE 13's bound-3 acceptance case**, refused by the projection seal instead of passing.
3. **R2-F3's inflated row**, refused by the per-pair unique instead of the quantity bound.
4. **PROBE 8's SoD message assertion**, matching a string the orgs routing had changed.

(2) and (3) are the 5A round-5 lesson at its next site: *a refusal is only evidence when it comes
from the seal under test.* Both were caught by running the probe rather than reading it.

## What the round-1 correction got right, and why round 2 still happened

Every round-1 fix is load-bearing and each is proven RED against its own defect. The correction was
not wrong; it was **not high enough**. Findings 3 and 4 pointed at two rows, I built the seal those
two rows needed, and I did not ask what else a certificate is. The review-efficiency rule says after
two finding-bearing heads produce this audit — and the reason that rule exists is visible here: the
second round's four findings would all have been closed by the first round's correction if it had
been written at the altitude of the certificate rather than the row.

## Round 5: the root RESTATED as a structural fix, not another correction

Findings 16 and 23 are the SAME finding. Round 3 said "the SoD actor set misses the author of a
positive correction"; I fixed it in `assertSegregation` and left the SQL seal reading `takenById`
alone, and round 5 said it again about the copy I had not touched. Findings 12/13 and 20 are the
same pair one layer along: the standing rule, corrected twice, in the language a finding named.

The three questions above would have caught these — question 1, *what SET does the subject belong
to*, answers all three — and by round 5 that is no longer the interesting observation. **The
questions were written down and the defect recurred anyway.** A checklist is a thing I have to
remember to run, and the evidence of four rounds is that under enough context I do not.

So the closure this round leaves is not another question. It is a structure in which the defect
cannot be expressed:

| Rule | Before | After |
|---|---|---|
| who is an evidence ACTOR | a TypeScript fold in `assertSegregation` **and** an inline `EXISTS` in the seal | `phase5_t5_evidence_actors(project, certificate)` — ONE function; the service `$queryRaw`s the same one the seal calls, over the same frozen rows |
| does the approver have pmc STANDING | `OrgsParticipant.hasProjectRoleStanding` **and** an inline `EXISTS` in the seal | `phase5_t5_pmc_standing` — still two implementations, but NAMED and PINNED by a correspondence probe that drives both over a matrix of standing shapes |
| is this certificate OPEN to new rows | nothing — the coherence seal returned early for history | `phase5_t5_assert_certificate_open`, called by every append path |

The first row is the real fix: there is now no second site to forget, so findings 16 and 23 are not
"fixed", they are **unrepeatable**. A future change to who counts as an evidence actor is one edit
that cannot half-land.

The second row is the honest limit, and it is worth stating precisely rather than papering over.
Standing is ORGS-owned and a PostgreSQL trigger cannot call TypeScript, so a single authority is
not available at any price I am willing to pay — moving the rule into SQL would put an orgs rule in
a commercial migration, which is finding 6 again in a different medium. What IS available is to
make the drift MECHANICAL to detect: name the predicate so it can be called in isolation, then
assert cell-by-cell that it agrees with the owner's method on every shape that separates them,
including the two that produced finding 20. Whichever copy changes next, a test fails.

**The general form: when a rule has two implementations, either collapse them to one CALLED site,
or pin them with a test that fails on divergence. "Be careful to update both" is not a third
option — it has now failed four times.**

## Round 5's other half: a seal that answers one question is not answering the other one

Findings 21 and 22 are the append-closure, and they have the same shape as findings 7–10 — a
question that was structurally unaskable where I had put the check — but with a twist worth
recording, because the early return they exploit is CORRECT.

`phase5_t5_certificate_complete_check` returns early for a superseded certificate deliberately: a
superseded certificate is history, the claim beneath it has legitimately moved on, and re-validating
it against today's world would refuse the very correction §F requires. That reasoning is sound. What
was wrong is that "we do not re-validate history" was silently doing duty as "history needs no
guard", and the append paths inherited the second sentence from the first.

They are two different questions at two different altitudes:

- **coherence** — does this certificate agree with the world as it is now? Only a LIVE certificate
  must, and history is exempt.
- **append** — may this row join this certificate at all? EVERY certificate, forever, because what
  an act rested on is not editable afterwards.

Question 2 of the three (*which WRITERS can break this invariant*) finds finding 22 immediately:
`SodException` had an immutability trigger and no insert-side seal, so it was a writer of the §I
invariant that nothing was asking. Finding 21 needs the altitude distinction as well as the writer
question — which is why the closure is a NAMED function (`phase5_t5_assert_certificate_open`) rather
than a line copied into two triggers.

## Gate results at the convergence head

| Gate | Result |
|---|---|
| `pnpm check` | EXIT 0 — web 543/543, API 724/724 |
| `phase5-t5b-certification.test.ts` | **39/39** on live PostgreSQL |
| Reproduce-first, round 1 | lock order → PG `40P01`; the three DB seals reverted → F2/F3/F4 red; SoD + orgs reverted → F5/F6 red |
| Reproduce-first, round 2 | completeness seal removed and the quantity bound neutered → **all four** R2 probes red, the other 21 green |
| Reproduce-first, round 3 | the four DB fixes and both service fixes reverted → **all five** R3 probes red (F2/F3 share one), the other 25 green |
| Reproduce-first, round 4 | the lock order, both `FOR UPDATE`s, the read predicate and the precedence guard reverted → **all four** R4 probes red |
| Reproduce-first, round 5 | the append-closure neutered, the `SodException` seal made a no-op, its unique index dropped, `phase5_t5_evidence_actors` reverted to `takenById` alone and `phase5_t5_pmc_standing` to an `OR` → **all four** DB-side R5 probes red, each for its own reason; the §J split reverted separately → R5-F4 red |
| Full integration, pristine migrated DB | see the PR body |
| `upgrade-proof.sh` | PASSED — the coherent case is now the COMPLETE act (certificate + evidence + status, one transaction, a non-recorder certifier), which is itself the round-2 seal being precise |
