# Site Visits — product plan (SV1–SV5)

**Status:** product plan for review. **No code and no technical design yet. Nothing here is built or fixed.**
Building begins only after the owner and Board place Site Visits in the queue (Q8). Each step then gets **its own
technical design**, written and reviewed when that step is next. It must meet the requirements in §5 and prove the
findings in §6.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792).
**Authority:**
- the Board's briefs of 7 Oct 2026 on #482:
  [17:47](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037732251),
  [17:53](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037831581),
  [17:56](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037874252),
  [18:03](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037997278) IST;
- the owner's decision of 12 Oct 2026 on who may start a visit;
- the owner's ruling of 12 Oct 2026 to split this plan (product plan here, one technical design per step);
- the owner's [documentation-preservation record](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6116163100)
  of 12 Oct 2026: findings stay open, the stop history and the Board's scope are kept.

**Review history and the stop.**
- **The stop.** The first version mixed this product plan with a full technical design for five features. Codex
  found a P1 in this file at three distinct reviewed heads: `664c6c8`, `b985832` and `e83ed57`. That is the repo's
  [third-head stop](https://github.com/JagPat/PMCvitan/blob/ec3f20b9508a0403366a1b98ba18ba5686b1fa92/docs/POLICY.md#review-continuity-and-scope),
  [recorded on the PR](https://github.com/JagPat/PMCvitan/pull/793#issuecomment-6116069309).
- **The ruling.** The owner ruled to continue with a smaller planning redesign:
  - **this document:** what is being built and why, for whom, and how it should feel; what is decided and what is open;
  - **one design per step:** how it works, reviewed on its own.
- **After the stop.** Later heads with P1s (`71c40b4`, `f8db706`) do not reset that history, and no count is reset.
- **Every finding stays open.** All 40 findings are listed in §6, each with the step and requirement it maps to, the
  proof required and its disposition. Moving a finding into a requirement, or answering and resolving its review
  thread, is a **carry-forward, not a fix**. A finding is fixed only when its step's design is reviewed and its
  proof passes.

---

## 1. In one page

**What it is.** A site visit is a dated walk-through of the site by a consultant-side visitor: the PMC, an
architect or another consultant. During the walk they take photos and say what they saw. Anything that needs
fixing becomes a task with an owner and a due date. Ending the visit produces a short report that the visitor
signs, and it reaches the project's members in their own language. Separately, any photo or visit report can be
shared, permission-checked and logged.

**Why.** The Board's test for every feature: *it helps each person do their own job better, makes clear who did
what, and keeps everyone in the loop.* Today a visit lives in WhatsApp photos and memory: problems get lost,
nobody knows who promised what, and the client hears about it late. After this work:
- the visitor can prove what they saw, when and where;
- engineers get a clear list of what to fix, with photos, an owner and a deadline;
- the client gets a plain summary;
- nothing is marked fixed until someone shows a photo of it fixed.

**What it is not.** Not a new app or a new menu. It lives inside screens people already use: the PMC Brief, the Site
Map, For You and the client Pulse. A problem found on a visit becomes one of the app's existing records (an
inspection, a decision or a change request), so it follows approval steps people already know.

**Who can start a visit.** An **architect**, a **consultant** or the **PMC** (owner, 12 Oct 2026: the PMC is a kind of
consultant too). Everyone else takes part, as an attendee, a fix owner or a reader, but does not start visits.

**The five steps (the Board's scope, 7 Oct 17:53 and 17:56 IST),** each built, released and tested on its own:

| Step | What people get (Board scope) |
| --- | --- |
| **SV1 Visit record** | "Start visit" (for the visitors in D5; the PMC from the PMC Brief) and "Visit this area" on the Site Map: who, when, GPS check-in, attendees and the places walked. Shows in the project's history. Works offline, like the Daily Log. |
| **SV2 Observations** | Photo + place tag + note, marked **Fine**, **Concern** or **Action needed**. Carries the actor's name and role. Works offline. |
| **SV3 Actions** | "Action needed" becomes an existing inspection item, decision or change request, with an owner and a due date, following the existing approval and re-inspection flows. It **closes only with a fix photo**. Overdue items show on the PMC Brief. |
| **SV4 Visit report** | Ending a visit produces a signed one-page report (attendees, observations with photos, open actions) in the reader's language (English, Hindi, Gujarati), delivered to each participant's For You as a deep link, and summarised in the client's Pulse. Contractors and engineers see their asks. |
| **SV5 Sharing** | A **Share** action on **any photo or visit report**, wherever photos already appear: the phone share sheet and/or an expiring read-only link (7 days by default) carrying the capture stamp. Project members only; every share is logged. **Also wire the worker job card's Photo button to real capture.** |

Where this plan proposes staging that differs from the Board's scope, it is listed in §2 under **Staging
proposals**. Those proposals are **not approved**.

---

## 2. Decisions, staging proposals and open questions

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

**Staging proposals (not approved).** These came out of review findings. Each departs from, or adds to, the Board's
scope above. Each stays a proposal until the owner or Board decides it, and its findings stay open (§6).

| # | Proposal | Departs from | Findings |
| --- | --- | --- | --- |
| S1 | SV1 gets a plain **End visit** with no report. Visits ended before SV4 ships stay unsigned ("ended before reports existed"), with no backfill. SV4's design may offer the visitor an explicit "create report" for one. | Board: ending a visit produces the report (SV4) | F35, F38 |
| S2 | **One open visit per visitor**; Start offers Resume when one is open. | not in the Board's scope | F8, F14, F34 |
| S3 | **The PMC turns every action into its record** (Q5). | Board: an action becomes a record, with no actor named | F4, F13, F25 |
| S4 | Besides **Fixed**, two non-fixed end states: **Declined** by the PMC with a reason, before any record exists; **Closed, not fixed** when the linked record is withdrawn. | D3: closes only with a fix photo | F36, F39 |
| S5 | A visitor may upload photos **only for their own visit** (Q4). | today's upload rule (PMC and engineers) | F2, F19 |
| S6 | The share sheet sends **only a tracked link**, never the file or a raw media URL. | Board: share sheet and/or link | F22 |
| S7 | The worker job card's Photo button becomes **its own unit after SV5** (Q13). | Board: part of SV5 | F32 |
| S8 | An earlier draft limited SV5 to **visit photos and reports first**. | Board: any photo or visit report | — |

**Open (decided before the step that needs it).** Each has a proposal; **none is decided.**

| # | Question | Proposal | Needed by | Status |
| --- | --- | --- | --- | --- |
| Q1 | May the **client** comment on a visit report, or only read the summary? (The Board's 17:53 proposal: client read-and-comment.) | Read only at first; comments later. | SV4 | Open |
| Q2 | May an **engineer or contractor** add photos to a visit they attend? | No: only the visitor records observations; owners answer through their own tasks. | SV2 | Open |
| Q3 | The **architect role** cannot yet be given on a project (reserved until the paused 4d-iii work). Architects visit as **consultant** members until then? | Yes. | SV1 | Open |
| Q4 | Consultants **cannot upload photos today** (only the PMC and engineers can). Allow a visitor to add photos **only for their own visit** (and its actions)? | Yes; never general photo upload (S5). | SV2 | Open |
| Q5 | Who turns an "Action needed" into a real record? | The PMC, through the normal form for that record, since consultants and architects cannot create decisions or change requests today (S3). | SV3 | Open |
| Q6 | Is **GPS check-in** required? | No: recorded when available, never blocks. | SV1 | Open |
| Q7 | **Share links**: how long, and can they be cancelled? | 7 days by default (Board), cancellable by the sharer or the PMC; members only; every open logged. | SV5 | Open |
| Q8 | **Where in the queue?** Your records disagree: Board 7 Oct 17:56 and 18:03 (SV1–SV3 early); owner 7 Oct 18:16 (after isolated QA); STATUS (after 4d-iii R1–R4). | The owner's 18:16 order: build after isolated QA exists, so each step is checked by real roles before real sites. | before SV1 | Open |
| Q9 | Should contractors add the "fixed" photo themselves? | Not at first (it needs new contractor rights); the engineer records the fix. | SV3 | Open |
| Q10 | Should guests (attendees typed as names, not app members) receive the report? | No automatic delivery; members only. | SV4 | Open |
| Q11 | Should a **contractor firm** be told about actions that concern it? | Not at first: the app has no link from a firm to its people. | SV3 | Open |
| Q12 | **One phone per visit?** | Yes: a visit is added to and ended from the phone that started it; if that phone is lost or broken, it is closed from another device (R4). | SV1 | Open |
| Q13 | The worker job card's **Photo** button (Board: SV5). | Its own unit after SV5 (S7): it needs a live worker screen and a narrowly scoped upload, which workers do not have today. | SV5 | Open |

Q8 concerns where Site Visits sits before SV1. It does not reopen or block other approved work.

---

## 3. How it should feel

*The intended experience, within the Board's scope. Where it relies on a proposal (S or Q above), that is marked.
Each step's technical design decides how to achieve it within §5's requirements.*

**The visitor (PMC, architect or consultant)**
1. **Start** from the PMC Brief (or the consultant's home), or **Visit this area** on the Site Map. If one is open,
   Start offers **Resume** (S2).
2. **Check in:** time, visitor and GPS when available (Q6). Pick attendees from the project's members; outside names
   can be typed (Q10).
3. **Walk:** **Add observation** → photo → place → note → **Fine / Concern / Action needed**.
4. **Act:** for "Action needed", a suggested kind (quality / design / change), owner and due date. The record is
   created by whoever Q5 settles (proposal: the PMC).
5. **End:** ending produces the report, and the visitor signs exactly what they reviewed (SV4). Before SV4, a plain
   End visit is proposed (S1).

It works without signal, and the report shows when things really happened.

**The PMC:** sees items awaiting them on the Brief, completes the normal form for the chosen record, and sees overdue
items. Declining an item is proposed (S4).

**Engineer:** For You shows the tasks from a visit; a quality fix is recorded with a photo proving the fix, and the
PMC reviews it as today.

**Contractor:** sees their asks (Board); how, and what they may do, is open (Q9, Q11).

**Client:** a plain summary in Pulse, with the report one tap away in their language (comments: Q1).

**Everyone:** each area on the Site Map shows its visit history. Any photo or visit report can be shared with
project members, and every share is logged (SV5).

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
- **Decisions:** only the PMC creates them; a decision can be withdrawn.
- **Change requests:** the architect cannot raise one, and one needs an approved decision plus cost and time
  impacts; a change request can be withdrawn.
- **Inspection photos:** they are shown to every project role today.
- **Firms:** nothing links a contractor firm to its people.
- **Worker job card:** it is hidden in live builds, and workers cannot upload.

**New, by step:**
- SV1 a visit record;
- SV2 observations with their photos;
- SV3 actions;
- SV4 the signed report and corrections;
- SV5 share links and their log, for any photo or visit report, and the worker Photo capture.

---

## 5. Requirements every step's design must meet

These are binding on the technical designs. Each requirement names the step whose design must define *how*, and
prove it with tests. They carry every finding in §6. A requirement written here is **not** a fix: the finding stays
open until its proof passes. Where a requirement depends on a proposal (S or Q), the design follows whatever the
owner decides.

**Who did what, when and where**
- R1. Every record carries the person and role from their login, never from what the screen sends.
- R2 (SV1, SV2). Offline visit steps keep when they really happened as well as when the server received them, with
  bounds against impossible times. Later steps (confirming, closing, correcting) have their own time rules and are
  not held to the visit's window. The visit keeps where it started and the places walked, even with no observation.
- R3 (SV1). Starts from two phones, or a delayed offline start, never lose recorded observations or silently merge
  visits. Overlap is judged only when both ends of a visit are known. If S2 is approved, at most one visit per
  visitor is open, enforced under concurrency.
- R4 (SV1, SV4). **No visit is ever stranded open or left in an undefined state.** The design lists every way a
  visit can end and gives each an end state, with tests. At least:
  - the visitor ends it, in every released step (S1 proposes how before SV4);
  - the visitor loses access: the PMC closes it, with a reason, marked unsigned;
  - if Q12 is approved, the starting phone is lost or broken: a defined closure from another device, keeping
    anything that phone sends later (proposal in Q12).

  A visit ended before reports exist is never presented as signed or delivered (S1 proposes how).

**Evidence**
- R5 (SV2). Each photo is durably tied to its visit and to the exact observation (or action) it belongs to, within
  the same project and uploader. Any new upload right is exactly as wide as Q4 decides, and no wider.
- R6 (SV2, SV4). Adding to, ending, signing and deleting photos of a visit are serialised, so nothing slips in or out
  around the end.
- R7 (SV4). The signed report stores **the exact content the visitor signed**, not only a fingerprint, and signing a
  preview that has since changed is refused.
- R8 (SV4). A signed report is never edited. Corrections are append-only and attributed, with a defined set of who may
  write them (proposal: the signer or the PMC). Every place the report is read or shared shows its corrections with
  it, and the report's original member recipients are told of each correction.

**Actions**
- R9 (SV3). Every linked record is created through its existing command, with that command's own inputs, by a role
  that command allows (who: Q5). Any rule change (for example an inspection assignee) is named and tested.
- R10 (SV3). Confirming is atomic: two PMCs or two retries cannot create two records.
- R11 (SV3). "Fixed" means **a photo that proves the fix**, captured after the action, for every record type. A
  defect photo never closes an action, and approving the linked record alone never closes it.
- R12 (SV3). **No action is ever stranded open.** The design maps every way an action, or its linked record, can end
  to an action end state, with tests. That includes:
  - an item that should not proceed before any record exists;
  - a linked record withdrawn.

  Only a fixed action (R11) is shown or counted as fixed. S4 proposes the non-fixed states. Who may close (and, if
  S4 is approved, decline) is defined, with wrong-role tests.
- R13 (SV2/SV3). "Action needed" observations made before SV3 is live are either not offered until SV3, or are
  turned into actions when SV3 starts, so none is silently left without a task.

**Reading and sharing**
- R14 (SV4). One read rule for visits, reports and visit photos, used by every route. It neither relies on nor
  changes the existing exposure of inspection photos.
- R15 (SV5). Sharing covers **any photo or visit report** (Board). Every share path, the share sheet included, is
  permission-checked for current project members, logged, and, for links, re-checked on every open, expiring and
  cancellable. Opening and cancelling are serialised. S6 proposes routing the share sheet through tracked links
  only.

**Delivery**
- R16. Each step ships its database change first as a separate, additive PR, then server and web PRs, per the repo
  policy.
- R17. Each step is tested with real roles on the isolated QA project before it counts as done: PMC, architect,
  consultant, engineer, contractor, client, and someone from another project.

---

## 6. Finding index

Every Codex finding on this plan, across all five reviewed heads (`664c6c8`: 12, `b985832`: 12, `e83ed57`: 10,
`71c40b4`: 3, `f8db706`: 3). **All 40 are open.** No step is designed or built, so no finding has a demonstrated
correction. Each closes only when its step's technical design is reviewed and the proof below passes in that step's
tests (R17 adds live role QA).

| # | Head | P | Finding | Step · requirement | Proof the step's design must show | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | `664c6c8` | P1 | [Add a photo gate for every action record type](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939257) | SV3 · R11 | for each record type (inspection, decision, change request), approving or re-approving the linked record without a fix-proving photo leaves the action open | **Open** |
| F2 | `664c6c8` | P1 | [Align the promised personas with inspection permissions](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939261) | SV3 · R9, R12; Q5, Q9 | wrong-role tests: a contractor, consultant or architect cannot take an inspection step today's rules refuse them, unless a new rule is named and tested | **Open** |
| F3 | `664c6c8` | P1 | [Lock the visit before admitting an observation](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939274) | SV2 · R6 | barrier test: an observation racing End visit is either in the ended visit (and any report) or refused, never added after | **Open** |
| F4 | `664c6c8` | P1 | [Model PMC confirmation as a durable action state](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939260) | SV3 · R9, R10; Q5 | the awaiting-PMC state is stored, notified and survives restart; confirming is idempotent under retry | **Open** |
| F5 | `664c6c8` | P1 | [Preserve occurrence times for offline visits](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939256) | SV1, SV2 · R2 | an offline start, end and observation sent later keep both the occurrence and the receipt time; impossible times are refused | **Open** |
| F6 | `664c6c8` | P1 | [Recheck object authorization when opening share links](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939263) | SV5 · R14, R15 | opening a link is re-authorised for the viewer's current role and membership; wrong-role and removed-member opens are refused | **Open** |
| F7 | `664c6c8` | P1 | [Seal photos referenced by a signed report](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939277) | SV4 · R6, R7 | deleting a photo that a signed report references is refused | **Open** |
| F8 | `664c6c8` | P1 | [Serialize creation of a visitor's open visit](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939267) | SV1 · R3; S2 | two concurrent starts with different keys for one visitor leave one open visit | **Open** |
| F9 | `664c6c8` | P2 | [Add recovery for visits orphaned by role removal](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939284) | SV1 · R4 | a removed or re-roled visitor's open visit can be closed by the PMC with a reason, marked unsigned | **Open** |
| F10 | `664c6c8` | P2 | [Define the promised immutable correction record](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939279) | SV4 · R8 | a correction is a new attributed record; the signed report is unchanged | **Open** |
| F11 | `664c6c8` | P2 | [Exclude free-text attendees from notice delivery](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939259) | SV4 · Q10, R1 | typed guest names receive nothing; member attendees receive the report | **Open** |
| F12 | `664c6c8` | P2 | [Persist the Site Map starting area on the visit](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243939269) | SV1 · R2 | the starting place and the places walked persist on the visit even with no observation | **Open** |
| F13 | `b985832` | P1 | [Match action creation to existing decision contracts](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981776) | SV3 · R9; Q5 | each linked record is created through its existing command with that command's full inputs; roles the policy refuses stay refused | **Open** |
| F14 | `b985832` | P1 | [Reconcile delayed offline starts across devices](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981764) | SV1 · R3 | a delayed offline start from a second phone, arriving after the first visit ended, loses nothing and is never silently merged | **Open** |
| F15 | `b985832` | P1 | [Reconcile offline observations from every device before signing](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981768) | SV2, SV4 · R3, R6; Q12 | an observation from another phone arriving after End visit is kept and flagged, never silently dropped | **Open** |
| F16 | `b985832` | P1 | [Scope visit-window validation to visit-time commands](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981782) | SV3, SV4 · R2 | confirming, closing and correcting after the visit has ended are accepted under their own time rules | **Open** |
| F17 | `b985832` | P1 | [Serialize photo deletion with visit ending](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981772) | SV2, SV4 · R6 | barrier test: photo deletion racing End visit never removes a photo the ended visit or report references | **Open** |
| F18 | `b985832` | P2 | [Restrict who may append report corrections](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981779) | SV4 · R8 | a correction by anyone other than the signer or the PMC is refused | **Open** |
| F19 | `b985832` | P1 | [Bind each visit photo to the visit that authorized it](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981785) | SV2 · R5; Q4 | a photo from another visit or another uploader cannot be attached to an observation | **Open** |
| F20 | `b985832` | P1 | [Bind the signature to the exact report preview](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981798) | SV4 · R7 | signing a preview that changed after it was shown is refused | **Open** |
| F21 | `b985832` | P1 | [Define object read policies before relying on reauthorization](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981789) | SV4 · R14 | one read rule serves visits, reports and visit photos on every route, with wrong-role tests; the existing inspection-photo exposure is unchanged | **Open** |
| F22 | `b985832` | P1 | [Route native sharing through authenticated share links](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981793) | SV5 · R15; S6 | every share path, the share sheet included, is permission-checked and logged; a copy sent to a non-member does not open | **Open** |
| F23 | `b985832` | P1 | [Separate schema migrations from service and web units](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981795) | all steps · R16 | each step's schema change ships as its own additive migration PR before its server and web PRs | **Open** |
| F24 | `b985832` | P2 | [Model the responsible contractor and its recipients](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4243981802) | SV3 · Q11 | no notice targets a firm while nothing links a firm to its people; notices go only to member recipients | **Open** |
| F25 | `e83ed57` | P1 | [Collect command inputs before PMC auto-creation](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025690) | SV3 · R9; Q5 | no path creates a linked record without collecting that command's required inputs | **Open** |
| F26 | `e83ed57` | P1 | [Require evidence that proves the inspection fix](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025693) | SV3 · R11 | a defect photo never closes an action; only a photo captured after the action and marked as the fix does | **Open** |
| F27 | `e83ed57` | P1 | [Persist the signed report content](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025688) | SV4 · R7 | the stored signed content is reproduced exactly after later action changes | **Open** |
| F28 | `e83ed57` | P1 | [Persist the observation-to-photo relationship](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025696) | SV2 · R5 | with two observations at one place, each photo stays bound to its own observation | **Open** |
| F29 | `e83ed57` | P1 | [Reconcile action observations created before SV3](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025699) | SV2, SV3 · R13 | after SV3 ships, every earlier "Action needed" observation has exactly one action (idempotent), or the rating was never offered | **Open** |
| F30 | `e83ed57` | P1 | [Serialize confirmation before creating the linked record](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025704) | SV3 · R10 | two PMCs, or two different keys, confirming at once create one linked record | **Open** |
| F31 | `e83ed57` | P1 | [Serialize share-link opening with cancellation](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025715) | SV5 · R15 | barrier test: an open racing cancellation never serves the target after the cancellation commits | **Open** |
| F32 | `e83ed57` | P2 | [Add a live backend path for the worker camera](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025713) | SV5 (Board scope) · Q13; S7 | a live worker path with a narrowly scoped upload; a worker device outside that scope is refused | **Open**; deferral (S7) not approved |
| F33 | `e83ed57` | P2 | [Define who may close a visit action](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025707) | SV3 · R12 | wrong-role tests on closing an action | **Open** |
| F34 | `e83ed57` | P2 | [Determine overlap only after receiving both visit endpoints](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244025709) | SV1 · R3 | overlap is judged only when both ends are known: visits one after another are not flagged; truly overlapping ones are | **Open** |
| F35 | `71c40b4` | P1 | [Add a normal close path to SV1](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244052681) | SV1 · R4; S1 | in every released step the visitor can end their own visit | **Open** |
| F36 | `71c40b4` | P1 | [Define how a declined action leaves Awaiting PMC](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244052684) | SV3 · R12; S4 | an action declined before any record exists leaves Awaiting PMC and the overdue list, and is never counted as fixed | **Open** |
| F37 | `71c40b4` | P2 | [Surface report corrections to the report's recipients](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244052687) | SV4 · R8 | corrections show wherever the report is read or shared, and its member recipients are told | **Open** |
| F38 | `f8db706` | P1 | [Let pre-SV4 visits enter the signing flow](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244075906) | SV4 · R4; S1 | visits ended before SV4 have a defined state and are never presented as signed | **Open** |
| F39 | `f8db706` | P1 | [Map withdrawn linked records to an action end state](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244075911) | SV3 · R12; S4 | a withdrawn decision or change request maps to a non-fixed end state, carrying its reason | **Open** |
| F40 | `f8db706` | P1 | [Provide recovery when the originating phone is unavailable](https://github.com/JagPat/PMCvitan/pull/793#discussion_r4244075904) | SV1 · R4; Q12 | a visit whose starting phone is lost or broken can be closed from another device; anything that phone sends later is kept | **Open** |
