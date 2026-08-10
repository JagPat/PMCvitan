# Phase 5 — Commercial Control — Consolidated Review Packet

The final Phase-5 review stop (plan `docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md`).
This packet maps the plan's design decisions §A–§M and the design spec's §25 pilot acceptance
criteria to delivered, independently reviewed evidence across Tasks 1–7.

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
| 7B-iv | Approve + advance (contract first), the pilot acceptance chain, this packet | **THIS review stop** |

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

### §I — separation of duties, modelled rather than banned
Two rules, deliberately distinct: `evidence-recorder-may-not-certify` and
`certifier-may-not-approve`. A grant issued for one is refused for the other. Every exception is
attributable, records the claim state its approver reviewed, and is refused if the claim has moved
since. A self-grant is impossible.

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
effect — and where no such read existed (the advance), the read was added rather than the key made
cleverer.

## 3. §25 pilot acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| a claim cannot be paid without traceable operational evidence | §E verification derived on every call; §G bounds 1–2 re-derived under lock; the pilot chain walks receipt → acceptance → claim → verification |
| authority for money leaving is explicit and attributable | §G bounds 3–5; §I's two rules, both exercised in the browser chain with attributable grants |
| a correction is a new fact, never an edit | append-only claim versions, release rows, payment reversals, superseding certificates |
| the money position is answerable at any moment | `commercial.money-position` from ONE repeatable-read transaction; the §J forecast projection |
| the pilot is opt-in and inert elsewhere | §D capability gating, proven in the acceptance chain's non-pilot project (no nav, reads 404) |

## 4. The pilot acceptance chain

`apps/web/tests/e2e-api/commercial-pilot.spec.ts` — real browser, live PostgreSQL, both capability
states, 32/32 in outbox mode, 32/32 consecutively (re-runnable), 32/32 in legacy mode.

The browser drives verification → certification → withholding → approval → payment → reversal, plus
a vendor advance that names no claim. What the chain surfaced is worth recording, because every item
is a product rule the spec had to obey rather than a test detail:

- **§L** activation demands a plan and a real operator identity.
- **§B** a PO cannot be issued with an unattributed line.
- **§I twice** — the evidence recorder may not certify, and the certifier may not approve. A
  one-person pilot site needs BOTH exceptions, each granted by a second pmc against the claim state
  as it stood at that moment (a different state each time, because certifying and withholding both
  move the revision).
- **ordering** — `materials` must be enabled before `commercial`, because a commercial claim is
  bounded by Phase 3's facts. The phase dependency showing up in the operator's runbook.

Every §F transition is confirmed landed against the server before the next control is touched: a
write-ahead surface reports a click as saved, so "the button was clickable" is not evidence the
claim moved.

## 5. What this phase cost, and what the record says about why

The 7B frontend was split four ways and then 7B-iii nine ways, on measured evidence each time. The
splits worked where they were drawn by a dependency and not by a module boundary — the lesson
7B-iii-b paid twenty-five findings over seven heads to learn, and which is written into STATUS as
three rules.

The last unit, 7B-iii-d, took four finding-bearing heads and twenty-one findings, and its
convergence audit (`docs/reviews/pr-316-convergence.md`) names three distinct roots in sequence:
coverage (a rule reached the controls I was holding in mind, not the set), **fidelity** (each gate
compared the nearest available signal rather than the predicate the server tests), and **temporal
assumption** (each gate was reasoned out against a world that holds still, when the write-ahead
outbox exists precisely because it does not).

The fidelity root is the one that changed this phase's shape. Three of its findings could not be
fixed on the client at all, because the quantity the gate needed was not in the contract — and all
three landed on exactly two controls. That is what drew the 7B-iii-d / 7B-iv seam: **the seam is
where the client's information runs out.** 7B-iv answers it contract-first, exposing
`VendorBillDto.lifecycleVersion`, an `approvePreflight` carrying the payment rule's grant state, and
the vendor advances read — after which each gate compares exactly what the server compares, and the
freshness guard that rounds 3 and 4 argued over becomes complete rather than partial.

The rule the phase leaves behind: *a gate may only compare the quantity the server compares; if that
quantity is not in the contract, the contract is the fix, never a nearer-to-hand stand-in.*

## 6. What comes next — final clarified owner direction, 2026-08-10

**The release target is a complete, production-usable Vitan platform for the owner's organisation
AND authorized external collaborators using Vitan itself.** The two "external" phases are not
equivalent, and the distinction is which kind of external each one means:

| Phase | What "external" means | Disposition |
|---|---|---|
| **6** — external collaboration | external *people and companies* using Vitan itself: supplier/contractor collaboration, tightly scoped access, guest `Company` → own `Organization` promotion where planned | **IN THIS RELEASE, and next** |
| **7** — external-system integration | external *software*: accounting, GST, bank, RedBracket or any vendor-specific adapter or live external API (§23's Stage-2 boundary) | **DEFERRED** future-version scope; not completed |

Order: **Phase 5 → Phase 6 → standalone-V1 completion gate + integrated live-pilot release.**

### Phase 6's authority rule, stated before any of it is designed

Phase 6 exposes **only project/company-authorized collaboration facts and actions.** The internal
authority for verification, certification, approval and payment stays attributable and **cannot be
delegated accidentally.** A collaborator surface widens who can SEE and SUPPLY — never who can
certify a claim or release money.

That is not a new rule; it is §I and the §G bounds applied to a wider audience. Phase 5 already
makes every one of those acts attributable to a resolved actor and refuses the forbidden pairings,
so Phase 6 inherits the guarantee rather than re-deriving it — which is exactly what "stable
internal workflows, permissions and audit trails are prerequisites for exposing the product to other
companies" meant in the phase intent map.

### Then the standalone-V1 completion gate

It runs **after** Phase 6, precisely so collaborator access and tenancy are inside what it
certifies. An evidence-led audit of the actual product, not a feature phase:

- administration and password login; project-scoped dashboard, inbox and schedule;
- decisions, drawings, inspections, activities and daily logs;
- materials, labour and commercial control;
- **collaborator access and tenancy**;
- cross-module reporting and projections; offline and error states;
- production migration, backup, restore, health, security and observability;
- onboarding and user documentation; and a real-project acceptance run.

It does not reopen cleared architecture and does not duplicate delivered modules.

### Integration capability is preserved; integrations are not built

What stays and stays tested: versioned public contracts and events, the transactional outbox,
adapter/connector boundaries, idempotency and reconciliation semantics, auditability, configuration
seams. What this release adds: **no vendor-specific adapter, no external credentials, no external
schema assumptions, no external calls.** That is what keeps Phase 7 cheap when it is wanted.

## 7. Gates at this head

- `pnpm check` EXIT 0.
- Full API unit suite and the commercial integration suites green on live PostgreSQL.
- `commercial-pilot.spec.ts` 32/32 outbox · 32/32 re-run · 32/32 legacy.
- No migration in 7B-iv; the contract additions are additive.
