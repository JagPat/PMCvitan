# Phase 6 — External Collaboration: the FOUNDATION

**Docs-only architecture plan, first of two.** This document settles external IDENTITY — the
canonical party, the promotion seam, and tenancy — and plans units 6.1 and 6.2. The AUTHORITY
BOUNDARY (§B the collaborator principal, §C the scope vocabulary, §D the closed set and its
tripwires) is planned in a **separate document that must clear its own review stop before 6.3**.

**Why two documents, stated rather than glossed.** Written as one, this plan took five
finding-bearing heads and nineteen findings, and the count was RISING (5 · 4 · 5 · 5 · 6) — the
review lifecycle reached its limit and recommended a split. The evidence for the seam is in the
findings themselves: identity (§A) drew ONE finding in five rounds and has been stable since;
authority (§B/§C/§D) drew almost every other one, and repeatedly a correction in one of those
sections created the next round's finding in another. Two concerns were sharing one review.
`docs/reviews/pr-324-convergence.md` carries the full finding history, which travels with the split
rather than being reset by it.

## Phase Intent

Suppliers, contractors and consultants work **through Vitan itself**, on tightly scoped access, with
a path from guest to their own tenant where that is planned.

This is collaboration, not integration. Phase 7 — accounting, GST, bank, or any vendor-specific
adapter or live external API — is deliberately deferred future-version scope. Integration
*capability* stays built and tested (versioned contracts, the transactional outbox, adapter seams,
idempotency and reconciliation semantics); this release adds no adapter, no external credentials, no
external schema assumptions and no external calls.

## THE AUTHORITY RULE — fixed before any design, and not a design question

> **A collaborator surface widens who can SEE and SUPPLY. It never widens who can CERTIFY or
> RELEASE MONEY.** The internal authority for verification, certification, approval and payment
> stays attributable and cannot be delegated accidentally.

Owner direction, recorded in `docs/STATUS.md` before this plan existed. Every section below is
subordinate to it. The boundary plan's §D is where it becomes a *checkable invariant* rather than a
discipline; this document's job is to make sure the identity it operates on is sound first.

## Decisions SETTLED by this document

A later unit may not re-choose these. The authority-boundary decisions (what a collaborator
principal is, how the closed set is derived, the scope vocabulary, and what enablement means) are
NOT settled here — they belong to the boundary plan and are listed below as its agenda, so nothing
is silently dropped in the split.

| # | Decision | Settled as | Where |
|---|---|---|---|
| 1 | The canonical external party | **A3 — a new orgs-owned `ExternalParty`**; `Vendor` and `ProjectCompany` reference it | §A |
| 2 | Whether 6.1 reconciles existing rows | **No.** One party per existing `Vendor` and per existing `ProjectCompany`; merging two rows into one firm is a human judgement a migration must not fabricate | §A |
| 2b | How the party links are sealed | **SAME-ORG composite FKs** on both `Vendor.partyId` and `ProjectCompany.partyId`, so a cross-org link is unrepresentable rather than refused | §A |
| 2c | Firms created AFTER 6.1 | the create paths assign a party in the same transaction, and `partyId` becomes NOT NULL once the backfill has run | §A |
| 3 | Guest → Org promotion | **The SEAM ships in 6.1; the promotion COMMAND is deferred** out of Phase 6 | §E |
| 4 | Tenancy standard | live-PostgreSQL cross-project proof per surface, unrepresentable-at-the-database where the shape permits | §F |

**Carried to the boundary plan, unsettled here:** the collaborator principal and its resolver; the
`COLLABORATOR_ROUTE_POLICY` map and the derived closed set; whether `ROLE_POLICY` is replaced and how
its ~48 service-level backstops are handled; the scope vocabulary including evidence upload and how
labour rows resolve to a party; route classification; the `collaboration` capability and what
enablement means on a live project; and the probe ledger. Six findings on head `3f7e35d` land in that
material and are answered there, not here — see the convergence audit.

## Facts consumed from earlier phases (never rebuilt)

| Fact | Owner | Phase |
|---|---|---|
| `Org` — the tenant that owns projects and admins | orgs | 0 |
| `Membership` — a PERSON with a login role on a project | orgs | 0 |
| `ProjectCompany` — a firm on a project (directory entry) | orgs | 0 |
| `Vendor` / `ProjectVendor` — the commercial counterparty | procurement | 3 |
| `VendorLabourProfile` — that counterparty as a labour supplier | labour | 4 |
| `ROLE_POLICY` — the single source of who may run each **permission** | shared | 0 |
| `@RolesFor` / `@AllowAnyRole` / `@Public` + the `route-policy.test.ts` route walk | platform | 2 |
| The command ledger, outbox, `DomainEvent` envelope, module manifests | platform | 2 |
| Capability gating (`ProjectCapability`) | platform | 3 |

## Current-State Revalidation (against `main` `1527ce3`)

**Checked, not recalled. Phase 6 is much less greenfield than "external collaboration" suggests, and
that changes what the phase is for.**

1. **The collaborator ROLES already exist and already carry real authority.** `ROLE_POLICY` defines
   `client`, `contractor` and `consultant` alongside `pmc`/`engineer`, and they are not decorative:
   `decision.change`, `drawing.acknowledge`, `attendance.record`, `labour.work.record` and
   `activity.output.record` all admit `contractor` today. A contractor person invited to a project
   can already do substantial work.

2. **`ProjectCompany` is a directory entry, not an access mechanism.** It carries `name`, `kind`
   (client | contractor | architect | structural | mep | pmc | consultant | other) and contact
   details. It has **no users and no relation to `Membership`**. Its own schema comment says so:
   *"Distinct from Membership (which is a person with a login role); a company is an organisation +
   a contact."*

3. **Therefore collaboration today is person-by-person, with no firm boundary.** People are invited
   individually; nothing records which firm a person belongs to. Access cannot be granted, scoped,
   audited or revoked **by firm** — only by person, one at a time.

4. **Access is PROJECT-WIDE by role.** There is no notion of a contractor seeing only their own
   packages, purchase orders or activities. A `contractor` membership sees the project.

5. **Three separate representations of "an external organisation" already exist** — `ProjectCompany`
   (directory), `Vendor`/`ProjectVendor` (commercial counterparty), and the prospective guest `Org`.
   A firm that both supplies materials and executes work exists twice today with no link.

6. **`ROLE_POLICY` does not see a third of the mutating surface.** Measured by walking the same
   controller metadata `route-policy.test.ts` walks: **225 route handlers, 167 of them mutating —
   134 carry `@RolesFor(permission)`, 22 carry `@AllowAnyRole(reason)` and 11 carry `@Public`.**
   So **33 of 167 mutating routes carry no `ROLE_POLICY` permission at all**, including
   `PushController.subscribe`, `AuthController.switch`, and every org-admin route. Anything derived
   from `ROLE_POLICY` alone is blind to all 33.

7. **A permission is not a command.** `ROLE_POLICY` is keyed by permission and the mapping to
   commands lives at the route: `commercial.certify` guards **both** `commercial/bills/certify` and
   `commercial/certificates/supersede`; `commercial.bill` guards create, submit, amend **and**
   reject. The relation is one-to-many, so no set of permissions determines a set of commands.

**What this means for the phase.** Phase 6 is not "add collaborators". It is: *give the firm a
first-class identity, scope what its people can reach, and keep the money authority closed while
doing so.* Item 5 is the identity problem, answered in §A — the whole subject of this document.
Items 6 and 7 are measurements the BOUNDARY plan is built on (they are why its enforcement runs over
routes rather than permissions); they are recorded here because they were taken against this base
and should not be re-derived.

**And note the direction of travel.** Because item 1 is true, Phase 6 **narrows** an existing
project-wide access model rather than widening a closed one. That is why the boundary plan gates the
whole resolver behind a per-project capability — and why THIS document reserves the capability name
in 6.1, so the flag cannot exist before the guard that governs it.

## Architecture

### §A. One canonical external party — **DECIDED: A3, owned by orgs**

The three representations must reconcile to one identity, or every later surface has to ask which
of them it means.

**The decision is A3 — a new org-scoped `ExternalParty` owned by the `orgs` module.** `Vendor` gains
a nullable reference to it; `ProjectCompany` becomes its per-project association.

**The reason is dependency direction, checked against the manifests rather than assumed.** Today
`orgs.dependsOn = ['decisions', 'inspections', 'labour']` and
`procurement.dependsOn = ['activities', 'decisions']` — neither module reads the other.

- **A2 (promote `Vendor`) inverts the layering.** `Vendor` is procurement-owned, so evaluating a
  collaborator grant or a firm-wide revocation would force `orgs.dependsOn += 'procurement'`: the
  module that decides who may see *anything* would have to read the module that buys things. Access
  would then depend on commercial state, which is the coupling `docs/ARCHITECTURE.md` exists to
  prevent. Round 0 recommended A2 on a tenancy-shape argument and that argument was too narrow — it
  compared the two tables and never asked which module the *access path* is allowed to read.
- **A1 (promote `ProjectCompany`) has the right owner and the wrong scope.** It is project-scoped
  with no org anchor, so promoting it means inventing the org anchor anyway.
- **A3 takes the owner from A1 and the org anchor from A2.** `ExternalParty(orgId, id)` — one firm,
  many projects — sits at the orgs end of an edge that runs *into* orgs, never out of it.

| Model | Owner | Scope | Role after 6.1 |
|---|---|---|---|
| `ExternalParty` | **orgs** | org (`orgId`) | the canonical firm identity |
| `ProjectCompany` | orgs | project | that party's per-project association (gains `partyId`) |
| `Vendor` | procurement | org | that party's COMMERCIAL relationship (gains nullable `partyId`) |

`Vendor.partyId` is a foreign key, not a read: procurement gains no `dependsOn` edge from holding
it. If a later unit needs the party's *name* inside procurement it goes through an orgs query
contract and declares `procurement.dependsOn += 'orgs'`, which stays acyclic because nothing in the
graph depends on `orgs`.

**Both references are SAME-ORG composite FKs, not plain ones — and that is a tenancy requirement,
not a style preference.** A globally-valid `partyId` lets `Vendor(org A).partyId` or a project-A
`ProjectCompany.partyId` point at an `ExternalParty` in org B; the firm grant and revocation
resolver would then treat org B's party as owning org A's project and commercial rows, and §F's
live-PostgreSQL cross-tenant proof would fail on a shape the database still accepted. So:

| Reference | Seal |
|---|---|
| `Vendor.partyId` | composite FK `(orgId, partyId) → ExternalParty(orgId, id)` — `Vendor` already carries `orgId` |
| `ProjectCompany.partyId` | the association is project-scoped, so it carries the project's `orgId` and takes the same composite FK; a cross-org link is then unrepresentable rather than merely refused |

This is the pattern every prior phase used for containment (Phase 4's same-project composite FKs on
worker, device and crew; Phase 3's on vendor and requisition lines), applied one level up at the org.

**Every FUTURE external firm gets its party at creation, not at the next backfill.** The migration
covers rows that exist when 6.1 runs; the `Vendor` and `ProjectCompany` create paths run afterwards
and would otherwise keep minting party-less firms right up until the boundary resolver ships,
leaving Phase 6 to start from a mixed identity set that needs a second, unplanned backfill. 6.1
therefore updates both create paths AND makes `partyId` NOT NULL once the backfill has run, so
"a firm without a canonical identity" stops being a representable state instead of being a thing the
next migration has to clean up.

**6.1 never merges two existing rows into one party.** It creates one party per existing `Vendor`
and one per existing `ProjectCompany`, and leaves any reconciliation to an explicit operator act.
Deciding that a vendor row and a company row are the same firm is a human judgement; a migration
that guessed it would fabricate identity, which every migration in this repository since Phase 3 is
written specifically not to do.
### §E. Guest → own Organization promotion — **DECIDED: seam in 6.1, command deferred**

A collaborator firm may become its own Vitan tenant.

**What ships in Phase 6:** the seam only. `ExternalParty` carries a nullable `promotedOrgId`, party
identity is stable and never re-keyed, and every attributable act continues to record the acting
person — so the attribution promotion must preserve is preserved by construction, before any
promotion exists to threaten it.

**What does not ship in Phase 6:** the `promote` command itself, tenant provisioning, and any
hand-over of records. Promotion CREATES A TENANT, which is a tenancy act; Phase 6's subject is
scoping access. Putting a tenant-creation path in the same phase as a new access resolver would put
both in front of one reviewer at once, which is the concern the one-PR-one-concern rule exists to
separate.

**The invariant that must hold when promotion is eventually built,** stated now so a later phase
inherits it rather than discovers it: work the firm's people did as guests stays attributable to
those people and that firm, and does not become the new tenant's to rewrite.

### §F. Tenancy proof

Every collaborator surface proves, against live PostgreSQL, that a party on project A cannot reach
project B — the same standard `TENANCY.md` sets for every prior phase. Cross-project references
unrepresentable at the database where the shape permits it, not merely refused in a service.

## Required Execution Order and Review Stops

| Unit | Contents | Stop |
|---|---|---|
| **This plan** | §A canonical party · §E promotion seam · §F tenancy standard | **review stop — 6.1 does not begin until it clears** |
| **6.1** | `ExternalParty` (§A) + the `promotedOrgId` seam (§E) + the §F tenancy proof. **No capability, no flag** — and see the reservation below | review |
| **6.2** | the party↔person binding and grants — inert data, because nothing can be switched on yet | review |
| **BOUNDARY PLAN** | §B principal + resolver · §C scope vocabulary · §D closed set, tripwires, the `collaboration` capability and its enablement rule · the probe ledger | **review stop — 6.3 does not begin until it clears** |
| **6.3** | the resolver, the route map, the closed set and the capability — as the boundary plan specifies | review |
| **6.4+** | the scoped surfaces (§C), one scope per unit | review each |

**6.3 lands before 6.4 deliberately, and the boundary plan lands before 6.3.** Building surfaces
first and adding the guard after is how a surface ships with authority nobody checked; the guard is
cheap to write and worthless to add late. The same argument applies one level up, which is why the
boundary is planned and reviewed on its own rather than implemented from prose that never converged.

### The capability name is RESERVED by 6.1, not created by it

6.1 and 6.2 ship inert data models and no flag — but "no flag" is not the same as "no flag can
exist". The generic `capability:enable` CLI upserts **any** capability string it is given, so an
operator could create `ProjectCapability(projectId, 'collaboration')` today, before any guard exists;
when 6.3 later keys the resolver off that row, the project is already enabled and the cutover check
never ran. **6.1 therefore makes `capability:enable` REFUSE the name `collaboration`**, and 6.3
replaces that refusal with the real enablement rule. A reserved name is cheap; a project enabled
before its guard exists is the cutoff the whole design is trying to prevent.

## Out of scope (Phase 6)

- Any external-system integration: accounting, GST, bank, RedBracket, vendor adapters, live APIs
  (Phase 7, deferred).
- External credentials, external schema assumptions, outbound calls to third-party systems.
- The guest → Org promotion command (§E — the seam ships, the act does not).
- The authority boundary (§B/§C/§D) — planned in the separate boundary document, not deferred or
  dropped. 6.3 is blocked until it clears.
- Reopening cleared architecture in Phases 0–5.

## Verification battery (every PR)

`pnpm check` EXIT 0 · full integration suite on a pristine migrated DB · `upgrade-proof.sh` where a
migration lands · `test:automation` · reproduce-first
probes RED at the stated base, **each mutation-tested**.

## Carried forward from Phase 5 (do not re-derive)

From `docs/reviews/pr-321-convergence.md` and `pr-322-convergence.md`, each bought with findings:

1. **Naming a root is not searching for it.** After finding one instance of a class, enumerate the
   class — the other registries, the other teardown lists, the other places one fact is written twice.
2. **An effect gated on a state its own action recreates is a loop by construction.**
3. **A grep that answers the question you asked is not the question you have.**
4. **A check is only evidence if its output could have come out differently** — no unconditional
   success markers, no piped exit codes, mutation-test every probe.
5. **Put every new condition INSIDE the shared resolver, never beside a call to it.** A shared
   predicate stops being shared the moment a caller adds a condition next to it.

Round 0 of this plan was itself an instance of rule 1: it named hand-kept lists as the root of
Phase 5's last unit, then proposed a hand-reachable derivation for the closed set one paragraph
later. That material now lives in the boundary plan, default-closed. It then happened a second time, in the correction written to record it —
see `docs/reviews/pr-324-convergence.md`. Two mechanical practices are added because writing rule 1
down demonstrably did not perform it:

6. **After measuring any set, enumerate its complement in the same breath.** 167 mutating routes
   implies 58 reads; reading evidence implies creating it; permissioned implies permission-less.
   Every one of this plan's second-round findings was a complement nobody looked at.
7. **When successive findings concern how your rule relates to an existing artefact, the finding is
   the dependency, not the relation** — and removing it at the layer where you found it is not
   removing it. The closed-set design was corrected three times over `ROLE_POLICY` at the ROUTE
   layer before a fourth finding named the 20 service files that read it too.
8. **After writing a rule to close a finding, state what else it now catches, and check that each of
   those is intended.** A complement over "all routes" catches the login switcher; a
   scope-completeness assertion at 6.3 catches nine unbuilt scopes; "unbound" misses "bound with no
   grant". Three of round 3's five findings were damage from round 2's own repairs.
9. **When the requirement is an OUTCOME, state the outcome and let a probe enforce it — do not keep
   encoding it as a test.** A test can be spelled correctly and still measure the wrong thing, and
   the only way to find out is to run it. Three consecutive rounds wrote a different predicate for
   "enablement must not cut anyone off"; each was refuted by the next. The boundary plan states the
   invariant and defers the predicate to a probe.
10. **An enumeration is not a closed set because you call it one.** Round 3 replaced a vague gesture
    with a list and labelled it "closed rather than open-ended"; round 4 found `GET me/portfolio`
    sitting outside it. Where a list must be complete, ship a classification RULE and a totality
    probe instead — the rule is checkable, the list is a claim.

## Vision alignment

One project is one site; project operational records never become global. A collaborator surface
widens who can see and supply on a project and changes nothing about who owns a fact. One fact keeps
one canonical owner — which is why §A refuses to leave three representations of one firm standing,
and why the canonical one is owned by the module that answers "who may see this" rather than the one
that answers "what did we buy". Attributable human approvals are preserved: the boundary plan's §D
exists so that certification and payment authority cannot be delegated by accident, and §E so that
promotion cannot rewrite who did what — which is why the promotion seam ships before the command
that would use it.
