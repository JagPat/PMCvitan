# Vitan PMC — Data Model

The relational model (PostgreSQL) for the domain. The frontend today runs against an in-memory seed of the same shapes (`packages/shared/src/domain`); Phase 7 stands this schema up behind the NestJS API. The Prisma schema lives at [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `Project` | A construction project the practice manages | name, descriptor, stage, siteCode, projStart/projEnd |
| `User` | An account-holding member (PMC/client/contractor) | name, email, phone |
| `Membership` | A user's role on a project | userId, projectId, **role** (`pmc\|client\|engineer\|contractor`) |
| `Worker` | On-site identity **without an account** (recognised by QR/face) | name, tradeKey, projectId |
| `Decision` | A client decision | code (DL-014), title, room, **status** (`pending\|approved\|change`), approvedOptionId, approver, approvedAt, costPaise |
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
