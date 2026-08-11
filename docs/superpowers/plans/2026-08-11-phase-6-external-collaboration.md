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

## Facts consumed from earlier phases (never rebuilt)

| Fact | Owner | Phase |
|---|---|---|
| `Org` — the tenant that owns projects and admins | orgs | 0 |
| `Membership` — a PERSON with a login role on a project | orgs | 0 |
| `ProjectCompany` — a firm on a project (directory entry) | orgs | 0 |
| `Vendor` / `ProjectVendor` — the commercial counterparty | procurement | 3 |
| `VendorLabourProfile` — that counterparty as a labour supplier | labour | 4 |
| `ROLE_POLICY` — the single source of who may run each command | shared | 0 |
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

**What this means for the phase.** Phase 6 is not "add collaborators". It is: *give the firm a
first-class identity, scope what its people can reach, and keep the money authority closed while
doing so.* Item 5 is the central design problem and §B is where it is answered.

## Architecture

### §A. One canonical external party

The three representations must reconcile to one identity, or every later surface has to ask which
of them it means.

**Decision to be settled at this plan's review stop, with the alternatives stated rather than
assumed:**

- **A1 — promote `ProjectCompany` to the canonical party**, and give `Vendor` a reference to it.
- **A2 — promote `Vendor` (org-scoped, already the commercial party) to canonical**, and make
  `ProjectCompany` a project-scoped *association* of it.
- **A3 — a new `ExternalParty` owned by orgs**, referenced by both.

A2 is the current recommendation and the reason is tenancy, not convenience: `Vendor` is already
`orgId`-scoped with `ProjectVendor` as its per-project association, which is exactly the shape a
collaborator needs (one firm, many projects). `ProjectCompany` is project-scoped with no org anchor,
so promoting it would require inventing the org anchor anyway. The cost is that "vendor" becomes a
name wider than procurement — a rename may be owed, and a rename touching a cleared phase is not
free.

### §B. A collaborator PRINCIPAL is a scoped grant, not a role

The unit of collaboration is **(party, project, scope)** — never a role widening.

A person gains collaborator access by being bound to a party that holds a grant on a project. What
they may *see* follows the grant's scope; what they may *do* follows `ROLE_POLICY` intersected with
§D's closed set. Two consequences worth stating now:

- Revoking a firm revokes everyone bound to it, in one attributable act.
- A person may belong to a firm and *also* hold an internal `Membership`. Those are different
  principals and must not merge silently — the internal authority is the one §D protects.

### §C. Scope is a positive grant, never a subtraction

A collaborator sees what the grant names. Not "the project minus the sensitive parts", because a
subtractive model leaks every fact added after it was written — the new fact is visible until
someone remembers to exclude it.

The scope vocabulary (activities, drawings, decisions, POs, requirements…) is settled in this plan
so it is not invented per surface.

### §D. The closed internal-authority set, enforced and PROVEN

This is the section that makes the authority rule real.

An explicit, named set of commands **no collaborator principal may ever reach** — at minimum
`commercial.bill.verify`, `commercial.bill.certify`, `commercial.certificate.supersede`,
`commercial.sod.grant`, `commercial.deduction.record`, `commercial.deduction.release`,
`commercial.payment.approve`, `commercial.payment.record`, `commercial.payment.reverse`,
`commercial.advance.pay`, `commercial.budget.set`.

**A list is not enough, and this plan knows exactly why.** Phase 5's final unit produced twelve
findings, nine of them from hand-kept lists that looked complete from the inside
(`docs/reviews/pr-322-convergence.md`). So the set is **derived and pinned**:

- derived from `ROLE_POLICY` — every command whose policy admits only internal roles is in the
  closed set by construction, not by transcription;
- pinned by a tripwire test asserting no collaborator principal resolves to any of them;
- **a new money command joins the set automatically**, and a test fails if a future policy edit
  admits a collaborator role to one.

That last property is the whole point. Phase 5's lesson, paid for four times, is that a hand-listed
subset always looks complete from inside.

### §E. Guest → own Organization promotion

A collaborator firm may become its own Vitan tenant. The promotion must preserve attribution: work
the firm's people did as guests stays attributable to those people and that firm, and does not
become the new tenant's to rewrite.

Whether promotion is in this phase or named-and-deferred is a review-stop decision. It is stated
here so it is not discovered late.

### §F. Tenancy proof

Every collaborator surface proves, against live PostgreSQL, that a party on project A cannot reach
project B — the same standard `TENANCY.md` sets for every prior phase. Cross-project references
unrepresentable at the database where the shape permits it, not merely refused in a service.

## Required Execution Order and Review Stops

| Unit | Contents | Stop |
|---|---|---|
| **Plan (this document)** | §A decision, §C vocabulary, §E in-or-out | **review stop — nothing is built until it clears** |
| **6.1** | the canonical party (§A) + its tenancy proof | review |
| **6.2** | the collaborator principal + party binding (§B) | review |
| **6.3** | §D's derived closed set and its tripwire — **before any collaborator surface reads or writes anything** | review |
| **6.4+** | the scoped surfaces themselves (§C), one workflow per unit | review each |

**6.3 lands before 6.4 deliberately.** Building surfaces first and adding the guard after is how a
surface ships with authority nobody checked. The guard is cheap to write and worthless to add late.

## Out of scope (Phase 6)

- Any external-system integration: accounting, GST, bank, RedBracket, vendor adapters, live APIs
  (Phase 7, deferred).
- External credentials, external schema assumptions, outbound calls to third-party systems.
- Reopening cleared architecture in Phases 0–5.

## Verification battery (every PR)

`pnpm check` EXIT 0 · full integration suite on a pristine migrated DB · `upgrade-proof.sh` where a
migration lands · `test:automation` · browser e2e for any §M surface · reproduce-first probes RED at
the stated base, **each mutation-tested**.

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

## Vision alignment

One project is one site; project operational records never become global. A collaborator surface
widens who can see and supply on a project and changes nothing about who owns a fact. One fact keeps
one canonical owner — which is why §A refuses to leave three representations of one firm standing.
Attributable human approvals are preserved: §D exists so that certification and payment authority
cannot be delegated by accident, and §E so that promotion cannot rewrite who did what.
