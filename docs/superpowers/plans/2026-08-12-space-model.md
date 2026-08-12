# Space model — redefining Room as Space, optional and self-nesting

**Status: PLAN, with all four open questions SETTLED by the owner. Implementation may begin.**

## The problem, in one screenshot

The Locations dialog says *"Zones contain rooms; rooms contain objects"*, and a live project reads:

```
ZONE  site
ROOM  Excavation
```

Excavation is not a room. Neither are boundary walls, external works, terraces, shafts, podiums,
basements-as-a-whole, or a pour segment. The vocabulary forces every piece of site work to be filed
as a "room", and the word stops carrying meaning the first time it is used.

**Two distinct problems hide behind one symptom, and only the first is naming:**

1. **Vocabulary.** "Room" is wrong for most of what gets filed. "Space" is right for all of it.
2. **Structure.** Site-level activities and partial zones are not fixed by a rename. The middle level
   is effectively mandatory, so `site` became a zone *and* `Excavation` a pseudo-room to hold the
   work. A partial zone — a wing, a pour segment, half a slab — has nowhere to live except as more
   pseudo-rooms.

## The decision

**Space replaces Room, and a space is OPTIONAL and SELF-NESTING.**

```
Ground Floor (zone)
 └ East Wing (space)
    └ Slab Pour 2 (space)
       └ Column C4 (element)

site (zone)
 ├ Site Gate (element)        ← an element may hang straight off a zone
 └ [excavation activities filed directly on the zone — no invented space]
```

Chosen over two narrower options, and the reasons are worth keeping:

- **Rename only** would leave `site > Excavation` exactly as it is — a pseudo-space named for an
  activity. It fixes the word and not the modelling error the word exposed.
- **Rename + zone-level filing, spaces stay flat** answers site work but not partial zones, which is
  half the question that was actually asked.

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

A fixed-depth lookup. It becomes a rule:

| kind | may hang under |
|---|---|
| `zone` | nothing — top level only |
| `space` | a `zone`, or another `space`, to **5 levels** of space |
| `element` | a `space`, or a `zone` directly |

**`element` under a `zone` is deliberate.** A site gate, a site board, a bore well are objects with
no meaningful containing space, and inventing one is the error this plan exists to remove.

**What is NOT changing:** `element` remains a leaf. Objects do not contain objects. Nothing in the
product asks for that, and admitting it would make every reader recursive for no gain.

### Cycle-safety stops being a formality

`isDescendant` already exists and already guards reparenting. At fixed depth it could never actually
fire for a `space`, because a room's only legal parent was a zone. With nesting it becomes
load-bearing: `move` must refuse a space under its own descendant, and that probe must be **seen to
fail** before the guard is trusted — the standing rule in this repository, and the one C7 in the
Phase 6 audit is the cautionary case for.

### Depth is unbounded, so something must bound it

Unbounded nesting is unbounded recursion in every reader: the picker, the Site Map, the location
filters, the snapshot, the projections. The bound is **5 levels of space**, enforced at write time,
because:

- it makes every reader's recursion provably terminating;
- five reaches a tower with wings and pour segments (`Tower > Floor > Wing > Zone > Pour`) and stays scannable on a phone, which is where the Site Map is actually read;
- an unbounded tree is a denial-of-service surface on the read path, entered by an ordinary user.

The limit is a refusal with a stated reason, not a silent truncation.

## §B — Filing targets any node

"Space is optional" is a statement about **filing**, not about the tree. A decision, inspection,
drawing, activity or daily-log entry must be able to name a `zone` directly.

This needs checking rather than assuming: filing appears to store a `nodeId`, in which case
zone-level filing may already be *representable* and merely not *offered* by `LocationPicker`. The
implementation's first task is to establish which, because it decides whether §B is a contract
change or a UI change.

## §C — The rename, and the drift it should not repeat

`room` → `space` across `ProjectNode.kind`, the API contracts, the store, the filters and three
locales.

**There is existing drift to fix while we are here:** the schema and API say `element`, the UI says
"objects". One of them is wrong in every conversation about this model. **Settled: `element`, in code
AND on screen** — closer to construction drawing language, and it ends the split rather than carrying
it forward. So TWO renames ship together: `room → space`, and `"object" → "element"` in the UI copy,
picker labels, filter chips and the three locales.

## §D — Migration

A data migration over live `ProjectNode.kind`, `'room' → 'space'`, **diagnostic-first** per the
standing discipline: it aborts on anything it did not expect rather than guessing, and it never
invents or deletes a row.

**No legacy alias.** Only `space` is accepted from day one — a clean break, decided deliberately.
What that costs is set out under the settled questions below: S1 and S2 stay two PRs for review size,
but they DEPLOY AS ONE RELEASE, because an API accepting only `space` while a cached browser bundle
still sends `room` produces errors until that user reloads.

## §E — Sequencing, and the review budget

A rename touching every location reference will exceed the 20-file / 1,500-line budget. Split along
the dependency:

| Unit | Contents |
|---|---|
| **S1 — the model** | `space` kind, the parent rule, the 5-level bound, cycle-safety probe, migration, API contracts |
| **S2 — the surfaces** | recursive `LocationPicker`, the Locations dialog's missing add-child control, filters, Site Map, locales |

S1 does not change what a user sees. S2 is where the confusion actually goes away — and because
there is no alias, **S1 must not reach production without S2**.

## §F — The separate UX gap this uncovered

While answering *"how do I add rooms or space under zones"*: **you cannot.** The Locations dialog
only creates zones. Its three zone-row icons are Save-as-module, Rename, Delete — there is no
add-child control. Rooms exist only because `LocationPicker` offers create-as-you-type at filing
time.

So the dialog states the model and can edit one third of it. That is why `Excavation` exists and no
sibling could be added. **Fixed in S2**, and recorded here because it is a defect in its own right,
not a consequence of the naming.

## The four open questions — SETTLED by the owner

| # | Question | Decision |
|---|---|---|
| 1 | how deep may spaces nest | **5 levels of space.** A tower with wings and pour segments fits; the Site Map stays scannable on a phone |
| 2 | may an `element` hang directly off a `zone` | **Yes.** A site gate or bore well needs no invented container — the same error `site > Excavation` exposed |
| 3 | `element` vs "object" | **`element`, in code AND on screen.** Closer to construction drawing language; the UI copy changes from "object" |
| 4 | accept `'room'` during changeover | **No — clean break.** Only `space` is accepted from day one |

### What decision 4 costs, stated rather than discovered

The legacy alias existed to let the model and the surfaces ship as **independently deployable**
releases. Without it they must reach production **together**: an API that accepts only `space` while
a browser still holds a cached bundle sending `room` produces errors until that user reloads.

That is the accepted trade — the pilot team is small and a reload is cheap — but it changes the
delivery shape, so it is written down rather than left as a surprise:

- **S1 and S2 remain two PRs** (review size is the reason for the split, and that reason is intact).
- **They deploy as one release.** S1 must not go to production alone.
- The web bundle changes in S2, so between the two merges `main` is briefly inconsistent. Nothing
  deploys from that intermediate state.

### What decision 2 changes in the rule

`element` under `zone` is now confirmed rather than proposed, and the parent rule is final:

| kind | may hang under |
|---|---|
| `zone` | nothing — top level only |
| `space` | a `zone`, or another `space`, to **5 levels** of space |
| `element` | a `space`, **or a `zone` directly** |

`element` remains a leaf: elements do not contain elements.

### What decision 3 changes beyond the rename

Two renames ship together, not one: `room → space`, and `"object" → "element"` in the UI copy,
picker labels, filter chips and the three locales. Worth noting the pairing, because shipping the
first without the second would leave the vocabulary half-corrected — which is how the current
`element`/"object" split arose in the first place.
