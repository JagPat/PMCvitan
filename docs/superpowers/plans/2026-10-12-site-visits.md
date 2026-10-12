# Site Visits — product plan (SV1–SV5)

**Status:** product decisions for review. **No code and no technical design. Nothing here is built or fixed.**
Building begins only after the owner and Board place Site Visits in the queue (Q8). Each step then gets **its own
technical design**, written and reviewed when that step is next.
**Tracking issue:** [#792](https://github.com/JagPat/PMCvitan/issues/792). It holds the requirements R1–R17 and all
44 review findings, every one open ([record](https://github.com/JagPat/PMCvitan/issues/792#issuecomment-6116340360)).
**Authority:**
- the Board's briefs of 7 Oct 2026 on #482:
  [17:47](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037732251),
  [17:53](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037831581),
  [17:56](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037874252),
  [18:03](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6037997278) IST;
- the owner's decisions of 12 Oct 2026: who may start a visit (D5) and the split (D6);
- the owner's [documentation-preservation record](https://github.com/JagPat/PMCvitan/issues/482#issuecomment-6116163100)
  of 12 Oct 2026: findings stay open, and the stop history and the Board's scope are kept;
- the owner's ruling of 12 Oct 2026 to shrink this document to the product decisions.

**Review history.**
- **The third-head stop.** Codex found a P1 in this file at `664c6c8`, `b985832` and `e83ed57`
  ([stop record](https://github.com/JagPat/PMCvitan/pull/793#issuecomment-6116069309)). The owner ruled the split.
- **The later heads.** `71c40b4`, `f8db706` and `d3ebebf` also drew P1s. They add to that history; none resets it.
- **The shrink.** Each round's answers were requirement text that drew new design-depth findings, so the owner ruled
  that this document keeps only the product decisions:
  - the Board's scope;
  - D1–D6;
  - the staging proposals S1–S8, none approved;
  - the open questions Q1–Q13.

  The requirements and the finding index moved to #792. Moving them there is a **carry-forward, not a fix**. Each
  finding closes only when its step's design is reviewed and its proof passes.
- **Earlier drafts.** The "how it should feel" and "today's rules" sections of earlier drafts remain in Git history
  ([`d3ebebf`](https://github.com/JagPat/PMCvitan/blob/d3ebebf653ee7138c7f7774a5471e38cd331121a/docs/superpowers/plans/2026-10-12-site-visits.md)).

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

**Staging proposals (not approved).** These came out of review findings. Each departs from, or adds to, the
Board's scope above, and stays a proposal until the owner or Board decides it. Its findings stay open on #792.

| # | Proposal | Departs from | Findings (#792) |
| --- | --- | --- | --- |
| S1 | A plain **End visit** in SV1, before reports exist. | Board: ending a visit produces the report (SV4) | F35, F38, F41 |
| S2 | **One open visit per visitor.** | not in the Board's scope | F8, F14, F34 |
| S3 | **The PMC turns every action into its record** (Q5). | Board: no actor named | F4, F13, F25 |
| S4 | Non-fixed end states for an action (for example declined, or its record withdrawn). | D3: closes only with a fix photo | F36, F39 |
| S5 | A visitor may upload photos **only for their own visit** (Q4). | today's upload rule (PMC and engineers) | F2, F19 |
| S6 | The share sheet sends **only a tracked link**. | Board: share sheet and/or link | F22, F42 |
| S7 | The worker job card's Photo button as **its own unit after SV5** (Q13). | Board: part of SV5 | F32 |
| S8 | SV5 first covers **visit photos and reports only** (an earlier draft). | Board: any photo or visit report | F42 |

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
| Q12 | **One phone per visit?** | Yes: a visit is added to and ended from the phone that started it; a lost or broken phone needs a defined recovery (#792 R4). | SV1 | Open |
| Q13 | The worker job card's **Photo** button (Board: SV5). | Its own unit after SV5 (S7): it needs a live worker screen and a narrowly scoped upload, which workers do not have today. | SV5 | Open |

Q8 concerns where Site Visits sits before SV1. It does not reopen or block other approved work.

---

## 3. Requirements and findings: kept open on the tracking issue

Per the owner's ruling of 12 Oct 2026 (after six reviewed heads of #793 with P1s in this file), this document keeps
only the product decisions. Two things live on the tracking issue
([#792, preserved record](https://github.com/JagPat/PMCvitan/issues/792#issuecomment-6116340360)):
- the binding requirements **R1–R17** for each step's technical design;
- the **finding index F1–F44**: every Codex finding on this plan, with its step, requirement and required proof.

**All 44 findings are open.** Each closes only when its step's technical design is reviewed and its proof passes.
Moving them to the issue is a carry-forward, not a fix.
