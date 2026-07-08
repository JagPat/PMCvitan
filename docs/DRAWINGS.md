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

## Roadmap

- **Slice 1 (this):** register + revisions + viewer + issue + per-role push. ✅
- **Slice 2:** activity/decision linkage surfaced on the Site Schedule / gate view;
  drawing on the worker job card; **acknowledgement** ("building to Rev C") + audit; RBAC
  (PMC issues; engineer/contractor view+ack; client curated read-only).
- **Slice 3:** offline PDF caching (PWA) for the field; **presigned direct-to-bucket
  uploads** for large drawings (the current path is the 12 MB base64 body); optional
  server-side DWG→PDF conversion.
