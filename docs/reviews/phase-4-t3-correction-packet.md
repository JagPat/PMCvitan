# Phase 4 Task 3 — correction packet (the four independent-review findings)

**Base:** `main` @ `cb589dd` (the merged Task-3 head, PR #224). Branch
`claude/phase4-task3-correction`. **Held for narrow re-review. Task 4 remains blocked.**

The reviewer's verdict was BLOCKED NARROWLY: the implementation is substantial and its declared
tests pass, but Task 4 would derive the Team gate from facts that can currently be invalid. All
four findings are accepted as stated — each was reproduced live before being fixed.

**Migration discipline.** The merged `20270210000000_phase4_t3_time_capacity` is **byte-for-byte
unchanged**. Every new seal lands in one additive, diagnostic-first
`20270215000000_phase4_t3_correction`, which reports a bounded per-finding sample and **ABORTS**
on any pre-existing violation rather than editing or inventing data. The labour pilot is row-free
on every legacy database, so a legacy upgrade is a no-op; the diagnostics exist so an operator is
never surprised, not because data is expected.

---

## F1 (P1) — the allocation did not bind the requirement to its owning activity

**Reproduced.** `phase4-t3-correction.test.ts` §F1 — a requirement owned by activity A allocated
with activity B succeeded at `cb589dd`, and the direct-SQL forgery was accepted, because the
`Activity` FK and the requirement/spec FK were independent.

**Fixed on both sides.**

- *Service:* the head now comes from Activities' own truth —
  `ActivityParticipant.labourRequirementHead` returns `{ revision, activityId, status, type }`.
  `allocate` refuses (400) when `head.activityId !== input.activityId`. Labour still reads no
  Activities table directly; the participant is the cycle-exempt channel, so Labour remains a LEAF.
- *Database:* `ActivityRequirement` gains
  `@@unique(projectId, requirementId, revision, activityId)` — a strict **widening** of the existing
  `(projectId, requirementId, revision)` key, so it cannot change which requirement rows are
  permitted, only what may reference them. `WorkerAllocation` then carries a composite FK on
  `(projectId, requirementId, originRevision, activityId)` to that key, making the mismatch
  unrepresentable in SQL.

This also replaces the old `headSpec()` (highest *labour* spec revision), which was never the
requirement's head — only a proxy for it.

---

## F2 (P1) — attendance was accepted without trusted evidence

**Reproduced.** §F2 probes — attendance with neither `deviceId` nor any evidence succeeded, and a
**nonexistent** `evidenceMediaId` succeeded because there was no FK at all.

**Fixed.** Canonical presence now carries exactly one of two paths, and the choice is explicit:

| Path | Meaning |
|---|---|
| `deviceId` | the worker's **own bound device** evidenced the muster (§H; a device bound to another worker was already rejected) |
| `manualReason` | an **explicit, pmc-attributable exception** — presence with no device behind it, recorded as such |

The manual path is deliberately *modelled*, not banned: site reality includes dead batteries and
lost phones. What it must never be is silent. It requires `labour.override` (pmc), so an engineer
cannot vouch for unsupported presence, and the reason is stored on the row.

Sealed at three levels: the zod contract (HTTP edge), a service backstop (a direct caller cannot
bypass it), and two CHECKs — `deviceId IS NOT NULL OR manualReason IS NOT NULL`, and never both.
`evidenceMediaId` gains a same-project `Media` composite FK, and the new
`LabourRequirementParticipant.assertMediaDisposable` — invoked by the **owning** media module's
delete transaction, the same pattern inventory uses — refuses to delete a photo while a muster cites
it. **Including a revoked muster:** the observation survives as history precisely so the correction
is auditable, and history without its evidence is not history.

---

## F3 (P1) — the §F bound-3 seal was concurrency-unsafe

**Reproduced.** §F3 — two **independent** `PrismaClient` sessions each open a transaction and insert
a drawing allocation against a quantity-1 commitment, with the first held open across the second's
insert. At `cb589dd` both committed: under READ COMMITTED each counted zero, because neither could
see the other's uncommitted row. The application service race was safe; the claimed **database**
invariant was not.

**Fixed.** The trigger now takes `FOR UPDATE` on the commitment row **before** counting. The second
transaction blocks on that row lock, and once the first commits it re-counts with the row visible
and is rejected. Serialize first, then read — the lock is what makes the count trustworthy.

**Evidence:** the two-session probe ran **10 consecutive times**, each admitting exactly one commit
and leaving exactly one active allocation.

---

## F4 (P2) — cancelled requirements still accepted allocations

**Reproduced.** §F4 — cancelling copies the labour spec and slices onto the cancellation revision,
so the labour-side max revision still resolved and a new allocation against dead demand succeeded.

**Fixed, in both directions**, because a one-sided rule just moves the hole:

- allocation against a cancelled head is refused (409) in the service, with a BEFORE INSERT trigger
  reading the head status as the DB seal;
- **cancellation is refused while active allocations remain** — the labour disposition check that
  the Activities cancel command already invokes now also counts live `WorkerAllocation` rows. The
  explicit disposition is: release them (an attributable `allocation.released` with a reason), then
  cancel. So neither side can strand the other.

---

## Evidence

**Reproduce-first:** `apps/api/test/integration/phase4-t3-correction.test.ts` — **5/5**, every probe
RED at `cb589dd` first. The F3 hostile two-session race: **10/10 consecutive**.

**Retained:** the 17 existing Task-3 tests all pass. Two attendance probes now bind the worker's
device before mustering — that is the intended behavioural change, not a test relaxed to fit.

**Gates:**

- `pnpm check` **EXIT 0** — web 432/432, API 655/655
- Full integration on a pristine migrated DB — **67 files / 583 tests** (was 66/578)
- `upgrade-proof.sh` **PASSED** — six new hostile inserts rejected (F1 mismatched activity; F2 no
  evidence, both paths at once, foreign media; F4 cancelled head) **and the explicit manual muster
  ACCEPTED**, so the seals are precise rather than merely strict. Every prior
  Phase-1..Phase-4-T3 rejection still passes.
- `test:e2e:api:allmodules` **31/31**; `:outbox` **25/25** (one earlier `:outbox` run failed; two
  subsequent runs were clean at 25/25 — reported as observed)
- Tripwires green: `media.workflowParticipants` gains `labour`, and the media unit test carries the
  new participant stub

## Boundary and scope

No module gains a synchronous read of another's tables. Labour stays a LEAF (`dependsOn: []`): the
requirement head arrives through `ActivityParticipant`, and the media seal is invoked *by* media
into Labour. Tasks 1–2 are untouched. No frontend, no Team gate, no coverage read — Task 4 remains
blocked and does not begin until an explicit GO.
