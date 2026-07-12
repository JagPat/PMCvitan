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

4. **Frontend store + URL** — the URL is **`/projects/:projectId/<screen>`**, so it is the source
   of truth for the active project: a refresh, bookmark or shared link restores both which project
   you're in and where you were (`RouteBridge` seeds `activeProjectId` + `screen` from the URL on a
   cold load, then keeps them in sync both ways; navigating the URL to a different project you can
   access switches to it; an unknown/forbidden project or screen redirects to the active project's
   role-default). `activeProjectId` names the current project; the store holds **that project's
   snapshot only**, and its live **project identity** (`name`/`short`/`descriptor`/`stage`/
   `siteCode`/`milestonePct`) comes from the snapshot too — screens read the store, never the
   `PROJECT` seed constant, so every surface (Dashboard, client screens, the rail footer) re-labels
   on a switch. `switchProject` **atomically** adopts the new token, **drops every project-scoped
   collection** (so the previous project's records can't linger under the new selection), sets
   `projectSwitching` to show a loading state until the new snapshot lands, and updates the URL.
   `applySnapshot` **ignores any snapshot whose `project.id` ≠ `activeProjectId`** (a late reply or
   a socket refetch that raced the switch), so a stale snapshot can never overwrite the active one.
   The Site Schedule / Decision Log / Site Map therefore always render exactly one project — never
   a merge, never a flash of the previous one.

### Super-admin nuance
An Org `owner`/`admin` can operate **every project in their org as PMC** even without an explicit
membership — but still **one project at a time**: `switchProject` issues a PMC token scoped to the
chosen project, so the tenancy guard above is unchanged. See [`ORGS.md`](./ORGS.md).

---

## Invariants (deliberate scope decisions)

These are conscious choices, documented so an absent value is never read as an accident:

- **`projectId` is mandatory; `nodeId` (a Site Map location) is optional — and an absent `nodeId`
  means _project-wide_, never _global_.** A drawing, activity, inspection, material or photo with
  no location applies across the whole project (a site plan, general notes, a project-level
  activity) — it is still owned by exactly one project. There is no cross-project record. The
  filing pickers place records on the location tree when a place is known; leaving one unfiled is
  a valid "applies to the whole project" state, surfaced in the Site Map's whole-project view.

- **One PMCvitan project = one construction site / job.** `Project.location` is free text and the
  Site Map's location tree starts at `zone`; there is no `Site`/`Building` layer above `zone`. If a
  single project must ever span multiple physical sites/campuses, introduce a first-class `Site`
  layer **before** building further on the spine — don't overload `zone`.

- **Reusable standards are a future Org-scoped concept, not a per-project or global one.** Today
  "templates" means only messaging-provider templates. Method statements, inspection checklists and
  schedule templates — when built — will belong to the **Org**, be **versioned**, and be **copied
  or referenced** when instantiated into a project. A created inspection/activity always carries a
  `projectId` (and preferably a `nodeId`) even when spawned from an `Org` template; the template is
  the *method*, the instance is the *work*. Until then, each project authors its own inspections.
