# Phase 6 unit 6.1a — the canonical external party

Base `main` `f670077`. One architectural concern: **who an external firm IS**, expressed as a data
model and its seals. No resolver, no principal, no grant, no capability, no route — those are the
boundary plan's, and 6.1a is deliberately unable to authorise anything.

The plan is `docs/superpowers/plans/2026-08-11-phase-6-external-collaboration.md` (PR #324, fourteen
finding-bearing heads, `docs/reviews/pr-324-convergence.md`). This unit implements §A, the §E seam
and the §F standard.

## What 6.1 promised, and what this half delivers

The plan's unit 6.1 lists six things. **6.1a is the identity data model and its seals**; 6.1b carries
the operator merge/repoint command and the capability-name reservation. The split is by dependency,
not by convenience: the merge needs the same-project seals to exist before it can refuse a collision,
and the reservation's backward half is a diagnostic over whatever `ProjectCapability` holds at deploy
time — a row created between the two units is still caught, because the diagnostic reads current
state rather than assuming a start point.

| §A promise | Here |
|---|---|
| `ExternalParty`, orgs-owned | ✅ |
| the same-org seals | ✅ |
| the backfill | ✅ |
| create-path assignment, `partyId` NOT NULL | ✅ |
| the `promotedOrgId` seam, frozen | ✅ (§E) |
| the §F tenancy proof | ✅ |
| the operator merge/repoint command | 6.1b |
| the `collaboration` capability-name reservation | 6.1b |

## §A — the party, and why it is not `Vendor`

`Vendor` is procurement-owned and org-scoped; `ProjectCompany` is orgs-owned and project-scoped.
Neither can be the canonical firm without inverting a module boundary: a resolver reading `Vendor`
puts a procurement table inside the authority predicate, which is exactly what §A rejects.

So the party is a new orgs-owned root, and the four models are:

| Model | Owner | What it says |
|---|---|---|
| `ExternalParty` | orgs | this org knows a firm by this identity |
| `ProjectParty` | orgs | that firm is associated with this project |
| `ProjectPartyCompanySource` | orgs | …BECAUSE this directory row exists |
| `ProjectPartyVendorSource` | orgs | …BECAUSE this vendor binding exists |

**The two source tables are one structure that was normalised after a review round.** The earlier
draft was a single `ProjectPartySource(projectId, partyId, source)` with a discriminated `source`
column — and no key any FK could bind to, so every drift needed a hand-written guard and each round
found another one. Per-origin tables give each source a real composite FK to its own origin, and
`ON DELETE CASCADE` removes the source with the row that justified it. The rule that came out of
that: **when a structure needs a new hand-written guard every round, the structure is wrong.**

### The association exists only while something SOURCES it

`ProjectParty` is what a resolver will read, so an association surviving the thing that justified it
is a live grant target with no firm behind it. Three DEFERRABLE INITIALLY DEFERRED constraint
triggers hold that: one on the association appearing, one on each source leaving.

Deferred rather than immediate because the legitimate write order is association-then-source — an
immediate trigger would refuse the correct transaction. Probe 6c asserts **both** directions for that
reason: a bare association is refused, and the legitimate ordering commits. A probe that only proves
refusal cannot distinguish a deferred constraint from an immediate one.

**The seal also fires on DELETE, and that is not redundant.** `CompaniesService.remove` releases the
association when the last source goes — but that call is a convenience for the user, not the thing
preventing an orphan. Probe 6d and the upgrade proof both delete the last source by bypassing the
service entirely; PostgreSQL refuses the transaction.

### One party, one directory row and one binding per project

`(projectId, partyId)` unique on both `ProjectCompany` and `ProjectVendor`.

This is not implied by `(projectId, vendorId)`. It is implied by it *only while `partyId` is derived
from the vendor* — and 6.1b's merge repoints `partyId`, after which two different vendors share one
party and binding both to one project is representable again. That is precisely the state the merge
must refuse, so the seal ships with the data model rather than with the command that relies on it.

Each index is preceded by an explicit diagnostic. `CREATE UNIQUE INDEX` names the duplicated key but
not the invariant it belongs to; a Phase 3 review rejected that opacity once already.

### The `Vendor` create path is a DECLARED cross-module write

`Vendor` is created in procurement; `ExternalParty` is orgs-owned. Assigning the party in the same
transaction is a cross-module write, and this repository does not permit undeclared ones — so it goes
through `OrgsParticipant` and `procurement.workflowParticipants` gains `orgs`.

`procurement.dependsOn` is deliberately unchanged: a participant edge is a write **through** the
owner, not a read of it. Probe **P5** asserts both halves, because a hand-built participant in the
vendor create path would satisfy the layering claim while leaving the write undeclared.

## §E — the promotion seam, frozen from the day it lands

Nothing in Phase 6 sets `promotedOrgId`. That is the reason it needs a guard, not a reason to skip
one: with no command writing it, the only things that could move a promoted party are a retry, a
repair or a migration, and any of those would silently re-point historical guest attribution at a
different tenant.

Two properties, and the first does not imply the second:

- **one-way** — null → an org is permitted; changing or clearing a non-null value is refused
  (`phase6_party_promotion_one_way`)
- **one-to-one per owner org** — a partial unique on non-null `(orgId, promotedOrgId)`

The uniqueness is **scoped to the owner org, and a global one would be wrong**: a supplier working
with owner orgs A and B has a local party in each by design, and a global unique would let A link
first and then refuse B's equally legitimate link. Both the integration probe and the upgrade proof
carry that cross-org case as a **negative control**.

## §F — unrepresentable, not merely refused

Five references, five named seals, each proven live:

| Attack | Seal |
|---|---|
| association pairing an org-A project with an org-B party | `ProjectParty_orgId_projectId_fkey` |
| directory row keeping its project on org A while claiming org B | `ProjectCompany_orgId_projectId_fkey` |
| same-org directory row pointing at another org's party | `ProjectCompany_orgId_partyId_fkey` |
| vendor claiming another org's party | `Vendor_orgId_partyId_fkey` |
| binding whose party copy is not its own vendor's | `ProjectVendor_orgId_vendorId_partyId_fkey` |

The last one is the interesting case: it is *same-org* and still refused, because the binding's copy
is bound **through** the vendor rather than to `ExternalParty` directly. Without it a same-org row
could bind project A to vendor V1 while mirroring party P2, and a resolver would grant P2 access to
V1's records — or would have to read procurement to re-check, which is what the orgs-owned mirror
exists to avoid.

## The migration

`20270801000000_phase6_t1a_external_party`, additive and diagnostic-first. It backfills one party
per existing `Vendor` and one per existing `ProjectCompany`, mirrors both into `ProjectParty` with
their sources, then sets `partyId` NOT NULL.

**It merges nothing.** Deciding that a vendor row and a company row are the same firm is a human
judgement; a migration that guessed it would fabricate identity. That is what 6.1b's operator command
is for, and it is why the plan schedules that command rather than leaving reconciliation as an
unowned "later".

The backfill is followed by three diagnostics that abort rather than accept a state the design
forbids: an unsourced association, and a duplicate `(projectId, partyId)` on either origin table.
Each is framed as a **migration defect** rather than a data problem, because the derivation is
deterministic and a duplicate can only mean the derivation is wrong.

## Verification

### Integration — `phase6-t1a-party.test.ts`, 7/7 live PG

| Probe | What it holds |
|---|---|
| 6a | every create path mints the identity; a binding carries the VENDOR's party, not a second one |
| 6b | one party through two origins holds ONE association; it outlives losing one source and dies with the last |
| 6c | a bare association is refused at COMMIT **and** the legitimate order commits |
| 6d | the seal fires when the service is bypassed; the service path that releases first succeeds |
| 6e | one-way, one-to-one per owner, **and** the cross-org case is permitted |
| 6f | five cross-tenant pairings, each by its own named seal |
| 6g | one directory row and one binding per party per project |

**6g was verified RED before green**: with the two new indexes dropped, the duplicate binding is
accepted. The seal is load-bearing, not decorative.

### Upgrade proof — 528 assertions, PASSED

Nineteen are new. The important half is not the hostile inserts:

`ProjectCompany` has been in the schema since before Phase 1 and every real project holds rows in it,
so this backfill **migrates existing data** — and a proof over an empty table would pass while
proving nothing. Two directory rows are now planted on the PRE-Phase-6 schema, using the ledger-stop
idiom Phase 5 Task 4 used for the vendor-pinning backfill, and the assertions read what the backfill
WROTE: the derivation is per-row, the org copy is the project's, a binding's party is provably its
vendor's, no association came out unjustified, and the §E seam ships empty.

A **positive control** sits among the refusals: a coherent party chain is ACCEPTED. A section that
only proves refusals cannot distinguish a precise seal from a blanket one.

### Correction probes — `phase6-t1a-correction.test.ts`, 7/7 live PG

Six were RED at `9a03d95` (C3, C5, C4, C8, C6, C2); C7 was not, for the reason given above.
C1 lives in `scripts/phase6-t1a-rerun-proof.sh` because a suite cannot observe a migration retry.

### Gates

| Gate | Result |
|---|---|
| `pnpm check` | see PR body |
| full integration (live PG) | see PR body |
| `upgrade-proof.sh` | see PR body |
| `phase6-t1a-rerun-proof.sh` | see PR body |

## The review round on head `9a03d95` — eight findings, one correction head

Codex returned one P1 and seven P2s. All eight are fixed in `fa16c3b`. **Six were reproduced RED
against `9a03d95` before the fix**; the two that were not are named as such rather than dressed up.

| # | Finding | What it was | Fix |
|---|---|---|---|
| C1 | P1 | unguarded `CREATE TABLE` / `ADD COLUMN`, so an apply interrupted partway could not be retried | `IF NOT EXISTS` / `DROP IF EXISTS` throughout |
| C2 | P2 | `releasePartyAssociationIfUnsourced` counted, then deleted | `FOR UPDATE` on the association before counting |
| C3 | P2 | a whitespace-only party name was accepted | non-blank CHECK + trimmed schema + legacy diagnostic |
| C4 | P2 | a REPOINTED source never rechecked the association it left | trigger fires on `UPDATE`, checks `OLD` |
| C5 | P2 | `promotedOrgId` was free text | FK to `Org` |
| C6 | P2 | a company rename desynchronised the party | follows a sole source; refused when shared |
| C7 | P2 | the sourced check counted without serializing | `FOR UPDATE` inside the trigger |
| C8 | P2 | a BOUND vendor could not be repointed, so 6.1b's merge could not run | `ON UPDATE CASCADE` on the derived copy |

### C1 is the one to look at first

Not because it is the P1, but because its proof is the only new gate. A migration's rerunnability
cannot be observed from a suite running against an already-migrated database, so
`scripts/phase6-t1a-rerun-proof.sh` builds the state instead:

- **scenario A** — a blank legacy firm name aborts the apply, and the proof asserts that **no party
  table exists afterwards**. That is the ordering claim ("diagnostic-first") and nothing more.
- **scenario B** — the file's structural prefix is applied, confirmed to have created **exactly one
  of the four tables**, and then the WHOLE migration is run over that half-applied schema. This is
  the finding. RED at `9a03d95` with `ERROR: relation "ExternalParty" already exists`.
- **step 8** — the retried schema's constraints, indexes and triggers are compared against a clean
  first-time apply. "It re-runs" is worth nothing if the retry leaves a different shape.

The first version of this proof conflated A and B and reported *"no DDL statement blocked the
retry"* **without ever reaching a DDL statement** — the abort was at the top diagnostic, so there
was nothing to trip over. Splitting the scenarios is what made the assertion mean anything.

### C7 has no red evidence, and says so

The reviewer's interleaving — two transactions each removing one of the last two justifications,
each still seeing the other's row — could not be reproduced. PostgreSQL serialised the two deferred
checks on every attempt: the second commit consistently observed the first's effect and was
rejected. The `FOR UPDATE` is applied because the mechanism is sound and the invariant should not
rest on commit ordering, but **the probe passes at both heads and is a regression guard, not
evidence.** Recorded here because a fix presented as red-to-green when it is reasoned is the kind
of claim these audits exist to catch.

### Two of my own probes were wrong

Worth stating because the pattern is the same one and it is not rare:

- **C2's first draft inlined the count** to control its barrier — which bypassed the exact method
  under test, and passed. A probe that reimplements the code it is testing tests nothing.
- **The rerun proof's first fixture** failed on a NOT NULL column, planted nothing, and then
  reported *"the migration completed over a blank firm name"* — a finding it had never tested. Its
  second defect was matching `already exists` anywhere in the output, which reads the
  `IF NOT EXISTS` **notice** — the guard working — as the guard failing.

Both now fail loudly by construction: the fixture verifies its own row landed, and the assertion
matches `ERROR:` rather than free text.

### C6 needed a decision the plan had deferred

§A says identity-changing updates are "refused once authority rows exist" — and authority rows are
2's. That left 6.1a with a real gap and no instruction: rename ACME to Beta and the party a
resolver keys on still says ACME.

The rule adopted here is narrower than 6.2's and does not pre-empt it: **a rename follows the row
into the party it is the sole evidence for, and is refused (409) once the party has another
justification.** Renaming a firm from one of its two faces is the operator's reconciliation
decision, not a side effect of a directory edit. 6.2's authority refusal is additive on top.

## Two things worth flagging to the reviewer

**The 35 one-line TRUNCATE edits are why this PR is over the file budget.** `ProjectParty` FKs to
`Project`, which those lists never truncate, so without the three party tables an association would
outlive the `ProjectVendor` rows justifying it — and `TRUNCATE` fires no row triggers, so the DB
would carry associations no writer could ever have created. The change is mechanical and identical in
all 35 files.

**`WorkerDevice` is not touched, and `ProjectCompany.remove` gains no authority guard.** The plan
puts the removal guard in 6.2 for an instructive reason: 6.1 cannot check rows that do not exist yet,
and a service check written against tables 6.2 introduces is inert by construction — indistinguishable
from a guard that works until the day it matters. The unit that creates the binding and grant tables
installs the refusal.
