# Units D & E: desktop search, and the mobile navigation

A proposal, not a change. The brief asked for Unit D (desktop search and add) and Unit E
(mobile navigation) to be **evaluated and proposed** before anything replaces the current
mobile navigation. This is that evaluation, owed since #444 narrowed the original three-unit
document to Unit C alone.

Everything in §1 is measured from the code at `main` `a839f328`; §§2–4 propose against it,
and the two are kept apart on purpose. It carries forward, verbatim, the two corrections the
Unit-C reviews established for D2 (§3), so neither is re-earned.

---

## 1 · Measured: what exists today

### 1.1 Half of Unit D is already delivered

The brief's Unit D was "desktop search **and add**". The *add* half shipped with Unit C1
(#446): `CreateRailButton` in `LeftRail` opens the shared `CreateMenu` from every desktop
screen, gated on `createOptionsFor(role)` and `projectDataUsable`. **What remains of Unit D
is search.**

### 1.2 One search input exists, and its mechanics are the pattern

`DecisionLogScreen.tsx:121` carries the application's only search input. Measured from its
implementation, not its label:

- **Client-side, over the screen's own already-loaded rows** — a `useMemo` filter, no read.
- **A composed haystack**: `[title, room, id, material, ...locationSegments].join(' ')`,
  case-insensitive substring. The location path is *derived* from the canonical node tree at
  filter time, so a record found "by place" is found through the same `pathOf` every other
  surface uses.
- **Composes with the screen's other controls** (status chips, group-by) rather than
  replacing them, and an empty result states itself: *"No decisions match your filters."*

There is no global search, and after C1 the shells carry navigation, notifications, the
project switcher and the create control — no search affordance.

### 1.3 Which screens have lists that earn the pattern

Screens rendering long, scanned-not-browsed lists, and what they offer today:

| Screen | List | Filter today |
|---|---|---|
| Decision Log | decisions, grouped | **the one input** + status chips + group-by |
| Drawings | the register, grouped by discipline | none |
| Schedule | activities by phase | none |
| Materials hub | seven tabbed panels | tabs only |
| Team / Team Access | rosters | none |

The Drawings register is the standout: it is a read-mostly reference surface every role
holds (`screensFor` includes `drawings` for all five), it is scanned by identity — number,
title, location — rather than browsed, and "where is that drawing" is the exact question the
audit's Unit-D framing asked. It is NOT append-only: `DrawingsController.remove` is a
pmc-authorized delete that removes the drawing row with its revisions, so no rationale here
rests on accumulation — the case is who holds the screen and how it is used, which survive
deletions.

### 1.4 The mobile split, measured from the list the bar actually renders

`BottomTabs` does not split `screensFor(role)`. It splits `useNavItems()`, which is
`enabledScreensFor(role, enabledModules, capabilities)` — the role list filtered by the
project's enabled modules and its `materials`/`labour`/`commercial` capabilities. An earlier
draft tabled the unfiltered role maxima as the truth; the corrected measurement EXECUTES the
real pipeline over representative configurations:

| Config | pmc bar | pmc More | engineer bar | engineer More |
|---|---|---|---|---|
| no capabilities (typical non-pilot) | inbox · site-schedule · places · portfolio | **6** | inbox · site-schedule · places · daily-log | **4** |
| materials only | same | 7 | same | 5 |
| all three pilots | same | 9 | same | 7 |

Client (6/2), contractor and consultant (5/0, no More sheet) are invariant across all three.
**The decisive fact: every role's BAR is identical in every configuration** — capabilities
only change how much sits behind More, and a typical non-pilot project carries a third less
of it than the maxima suggested. `daily-log` still reaches the engineer's bar by top-up
rather than preference, and the exposure is the role's screen order (§4 of the Unit-C
proposal measured that adding `daily-log` to `MOBILE_PRIMARY_PREFERENCE` changes no role's
bar).

What C1 changed is the *cost* of that split: the most common reason to cross the More sheet
— starting a record — no longer requires it. The floating `+` reaches capture from any
screen. The remaining crossings are navigational (opening Drawings, Materials, Team from a
pmc phone), which are reads, not the capture path this initiative exists to shorten.

---

## 2 · Unit D, part 1 — in-screen search where the list earns it (D1)

**Recommended, and the next unit: clone the Decision Log's filter onto the Drawings
register.** One screen, one shipped pattern, no new read, no permission surface — the rows
are already on the client under the screen's existing load states.

The haystack follows the same composition rule, and every term is **the RENDERED text, not
the stored value**: the drawing number, the title, the discipline as the register labels it
(`other` renders as *"Sketches & References"* — a stored-key haystack would make searching
for the visible group name return nothing), the revision as displayed (*"Rev B"*, not the
bare value), and **the location the row itself shows** — the *derived* path of any
placement, and, when a drawing has no placement, its legacy `zone` fallback. That is the
Decision Log's own shape, not an addition to it: `locationSegments` falls back to the stored
`room` when `pathOf` yields nothing, and `DrawingsScreen` renders exactly the same way
(`pathOf(nodes, d.nodeId)` when non-empty, else `d.zone`). A search that cannot find a
drawing by the location printed on its card is broken by its own rule — what the user can
see, the filter must match.

One interaction needs deciding up front rather than discovering in review: the consultant's
**discipline scope**. `scopeKey` is set for a consultant (`role === 'consultant'`, defaulted
`scoped`), and the screen's scoped-empty branch reads
`scopeKey && scoped && groups.length === 0 && drawings.length > 0` — *"No {discipline}
drawings filed yet"*. A filter applied before grouping can empty the scoped group while
drawings for that discipline exist, and that branch would then assert something false. The
implementation must **update the scoped-empty predicate** to be filter-aware, not add a
second message beside a now-lying one.

Acceptance tests for that unit:
1. Filtering narrows the register and composes with the discipline grouping.
2. A drawing is found by its number, its title, AND its placement's derived location path.
3. **A placement-less drawing is found by its legacy `zone`** — the location its own card
   displays.
4. The empty state names the filter, not an empty register.
5. **Search composed with the consultant's discipline scope shows exactly the
   filter-specific empty state** — the existing scoped-empty branch must not claim "No
   {discipline} drawings filed yet" when the search merely hid them.
6. The input renders under the screen's existing `unavailable`/`stale` guards — a filter
   over rows that failed to load is not offered.
7. **A drawing is found by its displayed discipline label** — searching *"Sketches"* finds an
   `other`-discipline drawing.
8. **A drawing is found by its displayed revision** — searching *"Rev B"* finds the row whose
   card prints it.

Schedule and the rosters wait for evidence: their lists are shorter, phase- and role-scoped,
and no audit row records a finding-something failure on them. Extending a shipped pattern
later is cheap; speculative inputs are clutter.

## 3 · Unit D, part 2 — a global search (D2) is specified, not built

D2 answers "where is that drawing *from anywhere*". It is a server contract, and the two
corrections from the Unit-C reviews are its constraints, carried verbatim so they are not
re-earned:

1. **The authorization source is NOT `ROLE_POLICY`.** Screen visibility comes from
   `screensFor` plus module and capability filtering, and the reads a search would perform
   are role-invariant — `activities.controller.ts` and `drawings.controller.ts` both use
   `@RolesFor('project.read')`, granted to all five roles. A D2 that filtered result kinds
   by `ROLE_POLICY` would surface activities to a client whose own navigation excludes the
   Schedule. Permitted result kinds must derive from the real role/module/capability
   visibility rules, with project tenancy enforced server-side.
2. **Kind visibility and tenancy are still not enough.** Each module query shapes results
   PER CALLER inside a kind: `ActivitiesController.read` passes `user.role === 'pmc'` (only
   a pmc sees the withdrawn-decision gate reason), and `DrawingsController.read` passes
   `user.sub` while `bakeDrawings` filters `!d.draft || d.authorId === userId` — an
   unpublished drawing is author-private. **D2 must return results through each module's own
   caller-shaped bake, never by reading around it.**
3. **The bake is necessary but its output is not yet routable.** `bakeDrawings` deliberately
   RETAINS the caller's own unpublished drafts, while `DrawingsScreen` renders only
   `!d.draft` — drafts live exclusively on `DraftsScreen`. A D2 that returned every baked
   drawing as a Drawings-kind match would surface a result whose destination register cannot
   render it: a dead link to the caller's own record. The contract must classify an
   authorized draft match as a **Drafts** result (routing to the surface that renders it),
   or exclude drafts after the bake — never emit a kind whose screen will drop the row.

**Decision: D2 is not built now, and that is a decision rather than a deferral to a person.**
Its trigger is evidence that D1's in-screen filters leave the cross-screen question unmet —
the same evidence-not-preference rule the Unit-C document set for widening `CreateKind`.
When triggered, D2 starts as its own plan (a server contract with load/error/empty states),
not as a screen unit.

## 4 · Unit E — the mobile navigation stands

**E1 — leave the composition — remains the recommendation, and C1 strengthened it.** Nothing
in the split is broken: it is deterministic, role-aware, fabricates nothing, and the two
roles under More-pressure (pmc, engineer) now reach capture without crossing the sheet. No
usage evidence says the remaining navigational crossings hurt.

**E2 — adding `daily-log` to `MOBILE_PRIMARY_PREFERENCE` — stays a free hardening that rides
with the next change to `screensFor` or `MOBILE_PRIMARY_PREFERENCE`.** Measured in the
Unit-C round: no role holds both `daily-log` and `portfolio`, so the pin changes no role's
bar; its entire effect is making the engineer's Daily Log tab deliberate rather than a
by-product of top-up. It protects against exactly the change it rides with, so it belongs
there and not in a standalone unit.

**E3 — a role-specific preference list — is not taken.** It removes the coupling that makes
one list serve five roles, at the cost of the single rule that makes the split easy to
reason about, and nothing measured here needs it.

---

## 5 · What is outside this proposal

- **The contractor capture gap** — `attendance.record`, `labour.work.record` and
  `activity.output.record` are granted to contractor while `screensFor('contractor')`
  carries neither `labour` nor `site-schedule`. That is a *screen-set* question, not a
  search or nav-split question; it has its own evaluation.
- **Any change to `splitMobileNav`, `MOBILE_PRIMARY_PREFERENCE` or `screensFor`** — all
  untouched by the recommended path.
- **D2's implementation** — specified in §3, triggered by evidence.

## 6 · The next unit

**D1-Drawings, as one review unit**: the Decision Log's filter pattern cloned onto the
Drawings register — an input, the haystack matching what each card displays (derived path,
else legacy `zone`, always as rendered), the filter-aware scoped-empty predicate, and the
eight acceptance tests in §2. It touches no navigation logic, no policy, no server contract, and no other screen.
E needs no unit; E2 rides with the change it guards against; D2 waits on its trigger.
