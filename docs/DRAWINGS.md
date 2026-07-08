# Vitan PMC — Drawings Register

Controlled drawings the site team builds from — the source of truth for execution,
distinct from progress **photos** (`Media`). PDF for the field, DWG as the CAD source,
plus sketch/reference images.

## Model

- **`Drawing`** — a register entry, unique by `(projectId, number)` (e.g. `A-201`). Has
  `title`, `discipline` (architectural / structural / mep / other), optional `zone`,
  and a `activityId` / `decisionId` link (the work it governs).
- **`DrawingRevision`** — one issue (Rev A, B, C…) with `status`
  (`for_review` / `for_construction` / `superseded`), the file (via `StorageService` —
  S3/R2 or the DB dev stub, same seam as `Media`), `issuedBy`, `issuedAt`, `note`.

**Current = the latest non-superseded revision.** Issuing a new revision of an existing
number **auto-supersedes** the prior ones, so the field only ever builds from the current
`for_construction` set.

## Formats

| Format | Handling |
|---|---|
| **PDF** | Inline viewer (`<iframe>`) — zoom/pan; the primary field format. |
| **Images** (sketches, references) | Inline `<img>`, tap to zoom. |
| **DWG / DXF** | **Download-only** — browsers can't render CAD. Issue the PDF export for the field; the DWG is the downloadable source. |

`StorageService` accepts `application/pdf`, `image/vnd.dwg`, `application/acad`,
`application/dxf`, `image/vnd.dxf` in addition to the image types.

## API

- `POST /projects/:projectId/drawings` — issue (auth required). New number → new register
  entry; existing number → new revision + supersede prior. Fans a **per-role push** to
  `engineer` + `contractor` ("Drawing issued: A-201 Rev C — …").
- `GET /drawings/rev/:id` — serve a revision's file (inline bytes for the dev stub, 302 to
  the bucket URL for S3/R2). Public (ids are unguessable cuids).
- `DELETE /drawings/:id` — delete a drawing + all revisions (bucket objects + rows),
  auth-required, scoped to the caller's project.
- Snapshot exposes `drawings[]`, each with `current` + full `revisions[]` (newest first).

## Frontend

A **Drawings** screen (all roles) grouped by discipline: each entry shows number, title,
current rev + status, "governs ACT-xx", and revision count. Opening one shows the current
revision (PDF/image inline, DWG download) plus the **revision history** with superseded
issues clearly marked. PMC gets an **Issue drawing** flow (file picker → number/title/
discipline/rev). The local demo seeds three drawings (mock SVG sheets) and issues locally.

## Slice 2 — linkage + acknowledgement + RBAC

- **`DrawingAck`** model — `user × revision` (unique), so acknowledgements are **per
  revision**: a superseding issue starts a fresh round. The snapshot adds `acks[]` to each
  revision and `ackedByMe` to each drawing (the caller's ack of the current rev).
- **`POST /projects/:id/drawings/rev/:revId/ack`** — the caller confirms "building to
  Rev X". Idempotent; **audited** (`drawing_ack`); the PMC is notified in realtime. Client
  is refused (they don't build).
- **RBAC tiers**: **PMC issues** (`POST /drawings` now 403s a non-PMC); **engineer /
  contractor** view + acknowledge; **client** curated read-only (no ack).
- **Frontend**: the drawing viewer shows a **"Building to Rev X"** block — who has
  acknowledged (name · role · date) and, for engineer/contractor, an **"I'm building to
  Rev X"** button (→ a "You're building to Rev X" confirmation). The **Site Schedule**
  links each activity to the drawing it builds from (a `A-201 · Rev C` chip that opens the
  register). The viewer reads the live drawing from the store, so a fresh ack shows at once.

## Slice 3 — offline cache + presigned uploads

- **Offline drawing cache (PWA)**: the service worker (`v2`) now runtime-caches drawing /
  media files (`/drawings/rev/*`, `/media/*`) on **any origin** — the API is a subdomain —
  with **stale-while-revalidate** into a dedicated `vitan-pmc-files-*` cache. Opaque
  (no-cors) responses are cacheable and render in `<iframe>`/`<img>`/`<a download>`, so a
  drawing the field has opened (its thumbnail loads it too) **stays viewable when the
  signal drops**. A failed revalidate keeps serving the cached copy. API JSON is still
  never intercepted.
- **Presigned direct-to-bucket uploads**: `POST /projects/:id/drawings/presign { mime }`
  (PMC only) returns `{ uploadUrl, storageKey }` in S3/R2 mode, or `{ presign: null }` on
  the dev stub. The client PUTs the bytes **straight to the bucket** (bypassing the API
  body limit) then issues with `{ …meta, storageKey, sizeBytes }` instead of base64.
  `issueDrawing` auto-routes: files ≥ ~3 MB try the presigned path and fall back to the
  base64 body if no bucket is configured or the PUT fails. Env-only to enable (`S3_*`),
  same seam as media (`StorageService.presignPut`, `@aws-sdk/s3-request-presigner`).

## Roadmap

- **Slice 1:** register + revisions + viewer + issue + per-role push. ✅
- **Slice 2:** activity linkage on the schedule; **acknowledgement** ("building to Rev C")
  + audit; RBAC (PMC issues; engineer/contractor view+ack; client read-only). ✅
- **Slice 3:** offline PDF caching (PWA, service worker `v2`) for the field; **presigned
  direct-to-bucket uploads** for large drawings (auto-routed, base64 fallback). ✅
- **Later (optional):** server-side DWG→PDF conversion so the CAD source auto-produces the
  field PDF; explicit "make available offline" prefetch of the full current set.
