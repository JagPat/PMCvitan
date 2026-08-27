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

**And "own" does not exist yet either — anywhere.** `recordWork` validates project
membership, allocation liveness and live-demand match; `recordOutput` validates that the
activity belongs to the project; **neither ties the record to the calling user**, and the
schema has no relation from an app `Membership` to a worker, crew or supplier that could.
With multiple contractors on one project, contractor A could today submit contractor B's
allocation or activity id and create immutable effort/output evidence against it — the
grants are safe only because no UI reaches them. Filtering the new reads is NOT write
authorization: the ownership relation must be defined in the schema and **enforced inside
each write transaction**, or the capture surface must not ship.

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

**O2, staged as three units, in this order, and none starts as a side effect of another:**

1. **The ownership relation, enforced at the writes** (server, schema): define what "own"
   means — a membership↔supplier attribution the schema currently lacks — and re-derive it
   INSIDE `recordWork`/`recordOutput`/`recordAttendance` transactions, so a contractor token
   is refused on another party's allocation, activity or worker regardless of what any UI
   sends. Reproduce-first: the two-contractors probe (A submits B's ids) must be RED today
   and refused after. Nothing about pmc/engineer behaviour changes — the own-scope check
   binds the contractor role.
2. **The own-scope read contract** (server): the narrow queries above, policy named for what
   it is, 404/403 semantics matching the existing capability gates, with tests proving a
   contractor token can read its own capture context and can NOT read any commercial or
   planning surface (the adversarial case is the point of the unit).
3. **The capture surface** (web): the minimal UI over those reads, dispatching the three
   EXISTING commands through the existing outbox discipline — with attendance
   **device-evidenced per §1.4** (the worker's device participates, QR/tap; a new dispatcher
   carrying `deviceId`, since none exists), never a contractor-typed `manualReason`, which
   stays a pmc exception.

**The `activity.output.record` UI gap (§1.3) is recorded for whichever unit builds the
output surface for pmc/engineer** — it is the same missing dispatcher for all three roles,
and building it once behind `createOptionsFor`-style filtering serves everyone.

This proposal starts none of the three. All are product scope beyond evaluate-and-propose;
the ownership relation is a schema decision deserving its own review unit, and it comes
FIRST — the surface without it is the multi-contractor forgery §2 describes.

## 5 · Outside this proposal

- Any change to `ROLE_POLICY`, `screensFor`, or the Labour hub.
- The D1-Drawings filter (the D/E proposal's next unit) — unrelated track.
- Worker-device (`§H`) BINDING flows — anonymous onboarding and `orgs.workerDevice.bind` are
  untouched. (Unit 3 *uses* an already-bound device as attendance evidence, which is §C's
  existing contract, not a binding change.)
