# Phase 5 Task 1 — the commercial capability, cost heads and the §C commitment attribution

Base `main` `60864b5` · branch `claude/phase5-task1`

Task 1 of the Phase-5 plan
(`docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md`), scoped by the
execution table's first row and by §L's placement argument:

> **Task 1 owns the `CommitmentAttribution` table, its XOR/uniqueness seals, the
> `CommercialParticipant` write path, the activation backfill AND the forward
> issue/amend/cancel/close-short participant hooks**; Task 2 owns what READS them.

**No `BudgetLine`, so no headroom and nothing to except.** That is §L's other half:
an earlier plan revision left the versioned budget here while the fold and the
over-budget exception stayed in Task 2, so a Task-1 deployment could produce −₹40
of headroom with nothing in the tree to report it. A budget you can revise but
whose breach nothing reports is worse than no budget, because the number looks
authoritative.

## Vision alignment

One fact has one canonical owner. §C's whole argument is that the committed amount
**already exists** — frozen, with provenance, on the Phase-3/4 PO-line snapshot —
so Phase 5 adds exactly one new fact: which cost head carries it. The attribution
therefore carries **no amount column at all**. "The amount is not copied" is the
rule; a column to copy it into is how the rule gets broken, and an earlier plan
revision listed `amount` among the frozen columns, which would have created the
second committed-amount ledger §C exists to forbid, with the freeze trigger then
preserving whatever a bad issuance wrote.

Money follows the site; it does not command it. `commercial` is a **SINK**: it
reads procurement, inventory, labour and activities, and nothing reads it. No
readiness gate consults it, and probe 2 pins that enabling the capability moves no
gate in either direction.

Attributable human decisions are preserved. A reclassification is a new row plus an
attributable supersession stamp — never an in-place edit that moves recorded
history with no evidence that it moved.

## §C — what the database enforces

| Rule (§C / §0b) | Mechanism | Probe |
|---|---|---|
| Exactly ONE attribution target | `CHECK (("poLineId" IS NULL) <> ("labourPoLineId" IS NULL))` | 5bi + upgrade proof |
| Exactly one ACTIVE attribution per line | two PARTIAL uniques, one per TARGET | 5u / 5y / 5aj + upgrade proof |
| The amount is not copied | there is no column to copy it into (`information_schema` asserted) | 5bi + upgrade proof |
| The attribution is EVIDENCE | `CommitmentAttribution_append_only`: DELETE always refused; UPDATE refused except the ONE transition | 5ai + upgrade proof |
| A key that groups money is FROZEN | `CostHead_key_frozen` (the unreferenced rename the FK cannot reach) | 5ai + upgrade proof |
| A supersession is attributable | `supersede_complete` CHECK — all three columns or none | upgrade proof |
| Non-blank text | `btrim(x, E' \t\n\x0B\f\r')` on `reason`, `supersedeReason`, `CostHead.code`/`name` | upgrade proof |
| Tenancy | same-project composite FKs to both PO-line tables and to `CostHead` | upgrade proof |

**The seal is on EVERY row from insertion, not only once superseded.** This is the
one place the plan explicitly corrected itself, and the implementation follows the
correction rather than the earlier spelling: the ACTIVE row is precisely the one an
in-place `CIVIL → MEP` edit would move, and it is not superseded at the moment of
the edit. So DELETE is refused always and UPDATE is refused always **except**
stamping an active row superseded — and probe 5ai proves both arms, including the
**piggyback**: smuggling a cost-head or reason change inside an otherwise-legitimate
supersession stamp. Without that second arm the seal would forbid only the naive
edit while reclassification could still move history in one row, leaving no
replacement and no evidence. That case is not in the plan's probe text; it is the
attack the trigger's shape invites, so it is tested.

## §0b closure — all EIGHT lifecycle sites, one channel

§0b's first row is the acceptance criterion, and it names four sites for each
pipeline. All eight go through `CommercialParticipant`:

| Site | What it does | Why not later |
|---|---|---|
| `pos.issue` · labour PO issue | writes the initial attribution **in the issuing transaction** | a PO version becomes live at issue; a separate command would leave every new order a live unattributed obligation reading ₹0 committed |
| amend (both) | supersedes v1's attribution and writes v2's atomically | an amendment retains v1's line, so both would stay active and a ₹100 order would read ₹200 |
| close-short (both) | supersedes and re-attributes on the SAME line | the obligation changed size; that is recorded attributably rather than left behind a moved amount |
| cancel (both) | supersedes without replacement | a cancelled version is not live — this is the one site where releasing is correct, and it is not §C's forbidden "revocable to nothing" |

Probe 5aj drives all four labour sites in order and is **RED against an
implementation that attributes on issue only** — the shape the plan warns a Task-2
reader could otherwise pass while a cancelled ₹100 order still reported ₹100
committed.

**Authority follows the WRITE, not the route.** The participant enforces
`commercial.attribute` exactly as the standalone re-attribution route does, so a
user holding PO-issue authority but not `commercial.attribute` cannot choose the
cost head during `pos.issue` and mutate budget evidence through a side door
(probe 5ar).

## §L — activation attributes what already exists

Enabling `commercial` is not a no-op. A pilot project can already hold live
material and labour POs, and §C only writes the initial attribution during FUTURE
issuance — so flipping the flag would leave those obligations unattributed,
`COMMITTED(costHead)` reading ₹0 and the budget exception silently missing every
existing commitment. That is the "observational not operational" defect Phase 3
Task 7 was blocked for, entered backwards.

And the enable path must be able to **succeed**, not only refuse: while the
capability is off there are no commercial routes, so an operator told to go and
choose a cost head has no surface on which to choose. The mapping is therefore
INPUT (`capability:enable --capability commercial --plan <file.json>`), created and
attributed in the same transaction as the capability row. Activation refuses ONLY
when the mapping leaves a live line unmapped, and it **names** those lines.

Probe 5bd proves both directions: the incomplete plan refuses naming the labour
line and rolls the WHOLE transaction back (no capability row, no cost heads); the
complete plan succeeds and is safe to re-run; a draft-only project needs no
mapping. The operator resolves to a real `User` row by id or email, so every
backfilled attribution is attributable to a person rather than to a string.

## §K — the module graph

The manifest is generated from §K's edge table, which the plan states is the single
declaration of it. `module-registry.test.ts` asserts the exact edge set (probe 5x)
and runs Kahn's algorithm over the LIVE manifests.

- `commercial.dependsOn: ['procurement', 'inventory', 'labour', 'activities']`
- `commercial.workflowParticipants: ['inventory', 'activities', 'procurement', 'labour']`
- `procurement` / `labour` / `activities` / `inventory` each gain `commercial`
- **no module's `dependsOn` gains `commercial`** — that asymmetry is what makes it a SINK

The four OUTBOUND participant edges are declared now although their calls land in
Tasks 3 and 5. That is the plan's own choice and worth stating plainly: a
transaction-bound call must be DECLARED or the manifest says it cannot happen, and
taking the fallback plain read instead would reopen the race the participant exists
to close. The alternative is amending the manifest in four later tasks and
re-litigating the edge table each time.

**One fold, two owners.** `ProcurementQuery` (new) answers for material PO lines and
`LabourQuery` for labour ones. An earlier plan revision said "through
`ProcurementQuery`, always", which would have left Task 2 either omitting live
labour POs from `COMMITTED` or having procurement read labour-owned rows.

## Invariant matrix

| Invariant | Where it is enforced | Evidence |
|---|---|---|
| authorization-tenancy | `commercial.manage`/`attribute`/`read` in `ROLE_POLICY`, enforced at the route AND in the participant (the write, not the route); same-project composite FKs make a cross-project attribution unrepresentable | probe 5ar; upgrade proof cross-project insert rejected; `route-policy.test.ts` |
| civil-time-lifecycle | no civil-date surface in Task 1 — the attribution carries no dates of its own; `createdAt`/`supersededAt` are instants, and the PO lines' civil dates stay on their owners' rows | schema; §C carries no date column |
| concurrency-idempotency | supersession is a CAS `updateMany` on `supersededAt IS NULL` (deterministic 409, never a raw trigger 500); the partial unique is the DB backstop; the initial attribution is replay-safe (same head is a no-op, a different head is a 409, never a silent re-attribution) | 5u / 5y / 5aj; activation re-run in 5bd |
| data-integrity-conservation | no second committed-amount ledger exists — there is no amount column; exactly one active attribution per line at every instant; supersession releases the unique so the replacement is accepted | 5bi / 5u / 5y; upgrade proof (12 forgeries rejected, the coherent chain accepted) |
| offline-reconciliation | every mutation runs through the command ledger with an Idempotency-Key; a keyed replay appends nothing | `commercial.costHead.define` / `commercial.attribution.reattribute` via `executeCommand` |
| ui-server-parity | no frontend surface in Task 1 (§M's hub is Task 7); the web policy matrix is pinned to the same `ROLE_POLICY` the API enforces | `apps/web/tests/policy.test.ts` |

## Review size

This unit is over the 20-file budget and is declared justified-large. The honest
accounting: **9 files carry the change** (schema, migration, the four commercial
sources, the procurement query, the two contract files) and **6 are the lifecycle
hooks and policy** (two PO services, the labour controller, the two manifests it
edits, `ROLE_POLICY`). The remaining files are tripwire pins the repository's own
invariants force to move in the same commit — the module-registry maps, MODEL_OWNER,
the boundary analyzer's directory map, the mutating-route count, the service and
controller triage, and the two policy matrices. Splitting them out would leave `main`
with a failing boundary check, which the loop's own rules forbid.

The one architectural concern is single: **every live PO line is attributed, from
whenever the capability is on.** It spans two pipelines because §0b's closure row
says it must — shipping the material half alone is exactly the "same rule, one site"
failure that section exists to prevent.

## Gates

| Gate | Result |
|---|---|
| `pnpm check` | EXIT 0 — web 432/432, API 685/685, both builds clean |
| integration suite (live PG, pristine migrated DB) | 73 files / 712 tests |
| `phase5-t1-commercial.test.ts` | 10/10 |
| `apps/api/scripts/upgrade-proof.sh` | PASSED — 231 assertions; both tables ROW-FREE over the legacy fixture with their seals installed, the coherent §C chain ACCEPTED, 12 new forgeries rejected, every prior Phase-1..Phase-4 rejection surviving |
| `test:e2e:api:allmodules` | see below |

The e2e run caught one real omission on its first pass: `prisma/seed.ts`'s reset
did not truncate the two new tables, so their FK to `LabourPurchaseOrderLine`
blocked the wipe. Fixed in the same change.

## What Task 1 deliberately does NOT ship

- **`BudgetLine`, the `COMMITTED` fold, the budget-vs-committed exception** — Task 2.
  Authority is only meaningful against the obligation it measures.
- **A domain event.** An attribution is an internal accounting fact with no external
  effect and no consumer; the exception that reacts to it is Task 2's Inbox action,
  raised from the fold. Attributability is the actor FK, the reason, the append-only
  seal and `recordAudit`.
- **The §D/§E participant calls** whose edges are declared here — measurement's
  locked status read (Task 3) and certification's evidence locks (Task 5).
- **Any frontend surface** — §M's Commercial hub is Task 7.

## Probe → plan mapping

| Probe | Plan section | File |
|---|---|---|
| 1 | §D byte-identity | `phase5-t1-commercial.test.ts` |
| 2 | §K no-gate | same |
| 5bi | §C one target, no amount | same + upgrade proof |
| 5ai | §C seals | same + upgrade proof |
| 5u | §C atomic re-attribution | same |
| 5y | §C amendment channel | same |
| 5aj | §C/§K labour twin, four sites | same |
| 5ar | §C authority follows the write | same |
| 5bd (ROW half) | §L activation backfill | same |
| 5x | §K edge set + topological sort | `module-registry.test.ts` |

`5bu` and `5bw` are explicitly Task-2 probes (they need the `COMMITTED` fold this
task has no reader for), exactly as §L and probe 5bd's own text assign them.
