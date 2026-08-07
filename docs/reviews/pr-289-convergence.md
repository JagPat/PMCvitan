# PR #289 convergence audit — Phase 5 Task 6B unit i

Two finding-bearing heads (`392b46f`, `36362e1`) trigger the convergence rule, and
the rule is explicit that the next head must be an architectural audit rather
than another isolated patch. This is that audit.

## The findings, in one table

| # | Source | Head | P | Finding |
|---|---|---|---|---|
| 1 | Codex | `392b46f` | P1 | The DB opened every in-family transition without checking the folds — `UPDATE "VendorBill" SET status='paid'` on `APPROVED = PAID = 0` committed |
| 2 | Codex | `392b46f` | P1 | No backfill: bills 6A legitimately left at `certified` with live approvals stayed stale |
| 3 | Codex | `392b46f` | P2 | `commercial.payments` read status and folds outside one snapshot |
| 4 | Codex | `392b46f` | P1 | A valid fold row could be appended without moving the status |
| 5 | JagPat | correction | P2 | `DERIVED_BILL_STATUSES` restated the shared `BILL_STATUSES_PAST_CERTIFICATION` |
| 6 | JagPat | correction | P1 | `BillCertificate` — a fold input — was missing from the seal set |
| 7 | JagPat | `36362e1` | P1 | The backfill and the seal were not atomic w.r.t. the old container |
| 8 | Codex | `36362e1` | P1 | The cutover lock relied on an implicit transaction |
| — | self | in-branch | — | Lock-order inversion (5C PROBE 14 deadlock); wrong lock mode; a global `DISABLE TRIGGER`; a probe that proved nothing; `SELECT count(*) … FOR UPDATE` that passed by erroring |

## Root A — a hand-written list standing in for a derived set

Findings 1, 4, 5 and 6 are one root. Each time, the code wrote down the members
instead of deriving them from what the fold actually reads:

- **1** enumerated the FAMILY in SQL and left the MEMBER to the service.
- **4** sealed the bill and not the tables that feed it.
- **6** then enumerated *five* of the six fold tables. `BillCertificate` supplies
  `certifiedAmount` to `NET_PAYABLE` and the `supersededAt IS NULL` predicate that
  decides which approvals are in `APPROVED`, and `certify`/`supersede` are two of
  this unit's own six declared movers — so the table that was missed was named in
  the unit's own mover list.
- **5** restated four status members the shared contract already declared, in a
  file whose comments claimed one family definition, while the shared declaration
  carried a note saying Task 6 would need it.

The migration's original comment argued that putting §F's arrows in SQL would
create a second copy of the truth table free to disagree. That reasoning was
backwards: the second copy already existed as
`phase5_t6b_derived_bill_status`. The question was never *how many copies* but
*which question the database is allowed to answer* — and answering only the
coarse one left the fine one enforced nowhere.

**This repository already knows the answer.** §B's `FOLD_INPUTS` derives its
mover set from what the fold READS, precisely because a hand-kept list of six
sites had already gone stale once (Task 2, round 3, three movers missed). Task 6B
re-made that mistake three times in one unit.

### Mechanical closure A

`commercial.contract.test.ts` now derives the seal set instead of trusting a
list: it reads the tables the three fold queries actually reference in
`commercial-deduction.query.ts`, and requires each one to carry a
`_t6b_status_sealed` constraint trigger in the migration. A seventh fold input
added to a query without a seal fails at the desk, with no database and no
reviewer required. The status family is pinned by **identity** (`toBe`, not
`toEqual`) to the shared array, so a same-members copy still fails.

## Root B — a guarantee asserted in prose instead of exercised

Findings 3, 7 and 8, and every one of the self-inflicted defects, are the other
root: a claim written into a comment or a packet that no test ever ran.

- **7** is the sharpest instance, because the false claim was in this PR's own
  packet: *"the backfill is not a courtesy; it is what makes the seal
  installable."* That sentence treats the backfill and the seal as one moment.
  They are two, `docs/DEPLOY.md` says the old container serves between them, and
  nothing tested the gap.
- **8** is the same shape one layer down: the barrier's comment asserted "Prisma
  wraps migrations in a transaction, and the dependency fails closed". The review
  disputed the premise. The premise turned out to be TRUE for the pinned runtime
  — checked, not argued — but that is not the point: it was a property of a
  dependency, stated in prose, tested by nothing.
- **3** was a read whose two halves were never shown to be one instant.
- The **wrong lock mode** (`SHARE ROW EXCLUSIVE` does not conflict with
  `ROW SHARE`) was asserted in a comment and would have closed nothing.
- **R1-F3's first draft** asserted internal consistency over 25 serial reads —
  green against the very head it was written to indict.
- The proof script's own first drafts parked the held-back migration *inside*
  `prisma/migrations` (so it was applied anyway) and used
  `SELECT count(*) … FOR UPDATE`, which PostgreSQL rejects — meaning the "writer
  was blocked" branch would have passed *because its own SQL was invalid*.

Every one of these was caught by running something, and none by re-reading.

### Mechanical closure B

Three practices, all now in the tree rather than in a resolution:

1. **A claim about a dependency is proven on the dependency's own path.**
   `scripts/phase5-t6b-production-runner-proof.sh` runs the real
   `prisma migrate deploy` — `upgrade-proof.sh` cannot, because it applies
   migrations with `psql --single-transaction` and so supplies the very
   transaction under question.
2. **A barrier probe has two halves.** R1-F6 checks the barrier is in the
   migration and precedes both the backfill and the first trigger (RED when the
   line is deleted) *and* that it actually excludes the movers. The wrong lock
   mode passed the first half and failed the second, which is exactly why the
   halves are separate.
3. **An acceptance is evidence only when the state moved.** The upgrade-proof
   arrow helper asserts the bill stood at `from` and reached `to`; the runner
   proof reports "UNPROVEN" rather than passing when it cannot establish an
   overlap. This is the mirror of the rule this repository already applies to
   rejections.

## What did not change

Tasks 5C, 6A and 5B are not reopened. Eleven pre-existing fixtures were updated —
seven upgrade-proof assertions, three 5C probes, one 6A probe — and every one is a
raw write that moved a fold and left the status behind, which is the state finding
4 asked the database to refuse. No rule under test was weakened; each fixture now
does the whole of what its real command does.

## A postscript this audit earned the hard way

The head that first carried this audit (`0dfb09f`) satisfied the convergence gate.
The next head (`fbbae44`) did not — it added the browser-gate numbers to the
packet and carried no `Review-Convergence` trailer, so the gate reported "missing
trailer and packet" on a branch where both had already landed.

That is root B one more time, in the shape of process rather than code: I knew
the gate reads the trailer *and* the changed-file set from the head commit — the
same lesson an empty commit taught earlier in this loop — wrote that constraint
into my own check-in note, and then pushed a head that broke it. A rule recorded
somewhere other than where it is enforced is a rule that gets missed.

The mechanical form of the lesson, for whoever picks this branch up: **once a
convergence trailer is required, every subsequent head needs it**, and the head
must also touch a `docs/reviews/*convergence*.md` file. Amending the packet
without the audit is not enough.

## The test if this recurs

If a further finding in this unit is of root A's shape — a member missing from a
set — the correction is not a seventh trigger. It is to make the set *derived* at
the point the next reader would look, the way `FOLD_INPUTS` already is.
