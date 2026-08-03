# Phase 5 Task 4 — the §F vendor bill and the §G conservation bounds 1–2

**Base:** `main` `5dc70c1` · **Branch:** `claude/phase5-task4` · **Plan:**
`docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md` (§F and §G carried into it
VERBATIM from `claude/phase5-planning` `a4d469b` by this PR, per the plan's own rule).

## What ships

The task table's row 4, in full: `VendorBill` + lines + immutable versions + the §F CAS lifecycle
**up to `under-verification`** + §G bounds 1–2 + the `disputed` transition **and both withdrawal
guards**.

| Piece | Where |
|---|---|
| `VendorBill` / `VendorBillVersion` / `VendorBillLine` | `schema.prisma`, `20270420000000_phase5_t4_vendor_bill` |
| §F vendor pinning on BOTH PO-line snapshots + the diagnostic-first backfill | same migration, part A |
| The §F CAS lifecycle, the §G bound evaluation, the dispute disposition | `commercial-bill.service.ts` |
| The §0 billed sets (`BILLED_QTY`, `BILLED_AMOUNT`, live claims, the certified floor) | `commercial-bill.query.ts` |
| Withdrawal guard, acceptance side (`assertAcceptanceReversible`) | `commercial.participant.ts` ← `inventory.service.ts` |
| Withdrawal guard, measurement side (`assertMeasurementWithdrawable`) | `commercial.participant.ts` ← `commercial-measurement.service.ts` |
| The ordered-side locks, through each line's OWNING module | `procurement.participant.ts`, `labour.participant.ts` |

## Vision alignment

A PMC cannot today answer, per order, what a vendor has claimed against what actually arrived. This
task makes the claim a **first-class, immutable, bounded record**: bound 1 caps it at what was
ordered, bound 2 at what was accepted (material) or measured (labour), and neither can be satisfied
by anything a commercial actor authored — every right-hand side is a Phase-1–4 fact read through
its owner's contract. It gates nothing: commercial stays a SINK and no readiness verdict consults a
bill.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | A new write surface, and a claim that could name another counterparty's order | `commercial.bill`/`commercial.verify` declared in `ROLE_POLICY` and mirrored web-side; §D/§I probe (engineer records, contractor refused 403, verification pmc-only, off-pilot 404 with zero rows); probe 5f/5ao proves cross-vendor claims are refused **at PostgreSQL** within one project, and the cross-project case by the tenancy composite FK (upgrade proof) |
| civil-time-lifecycle | `documentDate` is a civil date; the §F status graph must not admit an illegal arrow | `documentDate` is `@db.Date`, frozen by the lifecycle trigger; the transition table is enforced in PG (`VendorBill_lifecycle`) — upgrade proof rejects `draft → certified` and an unreasoned dispute; probe 5av proves a `resolved` claim cannot be revived even by direct SQL |
| concurrency-idempotency | Two claims racing one PO line's capacity; a duplicate document number submitted twice | **PROBE 5 (DATABASE)** — two independent `PrismaClient` sessions, each holding its transaction open until the other has written, are serialized by the deferred trigger's `FOR UPDATE`: exactly one commits. **Proven RED** by stripping that one `FOR UPDATE` from the function (both committed, 200 units live against 100 accepted). PROBE 5 (SERVICE) under the readiness-lock barrier; probe 5bg concurrent duplicate submission admits exactly one; every transition is a CAS `updateMany`; keyed replays append nothing |
| data-integrity-conservation | The whole point: a claim above the evidence behind it | §G bounds 1–2 re-derived in-service under the owning module's row lock **and** sealed by a DEFERRABLE INITIALLY DEFERRED constraint trigger firing from five sites; 29 upgrade-proof assertions incl. a coherent claim ACCEPTED before every rejection; the derived-amount CHECK; append-only triggers on all three tables |
| offline-reconciliation | None — no client outbox surface in this task | §M frontend is Task 7. No web change beyond the policy mirror |
| ui-server-parity | None — no UI | Same |

## The two things worth a reviewer's attention

**1. A breach DISPUTES; it does not refuse — and the DB seal is what makes that safe.**

§G says the bounds are "sealed by a PostgreSQL constraint", and §E says an over-bound submission is
disputed rather than rejected. Those look contradictory until you take §0's LIVE rule seriously: a
`disputed` version's lines are not in the fold, so the seal is never violated by a disputed claim.
The service evaluates the bound and routes the claim to `disputed`; the database independently
refuses to let any **live** claim set exceed the bound.

That seal is **deferred to COMMIT**, and that is load-bearing in both directions:

- *Adding* a claim: a bill is created at `draft` (lines not live) and becomes live one statement
  later. A `BEFORE INSERT` check on the line would pass on a claim that only becomes live at the
  transition — the PR-#217 lesson, where a seal durable only at initial insertion was not durable.
- *Withdrawing* the evidence: an acceptance reversal or a reducing measurement correction lowers the
  right-hand side, and the withdrawal guard disputes enough live claims in the same transaction to
  restore it. A deferred check passes when the guard did its job and **aborts the transaction when
  it did not** — which is exactly what happened in the RED proofs below.

**2. One probe passed while proving nothing, and I found it by running the RED proof.**

`PROBE 5 (SERVICE)` — two concurrent submissions under the readiness-lock barrier — stayed **green**
after I stripped the `FOR UPDATE` out of `ProcurementParticipant.lockOrderedLineForClaim`. It had to:
every commercial command takes `lockProjectReadiness`, so that lock, not the PO-line lock, is what
serializes the service path. The probe proves the bound holds under a race; it does not prove the
row lock is load-bearing. Rather than claim otherwise, I added `PROBE 5 (DATABASE)`, which drives two
independent PostgreSQL sessions straight at the rows with no readiness lock anywhere — and *that*
one goes RED the moment the trigger's `FOR UPDATE` is removed. The service-side lock is retained as
a second, narrower barrier and the packet says plainly which one carries the invariant.

This is the rule Task 3 closed once and it applied again here: **a guard is only proven by a probe
that fails without it.**

## Reproduce-first evidence

The claim surface does not exist at `5dc70c1`, so "RED at base" is trivially true and worth nothing.
Each guard was instead proven by removing it from **this** tree and confirming its probe fails:

| Guard removed | Probe | Result |
|---|---|---|
| `assertAcceptanceReversible` call in `stock.reverse` | PROBE 4/5ak | RED — `Bound 2 breached … 80 base units against 0.000000 accepted`, raised by the **deferred DB seal** at commit |
| `assertMeasurementWithdrawable` call in the correction path | PROBE 5bl | RED — `Bound 2 breached … 2 person-shifts against 1.000000 measured` |
| `FOR UPDATE` in `phase5_t4_billed_bound_check` | PROBE 5 (DATABASE) | RED — both sessions commit; 200 units live against 100 accepted |
| `FOR UPDATE` in `lockOrderedLineForClaim` | PROBE 5 (SERVICE) | **still GREEN** — recorded above, not hidden |

The first two are the strongest evidence in the PR: with the service guard gone, the database
refused the transaction on its own. The seal and the guard are independently real.

## Probe coverage (35 tests, `phase5-t4-vendor-bill.test.ts`)

`4`/`5ak` dispute-not-refuse + 80/20 acceptance fold + reversal disputes · `5` bound-2 race (DB and
service) · `5ac`/`5av` a dispute frees the fold and never returns · `5d` amended bill folds once ·
`5an` the disposition disputes the MINIMUM, newest-first · `5bl` the labour twin · `5bf`/`5ag`/`5au`
line seals precise not merely strict · `5bg`/`5bj` duplicate-claim key · `5f`/`5ao`/`5ax` vendor
pinning + backfill · `5h` unit discipline · `7` append-only · §D/§I capability + authority · §C
idempotency · `F1`–`F4` the Codex round-1 findings · `R2-F1`–`R2-F4` the round-2 findings · `R3-F1`–`R3-F3` the round-3 findings · `R4-F1`–`R4-F5` the round-4 findings · `R5-F1`–`R5-F4` the round-5 findings.

## Deliberately NOT in this task

- **`verified` and everything past it.** `verified` is the state whose safety IS the §E verdict;
  shipping it here would let a bill reach it before the ordered/accepted/billed comparison exists,
  and pulling §E forward would bypass the Task-5 review stop. The status CHECK names the full set
  because §0's LIVE rule is defined over all of it, but no transition into `verified` exists.
- **The row-level measurement freeze.** §D requires a correction to be refused if it would reduce a
  measurement row a live certificate has FROZEN as consumed evidence (`(measurementId, consumedQty)`).
  That set does not exist until Task 5. The **aggregate** certified floor ships here, written over
  the status set rather than hardcoded to zero, so Task 5 adds the certificate without re-deriving
  the floor. At this tree the arm is unreachable — stated as a property of the tree, not a stub.
- **The refusal arm of `assertAcceptanceReversible`.** Same reason: there is no certificate to refuse
  against yet. The dispute half, which is real now, ships now.

## One decision recorded rather than assumed

§I's permission list does not name an authority for *recording* a vendor's claim. Task 4 adds
`commercial.bill` (pmc/engineer, mirroring `commercial.measure`) rather than borrowing
`commercial.read` or silently reusing `commercial.certify` — following §I's own rule that "a
permission a route needs and the manifest does not declare … is an unauthorized write path".
`commercial.verify` is §I's own name and is declared here because `beginVerification` needs it; its
verdict lands in Task 5.

## Codex round 1 — four findings, all fixed forward

Head `61adb3d` drew four findings, every one correct about its mechanism. Each was reproduced RED
before the fix and is RED again with the fix reverted (verified by stashing the migration and the
participant and re-running: 4 failed / 15 passed).

| # | Finding | What was actually wrong | Fix |
|---|---|---|---|
| F1 | P1 — recheck PO version status when sealing billed bounds | The bound check read the line's frozen quantity without asking whether its version was still live, and **no vendor-bill trigger fired when one stopped being live**. Ordered authority is the THIRD withdrawal path and §0b's closure row does not name it | The seal joins the version status and treats a non-live version as ZERO authority; both PO-version tables become deferred firing sites (5 → 7); `withdrawOrderedAuthority` disputes the affected claims from `replaceAttribution`/`releaseAttribution` — the one channel all eight lifecycle sites already reach |
| F2 | P2 — freeze status reasons after they explain a claim exit | The lifecycle trigger only looked when the status itself moved, so a later update could rewrite the justification for an append-only exit | `statusReason` is writable only as part of the transition that sets it |
| F3 | P2 — seal supersession fields until the actual amendment | The trigger checked the immutable columns and returned, so `supersededById`/`supersedeReason` could be pre-filled and rewritten on a still-current version; and nothing forbade ZERO current versions | Those two columns are writable only WITH `supersededAt`; the deferred check gains an exactly-one-current-version rule and now fires on UPDATE, not only INSERT |
| F4 | P2 — reject late bill-line inserts into existing versions | The line trigger froze updates and deletes but not inserts. The reviewer's exploit is exact: a **zero-money** line leaves `claimedAmount` equal to the line total, so the money check passes while QUANTITY enters `BILLED_QTY` — on a PO line the original claim never named | `lineCount` frozen at creation and re-derived by the same deferred check. A COUNT, not a quantity: one version can carry base units and person-shifts, which do not sum |

**F1 is worth reading in full, because the mechanism was right and the consequence was not.** Codex
said an amend/cancel could strand a live claim. Chasing it down, that turns out to be unreachable
through any service path in this tree — three guards from three different tasks close it: Task 2
refuses labour cancel/amend while a live capacity commitment stands, Task 3 refuses defaulting that
commitment below `MEASURED` (and a labour claim needs `MEASURED > 0`), and Phase 3 refuses a
material cancel with accepted receipts while permitting amend only from `issued` (and a material
claim needs `ACCEPTED > 0`, which moves the version off it). The probe now pins all three, because
each belongs to a different task and any one relaxing would open the door silently.

The seal was still wrong and is still fixed. §G asks the **database** to hold the bound
independently of the service, and "another task's guard happens to block the only route" is not the
database holding anything. The probe's second half drives the withdrawal straight at PostgreSQL,
where those guards do not apply, and the seal aborts the commit naming bound 1 — then shows the
paired disposition letting a legitimate withdrawal through.

**A fourth vacuous probe, found the same way.** While fixing F1 the suite's `billedQty` helper
turned out to be material-only, so passing it a labour line folded zero rows and reported `0` for a
claim that was live. My first F1 probe asserted exactly that `0` and would have passed while
proving nothing — the third instance of this failure mode in Phase 5, after Task 3's three. The
helper now requires the kind explicitly rather than defaulting to one.

## Codex round 2 — four findings, two of them my own round-1 fixes one level short

| # | Finding | What was wrong | Fix |
|---|---|---|---|
| R2-F1 | P2 — freeze `lineCount` with the version evidence | Round 1 closed the line set with a frozen `lineCount`, but did not freeze `lineCount` itself: bump it 1 → 2 and insert the extra zero-money line in the SAME transaction and the deferred check sees a count that matches | `lineCount` joins the version's immutable column list |
| R2-F2 | P2 — preserve the original dispute reason on resolution | Round 1's reason freeze keyed on "the status changed", which still let `disputed → resolved` overwrite a `qty-over-accepted` breach with an amendment note — erasing the only evidence for why the claim left the live fold | A reason is writable only by a transition INTO a state that requires one (`disputed`/`rejected`); the resolve CAS passes `null`, and the resolution lives on the superseded version's `supersedeReason` |
| R2-F3 | P2 — block pre-Task-5 lifecycle arrows | The PG lifecycle listed the whole §F graph, so after an ordinary `beginVerification` maintenance SQL could mark a claim `verified` or `certified` — in a tree with no three-way verdict and no certificate table | The arrows stop at `under-verification`. The STATUSES stay in the CHECK vocabulary because §0's LIVE rule is defined over the whole set; Task 5 adds the arrows with the evidence that justifies them |
| R2-F4 | P2 — wire billed amounts into the budget fold | `billedAmountFor` was built and never called, so a ₹40 live claim against a ₹100 receipt still reported the whole ₹100 as `receivedNotBilled` — the surface saying billed work is unbilled. Task 2's own DTO comment had promised this ("Tasks 4–6 subtract `BILLED_AMOUNT` from it") | The position gains §J's `awaiting-certification` bucket; a live claim moves money OUT of received-not-billed and INTO it. **Headroom does not change** — that is what "the buckets partition" means, and the probe asserts it |

**Two of the four are the same shape as the round-1 finding they follow**, and that is worth naming
rather than smoothing over: R2-F1 sealed a set with evidence I left editable, and R2-F2 fixed the
overwrite I keyed on the wrong condition. Both are the "one level too shallow" pattern the
PR-#270 audit named twice in Task 2. The corrective here is not another patch but the rule the
audit already stated: **when a fix introduces evidence, the evidence needs the same seal as the
thing it evidences** — which is why `lineCount` now sits in the immutable list beside
`claimedAmount`, and why the reason freeze is now keyed on the destination state rather than on
"something moved".

R2-F4 is a different kind of miss: a fold written for a caller that was never wired. Task 2's DTO
comment named the obligation and I built the fold without discharging it. The probe now asserts the
partition invariant (`committed + receivedNotBilled + awaitingCertification` totals the received
money, headroom unchanged), which is what makes a future omission visible instead of quiet.

## Codex round 3 — three findings, one of them my round-2 fix one level short

| # | Finding | What was wrong | Fix |
|---|---|---|---|
| R3-F1 | P2 — re-evaluate budget exceptions when claims go live | Round 2 wired `BILLED_AMOUNT` into the position, which made a claim a HEADROOM MOVER — my own comment said so — but the bill transitions evaluated nothing. The budget READ could report −₹100 headroom while `BudgetException` stayed empty: two surfaces from the same folds disagreeing | `claim` becomes a `HeadroomMover` (admitted by the register's CHECK); every status-moving bill path evaluates the heads its lines touch, in its own transaction. The probe asserts the RAISE and the CLEAR |
| R3-F2 | P2 — freeze `statusChangedAt` outside lifecycle transitions | The status and its reason were frozen; the timestamp recording WHEN the claim left the live fold was rewritable on a same-status update | It moves only WITH the arrow that sets it |
| R3-F3 | P2 — validate initial bill status on insert | The lifecycle trigger was `BEFORE UPDATE OR DELETE`, so a direct insert could START a bill at `certified`, skipping every arrow round 2 had just sealed | A `BEFORE INSERT` guard limits creation to `draft`. The statuses stay in the CHECK vocabulary because §0's LIVE rule needs them — which is exactly why the entry point needs its own guard |

**R3-F1 is the third consecutive round in which a correction of mine reproduced the error class it
was correcting** (see the convergence audit's Root C). The rule that came out of rounds 1–2 —
*when a fix introduces evidence, that evidence takes the same seal as the fact it evidences* —
did not cover this one, because finding 8's fix introduced no evidence: it changed what a WRITE
MEANS. So the rule gains a second clause: **when a fix adds an input to a FOLD, every writer of
that input joins the fold's closure row in the same change.** Task 2's audit reached the same
conclusion once and made its mover set derived from what the fold reads rather than hand-kept.

R3-F3 also caught the upgrade proof's own fixture, which had been inserting a bill straight at
`under-verification`. The fixture now walks the arrows — a better fixture as well as a legal one,
since it exercises the transitions this task owns on the way in.

## Codex round 4 — five findings, three of them one root: a disposition that changed the fold without closing it

| # | Finding | What was wrong | Fix |
|---|---|---|---|
| R4-F1 | P2 — include superseded bill heads in amendment evaluation | The amendment read `claimTargets` AFTER superseding, so it saw the replacement set twice and never saw the lines it dropped. A head that only the retired version touched kept an open exception for exposure that had left the fold | The retired set is captured BEFORE the supersession; the evaluation is the union of before and after |
| R4-F2 | P2 — normalize bill numbers for duplicate detection | The duplicate-document index keyed RAW text, so ` V-9 `, `V-9` and `v-9` were three distinct live documents for one vendor invoice, each free to draw on the same accepted quantity | The index keys `lower(regexp_replace(n,'\s','','g'))` — whitespace removed, not collapsed; the stored text stays the vendor's verbatim, with a `VendorBill_number_trimmed` CHECK making a padded value unrepresentable and the contract trimming so the idempotency `requestHash` is stable |
| R4-F3 | P2 — re-evaluate all bill heads after automatic disputes | A disputed claim leaves the live fold WHOLE, so every head it touched moved — and only the withdrawal site's head was evaluated. The others kept flagging exposure the budget read had already released | `disputeClaimsBeyondEvidence` evaluates the heads of EVERY bill it disputed, from inside the disposition itself, so no present or future caller can forget to |
| R4-F4 | P2 — recompute the billed fold after a lost dispute CAS | A lost CAS means a concurrent transaction already took that claim out of the fold, so the running total was stale by exactly that claim and the next claim was measured against a number counting it twice — disputing a claim the fold had room for | On a lost CAS both the fold AND the live set are re-read. The re-read is also what terminates the loop: a claim that lost its CAS is no longer live, so it cannot be returned again |
| R4-F5 | P2 — require resolved bills to carry amendment evidence | `disputed → resolved` is terminal and RELEASES the duplicate-document key, so marking a claim resolved with no correction behind it freed the vendor's number while the disputed claim was still the only version that ever existed | The lifecycle trigger CAPTURES the version that was live when the claim was disputed (`disputedAtVersion`, overwritten on every update so no writer supplies it) and refuses `resolved` unless a live version supersedes exactly that one |

**Root C, a fourth consecutive time.** R4-F1, R4-F3 and R4-F4 are one root and it is the root the
round-3 audit had already named: *when a fix adds an input to a fold, every writer of that input
joins the fold's closure row in the same change.* Round 3 made the bill COMMANDS evaluate their
heads and stopped there — but the automatic dispute and the amendment's dropped lines move the same
fold, and neither is a command. So the closure moves down a level: the evaluation now lives inside
the DISPOSITION rather than in each of its callers, which is the only version of this fix that a
future caller cannot be one level short of.

R4-F4 is worth one honest sentence about reachability, in the same shape as round 1's F1. Every
service path that transitions a bill takes `lockProjectReadiness`, so within a project the CAS
cannot currently be lost — the defect is real, its consequence is not reachable through a route
this tree exposes. The probe therefore produces the interleaving deterministically, by wrapping the
transaction client so the concurrent rejection commits between the disposition's read and its CAS.
The fix is made anyway on the same principle as round 1: a guard that holds only because another
lock happens to be held is not the guard holding.

R4-F2's normalization is in the KEY, not in the stored value. `INV-7` is what the vendor printed
and rewriting it to `inv-7` in the record would be this repository inventing a fact; trimming is
the one normalization applied to storage, because leading and trailing whitespace is never part of
a printed number.

**And the first version of that fix was itself one transcription short**, which the upgrade proof
caught rather than a reviewer: the key collapsed whitespace RUNS, so ` V-9 ` and `v-9` collided
but `INV -003` and `INV-003` still did not. Whitespace is not part of a document number's identity
at any position, so the key now holds none of it. The proof caught it because the round-4
assertions were written as a table of transcription variants rather than as the one case the
finding named — which is the same discipline as putting an acceptance case beside every rejection.

R4-F5 chose a captured version number over a timestamp comparison deliberately. Comparing the
correction's stamp against the dispute's would have made a legitimate resolution depend on two
clocks agreeing; a version number the database captures itself does not.

## Codex round 5 — four findings, three of them my own fixes one level short (again)

| # | Finding | What was wrong | Fix |
|---|---|---|---|
| R5-F1 | P2 — require a current version when a bill becomes live | The status seal LOOPED over the current version's lines. With no version at all it iterated nothing and passed: a LIVE claim with no immutable version and no lines, holding the duplicate-document key against the vendor's real invoice | The seal asserts the set is NON-EMPTY before inspecting it — exactly one current version, at least one line — for any status §0 counts as live |
| R5-F2 | P2 — preserve the dispute reason when rejecting a disputed claim | Round 2 stopped `disputed → resolved` overwriting `statusReason`. The same hole was open at `disputed → rejected`, a legal transition carrying its own required reason, so a `duplicate invoice` judgement erased the `qty-over-accepted` breach | The trigger CAPTURES `disputeReason` when the claim enters `disputed` and carries it forward untouched — the `disputedAtVersion` precedent. Neither fact is discarded: the breach is evidence, the rejection is a judgement |
| R5-F3 | P2 — guard the dispute CAS with the claim version | The CAS guarded the bill's STATUS; the quantity being disputed was read off its current VERSION. A concurrent amendment replaces the version without touching the status, so with 80 accepted a v1 of 100 amended to a v2 of 70 was still disputed — at 70 ≤ 80 | The CAS guards the version too; the round-4 lost-CAS handler already refolds, so the two compose |
| R5-F4 | P2 — validate the resolving amendment before releasing the bill | Round 4 required a resolution to CARRY an amendment. §0 keeps a disputed bill out of every billed set, so the replacement was measured as claiming nothing: a 120-unit claim against 100 accepted could be "corrected" to 150 and resolve, releasing the document number | The replacement is evaluated with its own lines counted as live BEFORE the resolve, and a still-breaching correction is REFUSED |

**Root C, a fifth consecutive round — and R5-F4 is the sharpest instance yet.** Round 4's F5 required
the amendment to EXIST; R5-F4 says it must be VALID. That is the same finding one level down, in the
same fix, one round later. R5-F2 is round 2's fix at a second entry point. R5-F3 is round 4's F4 fix
one column short — I refolded the quantity and did not guard the version the quantity came from.

R5-F1 is a distinct and worth-naming shape: **a guard that inspects the members of a set is
vacuously satisfied by the empty set.** Phase 4 met this exact class once already ("an empty
due-today set can never yield `ok`"), and it recurred here because a loop reads as a check.

The rule this round adds, and the reason it is a *checklist* rather than another principle: when a
guard is written, state (a) what makes it fire, (b) what makes it pass, and (c) **whether "pass"
includes "there was nothing to check"** — and probe each distinct entry point into the guarded
state, not only the one the finding named. This repo already had the precision rule (*a rejection is
only evidence when an otherwise-identical case is ACCEPTED*); its missing twin is coverage.

R5-F4 REFUSES where §E's rule is otherwise dispute-not-refuse, and the distinction is what each
protects. Dispute-not-refuse exists so a submitted claim's record survives — and it does: the
original 120-unit claim and its breach are untouched. What is refused is an AMENDMENT that would end
the dispute without settling it.

The upgrade proof gained a five-unit ACCEPTANCE in the legacy fixture. Until now every §G claim path
in that proof could only end in refusal, and a seal never shown to accept is not shown to be
precise; five accepted units let a 3-unit claim go legitimately live while the 10-unit claim still
breaches, proving both directions against the same line.

## Gates

- `pnpm check` **EXIT 0** — web 42 files/543 tests, API 56 files/718 tests, builds clean
- Full integration suite **76 files / 799 tests** on a pristine migrated DB
- `boundary.test.ts` / `module-registry.test.ts` / `cross-module-graph.test.ts` green (mutating
  routes 152 → 157; MODEL_OWNER + owned/read-encapsulated sets extended)
- `upgrade-proof.sh` **PASSED** — the three tables upgrade ROW-FREE; the vendor-pinning backfill runs
  against two chains planted on the PRE-Task-4 schema in their own project `p3` (the only migration
  in this phase that migrates existing data, so a proof over empty tables would have been vacuous);
  a coherent claim is ACCEPTED before every one of the 20 hostile rejections
- `test:e2e:api:allmodules` **35/35**, `:outbox` **29/29** (one `drawings-module-query` visibility
  flake on the first allmodules run — an untouched surface; clean on re-run)

## Files

32 changed, ~3,750 lines. `<!-- review-size: justified-large -->`: the schema, its migration, the
service, the two withdrawal-guard call sites, the two owning-module locks, the tripwires, the probe
suite and the upgrade proof are one architectural concern — the vendor claim — and splitting the
seal from the fact it seals is exactly the failure mode §0b names. Roughly half the line count is
the migration (685 lines, most of it the reasoning behind each seal), the probe suite (620) and this
packet plus the §F/§G verbatim carry-forward into the plan.
