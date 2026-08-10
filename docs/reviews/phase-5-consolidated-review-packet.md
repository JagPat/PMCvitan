# Phase 5 — Commercial Control — Consolidated Review Packet

The Phase-5 review stop for the COMMERCIAL SPINE (plan
`docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md`). It maps the plan's design
decisions §A–§M and the design spec's §25 pilot acceptance criteria to delivered, independently
reviewed evidence across Tasks 1–7.

**It does not close the phase.** Two §M browser surfaces are parked with their findings named —
7B-v (the §I payment-rule authorisation form) and 7B-vi (the §H vendor advance control) — and both
are marked at every point they touch below. Every §G bound and §F derivation they concern is
enforced on the server and delivered. **§I is the exception and it is not only a browser gap:**
`commercial.sod.grant` does not check that a `certifier-may-not-approve` grant names the actual
certifier, so an unspendable grant can be recorded. That server guard is 7B-v's, alongside the
picker. See §I below and `docs/reviews/phase-5-t7b-v-parked-findings.md`; 7B-v proves the gap RED
against live PostgreSQL before closing it, per the plan's deferred-probe row.

Phase 5's outcome, in the spec's own terms: *budget, commitment, measurement, bill verification,
certification, payment approval, payment status and cash forecast trace to operational evidence.* A
vendor bill is never a payable on its own — it is bounded by ordered authority (Phase 3), accepted
delivery (Phase 3) and measured work (Phase 4), and only certification turns a bounded claim into
money anyone may approve.

## 1. Delivery record

| Task | Scope | Final state |
|---|---|---|
| 1 | `commercial` capability + SINK module + `CostHead` + commitment attribution (§B/§C/§L) | merged and cleared |
| 2 | Versioned immutable `BudgetLine` + `COMMITTED` fold + the over-budget exception (§B/§J) | merged and cleared |
| 3 | `Measurement` (§D) + the two withdrawal guards | merged and cleared |
| 4 | `VendorBill` + immutable versions + §G bounds 1–2 (§F/§G) | merged and cleared |
| 5A/5B/5C | §E three-way verification · certification + §I override · §H deduction ledger | merged and cleared (5A took five correction rounds and nineteen findings) |
| 6A/6B-i/6B-ii/6C | Payment approval + records · §F status derivation · reversals · advances (§G/§H) | merged and cleared |
| 7A | §J cash forecast + the EIGHTH rebuildable projection | merged and cleared |
| 7B-i/7B-i-a/7B-ii-a/7B-ii-b | The §M hub: money position, then the claim lifecycle tabs (READ ONLY) | merged and cleared |
| 7B-iii-a/b/e/c-i/c-ii/f/g/h/d | The §M write actions and the two-key outbox lifecycle, split by actor workflow | merged and cleared |
| 7B-iv | The approver's authority (contract first), the pilot acceptance chain | merged and cleared (five review rounds; two surfaces split out) |
| 7B-v | The §I PAYMENT-rule authorisation surface | **parked whole with five named findings — NOT delivered** |
| 7B-vi | The §H vendor advance surface | **parked whole with one named finding — NOT delivered** |

Every PR rode the exact-head `codex-current-head` gate — draft → CI green → orchestrator promotes →
Codex reviews the exact SHA → clean +1 → auto-merge. No human technical approval substituted for the
gate at any point.

## 2. Design decisions §A–§M → evidence

### §A — decimal money, end to end
`Decimal(18,2)` in PostgreSQL, decimal STRINGS on every wire, `Prisma.Decimal` in every fold. No
figure passes through float64 anywhere, including read projections. The client compares in
bigint-scaled paise (`lib/decimal.ts`) — a round-1 helper that converted through `Number` lost paisa
on large values and was replaced.

### §B — budget as versioned immutable lines; commitments attributed
A budget revision is a new row, never an edit. Every purchase-order line names the cost head that
carries it **at issue**, because issuing is what makes it a commitment; `commercial/attributions`
re-classifies an existing one and cannot create the first. The over-budget exception is raised, not
suppressed.

### §C — `COMMITTED` is a fold, never a column
Derived from the attribution register plus each line's live ordered quantity. Re-attribution
supersedes and inserts; the whole register including superseded history is readable, so a reader can
explain how a line reached its current head.

### §D — measurement, with two withdrawal guards
A labour claim's evidence is measured work. Withdrawing a sign-off or a measurement that a live
claim rests on is refused rather than silently stranding the claim.

### §E — three-way verification, derived on every call
`ordered · accepted/measured · billed`, with six exception kinds. Never stored: a stored verdict is
stale the moment a receipt is reversed. `duplicate-claim` compares per `(bill, PO line)` aggregate.

### §F — status is DERIVED from three folds
`NET_PAYABLE`, `APPROVED`, `PAID`. Task 6B stopped anyone writing a bill's payment status; it is a
function of the folds, and labels recycle (a claim returns to a status it has left) which is why the
monotonic `lifecycleVersion` exists beside them.

### §G — the five conservation bounds
1–2 bound a claim against ordered authority and accepted/measured evidence; 3 caps certification at
what is billed; 4 caps approvals at `NET_PAYABLE`; 5 caps payment at what **that** approval
authorised, net of reversals. Each is re-derived under a lock at the moment of the write, and the
§M surface compares against the same quantity rather than a proxy for it.

### §H — deductions, releases, advances
A withholding is taken from a payable and given back as a RELEASE row, never an edit. An
`advance-recovery` carries a second, vendor-scoped ceiling: what the counterparty still owes back
across every claim. An advance itself has no bound — it is a commercial decision about a
relationship — and what IS bounded is the recovery.

**PAYING an advance is delivered; READING the ledger is parked with the surface.** `POST
commercial/advances` exists and the recovery ceiling is enforced on the server, so no §G bound and
no §H rule is outstanding. What 7B-vi owes is the whole advance SURFACE — the list route
(`GET commercial/advances` and `listAdvances` were removed with the control, so there is currently
no way to hydrate or reconcile advance rows), the browser control, and a coalesce identity that
does not enumerate a subset of the row-defining facts: the parked one collapsed two advances
differing only in method or reference into a single action.

### §I — separation of duties, modelled rather than banned
Two rules, deliberately distinct: `evidence-recorder-may-not-certify` and
`certifier-may-not-approve`. A grant issued for one is refused for the other. Every exception is
attributable, records the claim state its approver reviewed, and is refused if the claim has moved
since. A self-grant is impossible.

**Both rules are ENFORCED where they are spent. What is parked is issuing a payment-rule grant
that is guaranteed spendable — on the server as well as in the browser.** `commercial.sod.grant`
checks that the excused actor holds standing for the act the rule names, but not that, for
`certifier-may-not-approve`, they ARE the certifier. `approve()` consumes such a grant only when
`certificate.certifiedById === actor`, so a grant naming anyone else is recorded, displayed, and
never spendable. **That guard is 7B-v's, and it is a SERVER change** — the browser picker narrowing
to the certifier is the same rule's other half, not the whole of it.

The §M grant form issues `evidence-recorder-may-not-certify` only. The payments tab reports the
payment-rule refusal accurately and names the API as its remedy. An accurate refusal with no in-app
remedy is a gap; a form that offers the authority and writes a grant nobody can spend is a defect.
Phase 5 takes the gap, and 7B-v closes both halves.

### §J — the cash forecast as the eighth rebuildable projection
Projected rather than folded on call, because the Inbox, dashboard and portfolio ask it for every
project on every load. Live == projection == rebuild by construction; a rebuild emits no events.

### §K/§L — capability activation is not a flag flip
Enabling `commercial` on a project that already holds live purchase orders must attribute them in
the same transaction, so the activation takes a PLAN as input and a real operator identity, and
refuses while any live line is unattributed.

### §M — the hub, and the write-ahead discipline
Seven tabs over six tasks of facts, with the two-key outbox lifecycle (a fresh `idempotencyKey` per
deliberate action, a deterministic `coalesceKey` while pending), latest-request ownership, scope
teardown, flush reconcile and hydration normalisation. Every key settles on a read that carries its
effect — and where no such read existed (the advance), the answer was to add the read rather than
make the key cleverer. **That read is PARKED with 7B-vi, not delivered**: `GET commercial/advances`
and `listAdvances` were removed with the control in the 7B-iv split, so the principle stands and
its one instance is still owed. 7B-vi lands the read before the control, for exactly the reason the
principle exists.

## 3. §25 pilot acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| a claim cannot be paid without traceable operational evidence | §E verification derived on every call; §G bounds 1–2 re-derived under lock; the pilot chain walks receipt → acceptance → claim → verification |
| authority for money leaving is explicit and attributable | §G bounds 3–5; §I's two rules, both exercised in the browser chain with attributable grants |
| a correction is a new fact, never an edit | append-only claim versions, release rows, payment reversals, superseding certificates |
| the money position is answerable at any moment | `commercial.money-position` from ONE repeatable-read transaction; the §J forecast projection |
| the pilot is opt-in and inert elsewhere | §D capability gating, proven in the acceptance chain's non-pilot project (no nav, reads 404) |

**Two §M surfaces are outstanding and neither weakens a criterion above:** the authority rules and
conservation bounds are the SERVER's and are enforced whichever route reaches them. 7B-v and 7B-vi
are about which acts a browser offers, not about what the product permits.

## 4. The pilot acceptance chain

`apps/web/tests/e2e-api/commercial-pilot.spec.ts` — real browser, live PostgreSQL, both capability
states. **32/32 outbox · 32/32 consecutively (re-runnable) · 32/32 legacy.**

The browser drives verification → certification → withholding → approval → payment → reversal. The
fixture stops at `submitted` deliberately: everything after it is what §M exists to put in front of
a person, and API-driving the interesting half would prove the API rather than the surface.

The advance leg left with 7B-vi. §H advances stay exercised through the API, but the browser chain
no longer covers a control the browser does not offer — a chain that walked a parked surface would
be asserting a capability the product does not have.

Four product rules the chain surfaced, none of them test detail: **§L** activation demands a plan
and a real operator identity; **§B** a PO cannot be issued with an unattributed line; **§I twice** —
the evidence recorder may not certify and the certifier may not approve, so a one-person site needs
both exceptions, each granted by a second pmc (through the API, per §I above) against the claim
state as it stood at that moment; and **ordering** — `materials` must be enabled before
`commercial`, the phase dependency appearing in the operator's runbook.

Every §F transition is confirmed landed against the server before the next control is touched: a
write-ahead surface reports a click as saved, so "the button was clickable" is not evidence the
claim moved.

## 5. What this phase cost, and what the record says about why

The 7B frontend was split four ways and then 7B-iii nine ways, on measured evidence each time. The
splits worked where they were drawn by a dependency and not by a module boundary — the lesson
7B-iii-b paid twenty-five findings over seven heads to learn, written into STATUS as three rules.

The last unit, 7B-iii-d, took four finding-bearing heads and twenty-one findings; its convergence
audit (`docs/reviews/pr-316-convergence.md`) names three roots in sequence: coverage (a rule reached
the controls I was holding in mind, not the set), **fidelity** (each gate compared the nearest
available signal rather than the predicate the server tests), and **temporal assumption** (each gate
was reasoned out against a world that holds still, when the write-ahead outbox exists precisely
because it does not).

Fidelity is the root that changed this phase's shape. Three of its findings could not be fixed on
the client at all — the quantity the gate needed was not in the contract — and all three landed on
exactly two controls. That drew the 7B-iii-d / 7B-iv seam: **the seam is where the client's
information runs out.** 7B-iv answers it contract-first with `VendorBillDto.lifecycleVersion` and an
`approvePreflight` carrying the payment rule's grant state — after which the approve gate compares
exactly what the server compares, and the freshness guard rounds 3 and 4 argued over becomes
complete rather than partial. The third fact, the vendor advances read, was built and then **parked
with 7B-vi**; the seam it belongs to is that unit's, not this one's.

The rule the phase leaves behind: *a gate may only compare the quantity the server compares; if that
quantity is not in the contract, the contract is the fix, never a nearer-to-hand stand-in.*

## 6. What comes next

Authoritative version in `docs/STATUS.md`; the decision in brief.

The two "external" phases are not equivalent, and which kind of external each means decides the
order. **Phase 6 — external COLLABORATION** (external people and companies using Vitan itself:
scoped supplier/contractor access, guest `Company` → own `Organization` promotion) **is in this
release and is next.** **Phase 7 — external-SYSTEM integration** (accounting, GST, bank,
RedBracket; §23's Stage-2 boundary) **is deferred future-version scope.** Neither is completed.

Order: **Phase 5 → Phase 6 → standalone-V1 completion gate + integrated live-pilot release.** The
gate runs after Phase 6 so collaborator access and tenancy are inside what it certifies, and it
covers the whole product rather than this packet's browser chain.

**Phase 6's authority rule, recorded before any of it is designed:** a collaborator surface widens
who can SEE and SUPPLY — never who can certify a claim or release money. Internal authority for
verification, certification, approval and payment stays attributable and cannot be delegated
accidentally. That is §I and the §G bounds applied to a wider audience, which is the sense in which
Phase 5 was Phase 6's prerequisite.

**Integration capability is preserved; integrations are not built.** Versioned contracts and events,
the outbox, adapter boundaries, idempotency and reconciliation, auditability and configuration seams
all stay and stay tested — while this release adds no vendor-specific adapter, no external
credentials, no external schema assumptions and no external calls.

## 7. Gates at this head

- `pnpm check` EXIT 0.
- Full API unit suite and the commercial integration suites green on live PostgreSQL.
- `commercial-pilot.spec.ts` green in CI on the merged head (`api-e2e`, `e2e`).
- No migration in 7B-iv; the contract additions are additive.
- **Phase 5 is not closed by this packet.** 7B-v and 7B-vi remain, each parked whole at its reviewed
  head with its findings named: `docs/reviews/phase-5-t7b-v-parked-findings.md` and
  `phase-5-t7b-vi-parked-findings.md` — **both land on `main` in this PR**, having been written on
  the park branches where a reader of `main` could not reach them. A hand-off that lives only on
  the branch it hands off from is not a hand-off. The closing PR's own review found three claims in
  this packet that the repository did not support; the root is in `docs/reviews/pr-318-convergence.md`
  — **a record may only claim what the repository actually contains**, which is PR #317's gate-fidelity
  lesson one level up. The lineage's own lesson is recorded in
  `pr-317-convergence.md`: **derive an identity from the whole payload, never enumerate its fields**
  — a rule this unit broke four times, twice inside the correction for it.
