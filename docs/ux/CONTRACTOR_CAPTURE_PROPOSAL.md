# Contractor capture: three grants with no road to them

A proposal, not a change. The Unit-C and D/E reviews surfaced — and their documents
deliberately left outside — a gap this evaluation now measures and closes with a
recommendation: **contractor holds three capture permissions with no UI route to any of
them.** Everything in §1 is measured from the code at `main` `0bbd6a2d`; §§2–4 propose.

---

## 1 · Measured

### 1.1 The grants, the routes, and the surfaces

| Action | `ROLE_POLICY` | Server route | Web dispatcher | Screen |
|---|---|---|---|---|
| `attendance.record` | pmc, engineer, **contractor** | `labour-capacity.controller.ts:53` | `LabourScreen` muster | `labour` |
| `labour.work.record` | pmc, engineer, **contractor** | `labour-capacity.controller.ts:76` | `recordWorkedMinutes` → `LabourScreen` | `labour` |
| `activity.output.record` | pmc, engineer, **contractor** | `activities.controller.ts:135` | **none — no web caller for ANY role** | — |

`screensFor('contractor')` is `inbox · drawings · places · team-access · decision-log`. It
contains neither `labour` nor `site-schedule`.

### 1.2 The gap is not just a missing screen

Handing contractor the Labour hub would not work, for a measured reason: **every read on it
is `labour.read`, granted to pmc and engineer alone** (`policy.ts:61`;
`labour.controller.ts:120,126`, `labour-capacity.controller.ts:110,121`). A contractor
landing on the hub would 403 on every tab. And the hub is the wrong room anyway: its seven
tabs include **suppliers and commitments — the §F commercial chain with frozen rates per
person-shift** — which is pmc/engineer planning material, not something to place in front of
the party on the other side of those rates.

### 1.3 One row of the table is a different gap

`activity.output.record` (§I `ActivityWorkOutput` — measured output with optional photo
evidence) has no web dispatcher at all: the route is exercised by the API suites and e2e,
and no role can reach it from the UI. That is an **all-roles** surface gap, not a
contractor-authorization gap, and it should not be solved as a side effect of one.

### 1.4 The attendance path a contractor can actually use

The muster command has two evidence branches, and they are NOT equally available
(`labour-capacity.service.ts:513-524`): a `manualReason` muster is a **pmc exception** — the
service asserts `labour.override`, granted to pmc alone (`policy.ts:79`) — while the
`deviceId` branch (the worker's OWN bound device) is the path left open to the site roles.
The web's only muster dispatcher, `musterWorker`, **always sends `manualReason`**, and no web
dispatcher sends `deviceId` at all. So even with a screen, the only existing dispatch path
403s a contractor by design. The consequence for §4: a contractor attendance capture must be
**device-evidenced with the worker's device participating** (the §H QR/tap shape that
anonymous onboarding already uses), and manual musters stay what they are — a pmc exception.
A capture flow that merely *cited* a worker's bound `deviceId` without the device in the loop
would satisfy the seal while hollowing out the evidence, and is refused here by name.

### 1.5 Why the grants are intentional

The cleared Phase-4 architecture names attendance, effort and output as **site facts** —
"something happened and a site user records it as it happens" — and §C's seals make the
records safe to accept from the party performing the work: a muster must cite the worker's
OWN bound device or an explicit pmc-attributable manual reason; worked minutes are capped by
`Σ workedMinutes ≤ shiftMinutes` re-derived under the worker lock; output is immutable with
delete-sealed evidence. The DB does not trust the recorder; that is precisely what makes a
contractor-side recorder admissible. Trimming the grants would re-litigate a cleared
decision.

---

## 2 · The shape of the fix

What a contractor needs is not the Labour hub. It is **capture with the context those three
records require**: today's own allocations (to record minutes against), the workers on their
own crews (to muster), and the activity being worked (for output). None of that is
`labour.read` — it is a narrower, own-scope read that does not exist yet.

**And "own" does not exist yet either — anywhere, at either end.** `recordWork` validates
project membership, allocation liveness and live-demand match; `recordOutput` validates that
the activity belongs to the project; **neither ties the record to the calling user**, and the
schema has no relation from an app `Membership` to a worker, crew or supplier that could.
With multiple contractors on one project, contractor A could today submit contractor B's
allocation or activity id and create immutable effort/output evidence against it — **and
"today" means the API, not a hypothetical UI**: the three routes are authenticated commands
a contractor bearer token can POST directly on any labour-enabled project; the missing web
dispatcher is an absence of convenience, not a guard. Filtering the new reads is NOT write
authorization: the ownership relation must be defined in the schema and **enforced inside
each write transaction** — and until it is, the server must fail closed for contractor
callers (§4 unit 0), because immutable evidence forged through the open routes cannot be
un-recorded later.

**The relation must bind the WORKERS, not just the memberships.** A membership↔supplier link
alone cannot enforce attendance ownership, because the other end is missing too: `Worker`
and `Crew` carry **no supplier or party identity** (`schema.prisma:2662,2716`), and an
in-house `WorkerAllocation` legitimately has `capacityCommitmentId = null` — so for such a
worker there is NO derivable path from any membership to the worker, and a
membership-side-only check must either reject the contractor's own legitimate muster or keep
accepting another contractor's worker id. The attribution has to be **project-contained on
the worker/crew side**, with membership↔party closing the loop — and the party anchor is
the orgs-owned association that already exists for exactly this purpose: `ProjectParty`,
which is SOURCE-JUSTIFIED (`ProjectPartyCompanySource`/`ProjectPartyVendorSource`) and
deleted by `OrgsParticipant.releasePartyAssociationIfUnsourced` (`orgs.participant.ts:419`)
when its last justification goes. A bare FK from `Worker`/`Crew` into that lifecycle would
make removing a project's last contractor company either fail on the FK or cascade away the
ownership evidence that authorizes capture — so the attribution must add a **labour
justification source of its own** (registered through the owning module's participant
channel, never by Orgs reading Labour tables), with an explicit release protocol for
removing a contractor company that still owns workers (§4 unit 1).

## 3 · Options

**O1 — give contractor the `labour` screen.** Refused by measurement: 403 on every tab
without widening `labour.read`, and widening it hands the §F commercial chain — supplier
rates — to the supplied party. Wrong on both sides.

**O2 — a narrow contractor capture surface.** New own-scope reads (my active allocations
today; my crews' workers; nothing commercial, nothing planning) behind a new
`labour.capture.read`-shaped policy, and a minimal capture UI — the C1 pattern: few
questions, inherited context, honest disabled states. Where it lives (a contractor tab on an
existing screen vs. a small new screen) is an implementation decision for the unit that
builds it; what is settled here is the **contract**: capture-only reads, no rate ever
serialized to a contractor token.

**O3 — trim contractor from the three grants.** Refused: it contradicts the cleared
architecture's intent (§1.4), and the seals that make contractor recording safe are already
built and reviewed.

## 4 · Recommendation, and what the next unit is

**O2, staged as seven units, in this order, and none starts as a side effect of another.**
Each migration is its own unit by the repository's mandatory seam — every schema change is
additive and nullable, so the old release serves against it untouched, and no
inseparable-unit justification exists or is claimed:

0. **Fail closed now** (service only, no schema): the three writes are OPEN at the API
   today (§2) and create immutable evidence, so before any attribution work begins, each
   service refuses a CONTRACTOR caller outright — a named, tested refusal inside the same
   transactions that will later hold the ownership check. This is NOT O3: the grants stay
   declared and pmc/engineer behaviour is untouched; the refusal is temporary by
   construction, lifted per-command by the unit that makes the call safe (unit 4 for worked
   minutes and output, unit 6 for attendance — with unit 6's rollout sequencing below).
   Reproduce-first: the contractor-token POST of another party's id that SUCCEEDS today is
   the RED probe.
1. **The attribution shape** (additive migration ALONE, no service change): the
   project-contained party reference on `Worker`/`Crew`, the membership↔party link, and the
   party-snapshot columns on the two WORKER-CARRYING evidence tables (`LabourAttendance`,
   `LabourWorkFact`; the output snapshot is unit 3's, below) — anchored on `ProjectParty`
   with a NEW labour justification source and its release protocol (§2 — removing a
   contractor company that still owns workers is a defined refusal-or-reassignment, decided
   through the participant channel, never an FK accident and never Orgs reading Labour
   tables). Nullable, additive, diagnostic-first, writing no rows. Four DB seals belong to
   this SAME migration or the shape is not what it claims, because during the mixed-version
   window the OLD release and any alternate writer keep writing these tables with no
   knowledge of the new columns:
   - **the append-only triggers extend over the new columns** — the §C triggers freeze
     evidence by ENUMERATED column comparison (`phase4_t3_attendance_append_only` and
     siblings), so a party snapshot left out of that enumeration is silently mutable,
     exactly the reattribution the snapshot exists to prevent;
   - **the DB is the ONLY writer of the snapshot** — a BEFORE INSERT trigger derives it
     from the worker's binding for EVERY writer, old release included (writers never supply
     it), recording the party bound AT THE MOMENT OF INSERT and NULL while the worker is
     unbound — which is then the truth of that moment: evidence recorded before a worker
     was ever bound is pre-attribution history, attributed to no party and never
     retroactively rewritten (unit 2's backfill binds rosters BEFORE unit 4 ever trusts a
     snapshot, so no contractor authority is derived from the unbound era);
   - **the derivation SERIALIZES against rebind at the DB** — the trigger reads the binding
     row `FOR SHARE`, which conflicts with the row-level lock any rebind UPDATE must take,
     so even an OLD-release insert either completes before a rebind (whose reliant-evidence
     guard then sees the new row and refuses) or blocks until the rebind commits and
     derives the NEW party — the guard-vs-first-fact race is closed for every writer, not
     only the new services;
   - **crew-party equality is a DB seal, not a service promise** — the same-project
     composite FKs on `CrewMembership` and `Crew.inchargeWorkerId` prove only shared
     `projectId`, so an old instance or direct SQL could join a party-A worker to a party-B
     crew; BEFORE INSERT/UPDATE triggers on membership AND in-charge compare the worker's
     bound party with the crew's (null-strict: null equals only null) and refuse the
     mismatch, so the inconsistent roster row is unrepresentable rather than filtered.
2. **The binding commands** (service only, schema untouched): the population path —
   pmc-authored, tenancy-checked `bind`/`rebind` commands for worker↔party, crew↔party and
   membership↔party, with the backfill on existing projects binding a crew and its active
   memberships in ONE transaction (the unit-1 equality seal refuses anything else) —
   because references that nothing can write leave the later units vacuously green and the
   capture context empty. The invariants: **the binding is FROZEN once evidence relies on
   it** — the initial bind is explicit and attributable, a rebind is a CAS lifecycle
   (release + new bind, audited) whose reliant-evidence guard re-derives under its own row
   lock, made race-free against every concurrent first-fact insert by unit 1's `FOR SHARE`
   seal (rebind ships HERE only because that DB-side serialization is already in place —
   service-side lock discipline alone could not cover the old release's writers) — and
   **one ownership authority** — the WORKER's party is authoritative; the crew's party is a
   derived convenience the unit-1 seal keeps consistent (`labour.service.ts:229` today
   checks only project containment for `inchargeWorkerId`).
3. **The output attribution shape** (additive migration ALONE): `ActivityWorkOutput`
   carries NO worker or allocation fact (`contracts.ts:1260` — activity, date, shift,
   quantity), so unit 1's derivation has nothing to read there and its snapshot cannot ship
   in unit 1 honestly. This migration adds the nullable allocation-reference and
   party-snapshot columns to `ActivityWorkOutput`, extends ITS append-only trigger over
   them, and derives the snapshot from the cited allocation's worker binding when the
   reference is present (old-release and pmc/engineer inserts carry no reference and commit
   with a null snapshot — legitimate: their attribution stays the recording principal, and
   contractor output remains refused by unit 0 until unit 4 makes the reference mandatory
   for contractor callers).
4. **The ownership enforcement** (service only, schema untouched): re-derive "own" INSIDE
   the `recordWork`/`recordOutput`/`recordAttendance` transactions from the unit-1
   relations, so a contractor token is refused on another party's allocation, activity or
   worker regardless of what any UI sends — and this lifts unit 0's refusal for worked
   minutes and output. Two requirements are part of the check, not optional hardening:
   **the record path locks the binding rows it derives authority from** (the same rows
   rebind locks — the service-level discipline on top of unit 1's DB seal, both orderings
   proven under the deterministic barrier); and **the output reference is slice-bound** —
   `recordActivityOutputSchema` carries its own `civilDate`/`shift`, so "a live allocation
   on that activity" is not enough (contractor A's Monday/day allocation must not authorize
   an output recorded for Friday/night): the allocation's project, activity, civil date and
   shift must ALL match the output, or the output derives those fields from the cited
   allocation — validated through the cycle-exempt participant channel, never by Activities
   reading Labour persistence. Reproduce-first: the two-contractors probe (A submits B's
   ids, for each of the three commands) is refused; the wrong-slice output probe is
   refused; an in-house (no-party) worker's records stay pmc/engineer-recordable and are
   NOT silently opened to any contractor. Nothing about pmc/engineer behaviour changes.
5. **The own-scope read contract** (server): the narrow queries above, policy named for what
   it is, 404/403 semantics matching the existing capability gates, with tests proving a
   contractor token can read its own capture context and can NOT read any commercial or
   planning surface (the adversarial case is the point of the unit).
6. **The capture surface** (web + server contract): the minimal UI over those reads. The
   attendance path needs more than a new dispatcher: **a contractor JWT carrying a
   `deviceId` is citation-only evidence however the UI dressed it** — an id observed once
   replays while device and worker are absent, and the server verifies only that the id is
   bound to the worker. So the server contract is EXTENDED with a fresh device-authenticated
   proof (the device attests through its own authenticated channel — the credentialed shape
   the §H device flows already use — or signs a server-issued nonce), and the muster command
   accepts device evidence only in that form from a contractor token — lifting unit 0's
   refusal for attendance last. `manualReason` stays a pmc exception. **The lift and the
   surface must not ship as one mixed-version step**: the client outbox classifies every
   4xx except 401/408/429 as terminal and drops the operation, so a legitimate device-proved
   muster routed to a still-serving OLD instance would hit unit 0's 403 and be LOST, not
   retried — the attendance action is therefore enabled only once every serving API accepts
   the proof (the UI gates on the server's advertised contract, not on its own release
   version), or the transitional refusal is made retryable for exactly this window. Until
   unit 6 lands, attendance capture is refused at the server (unit 0) and absent from the
   surface — worked minutes and output (units 1–5) do not wait for it.

**The `activity.output.record` UI gap (§1.3) is recorded for whichever unit builds the
output surface for pmc/engineer** — it is the same missing dispatcher for all three roles,
and building it once behind `createOptionsFor`-style filtering serves everyone.

This proposal starts none of the seven. All are product scope beyond evaluate-and-propose;
the fail-closed guard comes FIRST because the forgery window is open at the API today, the
attribution shapes are schema decisions each deserving its own review unit, the surface
without units 1–4 is the multi-contractor forgery §2 describes, and an attendance path
without unit 6's device-authenticated proof is the citation-only evidence §1.4 refuses.

## 5 · Outside this proposal

- Any change to `ROLE_POLICY`, `screensFor`, or the Labour hub.
- The D1-Drawings filter (the D/E proposal's next unit) — unrelated track.
- Worker-device (`§H`) BINDING flows — anonymous onboarding and `orgs.workerDevice.bind` are
  untouched. (Unit 6 *uses* an already-bound device as attendance evidence — with the fresh
  proof §4 requires — which is §C's existing contract, not a binding change.)
