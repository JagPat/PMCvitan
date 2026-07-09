# Vitan PMC — Orgs, Projects & Team Access (multi-tenant)

Moves the app from single-project to **an org (account) that owns many projects**,
with per-project team memberships and token-level tenancy isolation.

## Model

- **`Org`** — an architecture practice (e.g. "Vitan Architecture"). Owns projects.
- **`OrgMembership`** — `user × org × role` where role ∈ `owner | admin | member`.
  Owners/admins create projects and manage teams.
- **`Membership`** — `user × project × role` where role ∈ `pmc | client | engineer |
  contractor`, with a `status` (`invited | active | removed`). **This is the access
  grant the app scopes tokens to.** A user can hold different roles on different projects.
- **`Project`** gains `orgId` (nullable, for back-compat).
- **`User`** stays the identity (email/phone/password) + a legacy `projectId`/`role`
  (their "home" project) used as a fallback when no membership rows exist.

## Roles — who can do what (the "admin")

Two independent layers of access:

- **Org role** (`OrgMembership.role` = `owner | admin | member`) — *administrative* power over the
  account: **create projects**, **manage any project's team**, and (super-admin) **operate every
  project in the org**. `owner` and `admin` are the "admin who can do everything".
- **Project role** (`Membership.role` = `pmc | client | engineer | contractor`) — *operational*
  capability **within one project** (what screens/actions you get). PMC = full control of that project.

**Org super-admin reach.** An org `owner`/`admin` isn't limited to projects they're an explicit member
of — they can switch into **any project in their org and operate it as PMC**, even without a `Membership`
row. Concretely: `switchProject` issues a `pmc`-scoped token for any org project when the caller is an
org owner/admin; `/me/memberships` (the switcher) and `/me/portfolio` (the board) list **every** project
in their org (explicit-membership roles win; the rest surface as PMC); team management (`canManage`) already
accepts the project's org owner/admin. So the admin can **create projects, build teams, assign roles, and
run every project** — the full feature set — while a plain org `member` only sees the projects they're
explicitly added to.

## Tenancy isolation

A JWT is scoped to **one project** (`{ sub, role, projectId }`). `JwtGuard` now rejects
any request whose `:projectId` route param doesn't match the token's project — so a
valid token for project A can't read or write project B. Switching projects requires a
fresh token from `POST /auth/switch` (granted only for a project you're a member of).

## API (Slice 1 — backend foundation)

- `GET /me/memberships` — projects the caller can access (drives the project switcher);
  falls back to the home project for pre-membership users.
- `POST /auth/switch { projectId }` — re-scope the session to another project you belong to.
- `GET /me/orgs` — orgs the caller administers/belongs to.
- `POST /orgs { name }` — create an org (caller becomes `owner`).
- `POST /orgs/:orgId/projects { name, short, … }` — create a project (owner/admin only);
  the creator is auto-enrolled as the project's **PMC**.
- `DELETE /orgs/:orgId/projects/:projectId` — **archive** (soft-delete) a project (owner/admin).
  Sets `Project.archivedAt`; the project is then hidden from `/me/memberships`, `/me/portfolio`,
  the org's project list, and `POST /auth/switch` refuses it. Reversible via
  `POST /orgs/:orgId/projects/:projectId/restore`. Soft (not hard) delete keeps the audit trail
  and sidesteps FK-cascade risk; a member's live token still works until it expires.
- `GET /orgs/:orgId/projects` — list an org's (non-archived) projects (members only).

**Frontend**: the **Team** screen gains a "Danger zone → Archive project" control (org owner/admin
only, two-click confirm); archiving switches you to another accessible project and the switcher/
portfolio refresh. Creating a project is the switcher's **New project** flow.

The snapshot + all mutations remain `projectId`-scoped and unchanged; they're now
protected by the tenancy guard.

### Team management (Slice 2)

Project-scoped, so the tenancy guard already limits the caller to their project.
Gated to the project's **PMC** or an **owner/admin** of the owning org:

- `GET /projects/:projectId/members` — list the team (name, email/phone, role, status).
- `POST /projects/:projectId/members { name, role, email? | phone? }` — add a member;
  provisions the account if new (so, with invite-only auth, they can then sign in by
  email-OTP / password / phone-OTP) and upserts the `Membership`.
- `PATCH /projects/:projectId/members/:userId { role }` — change a member's role.
- `DELETE /projects/:projectId/members/:userId` — soft-remove (`status = removed`);
  you can't remove yourself.

### Phases & monitoring (Slice 3)

Adds **phase-level monitoring** and a **cross-project portfolio**:

- **`Phase`** model — `id, name, order, plannedStart, plannedEnd` (planned window as
  day-offsets, like activities); `Activity` gains a nullable `phaseId`. A phase groups
  activities so progress can be read per phase, not just per activity.
- **Snapshot `phases[]`** — each phase carries a live rollup computed from its activities
  (`activityTotal, done, inProgress, blocked, notStarted, donePct`). Activities now carry
  `phaseId`. Empty `phases[]` ⇒ the schedule renders a flat list, unchanged.
- **`GET /me/portfolio`** — one row per project the caller can access, each with an
  activity rollup, `openReviews`, RBAC-gated `pendingDecisions` (0 unless pmc/client on
  that project), `phaseCount` and `milestonePct`. Answers "how are all my projects doing?"
- **Frontend**: the **Site Schedule** groups activities under phase headers with a
  per-phase progress bar + running/blocked/to-start counts (recomputed **live** in a
  selector, so Start/Mark-complete moves the bar immediately); a new **Portfolio** screen
  (PMC nav) shows every project as a monitoring card with an **Open project** action that
  re-scopes the session (the project switcher, by card). Local demo synthesises a single
  portfolio row from the seeded state.

## Seed / backfill

- `seed.ts` (destructive — dev only) creates the org **Vitan Architecture** owning
  `ambli`, with `OrgMembership` + `Membership` rows for the demo accounts, and seeds
  **3 phases** (Services & Waterproofing → Wet Areas & Fittings → Finishing) with the
  activities filed under them.
- **`ensure-accounts.ts` (safe on prod)** upserts the org, links the project to it,
  ensures each account's `Membership` + `OrgMembership`, and (for `ambli`) upserts the
  phases and files each activity under one **only when it has no phase yet** — the
  non-destructive way to make a live DB multi-tenant + phased. Config via `ORG_SLUG` /
  `ORG_NAME` / `ACCOUNTS_JSON`.

## Deploy safety

Every migration here only **adds** tables/columns (nullable `Project.orgId`, nullable
`Activity.phaseId`, the `Phase` table), so it's non-breaking: existing tokens keep working
(tenancy check passes for same-project requests), users with no membership rows fall back
to their home project, and a project with no phases renders its schedule flat. Prod stays
single-project until `ensure-accounts` backfills the org/memberships/phases.

## Next

Drawings Slice 2 (activity ↔ drawing linkage + build-acknowledgement), then sign-in
activation (live email/Google) once the office accounts have a working real sign-in.
