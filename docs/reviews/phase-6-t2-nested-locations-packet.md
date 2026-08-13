# Phase 6 task 2 — nested locations: review packet

**Unit:** the structural half of the space-model decision (PR #331's cleared plan,
`docs/superpowers/plans/2026-08-12-nested-locations.md`) — the middle level stops being
mandatory. A room nests under a zone or another room to **5 levels**; an element is a
**leaf** under a room or directly under a zone. **No rename**: the kind is still called
`room` everywhere, no new comparison against the literal kind was written, and every
user-facing label stays Zone/Room/Object (the vocabulary belongs to the deferred rename
plan, task-tracked separately).

**Base:** `main` `16f5faa`. No schema change, no migration, no new route — the diff is
the node service, the initialization validator (both directions), the selection
contract's room target, and the three §C reader surfaces.

## Vision alignment

One project is one site, and the location spine is how every module files onto it. The
fixed 3-level tree forced pseudo-containers (`site` zone › `Excavation` "room") because
site-level work had nowhere else to go; this unit removes the *necessity* of those
containers (the rename later removes their *misnaming*). Locations stay project-owned,
tree invariants become properties PostgreSQL-adjacent code re-derives under one
serialization, and no operational record changes meaning.

## The staged RED baseline (per the plan's §D note)

At the base commit the nested fixtures die at `requireParentForKind` before any race can
reach the unserialized guards — a red there proves the fixture illegal, not the defect.
So the branch stages deliberately:

- **`399b751` — stage 1** legalizes the nested edges ONLY (the parent-kind rule), with
  serialization, depth logic, visibility rule and scoping still absent. **The probes'
  honest baseline: 12 of 15 §A probes SEEN RED there**, each for its named §A defect —
  P1 both orderings (*both moves committed and the tree loops*, real cycle, both `ok`),
  P2/P14 both orderings (*deepest level 6*), P17 both orderings (*a published node sits
  beneath a draft ancestor*), P3/P10/P15 (*expected the write to be REFUSED, and it was
  accepted*), P6 (*the first tree read's args carry no `where` clause*). P7/P8 and the
  element-leaf refusal were green already — the legalized edges work at the endpoint.
- **stage 2** adds the per-project tree advisory lock (`lockProjectTree`, first
  in-transaction statement of create/move/publish), the in-tx re-derivation of every
  invariant over ONE project-scoped tree load, the destination-depth + subtree-height
  cap, the move/publish visibility rule, and the scoped reads → **15/15 GREEN, three
  consecutive runs**.
- **stage 3** (module path probes red at the stage-2 head, captured by running them
  against it: the old `anchors to a room — can't be placed/join` refusals and the fixed
  parent map's `invalid parent kind`) opens the second write path → **10/10 GREEN**.
- **stage 4** (12 web reader probes red against the old surfaces) ships the three §C
  readers → **23/23 GREEN**.

## Probe ledger (the plan's §D, all EIGHTEEN)

| probe | proves | evidence |
|---|---|---|
| P1 ×2 orderings | move∥move cycle pair: exactly one commits, no cycle | RED at `399b751` (cycle committed, both ok) → GREEN under the deterministic held-lock harness |
| P2 ×2 | create∥move never exceeds 5 levels | RED (level 6) → GREEN |
| P3 | plain move counts the SUBTREE height; refusal states the level | RED (accepted) → GREEN, message `level 6` |
| P4 ×2 doors | init graft over 5 levels refused — statically AND at the ACTUAL graft depth | RED at stage-2 head → GREEN (`level 6 — nest to 5 levels`) |
| P5 | init refuses an illegal parent chain (element under element) | RED (old message) → GREEN (validator kind rule) |
| P6 | tree reads are project-scoped | RED (no `where`) → GREEN (`where.projectId` pinned via recording stub) |
| P7 | element directly under a zone accepted | GREEN from stage 1 |
| P8 | room under room accepted | GREEN from stage 1 |
| P9 | the Locations dialog BUILDS both new shapes (add-child on zone AND room rows; none on an element; none at the cap) | RED → GREEN (`nested-locations.test.tsx`) |
| P10 | plain create at level 5 refused with the depth stated | RED (accepted) → GREEN |
| P11 ×3 doors | element-root module under a zone AND under a room THROUGH the public selector; no-target refused | RED (`can't be placed`) → GREEN |
| P12 ×3 doors | kind-true register grouping, presence AND absence | RED (positional pins) → GREEN |
| P13 ×4 doors | picker: nested room reachable/selectable, zone-level element selectable, BOTH kinds creatable inline, no sixth level | RED → GREEN |
| P14 ×2 | move∥move depth race | RED (level 6) → GREEN |
| P15 | published subtree under a draft zone refused | RED (accepted) → GREEN |
| P16 | nested-room module instantiates through init | RED (`invalid parent kind`) → GREEN |
| P17 ×2 | publish∥move leaves no published node beneath a draft ancestor | RED (orphan produced) → GREEN (move-first: the draft ancestor is published with the branch; publish-first: the move refuses) |
| P18 ×2 doors | the room-targeted module SAVED as a preset and EXPANDED; a target-less item refused at save | RED (`can't join a preset`) → GREEN |

Concurrency determinism: every race rides a held raw-session transaction that takes the
tree advisory lock AND (where useful) FOR UPDATE on the first operation's target row; at
the red baseline the advisory lock is uncontested and the row lock forces the exact
interleaving; after the fix the service's first in-transaction statement blocks on the
advisory lock and the operations serialize in dispatch order — both orderings, no fixed
sleeps (condition-based blocked-or-settled polling), no probabilistic loops.

## The serialization design (§A)

`lockProjectTree` (`apps/api/src/common/tree-lock.ts`) is a per-project
`pg_advisory_xact_lock`, deliberately NOT `lockProjectReadiness`: the location tree
gates no activity start, and a node write takes ONLY this lock (no cross-lock ordering
exists). It is the first statement of every tree-writing transaction; every invariant —
cycle, depth (destination + subtree height), visibility ("a node may not be more visible
than its parent", now on create AND move AND publish's recomputed branch) — is re-derived
inside it over one project-scoped load walked by the pure, cycle-safe helpers in
`apps/api/src/nodes/tree-rules.ts`. The exported `treeLockKey` keeps probe and service on
the same key (one derivation, every caller).

## The second write path (§A.3)

`validateInitializationGraph` enforces the SAME rule set-valued (room under zone|room,
element a LEAF under room|zone, zone top-only) plus static depth bounds (chain + graft
offset minimum, message `level N — nest to 5 levels`); `writeInitializationSource`
re-derives depth at the ACTUAL graft point per created node. The public selection
contract gains `underRoom` (a room the copied source or an earlier selection creates —
resolved first-name-wins, an unknown room refused with the reason stated, never a
silently minted container) beside `underZone` for the element-under-zone edge; exactly
one target is required for a room-anchored module, `underRoom` on a zone-anchored module
is refused rather than ignored, and `createTemplate` applies the SAME rule so a preset
saves usable or refuses at save time.

## The readers (§C)

Dialog: add-child on every zone/room row (`+ Room` / `+ Object`, hidden at the cap,
absent on element rows); the structure copy now states the rule without renaming
anything. Picker: a selection path replaces the fixed zone/room state — one level per
depth, children of the level above, inline create of a room or an object per level, an
element is a leaf, no sixth level offered. Register: the room group is the DEEPEST room
on the filed trail; object groups form only for element-FILED decisions; absence is
honest (`No room` / `No object`); free-text legacy decisions keep their stored room name.

## Gates

- `pnpm check` EXIT 0 (web 748/748, API unit 788/788 — `nodes.service.test` and
  `project-initialization.test` reworked to the rule, red-first where behavior changed).
- Focused integration: `phase6-t2-nested-locations.test.ts` 15/15 (three consecutive
  runs), `phase6-t2-modules.test.ts` 10/10.
- FULL integration battery on a freshly recreated, fully migrated database: recorded in
  the PR body (run at the head).
- No migration (upgrade-proof not applicable: zero schema bytes changed); no route
  added; no event added; no tripwire count moves.

## What this unit deliberately does NOT do

No `room` → `space` rename (contracts, schema, UI copy, locales all untouched); no
`DailyLog` location (a daily log is a whole-site record — §B); no room-target for
zone-anchored modules (no probe demands it); no reordering/drag UI. The rename starts
from `docs/reviews/pr-330-convergence.md`'s comparison-site catalogue when the owner
schedules it.
