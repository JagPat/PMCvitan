# Data-entry friction audit

Measured against `main` before Unit A, which merged as #424. The question behind every row
is the product principle: *does the system ask for anything it could have worked out for
itself?*

The "before" columns are the state this audit found. Where Unit A changed something, §8 says
so; §9 lists what it deliberately left, including the two pieces split out of it and not yet
on `main`.

Interaction counts are from the code, not estimates. "Steps" means navigation taps plus
field entries plus confirmations, from wherever the user happens to be standing.

## 1 · Mobile

| Workflow | Steps | Truly required | Already known | Avoidable effort |
|---|---|---|---|---|
| Decision (pmc) | ~10 | title, `nodeId`, 2 options × material | project, author, date | location never inherited |
| Activity (pmc) | 4 taps past **9 flat controls** | name, `plannedStart`/`End` **as day-offset integers** | project, author | free-text `zone` duplicates the LocationPicker; day-numbers leak the timeline model |
| Inspection (pmc) | ~9 | title, **`zone` string (required)**, ≥1 item | project, author, date | location typed *then* optionally picked, with the canonical field as the optional one |
| Photo (eng) | 6–10 | the file | project, user | gated behind starting a daily log; **no caption field exists**; the place is an optional hand-pick and the capture time is never sent — see §4 |
| Daily update (eng) | 2 | — | project, user, date | wrong as a gate on photos — and **not currently a container either**, see §9 |
| Material delivery (eng) | 5–6 | name, qty | project, user, date | location never inherited (its `zone` text is storage detail, **not** a duplicate — see §4) |
| Drawing (pmc) | ~8 | number, title, discipline, rev, file | project, author, date | discipline is **not** inferable — see §4 |
| Places creation | — | name, kind | parent from selection | lives under the Decision Log, not under Places |
| Assignment | — | — | — | **no assignment field on any create form** |
| Note / observation | — | — | — | **does not exist** |

## 2 · Desktop

Every creation modal is shared byte-for-byte with mobile. Navigation is cheaper (the
LeftRail is always visible, one click to any screen); nothing else is better.

| Workflow | Steps | Desktop-specific friction |
|---|---|---|
| Decision | ~6 clicks + 3 typed | a 560px modal on a 1920px screen; options stack vertically where side-by-side would let them be compared |
| Activity | 3 clicks | 9 controls in a 480px column; no inline row editing, no drag to reschedule |
| Inspection | 3 clicks | checklist items added one at a time; no paste-a-list |
| Photo | 4–6 | **no drag/drop, no paste** — the two things a desktop user tries first |
| Material | 3 clicks | no bulk entry for a multi-line delivery note |

Structural:

- **No keyboard affordance** beyond `Escape` (Modal, PhotoViewer, MobileSheet) and `Enter`
  inside individual inputs. No global handler, no command entry.
- **No drag/drop and no paste handler anywhere in the codebase.** File input only.
- Content is capped at `--content-max: 1120px`, single column. A 1920px desktop renders the
  same one-column layout as a tablet; there is no split view or master–detail anywhere.
- **One search box in the product** (`decision-search`) and **one bulk action**
  (Drafts → Publish all).

## 3 · The five highest-friction workflows

Ranked by *thinking* effort. A user having to decide which backend module owns a record is
expensive even when it costs one tap.

1. **Recording a site observation.** Not slow — impossible. `inspection.create`,
   `decision.create` and `activity.manage` are all `['pmc']`. An engineer's whole
   "something is wrong" vocabulary is: fail an item on a checklist the PMC already issued,
   flag a material mismatch, or add a caption-less photo. Contractor, consultant and client
   have nothing at all.
2. **Inspection creation.** Location asked twice, and the *legacy* free-text field is the
   required one while canonical `nodeId` is optional.
3. **Activity creation.** Nine flat controls, no disclosure, and planned dates entered as
   day-offset integers — the user must understand the schedule anchor to enter a date.
4. **Photo capture.** Gated behind a daily log; no description field; and the UI claims
   *"Geo + time stamped, tied to activity"* while `addProgressPhoto` sends none of
   `takenAt`/`geoLat`/`geoLng` (all three accepted by `UploadMediaInput`) and media carries
   no activity link at all — and the place is hand-picked too. Of the four facts a photo
   could arrive with, it arrives with two: the project and the user. Its correction is a
   separate unshipped unit; see §9.
5. **Decision creation.** Location never inherited, and no way to raise a decision from the
   place it concerns.

## 4 · Fields that disappear through context

| Field | Appears in | How it goes |
|---|---|---|
| project | every flow | already scoped — never asked (already correct) |
| `nodeId` | decision, activity, inspection, material | inherited from the surface; shown as `Master Bathroom · Change` |
| `nodeId` on a **photo** | photo | **NOT inherited.** Unit A wired `CaptureContext` into the three modals and never into photo capture: `DailyLogScreen` still holds a `photoNode` that starts null behind an optional `LocationPicker`. A photo is the one record type still asked for its place by hand — see §9 |
| `zone` (free text) | inspection | **derived** from `nodeId` by `locationLabelFor` (the full path, as the existing data writes it) |
| `zone` on an **activity** | activity | **still asked twice.** `PlanActivityModal` keeps `zone` and `nodeId` as independent inputs and submits `zone.trim()` with no `locationLabelFor` call, so a node can be picked while the free text stays empty or contradicts it. Unit A derived `zone` for the checklist only — see §9 |
| `zone` on a **material** | material | **NOT derivable** — it holds storage detail ("covered, on pallets"), so it stays a question |
| author, date, time | all | already server-derived |
| `takenAt`, geo | photo | **not sent.** The upload is `{ kind, mime, data, nodeId? }`, so for a photo queued offline the eventual *upload* time stands in for the capture time. Sending them is its own unit — see §9 |
| `phaseId` | activity | defaultable from place or last use |
| `discipline` | drawing | **NOT derivable.** `MembersService.disciplineFor` stores a discipline only for `consultant` and clears it for every other role, while `drawing.issue` is `['pmc']` — so the only role that may issue never has one. An earlier draft of this audit claimed otherwise, reading the consultant's *read*-scoping in `DrawingsScreen` as if it were the issuer's. Simplifying this field needs a different source of truth, not a default |
| `plannedStart`/`End` | activity | civil dates with defaults, not offsets |
| swatch, price delta, decision link | decision, material | secondary — under More details |

## 5 · What is NOT UI bloat

Two long forms are long for real reasons, and shortening them would offer saves the server
refuses:

- **A decision needs 2–4 options.** `contracts.ts` pins `options.min(2).max(4)`. A decision
  with one option is not a decision. The options stay visible; only what an option
  *optionally* carries folds away.
- **A checklist needs at least one item.** An empty checklist asks the engineer nothing.

Only a mandatory domain rule may block a save, and only a mandatory domain rule may stay in
the opening form.

## 6 · Architecture

```
CaptureContext { projectId, nodeId, activityId, source }   ← derived, never stored
        ↓
createOptionsFor(role)     ← the existing ROLE_POLICY is the only authority
        ↓
CreateMenu                 ← one option list for both devices
        ↓
the existing modals, each taking `context?`
        ↓  InheritedContext — states the place, offers Change
        ↓  MoreDetails      — folds away what the domain does not require  (NOT YET SHIPPED)
the existing store commands, outbox, permissions and validation
```

`MoreDetails` is the one box above that is not yet on `main`: progressive disclosure is §10
of the brief, a principle of its own, and it went to its own review unit.

Nothing new sits behind the interaction layer. A phone and a desktop produce the same
records under the same rules; only the entry point's placement differs.

## 7 · Mobile navigation: not yet

`splitMobileNav` fills four primary slots from `MOBILE_PRIMARY_PREFERENCE`, then from the
role's own filtered list. A central `+` costs one slot:

| Role | Loses from the bar | Verdict |
|---|---|---|
| pmc | Portfolio | **not free yet.** The switcher's sheet does carry an *All projects (Portfolio)* row on the same `useNavItems()` filter — but `useProjectSwitch` sets `canSwitch = memberships.length > 1 \|\| Boolean(adminOrg)` and `TopBar` *disables* the button when that is false. A PMC on a single project who administers no org cannot open the sheet at all |
| engineer | **Daily Log** | harmful today: Daily Log is where every engineer capture lives. `+` must come *after* capture moves out of it |
| contractor | forces a More sheet where five screens fit exactly | net loss; four narrow create permissions |
| consultant | same | **zero** create permissions |
| client | — | approves and requests changes, never creates |

The header switcher makes a permanent Portfolio tab unnecessary **only for a user who can
open it**. `canSwitch` asks whether there is anything to switch *between*; it was never meant
to gate a link to a screen. So freeing that slot carries a prerequisite of its own: either
the sheet opens whenever its contents are reachable, or Portfolio keeps a second route. Even
then the slot should not become `+` until Unit C gives it destinations, and `+` should render
only for roles that can author something.

## 8 · Effort, before and after

Counted the same way on both sides, per the definition at the top: navigation taps **plus**
field entries **plus** the confirmation. Creating from a place costs TWO entry taps — `Add
here`, then choosing the record type — and an earlier version of this table omitted them
from the "after" column while counting the equivalent taps in "before". The comparison was
therefore flattering itself by one step in every row.

| Workflow | Before | After Unit A | Floor |
|---|---|---|---|
| Decision from a place | ~10 steps, location re-picked | **6**, location inherited | **6 — already there** |
| Inspection from a place | ~9, location entered **twice** | **5**, asked once | **5 — already there** |
| Material from a place | 5–6 | **5** — see below | **5 — already there** |
| Site observation | **impossible** | still impossible | 4 |
| Desktop photo | file dialog only | unchanged | 2 (drag/paste) |

An earlier version of this column set *targets* of 4 / 3 / 3 for the first three rows. They
are not reachable, and a measurement document does not get to publish goals it has not
checked against its own arithmetic. Each place flow spends two entry taps (`Add here`, then
the record type) and one confirmation, and what sits between them is the fields the server
refuses to save without: a title and two option materials for a decision, a title and one
item for an inspection, a name and a quantity for a delivery. 2 + 3 + 1, 2 + 2 + 1, 2 + 2 + 1
— **6 / 5 / 5, which is exactly where Unit A landed.**

That is the more useful finding and it was hidden behind the wrong number: these three flows
are at their floor. No further field can come out without the API rejecting the save, so
§5's two long forms are not the only things a mandatory rule protects — the whole remaining
length of all three is mandatory.

The one lever left is the entry model rather than the form. A `+` that opens a record type
directly from the place already on screen would spend one tap where two are spent now, making
the floor 5 / 4 / 4 — and that is the *only* thing that moves these rows. It is §7's subject,
and §7's answer is still "not yet". The observation row's 4 assumes the same two entry taps
plus a description and a confirmation, since that flow does not exist to measure.

**A delivery's tap count did not improve, and the row should not pretend otherwise.** Five
before, five after. What changed is what the record carries: the location now arrives with
it, where before it was either absent or cost extra taps to pick. The remaining wins in
this row are the ones §9 still lists as unshipped.

## 9 · What Unit A does not fix

- **Quick Capture has no home.** No existing mechanism carries a placed, described
  observation authored by a non-PMC: decision and drawing drafts are pmc-only, `MediaRef`
  and `UploadMediaInput` carry no text and `kind` is a closed union, `flagMismatch` is
  material-bound, and a checklist note needs a PMC-issued checklist first. The agreed
  direction is one caption column on media plus a `note` kind — the smallest change that
  makes an observation authorable by everyone who can already upload a photo.
- **A progress photo is not bound to its daily log.** `media` accepts a `dailyLogId`
  (`media.service.ts` resolves and project-checks it), but the web's `UploadMediaInput` has
  no such field, so `addProgressPhoto` never sends one — and `SnapshotService` folds
  **project-wide** `kind: 'progress'` media, attaching the newest 12 to whichever log is
  current. A day-two log therefore shows day-one photos in its gallery.

  The failure is the gallery's scope, and only that. An earlier version of this bullet said
  the log also *counted* those photos as today's progress; it does not, and the distinction
  decides where a fix belongs. `DailyLog.progress` is `@default(0)` and is written in exactly
  one place — `daily-log.submit`, from a number the engineer supplies (`daily-log.service.ts`
  writes `progress: input.progress`). It is self-reported at submission and never derived
  from media at all; `addProgressPhoto` increments it in the client only, which is what made
  it look like a photo count. So a day-two log shows day-one photos beside a count of zero,
  and a fix that adjusted the count would be repairing the wrong thing.

  It is NOT fixed by the capture-stamp unit below either: adding `takenAt` makes the
  mis-binding *visible* — yesterday's date in today's gallery — without correcting it. Either
  the upload carries its log and the gallery is scoped to it, or progress photos are defined
  as project-wide and the daily log stops presenting them as its own.
- **The photo capture stamp — and the photo's place.** The stamp is its own review unit:
  making the daily log's "geo + time stamped" claim true is about what a photo *carries*.
  The place is a second gap in the same flow, and a gap this audit originally hid by listing
  both as context a photo already has. Neither is: `photoNode` starts null behind an optional
  picker, and the upload sends no `takenAt`.
- **Progressive disclosure.** Also its own unit. Folding a form's optional fields under
  More details is §10 of the brief; Unit A did the §3 half. Both modals therefore still
  show every optional field today.
- **The Activity form** keeps its nine flat controls, its day-offset dates, and the
  duplicate location question. `zone` and `nodeId` are still independent inputs there, so
  picking a place leaves the free-text field to be typed anyway — or left contradicting it.
  Unit A derived `zone` for the checklist only, and §4 briefly claimed the activity with it.
- **Desktop density**: no command entry, no drag/drop, no paste, no split views.
- **The universal `+`** and its device-specific shells.
