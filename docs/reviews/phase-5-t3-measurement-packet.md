# Phase 5 Task 3 — `Measurement` (§D) and the two withdrawal guards (review packet)

**Branch** `claude/phase5-task3` · **base** `main` `96b0713`

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
| `phase5-t3-measurement.test.ts` | **9/9**, and **proven RED**: disabling the five §D bounds and both guards fails six of the nine |
| `upgrade-proof.sh` | **PASSED** — the table ROW-FREE over the legacy fixture, the material-column absence asserted, the `measurement` label accepted, and three forgeries rejected on the migrated DB |
| Full integration suite | *(reported in the PR body)* |

## Not in this PR

Task 4 raises the correction floor from zero to what live CERTIFIED bills have consumed and adds the
row-level consumption freeze — both ship with the bill that makes them meaningful, exactly as this
guard ships with the fold. An AMEND is deliberately not covered by the ordered-floor guard: an
amendment issues NEW lines and leaves the measured line non-live, so that line's own
`MEASURED ≤ ordered` still holds; refusing to BILL against a dead line is Task 4's, with the bill
that would do it. The code says so at the guard.

**Task 3 is a plan STOP — a narrow review before any bill can consume a measurement.**
