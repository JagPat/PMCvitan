# Phase 5 Task 5B unit C — §J `certified-payable`

Base: `main` `b49403f` (unit B, PR #281, merged after a fresh clean Codex +1 on
the exact head `f626808`).

## Vision alignment

The spec's §16 cash forecast asks one question a construction practice cannot
answer today: *of the money this project owes, how much has somebody with
authority actually agreed to?* Units A and B built the act that answers it — the
certificate, its frozen evidence, and the segregation rule with its attributable
override. This unit is the reading. It adds the §J bucket a certificate moves
money into, so a PMC looking at a cost head can see the difference between a
vendor's claim and a certified obligation.

The whole of unit C is one sentence: **certification settles who owes what, not
how much.** A certificate creates no exposure — the money was already on the
project the moment the claim was recorded. Certifying moves it from
`awaiting-certification` into `certified-payable` and leaves the total alone.

This ships no schema, no migration, and no new command. It is a read over facts
units A and B already cleared.

## What is in it

1. **`CommercialBillQuery.certifiedAmountFor`** — `CERTIFIED(poLine)`, folded in
   the same owned place as every other billed set. It reads the CERTIFICATE, not
   the claim lines of a certified bill (see PROBE 3 for why that distinction is
   load-bearing), counts a certificate only while it is live *and* still names
   the live claim version, and attributes the bill-scoped amount to each cost
   head by the line's share of the version it certified.
2. **`certifiedPayable` on the position and the DTO** — and
   `awaitingCertification` becomes the residual `BILLED − CERTIFIED`, which is
   what §J's table already says every other bucket is (`received-not-billed` is
   received − billed; `approved` is `APPROVED − PAID`).
3. **The §B mover obligation** — `certify` and `supersede` now discharge
   raise-or-clear in their own transaction, through the same public
   `evaluateHeadsForBill` verification uses.
4. **The closure that made 3 due, applied to the whole set** — `FOLD_INPUTS`
   gains `CERTIFIED` *and* `BILLED_AMOUNT`, and a second pin derives the
   bill-side set from the fold's actual `this.bills.*` calls.

## §J is the definition, evaluated against the facts that exist

§J defines `certified-payable` as `NET_PAYABLE − APPROVED`. Neither subtraction
exists yet: `NET_PAYABLE` is the certificate less unreleased deductions and the
§H ledger is 5C's; `APPROVED` is Task 6's. Both are the identity at this tree.

This is stated rather than hidden because the distinction matters to a reviewer:
the term shipped here is the full definition applied to the facts that exist, in
the same way `MEASURED` and `BILLED_AMOUNT` arrived in this fold — each landing
with the fact that supplies it. It is not a placeholder that 5C replaces. 5C
subtracts into it; Task 6 subtracts into it again.

Unit B deliberately shipped no `netPayable` field for the same reason, and that
decision is unchanged here: reporting a gross figure under a name §G defines as
net would be an answer rather than a question.

## The one probe that can tell two implementations apart

§G bound 3 is `CERTIFIED <= BILLED_AMOUNT(bill)` — a BOUND, not an equality.
`certify` writes the full amount today, so a fold that summed a certified bill's
LINES would agree with every other probe in this file while reading the wrong
fact, and would report the vendor's number as though a certifier had allowed it
the day a partial certification is written.

PROBE 3 writes a legal partial certificate directly (₹60 against a ₹100 claim,
carrying the same frozen evidence, in one transaction because unit A's
status↔certificate correspondence is a deferred constraint) and asserts the
bucket reports ₹60. Without it this file would pass over a fold that never reads
a certificate at all.

The disallowed ₹40 stays in `awaiting-certification` by the residual rule. It is
still exposure: the vendor claimed it, and a disallowance nobody has settled with
them is not money that has left the project.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | none new — no route, no command, no policy change; the read is the existing `commercial.budget` under `commercial.read`, and every fold filters on `projectId` | full integration suite on a pristine DB; `pnpm check` |
| civil-time-lifecycle | a certificate must stop counting when superseded, and must not outlive the claim version it certified | PROBE 1 (supersede returns the money to `awaiting-certification`); the fold matches a certificate to the LIVE version, not merely to its bill |
| concurrency-idempotency | none new — no new write path; the two evaluations run inside the existing `certify`/`supersede` command transactions, once each, at the end | PROBE 5; `commercial.contract.test.ts` "a multi-mutation act evaluates ONCE" |
| data-integrity-conservation | **the whole of this change.** A new bucket that ADDS rather than MOVES would double-count every certified rupee — the exact defect §J's residual rule exists to prevent, and one two earlier revisions of that section shipped | PROBE 1 and 2 assert the bucket pair AND the unchanged total; PROBE 4 proves a certificate is shared across the heads its claim spans, never counted whole on each; PROBE 3 proves the number comes from the certificate |
| offline-reconciliation | not applicable — no client surface | — |
| ui-server-parity | the DTO gains one field; no UI consumes it yet (§M frontend is Task 7) | `pnpm check` web 543/543 |

## Evidence

Reproduce-first, `apps/api/test/integration/phase5-t5c-payable.test.ts` — 5/5
GREEN here.

**RED at `b49403f`: 4 of 5.** PROBES 1–4 fail (`expected undefined to be …` —
the bucket does not exist). PROBE 5 PASSES at the base, and that is reported
rather than rounded up: it asserts certification is exposure-neutral and opens no
exception, which is true at the base for the trivial reason that nothing there
reads a certificate. What pins the §B mover call is the contract test, and its
RED proof was run directly: removing `evaluateHeadsForBill` from `certify` fails
`commercial-certification.service.ts#certify evaluates — it writes
commercial.CERTIFIED`, and removing `readVia: 'certifiedAmountFor'` fails
`FOLD_INPUTS covers every bill-side fold the budget query reads`. Both were
observed RED and restored.

| Gate | Result |
| --- | --- |
| `pnpm check` | EXIT 0 — web 543/543, API 731/731 (+7: the new bill-side pin and six writer tests) |
| full integration, pristine migrated DB | see PR body |
| `upgrade-proof.sh` | not applicable — no migration, no schema change |
| `test:e2e:api:allmodules` / `:outbox` | see PR body |

## What this unit does NOT do

- No `netPayable` (§G bound 4 needs the §H ledger — 5C).
- No `approved` or `paid` bucket (Task 6).
- No deduction, release, or approval path.
- No change to `certify`'s amount: it remains `BILLED_AMOUNT(bill)`. Bound 3
  stays a bound, and no equality CHECK was added — one would refuse the partial
  certification §G explicitly permits.
