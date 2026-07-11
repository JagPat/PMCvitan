# Vitan PMC — Drafts (private work-in-progress → publish)

Some things aren't ready to share the moment you start them. A decision needs its options,
photos and costs pieced together first; you want a **private place to keep working**, and to
decide *when* it becomes real. That's the **Draft → Publish lifecycle**.

A **draft** is a record you're still building. While it's a draft it is:

- **private to its author** — the server delivers it only to the person who created it, never
  to the client or the rest of the team (enforced in the snapshot, not just hidden in the UI);
- **weightless** — it never counts as pending, never notifies anyone, never drives a schedule
  gate, and doesn't appear on the Decision Log, the Site Map, the dashboard, or the portfolio.

When it's ready you **Publish** it. Only then does it enter the shared snapshot, ask the client
to act, and start driving the app. Publishing is the single moment the app "takes action" on
your data.

> Applies to **decisions**, **drawings** and **locations** today (the same `publishedAt` +
> `authorId` model on each). The pattern generalises further to other authored records in later
> slices.

---

## Where it lives

- **Drafts workspace** (`/drafts`, PMC) — your private holding area, unified across entity types.
  Draft **decisions** list their shortlisted options with a **Publish to client** button; draft
  **drawings** show a thumbnail + revision with a **Publish to team** button. Both with a
  readiness check. Nothing here is visible to anyone else.
- **New-decision / New-drawing modals** — each *New…* dialog offers **Save as draft** (private)
  or **Publish** (issue in one step: a decision goes to the client, a drawing to the build team).
- **"For You"** — the PMC's action queue shows *"N drafts in progress"* (decisions + drawings) so
  a draft never gets forgotten in the drawer.
- **Publish all** — when the workspace holds two or more drafts, a **Publish all N** button issues
  every one in a single action (each decision to the client, each drawing to the team) — "feed in
  a batch, release it together."

---

## Data model

`Decision` gains two additive, nullable columns (migration
`20260805000000_decision_draft_lifecycle`):

| Column | Meaning |
|---|---|
| `publishedAt` (`timestamptz?`) | `null` ⇒ **draft**. Set on publish. Existing rows are backfilled to `createdAt` so nothing becomes an invisible draft on deploy. |
| `authorId` (`text?`) | the creator — the only user the snapshot delivers the draft to while it's unpublished. |

Both nullable/additive, so the migration is safe on the live DB with no backfill risk.

## Endpoints

- `POST /projects/:id/decisions` — **creates a draft by default**. Pass `publish: true` to
  issue in one step. A draft creates **no** client notification and **no** realtime push.
- `POST /projects/:id/decisions/:decisionId/publish` (**pmc**) — flips `publishedAt`, notifies
  the client, and fires the same side-effects a one-step issue does. Re-publishing conflicts.

**Drawings mirror this exactly.** `Drawing` gained the same `publishedAt` + `authorId`
(migration `20260810000000_drawing_draft_lifecycle`). `POST /projects/:id/drawings` **creates a
new drawing as a draft by default** (`publish: true` issues in one step; a draft notifies no
one); `POST /projects/:id/drawings/:drawingId/publish` (**pmc**) issues a draft to the build
team. A draft drawing is absent from the register, the Site Map, and the acknowledgement queue
until published. (Adding a revision to an already-published drawing is a normal issue.)

**Locations extend the pattern to the project's spine.** `ProjectNode` gained the same
`publishedAt` + `authorId` (migration `20260815000000_node_draft_lifecycle`), so a PMC can build
out a new floor — a whole zone→room→object branch — **privately** before it exists for anyone
else. `POST /projects/:id/nodes` **publishes by default** (`publish: false` makes a private
draft); a child created under a draft parent is **forced draft too** (you can't have a live room
inside a hidden floor). `POST /projects/:id/nodes/:nodeId/publish` (**pmc**) reveals the branch —
and because the location spine is what six other modules file onto, publishing keeps two
invariants:

- **cascade, no orphan** — publishing a node also publishes its whole **subtree** *and* any
  still-draft **ancestors**, so a live location never hangs off a hidden parent;
- **nothing files onto a draft** — the location pickers (Issue-decision / Issue-drawing / photo
  upload) only ever offer **published** nodes, so no published record can point at a draft node.
  A draft node is therefore always empty, and is hidden from the Site Map until published.

## Snapshot visibility (the guarantee)

The snapshot filters decisions like this:

```ts
if (d.publishedAt === null) return d.authorId === userId; // a draft → only its author
return !(hidePending && d.status === 'pending');          // else the existing AUTH-02 rule
```

So a draft's title, options and cost can never leak to another user through any surface — the
same server-side discipline as the AUTH-02 pending-decision gating.

## Frontend

- Shared `Decision.draft?: boolean`; the store's `publishDecision(id)` works against the API
  (server publish) **and** offline in the demo (local flip + client notification), so the whole
  "hold then publish" flow is demoable without a server.
- `selectDraftDecisions` powers the workspace; `selectPending` / `selectLogDecisions` and the
  Site Map / schedule / daily-log / portfolio surfaces all **exclude drafts**, so a draft stays
  weightless everywhere but the Drafts workspace.
- Shared `ProjectNode.draft?: boolean`; the store's `publishNode(id)` mirrors the server cascade
  (subtree + draft ancestors) and works offline in the demo. A PMC manages draft locations in the
  Decision Log's **Locations** editor (a DRAFT chip + **Publish** button per draft row, plus an
  "add as a private draft" toggle); the **LocationPicker** and **Site Map** read
  `nodes.filter(n => !n.draft)`, which is what keeps a draft node out of every filing surface.

The role→action allowlist for `decision.publish` lives in the shared `ROLE_POLICY`
(`packages/shared/src/domain/policy.ts`), mirrored by the API's `@Roles` and pinned by the
route-policy drift test — see [`ROLES.md`](./ROLES.md).
