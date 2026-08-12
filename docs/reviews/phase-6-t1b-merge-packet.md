# Phase 6 unit 6.1b — the operator merge/repoint command, and the reserved capability name

Unit 6.1a made external identity canonical. It also, deliberately, left a gap: it created one
`ExternalParty` per existing row and merged **nothing**, because deciding that a `Vendor` row and a
`ProjectCompany` row are the same firm is a human judgement a migration must not fabricate.

The cost of that correctness is that a firm which is both currently has TWO canonical identities. A
grant bound to one cannot prove ownership of rows linked to the other, so a firm-wide revocation
would reach half the real firm. 6.1b is where the operator records the judgement — and it ships in
6.1 rather than "later" precisely so the canonical identity is reachable before anything relies on
it.

What it still does **not** do is decide which rows are one firm.

## What ships

| | |
|---|---|
| `PartyMergeService.merge` | the operator merge/repoint command, org-admin authority, one transaction |
| `ProcurementParticipant.repointVendorParty` | the orgs → procurement channel the merge reaches `Vendor` through |
| `orgs.workflowParticipants` gains `procurement` | the cycle-exempt edge that makes the above legitimate rather than merely representable |
| `ProjectCapability_collaboration_reserved` | the `collaboration` name reserved until the resolver that gates it exists |
| `renamePartyForSoleSource(…, callerCompanyId)` | the item 6.1a's F1 deliberately left behind |

## §A — the merge, and why its ORDER is not a style choice

The plan's list is `Vendor`, `ProjectVendor`, `ProjectCompany`, `ProjectParty` and both source
tables: *"anything it does not repoint becomes a stranded reference."* The interesting part is that
6.1a's own machinery dictates the sequence.

The party FKs cascade, and they are **not deferrable**:

```
ProjectCompany.partyId ──ON UPDATE CASCADE──▶ ProjectPartyCompanySource.partyId
Vendor.partyId ──▶ ProjectVendor.partyId ──▶ ProjectPartyVendorSource.partyId
ProjectParty(projectId,partyId) ──▶ BOTH source tables' partyId
```

So the association-side cascade and the origin-side cascade write the *same rows*, and every naive
single-table update violates the other FK:

| Attempt | What breaks |
|---|---|
| move `ProjectParty` first | its cascade moves the source rows' `partyId`, but their origin still names the absorbed party → origin FK rejected |
| move `ProjectCompany` first | its cascade moves the source rows' `partyId`, but no `ProjectParty` row exists for the survivor → association FK rejected |

The order that works:

1. ensure the survivor's `ProjectParty` exists on every project the absorbed party reaches
2. repoint `ProjectCompany` — its cascade carries the company source, and **both** its FKs are
   satisfied at statement end (origin moved with it; association created in step 1)
3. repoint `Vendor` through the participant — its cascade carries the binding and the vendor source
4. **delete the absorbed associations**
5. delete the absorbed party

**Step 4 is not cleanup.** The cascaded source updates in 2–3 fire `phase6_project_party_sourced`
with `TG_OP=UPDATE`, which targets the association the source *left* and finds zero sources. It
passes only because that trigger is `DEFERRABLE INITIALLY DEFERRED` and those rows are gone by
COMMIT. Omitting step 4 does not strand an association — it aborts the whole merge. The seal C4
added in 6.1a is what obliges the merge to tidy up after itself.

## The lock, and the evidence behind it

Two operators running A→B and B→A touch **disjoint initial row sets**. Neither blocks the other,
both commit, and the duplicate firm is reconciled into a *different* duplicate — the vendor on B,
the company on A. Nothing either transaction read was wrong; they simply never met.

Both roots are locked `FOR UPDATE` in ascending `id` order. The ordering is also what makes it
deadlock-free: both directions take the lower id first.

**The first version of probe M4 passed with the lock removed.** It started the second merge 50ms
after the first, so they ran end to end and the loser merely found its party already deleted. That
is the defect the 6.1a audit records against the E2/E3 first drafts, and C7 is the standing warning
about a lock applied on reasoning alone with no red evidence.

M4 is now a genuine overlap: a third session holds the lower-id party locked; both merges are
confirmed **BLOCKED** by reading `pg_stat_activity` (condition-based, not a sleep); only then is the
barrier lifted. Stripped of the `FOR UPDATE` it fails —
`expected 1 to be greater than or equal to 2` — so this lock ships with red evidence.

## The refusals, each scoped to the PARTY

| Refusal | Why |
|---|---|
| cross-org | a party is org-scoped; merging across tenants moves one org's firm identity into another's |
| either side `promotedOrgId IS NOT NULL` | §E; the merge outlives this unit, and merging a promoted party either strands the tenant link or moves a tenant relationship as a side effect of data cleanup |
| same-project collision | `(projectId, partyId)` is unique on `ProjectCompany` and `ProjectVendor`, so the duplicate is unrepresentable — detected before anything moves, and reported naming the PROJECT rather than an index |
| self-merge | it would delete the survivor |
| non org owner/admin | reconciling firm identity is an org-administration act |

None is scoped to a project the operator happens to name. 6.1a's D1 was exactly that error one
command over.

**Bindings and grants are NOT refused here, and that is deliberate.** Those tables arrive in 6.2,
and a service check written against tables that do not exist is inert by construction —
indistinguishable from a guard that works until the day it matters. What 6.1b owes 6.2 is the
constraint it creates: **the binding/grant create/update/repoint/revoke paths must lock the affected
`ExternalParty` roots in the same ascending-`id` order**, with their own barrier probe. A refusal
that reads is not a refusal that serializes: the merge could lock both roots, see no authority rows,
repoint the firm facts and commit, while a concurrent transaction creates a grant on the absorbed
party and commits after it.

## The reserved capability name

The boundary plan gates the collaborator resolver behind a per-project capability that does not
exist yet. A flag switchable before the thing it governs means nothing when it is on.

- The seal is a **CHECK**, chosen over a trigger because the obligation has two ends — INSERT and
  UPDATE — and a CHECK covers both by construction. F1 was an obligation armed against one end only;
  here the completeness is free.
- The service refusal is the **friendly error, not the seal**. A service check is scoped to the
  caller, and the operator CLI, a repair script and a raw insert all walk past it (Root A).
- It is declared in `schema.prisma` as well as the migration. Prisma cannot express a CHECK, so the
  model records what it cannot enforce — Root B is precisely the gap where a seal lives only in
  hand-written SQL.
- The migration is **diagnostic-first and will not clean up after an operator**: a pre-existing
  `collaboration` row aborts the deploy, naming the projects and the exact `DELETE`.

6.2 lifts the constraint in the same migration that installs the resolver. The guard ships with the
semantics.

## The carried-over item from F1

`renamePartyForSoleSource` computed `others = sources - 1` — *"one of these rows is me"*. F1 showed
that inference was false in a reachable state, and F1's seal made that state unrepresentable. The
inference is therefore now **true** — and still the wrong shape, because it is true by distant
consequence rather than by construction, and a check whose correctness lives in another file's
trigger is one edit from being wrong again with nothing to catch it. It now takes `callerCompanyId`
and counts.

## Verification

| Gate | Result |
|---|---|
| `phase6-t1b-party-merge.test.ts` | 6/6, three consecutive runs |
| M4 without the lock | **fails** — the probe is known to be capable of failing |
| upgrade proof | 540 → **544**, PASSED |
| migration abort → repair → redeploy | run end to end on a scratch database |
| `pnpm check` | see PR body |
| full integration | see PR body |

**Two probes were wrong before they were right, and both were 6.1a's seals working.** M2 tried to
CLEAR a promotion — the §E one-way trigger refuses that, correctly. M3 hand-repointed a vendor
without creating the association first — the cascade above. M3 also had to change shape: a company
and a vendor binding sharing a project is *not* a collision, since the uniques are per table; that
is the ordinary "firm reached both ways" case M1 covers.

**One upgrade-proof assertion was wrong too.** The UPDATE refusal ran before any capability row
existed, matched zero rows, succeeded trivially, and reported a pass for a seal it never reached.
The row is planted first now, and doubles as the narrowness control — a seal refusing *every*
capability would have passed both refusal assertions while breaking the three pilots that do have
behaviour.
