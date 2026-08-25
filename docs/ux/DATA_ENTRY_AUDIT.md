# Data-entry friction audit

Measured against `main` before Unit A. The question behind every row is the product
principle: *does the system ask for anything it could have worked out for itself?*

Interaction counts are from the code, not estimates. "Steps" means navigation taps plus
field entries plus confirmations, from wherever the user happens to be standing.

## 1 · Mobile

| Workflow | Steps | Truly required | Already known | Avoidable effort |
|---|---|---|---|---|
| Decision (pmc) | ~10 | title, `nodeId`, 2 options × material | project, author, date | location never inherited |
| Activity (pmc) | 4 taps past **9 flat controls** | name, `plannedStart`/`End` **as day-offset integers** | project, author | free-text `zone` duplicates the LocationPicker; day-numbers leak the timeline model |
| Inspection (pmc) | ~9 | title, **`zone` string (required)**, ≥1 item | project, author, date | location typed *then* optionally picked, with the canonical field as the optional one |
| Photo (eng) | 6–10 | the file | project, user, time, place | gated behind starting a daily log; **no caption field exists** |
| Daily update (eng) | 2 | — | project, user, date | fine as a container, wrong as a gate on photos |
| Material delivery (eng) | 5–6 | name, qty | project, user, date | `zone` text beside the picker again |
| Drawing (pmc) | ~8 | number, title, discipline, rev, file | project, author, date, **issuer's own discipline** | discipline is inferable from membership |
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
4. **Photo capture.** Gated behind a daily log; no description field; and the UI claimed
   *"Geo + time stamped, tied to activity"* while `addProgressPhoto` sent none of
   `takenAt`/`geoLat`/`geoLng` (all three accepted by `UploadMediaInput`) and media carries
   no activity link at all.
5. **Decision creation.** Location never inherited, and no way to raise a decision from the
   place it concerns.

## 4 · Fields that disappear through context

| Field | Appears in | How it goes |
|---|---|---|
| project | every flow | already scoped — never asked (already correct) |
| `nodeId` | decision, activity, inspection, material, photo | inherited from the surface; shown as `Master Bathroom · Change` |
| `zone` (free text) | activity, inspection, material | **derived** from `nodeId` by `zoneLabelFor` |
| author, date, time | all | already server-derived |
| `takenAt`, geo | photo | sent, rather than claimed |
| `phaseId` | activity | defaultable from place or last use |
| `discipline` | drawing | defaultable from the issuer's membership |
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
        ↓  MoreDetails      — folds away what the domain does not require
the existing store commands, outbox, permissions and validation
```

Nothing new sits behind the interaction layer. A phone and a desktop produce the same
records under the same rules; only the entry point's placement differs.

## 7 · Mobile navigation: not yet

`splitMobileNav` fills four primary slots from `MOBILE_PRIMARY_PREFERENCE`, then from the
role's own filtered list. A central `+` costs one slot:

| Role | Loses from the bar | Verdict |
|---|---|---|
| pmc | Portfolio | fine — the project switcher in the header already carries a Portfolio row, gated on the same `useNavItems()` filter |
| engineer | **Daily Log** | harmful today: Daily Log is where every engineer capture lives. `+` must come *after* capture moves out of it |
| contractor | forces a More sheet where five screens fit exactly | net loss; four narrow create permissions |
| consultant | same | **zero** create permissions |
| client | — | approves and requests changes, never creates |

The header switcher does make a permanent Portfolio tab unnecessary. The freed slot should
not become `+` until Unit C gives it destinations, and `+` should render only for roles that
can author something.

## 8 · Effort, before and after

| Workflow | Before | After Unit A | Target |
|---|---|---|---|
| Decision from a place | ~10 steps, location re-picked | **5**, location inherited | 4 |
| Inspection from a place | ~9, location entered **twice** | **4**, asked once | 3 |
| Material from a place | 5–6 | **4** | 3 |
| Site observation | **impossible** | still impossible | 3 |
| Desktop photo | file dialog only | unchanged | 2 (drag/paste) |

## 9 · What Unit A does not fix

- **Quick Capture has no home.** No existing mechanism carries a placed, described
  observation authored by a non-PMC: decision and drawing drafts are pmc-only, `MediaRef`
  and `UploadMediaInput` carry no text and `kind` is a closed union, `flagMismatch` is
  material-bound, and a checklist note needs a PMC-issued checklist first. The agreed
  direction is one caption column on media plus a `note` kind — the smallest change that
  makes an observation authorable by everyone who can already upload a photo.
- **The Activity form** keeps its nine flat controls and its day-offset dates.
- **Desktop density**: no command entry, no drag/drop, no paste, no split views.
- **The universal `+`** and its device-specific shells.
