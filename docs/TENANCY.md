# Vitan PMC — Project scoping (what's global vs per-project)

**Vitan PMC is multi-tenant.** A practice (an **Org**) runs many projects; a person operates
**one active project at a time** and monitors all of them from the Portfolio. Every operational
record belongs to exactly one project — nothing about a specific site is global.

If the app ever *looks* single-project, that's the **local demo**: with no `VITE_API_URL` it
ships one seeded project ("Residence at Ambli"), and the top-left buttons switch **role**, not
project. In API mode there's a project switcher and everything below re-scopes.

For the data model and accounts/memberships see [`ORGS.md`](./ORGS.md); this page is the
scoping cheat-sheet.

---

## The line: global vs project-scoped

**Global — the "how it works" layer (shared across all projects):**

- The **Org** (account) and its **admin roster** (owner/admin/member); user accounts.
- **Methods, not data:** the authorization policy (`ROLE_POLICY`), the domain schemas/types,
  swatches, i18n, the screen/route definitions. These describe *how* an inspection or a decision
  behaves — not any particular one.
- The **Portfolio** rollup — the one screen that deliberately spans projects (a card per project).

**Project-scoped — every *instance* of work (never global):**

- Decisions & change requests · Drawings & revisions · Inspections & checklists · Activities,
  phases & the schedule · the **location tree / Site Map** · materials & daily logs · media/photos ·
  notifications · **drafts** (of decisions and drawings) · the team & companies on the project.

So: *methods can be global; an inspection, a drawing, a schedule, a decision log cannot.*

---

## Per screen

| Screen | Scope |
|---|---|
| Site Schedule | the **active project's** activities & phases |
| Decision Log | the active project's decisions |
| Drafts | the active project's draft decisions/drawings (author-private within it) |
| Inspection Review | the active project's inspections (pmc) |
| Drawings | the active project's register |
| Site Map | the active project's location tree |
| Dashboard | the active project's KPIs — **single project** |
| **Portfolio** | the **only** cross-project screen — one rollup card per accessible project |

The Dashboard is a single-project summary; the **Portfolio** is "all my sites at a glance," and
opening a card switches you into that project.

---

## How scoping is enforced (four layers)

1. **Database** — every top-level table carries a `projectId` FK: `Decision`, `Activity`,
   `Phase`, `Inspection`, `Drawing`, `ProjectNode`, `Media`, `DailyLog`, `SiteMaterial`,
   `Notification`, `Membership`, … Child rows hang off a parent that has one. Nothing is loose.

2. **API routes** — every read/mutation is under `POST|GET|… /projects/:projectId/…`, and the
   snapshot is built per project: `snapshot.build(projectId, role, userId)` with every query
   `where: { projectId }`. There is **no** "all decisions / all activities across projects"
   endpoint (the Portfolio uses a dedicated `GET /me/portfolio` rollup).

3. **Token + tenancy guard** — a session token is scoped to **one** project. `JwtGuard`
   (`apps/api/src/common/auth.ts`) rejects any request whose route `:projectId` doesn't match the
   token's project → **403**. So a token for project A can't read or write project B. Switching
   projects mints a **fresh token** via `POST /auth/switch` (verified on prod: same-project 200,
   cross-project 403).

4. **Frontend store** — `activeProjectId` names the current project; the store holds **that
   project's snapshot only**. `switchProject` gets the new token, sets `activeProjectId`, and
   refetches + **fully replaces** the store (decisions, activities, drawings, inspections,
   nodes…). So the Site Schedule / Decision Log / Site Map always render exactly one project —
   never a merge across projects.

### Super-admin nuance
An Org `owner`/`admin` can operate **every project in their org as PMC** even without an explicit
membership — but still **one project at a time**: `switchProject` issues a PMC token scoped to the
chosen project, so the tenancy guard above is unchanged. See [`ORGS.md`](./ORGS.md).
