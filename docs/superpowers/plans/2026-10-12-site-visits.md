# Site Visits — product plan (SV1–SV5)

**Status:** product plan for review. **No code and no technical design yet.** Building begins only after the owner and
Board place Site Visits in the queue (Q8). Each step then gets **its own technical design**, written and reviewed
when that step is next. It must meet the requirements in §5.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792).
**Authority:**
- the Board's briefs of 7 Oct 2026 on #482:
  [17:47](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037732251),
  [17:53](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037831581),
  [17:56](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037874252),
  [18:03](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037997278) IST;
- the owner's decision of 12 Oct 2026 on who may start a visit;
- the owner's ruling of 12 Oct 2026 to split this plan (product plan here, one technical design per step).

**Why it is split.** The first version mixed this product plan with a full technical design for five features.
Three review rounds found 34 design-level gaps, and each round of detail opened new ones. Under the repo's review
rule, the plan was redesigned into smaller units:
- **this document:** what we are building and why, for whom, how it should feel, what is decided and what is open;
- **one design per step:** how it works, reviewed on its own.

Every gap found so far is kept, as a requirement in §5, so none is lost.

---

## 1. In one page

**What it is.** A site visit is a dated walk-through of the site by a consultant-side visitor: the PMC, an
architect or another consultant. During the walk they take photos and say what they saw. Anything that needs
fixing becomes a task with an owner and a due date. When they finish, the app produces a short report that the
visitor signs, and it reaches the project's members in their own language.

**Why.** The Board's test for every feature: *it helps each person do their own job better, makes clear who did
what, and keeps everyone in the loop.* Today a visit lives in WhatsApp photos and memory: problems get lost,
nobody knows who promised what, and the client hears about it late. After this work:
- the visitor can prove what they saw, when and where;
- engineers get a clear list of what to fix, with photos, an owner and a deadline;
- the client gets a plain summary;
- nothing closes until someone shows a photo of it fixed.

**What it is not.** Not a new app or a new menu. It lives inside screens people already use: the PMC Brief, the Site
Map, For You and the client Pulse. A problem found on a visit becomes one of the app's existing records (an
inspection, a decision or a change request), so it follows approval steps people already know.

**Who can start a visit.** An **architect**, a **consultant** or the **PMC** (owner, 12 Oct 2026: the PMC is a kind of
consultant too). Everyone else takes part, as an attendee, a fix owner or a reader, but does not start visits.

**The five steps,** each built, released and tested on its own:

| Step | What people get |
| --- | --- |
| **SV1 Visit record** | "Start visit": who, when, GPS check-in (if available), who else attended, where it started. Shows in the project's history. Works with no signal. |
| **SV2 Observations** | During the visit: photo + place + note, marked **Fine**, **Concern** or **Action needed**. Each carries the visitor's name and role. Works offline. |
| **SV3 Actions** | "Action needed" becomes a real task with an owner and a due date. The **PMC** turns it into the right record. It closes only with a photo proving the fix. Overdue items show on the PMC Brief. |
| **SV4 Visit report** | "End visit": a one-page report the visitor reviews and signs, in English, Hindi or Gujarati, delivered to members and summarised in the client's Pulse. |
| **SV5 Sharing** | A **Share** button on a visit photo or report that creates a tracked, expiring, members-only link (7 days by default), whichever way it is sent. Every share and open is logged. |

---

## 2. Decisions so far, and questions still open

**Decided**

| # | Decision | By / when |
| --- | --- | --- |
| D1 | Built into existing screens; no new navigation item. | Board, 7 Oct 17:53 IST |
| D2 | Observations use the existing photo store, place tags (Zone > Room > Object) and the "who did it" stamp. | Board, 7 Oct 17:53 IST |
| D3 | An action becomes an existing record type; it closes only with a fix photo. | Board, 7 Oct 17:53/17:56 IST |
| D4 | Steps SV1–SV5, one PR per unit, plan first. | Board, 7 Oct 17:56 IST |
| D5 | **Who starts a visit: architect, consultant or PMC.** | **Owner, 12 Oct 2026** |
| D6 | **This plan is the product plan; each step gets its own technical design.** | **Owner, 12 Oct 2026** |

D5 replaces the brief's "Start visit" on the engineer's Today and the client's Pulse. The engineer and client still
see visits; they don't start them.

**Open (decided before the step that needs it)**

| # | Question | Proposal | Needed by |
| --- | --- | --- | --- |
| Q1 | May the **client** comment on a visit report, or only read the summary? | Read only at first; comments later. | SV4 |
| Q2 | May an **engineer or contractor** add photos to a visit they attend? | No: only the visitor records observations; owners answer through their own tasks. | SV2 |
| Q3 | The **architect role** cannot yet be given on a project (reserved until the paused 4d-iii work). Architects visit as **consultant** members until then? | Yes. | SV1 |
| Q4 | Consultants **cannot upload photos today** (only the PMC and engineers can). Allow a visitor to add photos **only for their own visit** (and its actions)? | Yes; never general photo upload. | SV2 |
| Q5 | Who turns an "Action needed" into a real record? | **The PMC, always**, through the normal form for that record, since consultants and architects cannot create decisions or change requests today. | SV3 |
| Q6 | Is **GPS check-in** required? | No: recorded when available, never blocks. | SV1 |
| Q7 | **Share links**: how long, and can they be cancelled? | 7 days by default (Board), cancellable by the sharer or the PMC; members only; every open logged. | SV5 |
| Q8 | **Where in the queue?** Your records disagree: Board 7 Oct 17:56 (SV1–SV3 early); owner 7 Oct 18:16 (after isolated QA); STATUS (after 4d-iii R1–R4). | The owner's 18:16 order: build after isolated QA exists, so each step is checked by real roles before real sites. | before SV1 |
| Q9 | Should contractors add the "fixed" photo themselves? | Not at first (it needs new contractor rights); the engineer records the fix. | SV3 |
| Q10 | Should guests (attendees typed as names, not app members) receive the report? | No automatic delivery; members only. | SV4 |
| Q11 | Should a **contractor firm** be told about actions that concern it? | Not at first: the app has no link from a firm to its people. | SV3 |
| Q12 | **One phone per visit?** | Yes: a visit is added to and ended from the phone that started it. | SV1 |
| Q13 | The worker job card's **Photo** button. | Its own later unit: it needs a live worker screen and a narrowly scoped upload, which workers do not have today. Not part of SV5's sharing. | after SV5 |

---

## 3. How it should feel

*The intended experience. Each step's technical design decides how to achieve it within §5's requirements.*

**The visitor (PMC, architect or consultant)**
1. **Start** from the PMC Brief (or the consultant's home), or **Visit this area** on the Site Map. One open visit
   at a time; if one is open, Start offers **Resume**.
2. **Check in:** time, visitor and GPS when available. Pick attendees from the project's members; outside names can
   be typed (listed only).
3. **Walk:** **Add observation** → photo → place → note → **Fine / Concern / Action needed**.
4. **Act:** for "Action needed", a suggested kind (quality / design / change), owner and due date. It goes to the PMC
   to turn into the real record.
5. **End and sign:** the visitor reviews the report and signs exactly what they reviewed.

It works without signal on the phone that started the visit, and the report shows when things really happened.

**The PMC:** sees **Awaiting PMC** items on the Brief, completes the normal form for the chosen record (or declines
with a reason), and sees overdue items.

**Engineer:** For You shows the tasks from a visit; a quality fix is recorded with a photo proving the fix, and the
PMC reviews it as today.

**Contractor:** sees visit actions through their normal project view (Q9, Q11).

**Client:** a plain summary in Pulse, with the report one tap away in their language.

**Everyone:** each area on the Site Map shows its visit history.

**Kept out on purpose:** no new menu, inbox or "visits app"; one button and one card per role.

---

## 4. What already exists, and what each step adds

**Reused:**
- photo capture with its stamp, place and GPS;
- places (Zone > Room > Object) and the Site Map;
- inspections, decisions and change requests, with their approvals;
- For You and notifications that open the exact record, with read/unread;
- offline save-and-send (as the Daily Log does it);
- the language preference.

**Today's rules each step must work with** (each design must respect them or name the new rule it adds):
- **Uploads:** only the PMC and engineers can upload photos.
- **Inspections:** only the PMC creates and decides them; a new inspection has no assignee; only engineers do
  corrective work, and they submit it.
- **Decisions:** only the PMC creates them.
- **Change requests:** the architect cannot raise one, and one needs an approved decision plus cost and time
  impacts.
- **Inspection photos:** they are shown to every project role today.
- **Firms:** nothing links a contractor firm to its people.
- **Worker job card:** it is hidden in live builds, and workers cannot upload.

**New, by step:**
- SV1 a visit record;
- SV2 observations with their photos;
- SV3 actions;
- SV4 the signed report and corrections;
- SV5 share links and their log.

---

## 5. Requirements every step's design must meet

These are binding on the technical designs. Each requirement names the step whose design must define *how*, and
prove it with tests. They collect every point raised in the three reviews of the first version.

**Who did what, and when**
- R1. Every record carries the person and role from their login, never from what the screen sends.
- R2 (SV1, SV2). Offline visit steps keep when they really happened as well as when the server received them, with
  bounds against impossible times. Later steps (confirming, closing, correcting) have their own time rules and are
  not held to the visit's window.
- R3 (SV1). At most one open visit per visitor. A start from a second phone, or a delayed offline start, must never
  lose recorded observations or silently merge visits. Overlap is judged only when both ends of a visit are known.
- R4 (SV1). A visit left open by someone who loses access can be closed by the PMC, with a reason, marked unsigned.

**Evidence**
- R5 (SV2). Each photo is durably tied to its visit and to the exact observation (or action) it belongs to, within
  the same project and uploader. A visitor's upload right covers only their own visit.
- R6 (SV2, SV4). Adding to, ending, signing and deleting photos of a visit are serialised, so nothing slips in or out
  around the end.
- R7 (SV4). The signed report stores **the exact content the visitor signed**, not only a fingerprint, and signing a
  preview that has since changed is refused.
- R8 (SV4). A signed report is never edited. Corrections are append-only, attributed, and allowed only to the signer
  or the PMC.

**Actions**
- R9 (SV3). The PMC creates every linked record through the existing command, with that command's own inputs; any
  rule changes (for example an inspection assignee) are named and tested.
- R10 (SV3). Confirming is atomic: two PMCs or two retries cannot create two records.
- R11 (SV3). "Fixed" means **a photo that proves the fix**, captured after the action, for every record type. A
  defect photo never closes an action, and approving the linked record alone never closes it.
- R12 (SV3). Who may close an action is defined, with wrong-role tests.
- R13 (SV2/SV3). "Action needed" observations made before SV3 is live are either not offered until SV3, or are
  turned into actions when SV3 starts, so none is silently left without a task.

**Reading and sharing**
- R14 (SV4). One read rule for visits, reports and visit photos, used by every route. It neither relies on nor
  changes the existing exposure of inspection photos.
- R15 (SV5). Every share, whichever way it is sent, is a tracked link that requires a signed-in current member, is
  re-checked on every open, expires, can be cancelled, and is logged. Opening and cancelling are serialised.

**Delivery**
- R16. Each step ships its database change first as a separate, additive PR, then server and web PRs, per the repo
  policy.
- R17. Each step is tested with real roles on the isolated QA project before it counts as done: PMC, architect,
  consultant, engineer, contractor, client, and someone from another project.
