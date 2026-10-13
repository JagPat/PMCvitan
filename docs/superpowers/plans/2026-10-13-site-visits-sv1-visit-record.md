# Site Visits SV1: the visit record (technical design)

**Status:** technical design for review. No code ships with this document.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792). Product plan:
[2026-10-12-site-visits.md](2026-10-12-site-visits.md) (approved as written by the Board, 13 Oct 2026, which also
placed Site Visits in the queue, Q8).
**Scope:** SV1 only (Board scope: "Start visit" and "Visit this area": who, when, GPS check-in, attendees and the
places walked; shows in the project's history; works offline). Observations, actions, reports and sharing are SV2
to SV5 and get their own designs.

## 0. Decisions this design depends on

| Item | What this design assumes | Source |
| --- | --- | --- |
| D5 | A visit is started by the PMC or a consultant (and an architect once the role opens). | Owner, 12 Oct |
| Q3 | Architects visit as **consultant** members until 4d-iii opens the role. SV1 grants `architect` nothing. | Plan proposal |
| Q6 | GPS is recorded when the phone offers it and never blocks a start. | Plan proposal |
| Q12 | A visit is added to and ended from the phone that started it; another device can only **close** it, with a reason. | Plan proposal |
| S1 | A plain **End visit** exists in SV1. An ended visit is never shown as signed or delivered. | Plan proposal |
| S2 | At most **one open visit per visitor per project**. | Plan proposal |

Q3, Q6, Q12, S1 and S2 were put to the owner on 13 Oct 2026. If the owner changes any of them, this document
changes before its first reviewed head. Nothing here widens a role's rights outside the new site-visit actions.

## 1. What people get

- **PMC:** "Start visit" on the PMC Brief (For You). **Consultant:** "Start visit" on For You.
- **Both:** "Visit this area" on a place in the Site Map, which starts a visit with that place as its starting
  place.
- While a visit is open, the visitor sees one card on For You: the time it started, the places walked so far,
  **Add place** and **End visit**.
- Everyone on the project sees the visit in the project feed (the bell) when it starts and when it ends, and on
  each place in the Site Map ("Visits here").
- The PMC can **close** anyone's open visit, with a reason.

## 2. Data (unit SV1-a, migration only)

One new module, `site-visits`, owns three tables. All are additive. No existing table gains a column.

**`SiteVisit`**
- `id` (uuid, generated **on the phone** so offline steps can name the visit before the server has it) and
  `projectId`. Unique `(projectId, id)`, so later tables (SV2 observations, Media) can hold provably same-project
  composite keys.
- **Who.** `visitorId` (FK `User`), plus `visitorRole` and `visitorName` frozen from the server-resolved actor at
  start. Nothing about the visitor comes from the request body (R1).
- **When.** `startedAt` is when the phone says the visit began. `startReceivedAt` is when the server committed it
  (R2, F5).
- **Device.** `originDeviceId`: an opaque random id the phone keeps for this sign-in (Q12).
- **Where it started.** `startNodeId` (nullable, composite FK `(projectId, startNodeId)` to `ProjectNode`, NoAction)
  and `startPlaceName` (frozen label, nullable), so the starting place survives the node's later removal (F12).
- **GPS.** `gpsLat`, `gpsLng`, `gpsAccuracyM` and `gpsAt`, all nullable. CHECKs: all four null, or all four set,
  with latitude and longitude in range and accuracy ≥ 0 (Q6).
- **Lifecycle.** `status`, one of `open | ended | closed` (CHECK). End fields:
  - `endedAt` and `endReceivedAt`;
  - `closedById`, `closedRole`, `closeKind` (`pmc` | `visitor_other_device`) and `closeReason`;
  - `lateEndAt` and `lateEndReceivedAt`, for an end sent by the starting phone after the visit was closed elsewhere.
- **Lifecycle CHECKs.**
  - `open`: no end or close fields.
  - `ended`: `endedAt` and `endReceivedAt` set, `endedAt >= startedAt`, no close fields.
  - `closed`: close fields set and `closeReason` non-blank under the full ASCII whitespace set
    `btrim(x, E' \t\n\x0B\f\r')`.
- **One open visit per visitor (S2, F8):** a partial unique index on `(projectId, visitorId) WHERE status = 'open'`.

**`SiteVisitAttendee`**
- Columns: `visitId`, `projectId` (composite FK to the visit), and exactly one of `userId` (a member) or
  `guestName` (typed, non-blank under the same whitespace CHECK, at most 120 characters).
- A frozen `displayName` and `role` for members, so the record reads the same after the member leaves.
- Unique `(visitId, userId)`.

**`SiteVisitPlace`** (the places walked)
- Columns: `visitId`, `projectId`, `nodeId` (nullable, composite FK, NoAction), a frozen `placeName`, `addedAt`
  (phone time) and `addedReceivedAt`.
- Unique `(visitId, nodeId)` where `nodeId` is not null. A place stays on the visit even with no observation (R2,
  F12).

**Events.** `sitevisit.started`, `sitevisit.place_added`, `sitevisit.ended` and `sitevisit.closed` join
`DOMAIN_EVENT_TYPES`, each with an `invalidate`-only external-effect entry (no push). Because the effect catalog is
sealed by generation, SV1-a also ships the catalog-generation seed migration and its test row, in the existing
style. There is no projection consumer in SV1, so no consumer rule changes.

**Repository bookkeeping in SV1-a** (each is an existing tripwire):
- the manifest's `ownsModels`;
- the seed wipe order;
- the `set-null-coverage` classification for the two node columns (see §5);
- the migration count in `pg-parse.test.mjs`.

## 3. Commands (unit SV1-b, server)

Every command goes through `executeCommand` with an `Idempotency-Key`, `resolveActor` for who and the token role
for the route ceiling. A replay with the same key returns the committed result; a different payload under the key
is a 409.

| Command | Who (route policy) | Under | Rule |
| --- | --- | --- | --- |
| `siteVisit.start` | pmc, consultant | insert; the partial unique index | Validates attendees as **active** members of this project (guests are names only). Validates `startNodeId` through `resolveProjectNode` (published nodes only). Time bounds §4. A phone-made id that already exists (any project) is a 409, never an overwrite. A second open visit for the same visitor fails the index and is a 409, under any interleaving. |
| `siteVisit.addPlace` | the visitor (pmc, consultant ceiling; the service narrows to `visitorId`) | `SELECT … FOR UPDATE` on the visit row, then read status | Only while `open`, and only from `originDeviceId`. Adding the same place twice is a no-op. |
| `siteVisit.end` | the visitor (same ceiling and narrowing) | row lock, then read status | `open` and from `originDeviceId`: becomes `ended`. If already `closed`: the first such end is **kept** as `lateEndAt` and nothing else changes (Q12, R4). If already `ended`: a no-op. |
| `siteVisit.close` | pmc for any visit; the visitor for their own, from another device | row lock, then read status | `open` only. A reason is required. Becomes `closed`, marked unsigned. |

Every command writes an `AuditLog` row and one event. Start and end/close also write one project `Notification`
row ("Site visit started by …", "Site visit ended …"). That is the project's history surface today; no
history screen exists to extend.

**Reading.** `GET /projects/:projectId/site-visits` (route policy `project.read`) lists the project's visits with
their attendees and places. GPS coordinates and the device id are returned only to the visitor and the PMC. An
`overlaps` flag is computed at read time, between visits of the same visitor, and only when both visits' two ends
are known (F34). A
`closed` or `ended` visit is never labelled signed or delivered (S1, F38).

## 4. Offline and time (R2, R3, F5, F14)

- The phone generates the visit id and the idempotency key, writes the op to the durable outbox first (the
  existing write-ahead path), and sends `startedAt`, `addedAt` and `endedAt` as the moment the person tapped.
- **Start bounds:** `startedAt <= startReceivedAt + 5 min`, `startedAt >= startReceivedAt - 7 days`, and
  `startedAt >= project.createdAt`. Outside these the start is refused (422) and the phone keeps the visit locally,
  marked "not recorded", with a retry that uses the current time. A refused start loses nothing: in SV1 a visit
  holds no observations.
- **End and add-place bounds:** `startedAt <= t <= receivedAt + 5 min`. The phone checks this before queueing, using
  the same clock. If the server still refuses, the op is **not** dropped as terminal: the card shows "End visit
  didn't go through" and re-sends with the current time. The PMC close is the backstop. An end is never silently
  lost and a visit is never stranded (R4).
- **Two phones (F14):** the open-visit index refuses a second open visit while one is open. A delayed start from
  another phone that arrives after the first visit ended is accepted as its **own** visit. Visits are never merged;
  a true overlap shows as the read-time `overlaps` flag.
- Later steps (confirming, closing, correcting) are not held to the visit's window (F16). In SV1 only `close` is
  such a step, and it takes server time.

## 5. Every way a visit ends (R4, F9, F35, F40)

| Situation | End state | Test |
| --- | --- | --- |
| The visitor taps End visit on the starting phone | `ended` (not signed: reports arrive in SV4) | end, then replay; end from another device is refused |
| The visitor's phone is lost or broken | the visitor closes it from another device, with a reason: `closed`, `visitor_other_device` | close from a second device; a later end from the first phone lands in `lateEndAt` and the visit stays `closed` |
| The visitor is removed or re-roled | the PMC closes it, with a reason: `closed`, `pmc`, unsigned | the removed visitor's calls are refused at the route; the PMC close succeeds |
| An end refused on time | stays `open`; the phone re-sends; the PMC can close | the end is not dropped from the outbox |
| A node on the visit is removed | the visit is unchanged; `startNodeId` / `nodeId` set to null by the site-visits participant inside the nodes removal transaction; the frozen names remain | remove a node a visit walked |

The node participant follows the daily-log precedent (`unfileMaterialsForDeletedNodes`): it runs under the
nodes tree lock, in the same transaction, before the node row is deleted. The columns are classified `exempt` in
`set-null-coverage` because no projection serialises them.

How a visit ended in SV1 enters SV4's signing flow is SV4's design (F38). SV1 only guarantees that such a visit is
never shown as signed.

## 6. Screens (unit SV1-c, web)

- Outbox ops: `startSiteVisit`, `addSiteVisitPlace`, `endSiteVisit` and `closeSiteVisit`. Each carries its key and
  its phone time. The device id is minted once per sign-in and stored with the outbox scope.
- GPS: one `navigator.geolocation.getCurrentPosition` with a short timeout at start. A refusal or timeout starts the
  visit without GPS (Q6).
- Places: the For You open-visit card and the Site Map's "Visit this area" and "Visits here".
- New strings in English, Hindi and Gujarati.
- No new navigation item (D1). Before SV1-c starts, it is checked against the navigation lane's files (the
  Dashboard work, and #633 Site Map); if they overlap, this lane pauses and says so.

## 7. Tenancy and roles (R1)

- Every table carries `projectId`, with composite foreign keys, so a visit, its attendees and its places are
  provably one project in PostgreSQL.
- Attendee members are checked as active members of that project inside the start transaction.
- Role ceilings live in `ROLE_POLICY`:
  - `siteVisit.start`: `pmc`, `consultant`;
  - `siteVisit.addPlace`, `siteVisit.end`, `siteVisit.close`: `pmc`, `consultant`;
  - the service narrows each to the visitor, or to the PMC for close.
- `architect` is added to these rows by the unit that opens the role (4d-iii), not here.
- Engineers, contractors and clients read visits; they do not start them (D5).

## 8. Units and what each must prove (R16, F23)

| Unit | Contents | Proof |
| --- | --- | --- |
| SV1-0 | This design, and its hard choices on #792 | Review |
| SV1-a | Migration: the three tables, the CHECKs, the partial index, the catalog generation; module ownership | upgrade proof; hostile inserts each beside an accepted coherent row (two open visits; a blank close reason; a cross-project attendee or place; half-set GPS) |
| SV1-b | The four commands, the read, the node participant, the role policy | barrier tests: two concurrent starts with different keys leave one open visit (F8); end racing close leaves exactly one end state; add-place racing end is either in the ended visit or refused (R6 ahead of SV2). Wrong-role tests for each command. Time-bound tests (F5). Every §5 row. |
| SV1-c | Web: outbox ops, device id, GPS, the cards | browser test: start offline, add a place, end, reconnect; one visit on the server with the phone's times |

SV1 counts as done only after real-role QA on the isolated QA project (R17).

## 9. Findings this design answers

F5, F8, F9, F12, F14, F34, F35 and F40 (SV1's rows on #792). Each stays open until its proof above passes in the
unit that builds it.
