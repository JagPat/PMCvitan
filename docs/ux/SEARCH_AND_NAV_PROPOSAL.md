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
holds (`screensFor` includes `drawings` for all five), it grows monotonically (revisions
supersede but entries accumulate), and "where is that drawing" is the exact question the
audit's Unit-D framing asked.

### 1.4 The mobile split is unchanged, and C1 changed what it costs

`splitMobileNav(screensFor(role))` still yields: pmc 13 screens / 9 behind More; engineer
11 / 7; client 6 / 2; contractor and consultant 5 / 0 (no More sheet). `daily-log` still
reaches the engineer's bar by top-up rather than preference, and the exposure is the role's
screen order (§4 of the Unit-C proposal measured that adding `daily-log` to
`MOBILE_PRIMARY_PREFERENCE` changes no role's bar).

What C1 changed is the *cost* of that split: the most common reason to cross the More sheet
— starting a record — no longer requires it. The floating `+` reaches capture from any
screen. The remaining crossings are navigational (opening Drawings, Materials, Team from a
pmc phone), which are reads, not the capture path this initiative exists to shorten.

---

## 2 · Unit D, part 1 — in-screen search where the list earns it (D1)

**Recommended, and the next unit: clone the Decision Log's filter onto the Drawings
register.** One screen, one shipped pattern, no new read, no permission surface — the rows
are already on the client under the screen's existing load states.

The haystack follows the same composition rule: drawing number, title, discipline, current
revision label, and the *derived* location path of any placement. Derived, not stored — the
same `pathOf` discipline `locationSegments` uses, so search never introduces a second copy
of a location.

Acceptance tests for that unit:
1. Filtering narrows the register and composes with the discipline grouping.
2. A drawing is found by its number, its title, AND its placement's location path.
3. The empty state names the filter, not an empty register.
4. The input renders under the screen's existing `unavailable`/`stale` guards — a filter
   over rows that failed to load is not offered.

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
Drawings register — an input, the composed derived-path haystack, the four acceptance tests
in §2. It touches no navigation logic, no policy, no server contract, and no other screen.
E needs no unit; E2 rides with the change it guards against; D2 waits on its trigger.
