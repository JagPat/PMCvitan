# Vitan PMC — Project Templates (design proposal)

> **Status: design agreed (v1 defaults adopted — see Decisions below); Slice 1 is
> implemented.** Supersedes the "org-scoped templates" line item deferred in the
> multi-project review (ROADMAP follow-up #6).

## The problem

A brand-new project starts as a **blank slate**: an empty location tree ("No locations yet" on the
Site Map), no phases, no inspection checklists, no decision list. Today the PMC hand-builds all of
it, every project, from zero — and rooms/objects can only be added inline while filing a decision.
For a practice that keeps doing the *same kinds* of projects (a G+2 residence, a villa, an
apartment fit-out), that's the same structure re-keyed each time.

We want to **start from a prefilled, guiding structure** and refine it as the project progresses —
without every project being identical. The key requirement (from the ask):

> "You should have multiple templates — it's like a **menu** which we can deploy for a particular
> project in **different combinations**. Templates designed for **particular spaces or areas**. How
> do we **modulate** the template?"

So the design is **modular and composable**, not one monolithic blueprint.

---

## Core model: modules + compositions

Two org-owned concepts. A **module** is a reusable menu item; a **composition** is a named preset
of modules. You build a project by picking modules — from a saved preset or à la carte.

```
Org
 ├── TemplateModule[]        ← the menu: atomic, reusable, per space / area / discipline
 └── ProjectTemplate[]       ← named presets: an ordered selection of modules ("G+2 Residence")

Create Project → pick a preset OR pick modules à la carte → INSTANTIATE → a project skeleton (drafts)
```

The load-bearing idea:

> **A template is a project's *skeleton* — structure without actuals.** A **module** is a *slice* of
> that skeleton, scoped to one space or discipline, that can be combined with others in any mix.

### What a module can carry

A module contributes any subset of the four skeleton types (all four confirmed in scope):

| Skeleton | Example content | Attaches to |
|---|---|---|
| **Location subtree** | `Kitchen → [counter, sink, cabinets]`; `Bathroom → [WC, vanity, shower]` | grafts onto the tree at its **anchor kind** (see below) |
| **Phases + schedule shape** | "Services & Waterproofing", "Finishing" + activity names & planned offsets (no real dates) | the project schedule |
| **Inspection checklists** | "Waterproofing ponding test", "Tiling QA" (title + items) | a node kind ("run at each Bath") or the project |
| **Decision blanks** | "Living Room flooring", "CP fittings" (title + option scaffold, unfilled) | a space, as draft decisions |

### Module categories (the menu is grouped)

- **Space modules** — a room/area and its objects + the decisions & inspections that space typically
  needs ("Kitchen", "Master Bath", "Living Room", "Terrace").
- **Zone modules** — a floor/level that bundles space modules ("Ground Floor (residence)").
- **Discipline modules** — cross-cutting sets not tied to one room ("MEP inspection set",
  "Structural QA", "Interior finishes decision checklist").
- **Schedule modules** — a phase + its planned activities ("Finishing phase").

A module can be *simple* (just a location subtree) or *rich* (a space that also brings its decisions
and inspections). That's the "designed for a particular space/area" part.

---

## How you modulate — composition mechanics

This is the heart of the ask: how modules combine in different combinations.

1. **Anchor kind.** Every module declares where it attaches, matching the spine's `zone → room →
   element` rules:
   - a **zone module** creates a top-level zone;
   - a **space/room module** grafts under a chosen zone;
   - an **element module** grafts under a chosen room;
   - a **discipline module** attaches to matching node kinds or to the project (no tree graft).
2. **Count + placement, at instantiate.** You say *how many* and *where*: "add **3× Bedroom** under
   **Second Floor**", "add **Kitchen** to **Ground Floor**". Repeated modules auto-suffix
   ("Bedroom 1 / 2 / 3") so nothing collides.
3. **À la carte or preset.** A project's starting structure is the **union of the chosen modules**.
   You can pick them one-by-one from the menu, or start from a named **ProjectTemplate** preset and
   then add/remove modules for this specific project.
4. **Presets are just saved selections.** "G+2 Residence" = `Ground Floor` + `Second Floor` +
   `Terrace` + `Standard Residential Phases` + `Standard QA` + `Standard Decision Checklist`. Editing
   the preset doesn't touch already-created projects.

Example — composing SamBunglow à la carte:

```
Ground Floor (zone module)
  + Living Room (space)      + Kitchen (space)     + Entrance (space) → Main Door (element)
Second Floor (zone module)
  + Master Bath (space)      + 2× Bedroom (space)
Terrace (zone module)        + Waterproofing inspection set (discipline)
Standard Residential Phases (schedule)   +   Interior Finishes decision checklist (discipline)
```

---

## What travels vs what's stripped

A template captures **structure and intent**, never a prior project's **actuals**.

| Travels (the skeleton, lands as **drafts**) | Stripped (actuals — never copied) |
|---|---|
| Location nodes (zones/rooms/objects) | Approvals, statuses, gate states |
| Phase + activity names, planned offsets | Real dates, actual start/end, costs |
| Inspection checklist definitions (titles + items) | Submitted/decided state, rejections, photos |
| Decision titles + option scaffolds (unfilled) | Chosen options, approvers, attendance |
| Consultant/company **roles** (optional) | Specific people, contact details, PII |
| — | Notifications, audit trail |

Everything instantiated arrives as a **draft** (reusing the existing draft lifecycle) so the PMC
refines and **publishes** progressively — "prefilled, guiding; refined as the project progresses."

---

## The instantiate flow

```
1. Choose modules (preset or à la carte) + params (counts, graft targets).
2. Resolve into a plan: which zones/rooms/elements, which phases/activities,
   which inspection defs, which decision drafts — with suffixed names, collision-safe.
3. In one transaction, stamp into the target project as DRAFTS:
     • ProjectNodes  (graft subtrees under chosen/created parents; kinds enforced)
     • Phases + planned Activities  (offsets only, no actual dates)
     • Inspection definitions
     • Decision drafts (author = the instantiating PMC)
4. Nothing is published; the Site Map / schedule / drafts workspace now show the skeleton.
5. PMC refines per project and publishes as each part firms up.
```

**Customization = a copy, not a live link.** The instantiated content is an independent copy; editing
it never affects the module, and updating a module never touches existing projects. (A future
"pull module improvements into this project" sync is explicitly **out of scope for v1**.)

---

## Data model (sketch)

Org-scoped, additive, versioned. Content stored as JSON payloads so a module stays self-contained
and easy to evolve (the instantiate service is the only reader/writer of the payload shape).

```prisma
model TemplateModule {
  id          String   @id @default(cuid())
  orgId       String
  name        String                 // "Kitchen", "Waterproofing QA"
  category    String                 // space | zone | element | discipline | schedule
  anchorKind  String?                // zone | room | element | null (project-level)
  version     Int      @default(1)
  description String?
  payload     Json                   // { nodes?, phases?, activities?, inspections?, decisions? }
  archivedAt  DateTime?
  createdAt   DateTime @default(now())
  @@index([orgId, category])
}

model ProjectTemplate {              // a named preset = an ordered module selection
  id          String   @id @default(cuid())
  orgId       String
  name        String                 // "G+2 Residence"
  version     Int      @default(1)
  items       Json                   // [{ moduleId, count?, defaultParent? }, …]
  description String?
  archivedAt  DateTime?
  createdAt   DateTime @default(now())
  @@index([orgId])
}
```

Notes:
- **JSON payloads** avoid a heavy relational template mirror of every entity; the instantiate
  service validates the payload with a Zod schema shared conceptually with the domain types.
- **Versioning** is a simple integer bump (new version = new row or `version++`), so a preset can pin
  a module version if we later want reproducibility. v1 can treat versions as informational.
- Fits the tenancy model exactly: templates are **methods** (org-level, reusable), which
  [`TENANCY.md`](./TENANCY.md) already carves out as legitimately org-scoped — unlike *instances*
  (a real decision/inspection), which are always project-scoped. An instantiated occurrence always
  gets a `projectId` (and usually a `nodeId`); the module is the method, the instance is the work.

---

## How it reuses what already exists

- **Draft lifecycle** — instantiated content = drafts (`publishedAt` null, `authorId` = the PMC).
  No new "prefilled but private" mechanism needed; the Drafts workspace + per-item Publish already
  cover it.
- **Location spine** — modules *are* partial spines; grafting is the existing zone→room→element
  create logic (kind rules, cascade-safe) run in bulk.
- **Phases / inspections / decisions** — all already exist as authored entities with create paths;
  instantiation is "author these, as drafts, from a payload."
- **Org scoping** — reuses `Org` + org owner/admin authority; templates are managed by the same
  roles that create projects.

---

## Build slices (proposed, once the design is agreed)

| # | Slice | Value | Cost |
|---|---|---|---|
| **0** | ✅ **This design doc** + review | alignment | — |
| **1** | ✅ **Duplicate structure from an existing project** into a new one — `createProject` takes `structureFrom`; the copy engine clones the tree (as drafts), phases, planned activities (actuals stripped, `ok\|fail` gates → `wait`, `na` kept as structural) and checklist definitions (item names only), remapping every id; the New-project modal gains a **"Start from"** picker. Same-org, unarchived sources only. | fixes the empty Site Map **now** | small (project→project copy service) |
| **2** | ✅ **TemplateModule** model (org-owned, Zod-validated JSON payload, informational version) + the **module menu** (`GET/POST/DELETE /orgs/:id/modules` — create from an explicit payload or **extracted from a live project**: a zone's subtree via `fromNodeId`, or the whole project) + **à-la-carte composition at Create Project** (`modules: [{moduleId, count, underZone}]` — count suffixes root names "Kitchen 1/2", room-anchored modules graft under a by-name found-or-created zone, phases merge by name; everything lands as drafts). UI: a **Save-as-module** control on zone rows in the Locations editor + an **Add modules** menu in the New-project modal. Element-anchored modules are stored but not yet placeable at create (need a room target — a later slice). | the modular menu | medium (model + migration + UI) |
| **3** | **ProjectTemplate** presets + "save this project's structure as a template" + "save selection as a module" | the reusable library | medium |
| **4** | **Seed Vitan's real modules** (residence spaces, standard QA, standard decisions) so new projects start rich | never-blank projects; also closes the API-seed gap from the data-flow audit | small |

Slice 1 is the recommended first build: it removes today's pain and exercises the engine before we
commit to the module schema.

---

## Decisions (v1)

Recorded when the design was adopted; each can be revisited when the module slices land.

1. **Module granularity** — **room-level** ("Kitchen" as one module) is the default grain; objects
   ride inside their room's module rather than being modules themselves.
2. **Auto-attach vs manual** — **opt-in**: a space module's inspections/decisions are offered at
   instantiate, not silently attached, so the PMC composes deliberately.
3. **Instantiated content = drafts** — yes. The skeleton arrives private (the existing draft
   lifecycle) and is published progressively as the project firms up.
4. **Template source** — templates/modules come from projects a PMC **explicitly promotes**
   ("save as template"), not implicitly from every project. (Slice 1's `structureFrom` copy is the
   one exception by design: any same-org project can be a one-off starting point.)
5. **Versioning in v1** — **informational** (a version number + notes); pinned reproducible
   versions can come later if presets need them.
6. **Library shape** — **one shared org library**, with the menu grouped by module category;
   project-type folders only if the library outgrows a single list.
