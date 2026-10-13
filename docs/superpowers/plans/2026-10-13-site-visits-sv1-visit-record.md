# Site Visits SV1, design 1 of 3: the visit record in the database

**Status:** technical design for review. No code ships with this document.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792). Product plan:
[2026-10-12-site-visits.md](2026-10-12-site-visits.md), approved as written by the Board on 13 Oct 2026. That
approval also placed Site Visits in the queue (Q8).

**Why three designs.** The second reviewed head of this PR met POLICY's stop: its P1s targeted text the first
correction had added. The owner chose, on 13 Oct 2026, to redesign SV1 as **three smaller designs reviewed one by
one, with building starting after all three pass**:
1. **this document:** the database (unit SV1-a);
2. the server: commands, time rules, the read, notices (unit SV1-b);
3. the screens: outbox ops, location, the open-visit card (unit SV1-c).

Each later design states only what it adds. This one fixes every rule PostgreSQL itself enforces, so designs 2 and
3 cannot weaken it. The findings that belong to designs 2 and 3 stay open on #792 until those designs answer them
(§9).

**Scope:** SV1 only. The Board scope for SV1 is "Start visit" and "Visit this area": who, when, GPS check-in,
attendees and the places walked. The visit shows in the project's history and works offline. Observations, actions,
reports and sharing are SV2 to SV5, each with its own design.

## 0. Decisions this design follows

| Item | Decision | Source |
| --- | --- | --- |
| D5 | A visit is started by the PMC or a consultant (and an architect once the role opens). | Owner, 12 Oct |
| Q3 | Architects visit as **consultant** members until 4d-iii opens the role. | Board, 13 Oct (accepted as proposed) |
| Q6 | Location is recorded when the device offers it and never blocks a start. | Board, 13 Oct (accepted as proposed) |
| Q12 | **No one-phone-per-visit rule.** The same login can start, add to, edit and end a visit from any device, during or after the visit. A device without GPS records an approximate location or "no location" and is never blocked. Offline or concurrent edits use normal sync and conflict resolution. | Board, 13 Oct (changed from the proposal) |
| S1 | A plain **End visit** exists in SV1. An ended visit is never shown as signed or delivered. | Board, 13 Oct (accepted as proposed) |
| S2 | At most **one open visit per visitor per project**. | Board, 13 Oct (accepted as proposed) |
| Shape | Three designs (database, server, screens), reviewed one by one before building. | Owner, 13 Oct |

## 1. What the database guarantees, in plain words

- A visit, its attendees and its places all belong to one project, and every person named on them stood on that
  project, in the stated role, when they were written.
- Only the visitor edits their visit, and a PMC is the only one who closes it. Nobody's name can be put on an edit
  they did not make.
- Nothing is overwritten or deleted. Editing adds a row or retires one, once. The original taps are kept beside
  the times the record accepted.
- The accepted times are always in order: start, then the places walked, then the end.
- A closed visit takes no more edits.
- Every change is paired, in the same transaction, with exactly one event, exactly one audit row and (for start,
  end and close) exactly one project notice. A change without its counterparts, or a counterpart without its
  change, does not commit.

## 2. Tables

One new module, `site-visits`, owns three tables. All are additive. No existing table gains a column.

### `SiteVisit`

- **Identity.** `id` is the primary key, a uuid generated **on the device**, so offline steps can name the visit
  before the server has it. A second unique key, `(projectId, id)`, is the target of every composite foreign key
  below and of later SV2 tables.
- **Project.** `projectId`, a foreign key to `Project`.
- **Who.** `visitorId` (FK `User`), with `visitorRole` and `visitorName` frozen.
  - CHECK: `visitorRole IN ('pmc','consultant','architect')`.
  - `visitorName` is non-blank under the full ASCII whitespace set `btrim(x, E' \t\n\x0B\f\r')`.
- **When.** Each device-reported time is stored twice: as **claimed** (exactly what the device sent, never
  rewritten) and as **accepted**.
  - Start: `startClaimedAt`, `startedAt`, `startTimeAdjusted` and `startReceivedAt` (the server's time).
  - CHECK: `startedAt <= startReceivedAt`. The database admits no accepted time in the future of its own receipt
    (F47).
  - CHECK: `startTimeAdjusted` implies `startedAt = startReceivedAt`. An adjusted time is always the receipt time,
    never a third value.
  - How the server chooses between claim and receipt is design 2's.
- **Where it started.** `startNodeId` is nullable, with a composite FK `(projectId, startNodeId)` to
  `ProjectNode (projectId, id)`, NO ACTION. `startPlaceName` is a frozen label.
  - CHECK: `startNodeId IS NULL OR startPlaceName IS NOT NULL`. The label survives the node's later removal.
- **Location.** `locationKind` is `device` or `none` (CHECK).
  - For `device`, all of `locLat`, `locLng`, `locAccuracyM` and `locAt` are set. Latitude is within ±90,
    longitude within ±180, and accuracy is ≥ 0.
  - For `none`, all four are null.
  - "Approximate" is a read-time label (accuracy worse than 100 m), not a stored kind. It is design 2's.
- **Lifecycle.** `status` is `open`, `ended` or `closed` (CHECK).
  - Ordinary end: `endClaimedAt`, `endedAt`, `endTimeAdjusted` and `endReceivedAt`.
  - Close: `closedAt` (server time), `closedById` (FK `User`) and `closeReason`.
  - Late end: `lateEndClaimedAt` and `lateEndReceivedAt`.
- **Lifecycle CHECKs:**
  - `open`: no end, close or late-end field is set.
  - `ended`: every ordinary end field is set, and `startedAt <= endedAt <= endReceivedAt`. `endTimeAdjusted`
    implies `endedAt = endReceivedAt`. No close or late-end field is set.
  - `closed`: every close field is set, with `closedAt >= startReceivedAt` and a non-blank `closeReason`. No ordinary
    end field is set. The late-end pair is both null or both set, with `lateEndReceivedAt >= closedAt`.
- **One open visit per visitor (S2):** a partial unique index on `(projectId, visitorId) WHERE status = 'open'`.

### `SiteVisitAttendee`

- `id` is the primary key, a uuid generated **on the device** (F52). Commands, events and retires name the
  attendee by this id, so a retire sent from two devices names the same row.
- `projectId` and `visitId`, with a composite FK `(projectId, visitId)` to `SiteVisit (projectId, id)`.
- Exactly one of:
  - `userId` (FK `User`), a member, with a frozen `displayName` and `role`;
  - `guestName`, non-blank, at most 120 characters.
- `addedById` (FK `User`) and `addedAt` (server time).
- The retire pair `retiredAt` / `retiredById`, both null or both set (CHECK).
- A partial unique index on `(visitId, userId) WHERE userId IS NOT NULL AND retiredAt IS NULL`. A member removed
  and added again gets a new row, so the record shows both edits.

### `SiteVisitPlace` (the places walked)

- `id` is the primary key, a device-generated uuid (F52).
- `projectId` and `visitId`, with a composite FK to the visit as above.
- `nodeId`, with a composite FK `(projectId, nodeId)` to `ProjectNode`, NO ACTION. `placeName` is frozen and
  NOT NULL.
- **`nodeId` is required on insert (F51).** The column is nullable only so that a node's removal can clear it
  (§4). The insert trigger refuses a null `nodeId`, so no place is ever recorded without the node it names.
- `addedById`, `addedClaimedAt`, `addedAt` (accepted), `addedTimeAdjusted` and `addedReceivedAt`.
  - CHECK: `addedAt <= addedReceivedAt`. `addedTimeAdjusted` implies `addedAt = addedReceivedAt`.
- `addedAfterEnd`, set by the trigger (§3), never by the caller.
  - CHECK: `addedAfterEnd` implies `addedAt = addedReceivedAt`. A correction after the visit is not part of the
    walk's timeline.
- The retire pair, as for attendees.
- A partial unique index on `(visitId, nodeId) WHERE nodeId IS NOT NULL AND retiredAt IS NULL`.

## 3. Triggers: who, order, and the closed-visit ban

All are row-level PL/pgSQL triggers owned by `site-visits`, in the repository's existing sealed-table style.

**Standing.** People are checked with `platform_user_holds_role_windowed(projectId, userId, role)`, the
repository's one spelling of "holds this role on this project". It also admits an org owner or admin acting as
PMC with no membership row. The check runs only when the row is written, so a later removal never blocks reading
the record; the frozen names keep it readable.

| Write | The trigger requires |
| --- | --- |
| Insert `SiteVisit` | The visitor holds `visitorRole` on the project. |
| `SiteVisit` to `closed` | `closedById` holds `pmc` on the project. |
| Insert an attendee or a place | `addedById = visit.visitorId` (F46). For a member attendee, the member holds `role` on the project. |
| Retire an attendee or a place | `retiredById = visit.visitorId` (F46). |

**Binding attribution to the visit (F46).** An attendee or place row names the visitor as the person who added or
retired it, read from the locked visit row. A row can therefore never carry the name of someone from another
project, or of anyone but the visitor. The PMC's only write is the close.

**The visit row is the lock for every child write (F49).** Each child trigger begins with
`SELECT … FROM "SiteVisit" WHERE ("projectId", id) = (NEW."projectId", NEW."visitId") FOR UPDATE` and then decides
from that locked row:
- the visit is `closed`: the insert or retire is refused;
- for a place insert: `addedAfterEnd` is set to `(status = 'ended')`, whatever the caller sent;
- for a place added while `open`: `addedAt >= visit.startedAt`.

The end transition locks the same row, so an end and an add serialise. Either the add commits first and the end
sees it, or the end commits first and the add is recorded as `addedAfterEnd`.

**Order of the walk (F47).**
- On `open → ended`, the visit's own trigger requires `endedAt >=` the latest `addedAt` of the places added while
  open, standing or retired. No place walked during the visit sits after its end.
- Every accepted time is at or before its own receipt time (the CHECKs in §2), and receipt times only grow.
  Therefore an adjusted time is never before the visit's start, and the accepted history is always in order.

**What may change.** Every table refuses `DELETE` and `TRUNCATE`.
- The only exception is the cascade from a project deletion: `phase6_t4d_project_is_deleting(OLD."projectId")` at
  `pg_trigger_depth() > 1`, as the existing sealed tables do.
- The seed and the test resets clear these tables through `sanctionedReset`, which disables the TRUNCATE seals by
  name.

`UPDATE` on `SiteVisit` may only:
- move `open → ended` or `open → closed`, filling exactly that arm's fields;
- fill the late-end pair once, on a `closed` row;
- set `startNodeId` to null (§4).

`UPDATE` on an attendee or a place may only fill the retire pair once, or, for a place, set `nodeId` to null (§4).

Every other column is immutable: who, every claimed and accepted time, the location, the frozen names and
`addedAfterEnd`.

## 4. Removing a node

A node's removal must not delete or block the record. The composite FKs are NO ACTION, so a removal that forgot
the visits fails instead of losing them. A site-visits participant clears `startNodeId` and `nodeId` inside the
nodes removal transaction, before the node row (and any subtree) is deleted. It follows the daily-log precedent
`unfileMaterialsForDeletedNodes`. The triggers admit exactly that one nulling transition; the frozen names remain.
The participant's code is design 2's. This design fixes only what the database admits.

The columns are NO ACTION, not SET NULL, so `set-null-coverage` does not count them.

## 5. Events, audit rows and notices, sealed to the change (F45)

**Event types.** Eight types join `DOMAIN_EVENT_TYPES`:
- `sitevisit.started`, `sitevisit.ended`, `sitevisit.closed`, `sitevisit.late_end_recorded`;
- `sitevisit.place_added`, `sitevisit.place_retired`;
- `sitevisit.attendee_added`, `sitevisit.attendee_retired`.

Every event is on the visit's stream: `entityType = 'SiteVisit'`, `entityId` = the visit id. A child event's payload
names the child row's `id`.

**Catalog.** Each type has one external-effect entry: `invalidate: true`, no push, `pairingRequired: true`. The
invalidation is what refreshes the visit on the visitor's other devices. No consumer contract moves: no projection
consumes `sitevisit.`, and `socket.invalidation` and `webpush.notify` keep their versions.

**Pairing, in both directions.**
- **Event without its change.** The kernel's existing seal refuses, at commit, a `pairingRequired` event that no
  fact claimed. It also requires a human actor with an actor id.
- **Change without its counterparts.** Each change (an insert, or one of the transitions in §3) has a claimant
  trigger in two halves on one function: an immediate AFTER trigger and a DEFERRED constraint trigger. This is
  U3's order-independent shape. At commit, the claimant requires, among rows written in this same transaction
  (`xmin = txid_current()`):
  - **exactly one event** of the change's type on the visit's stream, from a human actor whose `actorId` is the
    attributed person: the visitor, `addedById`, `retiredById` or `closedById`. For a child change, "exactly one"
    counts only the events whose payload `rowId` is this row's `id`. A start that names three attendees writes
    three `sitevisit.attendee_added` events on one visit stream in one transaction, each paired to its own row.
  - **exactly one `AuditLog` row** for the project, with `entityId` = the changed row's id, `action` = the event
    type, and `actorId` = the same person.
  - for `started`, `ended` and `closed`, **exactly one `Notification`** for the project whose `eventId` is that
    event.
  - It then claims the event with `platform_claim_event_pairing_once`.
- Counting uses the generic `platform_tx_event_count`, not the decisions-only helper.

**Notices render with no feed change (F50, database half).** A site-visit notice has no `kind` and no
`decisionId`. Kind-less notices are already served from their stored text to every reader, and
`Notification_t4d_binding_bound` already checks that its `eventId` was written in the same transaction. The wording
is design 2's.

**One generation, one reseal.** Adding entries changes the sealed catalog's coverage hash. SV1-a therefore ships a
catalog-generation migration in A7d's shape (Part 1 only), carrying all eight keys at once. The first release that
carries it needs the operator reseal in `docs/RUNBOOK.md` ("catalog changed"). SV2 to SV5 will each add their own
types, so each will need one reseal too. That is accepted, rather than reserving types now for designs that do not
exist yet.

## 6. Repository bookkeeping in SV1-a

The migration is **inseparable** from its catalog code. The envelope seal refuses every emit whose
`(coverageVersion, effectKey)` the database does not hold, so the new entries and the seeded generation must land
together.

Files:
- the migration;
- `schema.prisma`;
- the events list in `packages/shared`;
- `external-effects.ts`;
- the module manifest and the registry;
- the boundary analyzer's directory map;
- `seed.ts` and `sanctioned-reset.ts`;
- the catalog seed and generation tests;
- `upgrade-proof.sh`;
- `migrate.sh` (`ALWAYS_EXECUTE`, so a db-push baseline gets the catalog rows and triggers);
- `pg-parse.test.mjs`;
- the new integration suite;
- the RUNBOOK note.

That is about 16 files, within one standard unit. The plumbing map behind this list is recorded on #792.

## 7. What SV1-a must prove

Each hostile write sits beside an accepted, coherent one, so the test shows the rule and not a broken fixture:
- **Lifecycle:** two open visits for one visitor; a row both ended and closed; an end before the start or after
  its receipt; an adjusted time that is not the receipt time; a late end on an `open` or `ended` row; a second late
  end.
- **Data shape:** a blank close reason; a node without its label; a half-set location; a start accepted after its
  receipt.
- **Who:** a visitor, closer or attendee with no standing on the project; an org owner of an unrelated organisation
  as closer; an attendee or place added or retired by anyone but the visitor (F46).
- **Places:** a cross-project place; a place inserted with no node (F51); a place's `addedAfterEnd` sent wrong by
  the caller and corrected by the trigger.
- **Closed visits:** an insert or retire on a closed visit (F49).
- **Walk order:** an end earlier than a place walked while open (F47).
- **Locking:** an add racing an end, which lands either before the end or as `addedAfterEnd` (two-connection
  barrier test).
- **Immutability:** an update to each frozen column; a second retire; a delete; a truncate; a project deletion that
  cascades cleanly.
- **Pairing (F45):** for each of the eight changes, the change with no event, two events, an event of the wrong
  type, an event naming another actor or another child, no audit row, or (for start, end and close) no notice. Also
  a `sitevisit.*` event with no change.
- **Catalog:** the upgrade proof, the generation tests, and an outbox start in `outbox` mode refused until the
  reseal.

## 8. Tenancy and roles in the database

Every table carries `projectId`, with composite foreign keys to the visit and the node, and every person is checked
by the standing triggers (§3). A visit, its visitor, its closer, its attendees and its places are therefore provably
one project. `architect` is admitted by the role CHECK, and so is unreachable only through standing: no one holds
the role until 4d-iii opens it (Q3). Route ceilings and `ROLE_POLICY` are design 2's.

## 9. Findings

| Finding | Where it is answered |
| --- | --- |
| F45 pairing with event, audit and notice | §5, proofs in §7 |
| F46 attribution bound to the visit | §3 |
| F47 times never before the start | §2 CHECKs and §3 walk order; the server's choice of claim or receipt in design 2 |
| F49 no edits on a closed visit, in PostgreSQL | §3 |
| F51 node required on insert | §2, §3 |
| F52 stable child ids | §2 |
| F50 site-visit notices render | database half in §5; wording and the feed check in design 2 |
| F48 late end after the visitor's removal | design 2 (command authority); the database admits the late-end pair (§2) |
| F53 queued ops survive a start conflict | design 3 (web outbox) |

The first round's findings stay answered where they were. The earlier SV1 rows on #792 (F5, F8, F9, F12, F14,
F34, F35, F40) are carried by the same three designs. Each finding stays open until its proof passes in the unit
that builds it.
