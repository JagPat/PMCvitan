# UX Completion Programme — master brief (v2)

**Base:** `JagPat/PMCvitan @ main`, tree `a35439439a30`
**Scope:** Mandates A, C, E, F (the standalone-V1 gap programme). Mandates B and D are owned by Task 4 and the Phase 6 collaborator units and are **out of scope here**.
**Status:** docs-only UX completion plan. Not implementation-ready for Waves 3–4 until the open questions in §6 are settled.

> **Re-audit required before use.** These findings were reproduced at `a35439439a30`. Task 4 and the remaining Phase 6 collaborator work land first and *will* change the interface inventory. Re-run every reproduction step against the post-Phase-6 head, and re-derive §5 from the final screen list, before planning any unit.

### v2 corrections
Four claims in v1 were wrong or overstated and are corrected below. They are listed openly because a code agent may have already read v1.

| v1 claim | Correction | Verified at |
|---|---|---|
| "Mistri and worker are not first-class roles — 2 personas unmodelled" | **Wrong.** `Worker` is a first-class domain entity and mistri responsibility is modelled as crew in-charge. What is missing is a dedicated *experience* for each, not a domain model. | `packages/shared/src/domain/types.ts:504` (`interface Worker`); `packages/shared/src/contracts/labour.ts:162` (`inchargeWorkerId`) |
| "Done is correctly wired and does not need rebuilding" | **Overstated.** Done *is* a distinct store action, but no durable `worker.*` command exists anywhere on the server. All three commands need durable treatment. | `store/store.ts:4654` (local action only); no match for `commandType:'worker…'` in `apps/api/src/labour` |
| "Accent `#b4462e` must clear 3:1 on both surfaces" | **Impossible as written.** Accent-on-ink measures **2.95:1**. The v1 `--focus-ring-dark` token was itself non-compliant. | Computed: accent L=0.1428, ink L=0.0153 → 2.95:1 |
| "Wave 0 — diff S, all 23 surfaces, one unit" | **Too large.** Split into three units (F-1a/b/c). | Review-unit limit |

---

## 1. Reproduced evidence

Each row is a counted failure with its citation. **Re-run each before planning its correction.**

| # | Mandate | Finding | Evidence | Metric |
|---|---|---|---|---|
| 1 | A | Mobile tab bar renders every role screen, uncapped. `flex:1` per tab; PMC has 13 destinations sharing 360px. `.label` sets `text-overflow:ellipsis`, so labels truncate — explicitly forbidden. Bar height (62px) already passes. | `layout/BottomTabs.tsx:10`, `BottomTabs.module.css`, `lib/screens.ts:screensFor` | **27.7px** vs 44px floor |
| 2 | C | No durable worker commands. `Done` is a distinct store action but mutates local state only; `Photo` and `Problem` both route to `speakJob`, the same handler as Listen. No `worker.*` command type exists server-side. **All three need building.** | `TeamAccessScreen.tsx:586, 590, 594`; `store.ts:4654`; no `worker.*` commandType in `apps/api/src/labour` | **0 of 3** durable |
| 3 | C | "Listen" provides no audio at any layer. | no match for `speechSynthesis|Audio` in `apps/web/src`; `store.ts:4650` | **0** audio paths |
| 4 | F | No focus indicator anywhere; `outline` actively removed. Zero `:focus-visible` rules app-wide. WCAG 2.2 AA 2.4.7 failure. | 0 matches for `:focus-visible`; `outline:none` at `DailyLogScreen:401`, `DecisionLogScreen:517`, `InspectionReviewScreen:265`, `ScheduleScreen:519`, `TeamScreen:601`, `ProjectSwitcher:238`, `DrawingsScreen:494`, `TeamAccessScreen:684`, `LocationPicker:22`, `modals/ChangeModal:12`, `EngineerChecklistScreen:150`, `TopBar.module.css:68` | **0** focus rules |
| 5 | F | Every mobile text input below the 16px floor; under 16px iOS Safari zooms on focus and does not zoom back. | `CommercialScreen:662` (12.5), `EngineerChecklistScreen:150` (13), `DailyLogScreen:401` / `DecisionLogScreen:517` / `InspectionReviewScreen:265` / `ScheduleScreen:519` (13.5), `TeamScreen:601` / `ProjectSwitcher:238` (14) | **8** field styles |
| 6 | F | Essential information in 8–9.5px metadata type; mismatch control is a 9.5px text button with `padding:0`. | `EngineerChecklistScreen:144`, `:166`; `DailyLogScreen:171`, `:182`, `:249`; `DrawingsScreen:235` | **6+** critical lines |
| 7 | F | Four surfaces ask users to type an internal identifier. (Device ID is a *fifth* but is a different problem — see §6.4.) | `CommercialScreen:1013` vendorId, `:1020` poLineId, `:1669` vendorId, `:2197` activityId | **4** raw ID inputs |
| 8 | E | Translation exists but not on field workflows. Coverage is **partial, not absent** — `DailyLogScreen:232` already translates via `labourLabels[lang]`, proving the pattern works and simply has not been extended. | `i18n/i18n.ts:14` `ns:['access','trades','workerTrades']`; `i18n/useT.ts:18` | **3 of 7** namespaces |
| 9 | Structural | Worker and mistri identities exist in the domain but have **no dedicated experience**. `Role` (the app-shell union) excludes worker; both currently live only as steps inside `TeamAccessScreen`. | `domain/types.ts:16,72,504`; `contracts/labour.ts:162`; `lib/screens.ts:screensFor` | **2** experiences missing |

**On finding 9 — do not add worker/mistri as full application-shell roles.** They are already modelled. Connect the existing `Worker` entity and crew-in-charge relationship to dedicated, narrow experiences (the job card; the trade-in-charge task list). Widening the shell `Role` union would grant navigation and authority neither persona should have.

---

## 2. The stages

A foundation stage plus five waves — six in all. Ordered by **dependency**, not mandate letter.

### Wave 0 — Foundation · units `F-1a` → `F-1b` → `F-1c`
Three review units, **run in order**: `F-1c` validates the work of the other two and must follow both. Full spec: `WAVE_0_FOUNDATION.md`.
- **F-1a — primitives + dialog focus.** Focus tokens; `:focus-visible` on shared primitives; focus trap in `Modal.tsx` and the 4 dialogs (`ApproveModal`, `ChangeModal`, `QrModal`, `PhotoViewer`); `ProjectSwitcher` is a non-modal disclosure per the Wave-0 amendment (2026-08-15).
- **F-1b — mobile field and touch corrections.** 8 field constants to 16px; critical type off 9px; mismatch control to 44×44.
- **F-1c — per-surface validation.** The 23-surface sweep plus Playwright, automated a11y, and manual keyboard/screen-reader passes.

**Why first:** every later unit needs accessibility checks and keyboard verification, and none can pass while focus is invisible app-wide.

### Wave 1 — Shell and responsive · unit `A` · M
Cap mobile primary nav at 5 with a role-aware More sheet; client large-screen scale-up.
**Why here:** isolated to `layout/`. Before the content waves because acceptance scripts navigate — testing translated screens through a broken tab bar confuses two failures into one.

| Role | Now | Tabs | Behind More |
|---|---|---|---|
| pmc | 13 | For You · Dashboard · Schedule · Decisions · More | Drafts, Inspection Review, Drawings, Materials, Labour, Commercial, Site Map, Team, Portfolio |
| engineer | 11 | For You · Daily Log · Checklist · Schedule · More | Drawings, Materials, Labour, Commercial, Site Map, Team Access, Decision Log |
| client | 6 | For You · Decisions · Health · Drawings · More | Decision Log, Site Map |
| contractor | 5 | For You · Drawings · Site Map · Access · Log | — stays flat |
| consultant | 5 | For You · Drawings · Decisions · Site Map · Health | — stays flat |

Contractor and consultant already sit at five: **do not add a More sheet there.**
5 tabs at 360px = 72px each. Label 11px; **remove `text-overflow:ellipsis`** — if a label cannot fit, shorten `short` in `SCREEN_META` rather than truncating at runtime. Left rail unchanged. More-sheet rows ≥44px.

**Client scale-up** (`ClientHealthScreen`, `ClientDecisionsScreen`): base 16px → **18–20px** desktop; measure capped ~640–720px and centred; thumbnails and photos enlarged; respect OS Dynamic Type and browser zoom. The client may be elderly reading on an iPad at home — the layout must *grow up*, not merely widen.
Engineer and worker surfaces stay **single-column and large-target even on tablet**.

### Wave 2 — Field language · unit `E` · M
Add `daily-log`, `checklist`, `attendance`, `issues` namespaces for **en / hi / gu**, covering validation, offline and error messages — not only visible labels. Pair every icon-only control with a short word.
**Why here:** extends a mechanism that already works, and lands before pickers so picker strings inherit the same namespaces.
Never rely on colour alone, technical IDs, long instructions or specialist terminology.

### Wave 3 — Business language · unit `F-2` · L
Replace the **four** raw identifier inputs with searchable pickers scoped to project and company.
**Splitting is mandatory:** `CommercialScreen.tsx` is 162 KB and holds all four. Extract the shared picker component first and adopt it flow by flow, or split by flow — lodge claim / advance / measurement. **Decide before the wave opens.**
Leave alone: `Site code`, `Template name`, `Descriptor`, OTP `6-digit code` — legitimate business language.
Device ID is **not** part of this unit — see §6.4.

### Wave 4 — Worker experience · unit `C` · L
**Blocked on §6.2 and §6.3.** Do not start UI work until worker-device binding and session design are settled.
All three commands — Done, Photo, Problem — become idempotent durable commands with offline outbox support, evidence, retry and idempotency. Honest **queued / failed / retrying / completed** states per button plus a card-level summary with retry. Never report success for a local-only or failed operation.

**Listen — audio needs two layers, and the source must be settled before UI work.**
- **Fixed controls** (Done, Photo, Problem, and standing instructions): bundled versioned recordings in en/hi/gu, shipped as cached assets.
- **Project-specific content** (the task description, the approved material name): these change per assignment and cannot be bundled. Use an **attributable voice briefing recorded by the engineer or PMC**, bound to the assignment revision or fingerprint, cached offline, and re-recorded when the assignment changes so a stale briefing can never play against a new job card.

Browser speech synthesis is **not acceptable for either layer**: it cannot guarantee a Hindi or Gujarati voice is installed, and it cannot be relied on offline — which is precisely when the guidance is needed.
**Preserve exactly:** the no-navigation job-card model, no typing, large targets, picture-first layout.

### Wave 5 — Observed acceptance · GATE
See §4. Only this closes the gate.

---

## 3. Backend wiring

| Wave | Backend work |
|---|---|
| 0 | **None.** Pure presentation. |
| 1 | **None.** Nav derives from `screensFor` + `enabledModules` + `capabilities`, already client-side. |
| 2 | **Yes — error contracts.** The client cannot translate English prose from the API. Any validation/error on a field path must return a **stable machine code** the client maps to a localized string. Audit field-path endpoints and add codes where they return prose. |
| 3 | **Mostly none — verify first.** `GET /projects/:projectId/vendors` **already exists** (`procurement/vendors.controller.ts:52`, `listForProject`), project-scoped, so the vendor picker is a frontend change against an already-contained endpoint. Confirm equivalent scoped reads for **PO lines** and **activities**; add only what is missing, following the existing controller/service/manifest pattern. **Do not widen authorization to make a picker convenient** — a missing list read may be a deliberate containment boundary. |
| 4 | **Yes, substantial.** Three durable worker commands with idempotency; the repo pattern is `commandType` + `idempotencyKey` + `requestHash` (`procurement/vendors.service.ts:53`) — follow it exactly so same-key retry never double-posts. Plus worker-device binding and session (§6.2), evidence storage, and **two audio layers**: hosted versioned assets for fixed controls, and storage plus assignment-bound invalidation for the recorded voice briefings (§6.6). |

**Module boundaries stand.** Cross-module access goes through the participant per the existing manifest pattern.

---

## 4. Verification

Per unit: reproduce-first **RED** evidence · focused component/integration tests · Playwright at **360×800, 390×844, tablet, desktop** · automated accessibility checks **plus manual keyboard and screen-reader verification** · offline / lost-response / same-key retry tests for field commands · role and project/company containment tests · no overflow, overlap or clipped controls · full CI and **exact-current-head Codex clearance**.

### Wave 5 — observed sessions with real people

> **Amendment (2026-08-15, autonomous loop — ownership clarification, not a
> scope change):** this gate is an OWNER-EXECUTED acceptance act, not an
> autonomous-loop obligation. The loop's deliverable ends at "every wave
> implemented, verified, and READY for observed sessions" — it never blocks
> awaiting them (AGENTS.md's non-blocking rule), and the standalone-V1
> COMPLETION declaration is made by the owner after their sessions. The
> requirement itself stands exactly as the owner wrote it below; only the
> actor is named.

**Claude, Codex and CI cannot certify this. It requires observed sessions with actual stakeholder representatives** — PMC, architect, client, contractor, mistri and worker participants — recorded with completion time, assistance required, mistakes, abandoned actions and unresolved confusion.

| Persona | Device | Task | Pass if |
|---|---|---|---|
| PMC / project manager | Desktop | Open cold, find every decision ageing >5 days with the client | No assistance; correct set first try |
| Site engineer | Phone 360×800 | No signal: check in, log crew, capture a failed checklist item with photo + note, submit | Queued states honest; nothing reports false success |
| Architect | Desktop | *See §6.5 — scenario unsettled* | — |
| Client | iPad | Read what is waiting, approve one option, then find it locked in the register | Text readable unaided; lock and attribution understood |
| Contractor | Phone | Find the current approved drawing package for one location, confirm the approved material | Only authorized packages visible; no ID typing |
| Consultant | Desktop | Open an assigned matter, record a consultation response, return it without approving | No approval authority exposed in the path |
| Mistri / trade in-charge | Phone 390×844 | Sign in, see today's trade tasks, confirm the approved fitting brand | No English-only strings; no internal identifiers |
| Low-literacy worker | Phone / kiosk | Be recognised without typing, understand the task from picture + spoken guidance alone, report a problem with a photo | Completed without reading English; problem reaches the engineer |

The "generate the weekly report" step was removed from the PMC scenario — see §6.1.

---

## 5. Surface map

24 surfaces: 18 screens plus 6 shared dialogs/pickers (`components/PhotoViewer` added 2026-08-15 — it is one of the four true dialogs and was missing from the map). **Re-derive this list after Phase 6 closes.**

| Surface | Waves | What changes | Effort |
|---|---|---|---|
| `DailyLogScreen` | 0, 2 | Heaviest language work; mismatch control to 44×44; presence proof off 9px | L |
| `TeamAccessScreen` | 0, 2, 4 | Three durable worker commands; real audio; full vernacular | L |
| `CommercialScreen` | 0, 3 | Four raw ID inputs → pickers; **must split into 3 units** | L |
| `EngineerChecklistScreen` | 0, 2 | Fail-evidence line off 9px; note field to 16px; toggles labelled in-language | M |
| `ClientHealthScreen` | 0, 1 | Scale-up: 18–20px base, capped measure, enlarged photos | M |
| `ClientDecisionsScreen` | 0, 1 | Same scale-up; thumbnails enlarged; approve target ≥44px | M |
| `TeamScreen` | 0, §6.4 | Device binding reworked (not a picker); fields to 16px | M |
| `ScheduleScreen` | 0, 1 | Fields to 16px; gate dots need a non-colour cue; timeline scrolls on tablet | M |
| `DecisionLogScreen` | 0, 1 | Fields to 16px + focus ring; **behaviour owned by Task 4** | M |
| `DrawingsScreen` | 0, 1 | Issued-to status off 9.5px; filter chips to 44px | M |
| `InspectionReviewScreen` | 0 | Fields to 16px; reject toggles get focus and keyboard operation | S |
| `DashboardScreen` | 0, 1 | Live-from-site strip off 8.5px; tiles stack on tablet | S |
| `InboxScreen` | 0 | Focus ring only — stays the default work queue | S |
| `MaterialsScreen` | 0 | Sweep; shortage state needs more than colour | S |
| `LabourScreen` | 0 | Sweep; forecast verdicts need a non-colour cue | S |
| `PlacesScreen` | 0 | Sweep; tree nodes need keyboard traversal | S |
| `DraftsScreen` / `PortfolioScreen` | 0 | Sweep | S |
| `layout/ProjectSwitcher` | 0 | Field to 16px; focus ring; non-modal disclosure per the Wave-0 amendment (2026-08-15): `aria-expanded` trigger, `role="group"` panel, root Escape, light dismiss — NO trap, it is not a dialog | S |
| `components/LocationPicker` | 0 | `outline:none` removed; field to 16px; listbox keyboard semantics | S |
| `modals/ApproveModal` | 0 | Focus ring + trap; **confirmation wording preserved** | S |
| `modals/ChangeModal` | 0 | `outline:none` removed; trap; field to 16px | S |
| `modals/QrModal` | 0 | Focus ring + trap; dismiss reachable by keyboard | S |
| `components/PhotoViewer` | 0 | Focus ring + trap (the fourth true dialog); ink-surface opt-in | S |

---

## 6. Open questions — settle before the affected wave

**6.1 Weekly report export.** Reported as disabled. If so, "generate the weekly report" cannot be an acceptance criterion; it needs its own implementation unit outside this programme. **Reproduce, then either schedule the unit or leave the step out.** Removed from the Wave 5 PMC scenario pending that.

**6.2 Worker authentication.** Reported that the UI requests a worker token but ignores it, and that repeated access can create new unbound device records. **Reproduce first.** If it holds, Wave 4 needs a trusted worker-device binding and session design *before* any UI work — this is a security question, not a UX one, and must not be designed around.

**6.3 Worker/mistri experience shape.** Per finding 9, connect the existing `Worker` entity and crew-in-charge relationship to dedicated narrow experiences. Do **not** widen the shell `Role` union. Settle the surface and authority model during Wave 0, as it has the longest lead time and Wave 4 depends on it.

**6.4 Device assignment is not a picker problem.** Replacing `TeamScreen:544`'s device-ID field with a worker picker does not solve it. The correct workflow is **QR scan, or selection from pending devices using a readable label and observation time, followed by worker assignment.** This is its own design and unit — it is removed from Wave 3.

**6.5 Architect inspection-rejection authority.** The v1 acceptance scenario assumed an architect may reject inspection line items. That authority is not established by Task 4 and this programme must not introduce it. **Either settle the policy explicitly with Task 4, or replace the scenario with an authorized architect workflow.** Scenario left blank until then.

**6.6 Audio for Listen — two layers.** Settle before Wave 4 opens. Fixed controls use bundled versioned recordings in en/hi/gu. Project-specific content — the task and the approved material — cannot be bundled and needs an **attributable voice briefing recorded by the engineer or PMC**, bound to the assignment revision or fingerprint and cached offline, invalidated when the assignment changes. Browser speech synthesis is ruled out for both layers: no guaranteed installed Hindi or Gujarati voice, and no offline guarantee. Decide who records, when they are prompted, and what happens when a briefing is missing.

**6.7 Field style sharing.** The eight sub-16px field styles are separate per-screen objects, not shared constants. Either introduce a real shared field primitive (preferred — makes the property structurally guaranteed) or verify with Playwright computed-style assertions per surface. Decide before F-1b opens; it changes the unit's size. **Decided (2026-08-15, autonomous loop, per the non-blocking rule — F-1b is loop-assigned work):** the shared field primitive, this section's preferred option; the Wave-0 doc carries the full dated amendment, and the owner may override asynchronously.

---

## 7. STATUS handoff

At the next **safe** handoff, record this as an owner-mandated standalone-V1 completion gate. Do **not** modify or expand an active unrelated PR to record it. Task 4 must remain undisturbed. Continue the autonomous draft → CI → exact-head Codex → correction → merge sequence. **Never self-certify the final outcome.**
