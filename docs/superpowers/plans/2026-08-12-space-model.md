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

**Migrating the stored values is not enough — the code that DERIVES and CONSUMES `anchorKind` has
the kind names hard-coded, and would silently mis-anchor every module saved afterwards.**
`anchorKindOf` (`orgs.service.ts:71`) is a two-line ladder over the literal kinds:

```ts
if (roots.some((r) => r.kind === 'element')) return 'room';
if (roots.some((r) => r.kind === 'room'))    return 'zone';
return null;                                  // ← where a `space` root lands after S3
```

A module captured from a `space` root matches NEITHER branch and returns `null`. `loadModuleCopies`
(`orgs.service.ts:490`) then grafts only when `row.anchorKind === 'zone'`, so a `null` anchor
instantiates with `parentId: null` — a **top-level space**, which the parent rule in §A forbids. The
element branch is wrong in the other direction: it would keep returning `'room'`, a kind that no
longer exists.

There is a **third** consumer, and it fails in the most dangerous direction — silently. The
placement guards at `orgs.service.ts:418` and `:592` refuse element-anchored modules:

```ts
if (m.anchorKind === 'room') {
  throw new BadRequestException(`"${m.name}" anchors to a room — element modules can't be placed …`);
}
```

Once no module anchors to `'room'` any more, that comparison is never true, the guard stops firing,
and element modules start slipping into project creation and presets — the exact thing it was added
to prevent (its own comment cites "review F3"). A guard that quietly stops guarding is worse than one
that breaks loudly.

So the changeover touches three stored values AND **four** code sites:

| what | where | fails how |
|---|---|---|
| `ProjectNode.kind` | column | the tree itself |
| `TemplateModule.payload.nodes[*].kind` | JSON | `.parse()` throws on a menu read |
| `TemplateModule.anchorKind` | column | grafting stops |
| `anchorKindOf` — derivation | `orgs.service.ts:71` | returns `null` for a space root |
| `loadModuleCopies` — graft condition | `orgs.service.ts:490` | grafts at `parentId: null` |
| placement guard (project creation) | `orgs.service.ts:418` | **stops firing, silently** |
| placement guard (presets) | `orgs.service.ts:592` | **stops firing, silently** |

**All four code sites move to S2, not S3** — see §E. S2 is where the contract starts accepting
`space`, and the moment it does, a space-root module can be persisted through the public
`POST /orgs/:orgId/modules`. Anchor code that still only understands `room` would mis-anchor it
immediately. The data migration stays in S3; the code that interprets kinds must lead it.

Probes: a module saved BEFORE the changeover still lists and instantiates after it; a module captured
from a space root anchors under a zone rather than at top level; and an element-anchored module is
still refused at both guards. The JSON rewrite aborts on any payload it cannot parse rather than
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
| **S2 — expand** | the API accepts `space` in addition to `room`; contracts and payload schema widened; **all four `anchorKind` code sites** (§D) updated first, since accepting `space` is what makes a space-root module persistable |
| **S3 — migrate + surfaces** | the three-store data migration; the API **canonicalizes an accepted `room` to `space`** (§E); recursive `LocationPicker`, the Locations dialog's missing add-child control, filters, Site Map, locales, `"object" → "element"`. The surfaces **read both kinds and write only `space`** |
| **S4 — contract** | drop `room` from the contracts and the payload schema; a probe that `kind: 'room'` is refused. **Gated on both preconditions** (§E): the measured quiet window, and a preflight proving zero `room` values exist in any of the three stores |

**S1 carries no rename, and that is what makes it buildable now.** Everything round-1 review found
unsafe about the tree — the unserialized cycle guard, the depth cap that a subtree move walks
straight past, the initialization path that enforces neither — is a property of *nesting*, not of
what the nestable kind is called. It is also the part that must be right before any data is
rewritten, since a migration that lands `space` rows into a tree whose guards still do not hold just
makes the broken states easier to reach.

**S2 and S3 must be separate merges, and S2 must be DEPLOYED — not merely merged — before S3's
bundle ships.** If one PR both teaches the API `space` and switches the web to send it, the web
application can deploy first and spend the gap sending a kind the API still rejects. Splitting them
is necessary but not sufficient: merge order does not imply deploy order when the two applications
redeploy independently, so "S2 is live" is a release-time check somebody performs, not something the
PR graph guarantees. Once S2 IS live, every combination of old/new web against old/new API is valid.

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

| step | API accepts | API stores | web | safe alone because |
|---|---|---|---|---|
| **E — expand** | `space` **and** `room` | as sent | unchanged, still sends `room` | old web + new API both work; anchor code understands both |
| **M — migrate** | `space` and `room` | **always `space`** — canonicalized | writes `space`, **reads either** | old rows are swept; new `room` writes canonicalize, so no `room` row survives the step |
| **C — contract** | `space` only | `space` | unchanged | no client is still writing `room` (measured) AND no `room` row exists (verified) |

### Why M canonicalizes rather than storing what it is sent

The migration is a **point-in-time sweep, but writes do not stop when it finishes.** `create`
persists the literal kind (`nodes.service.ts:64`), so a tab opened before M can create a brand-new
`room` row minutes *after* the sweep has run. C would then drop `room` from the contract while those
rows sat in the database — the end state promised in decision 4 would be false in the data even
though it was true in the schema.

So from M's API deploy onward, an accepted `room` is **stored as `space`**. This is not a silent
rewrite of someone's input: `room` and `space` are the same concept under two names, and
canonicalizing a synonym is precisely what the expand/contract shape is for. It is recorded here so
it is a documented behaviour rather than a surprise.

**Why M and not E.** Canonicalizing at E would break the clients E exists to protect: the pre-M
bundle renders levels by `kind === 'room'` (`LocationPicker.tsx:51`), so a node it created would be
stored as `space` and then vanish from its own view. By M the shipping bundle reads both kinds, and
the only sufferer is a stale tab whose freshly created node does not appear until it reloads — a
display gap, not an error, and strictly better than leaving `room` rows behind.

**C therefore has two preconditions, not one:** the measured quiet window (no client is still
*writing* `room`), and a diagnostic preflight proving zero `room` values *exist* — in
`ProjectNode.kind`, in `TemplateModule.payload`, and in `anchorKind`. The second is cheap, and it is
what makes the end state a verified fact rather than a belief.

### The mistake this table hides, and the rule that fixes it

The first version of this table said step M "switches to `space`" and step C was safe because
"nothing sends `room` any more". Both treat the web switch as an **instant**. It is not. A browser
tab holds its bundle until the user reloads, so at every moment during the changeover there are
clients running the PREVIOUS step's code — and there is no point at which that stops being true by
itself.

**The rule: every step must tolerate the previous step's client, and no step may assume a client has
been replaced.** Applied to the two places the first draft broke:

- **M's web must READ both kinds.** Its bundle can reach a user before the API container has run the
  migration, so it will be handed snapshots still containing `kind: 'room'`. A bundle that filters on
  `space` alone renders those as nothing — the Site Map blanks. M's surfaces therefore treat `room`
  and `space` as the same thing on read, and write only `space`.
- **M's web must not ship before E is live.** Its creates send `space`; an API still on
  `NODE_KINDS = ['zone','room','element']` (`contracts.ts:475`) rejects them. E merging is not
  enough — E must be DEPLOYED. Since the two applications deploy independently and neither PR
  boundary orders them, this is a release-time check, not something a merge order guarantees.
- **C needs a positive signal, not an inference.** `LocationPicker.tsx:60` creates locations with
  `kind: 'room'`; any tab opened before M still does. Dropping `room` while such a tab is open
  breaks ordinary location creation for that user until they reload — exactly the outage the expand
  step existed to prevent. There is **no client-version handshake in this codebase** (checked), so
  "all clients are new" cannot currently be established mechanically.

**So C is gated on a measured precondition:** instrument `room`-valued writes at E, and run C only
after a defined quiet window with zero of them. That converts "nothing sends `room`" from an
assumption into an observation, which is the whole difference. Building a client-version handshake
that forces a stale bundle to reload would make the gate mechanical rather than observational and is
the better long-run answer — but it is its own piece of work, and naming it here is deliberate so C
is not blocked on inventing it.

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

## §G — The named probes this plan defers to

Three finding-bearing rounds is the cap. Past it, a docs-only review stops answering questions with
more prose and hands each remaining one to a **named probe** — an executable check written during
implementation. Nothing is dismissed; only the place of verification moves. Every claim below is one
this plan currently *asserts*, and each is listed against the unit that must *prove* it.

The three rules the convergence audit extracted are what these probes exist to enforce, so each is
tagged with the rule it defends: **[W]** state it per write path · **[C]** trace the renamed value to
every comparison · **[D]** pair a migration with the write-path rule that keeps its result true.

### S1 — the structure

| probe | proves | must first be seen to FAIL against |
|---|---|---|
| `P1.1` concurrent `move(A under B)` ∥ `move(B under A)`, both orderings, under a barrier | exactly one commits; no cycle exists after | the unserialized guard as it stands today |
| `P1.2` move a 3-deep subtree under a 3-deep chain | refused, with the depth stated in the reason | a check that measures only the moved node |
| `P1.3` project init from a module whose graft would exceed 5 levels **[W]** | refused | `writeInitializationSource` as it stands today |
| `P1.4` project init from a module with an illegal parent chain **[W]** | refused | the same |
| `P1.5` `subtreeIds` / `ancestorIds` against a second project's tree | only this project's rows are read | the unscoped `findMany` |

`P1.1` and `P1.3` are the two that matter most: the first because a green concurrency probe proves
nothing until reverting the fix turns it red, and the second because project initialization is the
write path this plan has now twice been caught assuming away.

### S2 — expand

| probe | proves |
|---|---|
| `P2.1` capture a module from a **space** root via `POST /orgs/:orgId/modules`, then instantiate it | it anchors under a zone — NOT at `parentId: null` |
| `P2.2` an element-anchored module at project creation, and at preset save **[C]** | still refused at BOTH guards (`orgs.service.ts:418`, `:592`) |
| `P2.3` create a node with `room`, and with `space` | both accepted; each stored as sent |

`P2.2` is the silent-failure probe. After the rename the old comparison is simply never true, so the
guard stops guarding without erroring — the failure mode no test catches unless one is written for it
deliberately.

### S3 — migrate + surfaces

| probe | proves |
|---|---|
| `P3.1` a module saved BEFORE the migration | still lists and still instantiates after it |
| `P3.2` a payload the migration cannot parse | it ABORTS; no row is rewritten, none dropped |
| `P3.3` a `room`-valued write after this deploy **[D]** | stored as `space` |
| `P3.4` a snapshot containing both kinds | the surfaces render both identically |

`P3.3` is what makes the migration's result survive the migration.

### S4 — contract

| probe | proves |
|---|---|
| `P4.1` preflight against a database holding one `room` value in any of the three stores | refuses, naming the store |
| `P4.2` after the contraction | a request carrying `kind: 'room'` is refused |

## What decision 2 changes in the rule

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
