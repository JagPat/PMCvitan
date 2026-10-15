# Site Visits SV1-c unit 1 — the screen (online)

**Work item:** #792, on the owner's per-role QA check of 14 Oct 2026 (#482, item 6: "Site Visits needs a screen:
start/end, place, attendees, photo").
**Builds on:** SV1-a (#815, the record), SV1-b (#843 start/end/close and the read; #850 places and attendees).

## What it is

One screen, "Site Visits", in every role's menu after its other screens (so under More on a phone). It lists the
project's visits, newest first, a page of 20 at a time: who visited and in which role, when it started and ended,
the starting place, whether a location was saved, the places walked and the people there (retired rows stay,
marked "removed"). The PMC and consultants start a visit (with an optional starting place; the phone's location is
saved when it offers one within five seconds and never blocks), add and remove places, team members and guests on
their own visit, and end it. The PMC closes someone else's visit left open, with a reason. Client, engineer and
contractor read only. Only active members can be named (an invitation not yet taken is refused by the server), and a team list that
could not be read offers a retry. A closed visit says when it was closed. Every word is in English, Hindi and
Gujarati.

## Hard choices

1. **Buttons follow the server, not a new rule.** Each control shows only where `ROLE_POLICY` grants the act
   (`siteVisit.start`/`end`/`edit` to pmc and consultant, `close` to pmc) and, for edits and End, only on the
   viewer's own visit in the role they started it in (the server's visitor rule). Close shows only on an open
   visit that is not the viewer's own, since the visitor ends their own. End also shows on the visitor's own
   visit a PMC closed, until its late end is recorded (SV1-b).
2. **No store slice.** The screen keeps its visits in its own hook (`useSiteVisits`) and sends through the store's
   gateway (`serverGateway()`, one new accessor). A reply is applied only while the project scope it was sent for
   is current, the same guard the store uses.
3. **One act, one key, one body.** An act keeps its idempotency key, the row id it minted and the exact body it
   first sent (its claimed time and location included) until it settles. A lost answer or a passing fault (no
   status, 401, 408, 429, 5xx: `isTerminalOutboxError` false) keeps all three, so pressing again is the same act
   and the server runs it once; a definite refusal settles it, so the next press is a new act. The key is bound to
   the project scope, and a start whose location wait outlives that scope is never sent. Row ids are version 4
   UUIDs even where the browser has no `randomUUID`. A read that shows the row an act minted settles that act too,
   so adding the same thing again after removing it is a new act.
4. **Open visits always known; live like the other screens.** Beside the first page the screen reads every open
   visit (`?status=open`, a read-only filter added to SV1-b's list for this, followed page by page to its end), so
   the viewer's own open visit decides Start however old it is, and open visits show first; Start shows only once
   that read has answered. The realtime ping that refreshes the snapshot (`useApiSync`) also re-reads every page
   the screen shows, and the team for the attendee picker. A read that an act or a later read has overtaken is
   dropped, so an older answer never puts back a state already replaced.
5. **Online only.** With no signal, nothing is saved and the screen says so. The offline queue (F53: queued acts
   survive a start conflict, a queued remove waits for its add) is unit 2: see
   [2026-10-15-site-visits-sv1c-offline.md](2026-10-15-site-visits-sv1c-offline.md), which replaces choice 3's
   in-memory act map with the outbox.
6. **Refusals in the viewer's language.** In English the server's own reason is shown after "This was not saved.";
   Hindi and Gujarati show the translated line only, because the server's reasons are English.
7. **Photo later.** "Add photo" (unit 3) reuses the site photos button once it is on main and files the photo as
   a normal site photo; tying a photo to the visit record is SV2.
8. **Entry points later.** "Start visit" from the PMC Brief and "Visit this area" on the Site Map (plan, SV1 row)
   wait for Lane 1's Site Map units.
