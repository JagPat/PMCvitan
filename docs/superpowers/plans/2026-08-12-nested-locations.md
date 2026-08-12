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

### 3. A second write path enforces none of it

`NodesService` is not the only thing that creates a `ProjectNode`. Project copy and module
instantiation go through `OrgsService.writeInitializationSource` (`orgs.service.ts:862,876`), which
calls `NodeInitParticipant.createForInit` and writes `kind` **straight through** — no parent-kind
check, no depth check, because `requireParentForKind` is a private on the other service.

A saved module or a copied project can therefore instantiate a chain the endpoints would refuse. The
same parent rule and the same depth arithmetic apply to the initialization validator.

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

## §C — The UX gap this uncovered

Answering *"how do I add rooms under zones"*: **you cannot.** The Locations dialog only creates
zones. Its three zone-row icons are Save-as-module, Rename, Delete — there is no add-child control.
Rooms exist only because `LocationPicker` offers create-as-you-type at filing time.

So the dialog states the model and can edit one third of it. That is why `Excavation` exists and no
sibling could be added. **Nesting makes this worse, not neutral**: a tree you cannot build in the one
screen devoted to building trees is a tree nobody will use. The add-child control ships with this
unit.

## §D — Named probes

Every claim above is one this plan *asserts*; each is listed against what must *prove* it. The two
concurrency probes must be **seen to fail** against the current code before they are trusted — a
green concurrency probe proves nothing until reverting the fix turns it red. R4 on #329 needed three
attempts before it could fail at all.

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

## §E — Why this is one review unit

No schema rename, no data migration, no cross-application deploy ordering, no client compatibility
window, no seed constants, no contraction. The diff is the node service, the initialization
validator, the parent-rule contract, and one dialog control.

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
