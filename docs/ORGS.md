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
- `GET /orgs/:orgId/projects` — list an org's projects (members only).

The snapshot + all mutations remain `projectId`-scoped and unchanged; they're now
protected by the tenancy guard.

## Seed / backfill

- `seed.ts` (destructive — dev only) creates the org **Vitan Architecture** owning
  `ambli`, with `OrgMembership` + `Membership` rows for the demo accounts.
- **`ensure-accounts.ts` (safe on prod)** upserts the org, links the project to it, and
  ensures each account's `Membership` + `OrgMembership` — the non-destructive way to make
  a live DB multi-tenant. Config via `ORG_SLUG` / `ORG_NAME` / `ACCOUNTS_JSON`.

## Deploy safety

The migration only **adds** tables + a nullable `Project.orgId`, so it's non-breaking:
existing tokens keep working (tenancy check passes for same-project requests), and users
with no membership rows fall back to their home project. Prod stays single-project until
`ensure-accounts` backfills the org/memberships.

## Next (Slice 2 — frontend)

Project switcher (calls `/me/memberships` + `/auth/switch`), create-project + a Team
screen (add/remove members, set roles, invites), and a runtime active-project (replacing
the hardcoded `PROJECT_ID`). Then phase-based monitoring + a portfolio view.
