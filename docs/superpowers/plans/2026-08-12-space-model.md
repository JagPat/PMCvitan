# Space model — redefining Room as Space, optional and self-nesting

**Status: PLAN, fully settled. Implementation may begin.** The four original questions are SETTLED by
the owner; round-1 review returned seven findings, all verified against the code and corrected here;
and the one question that correction raised — the changeover route — is **SETTLED: expand → migrate
→ contract** (§E).

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

### Cycle-safety stops being a formality — and the current guard cannot hold it

`isDescendant` already exists and already guards reparenting. At fixed depth it could never actually
fire for a `space`, because a room's only legal parent was a zone. With nesting it becomes
load-bearing: `move` must refuse a space under its own descendant, and that probe must be **seen to
fail** before the guard is trusted — the standing rule in this repository, and the one C7 in the
Phase 6 audit is the cautionary case for.

**The guard as written is not sufficient, and this was verified rather than assumed.** In
`nodes.service.ts`, `move` runs the check at line 108 and the write at line 111 — the check is
*outside* the transaction:

```ts
if (await this.isDescendant(parent.id, nodeId)) throw new BadRequestException(…);  // read
…
const ev = await this.prisma.$transaction(async (tx) => {                          // write
  await tx.projectNode.update({ where: { id: nodeId }, data: { parentId: … } });
```

Two concurrent moves — `A under B` and `B under A` — each read the old tree, each pass, and both
commit. The result is a two-node cycle, after which every recursive reader (`subtreeIds`,
`ancestorIds`, the picker, the Site Map) either loops or overflows. Today this is unreachable for a
room; **nesting makes it reachable by two ordinary users.**

S1 must therefore:

- move the descendant check **inside** the write transaction, serialized against concurrent
  reparents of the same tree (a lock whose scope covers both nodes' ancestry — the project's node
  set is the honest granularity, since ancestry can span it);
- carry a **barrier race probe** driving both orderings, `A→B` and `B→A`, proving exactly one
  commits;
- and that probe must be **seen to fail first** against the unserialized guard. A green concurrency
  probe proves nothing until reverting the fix turns it red — the standing rule, and R4 on #329
  needed three attempts before it could fail at all.

### Depth is unbounded, so something must bound it

Unbounded nesting is unbounded recursion in every reader: the picker, the Site Map, the location
filters, the snapshot, the projections. The bound is **5 levels of space**, enforced at write time,
because:

- it makes every reader's recursion provably terminating;
- five reaches a tower with wings and pour segments (`Tower > Floor > Wing > Zone > Pour`) and stays scannable on a phone, which is where the Site Map is actually read;
- an unbounded tree is a denial-of-service surface on the read path, entered by an ordinary user.

The limit is a refusal with a stated reason, not a silent truncation.

**A depth check on the moved node alone does not deliver this bound.** `requireParentForKind` today
inspects only the *immediate* parent's kind — there is no depth logic anywhere, because at fixed
depth none was possible. Add a naive one and this passes:

```
move (A > B > C)  under  (P1 > P2 > P3)
        ↑ moved root lands at level 4 — legal
                                 → B at 5, C at 6 — over the cap, silently
```

So the rule is **destination depth + the moved subtree's own height**, evaluated on every reparent,
not the moved node's new depth. The same arithmetic governs `create` (height 0) and is what makes
the cap a property of the tree rather than of one operation.

### The second write path, which bypasses all of this

`NodesService` is not the only thing that creates a `ProjectNode`. Project copy and module
instantiation go through `OrgsService.writeInitializationSource`
(`orgs.service.ts:862,876`), which calls `NodeInitParticipant.createForInit` and writes
`kind: node.kind` **straight through** — no parent-kind check, no depth check, because
`requireParentForKind` is a private on the other service and the init path has its own separate graph
validation.

That means a saved module or a copied project can instantiate a chain the node endpoints would
refuse, and every reader then receives a tree this plan promised was impossible. **S1 applies the
same parent rule and the same depth arithmetic to the initialization validator, with a RED probe
driving it through project initialization** — not only through the endpoints.

### One more thing the nesting makes worse

`subtreeIds` and `ancestorIds` both call `prisma.projectNode.findMany({ select: { id, parentId } })`
with **no `projectId` filter** — every move loads every node of every project. It is not a data leak
(ids only, and a cross-project parent is already refused upstream), but it is an unscoped
cross-tenant read on a path nesting is about to make hotter. **Scope both to the project in S1**,
while the file is open and the tests are being written anyway.

## §B — Filing targets any node

"Space is optional" is a statement about **filing**, not about the tree. A record that is filed at a
location must be able to name a `zone` directly.

**Checked rather than assumed, and the first draft of this section overreached.** Filing stores a
`nodeId`, so zone-level filing is already *representable* and merely not *offered* by
`LocationPicker` — §B is a UI change, not a contract change. But the list of what gets filed was
wrong:

| record | carries `nodeId` | filed at a place? |
|---|---|---|
| decision, inspection, drawing, activity | yes | yes |
| `SiteMaterial` (a daily log's material row) | yes (`schema.prisma:2309`) | yes |
| `Media` (a daily log's photo) | yes | yes |
| **`DailyLog` itself** | **no** | **no — and it should not** |

`DailyLog` (`schema.prisma:2260`) has no location column, and `placeContents`
(`apps/web/src/lib/locationTree.ts:186`) never receives logs — it folds decisions, drawings, photos,
activities, materials and inspections.

That is **correct as it stands, not a gap to close.** A daily log is a whole-site record of one
civil day; the located things are the materials delivered and the photos taken, and those already
carry `nodeId`. Giving the log itself a location would force a site-wide record to claim one place,
which is the same category error as `site > Excavation` — the error this plan exists to remove.

**So §B narrows: a daily log is not a filing target, and S1 adds no `DailyLog.nodeId`.** Its
child records are filed, and they already can be.

## §C — The rename, and the drift it should not repeat

`room` → `space` across `ProjectNode.kind`, the API contracts, the store, the filters and three
locales.

**There is existing drift to fix while we are here:** the schema and API say `element`, the UI says
"objects". One of them is wrong in every conversation about this model. **Settled: `element`, in code
AND on screen** — closer to construction drawing language, and it ends the split rather than carrying
it forward. So TWO renames ship together: `room → space`, and `"object" → "element"` in the UI copy,
picker labels, filter chips and the three locales.

## §D — Migration

A data migration `'room' → 'space'`, **diagnostic-first** per the standing discipline: it aborts on
anything it did not expect rather than guessing, and it never invents or deletes a row.

**`ProjectNode.kind` is not the only place `'room'` is stored, and missing the others would break
reads that have nothing to do with this change.** Verified in the code:

| store | where | what breaks if it is not migrated |
|---|---|---|
| `ProjectNode.kind` | column | the tree itself |
| `TemplateModule.payload.nodes[*].kind` | **JSON** | `moduleSummary` calls `modulePayloadSchema.parse()` — a *throw*, not a `safeParse` — on every menu read (`orgs.service.ts:653`). An org with one saved room module gets a BadRequest **just listing its modules** |
| `TemplateModule.anchorKind` | column | `orgs.service.ts:418,592` branch on `anchorKind === 'room'`; an element module anchored to a room stops grafting, so **project creation from a template fails** |

`modulePayloadSchema` (`contracts.ts:285`) pins `kind: z.enum(['zone','room','element'])`, so
narrowing that enum to `space` without rewriting the stored JSON turns every pre-existing saved
module into a parse failure on a read path no one associates with a rename.

**S3 migrates all three together** (see §E for why the data moves with the surfaces rather than with
the model), diagnostic-first, with a probe that a module saved before the migration still lists and
still instantiates afterwards. The JSON rewrite aborts on any payload it cannot parse rather than
dropping nodes.

**No legacy alias in the end state.** Only `space` is accepted once the changeover completes — a
clean break, decided deliberately. How that is delivered safely is §E, and it is the one place this
plan now differs from the decision as originally recorded.

## §E — Sequencing, and why "deploy as one release" cannot be honoured

A rename touching every location reference will exceed the 20-file / 1,500-line budget, so the work
splits along the dependency:

| Unit | Contents |
|---|---|
| **S1 — the structure** | the parent rule, the depth cap by subtree height, the serialized cycle guard, the initialization validator, project-scoped tree reads. **No vocabulary change at all** |
| **S2 — expand** | the API accepts `space` in addition to `room`; contracts and payload schema widened |
| **S3 — migrate + surfaces** | the three-store data migration, recursive `LocationPicker`, the Locations dialog's missing add-child control, filters, Site Map, locales, `"object" → "element"` |
| **S4 — contract** | drop `room` from the contracts and the payload schema; a probe that `kind: 'room'` is refused |

**S1 carries no rename, and that is what makes it buildable now.** Everything round-1 review found
unsafe about the tree — the unserialized cycle guard, the depth cap that a subtree move walks
straight past, the initialization path that enforces neither — is a property of *nesting*, not of
what the nestable kind is called. It is also the part that must be right before any data is
rewritten, since a migration that lands `space` rows into a tree whose guards still do not hold just
makes the broken states easier to reach.

**S2 and S3 must be separate merges, with S2 deployed before S3's bundle ships.** If one PR both
teaches the API `space` and switches the web to send it, the web application can deploy first and
spend the gap sending a kind the API still rejects. Expanding first removes the ordering requirement
entirely — every combination of old/new web against old/new API is then valid.

**The data migration belongs with the surfaces (S3), not with the model.** Rewriting
`ProjectNode.kind` to `space` while the live bundle still filters on `room` would blank the user's
Site Map. The data and the surfaces that read it move together.

All four units are unblocked. S1 is buildable immediately and independently of the rest.

The original plan said these two "deploy as one release" and that S1 must not reach production
alone. **That hold is not enforceable, and not merely unenforced — it is impossible by
construction.** `docs/DEPLOY.md` provisions the web SPA and the API as **two separate Coolify
applications**, both tracking `main` (§"Deploy on Coolify" and §"API Application" respectively).
There is no deploy unit that contains both. Even collapsing S1 and S2 into a single PR would not fix
it: one merge triggers two independent redeploys with no ordering guarantee between them, and a
cached browser bundle outlives both.

So a simultaneous cutover is not available at any PR granularity, and a plan that depends on one is
a plan with an outage in it.

### The delivery that does work: expand → migrate → contract

Each step is independently deployable and compatible in **both** directions, so no ordering between
the two applications matters:

| step | API | web | safe alone because |
|---|---|---|---|
| **E — expand** | accepts `space` **and** `room`; all nesting rules, depth, cycle guard, init validator | unchanged, still sends `room` | old web + new API both work |
| **M — migrate** | unchanged | switches to `space`; the surfaces land | data is rewritten; API accepts either, so a stale bundle still works |
| **C — contract** | drops `room` | unchanged | nothing sends `room` any more |

**This preserves decision 4's end state exactly** — after step C, only `space` is accepted and no
alias remains. What it changes is that the alias exists *during* the changeover rather than never,
with step C as the scheduled removal rather than an open-ended "someday".

**SETTLED by the owner: expand → migrate → contract.** Decision 4 stands as an end state and is
delivered in full; what was revised is the route to it, once the review established that "only
`space` from day one" was unavailable at any PR granularity without an outage window of unknown
length.

**Step C is not optional, and it is not "someday".** The whole difference between this and the
permanent alias that was rejected is that the removal is scheduled work with an owner. It carries
its own unit (S4) and its own probe: after C, a request carrying `kind: 'room'` is refused. A
changeover that stops after M has quietly become the thing decision 4 said no to.

S1 and S2 do not change what a user sees. S3 is where the confusion actually goes away.

## §F — The separate UX gap this uncovered

While answering *"how do I add rooms or space under zones"*: **you cannot.** The Locations dialog
only creates zones. Its three zone-row icons are Save-as-module, Rename, Delete — there is no
add-child control. Rooms exist only because `LocationPicker` offers create-as-you-type at filing
time.

So the dialog states the model and can edit one third of it. That is why `Excavation` exists and no
sibling could be added. **Fixed in S3**, and recorded here because it is a defect in its own right,
not a consequence of the naming.

## The four open questions — SETTLED by the owner

| # | Question | Decision |
|---|---|---|
| 1 | how deep may spaces nest | **5 levels of space.** A tower with wings and pour segments fits; the Site Map stays scannable on a phone |
| 2 | may an `element` hang directly off a `zone` | **Yes.** A site gate or bore well needs no invented container — the same error `site > Excavation` exposed |
| 3 | `element` vs "object" | **`element`, in code AND on screen.** Closer to construction drawing language; the UI copy changes from "object" |
| 4 | accept `'room'` during changeover | **No alias in the end state.** Reached by expand → migrate → contract, where S4 removes `room` on a schedule — the route was revised after review, the end state was not |

### What decision 4 costs — revised, because the first statement of it was wrong

The first version of this section said S1 and S2 would "deploy as one release", with the cost being
a single stale-bundle reload. **Both halves of that turned out to be untrue**, and the correction is
recorded rather than quietly swapped:

- *"They deploy as one release"* — there is no such release. The web SPA and the API are **separate
  Coolify applications** (`docs/DEPLOY.md`), so no PR boundary, however drawn, deploys them together.
- *"the cost is one reload"* — the inconsistent window is not a moment. It lasts until two
  independent deploys and every open browser cache converge.

Decision 4's **end state is unchanged and still delivered**: only `space` is accepted, no alias
remains. What changes is the route — expand → migrate → contract in §E, where the alias exists
during the changeover and step C removes it on a schedule.

**SETTLED by the owner: expand → migrate → contract.** The alternative was priced honestly first:

| route | what it costs |
|---|---|
| **expand/migrate/contract** ← chosen | `room` is accepted transiently; four units instead of two; the end state is identical |
| clean break as originally recorded | an outage window of unknown length, spanning two independent deploys, for anyone on a stale bundle |

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
