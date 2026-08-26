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

| Record | Entry points today | `CreateKind`? |
|---|---|---|
| Inspection | Places, Inspection Review | yes |
| Material delivery | Places, Daily Log | yes |
| Decision | Places, Decision Log | yes |
| Activity | Schedule only | **no** |

Every kind in the menu has its owning screen plus Places. Activity is the exception on both
counts: one entry point, and absent from `CreateKind` entirely. The audit records separately
that `PlanActivityModal` takes no `CaptureContext`, so it is the one create flow that
inherits nothing.

From any other screen — Dashboard, Drawings, Materials, Labour, Commercial, Team, Portfolio,
Inbox, Drafts — there is no create affordance at all.

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
  absent for that role and the loop fills from role order. Any change to the preference list
  or to the engineer's screen order can silently displace the surface where every engineer
  capture happens.
- **Contractor and consultant fit exactly.** Five screens, five slots, no More sheet. Adding
  a permanent sixth destination for them creates a More sheet that does not exist today.

### 1.4 Search exists on one screen

One search input in the whole application: `DecisionLogScreen.tsx:121`, a client-side filter
over that screen's own list, labelled *Search decisions…*. There is no global search, and
`TopBar` carries only the brand, the project switcher, notifications and sign-out.

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

**C1 — `+` without spending a slot.** Mount the existing `CreateMenu` in `TopBar` on desktop
and as a floating action on mobile, leaving `splitMobileNav` untouched. Costs no
destination, changes no nav logic, and renders only when `createOptionsFor(role)` is
non-empty — so consultant and client, who create nothing, see nothing and keep their exact
bars.

**C2 — `+` as a fifth tab.** Reaches the bar directly, but consultant and contractor gain a
More sheet they do not have today, for a button that is empty for a consultant.

**C3 — `+` replacing Portfolio.** Cheapest visually, blocked by the constraint above unless
the switcher sheet opens whenever its contents are reachable, or Portfolio keeps a second
route.

**Recommended: C1.** It is the only option that adds reach without taking any away, and it
needs no change to the navigation split — which keeps Unit C independent of Unit E rather
than entangled with it.

### Open question for the owner

Should `activity` join `CreateKind`? It is the one record with a single entry point and no
inherited context. Adding it widens the menu and the modal's contract; leaving it out means
the universal `+` is universal for three of four record types. This proposal does not decide
it.

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

**E2 — re-order the preference list.** Adding `daily-log` to `MOBILE_PRIMARY_PREFERENCE`
would make the engineer's most-used surface deliberate rather than incidental (§1.3). It
costs a slot for roles that have both, and would displace `portfolio` for a PMC — the
constraint in §2 applies again.

**E3 — a role-specific preference list.** Removes the coupling that makes one list serve
five roles, at the cost of the single rule that currently makes the split easy to reason
about.

**Recommended: E1 for now, and E2 only with a measurement.** "Daily Log is the engineer's
home" is stated in the audit and matches the code, but no usage evidence is available here,
and re-ordering on intuition is how the false premise this proposal corrects got written in
the first place.

---

## 5 · What this proposal does not decide

- Whether `activity` becomes a `CreateKind` (§2).
- Whether a global search endpoint is worth its contract (§3).
- Any change to `splitMobileNav`, `MOBILE_PRIMARY_PREFERENCE` or `screensFor` — all three are
  untouched by the recommended path.
- The two other open units recorded in `docs/STATUS.md`: the daily-log gallery's scope, and
  Quick Capture's `createMediaSchema` blocker. Neither is navigation.

## 6 · If the recommendation is taken

C1 is one review unit: two mounts of an existing component, its two device shells, and the
tests that prove a create-less role sees no button. It touches no navigation logic, no
policy and no server contract — which is what makes it reviewable on its own, and what keeps
Unit E free to be decided on evidence later rather than as a side effect.
