# Phase 5 Task 3 — `Measurement` (§D) and the two withdrawal guards (review packet)

**Branch** `claude/phase5-task3` · **base** `main` `96b0713`

**Convergence audit** `docs/reviews/pr-272-convergence.md` (three finding-bearing heads, ten
findings, three roots — including the honest record that round 1's own fix created round 2's finding,
and that round 1's fix for finding 4 acquired the unsealed precondition round 3 found)

**§D is carried forward VERBATIM** from `claude/phase5-planning` @ `a4d469b`, byte-identity verified
by diff against the source revision. The plan mandates carrying rather than re-deriving; re-deriving
is what produced twenty review rounds on the plan itself.

## Vision alignment

Phase 5 CONSUMES the operational record; it does not restate it. A measurement is the one place
where that could quietly go wrong — a commercial actor writing a quantity that later becomes a
payable without any site fact behind it. So §D bounds a measurement by evidence the site already
produced: a closing sign-off, recorded work output, worked effort traced to the commitment that
funded it, and the ordered authority itself.

`ActivityWorkOutput` records what was physically produced. `LabourWorkFact` records minutes worked.
Neither is a measurement: a measurement is a **contractually agreed quantity at a contract rate,
taken by a named person on a named date, against a named PO line** — different unit, different
authority, different lifecycle. Commercial stays a SINK; nothing here gates an activity or a receipt.

## What ships

| § | Thing | Where |
|---|---|---|
| §D | `Measurement` — immutable, signed quantities, LABOUR-only | `20270415000000_phase5_t3_measurement` |
| §D | `commercial.measurement.take` / `.correct` — a correction is a NEW row with a signed delta | `commercial-measurement.service.ts` |
| §D | the sign-off read **under the activity row lock** | `ActivityParticipant.measurableTarget` |
| §0 | `OUTPUT` as a PREDICATE — cited, never drawn down | `ActivityParticipant.workOutputBelongsToActivity` |
| §0 | `EFFORT(poLine)` — minutes normalised to person-shifts, joined through the commitment | `LabourQuery.effortForPoLines` |
| §D/§E | the `revertSignOff` withdrawal guard | `CommercialParticipant.assertWorkEvidenceRevisable` |
| §D/§G | the labour close-short measured floor | `CommercialParticipant.assertOrderedNotBelowMeasured` |
| §0 | the `COMMITTED` fold's labour CONSUMPTION term | `commercial-budget.query.ts` |
| §D | `GET …/commercial/labour-po-lines/:id/measurements` | `commercial.controller.ts` |

### The four bounds, and why none is redundant

1. **the activity is `done`, read UNDER ITS ROW LOCK.** §D names the race a plain query admits:
   measurement sees `done`, a rejected closing inspection commits `revertSignOff`, and the
   *immutable* measurement commits anyway — a bill later resting on withdrawn evidence.
2. **a cited `ActivityWorkOutput` exists for that same activity.** Sign-off alone would let a
   commercial actor author the only quantity evidence in the chain. The citation is a PREDICATE and
   is never drawn down, so a mason line and a helper line both measure against ONE output.
3. **`MEASURED ≤ EFFORT`**, effort joined `LabourWorkFact → WorkerAllocation → CapacityCommitment →
   LabourPurchaseOrderLine`. Not fingerprint+slice: two vendors can share a fingerprint on one day,
   and matching on it would let A's attendance fund B's bill. Minutes normalise to person-shifts
   *inside* the set — a caller holding raw minutes could satisfy a 10-shift claim from one worker's
   720-minute day.
4. **`MEASURED ≤ ordered personShiftQty`.** See the 5as note below: this is not redundant with (3).

### LABOUR only, structurally

There is no `poLineId` column on `Measurement`. A material measurement is **unrepresentable**, not
merely refused: `ACCEPTED(poLine)` already IS the measurement of a delivery, and a parallel manual
figure would be a second truth about one physical event. `upgrade-proof.sh` asserts the column's
absence.

### Immutable, strictly

The trigger permits **no** UPDATE and **no** DELETE — stricter than the append-only tables that
allow one supersession stamp. A measurement has no lifecycle to move through, and its whole value as
evidence is that the number recorded on the day cannot change. A correction is a new row.

## Invariant matrix

<!-- review-size: justified-large -->

| invariant | risk in this change | verification |
|---|---|---|
| authorization-tenancy | A caller without `commercial.measure` writes a payable quantity, or a measurement reaches across a tenant boundary to another project's PO line, activity or work output | `RolesFor` **plus** a service-level `assertMeasure` backstop; probe asserts a `contractor` is 403 **and writes zero rows**; both write and read 404 off-pilot. Same-project composite FKs on the labour PO line, activity, cited output, corrected row, evidence media and source command — `upgrade-proof.sh` rejects a nonexistent-line measurement **at PostgreSQL** |
| civil-time-lifecycle | `measuredOn` is a CIVIL date, and a correction backdated to the original's date would erase the fact that the record changed after the event | `measuredOn` is `DATE`, parsed through the shared `fromIsoCivilDate` with a rejection for a non-date; a correction is deliberately stamped TODAY and the code says why. Lifecycle: the row has none — the immutability trigger refuses every UPDATE and DELETE, proven by probe 5n against live PG |
| concurrency-idempotency | A rejected closing inspection commits between the status read and the immutable insert, stranding a measurement on withdrawn evidence; or a replayed command appends a phantom quantity | `lockProjectReadiness` first, then `measurableTarget` takes the activity row `FOR UPDATE` before reading status — `revertSignOff` CASes that same row, so one side blocks and re-reads a status it can trust. Both bounds are re-derived **inside** that lock. Every write runs through `executeCommand`; an unkeyed call reserves a server one-shot command (`synthesizeKeyWhenAbsent`), so `sourceCommandId` is a real FK and a keyed replay appends nothing |
| data-integrity-conservation | Effort double-counted across PO lines; measured work exceeding what was ordered; a correction driving the fold negative; or money double-counted between the committed and received buckets | Effort reaches at most ONE line by construction (the join runs through the commitment that funded the allocation) — probe: a line that funded nothing has ZERO attributable effort. `MEASURED ≤ EFFORT` **and** `≤ ordered` both re-derived under lock. The fold may never go negative (probe 5n: −3 against 2 refused, fold stays 2). `MEASURED` is a FOLD with no stored balance. The `COMMITTED` consumption term moves money between buckets and the probe asserts `committed + receivedNotBilled` is conserved at ₹2,000 |
| offline-reconciliation | **No client write path ships** — no outbox, queue or hydration code is touched. The server-side equivalent is command replay | `executeCommand` + `requestHash`; the write and its budget re-evaluation are one transaction, so a partial apply is impossible |
| ui-server-parity | **No frontend ships.** The parity risk that exists is *contract* parity — a declared command or query with no handler, which was 3 of PR #270's 13 findings | `commercial.contract.test.ts` closure 1 pins every `COMMERCIAL_COMMANDS`/`COMMERCIAL_QUERIES` entry to a real handler and route; it **failed immediately** when the two new commands and the query were declared, which is the closure doing its job. `apps/web/tests/policy.test.ts` mirrors `commercial.measure` |

### Repository invariants (CLAUDE.md)

| # | Invariant | Proof |
|---|---|---|
| 1 | One project = one site | every FK is same-project composite; cross-project reference unrepresentable |
| 2 | Operational records never global | `Measurement` carries `projectId`; no org row written |
| 3 | One fact, one canonical owner | the sign-off and the cited output are read through `ActivityParticipant`; effort and the ordered quantity through `LabourQuery`; commercial reads no foreign table (`cross-module-graph.test.ts`) |
| 4 | Attributable approvals preserved | actor FK + `measuredOn` + reason on every correction; fully immutable at PG |
| 5 | Additive migrations | one new table, `CREATE`-only, closing row-free ABORT |
| 6 | Isolation proven against PostgreSQL | `upgrade-proof.sh` executes the Task-3 assertions on the migrated legacy database |

## Codex round 3 — three findings, and the same question answered wrongly three times

All three ask **which of the service and PostgreSQL should hold this rule**, and I had been answering
"whichever is easier to write here".

**R8 (P1).** A correction could target another correction. This is the sharper half of the round, and
it is **round 1's fix acquiring a precondition it did not seal**: finding 4 replaced the line-aggregate
floor with `netOf` walking a row's DIRECT children, which is sound only over a one-level tree, and
nothing made the tree one level deep. A → B → C would let C erase evidence B had already accounted
for. The service now refuses it, and `phase5_measurement_correction_target()` makes a chain
**unrepresentable** rather than merely refused by the one path that happens to write it.

**R9 (P2).** A negative ORIGINAL was refused by the service only. Because the table is fully
immutable, a direct insert would leave permanently corrupted billing evidence sitting under every
service-side floor. `Measurement_quantity_check` now splits: `> 0` for an original (it records work
that HAPPENED), `<> 0` for a correction (only a correction carries a sign).

**R10 (P2).** A nonexistent or cross-project `evidenceMediaId` reached the client as a 500 from the
raw FK violation. It now goes through `rethrowMediaRefViolation` — the cleared Task-5 precedent for
exactly this — and is a 400.

The rule I take forward is in the audit's closure C: when a correction changes HOW a value is
computed, write down the property of the stored data the new computation relies on and put it in the
schema, where the computation will read it.

## Codex round 2 — two findings, one of them mine to have created

**R6 (P1).** The measured floor was on close-short only, and **round 1's own fix is what made
`defaultCapacity` need it**: once `defaulted` maps to a live authority of 0, defaulting silently does
what close-short is refused for. A fix that changes what a value MEANS changes which writers are
subject to the rules that read it — the same shape as PR #270's root B, one task later.

The operational consequence is stated in the code rather than left to be discovered: once real work
has been measured against a line, a supplier walking away is recorded as a CLOSE-SHORT (which keeps
the committed portion), not a default. `default` is for a commitment that delivered nothing anyone
measured; if the work is being disclaimed rather than kept, the measurement is corrected first.

**R7 (P2).** `measuredOn` accepted a well-shaped impossible date (`2026-02-31`), so the shared
parser threw a plain `Error` — a 500 for a plainly bad request. It now uses `isoCivilDateSchema`.

## Codex round 1 — five findings, one shape

All five were real and four were P1. What they share is worth naming, because it is the same class
of mistake five times: **every bound I wrote checked the right quantity against the WRONG SCOPE.**

| # | Sev | Finding | The scope that was wrong |
|---|---|---|---|
| F1 | P1 | Effort fetched by PO line alone, so a caller could name a DIFFERENT signed-off activity plus its output, pass the sign-off and evidence checks against that one, and have the quantity cap satisfied by work on an activity nobody signed off | effort scoped to the line, not to the **activity being measured** |
| F2 | P1 | The ordered cap compared against the FROZEN `personShiftQty`; after a capacity default the version can still read `issued` while the commitment authorises nothing, so historical effort could be measured against an order nobody owes | the **original** order, not the **live authority** |
| F4 | P1 | The correction floor was the LINE aggregate: with A=1 and B=1, correcting A by −2 keeps the line at a legal 0 while silently wiping B's payable evidence | the **line**, not the **row being corrected** |
| F5 | P1 | The live-line check refused REDUCING corrections too, so a cancelled line deadlocked against `assertWorkEvidenceRevisable` telling the operator to correct to zero first | gated **all** writes, not just **positive** ones |
| F3 | P2 | `measuredOn` defaulted to the server's UTC date | the **server's** day, not the **project's** civil day |

F2's fix reuses the `liveAllocation` rule Task 2's correction established (0 when defaulted,
`committedQty` when closed short) rather than inventing a second spelling of it, and F4's row-level
floor is the same identity §E's `(measurementId, consumedQty)` freeze will depend on.

### Two defects in my own testing, both fixed

**R3 initially PASSED against the very bug it was written for.** With Asia/Kolkata the site date
differs from UTC only between 18:30 and 24:00 UTC, so for most of the day the probe proved nothing.
It now picks whichever of UTC+14 / UTC−11 currently differs from UTC — at every instant at least one
does — and asserts that difference up front, so it can never be vacuous. A probe that passes while
the code is wrong is worse than no probe.

**The three §D upgrade-proof rejections were passing for the wrong reason.** Extending the proof for
R8 and R9 I found that all three existing `Measurement` hostile inserts cited an output id `OUT-1`
the legacy fixture never creates, so every one was rejected by the `citedOutputId` FK — three green
lines with no evidence behind them, which would have stayed green if I had deleted all three of the
constraints they named. The closure is the shared one, not a second patch: **a rejection is only
evidence when an otherwise-identical row is ACCEPTED.** The §D section now inserts a coherent
measurement and its signed correction first (citing the real `UPL-T5O` output on the same activity),
and each hostile row differs from that accepted one in exactly the single respect its label names —
the same coherent-chain pattern the §C, §E and §B sections already use to prove precision.

## Two things the probes taught me, recorded rather than smoothed over

**5as — `EFFORT` cannot normally exceed `ORDERED`, and finding that out mattered.** My first probe
simply added a third worker to a 2-shift order; §F bound 3 refused the allocation, correctly. Live
allocations are capped at the committed quantity, so effort cannot outrun the order that way. What
is *not* capped is **history**: a supplier's worker leaves mid-job and is REPLACED. Both people did
real work, both work facts stand, and the ordered authority is still one shift. That is exactly why
§D bounds measurement by the ORDER independently of effort, and the probe now exercises the real
site event instead of an impossible one.

**5c — the first fixture read zero effort, and the fold was right.** It allocated workers as OWN
WORKFORCE. §0's `EFFORT` joins through the `CapacityCommitment` that funded the allocation, so
own-workforce effort attributes to no PO line — correctly, because nobody is billing a supplier for
it. The fixture now draws the named commitment.

## A module cycle this task exposed

Importing `SHIFT_MINUTES` from `labour-capacity.service.ts` into `labour.query.ts` closed a cycle
(`labour.query → labour-capacity.service → activity.participant → commercial.participant →
commercial-budget.query → labour.query`) that left Nest unable to construct `LabourCapacityService`
at all. The constant now lives in a leaf `shift.ts`; the service re-exports it, so no existing
import changes. Recorded because the cause was a one-line import, and the symptom was a DI error
several modules away.

## `measurement` as a headroom mover

`MEASURED` is a `COMMITTED` fold input, so under Task 2's closure it is a headroom mover and the
write re-evaluates. **As the arithmetic stands it is exposure-NEUTRAL and can never raise**:
measurement is hard-capped at the ordered quantity, so consumed can never exceed
`committedAmountBase` and the money only changes bucket. It is wired and labelled anyway, because
the closure's rule is mechanical and carving out an exception on the strength of my own arithmetic
is what went wrong twice in PR #270.

## Evidence

| Gate | Result |
|---|---|
| `pnpm check` | **EXIT 0** — web 543/543, API 716/716, build clean |
| `phase5-t3-measurement.test.ts` | **19/19**, and **proven RED**: disabling the five §D bounds and both guards fails six of the original nine; reverting the five round-1 fixes fails all five of their probes, the two round-2 fixes fail both of theirs, and the three round-3 fixes fail all three of theirs (proven by restoring the old CHECK and dropping the trigger in live PG, not by reasoning) |
| `upgrade-proof.sh` | **PASSED** — the table ROW-FREE over the legacy fixture, the material-column absence asserted, the `measurement` label accepted, the correction-target trigger present, a coherent measurement + its signed correction **ACCEPTED** (so the seals are precise, not merely strict), and **eight** forgeries rejected on the migrated DB |
| Full integration suite, migrated + UNSEEDED DB | **75 files / 759 tests passed** |

## Not in this PR

Task 4 raises the correction floor from zero to what live CERTIFIED bills have consumed and adds the
row-level consumption freeze — both ship with the bill that makes them meaningful, exactly as this
guard ships with the fold. An AMEND is deliberately not covered by the ordered-floor guard: an
amendment issues NEW lines and leaves the measured line non-live, so that line's own
`MEASURED ≤ ordered` still holds; refusing to BILL against a dead line is Task 4's, with the bill
that would do it. The code says so at the guard.

**Task 3 is a plan STOP — a narrow review before any bill can consume a measurement.**
