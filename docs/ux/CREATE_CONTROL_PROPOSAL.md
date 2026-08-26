# Unit C: a universal create control

A proposal, not a change. The brief asked for Units C (a universal `+`), D (desktop search
and add) and E (mobile navigation) to be **evaluated and proposed** before anything replaces
the current mobile navigation.

**This document covers Unit C only.** It replaces #443, which carried all three and reached
the review-round limit; D and E are deferred to their own unit, and §6 records what the next
document owes so nothing learned is lost. Narrowing is the point: both review rounds landed
on C's mount and C's pricing, and a smaller surface is what the replacement rule is for.

Everything in §1 is measured from the code at `main` `0818c96f` — by running the real
functions and grepping the real call sites, never by reading an algorithm. §§2–5 propose
against it, and are kept in separate sections on purpose.

---

## 1 · Measured: what exists today

### 1.1 The shared create menu already exists, with one mount

`components/CreateMenu.tsx` is built and working: one option list for both devices, filtered
by `createOptionsFor(role)` against the existing `ROLE_POLICY`, with `materialBlockedReason`
separating *may never* (option absent) from *not yet* (option shown with the reason).

It is mounted in **exactly one screen**: `PlacesScreen.tsx`. Its own doc comment anticipates
this unit — the device-specific shells "belong with the universal `+` entry point, not with
this list". **Unit C is a further mount of a shipped mechanism, not a new one.**

### 1.2 Where each record can be started

Every create modal in the application and where it is mounted, found by locating each
`*Modal` component and grepping for its call sites.

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
flows exist, each with exactly one entry point**, and none is in `CreateKind`.

**This table is not the whole capture surface**, and an earlier draft treated it as if it
were. It inventories flows that open a `*Modal`; §1.3 adds the record-level writers that open
no modal at all, and they change who counts as able to capture.

**The scoping decision, stated rather than left implicit.** `createOptions.ts` already draws
the line in its own doc comment — its options are worded as "things that happen on a building
site". That criterion separates the table cleanly:

- **Capture records.** Something happened and a site user records it as it happens —
  inspection, material delivery, decision. These are the three in `CreateKind`.
- **Planning and administrative records.** Authored deliberately, from the screen holding the
  thing being planned or administered: an activity and a phase against the programme on
  Schedule, a revision against the register on Drawings, a company against the roster on Team,
  a project outside any project's scope at all.

**A universal `+` covers the capture records, and this unit is scoped to those three.** A
user on Dashboard still cannot issue a drawing from the `+`, and that is a decision rather
than an oversight: a revision issued against the wrong register is precisely the mistake a
context-free entry point invites, and the register is the context.

### 1.3 Who can capture anything at all

Two different questions, which an earlier draft ran together. Both are read from `ROLE_POLICY`.

**(a) The three actions the menu offers.**

| Action | Roles |
|---|---|
| `decision.create` | pmc |
| `inspection.create` | pmc |
| `dailyLog.addMaterial` | engineer, pmc |

So `createOptionsFor(role)` is **non-empty for exactly two roles**: pmc (three options) and
engineer (one). Client, contractor and consultant get an empty list and, under the menu's own
rule, must see no control. **That is a statement about the menu, not about capture authority.**

**(b) Record-level capture writers that open no modal**, and so are absent from §1.2's table:

| Action | Roles | What it records |
|---|---|---|
| `attendance.record` | pmc, engineer, **contractor** | a worker mustered for a date and shift |
| `labour.work.record` | pmc, engineer, **contractor** | worked minutes against an active allocation |
| `activity.output.record` | pmc, engineer, **contractor** | measured output against an activity |

All three are site facts under this document's own criterion — something happened and someone
records it as it happens. **Contractor therefore holds capture authority**, and calling that
role "create-less" (as an earlier acceptance test did) was wrong.

**Why none of them joins `CreateKind` here**, stated per record rather than waved past:

- **Attendance and worked minutes need a context the `+` cannot supply**: a specific worker,
  a civil date and a shift, and for effort an *active allocation* to record against. They are
  entered from the Labour screen, beside the allocation they attach to.
- **Measured output needs an activity**, and is recorded against the activity it belongs to.
- A context-free `+` would have to ask for that context first, which is a picker flow, not a
  menu entry — a different unit from mounting a component that already exists.

**One measured gap this surfaces, which C1 does not close.** `screensFor('contractor')` is
`inbox · drawings · places · team-access · decision-log` — it contains neither `labour` nor
`site-schedule`, the surfaces those three writers live on. So a contractor holds three capture
permissions with **no UI route to any of them today**. That is a real finding, it predates
this unit, and it is recorded in §6 rather than fixed here: giving contractor a `+` would not
help, because the records still need their context.

### 1.4 The mobile bar for those two roles is already full

`MOBILE_PRIMARY_SLOTS` is 4 and `MOBILE_MAX_TABS` is 5: four destinations plus More, and
`splitMobileNav` only adds More when the role overflows. Computed by running
`splitMobileNav(screensFor(role))`:

| Role | Screens | Bottom bar | Behind **More** | Controls rendered |
|---|---|---|---|---|
| pmc | 13 | inbox · site-schedule · places · portfolio | **9** | 4 + More = **5** |
| engineer | 11 | inbox · site-schedule · places · daily-log | **7** | 4 + More = **5** |
| client | 6 | inbox · places · client-decisions · client-health | 2 | 4 + More = 5 |
| contractor | 5 | all five, no More | 0 | 5 |
| consultant | 5 | all five, no More | 0 | 5 |

**Both roles that can create are already at the five-control cap.** There is no free slot for
either of them — the fact §3 turns on.

### 1.5 The two shells, and what the project boundary covers

`TopBar` is **mobile-only**: `TopBar.module.css:14-17` hides it from 640px upward, and
`TopBar.tsx` names itself "mobile only (<640px)". `LeftRail` is its exact complement, hidden
at 639.98px and below (`LeftRail.module.css:11-15`). **A control that must exist on both
devices needs two mounts, one per shell.**

`AppShell.tsx:39-41` wraps **only `<ScreenView />`** in `ProjectLoadBoundary`. `LeftRail`,
`TopBar`, `BottomTabs`, `NotificationPanel` and `ModalHost` all render **outside** it, and
keep rendering while the boundary shows `switching`, `loading` or `error`.

That matters because of what `switchProject` (`store.ts:3366`) does. Before the auth request
goes out it bumps `projectScopeGeneration`, sets `projectLoadState = 'switching'`, sets
`pendingProjectId`, and empties every project-owned field — but it does **not** change
`activeProjectId`, and the existing `gateway` stays the live write scope until
`applyAuthResult` adopts the server's answer. On failure it deliberately keeps the old
authenticated identity and sets `projectLoadState = 'error'`.

So there is a real window, and a real error state, in which a shell-mounted control is
interactive while the stage says a different project is loading. `PlacesScreen`'s existing
mount is inside the boundary and has never been exposed to it; a shell mount would be.

---

## 2 · The gap

The menu exists; the reach does not. On desktop a PMC on Dashboard must navigate to Places or
to the owning screen before they can enter anything. On mobile the same PMC is behind a More
sheet for 9 of 13 screens, so a delivery recorded from Materials is More → Materials → button
— three taps before the form.

---

## 3 · Options

**C1 — `+` without spending a slot.** Mount the existing `CreateMenu` in `LeftRail` on desktop
and as a floating action on mobile, leaving `splitMobileNav` untouched. Costs no destination
and changes no navigation logic. It renders only when `createOptionsFor(role)` is non-empty,
so by §1.3 it appears for pmc and engineer alone and the other three roles keep their exact
bars.

**Every option below carries the same project-load obligation (§4)** — C1 is not special here.
All three mount outside `ProjectLoadBoundary`, so what separates them is only the slot cost.

**C2 — `+` as a fifth tab.** Priced against the roles that would actually see it, per §1.3 and
§1.4: pmc and engineer are already at 4 destinations plus More. A fifth destination therefore
either renders a **sixth control**, or drops the primary slots to three and **evicts
`portfolio` for a pmc and `daily-log` for an engineer** — the engineer's capture surface, and
the one route to Portfolio for a single-project pmc who cannot open the switcher sheet (§5).
Contractor and consultant, who fit their bars exactly, would gain nothing and lose nothing:
`createOptionsFor` is empty for them, so they get no tab either way — which is a fact about the
menu, not about their capture authority (§1.3(b)).

**C3 — `+` replacing Portfolio.** The same eviction as C2's second branch, chosen deliberately
rather than as a side effect. Blocked by the constraint in §5 unless the switcher sheet opens
whenever its contents are reachable, or Portfolio keeps a second route.

---

## 4 · Recommended: C1 — and the project-load requirement every option shares

C1 is the only option that adds reach without taking any away, and the only one that needs no
change to the navigation split — which keeps this unit independent of Unit E rather than
entangled with it.

### The project-load requirement — on every option, not just this one

An earlier draft called this "one obligation that C2 and C3 do not carry, because they mount
inside the tab bar's own logic". **That is false.** `AppShell.tsx` renders `<BottomTabs />`
after and outside `ProjectLoadBoundary`, exactly like `LeftRail`, and it stays interactive
through `switching`, `loading` and `error`. A `+` in the tab bar is in the same window as a `+`
in the rail. So the requirement below binds **C1, C2 and C3 alike**, and what actually
separates them is the slot cost in §3 — nothing else.

> **1. The trigger must be unavailable unless the project is ready.** A `projectLoadState` of
> `switching`, `loading` or `error` hides it. Hiding beats disabling: the boundary's own idiom
> is to replace content rather than grey it out, and a disabled `+` beside a "Loading …" stage
> invites a second click.
>
> **2. An already-open create flow must close, or stop being submittable, the moment project
> scope leaves `ready`.** Gating the trigger alone does not make the §1.5 write unreachable. A
> user can open the menu — or a create modal — while ready, then press Back or Forward to
> another project's URL; `RouteBridge.tsx:54` starts `switchProject` from that navigation. A
> shell-mounted modal is outside `ProjectLoadBoundary` and so is not unmounted, and **no create
> modal reads `projectLoadState` today** (nor does `CreateMenu`). Until `applyAuthResult`
> lands, `activeProjectId` and the gateway still address the old project, so submitting that
> already-open form files the record against the project being left.

Requirement 2 is the one that actually closes the hole; requirement 1 only narrows how often it
can be opened. A screen-owned mount like `PlacesScreen`'s is unmounted by the boundary and gets
both for free — which is precisely why moving the menu into the shell creates an obligation the
existing mount never had.

---

## 5 · A constraint this unit must not break

The audit's §7 priced a `+` in the mobile bar and found it "not free yet". One restatement of
it has since been corrected, and the correct form matters for C2/C3: the audit says a
single-project pmc who administers no org **cannot open the switcher sheet** — which carries
an *All projects (Portfolio)* row. It does **not** say Portfolio is unreachable.
`screensFor('pmc')` includes `portfolio`, `MOBILE_PRIMARY_PREFERENCE` gives it a permanent
tab, and `LeftRail` renders every permitted item; `canSwitch` is read only by `TopBar` and
`ProjectSwitcher`, where it disables the switcher chip, and it gates no screen.

The surviving constraint is narrower and still binding: **taking Portfolio's tab for `+`
removes that user's only route to Portfolio**, because the sheet they would fall back on is
the thing they cannot open. C1 does not take it; C2's second branch and C3 do.

---

## 6 · The next unit, and what is deferred

**C1 is one review unit.** Two mounts of the existing `CreateMenu` — a control in `LeftRail`
for desktop, a floating action for mobile — plus both project-load requirements in §4. It
touches no navigation logic, no policy and no server contract. Its acceptance tests:

1. A role whose `createOptionsFor` is empty (client, contractor, consultant) sees no control at
   either width. Stated as the menu's own rule, **not** as "a create-less role": §1.3(b) shows
   contractor holds three capture permissions, and this control is simply not their route to
   them.
2. Each shell renders only at its own width — the desktop mount is absent below 640px, the
   mobile mount absent at and above it.
3. **The trigger is unavailable while `projectLoadState` is `switching` or `loading`.**
4. **The trigger is unavailable while `projectLoadState` is `error`**, when the old identity is
   still held.
5. **An open flow does not survive the transition.** Open the menu while `ready`, drive a
   project change through the URL (the `RouteBridge` path, i.e. Back/Forward — not a click on
   the switcher), and assert the menu is gone.
6. **An open modal cannot write across the transition.** Open a create modal while `ready`,
   drive the same URL-borne project change, and assert the form is closed or its submit is
   refused — with a companion assertion that **no command reached the old project's gateway**.
   This is the test that actually covers §1.5; 3 and 4 only narrow the entry.

**Units D and E are deferred to their own proposal**, which owes two corrections found here and
must not repeat either.

**(i) The authorization source.** An earlier draft claimed a global search (D2) would filter
results by "the same `ROLE_POLICY` that governs the screens". **Both halves are false.** Screen
visibility comes from `screensFor` plus module and capability filtering, not from `ROLE_POLICY`;
and the reads such a search would perform are role-invariant —
`activities.controller.ts:22` and `drawings.controller.ts:25` both use
`@RolesFor('project.read')`, which `policy.ts:198` grants to **all five roles**. A client holds
`project.read` but has no Schedule screen, so a search filtered that way would surface
activities the client's own navigation excludes.

**(ii) Kind visibility and tenancy are still not enough.** Each module query also shapes its
result **per caller**, inside a kind the caller may legitimately see:
`ActivitiesController.read` passes `user.role === 'pmc'` so that only a pmc receives the honest
withdrawn-decision gate reason; `DrawingsController.read` passes `user.sub`, and `bakeDrawings`
filters `!d.draft || d.authorId === userId` — *"an unpublished drawing is author-private — only
in its creator's register"* — as well as computing that viewer's `ackedByMe` and
`recipientOfCurrent`. A D2 search that enforced only permitted result kinds plus project
tenancy would therefore leak pmc-only fields, or another pmc's unpublished draft, to a caller
whose own screens would never show them.

So D2 must (a) derive permitted result kinds from the real role/module/capability visibility
rules, (b) enforce project tenancy server-side, **and (c) return results through each module's
own caller-shaped bake rather than reading around it.**

**One gap recorded, not fixed here.** §1.3(b) measures that contractor holds
`attendance.record`, `labour.work.record` and `activity.output.record` while
`screensFor('contractor')` contains neither `labour` nor `site-schedule` — three capture
permissions with no UI route. C1 does not close it (those records need a context a `+` cannot
supply), and neither does D or E. It belongs to whichever unit next takes up contractor's
surfaces.
