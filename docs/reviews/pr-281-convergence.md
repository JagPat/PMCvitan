# PR #281 — architectural convergence audit (Phase 5 Task 5B unit B, §I's override)

Two finding-bearing heads, five findings. Per `CLAUDE.md` this stops being another isolated patch:
it names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `b64d027` | 3 | 2×P1, 1×P2 — the approver never acted; matching ids are not provenance; a probe that described an assertion it never made |
| `d360445` | 2 | 1×P1, 1×P2 — **the grant needed the receipt rule the same correction had just introduced**; the live-grant unique excluded the version |

## The root: a correction creates a new artifact, and the rule it was correcting does not travel

Round 7's P1 said `SodException.sourceCommandId = BillCertificate.sourceCommandId` proves nothing,
because two rows can copy the same stale id. The fix was right: the RECEIPT is the authority, so arm
(c) now requires a `succeeded` `commercial.bill.certify` receipt whose `resultRef` names this
certificate.

Round 7's other P1 was larger — the approver never acted at all — and its fix introduced a NEW
artifact, `SodGrant`. And `SodGrant.sourceCommandId` shipped as a bare FK.

**So round 8's P1 is round 7's P2, one artifact along, and the artifact was created by round 7's own
correction.** I had the rule in my hands, applied it to the row a finding named, and did not apply
it to the row I was inventing in the same edit to satisfy that finding.

This is the identical root `docs/reviews/pr-279-convergence.md` names across six rounds — *fix the
instance the finding names, at the altitude it names it, and the sibling survives* — with one new
and worse property: **the sibling did not pre-exist. I created it.** A checklist asking "where else
does this rule apply?" scans what is already there. It does not scan what this commit is adding.

The mechanical closure, stated as a question to ask of every correction:

> **Does this fix introduce a new row, table, or reference? If so, every seal that applies to the
> thing it replaces or accompanies applies to it too — and the burden is on the correction to say
> why not, in the migration, in words.**

Round 8's `AND EXISTS (... gce ...)` clause carries exactly that sentence in its comment, so the
next reader sees the rule rather than re-deriving it from two other clauses.

## The second root: proving a thing is WELL-FORMED is not proving it is REAL

Round 7's headline P1 deserves its own naming, because every seal in unit A and unit B was working
correctly and the control was still hollow. The exception had: the right rule, an approver with
standing, membership precedence, a `FOR UPDATE` on the standing rows, exactly one row, append-only
storage, a non-blank reason, and command provenance. What it did not have was **anybody's consent**:
`approverId` arrived in the certifier's own request.

Eight seals answering "is this override well-formed?" and none answering "did the authority act?".
The distinction is worth carrying forward because it does not look like a gap — the checks are
detailed, the record is immutable, and the audit trail names a real person who never agreed.

The closure is structural rather than another predicate: the authority's consent is now **their own
authenticated command**, so the record is a second act rather than a claim about a third party, and
there is no field for a certifier to fill in. A rule enforced by the ABSENCE of an input cannot
regress quietly.

## What round 8's P2 taught that a seal could not

The version-blind live-grant unique was an operational deadlock: grant for v1, amend, and the stale
grant blocks every replacement. Fixing it made a defect in the SERVICE reachable — `assertSegregation`
selected `findFirst` over the version-blind scope and compared versions afterwards, so a legitimate
stale+current pair was resolved arbitrarily and a good certification refused.

**A database constraint that changes which states are reachable changes which service paths are
reachable.** The probe found it only because it drove the service rather than the seal; a probe
written at the SQL layer would have passed and left the deadlock in place one level up.

## Probes that passed while proving nothing — the running count

Six now, in this task:

1. the round-1 deadlock probe with a 300 ms sleep;
2. PROBE 13's bound-3 case, refused by the projection seal;
3. R2-F3's inflated row, refused by the per-pair unique;
4. R6-F1's standing race, driving the service (already locked) instead of the seal;
5. R3-F2/F3's and R6-F4's accepted arms, valid only because the check compared copied ids;
6. R8-F1's forged grant, refused by the EXCEPTION's receipt check rather than the grant's.

Every one was caught by RUNNING it against the defect, never by reading it. That is the closure:
*reproduce-first is not "write the probe first" — it is "watch the probe fail for the reason you
named".* A probe that goes red for a different reason is a probe that will go green for a different
reason too.

## Gate results at this head

| Gate | Result |
|---|---|
| `pnpm check` | EXIT 0 — web 543/543, API 724/724 |
| `phase5-t5b-certification.test.ts` | **45/45** on live PostgreSQL |
| Reproduce-first, round 7 | the grant path reverted → the forged-approver certification commits |
| Reproduce-first, round 8 | the grant-receipt clause removed → the forged grant is accepted and the certificate commits; the version dropped from the unique → the amended claim can never be authorised again |
| `upgrade-proof.sh` | PASSED — the grant carries its own approver receipt, reserved and completed in one transaction |
| Full integration, pristine migrated DB | see the PR thread |
