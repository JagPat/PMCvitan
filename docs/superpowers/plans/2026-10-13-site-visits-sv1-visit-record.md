# Site Visits SV1-a: the visit record in the database

**Status:** built, with its proofs. This note records the design of the code in this PR; the migration and the test
are the detail.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792). Product plan:
[2026-10-12-site-visits.md](2026-10-12-site-visits.md), approved as written by the Board on 13 Oct 2026.

**Why a build, not another paper design.** The database design for SV1 reached POLICY's stop twice on this PR. On
13 Oct 2026 the owner chose to **build it with tests**: this step ships the real database change, this short note,
and a test for each review finding. The server (SV1-b) and the screens (SV1-c) keep their own designs, reviewed
before they are built.

**Scope:** the three tables, their rules, and the event types. No command, route or screen writes a visit yet, so
this release changes no behaviour. The first release with site visits needs the operator's catalog reseal once at
deploy (`docs/RUNBOOK.md`, "catalog changed"); all eight SV1 event types are in this one generation, so it is needed
once.

## Decisions this follows

| Item | Decision | Source |
| --- | --- | --- |
| D5, Q3 | A visit is started by the PMC or a consultant; architects visit as consultant members until their role opens. | Owner 12 Oct; Board 13 Oct |
| Q6, Q12 | Location is recorded when the device offers it (`device`) or not at all (`none`), and never blocks. Any device of the same login can start, add to and end a visit, during or after it. "Approximate" is a read-time label (accuracy worse than 100 m), SV1-b's. | Board, 13 Oct |
| S1 | A plain End visit exists; a PMC can close a visit left open. | Board, 13 Oct |
| S2 | At most one open visit per visitor per project (a partial unique index). | Board, 13 Oct |

## What PostgreSQL guarantees

Each line is proved in `apps/api/test/integration/site-visits-sv1a.test.ts` beside an accepted row.

| Rule | How | Findings |
| --- | --- | --- |
| **V1 Tenancy.** Every row carries `projectId`; children reach their visit, and rows their node, by composite keys. Deleting a project removes its visits and their children. | Composite FKs, `ON DELETE CASCADE` | F60 |
| **V2 Who.** The visitor (at the start and at each later act: end, late end, child add or retire), a member attendee and the closer (pmc) hold that role on the project when written, judged after locking the registers in the actor envelope's order (authority, standing, the project row, then the identity row FOR UPDATE, as an archive and the envelope seal take them). Names are copied from the locked identity; a place label comes from the nodes module's own function, which locks the node so a rename and a visit serialize. Only the visitor adds or retires a child row. A visitor removed after a close records no late end: the close stands. | `site_visits_standing_name`, `nodes_published_name_locked`, insert and lifecycle triggers | F46, F48, F55, F57, F61 |
| **V3 Time.** The caller sends only claimed times. The database stamps each receipt and accepts the claim only inside its window (start: the last 7 days and not before the project; place: after the start; end and late end: after the start and after every place walked while open), else the receipt. `adjusted` is exactly "accepted differs from claimed". Every claimed and device time is finite (no `infinity`). | `site_visits_accept`, CHECKs | F47, F54 |
| **V4 Lifecycle.** open → ended or closed, once; a late end only on a closed visit, once. A closed visit takes no child edit. A place added after the end is marked `addedAfterEnd` and accepted at its receipt. Every child write locks the visit row first, so it and the end or close serialize. A place always names a published node of its project. | `SiteVisit_update`, `site_visits_lock_visit` | F49, F51 |
| **V5 Immutable.** No direct delete or truncate; frozen columns stay frozen; a child is retired once. A node reference is cleared only by the node's own `ON DELETE SET NULL (col)` action, never by a direct update, and the frozen label stays. A `db push` baseline's NO ACTION node keys are replaced by that action on replay. A device fix's accuracy is finite. | no-delete/no-truncate triggers, depth check, FK audit, CHECKs | F58 |
| **V6 Paired.** Each change commits with exactly one same-transaction `sitevisit.*` event from the human it is attributed to, carrying their actor envelope in the role the row attributes (the visit role, or `pmc` for a close), on the visit's stream, naming the child row for child changes. Start, end and close also need exactly one notice whose `kind` is that event's type. The event is then claimed, so the kernel's `pairingRequired` seal refuses a site-visit event with no change. | claimant triggers (immediate + deferred), `platform_claim_event_pairing_once` | F45, F59 |

**Correction to the previous design (F59).** It said a site-visit notice could carry an `eventId` without a `kind`.
It cannot: `Notification_event_binding_pair_check` requires both or neither, and a kinded notice must match its
event's type. The notices are therefore kinded `sitevisit.started`, `sitevisit.ended` and `sitevisit.closed`.

**Audit (F56).** The site-visit rows are themselves the audit register (append-only, attributed, timed), as
`DecisionEvent` is for decisions. The generic `AuditLog` row a command writes stays a convention and is not paired.

**Node removal and projections.** Site visits are read live and serialized into no projection, so the two SET NULL
columns are classified `exempt` in `set-null-coverage.test.ts`.

## Repository bookkeeping

- Event types in `packages/shared` and `external-effects.ts` (`invalidate: true`, no push, `pairingRequired`); the new
  coverage generation is seeded by `20280111000000_site_visits_sv1a_catalog` (A7d's Part 1 shape).
- Both migrations are on `migrate.sh`'s `ALWAYS_EXECUTE`. On a database restored without its migration ledger that
  carries SV1-a's generation, `migrate.sh` resolves A7d (and U1, A7a, whose replays only A7d repairs) as applied,
  because A7d's catalog audit refuses any generation newer than itself. `upgrade-proof.sh` mirrors this.
- The `site-visits` module manifest (`dependsOn: ['nodes']`, for the node-label function), the truncate seals in
  `sanctioned-reset.ts`, and the seed reset list.

## SV1-b, unit 1: start, end and close through the server

Built with tests (`apps/api/test/integration/site-visits-sv1b.test.ts`), the path the owner chose for SV1-a.

- **Routes.** `GET /projects/:projectId/site-visits` (every member, newest first); `POST …/site-visits` (start: the
  PMC or a consultant, with a device-minted `id`, a claimed time, an optional published place and an optional device
  location); `POST …/:visitId/end` (the visitor only; on a visit a PMC already closed it records the late end once);
  `POST …/:visitId/close` (the PMC, with a reason). Each takes an optional `Idempotency-Key`.
- **Refusals before the database's.** A second open visit (S2), a reused id, a draft or another project's place, an
  end by anyone but the visitor or in another role than the visit's, and a second end or close are clear 4xx
  answers; SV1-a's triggers stay the backstop.
- **Read.** Accepted times, whether each was adjusted, the frozen visitor and place names, and the location with
  "approximate" when its accuracy is worse than 100 m (Q6).
- **Notices (F50).** "Site visit started: <visitor> — <place>", "Site visit ended: <visitor>" and "Site visit closed
  by the PMC: <visitor>", rendered from their events, served to every member, and translated in the bell.
- **Lock order (#834).** Every act takes the project's readiness lock first, as membership changes and archives
  do; then the visit row; a start naming a place then takes the project's tree lock and the node, as every node
  writer does; then the standing registers, the project row and the identity. Both deadlocks Codex named on #815
  (a start against the same PMC's node removal; a visit act against the same PMC's membership change) are
  reproduced by barrier tests that fail without these locks.

## Left for later units

| Finding | Where |
| --- | --- |
| Adding and retiring places and attendees through the server | SV1-b, unit 2 |
| F53 queued offline actions survive a start conflict | SV1-c |
