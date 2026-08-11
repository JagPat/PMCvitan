# Phase 6 — External Collaboration

**Round 0 — docs-only architecture plan.** No implementation begins until this clears its own
review stop.

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
subordinate to it. §D makes it a *checkable invariant* rather than a discipline.

## Decisions SETTLED by this document

A later unit may not re-choose any of these. Where a decision was open in round 0 it is closed here,
because a plan that hands the runner to `phase-6-task-1` while §A, §C and §E are still alternatives
lets two units pick different semantics and both claim to follow the merged plan.

| # | Decision | Settled as | Where |
|---|---|---|---|
| 1 | The canonical external party | **A3 — a new orgs-owned `ExternalParty`**; `Vendor` and `ProjectCompany` reference it | §A |
| 2 | What a collaborator principal is | **(party, project, scope)**, resolved by a THREE-conjunct default-deny rule | §B |
| 3 | Whether the closed set is subtracted | **Deny, never intersect** — the closed set is the COMPLEMENT of a positive route allow-list | §B/§D |
| 4 | How the closed set is derived | **Over the ROUTE→permission mapping the route walk already reads**, not over `ROLE_POLICY` | §D |
| 5 | The scope vocabulary | **A closed enum of nine scopes**, fixed in §C; `commercial` is not one of them | §C |
| 6 | Guest → Org promotion | **The SEAM ships in 6.1; the promotion COMMAND is deferred** out of Phase 6 | §E |
| 7 | How existing projects are protected | A per-project **`collaboration` capability**; off = byte-identical to today | §B |

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
doing so.* Item 5 is the identity problem, answered in §A. Items 6 and 7 are why §D's enforcement
runs over routes rather than permissions.

**And note the direction of travel.** Because item 1 is true, Phase 6 **narrows** an existing
project-wide access model rather than widening a closed one. That is why §B gates the whole
resolver behind a per-project capability: an existing project must be byte-identical until someone
deliberately turns collaboration on.

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

**6.1 never merges two existing rows into one party.** It creates one party per existing `Vendor`
and one per existing `ProjectCompany`, and leaves any reconciliation to an explicit operator act.
Deciding that a vendor row and a company row are the same firm is a human judgement; a migration
that guessed it would fabricate identity, which every migration in this repository since Phase 3 is
written specifically not to do.

### §B. A collaborator PRINCIPAL is a scoped grant — and the rule is DENY, not intersect

The unit of collaboration is **(party, project, scope)** — never a role widening.

A person gains collaborator access by holding a `Membership` on the project **and** being bound to a
party that holds a grant on it. A request is permitted only when **all three** conjuncts hold:

```
permitted(principal, route, resource) :=
      route ∈ COLLABORATOR_REACHABLE            (§D — a positive allow-list; default CLOSED)
  ∧   ROLE_POLICY[route.permission] admits the principal's role
  ∧   grant.scope covers resource ∧ resource belongs to the principal's party
```

**Round 0 said "`ROLE_POLICY` intersected with §D's closed set" and that was backwards.** An
intersection with the *forbidden* set denies `attendance.record` (correct behaviour, wrong reason —
it is simply not a money command) while *admitting* exactly the money command an accidental policy
edit made reachable, because that command IS in the closed set and therefore survives the
intersection. The forbidden set must never appear in the allow calculation. §D's closed set is the
**complement** of conjunct 1 — a deny statement derived from it, and a thing to assert, not a thing
to intersect.

Two consequences worth stating now:

- Revoking a firm revokes everyone bound to it, in one attributable act.
- A person may belong to a firm and *also* hold an internal `Membership` in the operator's own org.
  Those are different principals and must not merge silently — the internal authority is the one §D
  protects.

**The `collaboration` capability.** The whole resolver is gated by a per-project `ProjectCapability`
(`collaboration`), the same mechanism `materials`, `labour` and `commercial` use. Off — every
existing project — the request path is byte-identical to today and no collaborator table carries a
row. On, the three conjuncts apply. The two-projects-one-org inertness proof every prior pilot
capability shipped is repeated here.

### §C. Scope is a positive grant, never a subtraction — and the vocabulary is CLOSED

A collaborator sees what the grant names. Not "the project minus the sensitive parts", because a
subtractive model leaks every fact added after it was written — the new fact is visible until
someone remembers to exclude it.

**The vocabulary is fixed here, as a closed enum of nine scopes.** Each names exactly one owning
module, so no scope can be interpreted twice:

| Scope | Owning module | What the grant admits |
|---|---|---|
| `activities` | activities | the activity register and its readiness for work this party executes |
| `requirements` | activities | the demand rows this party is being asked to supply against |
| `drawings` | drawings | issued drawings and their acknowledgement |
| `decisions` | decisions | published decisions and change requests |
| `procurement` | procurement | RFQs, quotes and purchase orders addressed to this party |
| `deliveries` | procurement | delivery commitments and promises against this party's orders |
| `labour` | labour | this party's own workers, attendance and work facts |
| `inspections` | inspections | inspections raised against this party's work |
| `daily-log` | daily-log | the site-log entries this party's own people author |

Evidence (`media`) is **not** a scope: a photo is reachable exactly when the fact citing it is, so
it inherits its parent's scope and can never be granted independently.

**There is no `commercial` scope, at any granularity.** That is a vocabulary-level statement of the
authority rule: §D closes the money routes, and §C gives no word with which to ask for them.

**A scope is not a wildcard over its module.** A new route in an already-granted module is
unreachable until it is added to §D's allow-list. The scope says *what kind of fact*, the allow-list
says *which routes*, the party binding says *whose rows* — three independent narrowings, each of
which must pass.

### §D. The closed internal-authority set — DERIVED over ROUTES, and default-CLOSED

This is the section that makes the authority rule real.

**Round 0 proposed deriving the closed set from `ROLE_POLICY` and that cannot work.** Revalidation
items 6 and 7 are why, and both are measured rather than argued: 33 of 167 mutating routes carry no
permission at all, and one permission maps to many commands. A `ROLE_POLICY`-only derivation is
blind to a third of the surface and cannot name a single command precisely. A new money route added
under the existing `commercial.certify` permission would never enter such a set — the tripwire would
pass while the route stayed reachable.

**The derivation therefore runs over the route→permission mapping the platform already maintains.**
`route-policy.test.ts` reflects over every controller and already asserts that every mutating route
declares exactly one authz intent, and `@RolesFor` records its permission under `ACTION_KEY`. Phase
6 reads that same walk:

1. `COLLABORATOR_REACHABLE` — an explicit, positive allow-list of route handler ids, the **only**
   routes a collaborator principal may reach. Each entry names its §C scope.
2. The closed set is **derived as the complement**: `all mutating routes − COLLABORATOR_REACHABLE`.
   A new route — money or not, permissioned or `@AllowAnyRole` — is closed on the commit that adds
   it, with no edit anywhere.
3. The resolver applies §B's three conjuncts. Conjunct 1 is membership of the allow-list; nothing
   consults the closed set at request time, because a default-deny rule has nothing to subtract.

**The tripwire, and what each assertion would catch:**

| Assertion | Fails when |
|---|---|
| Every route dispatching a money command is in the derived closed set | someone adds a money route to the allow-list |
| No allow-listed route carries a permission whose `ROLE_POLICY` entry admits no collaborator role | a route is allow-listed that no collaborator could ever pass — dead grant, or a mis-scoped one |
| Every allow-listed route names a §C scope, and that scope's owning module owns the route | a route is granted under a scope that does not own it |
| The route walk finds routes at all | reflection silently returns nothing and every assertion above passes for free |

The money list — at minimum `commercial.bill.verify`, `commercial.bill.certify`,
`commercial.certificate.supersede`, `commercial.sod.grant`, `commercial.deduction.record`,
`commercial.deduction.release`, `commercial.payment.approve`, `commercial.payment.record`,
`commercial.payment.reverse`, `commercial.advance.pay`, `commercial.budget.set` — survives **only as
the first assertion's proof obligation**, never as the mechanism. If it is incomplete the default
still closes the missing command; the assertion exists so that widening the allow-list toward money
fails loudly rather than quietly.

**Why default-deny and not a longer list.** Phase 5's final unit produced twelve findings, nine of
them from hand-kept lists that looked complete from the inside
(`docs/reviews/pr-322-convergence.md`). Round 0 claimed "a new money command joins the set
automatically" while proposing a mechanism that could not deliver it. Default-deny is the only shape
in which that sentence is true, because it makes the *unlisted* case safe instead of the listed one.

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
| **Plan (this document)** | the seven decisions above, SETTLED | **review stop — nothing is built until it clears** |
| **6.1** | `ExternalParty` (§A) + the `promotedOrgId` seam (§E) + the `collaboration` capability + the §F tenancy and inertness proofs | review |
| **6.2** | the collaborator principal + party binding (§B) | review |
| **6.3** | §D's route walk, `COLLABORATOR_REACHABLE`, the derived closed set and its tripwire — **before any collaborator surface reads or writes anything** | review |
| **6.4+** | the scoped surfaces themselves (§C), one scope per unit | review each |

**6.3 lands before 6.4 deliberately.** Building surfaces first and adding the guard after is how a
surface ships with authority nobody checked. The guard is cheap to write and worthless to add late.

## Out of scope (Phase 6)

- Any external-system integration: accounting, GST, bank, RedBracket, vendor adapters, live APIs
  (Phase 7, deferred).
- External credentials, external schema assumptions, outbound calls to third-party systems.
- The guest → Org promotion command (§E — the seam ships, the act does not).
- Reopening cleared architecture in Phases 0–5.

## Verification battery (every PR)

`pnpm check` EXIT 0 · full integration suite on a pristine migrated DB · `upgrade-proof.sh` where a
migration lands · `test:automation` · browser e2e for any collaborator surface · reproduce-first
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
Phase 5's last unit, then proposed a hand-reachable derivation for §D one paragraph later. §D is now
default-closed instead.

## Vision alignment

One project is one site; project operational records never become global. A collaborator surface
widens who can see and supply on a project and changes nothing about who owns a fact. One fact keeps
one canonical owner — which is why §A refuses to leave three representations of one firm standing,
and why the canonical one is owned by the module that answers "who may see this" rather than the one
that answers "what did we buy". Attributable human approvals are preserved: §D exists so that
certification and payment authority cannot be delegated by accident, and §E so that promotion cannot
rewrite who did what.
