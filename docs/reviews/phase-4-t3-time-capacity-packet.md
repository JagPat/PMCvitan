# Phase 4 Task 3 — §C time-capacity facts + §F bound 3 (review packet)

**Base:** `main` @ `83971b7` (merge of PR #223 — the Task-2 correction round 3 that returned
**GREEN SIGNAL — PHASE 4 TASK 2 CLEARED**). Branch `claude/phase4-task3`. Held for independent
review at the prescribed stop. **Task 4 has NOT begun.**

**Clearance recorded first.** Commit `ffeab09` is the required first documentation commit: it
records the Task-2 GREEN SIGNAL, the verified points, and the cleared lineage
`c09b1ac → 45ac885 → 83971b7` in `CLAUDE.md` + `docs/ROADMAP.md` before any Task-3 code.

**Scope boundary.** Task 3 delivers the plan's §C time-capacity FACT families, the §F bound-3
allocation arm, and the §H device binding Task 1 deferred here. It does **not** touch Tasks 1–2:
no earlier migration is edited, no Task-1/2 service behaviour changes, and the labour commercial
chain is used only as a fixture. The derived Team gate, the coverage read and the readiness
projection are **Task 4**; the frontend is **Task 6**.

---

## 1. What §C actually models (and what it deliberately is not)

Labour is **expiring, time-bounded capacity**, so this is **not** a stock ledger. There is no
current-quantity column, no bucket and no transfer anywhere in the design. Four families, each
with its own unit and its own seal:

| Family | Unit | Lifecycle | Seal |
|---|---|---|---|
| `WorkerAllocation` | 1 person-shift | frozen-identity CAS `active → released` | identity trigger + one-way status + the conservation exclusion |
| `LabourAttendance` | headcount (1) | append-only observation, revocable correction | append-only trigger + one live muster per slice + device binding |
| `LabourWorkFact` | worked-minutes | fully immutable | `phase3_immutable_row` + allocation-identity copy + per-row and cumulative bounds |
| `ApprovedSkillSubstitution` | (authorization) | append-only, revocable | append-only trigger + one active per `(requirement, from, to)` + distinct CHECK |

**Conservation is enforced at the `Worker`** (round-2 finding 1). A `Crew` is organizational only:
allocating one EXPANDS transactionally into one `WorkerAllocation` per ACTIVE member, so a worker
booked twice directly, via two crews, or directly-and-via-crew all collide on the ONE partial
unique `(projectId, workerId, civilDate, shift) WHERE status='active'`.

---

## 2. The two round-3 guardrails, implemented

**Guardrail 1 — deadlock-free crew allocation.** `lockWorkersInOrder` issues
`SELECT … FOR UPDATE … ORDER BY "id" ASC` over the de-duplicated member set. Two transactions
allocating overlapping crews therefore request the shared worker locks in the SAME order, so one
simply waits — a lock cycle is impossible by construction. The overlapping-crews probe is shaped so
a naive membership-order lock would invert (`crew1 = [shared, onlyA]`, `crew2 = [onlyB, shared]`),
and it asserts BOTH transactions complete with a 409 whose message does not mention a deadlock.

**Guardrail 2 — cumulative worked-minutes.** `recordWork` re-derives
`Σ workedMinutes` for `(projectId, workerId, civilDate, shift)` under the worker `FOR UPDATE` and
refuses an overrun. The per-row CHECK (`> 0 AND <= 720`) alone cannot catch this: the probe records
500 minutes (individually legal), then refuses 300, then accepts exactly the 220-minute remainder,
then refuses one more minute. A barrier race with two 400-minute records admits exactly one.

---

## 3. §F bound 3

An allocation MAY draw down committed supplier capacity (`capacityCommitmentId`, nullable — own
workforce cites nothing). Three layers:

1. **Slice identity is a five-column FK** — `(projectId, capacityCommitmentId, labourSpecFingerprint, civilDate, shift)` references the commitment's own
   `(projectId, id, labourSpecFingerprint, civilDate, shift)` candidate key. Capacity committed for
   one `(civilDate, shift)` can never be drawn for another — a **partial date-range commitment
   covers only its own slices**, unrepresentable otherwise.
2. **The service re-derives the bound under the commitment `FOR UPDATE`**, so two transactions
   competing for the last committed person-shift serialize and exactly one may take it.
3. **A BEFORE INSERT trigger is the backstop** under a direct write.

**Honest statement of the overage arm.** The plan states bound 3 as
`committed/allocated ≤ ordered + approvedOverage`. The labour chain's headroom is **structurally
zero**: Task 2's `committedQty ≤ personShiftQty` CHECK plus the commitment↔PO-line slice FK make
`committed == ordered` exactly, and a labour PO has no `approvedOverage` column. Adding one would
reopen Task 2, which the directive forbids. So bound 3 here reads `allocated ≤ committed (= ordered)`
per slice, and the migration says so in a comment at the trigger.

---

## 4. Boundary discipline (Labour stays a LEAF)

`labour.dependsOn` is still `[]`. Two edges were added, both correct:

- **`labour → activities` workflow participant** — an allocation names the activity it serves,
  validated through the new `ActivityParticipant.labourTarget`. §G's READ edge runs
  `activities → labour` (the Task-4 coverage read), so a `labour → activities` READ would close a
  cycle; the participant channel is cycle-exempt, exactly as inventory does it.
- **`orgs → labour` read edge** — the orgs-owned `WorkerDevice` bind command reads the trusted-worker
  lifecycle through the new `LabourRequirementQuery.workerLifecycle`. The boundary analyzer CAUGHT
  the first draft's direct `tx.worker` read (`cross-module-read`, `worker` owned by `labour`) and
  this is the routed fix. Labour is a LEAF, so this edge closes no cycle; the acyclicity pin passes.

---

## 5. §H device binding — the Task-1 promise, kept

Task 1 shipped the structural foundation (nullable same-project `(projectId, workerId)` composite
FK on `WorkerDevice`) and explicitly deferred the binding COMMAND to Task 3. It lives in the ORGS
module because `WorkerDevice` is orgs-owned. A device starts UNBOUND, so anonymous QR/tap
onboarding is byte-for-byte unchanged; binding is a CAS on the still-unbound row; re-binding to a
different worker is refused because the device already attributes that worker's past musters.

The attendance seal that makes it matter: `phase4_t3_attendance_device_bound` rejects a muster
citing an UNBOUND device, or a device bound to a DIFFERENT worker. Free-text device `name`/`trade`
are never readiness evidence — the FK identity is.

---

## 6. Migration

ONE additive, diagnostic-first migration: `20270210000000_phase4_t3_time_capacity`. Every earlier
migration is byte-for-byte unchanged. Four new tables + 3 partial uniques + 26 same-project
composite FKs + 8 triggers + 10 CHECKs, and a closing `DO` block that **ABORTS** if the newly
created tables hold any row (they cannot on a legacy database — the labour pilot is row-free — so
the assertion documents the invariant rather than assuming it). No backfill, no data edit, no
operator repair needed: there is nothing to repair in tables that start empty.

---

## 7. Evidence

**Reproduce-first live-PG suite** — `apps/api/test/integration/phase4-t3-time-capacity.test.ts`,
**17/17**. Every plan-required Task-3 probe:

| Probe | Assertion |
|---|---|
| §C.2 slice arithmetic | 2 workers × 3 days = 6 rows; one fingerprint; a date the head does not demand is refused |
| §C.2 conservation | a second live allocation is a 409; release frees it; the released row survives; a second release is a 409 |
| §C.2 frozen identity | slice/activity re-point refused, DELETE refused, `released → active` refused |
| §C.2 competing-activity race | exactly one wins |
| §C.2 worker-vs-crew race | exactly one wins; the whole crew expansion rolls back |
| §C.2 overlapping-crews race | exactly one wins, BOTH transactions complete, no deadlock |
| §C.3 attendance | one live muster per slice; night is a different slice; revoke then re-record; append-only |
| §H device evidence | unbound refused, bound accepted, wrong worker refused, re-bind refused |
| §C.4 cumulative bound | 500 ok, +300 refused, +220 ok, +1 refused; immutability; slice-copy forgery refused |
| §C.4 cumulative race | two 400s → exactly one |
| §F bound 3 | 2 of 2 drawn, 3rd refused; the 11th cannot draw the 10th's commitment; own workforce unaffected; release returns the person-shift |
| §F bound 3 race | two allocations race the last committed person-shift → exactly one |
| §F bound 3 DB seal | hostile mis-slice draw → FK; hostile over-draw → bound-3 trigger |
| §B substitution | `from` = head fingerprint; self-substitution refused; duplicate active refused; a revision strands it; revoke is a stamp |
| §H containment | cross-project worker/activity refused; direct forgery refused by FK; cross-project device refused |
| §D inertness + §C rule ii | all 9 surfaces 404 off-pilot; keyed replay appends nothing; `sourceCommandId` resolves |
| `labour.capacity` read | serves the facts, filters by civil-date window, refuses a client |

**Gates:**

- `pnpm check` **EXIT 0** — web 432/432, API 655/655 (+24: the new suites and mirror rows), builds clean.
- Full integration suite on a **pristine migrated DB**: **66 files / 578 tests** (was 65/561; +1 file, +17 tests).
- `scripts/upgrade-proof.sh` **PASSED** — the 4 tables upgrade ROW-FREE over the legacy fixture with
  their seals installed; a coherent §C chain (worker → bound device → allocation → attendance →
  effort) is ACCEPTED, proving the seals are precise; and 12 hostile inserts are rejected (duplicate
  live allocation, frozen re-point, delete, over-draw, mis-sliced draw, duplicate muster, muster
  edit, unbound-device evidence, effort edit, effort slice forgery, over-shift record, self-
  substitution, out-of-window allocation). Every prior Phase-1..Phase-4-T2 rejection still passes.
- `test:e2e:api:allmodules` **31/31**; `:outbox` **25/25 + 6 skipped**. (One `allmodules` run flaked
  on the documented timing-sensitive `inspections-module-query` scope-lease step — no labour surface
  is involved — and the clean re-run was 31/31.)
- Tripwires advanced in the same commits that change them: `MODEL_OWNER` (+4 labour-owned models),
  the labour capacity service (`dispatch: 7`) and the orgs device service (`dispatch: 0`), the two
  new controllers, mutating routes **136 → 144**, external-effect dispatch sites **70 → 77**,
  dispatching services **14 → 15**, the labour read-encapsulated set and participant edge,
  `orgs.dependsOn` + `labour`, the route-policy controller registry, and the §A readiness-lock
  command enumeration **22 → 29**.

---

## 8. Vision alignment

One project is one site: every §C fact is project-contained and a cross-project reference is
unrepresentable in PostgreSQL (proven by forgery). One fact has one canonical owner: Labour owns the
four fact families, Activities owns the requirement root, Orgs owns `WorkerDevice` — and each is
written only by its owner, through participants and query contracts where a boundary is crossed.
Attributable human approval is preserved: every command resolves an `Actor`, records an audit row
and stamps `sourceCommandId`; a skill substitution names its approver and its reason. Additive
migration only, diagnostic-first, proven against real PostgreSQL.

This fills the physical-truth half of the "Team" readiness gate: the site can now say **who is
assigned**, **who actually turned up**, and **how much effort was spent** — as three distinct,
immutable facts with distinct units, none of which can be forged into another. Task 4 turns those
facts into the gate verdict.
