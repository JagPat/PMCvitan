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

**How to read this plan.** Sections 1–3 are for everyone. Sections 4–8 are the technical design. Every promise in
sections 1–3 is tied, in §6 and the contract check in §7, to either an existing rule in the app or a named new rule
with its own proof. A promise with neither is not made.

---

## 1. In one page (for everyone)

**What it is.** A site visit is a dated walk-through of the site by a consultant-side visitor: the PMC, an
architect or another consultant. During the walk they take photos and say what they saw. Anything that needs
fixing becomes a task with an owner and a due date. When they finish, the app writes a short report, the visitor
signs exactly what they reviewed, and the report goes to the project's members in their own language.

**Why.** The Board's test for every feature: *it helps each person do their own job better, makes clear who did
what, and keeps everyone in the loop.* Today a visit lives in WhatsApp photos and memory: problems get lost,
nobody knows who promised what, and the client hears about it late. After this work:

- the visitor can prove what they saw, when, and where;
- engineers get a clear list of what to fix, with photos, an owner and a deadline;
- the client gets a plain summary in their Pulse;
- nothing closes until someone shows a photo of it fixed.

**What it is not.** It is not a new app or a new menu. It lives inside screens people already use: the PMC Brief,
the Site Map, For You and the client Pulse. A problem found on a visit becomes one of the app's existing records
(an inspection, a decision or a change request), so it follows the approval steps people already know.

**Who can start a visit.** An **architect**, a **consultant** or the **PMC**. That is the owner's decision of
12 Oct 2026: the PMC is a kind of consultant too. Everyone else takes part, as an attendee, a fix owner or a
reader, but does not start visits.

**The five steps,** each released and tested on its own:

| Step | What people get |
| --- | --- |
| **SV1 Visit record** | "Start visit" → who, when, GPS check-in, who else attended, where it started. Shows in the project's history. Works with no signal. |
| **SV2 Observations** | During the visit: photo + place + note, marked **Fine**, **Concern** or **Action needed**. Each carries the visitor's name and role. Works offline. |
| **SV3 Actions** | "Action needed" becomes a real task with an owner and due date, created by the PMC through the app's existing rules. It closes only with a "fixed" photo. Overdue items show on the PMC Brief. |
| **SV4 Visit report** | "End visit" → a one-page report the visitor reviews and signs, in English, Hindi or Gujarati, delivered to members' For You and summarised in the client's Pulse. |
| **SV5 Sharing** | A **Share** button on a visit photo or report that creates a tracked, expiring, members-only link (7 days by default), whether it is sent by the phone's share menu or copied. Every share and open is logged. The worker job card's Photo button opens the real camera. |

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
engineer and client still see visits; they don't start them.

**Open (the owner or Board decides before the step that needs it)**

| # | Question | Proposal | Needed by |
| --- | --- | --- | --- |
| Q1 | May the **client** comment on a visit report, or only read the summary? | Read only in SV4; comments are a later unit. | SV4 |
| Q2 | May an **engineer or contractor** add a photo to a visit they attend? | No: only the visitor records observations. Owners answer through their own tasks. | SV2 |
| Q3 | The **architect role** cannot yet be given on a project (reserved until the paused 4d-iii work). Architects visit as a **consultant** member until then. Acceptable? | Yes; nothing about visits changes when 4d-iii opens the role. | SV1 |
| Q4 | Consultants **cannot upload photos today** (only the PMC and engineers can). Allow a visitor to add photos **only to their own visit** (observations, and fix photos for their own visit's actions)? | Yes, bound to that visit (§6 SV2), not general photo upload. | SV2 |
| Q5 | Who turns an "Action needed" into a real record? | **The PMC, always.** A non-PMC visitor's action waits as **Awaiting PMC**; the PMC chooses the record type and fills the inputs the existing command needs. The PMC's own actions create the record directly. See §6 SV3. | SV3 |
| Q6 | Is **GPS check-in** required? | Recorded when available; never blocks a visit ("location not captured"). | SV1 |
| Q7 | **Share links**: how long, and can they be cancelled? | 7 days by default (Board), cancellable by the sharer or the PMC; members only; every open logged. | SV5 |
| Q8 | **Where in the queue?** Your records disagree: Board 7 Oct 17:56 (SV1–SV3 early); owner 7 Oct 18:16 (after isolated QA); STATUS (after 4d-iii R1–R4). | Owner's 18:16 order, building SV1 onward **after isolated QA exists**, so each step is checked by real roles on the QA project before real sites. | before SV1 |
| Q9 | Should contractors be able to add the "fixed" photo themselves? | Not in SV1–SV5: it needs new upload and submit rights for contractors. The engineer records the fix. | SV3 |
| Q10 | Should guests (attendees typed as names, not app members) receive the report? | No automatic delivery; members only (Q7). | SV4 |
| Q11 | Should a **contractor firm** be told about actions that concern it? | Not targeted in SV1–SV5: the app has no link from a firm to its people today. An action may show the firm's name as a label; contractor members see actions only through their normal project view. | SV3 |
| Q12 | A visitor uses **one phone per visit**. Acceptable? | Yes. A visit is tied to the phone that started it; other devices can view it but not add to it or end it (§6 SV1). | SV1 |

---

## 3. How it will feel (screen by screen)

**The visitor (PMC, architect or consultant)**

1. **Start.** On the PMC Brief (and the consultant's home), a **Start site visit** button. On the Site Map, any area
   shows **Visit this area**, which starts a visit at that place; the starting area is saved on the visit. One
   visit at a time: if one is open, Start offers **Resume**.
2. **Check in.** The app records the time, the visitor and (if allowed) GPS. Pick attendees from the project's
   members; people outside the app can be typed as names (they are listed, nothing is sent to them).
3. **Walk.** **Add observation** → photo → place (the usual Zone > Room > Object picker) → short note →
   **Fine / Concern / Action needed**. Places walked fill in from the starting area and the observations.
4. **Act.** For "Action needed": kind (quality / design / change), a suggested owner and a due date. The PMC's own
   actions become real records straight away; anyone else's go to the PMC as **Awaiting PMC**.
5. **End and sign.** **End visit** shows the report preview. The visitor signs *that* preview. If anything changed
   since the preview, the app shows the new one to sign instead.

Everything works with no signal, on the phone that started the visit: it saves on the phone and sends when the
signal returns, in order. The report shows when things actually happened ("recorded offline, sent 14:05"). If the
visitor loses access to the project while a visit is open, the PMC can **close it on their behalf** with a reason;
it is marked "closed by PMC, not signed by the visitor".

**The PMC (as well as visiting)**

- **Awaiting PMC** items appear on the PMC Brief. **Confirm** opens the normal form for that record type
  (inspection, decision or change request) pre-filled from the observation; **Decline** asks for a reason.

**Engineer**

- For You shows "New from site visit", each opening the task with its photo, due date and the visit it came from.
- For a **quality** task the engineer opens the inspection, does the fix, adds the **fixed photo** to the checklist
  and submits; the PMC reviews it as today.

**Contractor**

- Sees visit actions only through their normal project view; the responsible firm may be shown as a name (Q11).
  The engineer records fixes (Q9).

**Client**

- **Pulse** shows "Site visit by [name], [date]: 12 things checked, 9 fine, 2 concerns, 1 action", with the report
  one tap away in their language (§6 SV4 read rules).

**Everyone**

- **Site Map**: each area shows its visit history, next to the photo history already there.

**Kept out on purpose:** no new menu, inbox or "visits app". Home screens get one button and one card each.

---

## 4. What already exists, and what is new

**Reused as is**
- Photo capture with a stamp; photos keep GPS, time and place (`Media`: `geoLat`, `geoLng`, `takenAt`, `nodeId`).
- Places (`ProjectNode`) and the Site Map with photo history.
- Inspections (`inspection.create` / `decide` are PMC-only; `inspection.submit` is engineer and PMC; corrective
  work is engineer-only, `CORRECTIVE_ROLES`).
- Decisions (`decision.create` is PMC-only) and change requests (`decision.change` excludes the architect; a change
  request targets an approved decision and carries cost and time impacts).
- For You, notifications that open the exact record, and read/unread.
- Offline save-and-send (the Daily Log's write-ahead) and the language preference.

**New** (each named with its unit in §6)
- `SiteVisit` (visitor, role, device, starting place, GPS, status, times) and `SiteVisitAttendee`.
- `VisitObservation`, and a visit binding on visit photos.
- `VisitAction` with its own states, linked to the record the PMC creates.
- `VisitReport` (signed snapshot bound to the previewed content) and `VisitReportCorrection`.
- `ShareLink` and `ShareOpen`.
- Read rules for visits and reports, and the permissions listed in §7.

---

## 5. Safety, privacy and accountability

- **Project walls stay up.** A visit, its photos and its report belong to one project. Who can read them is set by
  the visit read rules in §6 SV4, used by every route, including share links. Tested with another project's member
  and a worker device.
- **Who did what, and when.** Each record carries the person and role from their login, never from what the screen
  sends. Visit-time steps (start, observation, end) store when they **happened** (the phone's clock) and when the
  server **received** them, within the bounds in §6 SV1. Later steps (confirming an action, closing it, correcting
  a report) are stamped by the server when they happen.
- **Signed means exactly what was reviewed.** The signature is bound to the previewed report's content. A signed
  report is never edited; a mistake is fixed by an attributed, append-only correction from the visitor or the PMC.
- **Evidence can't vanish.** Photos in a visit are protected from deletion once the visit has ended, and deleting
  is serialised with ending, so a report never points at a removed photo.
- **Sharing never widens access.** Every share, from the phone's share menu or a copied link, is a tracked link that
  requires a signed-in current member and re-checks the visit read rules on every open.
- **GPS is optional** and shown only inside the project.
- **No bypass of existing approvals.** Records created from actions go through their existing commands and
  permissions.

---

## 6. The units (technical design)

Each unit is split, per the repo policy, into a **migration-only PR** (new tables and columns, additive, unused)
followed by **server** and **web** PRs. Each PR has its own tests, independent exact-head review, merge, deployment
evidence, and **live role testing on the isolated QA project** before the unit counts as done.

**SV0 — this plan** (docs only).

### SV1 — Visit record

- **SV1a migration:** `SiteVisit` (project, visitor, role, `deviceId`, `startNodeId`, GPS, status
  `open | ended | signed | closed_by_pmc`, `startedOccurredAt`/`startedReceivedAt`,
  `endedOccurredAt`/`endedReceivedAt`, `overlapsVisitId`) and `SiteVisitAttendee` (member reference, or a guest
  name). A partial unique index allows **one open visit per (project, visitor)**.
- **SV1b server:**
  - `visit.start` (policy: `pmc`, `consultant`, `architect`) with the start-command guard. A second start while
    one is open answers with the open visit. Idempotent through the command ledger.
  - **Device lease:** the visit records the device that started it. Observations and End are accepted only from
    that device (Q12).
  - **A second phone:** a start from another device while the visitor has an open visit is refused. Nothing is
    lost: that phone keeps its queued steps and offers to send them as a new visit once the open one has ended.
  - **Delayed offline start:** a start that arrives after the same visitor's overlapping visit has already ended
    (or is sent as above) is **kept**, not refused, because its observations are real evidence. It is marked
    `overlapsVisitId`, so the visitor and PMC see "overlaps your visit from another phone". Visits are never
    merged silently.
  - **Visit-time bounds** (start, observation, end only): `occurredAt` may not be in the future (beyond a small
    clock-skew allowance) and must lie within the visit window. A gap above a set limit (proposed 24 h) between
    occurrence and receipt is flagged, not refused. Times display in the project's time zone.
  - `visit.closeOnBehalf`: PMC only, reason required, audited. Sets `closed_by_pmc`, never a signature.
- **SV1c web:** Start, Resume and End on the PMC Brief and consultant home; Visit this area; history entry;
  offline queue in order.
- **Proofs:**
  - only the three roles can start; tenant walls;
  - a retried start makes one visit; two concurrent starts make one;
  - start → end → a delayed offline start from another device makes a second, flagged visit, losing no
    observation;
  - a second phone's start while one is open is refused, and its queued steps survive to be sent later;
  - another device cannot add to or end the visit;
  - impossible visit-time times are refused;
  - the starting area shows with no observations;
  - only the PMC can close on behalf, and the visit shows unsigned.

### SV2 — Observations

- **SV2a migration:** `VisitObservation` (visit, place, note, rating, author, role, `occurredAt`/`receivedAt`), plus
  `Media.siteVisitId` and `Media.visitActionId` (same-project composite foreign keys, nullable) and `kind: 'visit'`.
- **SV2b server:**
  - **Upload binding:** a visitor's photo upload (Q4) must name either their own open visit (an observation photo,
    stored with `siteVisitId`) or an action raised on their own visit (a fix photo in SV3, stored with
    `visitActionId`). The media row stores the uploader.
  - An observation may reference only media bound to **the same visit and uploaded by the same visitor**.
  - **One lock order:** adding an observation, ending the visit, and deleting a visit-bound photo all lock the same
    `SiteVisit` row before reading its status, and hold it through their writes.
  - **Delete guard:** a visit participant joins the existing `MediaService` delete guard and refuses deletion of a
    visit-bound photo once the visit has ended, before the row or the stored object is removed.
- **SV2c web:** the observation flow; offline capture.
- **Proofs:**
  - an observation needs the visitor's own open visit, from its device;
  - media from another visit, another uploader or another project is refused;
  - barrier tests for observation vs end and delete vs end, both orderings;
  - a photo of an ended visit cannot be deleted, and the file stays.

### SV3 — Actions

- **SV3a migration:** `VisitAction` (observation, kind, suggested owner, due date, responsible-firm label, state
  `awaiting_pmc | open | fix_submitted | closed | declined`, linked record id and type).
- **SV3b server:**
  - **Raising:** an "Action needed" observation creates a `VisitAction`.
    - Raised by the PMC: the record is created at once.
    - Raised by anyone else: `awaiting_pmc`, and the PMC is notified.
  - **Confirming:** `visitAction.confirm` (PMC only, idempotent; a second answer is refused) creates the linked
    record **through the existing command, with that command's own inputs**:
    - **quality:** an inspection via `inspection.create`. Today a new inspection has no assignee, so SV3b adds an
      optional assignee to inspection creation, checked by the same `CORRECTIVE_ROLES` eligibility used for
      re-inspections, with its own proofs;
    - **design:** a decision via `decision.create` (PMC only, as today);
    - **change:** a change request via the existing `decision.change` command, which needs the target approved
      decision and the cost and time impacts. The PMC supplies them in the confirm form.
  - **Declining:** `visitAction.decline`, PMC only, reason required.
  - **Closing:** `visitAction.close` needs a fixed photo, whatever the type:
    - **inspection:** closes when the linked inspection is approved **and** carries at least one evidence photo.
      A passing inspection needs no photo today, so an approval without one leaves the action open, asking for it;
    - **decision or change request:** after the linked record is resolved, a fix photo bound to the `VisitAction`
      (`Media.visitActionId`) is added by the PMC, an engineer, or the visitor who raised it (Q4). Approving the
      linked record alone never closes the action.
  - **Times:** action transitions are server-stamped and bounded by the action's own lifecycle (after it was
    raised), not by the visit window.
- **SV3c web:** Awaiting PMC on the PMC Brief; the pre-filled confirm forms; action cards in For You; overdue
  actions on the PMC Brief.
- **Proofs:**
  - a non-PMC visitor can never create an inspection, decision or change request through a visit;
  - a double confirm creates one record;
  - for each of the three types the action cannot close without a fixed photo, including an approved inspection
    with none;
  - the assignee check refuses a non-engineer;
  - the overdue list matches the records the PMC can open.

### SV4 — Visit report (after the language work, Top 10 #5, per the Board's order)

- **SV4a migration:** `VisitReport` (visit, content hash, version, signer, role, signed-at) and
  `VisitReportCorrection` (report, author, role, reason, text, time).
- **SV4b server:**
  - **Preview:** returns the report content and its hash.
  - **Sign:** `visit.sign` carries that hash. Under the `SiteVisit` lock the server recomputes the hash from the
    current visit (observations and action states). On a mismatch it refuses with "preview out of date" and the
    phone shows the new preview.
  - **Corrections:** `visitReport.correct` is **the visitor who signed, or the PMC**; anyone else is refused.
    Append-only; server-stamped.
  - **Read rules** (one definition, `visit.read`, used by the report route, the snapshot and share links): the
    project-member roles that can read the project today (`project.read`: PMC, client, engineer, contractor,
    consultant, architect) may read a project's visits, reports and visit photos. The client's view is read-only
    (Q1). Worker devices and other projects are refused.

    Visit photos follow the same rule. Existing inspection photos keep their existing exposure; this plan does not
    change or rely on it.
  - **Signing state:** an ended visit waits as "awaiting signature" on the visitor's home. Delivery happens on
    signing; a visit never signed can be closed by the PMC (SV1b).
  - **Delivery:** a notice to each member attendee and action owner (For You), and a client Pulse summary; guests
    get nothing (Q10). Corrections are delivered to the same people.
- **SV4c web:** preview and sign; report view in the reader's language; correction flow.
- **Proofs:**
  - signing a stale preview is refused;
  - a signed report never changes;
  - only the signer or the PMC can correct;
  - each project role can read; a worker device and another project's member are refused;
  - each member recipient gets one notice; guests none;
  - the summary counts match the report.

### SV5 — Sharing

- **SV5a migration:** `ShareLink` (target visit photo or report, sharer, expiry, cancelled) and `ShareOpen`.
- **SV5b server:** every share creates a `ShareLink`. Opening it requires a signed-in current project member and
  re-checks the SV4 read rules on every open. It is read-only, expires, can be cancelled by the sharer or the PMC,
  and every open is logged.
- **SV5c web:**
  - **Share** uses `navigator.share` with **the share-link URL only**, never the photo bytes or an ordinary signed
    media URL; **Copy link** uses the same link.
  - The worker job card's Photo button goes to real capture (`TeamAccessScreen.tsx`).
- **Proofs:**
  - both share paths create the same audited link;
  - members only;
  - a worker device and another project's member are refused;
  - expiry, cancellation and a removed member are refused;
  - every share and open is logged.

---

## 7. Contract check: each promise against today's rules

| Promise | Existing rule | New rule (unit) |
| --- | --- | --- |
| Architect, consultant or PMC starts a visit | none | `visit.start` (SV1b) |
| Visitor adds photos | `media.upload` is PMC and engineer only | visit-bound upload for the visitor (SV2b) |
| A quality action becomes an inspection | `inspection.create` is PMC only, no assignee | PMC confirm (SV3b); optional engineer assignee on create (SV3b) |
| A design action becomes a decision | `decision.create` is PMC only | PMC confirm (SV3b) |
| A change action becomes a change request | `decision.change`: no architect, needs an approved decision and impacts | PMC confirm with those inputs (SV3b) |
| The engineer records a quality fix | `inspection.submit` (engineer, PMC); failed items need photos | none; the fix-photo check on close (SV3b) |
| Contractor records a fix | not possible today | not in scope (Q9) |
| Contractor firm is notified | no firm-to-member link | not in scope (Q11) |
| Photos can't be deleted after a visit | `MediaService` delete guard | visit participant (SV2b) |
| Report readers | none for visits | visit read rules (SV4b) |
| Sharing | none | `ShareLink` (SV5b) |
| Undo a stuck visit | none | `visit.closeOnBehalf` (SV1b) |

---

## 8. Risks, and how we'll know it works

| Risk | Handling |
| --- | --- |
| Crowded home screens | One button and one card per role. |
| No signal on site | Saved on the phone and sent in order; one phone per visit (Q12). |
| Weak or blocked GPS | Optional; never blocks. |
| Two phones, two starts | One open visit per visitor; a delayed overlapping start is kept and flagged, never merged silently. |
| Actions nobody owns | An action needs an owner and a due date; the PMC turns it into a real record. |
| Contractors expecting to close fixes | The engineer records the fix (Q9). |
| A visit stuck open | PMC close-on-behalf, marked unsigned. |
| Shared links leaking | Members only; tracked, expiring, cancellable, re-checked on each open. |
| Architect role not yet available | Architects visit as consultants until 4d-iii (Q3). |

**Proof:**
- **Automated:** each unit's tests as listed in §6, independent review and CI.
- **Live role QA** on the isolated QA project, per unit:
  - the PMC, an architect and a consultant run visits;
  - the PMC confirms and declines actions;
  - an engineer closes a quality action with a fixed photo;
  - a contractor sees only their normal view;
  - a client reads the summary;
  - another project sees nothing.

  Results are recorded in the PR before it is called done.
- **Real use:** one real project's first visits, reviewed with the PMC before wider rollout.
