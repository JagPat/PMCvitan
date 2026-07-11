# Vitan PMC — Data Model

The relational model (PostgreSQL) for the domain. The frontend today runs against an in-memory seed of the same shapes (`packages/shared/src/domain`); Phase 7 stands this schema up behind the NestJS API. The Prisma schema lives at [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `Project` | A construction project the practice manages | name, descriptor, stage, siteCode, projStart/projEnd |
| `ProjectNode` | A node in the project's **location tree** (zone → room → object) | projectId, parentId, name, **kind** (`zone\|room\|element`), order |
| `User` | An account-holding member (PMC/client/contractor) | name, email, phone |
| `Membership` | A user's role on a project | userId, projectId, **role** (`pmc\|client\|engineer\|contractor`) |
| `Worker` | On-site identity **without an account** (recognised by QR/face) | name, tradeKey, projectId |
| `Decision` | A client decision | code (DL-014), title, room, **nodeId** (location-tree link), **status** (`pending\|approved\|change`), approvedOptionId, approver, approvedAt, costPaise |
| `DecisionOption` | An option presented for a decision | label, material, deltaPaise, swatch, recommended |
| `DecisionEvent` | **Append-only** lifecycle/audit log | type (`issued\|approved\|locked\|change_requested`), actor, at, payload |
| `ChangeRequest` | A change against a locked decision | reason, costImpactPaise, timeImpactDays, status |
| `Activity` | A unit of site work (the spine) | code (ACT-31), name, zone, decisionId, plannedStart/End, actualStart/End, **status** (`not-started\|in-progress\|done\|blocked`) |
| `ActivityGate` | The four readiness gates | activityId, kind (`decision\|material\|team\|inspection`), state (`ok\|wait\|fail\|na`) |
| `Inspection` | A checklist / review | code (INSP-22), title, zone, submittedBy, submittedAt, decidedAt |
| `InspectionItem` | A line item | name, state/result, note, reinspectionOfId |
| `DailyLog` | One site-day | projectId, date, checkedInAt, submittedAt |
| `AttendanceEvent` | Check-in / QR / face | dailyLogId, workerId, kind, at, geo, selfieMediaId |
| `CrewCount` | Crew present per trade | dailyLogId, trade, count |
| `SiteMaterial` | Material delivered on site | name, decisionId, qty, zone, matched, mediaId |
| `Media` | An uploaded photo | url, geo, takenAt, activityId?, decisionId? |
| `Notification` | Feed item | projectId, text, kind/color, at |
| `SyncOutboxEntry` | Offline mutation queue (idempotency) | clientId, opType, payload, appliedAt |
| `AuditLog` | Global attribution trail | actor, action, entity, entityId, at |

## Conventions

- **Money** stored as integer **paise** (`costPaise`, `deltaPaise`) — formatted with Indian digit grouping (`₹1,40,000`) on the client via `inr()`/`signed()`.
- **Dates** as `timestamptz`; UI dates render `DD MMM YYYY`.
- **Enums** match the frontend string unions exactly (`packages/shared/src/domain/types.ts`) so the API contract and UI stay aligned.
- **Locked decisions** are immutable; state transitions only via `DecisionEvent` + `ChangeRequest` (never in-place edits).
- **Gates** — the `decision` gate is derived live from the linked decision's status; `material/team/inspection` are stored and mutated by site events (e.g. a flagged material mismatch sets the `material` gate to `fail` and blocks the activity).

## Core flows (server responsibilities)

1. **Approve → lock**: transaction sets `Decision.status=approved`, writes a `DecisionEvent(approved)` + `AuditLog`, emits a notification, and any linked activity's decision gate recomputes to `ok`.
2. **Inspection submit → review → re-inspection**: guarded submit; PMC approve/reject creates `InspectionItem` re-inspection rows and notifications.
3. **Material mismatch**: flags `SiteMaterial.matched=false`, sets the linked `Activity` material gate to `fail`, transitions the activity to `blocked`, notifies PMC.
4. **Complete activity**: sets `actualEnd`, auto-creates a closing `Inspection`, notifies.
5. **Offline sync**: `SyncOutboxEntry` rows replay with idempotency keys on reconnect; stale writes to locked decisions are rejected.

## Location tree (zones → rooms → objects)

Decisions (and, in time, activities, inspections and materials) attach to a place on site instead of a free-text room string. `ProjectNode` is a per-project, self-referential tree with a **strict three-level hierarchy**:

```
ProjectNode  id, projectId, parentId?, name, kind (zone|room|element), order, createdAt
             zone   → parentId = null           (e.g. "Ground Floor")
             room   → parent is a zone           (e.g. "Master Bedroom")
             element→ parent is a room           (e.g. "Main Door")  ← the "object"
```

An **object** ("Main Door") is an `element`; it can carry many decisions (the lock, the veneer) or just one. `Decision.nodeId` points at whichever level the decision belongs to (a room-wide finish attaches to the room; a lock attaches to the element). The link is `SET NULL` on delete so a decision is never lost when its node is removed.

**Rules the server enforces** (`NodesService`):
- **Parent-kind**: a `zone` has no parent; a `room` must sit under a `zone`; an `element` must sit under a `room`. Creating or moving a node to a wrong-kind parent is a `400`.
- **Same project**: a parent must belong to the same project (else `404`).
- **Cycle-safe move**: a node cannot be reparented under itself or any of its descendants.
- **Delete guard**: a node whose subtree has any decision attached cannot be deleted (`400`) — detach or move the decisions first.

```
POST   /projects/:id/nodes                { name, kind, parentId? }   -> Snapshot   # pmc only
PATCH  /projects/:id/nodes/:nodeId        { name }                    -> Snapshot   # pmc only
POST   /projects/:id/nodes/:nodeId/move   { parentId, order? }        -> Snapshot   # pmc only
DELETE /projects/:id/nodes/:nodeId                                    -> Snapshot   # pmc only
```

The snapshot carries the flat `nodes: NodeDto[]` list; the client rebuilds the tree (`apps/web/src/lib/locationTree.ts`) and **groups the register by location / room / object / status / flat**, showing the finer breadcrumb (`Master Bedroom › Main Door`) as a per-row caption. Issuing a decision uses a cascading Zone › Room › Object picker (with inline "＋ New…" node creation) rather than a free-text room field. Decisions issued before the tree existed keep their `room` string and fall back to an "Unfiled"/room-named group.

> **Migration** `20260715000000_add_location_tree` is **additive and nullable** — it creates `ProjectNode` and adds a nullable `Decision.nodeId` (FK `ON DELETE SET NULL`); no backfill, no data rewrite, safe to apply on a live database.

## API contract (Phase 7, ts-rest sketch)

```
POST   /projects/:id/decisions/:decisionId/approve   { optionIndex }        -> Decision
POST   /projects/:id/decisions/:decisionId/change     { reason, cost, days } -> ChangeRequest
POST   /projects/:id/inspections/:id/submit           { items }              -> Inspection
POST   /projects/:id/inspections/:id/decide           { rejectedItemIds }    -> Inspection
POST   /projects/:id/activities/:id/start | /complete                        -> Activity
POST   /projects/:id/daily-log/submit                 { crew, materials }    -> DailyLog
POST   /projects/:id/materials/:idx/flag-mismatch                            -> void
GET    /projects/:id/snapshot                                                -> ProjectSnapshot
WS     /projects/:id/stream   (notifications, live-from-site)
```
Contracts are authored with Zod in `packages/shared` and shared by both the NestJS handlers and the typed client.

## Auth (Phase 7c-auth — implemented)

The single-project MVP collapses `User`/`Membership` above into one `User` table (role held directly on the row) and models on-site identity as `WorkerDevice` (a no-account, token-only record). Both are additive; the rest of the schema is unchanged.

```
User          id, projectId, role (pmc|client|engineer|contractor), name, email?, phone?, passwordHash?
WorkerDevice  id, projectId, name?, trade?, token, createdAt, lastSeen
```

Three ways in (all issue a role-scoped JWT):

```
POST /auth/login         { email, password }            -> { token, role, projectId, name }   # bcrypt, PMC/client/contractor
POST /auth/otp/request   { phone, projectId }           -> { sent, live, devCode? }            # MSG91 v5; devCode only in stub mode
POST /auth/otp/verify    { phone, code, projectId }     -> { token, role, projectId, name }    # provisions a site engineer on first use
POST /auth/worker/token  { projectId, name?, trade? }   -> { token, role: 'worker', ... }      # no-account QR / tap-photo job card
POST /auth/email/request { email, projectId }           -> { sent, live, devCode? }            # email OTP (zero-DLT); devCode only without SMTP
POST /auth/email/verify  { email, code, projectId }     -> { token, role, projectId, name }    # reuse account by email, else provision
POST /auth/google        { idToken, projectId }         -> { token, role, projectId, name }    # verify Google ID token; disabled without GOOGLE_CLIENT_ID
POST /auth/session       { role, projectId }            -> { token, role, projectId }          # passwordless dev auth; gated by ALLOW_DEV_AUTH
```

**Phone-OTP delivery is channel-pluggable** (`SmsService`), priority **MSG91 → Telegram Gateway → dev-stub** (first configured wins): MSG91 is real SMS (needs DLT); **Telegram Gateway** (`TELEGRAM_GATEWAY_TOKEN`) delivers a code we generate via Telegram by phone number (**zero-DLT, free**, verified locally); the stub logs/returns the code. **Email OTP** (`EmailService`, SMTP or stub) and **Google sign-in** (`GoogleAuthService`, verifies an ID token against `GOOGLE_CLIENT_ID`) are additional zero-DLT paths. All passwordless sign-ins resolve via `signInOrProvision` — reuse the account matched by email/phone, else provision a site engineer (same trust model as the original phone-OTP flow).

**OTP delivery** (`SmsService`) uses MSG91's v5 OTP API when `MSG91_AUTH_KEY` + `MSG91_TEMPLATE_ID` are set (MSG91 owns generation, storage and verification against the DLT-approved `##OTP##` template). With no provider configured it falls back to an in-memory dev stub that logs the 4-digit code and returns it, so the flow is demoable without SMS. **RBAC**: only `pmc`/`client` see pending decisions in the snapshot; every other role (contractor, engineer, worker) is restricted to decided ones.

## Media (Phase 7c-media — implemented, backend)

Site photos are provider-agnostic and dev-stub-first (same shape as OTP). One additive `Media` table:

```
Media  id, projectId, kind (progress|inspection|decision|attendance|material),
       mime, data (Bytes, dev stub), url (S3/R2), storageKey, sizeBytes,
       geoLat?, geoLng?, takenAt?, uploadedBy, decisionId?, dailyLogId?, createdAt
```

```
POST /projects/:id/media   { kind, mime, data (base64), decisionId?, geoLat?, geoLng?, takenAt? }  -> { id, url }   # auth
GET  /media/:id                                                                                     -> image bytes or 302 to bucket
```

`StorageService` writes bytes to an S3/R2 bucket when `S3_ENDPOINT` + `S3_BUCKET` + key/secret are set (then `Media.url` is the public URL and `data` is null); with no provider it keeps the bytes in `Media.data` and `GET /media/:id` streams them (the dev stub). The API's JSON body limit is raised to 12 MB for base64 uploads. Every upload emits a realtime `changed` signal. The frontend uploads progress photos from the daily log and renders a zoomable gallery (`dailyLog.photos` in the snapshot).

## Web Push (Phase 8 — implemented)

One additive `PushSubscription` table (`endpoint` unique, `p256dh`/`auth` keys, optional `role`). `PushService` fans project notifications out to every subscription via VAPID (`web-push`) when `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` are set; with no keys the send path is a no-op (subscriptions are still stored). Notification-bearing mutations pass their text to `realtime.notifyChanged(projectId, body)`, which both signals the room and sends the push. Endpoints: `GET /push/public-key`, `POST /projects/:id/push/subscribe`. The service worker handles `push`/`notificationclick`; the client subscribes when notification permission is already granted.

```
PushSubscription  id, projectId, endpoint (unique), p256dh, auth, role?, createdAt
```
