# Platform — seal the command receipt protocol

## Why this is its own PR

Phase 5 Task 5A (PR #276) built a §E provenance seal: a vendor bill is `verified` only when a
MATCHED verdict exists whose `sourceCommandId` names a SUCCEEDED `commercial.bill.verify` execution
whose `resultRef` is that verdict. Codex's round-5 P1 pointed at the floor underneath it:

> those fields are still freely writable on `CommandExecution`. A maintenance SQL path can … insert
> a fresh `commercial.bill.verify` receipt already `succeeded` with `resultRef` equal to a
> hand-inserted `matched` `BillVerification` … this predicate passes even though
> `commercial.bill.verify` never ran.

Verified, and worse than one task's problem: `CommandExecution` carries **no triggers at all** —
only indexes, FKs and two CHECKs — while **fifteen `sourceCommandId` columns** across Phase 3's
stock ledger, Phase 4's labour facts and Phase 5's commercial documents cite it to answer *which
command produced this fact*. Every one of those provenance seals is exactly as strong as the
receipt behind it.

Sealing this inside PR #276 would have made the same mistake one level up: a platform-kernel
change, affecting every merged phase, buried in a commercial PR — and pushing an already
over-budget unit (26 files, 2,804 lines, five finding-bearing heads) further past its limit. So it
ships once, here, for every fact that cites a command. PR #276's round-5 head then rests on it.

## What ships

**One trigger, no runtime change, no schema change.** `executeCommand` has exactly two writers in
the entire API — the `reserved` insert and the completing update — with no raw SQL, no second
creator and no delete path. The migration makes PostgreSQL enforce the protocol the code has always
followed:

| Rule | Why it is not merely tidiness |
|---|---|
| INSERT only as `reserved`, with no result and no completion time | A receipt records that a command RAN. Minting one already terminal records a command that never did — and with a chosen `resultRef` it is provenance for anything |
| Identity frozen (`scopeKind`, org, project, actor, `commandType`, key, `requestHash`, `createdAt`) | The replay lookup and every provenance join read these. A rewritable identity re-points a real receipt at a different actor or command after the fact |
| `reserved` completes exactly once, to `succeeded` or `failed`, recording WHEN | One direction, one time. A receipt that can return to `reserved` can be completed twice with different results |
| The completion comes from the SAME transaction that reserved | Phase 2 states the protocol as reserve→execute→receipt in ONE transaction, so a completion arriving later did not come from a command run. Without it, a receipt reserved at any point in the past can be adopted and completed against a result chosen afterwards |
| A completed receipt is immutable | A re-pointable `resultRef` is a re-pointable provenance chain — the same defect as forging the row |
| A `failed` receipt carries no result | A result reference on a failed command is provenance for something that did not happen |
| A `succeeded` receipt carries a NON-BLANK result | The converse half, missing from the first head. `ExecuteResult.resultRef` is a required `string` and every command site returns an entity id, so this is the type system's rule where the database can hold it. Left open, a succeeded receipt with no result SUPPRESSES the retry that would have produced the entity — the replay path returns `prior.resultRef ?? ''` — and hands the caller success with nothing in it |

**DELETE stays permitted, deliberately.** Phase 2 decided in as many words that receipts are
"disposable idempotency records, not an immutable audit trail", and gave both tenant FKs
`ON DELETE CASCADE` so a hard org or project delete takes its receipts with it. Banning DELETE
would contradict a cleared decision and break that cascade — and buy nothing, because deleting a
receipt cannot forge provenance, only remove it, so every join then FAILS CLOSED. Where a fact must
outlive its receipt, the fact says so itself: citing rows hold `ON DELETE NO ACTION` composite FKs,
so PostgreSQL already refuses to delete a receipt something rests on.

**`failed` stays reachable** although nothing writes it today. The status vocabulary is a cleared
Phase-2 decision and a rollback records a real outcome; closing the arrow would seal out a state
the schema documents.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | None — no new surface, no policy change. The seal constrains a table, not a caller | Tenancy is unchanged: the scope truth table, both composite tenant FKs and the scope-specific partial unique indexes are untouched, and the upgrade proof re-asserts all four |
| civil-time-lifecycle | A new one-way lifecycle on an existing table could refuse a legitimate transition | The only legitimate transition is `reserved → {succeeded, failed}`, which `executeCommand` performs; the probe suite asserts BOTH directions of every rule — each forgery refused AND the honest operation accepted — and one probe drives a real keyed command end to end plus its replay |
| concurrency-idempotency | The ledger IS the idempotency mechanism; a seal that broke completion would surface as double execution | The e2e probe runs a real command twice under one key and asserts exactly one receipt and exactly one decision. The reserve/complete pair is inside one transaction, so a BEFORE-row trigger adds no new lock and no new failure mode |
| data-integrity-conservation | The forgery this exists to stop, and legacy rows | Six hostile shapes refused (mint-as-succeeded, pre-loaded result, re-pointed result, re-opened terminal, mutated identity, failed-with-result), each RED against `main` before the trigger. The migration reads and rewrites nothing, so a legacy database upgrades untouched |
| offline-reconciliation | None — no client surface | — |
| ui-server-parity | None — no UI, no contract change | — |

## What this does NOT close — stated because the first head overclaimed

The review was right and this is the correction. **No database trigger can distinguish "the
application ran" from "SQL that reproduced what the application would have written."** Someone with
INSERT/UPDATE on this table can always perform the protocol by hand inside one transaction, and
nothing here prevents it. That is the trust boundary every trigger-based seal in this repository has
always had; it is written down now because this is the table the others rest on.

What the seal does is make the protocol's shape the ONLY representable shape — no minting a
terminal row, no backdating, no re-pointing a result, no rewriting identity, no adopting a stale
reservation. Those are the shapes a bug, a careless maintenance UPDATE or a future path that
bypasses `executeCommand` actually produce, and each was one statement away before.

The remainder is a **privilege** question, not a trigger question: the role used for maintenance
and migrations should not be the role the application runs as, and only the application role needs
INSERT/UPDATE here. Where the deployment uses a single role today, that is the gap — recorded in
`docs/RUNBOOK.md §CMDR.2`, and it applies to every provenance seal in the system rather than only
this one.

## Legacy databases — the diagnostic ABORTS

The first head only raised a NOTICE on the two incoherent shapes (`succeeded`/`failed` with no
`completedAt`; `failed` carrying a `resultRef`), reasoning that neither could satisfy a provenance
seal falsely. **That reasoning was wrong**, and it is the more instructive of the two corrections:
§E's join reads `status = 'succeeded'`, `commandType` and `resultRef` — it never reads
`completedAt`. So a pre-existing hand-written `succeeded` receipt with a chosen `resultRef`
validates a hand-written verdict the moment the seal is installed, and a seal installed over rows
it never checked is worse than none, because everything downstream then reads as verified
provenance.

The diagnostic now runs BEFORE the trigger is created (so a repair is not blocked by the seal) and
ABORTS, naming both counts and pointing at `docs/RUNBOOK.md §CMDR`.

**The repair is DELETE, never invention.** Nobody knows when a receipt with no completion time
completed. Deleting makes the row non-authoritative, and it is self-diagnosing: DELETE is permitted
on this table, every citing row holds an `ON DELETE NO ACTION` composite FK, so PostgreSQL removes
a receipt nothing rests on and REFUSES one a fact depends on — which tells the operator they have
found a fact resting on a receipt no command produced.

`apps/api/scripts/command-receipt-abort-proof.sh` drives all of it on throwaway databases: each
shape planted independently, the migration aborting with the trigger NOT installed and the
migration NOT recorded as applied, the `migrate resolve --rolled-back` + `deploy` sequence, and the
refusal for a receipt an `ApprovedSkillSubstitution` cites. **The proof found two defects in its
own subject**: §CMDR omitted the `resolve` step (without which the redeploy is refused, exactly as
in production), and the first shape-C fixture silently failed to create its citing fact — which
would have made the refusal assertion pass while proving nothing.

## Fixtures that had to change, and what that says

**Ten sites** minted `succeeded` receipts directly, and after the same-transaction rule was added,
each also had to perform the completion inside the reserving transaction — seven integration-test helpers across Phases
3, 4 and 5, and three inserts in the upgrade-proof's legacy chain. Each now reserves and completes,
like every real command.

Worth recording rather than hiding: those fixtures were performing exactly the forgery this seal
refuses. They did it innocently — to satisfy a NOT NULL `sourceCommandId` while reaching some other
constraint under test — but the fact that the shortest path to a valid-looking receipt was to mint
one is the finding in miniature. It is also why the first count in this section said *three*: the
grep that found them was truncated by `head`, and the real number only surfaced when the full suite
ran and 58 tests failed. Both numbers are left visible here rather than quietly corrected.

## A proof that passed while proving nothing

The upgrade-proof's new assertions were first placed at the point in the file where the other
`CommandExecution` checks live — which is 250 lines ABOVE where `assert_rejects` is defined. Bash
printed `assert_rejects: command not found` to stderr, never set `FAIL`, and the script reported
**PASSED** with five of its eight new assertions having done nothing at all.

That is the precise failure this script exists to prevent, turned on itself, and it would have gone
unnoticed if the summary had not been read line by line. Two fixes, and the second matters more than
the first: the block moved below the definition, and `command_not_found_handle` now prints a named
`FAILED` and sets `FAIL`. A misspelled or not-yet-defined helper can no longer vanish into a green
run — for this PR or any future one.

## Gates

- Focused `platform-command-receipt.test.ts` **10/10** on live PostgreSQL — the refusal probes proven
  RED against `main` with the migration removed and the database rebuilt from scratch (the
  acceptance probes pass in both states, which is what makes them the precision half)
- `command-receipt-abort-proof.sh` PASSED — both abort shapes, the documented repair, and the
  refusal that makes it safe
- `pnpm check` **EXIT 0** — web 42 files/543 tests, API 56 files/718 tests, builds clean
- Full integration suite **77 files / 810 tests** on a pristine migrated database
- `upgrade-proof.sh` PASSED with all eight new assertions actually executing (see above): the six
  refusals plus the honest reserve → complete → result accepted over the legacy fixture
- One additive migration; every earlier one byte-for-byte unchanged. No `schema.prisma` change —
  the protocol is not Prisma-expressible, the same accepted-drift convention Phase 2 used for this
  table's partial indexes and CHECKs
