# Site Visits — plan (SV1–SV5)

**Status:** plan for review. **No code yet.** Building begins only after the owner and Board review this plan and
place Site Visits in the queue.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792).
**Authority:** Board briefs of 7 Oct 2026 on #482
([17:47](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037732251),
[17:53](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037831581),
[17:56](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037874252),
[18:03](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037997278) IST), and the owner's decision of
12 Oct 2026 on who may start a visit.

---

## 1. In one page (for everyone)

**What it is.** A site visit is a dated walk-through of the site by a consultant-side visitor: the PMC, an
architect or another consultant. During the walk they take photos, say what they saw, and turn anything that needs
fixing into a task with an owner and a due date. When they finish, the app writes a short, signed visit report
and sends it to everyone involved, in their own language.

**Why.** The Board's test for every feature: *it helps each person do their own job better, makes clear who did
what, and keeps everyone in the loop.* Today a visit lives in WhatsApp photos and memory. Problems get lost, nobody
knows who promised what, and the client hears about it late. After this work:

- the PMC or architect can prove what they saw, when, and where;
- the contractor and engineer get a clear list of what to fix, with photos, an owner and a deadline;
- the client gets a plain summary in their Pulse;
- nothing closes until someone shows a photo of it fixed.

**What it is not.** It is not a new app or a new menu. It lives inside screens people already use: the PMC Brief,
the Site Map, For You and the client Pulse. A problem found on a visit becomes one of the app's existing records
(an inspection item, a decision or a change request), so it follows the approval and re-inspection steps people
already know.

**Who can start a visit.** An **architect**, a **consultant** or the **PMC**. That is the owner's decision of
12 Oct 2026: the PMC is a kind of consultant too. Everyone else in the project takes part (as an attendee, an
owner of a fix, or a reader of the report) but does not start visits.

**The five steps,** each a separate, separately tested release:

| Step | What people get |
| --- | --- |
| **SV1 Visit record** | "Start visit" → who, when, GPS check-in, who else attended, which areas were walked. Shows in the project's history. Works with no signal. |
| **SV2 Observations** | During the visit: photo + place + note, marked **Fine**, **Concern** or **Action needed**. Each carries the visitor's name and role. Works offline. |
| **SV3 Actions** | "Action needed" becomes a real task (inspection item, decision or change request) with an owner and due date. It closes only with a "fixed" photo. Overdue items show on the PMC Brief. |
| **SV4 Visit report** | "End visit" → a signed one-page report (attendees, observations with photos, open actions), in English, Hindi or Gujarati, delivered to each person's For You and summarised in the client's Pulse. |
| **SV5 Sharing** | A **Share** button on any photo or report: the phone's share menu, or a read-only link that expires (7 days by default). Project members only; every share is logged. The worker job card's Photo button opens the real camera. |

---

## 2. Decisions so far, and questions still open

**Decided**

| # | Decision | By / when |
| --- | --- | --- |
| D1 | It is built into existing screens; no new navigation item. | Board, 7 Oct 17:53 IST |
| D2 | Observations use the existing photo store, place tags (Zone > Room > Object) and the "who did it" stamp. | Board, 7 Oct 17:53 IST |
| D3 | An action becomes an existing record type; it closes only with a fix photo. | Board, 7 Oct 17:53/17:56 IST |
| D4 | Steps SV1–SV5 as listed, one PR per unit, plan first. | Board, 7 Oct 17:56 IST |
| D5 | **Who starts a visit: architect, consultant or PMC.** | **Owner, 12 Oct 2026** |

D5 replaces the brief's idea of a "Start visit" button on the engineer's Today screen and the client's Pulse. The
engineer and client still see visits; they just don't start them. See Q1 and Q2.

**Open (the owner or Board decides before the step that needs it)**

| # | Question | Proposal | Needed by |
| --- | --- | --- | --- |
| Q1 | May the **client** comment on a visit, or only read the summary? | Read the summary in Pulse and reply with a comment on the report; no edits. | SV4 |
| Q2 | May an **engineer or contractor** add a photo to a visit they attend? | No for SV1–SV3: only the visitor records. Owners answer through their own tasks (the fix photo). Revisit after use. | SV2 |
| Q3 | The **architect role** cannot yet be given on a project; it is reserved until the paused 4d-iii work. Until then, architects visit as a **consultant** member. Acceptable? | Yes. Architects use the consultant role until 4d-iii opens the architect role; nothing about visits changes when it does. | SV1 |
| Q4 | Consultants **cannot upload photos today** (only the PMC and engineer can). Visits need it. Allow consultants and architects to add photos **only inside a visit they started**? | Yes, scoped to their own visit, not general photo upload. | SV2 |
| Q5 | Which record does an action become? | The visitor picks, with a sensible default: a **workmanship/quality** issue → inspection item (re-inspection flow); a **design or material choice** → decision; a **change to what was agreed** → change request. Only the PMC can create inspections today, so a consultant's quality action goes to the PMC to confirm (one tap). | SV3 |
| Q6 | Is **GPS check-in** required? | Record it when available. If GPS is off or weak, the visit still starts and says "location not captured". Never blocks. | SV1 |
| Q7 | **Share links**: how long, and can they be cancelled? | 7 days by default (Board), cancellable by the sharer or the PMC; every open is logged. Links never show other photos or the rest of the project. | SV5 |
| Q8 | **Where in the queue?** Your records disagree: Board 7 Oct 17:56 (SV1–SV3 early); owner 7 Oct 18:16 (after isolated QA); STATUS (after 4d-iii R1–R4). | Owner's 18:16 order, with one change: build SV1–SV3 **after isolated QA exists**, so each step can be checked by real roles on the QA project before it reaches real sites. | before SV1 |

---

## 3. How it will feel (screen by screen)

**PMC, architect or consultant (the visitor)**

1. **Start.** On the PMC Brief (and the consultant's home), a **Start site visit** button. On the Site Map, any area
   shows **Visit this area**, which starts a visit already pointed at that place.
2. **Check in.** The app records the time, the visitor and (if allowed) GPS. Pick attendees from the project's
   members ("who's with you?"); people outside the app can be typed as names.
3. **Walk.** A simple running list: **Add observation** → take or pick a photo → choose the place (Zone > Room >
   Object, the same picker as everywhere else) → a short note → **Fine / Concern / Action needed**. The places
   walked fill in automatically from the observations.
4. **Act.** For "Action needed", three more fields appear: what kind (quality / design / change), **owner**,
   **due date**. Saving creates the real task in the right place.
5. **End.** **End visit** shows the report preview. The visitor reads it, signs it (name, role, time; the same stamp
   used elsewhere), and sends it.

Everything works with no signal: it saves on the phone and sends when the signal returns, like the Daily Log does
today. A visit left open shows **Visit in progress** on the visitor's home, with **Resume**.

**Engineer and contractor**

- Their **For You** shows "New from site visit: 2 actions for you", each opening the task with its photo, owner,
  due date and the visit it came from.
- They close a task by doing the fix and adding a **fixed photo**. The PMC or visitor confirms through the
  existing review step.

**Client**

- **Pulse** shows "Site visit by [name], [date]: 12 things checked, 9 fine, 2 concerns, 1 action", with the report
  one tap away in their language. Raw problem photos follow the same rules as today: the client sees what the
  project already shows them.

**Everyone**

- **Site Map**: each area shows its visit history (date, visitor, what was seen), next to the photo history already
  there.
- **Share** (SV5): on any photo or report, the phone's own share menu (WhatsApp, email…) or **Copy link**.

**Kept out on purpose:** no new menu, no new inbox, no separate "visits app". Home screens get one button and one
card each, so they don't get crowded.

---

## 4. What already exists, and what is new

**Reused as is**
- Photo capture with a stamp (who, when, where) on the Daily Log and checklists; photos keep their GPS, time and
  place (`Media`: `geoLat`, `geoLng`, `takenAt`, `nodeId`).
- Places: Zone > Room > Object (`ProjectNode`), and the Site Map with photo history.
- Inspections with re-inspection; decisions and change requests with their approvals.
- For You, notifications that open the exact record, and read/unread (Top 10 #3 and #4, just delivered).
- Offline save-and-send (the Daily Log's write-ahead), and the language preference (English / Hindi / Gujarati).

**New**
- A **visit** record (who, when, GPS, attendees, places walked, status: in progress / ended / signed).
- An **observation** inside a visit (photo, place, note, Fine / Concern / Action needed, author and role).
- The **link** from an observation to the task it created, so the report knows what is still open.
- The **report**: a signed snapshot of the visit, in the reader's language.
- **Share links** and a **share log**.
- One **permission** for starting visits (architect, consultant, PMC) and one scoped photo permission (Q4).

---

## 5. Safety, privacy and accountability

- **Project walls stay up.** A visit, its photos and its report belong to one project. Only that project's members
  see them, each by their role's existing rules. This is tested as the notification work was, including someone
  from another project and a worker device.
- **Who did what.** Every visit, observation, action and signature carries the person and role from their login,
  never from what the screen sends, and the time from the server.
- **Signed means frozen.** Once signed, a report cannot be edited; a correction is a new, linked note.
- **Share links are narrow.** A link shows only what was shared, read-only, expires, can be cancelled, and every
  open is logged. It never reveals the rest of the project or works for a removed member.
- **GPS is optional** and shown only inside the project.
- **No bypass of existing approvals.** A visit creates normal records, which then follow their normal permission and
  approval steps.

---

## 6. The units (technical detail)

Each unit is one PR from `main` with its own tests, independent exact-head review, merge, deployment evidence, and
**live role testing on the isolated QA project** before it counts as done.

**SV0 — this plan** (docs only).

**SV1 — Visit record.**
- **Server:** a `SiteVisit` model (project, started by, role, `startedAt` / `endedAt`, optional GPS, status) and
  `SiteVisitAttendee` (member or typed name). Start and end commands use the existing idempotent command ledger, so
  a retried "Start visit" never makes two visits. Policy `visit.start`: `pmc`, `consultant`, `architect`.
- **Web:** Start / Resume / End on the PMC Brief and consultant home, "Visit this area" on the Site Map, and the
  project history entry.
- **Offline:** start and end are queued like the Daily Log.
- **Proofs:**
  - only the three roles can start; tenant walls hold;
  - a retried start makes one visit;
  - the visit works offline;
  - a visit left open survives reload.

**SV2 — Observations.**
- **Server:** `VisitObservation` (visit, place, note, rating, author, role, photo link). Photos reuse `Media` with a
  new `kind: 'visit'`; the visitor's upload right is scoped to their own open visit (Q4). Places walked are derived
  from the observations.
- **Proofs:**
  - an observation needs an open visit by its author;
  - photo upload is refused outside one's own visit;
  - offline capture is sent once.

**SV3 — Actions.**
- An "Action needed" observation creates an inspection item (through the PMC, Q5), a decision or a change request,
  with an owner and due date, linked back to the observation.
- Closing requires a fix photo through the record's existing flow.
- Overdue actions show on the PMC Brief.
- **Proofs:**
  - one action creates exactly one record, even on retry;
  - it cannot close without a fix photo;
  - the overdue list matches the open records the PMC can open.

**SV4 — Visit report** (after the language work, Top 10 #5, per the Board's order).
- `End visit` → `VisitReport` (frozen snapshot, signature: who, role, time).
- Delivered as a notice to each attendee and owner (For You deep link) and as a client Pulse summary. Rendered in
  English, Hindi or Gujarati.
- **Proofs:**
  - signed is immutable;
  - each recipient gets one notice;
  - the summary counts match the report.

**SV5 — Sharing.**
- `navigator.share` where the phone supports it; otherwise copy link.
- `ShareLink` (what, who, expiry, cancelled) and `ShareOpen` (each open), read-only and limited to what was shared.
- The worker job card's Photo button goes to real capture (`TeamAccessScreen.tsx`).
- **Proofs:**
  - members only;
  - expiry and cancellation;
  - a removed member's link stops working;
  - every share and open is logged.

**Size:** each unit is a "standard" review size. SV1 and SV2 may each split into server and web PRs if they grow.

---

## 7. Risks and how we handle them

| Risk | Handling |
| --- | --- |
| Crowded home screens | One button and one card per role; nothing else added. |
| No signal on site | Save on the phone, send later; a clear "waiting to send" marker. |
| Weak or blocked GPS | Optional; never blocks a visit. |
| Same photo stored twice | Reuse the existing photo store; a visit photo is a normal photo, linked. |
| Actions nobody owns | An action cannot be saved without an owner and a due date. |
| Shared links leaking | Narrow, expiring, cancellable, logged; members only. |
| Language | The report uses the same translation path as the rest of the app; SV4 waits for the Hindi/Gujarati work. |
| Architect role not yet available | Architects visit as consultants until 4d-iii (Q3). |

---

## 8. How we'll know it works

- **Automated:** every unit's tests (permissions, tenant walls, retries, offline, counts), independent review, and
  CI.
- **Live role QA** on the isolated QA project, per unit:
  - the PMC, an architect and a consultant run a visit;
  - an engineer and a contractor receive and close actions;
  - a client reads the summary;
  - someone from another project sees nothing.

  Results are recorded in the PR before it is called done.
- **Real use:** one real project's first visits, reviewed with the PMC afterwards before rolling out widely.
