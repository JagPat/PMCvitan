# PR #279 — architectural convergence audit (Phase 5 Task 5B, certification)

Two finding-bearing heads, ten findings. Per `CLAUDE.md` this stops being another isolated patch:
it names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `32b1ca2` | 6 | 2×P1, 4×P2 |
| `bf50d27` | 4 | 4×P2 — **all four the same shape**, and that shape is the subject of this audit |

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

## Gate results at the convergence head

| Gate | Result |
|---|---|
| `pnpm check` | EXIT 0 — web 543/543, API 724/724 |
| `phase5-t5b-certification.test.ts` | **25/25** on live PostgreSQL |
| Reproduce-first, round 1 | lock order → PG `40P01`; the three DB seals reverted → F2/F3/F4 red; SoD + orgs reverted → F5/F6 red |
| Reproduce-first, round 2 | completeness seal removed and the quantity bound neutered → **all four** R2 probes red, the other 21 green |
| Full integration, pristine migrated DB | see the PR body |
| `upgrade-proof.sh` | PASSED — the coherent case is now the COMPLETE act (certificate + evidence + status, one transaction, a non-recorder certifier), which is itself the round-2 seal being precise |
