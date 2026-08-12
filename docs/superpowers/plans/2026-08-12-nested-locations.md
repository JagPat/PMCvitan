# Nested locations — the middle level stops being mandatory

**Status: PLAN. Structure only. The `room` → `space` rename is deliberately NOT in this unit** — see
"What this plan is not" below, and `docs/reviews/pr-330-convergence.md` for why it was separated.

## The problem, in one screenshot

The Locations dialog says *"Zones contain rooms; rooms contain objects"*, and a live project reads:

```
ZONE  site
ROOM  Excavation
```

Two distinct problems hide behind that one screenshot:

1. **Structure.** The middle level is effectively mandatory. `site` became a zone *and* `Excavation`
   a pseudo-room, because site-level work had nowhere else to go. A partial zone — a wing, a pour
   segment, half a slab — has nowhere to live except as more pseudo-rooms.
2. **Vocabulary.** "Room" is the wrong word for most of what gets filed.

**This plan fixes (1) only.** Fixing the structure is what stops the pseudo-containers from being
*necessary*; the rename is what stops them from being *misnamed*. They are separable, and separating
them is deliberate.

## The decision

**A location may nest, and the middle level becomes optional.**

```
Ground Floor (zone)
 └ East Wing
    └ Slab Pour 2
       └ Column C4 (element)

site (zone)
 ├ Site Gate (element)        ← an element may hang straight off a zone
 └ [excavation activities filed directly on the zone — no invented container]
```

| kind | may hang under |
|---|---|
| `zone` | nothing — top level only |
| `room` | a `zone`, or another `room`, to **5 levels** |
| `element` | a `room`, **or a `zone` directly** |

`element` remains a **leaf**. Objects do not contain objects; nothing in the product asks for that,
and admitting it would make every reader recursive for no gain.

**Why 5.** It reaches a tower with wings and pour segments (`Tower > Floor > Wing > Zone > Pour`) and
still fits on a phone, which is where the Site Map is actually read. The limit is a refusal with a
stated reason, never a silent truncation.

## What this plan is NOT

**No `room` → `space` rename.** Not in the contracts, not in the schema, not in the UI copy, not in
the locales. The kind is still called `room` after this lands, and the dialog still says so.

That is not an oversight. The rename was planned as one unit with this structural work, and five
review rounds produced twenty findings — **seventeen of them in the rename**, none of them wrong:
template payloads in JSON that a `.parse()` throws on, four separate code sites that compare against
the literal kind (one of which *silently stops guarding* when the value changes), two independently
deployed applications with no ordering guarantee, browser tabs that outlive any deploy, seed
constants that reinsert the old value after a migration, and a picker that discovers the created node
by matching the kind it sent.

None of that touches the tree rules. Bundling them meant the structural fix — which is small,
self-contained, and fixes real bugs — could not land until the changeover was fully solved.

**The rename gets its own plan**, and it starts from what those rounds established rather than
rediscovering it. What this plan does NOT do is make the rename harder: nothing here writes a new
comparison against the literal kind.

The boundary, stated precisely so it survives review: **structure is in, vocabulary is out.** The
picker learning to render nested rooms and zone-level elements is structure and ships here; the
picker's labels saying "Room" and "Object" are vocabulary and do not change. The same line runs
through the dialog, the register grouping, and the module-placement code.

## §A — The tree rule replaces the tree map

Today (`apps/api/src/nodes/nodes.service.ts`):

```ts
/** The location tree is exactly 3 levels */
const PARENT_KIND: Record<string, 'zone' | 'room' | null> = {
  zone: null,
  room: 'zone',
  element: 'room',
};
```

A fixed-depth lookup becomes a rule. Three things that are safe *because* the depth is fixed stop
being safe the moment it is not, and each is a real defect rather than a hypothetical.

### 1. The cycle guard does not hold, and cannot

`move` runs the descendant check at `nodes.service.ts:108` and the write at `:111` — the check is
**outside** the transaction:

```ts
if (await this.isDescendant(parent.id, nodeId)) throw new BadRequestException(…);  // read
…
const ev = await this.prisma.$transaction(async (tx) => {                          // write
  await tx.projectNode.update({ where: { id: nodeId }, data: { parentId: … } });
```

Two concurrent moves — `A under B` and `B under A` — each read the old tree, each pass, and both
commit. Every recursive reader then loops or overflows. Today this is unreachable for a room, whose
only legal parent was a zone. **Nesting makes it reachable by two ordinary users.**

The check moves inside the write transaction, serialized against concurrent reparents of the same
tree. The project's node set is the honest lock granularity, since ancestry can span it.

### 2. The depth cap must count the subtree, and the create path

A cap on the moved node's own depth does not deliver a 5-level guarantee:

```
move (A > B > C)  under  (P1 > P2 > P3)
        ↑ moved root lands at level 4 — legal
                                 → B at 5, C at 6 — over the cap, silently
```

So the rule is **destination depth + the moved subtree's height**, on every reparent.

**And `create` must be serialized with reparents of its ancestry**, which the first draft of this
rule missed. If T1 creates a child under `P` while `P` sits at depth 4, and T2 concurrently moves `P`
under another depth-4 destination, each check passes in its own snapshot and the commits leave `P` at
5 and the new child at 6. The cap is a property of the tree, so every write that can change a node's
depth — create and move alike — takes the same serialization.

**The plain case comes before the race, and it gets its own probe.** Today's `create` path has NO
depth logic at all — none was needed at fixed depth — so a single ordinary request appending a child
under a node already at level 5 would simply succeed. Serializing the race without adding the plain
check would be exactly the kind of half-fix a green concurrency probe hides, so §D adjudicates them
separately: the plain refusal first (P10), the race second (P2).

### 3. A second write path enforces none of it

`NodesService` is not the only thing that creates a `ProjectNode`. Project copy and module
instantiation go through `OrgsService.writeInitializationSource` (`orgs.service.ts:862,876`), which
calls `NodeInitParticipant.createForInit` and writes `kind` **straight through** — no parent-kind
check, no depth check, because `requireParentForKind` is a private on the other service.

A saved module or a copied project can therefore instantiate a chain the endpoints would refuse. The
same parent rule and the same depth arithmetic apply to the initialization validator.

**And validation must match in BOTH directions — refusal and acceptance.** The decision above makes
`element` under `zone` legal, but the module path today makes that shape **unrepresentable**:
`anchorKindOf` (`orgs.service.ts:71`) maps an element-root module to anchor `'room'`, the placement
guards (`:418`, `:592`) refuse exactly that anchor at project creation and preset save, and
`loadModuleCopies` (`:490`) grafts only zone-anchored modules under a zone. So this unit could pass
every refusal probe while project initialization still cannot *produce* a tree shape the decision
explicitly allows — a site-gate module would remain impossible to place. The anchor-placement code
changes here, **structurally, without renaming anything**: an element-root module becomes placeable
directly under a zone, and the acceptance is probed (P11), not assumed. What stays refused stays
deliberately refused, with its reason intact.

### 4. `move` must honour the visibility invariant `create` already does

`create` refuses to publish a node under a DRAFT parent (`nodes.service.ts:58-61`): *"a published
child of a hidden parent would be an orphan on the team's Site Map."* `move` enforces nothing about
`publishedAt` — so reparenting a published subtree under a draft zone produces exactly the orphan
the create path exists to prevent: teammates hold nodes whose browse path is hidden, and the filing
pickers cannot reach them. Fixed depth kept the blast radius small (one level of room under a
handful of zones); nesting multiplies the reparent surface, and this unit rewrites `move` anyway —
so the rule lands here, stated the same way create states it: **a node may not be more visible than
its parent, on every write path that can change either side of that relation.**

### One more thing nesting makes worse

`subtreeIds` and `ancestorIds` call `prisma.projectNode.findMany({ select: { id, parentId } })` with
**no `projectId` filter** — every move loads every node of every project. Not a data leak (ids only,
and a cross-project parent is already refused upstream), but an unscoped cross-tenant read on a path
nesting is about to make hotter. Both get scoped while the file is open.

## §B — Filing, and what is already true

Filing stores a `nodeId`, so zone-level filing is already *representable* — it is simply not
*offered* by `LocationPicker`. That makes §B a UI change, not a contract change.

One correction worth keeping, because the first draft got it wrong: **a daily log is not filed at a
place, and should not be.** `DailyLog` (`schema.prisma:2260`) has no location column and
`placeContents` (`apps/web/src/lib/locationTree.ts:186`) never receives logs — it folds decisions,
drawings, photos, activities, materials and inspections. A daily log is a whole-site record of one
civil day; the located things are the materials delivered and the photos taken, and those already
carry `nodeId`. Giving the log itself a location would force a site-wide record to claim one place —
the same category error as `site > Excavation`.

## §C — The surfaces that assume the fixed depth

The first draft of this section covered one surface (the Locations dialog) and called it the UX gap.
Review found the honest scope is wider: **the fixed-depth assumption lives in readers too**, and a
tree the writers permit but the readers misrender is not shipped — it is half-shipped. Three
surfaces, each verified against the code, each in this unit:

**1 · The Locations dialog cannot build the tree.** Answering *"how do I add rooms under zones"*:
you cannot. The dialog only creates zones — its three zone-row icons are Save-as-module, Rename,
Delete, with no add-child control. Rooms exist only because `LocationPicker` offers
create-as-you-type at filing time. That is why `Excavation` exists and no sibling could be added.
**Nesting makes this worse, not neutral**: a tree you cannot build in the one screen devoted to
building trees is a tree nobody will use. The add-child control ships here.

**2 · The filing picker renders exactly three levels.** `LocationPicker.tsx:43-61` holds state for
precisely `zone` and `room` and renders Zone → Room → Object as three fixed rows; the element row
appears only once a room is selected. So after nesting lands, a fourth-level room is unreachable
from every filing flow, and a zone-level element cannot be selected at all — or worse, appears in
the Room selector. The picker's **structural recursion** (arbitrary room depth, element directly
under a zone) is this unit's work. Only its *labels* stay as they are — the copy belongs to the
deferred rename.

**3 · The Decision Register groups by position, not by kind.** `locationTree.ts:108-118` takes
`groupBy: 'room'` as *"the 2nd path segment"* and `groupBy: 'element'` as *"the last segment"* —
kind-blind positional logic that is only correct while the tree is exactly three levels. Under
nesting, a decision filed at `Zone > Wing > Pour` groups under **Wing** instead of the room it was
actually filed at, and an element directly under a zone lands at segment 2 and is grouped **as a
room**. The grouping moves to the node's *kind*, and the probe pins the two misclassifications that
positional logic produces.

The pattern behind all three is the one `docs/reviews/pr-330-convergence.md` already names — a rule
stated about one place when the system has several. §A enumerated the fixed-depth **write** paths;
this section is the same enumeration for the **readers**, done now rather than found in review
again.

## §D — Named probes

Every claim above is one this plan *asserts*; each is listed against what must *prove* it. The
concurrency probes must be **seen to fail** before they are trusted — a green concurrency probe
proves nothing until reverting the fix turns it red. R4 on #329 needed three attempts before it
could fail at all.

**Where the RED is captured matters, and the base commit is the wrong place.** At today's code,
`move` runs `requireParentForKind` (line 105) *before* `isDescendant` (line 108) — so a
room-under-room race fixture dies at the kind check and never reaches the unserialized guard. A red
at the base commit would be the *wrong failure*: proof the fixture is illegal, not proof the race
exists. The implementation therefore stages deliberately: **stage 1 legalizes the nested edges (the
parent-rule change) with serialization still absent; the concurrency probes are run and SEEN RED
there; stage 2 adds the serialization and turns them green.** The red-state evidence is captured
mid-implementation and recorded in the packet — that intermediate commit is the probes' honest
baseline, and the plan says so now rather than letting the reviewer discover the base-commit red
proves nothing.

| probe | proves | must first be seen to FAIL against |
|---|---|---|
| `P1` concurrent `move(A under B)` ∥ `move(B under A)`, both orderings, under a barrier | exactly one commits; no cycle exists after | the unserialized guard at `nodes.service.ts:108` |
| `P2` concurrent `create` under `P` ∥ `move(P)` to a depth-4 destination | the tree never exceeds 5 levels | an unserialized create path |
| `P3` move a 3-deep subtree under a 3-deep chain | refused, with the depth stated in the reason | a check measuring only the moved node |
| `P4` project init from a module whose graft would exceed 5 levels | refused | `writeInitializationSource` as it stands |
| `P5` project init from a module with an illegal parent chain | refused | the same |
| `P6` `subtreeIds` / `ancestorIds` against a second project's tree | only this project's rows are read | the unscoped `findMany` |
| `P7` an `element` created directly under a `zone` | accepted | the current `PARENT_KIND` map |
| `P8` a `room` created under another `room` | accepted | the same |
| `P9` add-child from the Locations dialog | creates a nested location without going through filing | the dialog's three-icon row |
| `P10` a plain `create` under a node already at level 5 — no race | refused, with the depth stated | the create path's absent depth logic |
| `P11` a saved element-root module placed directly under a `zone` | it instantiates there — the shape the decision allows is producible through init | `anchorKindOf` → `'room'` + the placement guards + the zone-only graft |
| `P12` a decision filed at `Zone > Room > Room`, and an element filed directly under a `zone` | the register groups the first under the room it was FILED at, and never shows the element as a room | the positional `seg[1]` / last-segment grouping |
| `P13` the filing picker on a nested tree | a room under a room is reachable and selectable, and so is an element directly under a zone | the picker's fixed `zone`/`room` state |
| `P14` concurrent `move(C under P)` ∥ `move(P under a depth-4 chain)`, both orderings | the tree never exceeds 5 levels | move-side depth checks outside the shared serialization |
| `P15` move a PUBLISHED subtree under a DRAFT zone | refused — the visibility invariant `create` already enforces (a published child of a hidden parent is an orphan) holds for `move` too | `move`'s absent `publishedAt` logic |
| `P16` a saved module containing `Zone > Room > Room`, instantiated | the nested-room chain is produced through init | the init validator's fixed parent map |

`P10` sits before `P2` deliberately: the race probe is worthless while the plain refusal does not
exist, and a green race probe would hide that. `P11` and `P16` are the acceptance mirrors of
`P4`/`P5` — one per legal shape the decision adds, because a validator that only ever refuses is not
proven able to produce them. `P14` exists because `P1` proves only *cycle* serialization and `P2`
only the *create* side: a fix could serialize both and still leave move-side depth checks reading a
stale snapshot, and only a move∥move race catches that. `P15` is the invariant this unit could
silently break — `create` refuses publish-under-draft (`nodes.service.ts:58-61`, "a published child
of a hidden parent would be an orphan on the team's Site Map") while `move` checks nothing, and a
unit that rewrites `move` for nesting owns that gap the moment it touches the file.

## §E — Why this is one review unit

No schema rename, no data migration, no cross-application deploy ordering, no client compatibility
window, no seed constants, no contraction. The diff is the node service, the initialization
validator (both directions — refusal and the element-module acceptance), the parent-rule contract,
and the three §C surfaces: the dialog's add-child control, the picker's structural recursion, and
kind-based register grouping.

It is independently deployable in the ordinary sense: the API accepts a strictly wider set of trees
than before, and every existing client keeps working unchanged, because nothing it can send stops
being valid.

## What carries forward to the rename

Three rules the review of the combined plan extracted. They cost five rounds to learn and are worth
more than the plan they came from:

1. **The code that INTERPRETS a value must land in the same step that starts ACCEPTING it**, or
   earlier — never later.
2. **A migration is a point in time; writes are a duration.** Pair every migration with the
   write-path rule that keeps its result true afterwards.
3. **Trace a renamed value to everywhere it is COMPARED**, not only everywhere it is written. A guard
   that tests for the old value stops guarding *silently*.

And one about this loop specifically: **a risk may be discharged into code, a gate, or a merged
state — never into an instruction for a person to be careful.** There is no person.
