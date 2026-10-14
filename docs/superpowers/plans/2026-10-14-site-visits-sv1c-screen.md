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
contractor read only. Every word is in English, Hindi and Gujarati.

## Hard choices

1. **Buttons follow the server, not a new rule.** Each control shows only where `ROLE_POLICY` grants the act
   (`siteVisit.start`/`end`/`edit` to pmc and consultant, `close` to pmc) and, for edits and End, only on the
   viewer's own visit in the role they started it in (the server's visitor rule). Close shows only on an open
   visit that is not the viewer's own, since the visitor ends their own. End also shows on the visitor's own
   visit a PMC closed, until its late end is recorded (SV1-b).
2. **No store slice.** The screen keeps its visits in its own hook (`useSiteVisits`) and sends through the store's
   gateway (`serverGateway()`, one new accessor). A reply is applied only while the project scope it was sent for
   is current, the same guard the store uses.
3. **One act, one key.** An act keeps its idempotency key and the row id it minted until it settles. A lost
   response (no status) keeps both, so pressing again is the same act and the server runs it once; a refusal
   settles it, so the next press is a new act. The key is bound to the project scope.
4. **Online only.** With no signal, nothing is saved and the screen says so. The offline queue (F53: queued acts
   survive a start conflict, a queued remove waits for its add) is unit 2.
5. **Refusals in the viewer's language.** In English the server's own reason is shown after "This was not saved.";
   Hindi and Gujarati show the translated line only, because the server's reasons are English.
6. **Photo later.** "Add photo" (unit 3) reuses the site photos button once it is on main and files the photo as
   a normal site photo; tying a photo to the visit record is SV2.
7. **Entry points later.** "Start visit" from the PMC Brief and "Visit this area" on the Site Map (plan, SV1 row)
   wait for Lane 1's Site Map units.
