# Vitan PMC — Roles & Access (quick reference)

There are **two** role systems. Someone's access is the combination of both. For the full
data model see [`ORGS.md`](./ORGS.md); this page is the practical cheat-sheet.

- **Org role** — administrative power over the *account* (the practice): who can create
  projects, run every project, and manage other admins.
- **Project role** — operational power *inside a project*: what you can do on the decisions,
  inspections, drawings, daily log, etc.

---

## Org roles (`owner | admin | member`)

Set on the **Team** screen → **Organization Admins** section (owner only).

| Org role | Runs every project (as PMC) | Create / archive / restore projects | Manage each project's team & companies | Manage the admin roster (add/remove/promote admins & owners) |
|---|:---:|:---:|:---:|:---:|
| **owner** (super-admin) | ✅ | ✅ | ✅ | ✅ |
| **admin** | ✅ | ✅ | ✅ | ❌ |
| **member** | ❌ (only projects they're an explicit member of) | ❌ | ❌ | ❌ |

**The key guardrails (enforced server-side, not just hidden in the UI):**
- Managing the admin roster is **owner-only**. An **admin can do everything on projects but
  cannot add, remove, promote, or demote any admin or owner** — so an admin **can't delete or
  demote the super-admin**. This is exactly the "full access, but can't touch me" role.
- The system **refuses to remove the last owner**, so the org can never be left with no one
  able to manage it.

### Owner vs admin — which to give
- Want someone with **all portal features but no control over admins / can't remove you** →
  give **Admin**.
- Want a **second full super-admin** (who can also manage the roster) → give **Owner**. (Even
  an owner can't remove the *last* owner.)

### Super-admin reach
An **owner/admin operates every project in the org as PMC** — even projects they were never
explicitly added to. They appear in the switcher and portfolio automatically.
*Exception:* if an owner/admin holds an **explicit membership** on a specific project (e.g. added
there as `client`), that explicit role wins for that one project — a deliberate way to scope
yourself down on a particular job.

---

## Project roles (`pmc | client | engineer | contractor | consultant` + `worker`)

Set on the **Team** screen → member list. A person can hold different project roles on
different projects.

| Project role | Typical use | Can do |
|---|---|---|
| **pmc** | Architect / PMC | Everything on the project: issue drawings, approve/reject inspections, approve decisions, edit project details, manage the team & companies, archive/restore. (Org owners/admins operate as this.) |
| **client** | Owner / client | Approve & lock decisions, raise change requests, view drawings & health. |
| **engineer** | Site engineer | Submit inspection checklists, submit the daily log, start/complete activities, acknowledge drawings, raise change requests. |
| **contractor** | Contractor | Acknowledge drawings, raise change requests, read-only elsewhere. |
| **consultant** | Discipline consultant (architect / structural / MEP / **plumbing** / **lighting** / HVAC / …) | Read-mostly reviewer: view the drawings, decision register, Site Map & project health; raise a change request to flag a conflict in their discipline. Does **not** approve decisions or issue drawings. Carries a **discipline** label (see below). |
| **worker** | Site labour (QR job card) | No login account — a device token from the site QR; can only tap-photo / job-card actions. Cannot perform any of the gated project mutations. |

### Consultants: one role, many disciplines

Every consultant shares the same `consultant` role (the access tier). What distinguishes an
architect from a lighting or plumbing consultant is a **`discipline`** label on their
membership — a record of *what they cover*, **not** a permission set. So adding a new kind of
consultant needs **no new role and no code**: on the **Team** screen, add the member, set role
**Consultant**, and pick their discipline (Architect / Structural / MEP / Plumbing / Electrical /
HVAC / Lighting / Landscape / Interior / Façade / Acoustics / Other). Change or clear it any time
by switching their role. (A firm can also be recorded as a **Company / Consultant** on the same
screen — that's a directory contact, distinct from a login-bearing member.)

**Discipline-scoped views.** A consultant's discipline scopes what they land on: the **Drawings
register defaults to their discipline's set** — the four register buckets are
`architectural | structural | mep | other`, and `drawingDisciplineFor()` maps the finer
disciplines onto them (so lighting / plumbing / electrical / HVAC → **MEP**, architect /
interior / façade → **architectural**, etc.). It's a **soft default**, not a hard filter: a
one-tap **"All disciplines"** toggle shows the whole register, because consultants routinely need
to coordinate against other trades' drawings. (The discipline travels on `/me/memberships`; the
demo persona has no membership, so a consultant there falls back to a representative discipline.)

### The "For You" home (per-role landing)

Every role lands on a **"For You"** screen — a live, cross-cutting to-do list of exactly what's
waiting on *them*, each card a one-tap jump to where they act. It's a pure derivation of state
(`selectActionItems`), so an item disappears the moment it's dealt with:

| Role | What "For You" surfaces |
|---|---|
| **client** | decisions awaiting your approval |
| **engineer** | today's checklist to complete, an unsubmitted site log, drawings to acknowledge |
| **contractor** | drawings to acknowledge, open change requests |
| **pmc** | inspections to review, change requests to resolve, blocked activities, decisions waiting on the client |
| **consultant** | the issued drawing set in your discipline |

It surfaces work; it doesn't grant it — every CTA still lands on a screen the role is already
permitted to use (the allowlist below is unchanged).

The exact who-can-do-what allowlist for every action lives in one place —
`packages/shared/src/domain/policy.ts` (`ROLE_POLICY`) — and the API and web UI both read
from it, with a CI test that fails if they ever drift.

---

## How to make someone an admin

1. Sign in as the **owner** (e.g. `jp@vitan.in`).
2. **Team** screen → **Organization Admins** → enter their **name + email/phone**, set role
   **Admin**, click **Add admin**. This provisions their login.
3. They sign in (email-OTP / password / Google) and immediately have full PMC access to every
   project — but cannot touch the admin roster or remove you.

> This is a **live-API** action (real sign-in, not the demo), and the Organization Admins
> section is visible only to the owner — so do it signed in as the owner.

## Making the owner (bootstrapping / "I don't see Organization Admins")

If **no one you can sign in as is an owner** — the seeded `pmc@vitan.in` is the org owner by
default; another account (e.g. `jp@vitan.in`) may have been added as an *admin* and so can't
manage the roster — promote an owner without shell access:

1. On the **API** app set `ORG_OWNER_EMAIL=jp@vitan.in` and `AUTO_ENSURE_ACCOUNTS=true`.
2. **Redeploy.** On boot, `ensure-accounts` promotes that account's org membership to **owner**
   (idempotent, and it doesn't demote anyone). The account must already exist — sign them in
   once first if needed.
3. Sign in as that account → the **Organization Admins** section now appears. Unset
   `AUTO_ENSURE_ACCOUNTS` again if you prefer.

(Alternative: sign in as the seeded owner `pmc@vitan.in` — office password, default `vitan123`
unless changed — and promote the other account to Owner from the roster UI.)
