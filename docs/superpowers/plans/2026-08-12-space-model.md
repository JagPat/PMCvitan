# Space model — redefining Room as Space, optional and self-nesting

**Status: PLAN. Review stop before implementation.**

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
       └ Column C4 (object)

site (zone)
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
| `space` | a `zone`, or another `space`, to any depth |
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
filters, the snapshot, the projections. The plan takes a **bounded depth** (proposal: 8 levels of
space) enforced at write time, because:

- it makes every reader's recursion provably terminating;
- it is far past any real building (`Tower > Floor > Wing > Zone > Pour` is five);
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
"objects". One of them is wrong in every conversation about this model. The plan adopts **`element`
in code, "object" in UI copy** — the current split — but states it once, deliberately, instead of
leaving it to be rediscovered. If that is the wrong call it should be settled in review, not later.

## §D — Migration

A data migration over live `ProjectNode.kind`, `'room' → 'space'`, **diagnostic-first** per the
standing discipline: it aborts on anything it did not expect rather than guessing, and it never
invents or deletes a row.

`'room'` is accepted as a **legacy alias on read** for one release, which is what allows the model
and the surfaces to ship as two reviewable units instead of one unreviewable one.

## §E — Sequencing, and the review budget

A rename touching every location reference will exceed the 20-file / 1,500-line budget. Split along
the dependency:

| Unit | Contents |
|---|---|
| **S1 — the model** | `space` kind, the parent rule, depth bound, cycle-safety probe, migration, API contracts, `'room'` legacy alias |
| **S2 — the surfaces** | recursive `LocationPicker`, the Locations dialog's missing add-child control, filters, Site Map, locales |

S1 does not change what a user sees. S2 is where the confusion actually goes away.

## §F — The separate UX gap this uncovered

While answering *"how do I add rooms or space under zones"*: **you cannot.** The Locations dialog
only creates zones. Its three zone-row icons are Save-as-module, Rename, Delete — there is no
add-child control. Rooms exist only because `LocationPicker` offers create-as-you-type at filing
time.

So the dialog states the model and can edit one third of it. That is why `Excavation` exists and no
sibling could be added. **Fixed in S2**, and recorded here because it is a defect in its own right,
not a consequence of the naming.

## Open questions for review

1. **Depth bound of 8** — right number, or should it be lower (5) to keep the Site Map legible?
2. **`element` under `zone`** — accepted, or should site-level objects be forced into a space named
   for the site?
3. **`element` vs "object"** — settle the vocabulary in one direction rather than carrying both.
4. **Legacy alias lifetime** — one release, or removed in S2's own migration?
