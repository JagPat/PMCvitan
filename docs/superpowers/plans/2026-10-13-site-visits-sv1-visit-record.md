# Site Visits SV1: the visit record (technical design)

**Status:** technical design for review. No code ships with this document.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792). Product plan:
[2026-10-12-site-visits.md](2026-10-12-site-visits.md), approved as written by the Board on 13 Oct 2026. That
approval also placed Site Visits in the queue (Q8).
**Scope:** SV1 only. The Board scope for SV1 is "Start visit" and "Visit this area": who, when, GPS check-in,
attendees and the places walked; the visit shows in the project's history and works offline. Observations, actions,
reports and sharing are SV2 to SV5, each with its own design.

## 0. Decisions this design follows

| Item | Decision | Source |
| --- | --- | --- |
| D5 | A visit is started by the PMC or a consultant (and an architect once the role opens). | Owner, 12 Oct |
| Q3 | Architects visit as **consultant** members until 4d-iii opens the role. The `architect` ceiling is present but unreachable until then (§7). | Board, 13 Oct (accepted as proposed) |
| Q6 | Location is recorded when the device offers it and never blocks a start. | Board, 13 Oct (accepted as proposed) |
| Q12 | **No one-phone-per-visit rule.** The same login can start, add to, edit and end a visit from any device (phone, laptop, iPad), during or after the visit. The device only registers the visit and its location when available. A laptop or iPad without GPS records an approximate location or "no location" and is never blocked. Offline or concurrent edits use normal sync and conflict resolution. | Board, 13 Oct (changed from the proposal) |
| S1 | A plain **End visit** exists in SV1. An ended visit is never shown as signed or delivered. | Board, 13 Oct (accepted as proposed) |
| S2 | At most **one open visit per visitor per project**. | Board, 13 Oct (accepted as proposed) |

Recorded on [#792](https://github.com/JagPat/PMCvitan/issues/792). Nothing here widens a role's rights outside the
new site-visit actions.

## 1. What people get

- **PMC:** "Start visit" on the PMC Brief (For You). **Consultant:** "Start visit" on For You.
- **Both:** "Visit this area" on a place in the Site Map, which starts a visit with that place as its starting
  place.
- While a visit is open, the visitor sees one card on For You, on **every device they are signed in on**. The card
  shows the time the visit started, the attendees, the places walked so far, **Add place**, **Add attendee** and
  **End visit**.
- After the visit, the visitor can still correct it from any device: add or remove a place or an attendee.
- Everyone on the project sees the visit in the project feed (the bell) when it starts and when it ends, and on
  each place in the Site Map ("Visits here").
- The PMC can **close** anyone's open visit, with a reason (for a visitor who has left the project).

## 2. Data (unit SV1-a, migration only)

One new module, `site-visits`, owns three tables. All are additive. No existing table gains a column.

**`SiteVisit`**
- **Identity.** `id` is the **primary key**, a uuid generated **on the device** so that offline steps can name the
  visit before the server has it. It is therefore globally unique in PostgreSQL. A second unique key,
  `(projectId, id)`, lets later tables (SV2 observations, Media) hold provably same-project composite keys.
- **Who.**
  - `visitorId` (FK `User`).
  - A `BEFORE INSERT` trigger requires a current `ProjectUserStanding` row for `(projectId, visitorId, visitorRole)`.
    That table is the repository's record of who stands on a project in which role, and it covers an org owner or
    admin acting as PMC without a membership row. PostgreSQL therefore refuses a visit attributed to someone with no
    standing on this project. The check runs only at insert, so a later removal is never blocked; the frozen fields
    keep the record.
  - `visitorRole` and `visitorName` are frozen from the actor envelope, resolved **inside** the command transaction
    (§3). Nothing about the visitor comes from the request body (R1).
- **When (R2, F5).** Each device-reported time is stored twice:
  - **as claimed**, exactly as the device sent it and never rewritten (evidence): `startClaimedAt`;
  - **as accepted**: `startedAt` is the claim when it is within bounds (§4), otherwise the server's receipt time,
    with `startTimeAdjusted = true`.

  `startReceivedAt` is the server's commit time.
- **Where it started.** `startNodeId` is nullable, with a composite FK `(projectId, startNodeId)` to `ProjectNode`
  (NoAction). `startPlaceName` is a frozen label. A CHECK, `startNodeId IS NULL OR startPlaceName IS NOT NULL`,
  means a node is never stored without its label, and the label survives the node's later removal (F12).
- **Location (Q6, Q12).**
  - `locationKind` is one of `device | none` (CHECK).
  - For `device`, all of `locLat`, `locLng`, `locAccuracyM` and `locAt` are set, latitude and longitude are in
    range, and accuracy is ≥ 0. For `none`, all four are null.
  - Whatever the browser's location service returns is kept with its accuracy. A phone's GPS fix is typically a few
    metres; a laptop's or iPad's Wi-Fi or IP estimate can be hundreds of metres.
  - The read labels a fix **approximate** when its accuracy is worse than 100 m. A denied, unavailable or timed-out
    request records `none` and never blocks the start.
- **Lifecycle.** `status` is one of `open | ended | closed` (CHECK). The end fields are:
  - ordinary end: `endClaimedAt`, `endedAt` (accepted), `endTimeAdjusted` and `endReceivedAt`;
  - close: `closedAt` (server time), `closedById`, `closedRole` and `closeReason`;
  - late end: `lateEndClaimedAt` and `lateEndReceivedAt`. These record the first end that arrives, from any device,
    after the PMC has closed the visit.
- **Lifecycle CHECKs.**
  - `open`: no end, close or late-end field is set.
  - `ended`: every ordinary end field is set, and `endedAt >= startedAt`. No close or late-end field is set.
  - `closed`:
    - every close field is set, and `closedAt >= startReceivedAt`;
    - `closeReason` is non-blank under the full ASCII whitespace set `btrim(x, E' \t\n\x0B\f\r')`;
    - **no ordinary end field is set**;
    - the late-end pair is both null or both set.
- **One open visit per visitor (S2, F8):** a partial unique index on `(projectId, visitorId) WHERE status = 'open'`.
- **The closer.** The same standing trigger checks `(projectId, closedById, closedRole)` when a row moves to
  `closed`.

**`SiteVisitAttendee`**
- `visitId` and `projectId`, with a composite FK to the visit.
- Exactly one of:
  - `userId`, a member, checked by the same insert-time standing trigger for `(projectId, userId, role)`;
  - `guestName`, typed, non-blank under the same whitespace CHECK, at most 120 characters.
- A frozen `displayName` and `role` for members, so the record reads the same after the member leaves.
- `addedById`, `addedAt` (server time), and the retire pair `retiredAt` / `retiredById`. Both are null while the
  attendee stands; both are set when the visitor removes them.
- Unique `(visitId, userId) WHERE retiredAt IS NULL`. A member who was removed and then added again gets a new row,
  so the history shows both edits.

**`SiteVisitPlace`** (the places walked)
- `visitId` and `projectId`.
- `nodeId` is nullable, with a composite FK (NoAction). `placeName` is frozen and NOT NULL.
- `addedClaimedAt`, `addedAt` (accepted) and `addedReceivedAt`.
- `addedAfterEnd` is true when the visitor adds the place as a correction after the visit ended (§4).
- The retire pair `retiredAt` / `retiredById`, as for attendees.
- Unique `(visitId, nodeId) WHERE nodeId IS NOT NULL AND retiredAt IS NULL`. A place stays on the visit even with no
  observation (R2, F12).

**Edits are additions, never rewrites.** "Editing" a visit means adding a row, or retiring one by setting its
retire pair once. Nothing is overwritten, so every edit from every device stays visible, with who made it and when.

**Frozen evidence is enforced in PostgreSQL**, with row-level triggers in the repository's existing append-only
style:
- `SiteVisit` refuses `DELETE`. Its `UPDATE` may only:
  - move `open → ended` or `open → closed`, filling exactly that arm's fields;
  - fill the late-end pair once, on a `closed` row;
  - set `startNodeId` to null (the node-removal transition).

  Every other column is immutable, including who, the claimed and accepted start times, the location and
  `startPlaceName`.
- `SiteVisitAttendee` and `SiteVisitPlace` refuse `DELETE`. Their `UPDATE` may only:
  - fill the retire pair once;
  - for a place, set `nodeId` to null.
- The seed and the test resets clear these tables through the sanctioned reset (`prisma/sanctioned-reset.ts`), as
  every sealed table does.

**Events.** These event types join `DOMAIN_EVENT_TYPES`:
- `sitevisit.started`;
- `sitevisit.place_added`;
- `sitevisit.place_retired`;
- `sitevisit.attendee_added`;
- `sitevisit.attendee_retired`;
- `sitevisit.ended`;
- `sitevisit.closed`;
- `sitevisit.late_end_recorded`.

Each has an `invalidate`-only external-effect entry, with no push. The `invalidate` effect is what refreshes the
visit on the visitor's other devices. The effect catalog is sealed by generation, so SV1-a also ships the
catalog-generation seed migration and its test row, in the existing style. SV1 has no projection consumer, so no
consumer rule changes.

**Repository bookkeeping in SV1-a** (each is an existing tripwire):
- the manifest's `ownsModels`;
- the seed wipe order and the sanctioned reset;
- the `set-null-coverage` classification for the two node columns (see §5);
- the migration count in `pg-parse.test.mjs`.

## 3. Commands (unit SV1-b, server)

**The envelope every command shares:**
- Each command runs through `executeCommand` with an `Idempotency-Key`. A replay under the same key returns the
  committed result; a different payload under the same key is a 409.
- Who the actor is comes from `requireActorEnvelope`, **inside** that transaction. This is the repository's
  transaction-bound identity: it locks the actor's standing and display name, so the frozen `visitorName` and the
  event's actor come from the same locked read. A role that has changed since sign-in is refused
  (`STALE_ROLE_MESSAGE`).
- The token role is checked against the route ceiling.
- **The device is never part of authority.** Any device signed in as the visitor is the visitor (Q12).

| Command | Who | Order inside the transaction | Rule |
| --- | --- | --- | --- |
| `siteVisit.start` | Ceiling: pmc, consultant, architect (§7). | 1. The actor envelope. 2. Each attendee member's standing row `FOR SHARE`, in sorted user-id order, through the orgs-owned standing query (the `lockStandingForWrite` ordering). 3. Read each attendee as active. 4. Insert. | `startNodeId` must pass `resolveProjectNode`, which admits published nodes only. The time rule is in §4. An id that already exists is a 409, never an overwrite (it is the primary key). A second open visit for the same visitor fails the partial index, so it is a 409 under any interleaving, and the response names the open visit (§4). |
| `siteVisit.addPlace` | The visitor. The ceiling is as for start; the service narrows to `visitorId`. | Visit row `FOR UPDATE`, then read status | Allowed while `open` or `ended`. `nodeId` is required and must pass `resolveProjectNode` (published nodes only), so a draft place is never recorded or exposed. A place already standing on the visit changes nothing. |
| `siteVisit.retirePlace` | The visitor. | Visit row `FOR UPDATE`, then read the place | Allowed while `open` or `ended`. A place that is already retired changes nothing. |
| `siteVisit.addAttendee` | The visitor. | 1. Visit row `FOR UPDATE`. 2. The attendee's standing row `FOR SHARE`. 3. Read it as active. | Allowed while `open` or `ended`. A member who is already standing on the visit changes nothing. Guests are names only. |
| `siteVisit.retireAttendee` | The visitor. | Visit row `FOR UPDATE`, then read the attendee | Allowed while `open` or `ended`. An attendee who is already retired changes nothing. |
| `siteVisit.end` | The visitor, from any device. | Visit row `FOR UPDATE`, then read status and the latest accepted time of the places added while open | `open` becomes `ended`. If the visit is already `ended`, nothing changes: the first end wins (§4). If it is already `closed`, the first end fills the late-end pair and nothing else changes (R4). |
| `siteVisit.close` | pmc, for any visit. | Visit row `FOR UPDATE`, then read status | `open` only. A reason is required. The visit becomes `closed` at server time, marked unsigned. |

A `closed` visit takes no edits. The PMC closed it because the visitor can no longer act on it.

**Writes happen only on a real change.** An `AuditLog` row, the event and any `Notification` are written only when
the command changes a row. A command that changes nothing returns the current visit and writes only its command
receipt; examples are a repeated place, a second end, or retiring a row that is already retired. No history ever
shows a transition that did not happen.

Start, end and close each write one project `Notification` ("Site visit started by …", "Site visit ended …"). The
project feed is the project's history surface today; there is no history screen to extend. Edits and a late end
write their event but no notification.

**Errors are never about time.** A command gets a 4xx answer only for one of these:
- authorization: the wrong person or role;
- a missing or draft place;
- a cross-project id;
- an id clash;
- the open-visit index;
- an edit to a closed visit.

Time never refuses a command (§4). The web outbox drops every 4xx except 401, 408 and 429 as terminal
(`isTerminalOutboxError`), so it can never drop an end because of its time.

**Reading.** `GET /projects/:projectId/site-visits` (route policy `project.read`) lists the project's visits.
- Each visit comes with its standing attendees and places, and with its retired rows (marked, with who retired them
  and when).
- Every claimed time and every accepted time is shown, and adjusted times are marked.
- The location, labelled approximate or "no location" as in §2, is returned only to the visitor and the PMC.
- An `overlaps` flag is computed at read time, between visits of the same visitor. It uses each visit's accepted
  start and its end point: `endedAt` for an ended visit, `closedAt` for a closed one. It is computed only when both
  visits have an end point (F34).
- A `closed` or `ended` visit is never labelled signed or delivered (S1, F38).

## 4. Offline, several devices, and time (R2, R3, F5, F14)

**The device's role.** A device generates the visit id and the idempotency keys, and captures the location when it
can. It writes each op to the durable outbox first, through the existing write-ahead path. It sends the moment the
person tapped as the claimed time. Every device signed in as the visitor reads the same open visit from the server,
so a visit started on a phone can be added to on a laptop, and ended from either.

**Conflict resolution (Q12): every edit is an operation, and operations merge.** Each command applies under the
visit's row lock, so edits from several devices are serialised in the order they reach the server. They are built to
commute:
- adds are keyed: the same place or member is added once;
- retires are set-once;
- the first end wins, and a later end from another device changes nothing;
- an end after a PMC close becomes the late end.

So two devices editing at once, or one coming back online after the other, converge on the same visit with nothing
lost. Every edit stays in the record (§2). After each committed op, the `invalidate` effect refreshes the visit on
the visitor's other devices.

**Two starts (S2, F14).**
- If a device starts a visit while the visitor already has one open (for example, offline on a laptop while the phone
  visit is open), the start is refused with a 409 that names the open visit.
- The device then shows: "You already have a visit in progress, started at 10:02. Add what you recorded here to it?"
  If the visitor confirms, the device re-sends its queued places and attendees against that visit, under fresh keys.
  If the visitor declines, the device keeps its own visit locally, marked "not recorded", to retry once the other
  visit ends.
- Visits are never merged silently.
- A delayed start that arrives after the other visit ended is accepted as its **own** visit. A true overlap shows as
  the read-time `overlaps` flag.

**Time: the claim is never refused and never rewritten.** The server keeps the claim as evidence and derives the
accepted time:
- **start:** the claim, when `max(received − 7 days, project.createdAt) <= claim <= received + 5 min`; otherwise
  the receipt time, flagged as adjusted;
- **add-place while open:** the claim, when `startedAt <= claim <= received + 5 min`; otherwise the receipt time,
  flagged;
- **end:** the claim, when `max(startedAt, latest accepted time of the places added while open) <= claim <=
  received + 5 min`; otherwise the receipt time, flagged. This is read under the visit's row lock, so no place
  walked during the visit can sit after the end;
- **add-place after the visit ended:** marked `addedAfterEnd`. Its accepted time is the receipt time, and it is not
  part of the walk's timeline, so it never moves the end;
- **retires, attendee edits and close:** server time. These are later steps that are not held to the visit's window
  (F16).

**Why the accepted order holds.** A device that was offline for more than 7 days has its start adjusted to the
receipt time. Its queued places and end are received later still, so each is either inside its bounds or adjusted
to a later receipt time. The accepted history is always in order, and the original taps are always kept.

## 5. Every way a visit ends (R4, F9, F35, F40)

| Situation | End state | Test |
| --- | --- | --- |
| The visitor taps End visit, on any device | `ended` (not signed; reports arrive in SV4) | end, then a replay; an end from a second device after the first changes nothing |
| The visitor's phone is lost or broken | the visitor ends the visit from any other signed-in device: `ended` | start on device A, end on device B |
| The visitor is removed or re-roled | the PMC closes the visit, with a reason: `closed`, unsigned | the removed visitor's calls are refused (route or envelope); the PMC close succeeds |
| A device ends the visit after the PMC closed it | stays `closed`; the end fills the late-end pair | PMC close, then an offline end lands |
| The device's clock is wrong | the end is accepted at receipt time, flagged; the claim is kept | an end claiming a time before the start, or before the last place, is accepted and flagged |
| A node on the visit is removed | the visit's status is unchanged; the site-visits participant sets `startNodeId` / `nodeId` to null inside the nodes removal transaction; the frozen names remain | remove a node a visit walked |

The node participant follows the daily-log precedent (`unfileMaterialsForDeletedNodes`): it runs under the nodes
tree lock, in the same transaction, before the node row is deleted. The trigger admits exactly this nulling. The
columns are classified `exempt` in `set-null-coverage` because no projection serialises them.

How a visit ended in SV1 enters SV4's signing flow, and when edits stop once a report is signed (R7), are SV4's
design (F38). SV1 only guarantees that such a visit is never shown as signed.

## 6. Screens (unit SV1-c, web)

- **Outbox ops:** `startSiteVisit`, `addSiteVisitPlace`, `retireSiteVisitPlace`, `addSiteVisitAttendee`,
  `retireSiteVisitAttendee`, `endSiteVisit` and `closeSiteVisit`. Each carries its key, and the walk ops carry their
  claimed time.
- **Location:** one `navigator.geolocation.getCurrentPosition` at start, with a short timeout. It works the same on a
  phone, laptop or iPad: a GPS fix, an approximate fix or "no location". It never blocks the start (Q6, Q12).
- **Where it shows:** the For You open-visit card on every signed-in device, the visit's detail (where it is edited
  after the visit), and the Site Map's "Visit this area" and "Visits here".
- **A 409 on start** shows the "add to the visit in progress?" prompt (§4).
- **New strings** in English, Hindi and Gujarati.
- **No new navigation item (D1).** Before SV1-c starts, it is checked against the navigation lane's files (the
  Dashboard work and #633 Site Map). If they overlap, this lane pauses and says so.

## 7. Tenancy and roles (R1)

- **Provable tenancy.** Every table carries `projectId`, with composite foreign keys to the visit and the place, and
  every person is checked by the insert-time standing trigger (§2). A visit, its visitor, its closer, its attendees
  and its places are therefore provably one project in PostgreSQL.
- **Attendees.** An attendee member is read as active only after their standing row is locked (§3). A removal that
  commits first is seen; one that commits later waits.
- **Role ceilings** live in `ROLE_POLICY`:
  - every visitor command admits `pmc`, `consultant` and `architect`, and the service narrows it to the visitor;
  - close admits `pmc`.
- **Architect (Q3).** `architect` is in the visitor ceilings from SV1, so the two lanes may land in either order.
  - While 4d-i's reservation doors stand, no token carries the role, so the row is unreachable, and architects visit
    as consultant members.
  - The moment 4d-iii opens the role, architects can start visits with no further unit.
  - This follows the existing `consultation.request` precedent. `route-policy.test.ts`'s architect action list is
    updated in SV1-b.
- **Who reads.** Engineers, contractors and clients read visits; they do not start or edit them (D5).

## 8. Units and what each must prove (R16, F23)

| Unit | Contents | Proof |
| --- | --- | --- |
| SV1-0 | This design, and its hard choices on #792 | Review |
| SV1-a | Migration: the three tables, the CHECKs, the partial indexes, the standing triggers, the immutability triggers, the catalog generation; module ownership and the sanctioned reset | Upgrade proof. Hostile inserts and updates, each beside an accepted coherent row: two open visits; a blank close reason; a row both ended and closed; a node without its label; a half-set location; a visitor, closer or attendee with no standing on the project; a cross-project place; an update to a frozen column; a second retire; a delete. |
| SV1-b | The seven commands, the read, the node participant, the role policy | Barrier tests: two concurrent starts with different keys leave one open visit (F8); end racing close leaves exactly one end state; ends from two devices racing leave one end; add-place racing end lands either before the end or as `addedAfterEnd`, never inside the walk after the end (R6 ahead of SV2); an attendee removal racing start or add-attendee either precedes and refuses, or follows. Wrong-role tests for each command, and a test that a different user on the same device is refused. Claimed and accepted time tests, including an end claimed before the last place (F5). No-op commands write no event or notification. A draft node is refused. Every §5 row. |
| SV1-c | Web: outbox ops, location, the cards and the 409 prompt | Browser tests: (1) start offline, add a place, end, reconnect, and the server holds one visit with the claimed times; (2) start on one device, add a place on a second, end on the first; (3) an offline start while another visit is open, then "add to the visit in progress"; (4) a location refusal starts with "no location"; (5) the PMC closes a visit while the device is offline, and the device's end lands as a late end. |

SV1 counts as done only after real-role QA on the isolated QA project (R17).

## 9. Findings this design answers

F5, F8, F9, F12, F14, F34, F35 and F40 (SV1's rows on #792). F40 (a lost phone) is answered by Q12's ruling: any
signed-in device ends the visit. Each finding stays open until its proof above passes in the unit that builds it.
