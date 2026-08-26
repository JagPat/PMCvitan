# Units C–E: the create and navigation surface

A proposal, not a change. The brief asked for Units C (a universal `+`), D (desktop
search and add) and E (mobile navigation) to be **evaluated and proposed** before anything
replaces the current mobile navigation. This is that evaluation.

It continues `DATA_ENTRY_AUDIT.md` §7, which stopped at "not yet" and named what would have
to be true first. Everything in §1 is measured from the code at `main` `0818c96f`; §§2–4
propose. The two are kept apart on purpose — §4 of the audit mixed them and drew eight
findings across four review rounds for it.

---

## 1 · Measured: what exists today

### 1.1 The shared create menu already exists, with one mount

`components/CreateMenu.tsx` is built and working: one option list for both devices,
filtered by `createOptionsFor(role)` against the existing `ROLE_POLICY`, with
`materialBlockedReason` separating *may never* (option absent) from *not yet* (option shown
with the reason). A role with no create authority never reaches it.

It is mounted in **exactly one screen**: `PlacesScreen.tsx`.

Its own doc comment anticipates this unit — the device-specific shells "belong with the
universal `+` entry point, not with this list". So Unit C is not a new mechanism. It is a
second and third mount for a mechanism already reviewed and shipped.

### 1.2 Where each record can be started

Every create modal in the application and where it is mounted, found by locating each
`*Modal` component and grepping for its call sites — not by recalling which ones matter.

| Record | Modal | Entry points today | `CreateKind`? |
|---|---|---|---|
| Inspection | `IssueChecklistModal` | Places, Inspection Review | yes |
| Material delivery | `AddMaterialModal` | Places, Daily Log | yes |
| Decision | `IssueDecisionModal` | Places, Decision Log | yes |
| Activity | `PlanActivityModal` | Schedule only | **no** |
| Drawing issue | `IssueDrawingModal` | Drawings only | **no** |
| Schedule phase | `AddPhaseModal` | Schedule only | **no** |
| Company | `CompanyModal` | Team only | **no** |
| Project | `CreateProjectModal` | project switcher | **no** |

The three kinds in the menu each have their owning screen plus Places. **Five further create
flows exist, each with exactly one entry point**, and none of them is in `CreateKind`. An
earlier draft named only Activity and called it "the exception on both counts", which was
wrong: Drawing issue, Schedule phase and Company are in exactly the same position.

**The scoping decision, stated rather than left implicit.** `createOptions.ts` already draws
the line in its own doc comment — its options are worded as "things that happen on a building
site". That criterion separates the table cleanly:

- **Capture records.** Something happened and a site user records it as it happens —
  inspection, material delivery, decision. These are the three in `CreateKind`.
- **Planning and administrative records.** Authored deliberately, from the screen holding the
  thing being planned or administered: an activity and a phase against the programme on
  Schedule, a revision against the register on Drawings, a company against the roster on Team,
  a project outside any project's scope at all.

**A universal `+` covers the capture records, and this proposal is scoped to those three.**
Under C1 a user on Dashboard still cannot issue a drawing from the `+`, and that is a decision
rather than an oversight: a revision issued against the wrong register is precisely the
mistake a context-free entry point invites, and the register is the context. §2 records what
it would take to widen the set later.

From any screen other than those in the table — Dashboard, Materials, Labour, Commercial,
Portfolio, Inbox, Drafts — there is no create affordance at all.

### 1.3 The mobile split, per role

Computed by running `splitMobileNav(screensFor(role))` directly, not by reading the
algorithm. `MOBILE_PRIMARY_PREFERENCE` is `[inbox, site-schedule, places, portfolio]`, four
slots, five tabs maximum.

| Role | Screens | Bottom bar | Behind **More** |
|---|---|---|---|
| pmc | 13 | inbox · site-schedule · places · portfolio | **9** — dashboard, decision-log, drafts, inspect-review, drawings, materials, labour, commercial, team |
| engineer | 11 | inbox · site-schedule · places · daily-log | **7** — engineer-check, drawings, materials, labour, commercial, team-access, decision-log |
| client | 6 | inbox · places · client-decisions · client-health | 2 — decision-log, drawings |
| contractor | 5 | all five, no More | 0 |
| consultant | 5 | all five, no More | 0 |

Two facts follow that matter for Unit E:

- **Daily Log reaches the engineer's bar by top-up, not by preference.** It is not in
  `MOBILE_PRIMARY_PREFERENCE`; it lands in the fourth slot only because `portfolio` is
  absent for that role and the loop fills from role order. The exposure is the **role's screen
  order**, not the preference list: re-ordering `screensFor('engineer')`, or adding a preferred
  key that role also has, can silently take that tab away. §4's E2 measures this rather than
  assuming it.
- **Contractor and consultant fit exactly.** Five screens, five slots, no More sheet. Adding
  a permanent sixth destination for them creates a More sheet that does not exist today.

### 1.4 Search exists on one screen

One search input in the whole application: `DecisionLogScreen.tsx:121`, a client-side filter
over that screen's own list, labelled *Search decisions…*. There is no global search, and
`TopBar` carries only the brand, the project switcher, notifications and sign-out.

`TopBar` is also **mobile-only**: `TopBar.module.css:14-17` hides it from 640px upward and
`TopBar.tsx` names itself "mobile only (<640px)". Its desktop complement is `LeftRail`, hidden
at 639.98px and below (`LeftRail.module.css:11-15`). Any control that must exist on both
devices therefore needs **two mounts**, one in each shell — which §2 gets wrong if read
carelessly.

---

## 2 · Unit C — a universal `+`

### The gap

The menu exists; the reach does not. On desktop a PMC on Dashboard must navigate to Places
or to the owning screen before they can enter anything. On mobile the same PMC is behind a
More sheet for 9 of 13 screens, so a delivery recorded from Materials is More → Materials →
button — three taps before the form.

### The slot cost, corrected

The audit's §7 priced a `+` in the mobile bar and found it "not free yet". That analysis
stands, with one correction to how it has since been restated: the audit says a
single-project PMC who administers no org **cannot open the switcher sheet** — which carries
an *All projects (Portfolio)* row. It does **not** say Portfolio is unreachable.
`screensFor('pmc')` includes `portfolio`, `MOBILE_PRIMARY_PREFERENCE` gives it a permanent
tab, and `LeftRail` renders every permitted item. `canSwitch` is read only by `TopBar` and
`ProjectSwitcher`, where it disables the switcher chip; it gates no screen.

The real constraint is therefore narrower and still binding: **taking Portfolio's tab for
`+` removes that user's only route to Portfolio**, because the switcher sheet they would
fall back to is the thing they cannot open.

### Options

**C1 — `+` without spending a slot.** Mount the existing `CreateMenu` in **`LeftRail`** on
desktop and as a **floating action** on mobile, leaving `splitMobileNav` untouched. Costs no
destination, changes no nav logic, and renders only when `createOptionsFor(role)` is
non-empty — so consultant and client, who create nothing, see nothing and keep their exact
bars.

**The desktop shell has to be `LeftRail`.** An earlier draft of this section said `TopBar`,
which would have delivered nothing on desktop: `TopBar.module.css:14-17` sets `display: none`
from 640px upward and `TopBar.tsx` names itself "mobile only (<640px)". A `+` mounted there is
invisible at **every** desktop width, so C1 would ship its mobile half only — on a brief that
asked for mobile *and* desktop. `LeftRail` is the shell that renders where `TopBar` does not
(§1.4), and it already renders every permitted nav item, so the control sits beside the
destinations it complements.

**C2 — `+` as a fifth tab.** Reaches the bar directly, but consultant and contractor gain a
More sheet they do not have today, for a button that is empty for a consultant.

**C3 — `+` replacing Portfolio.** Cheapest visually, blocked by the constraint above unless
the switcher sheet opens whenever its contents are reachable, or Portfolio keeps a second
route.

**Recommended: C1.** It is the only option that adds reach without taking any away, and it
needs no change to the navigation split — which keeps Unit C independent of Unit E rather
than entangled with it.

### The kind set, decided

`activity` does **not** join `CreateKind` in this unit, and neither do the other four
single-entry flows in §1.2. They are planning and administrative records whose owning screen
is their context, and adding any of them would change that modal's contract — a different unit
from mounting a component that already exists. C1 carries the three capture records the menu
already holds, which is what makes it a mount rather than a redesign.

This forecloses nothing. Adding a kind later is an additive entry in `OPTIONS`
(`createOptions.ts`) plus a `CaptureContext` on the modal, and the menu's existing
`createOptionsFor(role)` filter governs it for free. The trigger for doing so is evidence that
users try to start one of these records from elsewhere — not a preference stated here.

---

## 3 · Unit D — desktop search and add

### The gap

`DecisionLogScreen` proves the pattern is wanted and shows its ceiling: the filter is
in-screen and client-side, so finding a decision requires already being on the Decision Log.
There is no way to answer "where is that drawing" from anywhere else.

### What a global search would have to settle first

- **Scope.** Which record types are searchable, and by what — title, number, location,
  material name? Each is a different read.
- **Where the filtering happens.** The Decision Log filters an already-loaded list. A global
  search over drawings, materials and activities cannot assume everything is loaded, so it
  is a server read with its own load, error and empty states.
- **Permission.** Results must be filtered by the same `ROLE_POLICY` that governs the
  screens, or search becomes a way to see records a role's own screens would not show.

### Options

**D1 — search only what is loaded.** Extend the Decision Log's in-screen pattern to the
other list screens. Cheap, no new read, no permission surface; does not answer the
cross-screen question.

**D2 — a global read.** A real search endpoint with its own contract, permission filtering
and states. Answers the question, and is a materially larger unit than C or E.

**Recommended: D1 first, D2 as its own plan.** D2 is a server-contract change and does not
belong in the same review unit as a navigation affordance.

---

## 4 · Unit E — mobile navigation

### The measured position

Nothing here is broken. The split is deterministic, role-aware, fabricates nothing, and
already gives contractor and consultant a complete bar. The pressure is entirely on pmc (9
behind More) and engineer (7).

### Options

**E1 — leave it.** If Unit C lands as C1, the most common reason to cross the More sheet —
starting a record — is gone, and the remaining crossings are navigational rather than
capture-blocking. This is the option the audit's "not yet" points at.

**E2 — add `daily-log` to the preference list.** Measured, not reasoned. `splitMobileNav`
drops preferred keys the role does not have, and **no role holds both `daily-log` and
`portfolio`**: `screensFor('pmc')` carries `portfolio` and not `daily-log`,
`screensFor('engineer')` the reverse. Running the split over all five roles against today's
list, against `[inbox, site-schedule, places, daily-log, portfolio]` and against `[inbox,
daily-log, site-schedule, places, portfolio]` leaves **every role's bar identical to today**.
Only the engineer's *order* moves, and only in the third variant: `inbox · site-schedule ·
places · daily-log` becomes `inbox · daily-log · site-schedule · places`. The PMC bar is
`inbox · site-schedule · places · portfolio` in all three.

So E2 costs no slot and displaces nothing — an earlier draft said it "would displace
`portfolio` for a PMC", a conflict the algorithm cannot produce. Its entire effect is to make
the engineer's Daily Log tab **deliberate instead of a by-product of top-up**, which closes
exactly the fragility §1.3 names.

**E3 — a role-specific preference list.** Removes the coupling that makes one list serve
five roles, at the cost of the single rule that currently makes the split easy to reason
about.

**Recommended: E1 for what the bar contains, with E2 as a one-line hardening.** E1 is right
about composition — C1 removes the most common reason to cross the More sheet, and nothing in
§1.3 puts a destination in the wrong half. E2 is no longer a trade-off to weigh against it:
because it changes no role's bar, it is not a re-ordering on intuition but a pin on behaviour
that is already correct and currently accidental. It belongs in whichever unit next touches
`screensFor` or `MOBILE_PRIMARY_PREFERENCE` — the change it protects against — rather than
standing alone.

---

## 5 · What is outside this proposal

Not "awaiting a decision" — each is either settled above or is its own unit with its own
trigger.

- **A global search endpoint (D2, §3).** A server contract with its own permission surface
  and load states. It needs a plan before code, and that plan is not this document.
- **`splitMobileNav`, `MOBILE_PRIMARY_PREFERENCE` and `screensFor`.** Untouched by the
  recommended path, by design — that independence is the point of C1.
- **The two open units in `docs/STATUS.md`** — the daily-log gallery's scope and Quick
  Capture's `createMediaSchema` blocker. Neither is navigation.
- **Widening `CreateKind`.** Decided in §2: not in this unit, additive later, triggered by
  evidence rather than by preference.

## 6 · The next unit

**C1, as one review unit.** Two mounts of the existing `CreateMenu` — a control in `LeftRail`
for desktop and a floating action for mobile — plus tests proving that a create-less role
(consultant, client) sees no control at either width, and that each shell renders only at its
own width. It touches no navigation logic, no policy and no server contract, which is what
makes it reviewable alone and what keeps Unit E decidable later on evidence rather than as a
side effect of this one.

**E1 needs no unit** — it is current behaviour, and §4 is what makes leaving it alone a
decision rather than an omission. **E2 rides with the next change to `screensFor` or
`MOBILE_PRIMARY_PREFERENCE`**, being the pin that protects it. **D1 follows C1** as its own
unit; **D2 needs a plan first.**
