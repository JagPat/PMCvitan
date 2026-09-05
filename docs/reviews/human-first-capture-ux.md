# Make everyday site updates feel natural

Date: 2026-09-05. Repository base: `2ec4ba7d7d5bb46573384ac9300cb6b14f41aafa`.
Owner-directed usability review and one focused implementation: progress-photo capture.

## Outcome and evidence boundary

The app already has useful foundations: a role-aware **For You** home, one shared **Add**
menu, location inheritance for several forms, optional **More details**, capped mobile
navigation, and shared keyboard-focus treatment. The remaining problem is the work between
those pieces: finding the relevant record again, entering facts the screen knows, and
understanding internal terminology before recording an ordinary site event.

Live review: signed in as the PMC account on `https://pms.vitan.in`, project Residence at
Ambli. Inspected For You, followed its blocked-work link to Schedule, opened and cancelled
Plan activity, and opened Add here within Ground Floor on Site Map. The viewport was
1363 × 936. No production records were created, edited, approved, or submitted. Returned
the app to For You afterwards. This establishes the current desktop PMC experience only;
it does not establish engineer/client/worker usability or phone-camera behavior.

The new capture UI was tested through DOM interactions against the application components.
The browser could not open the local preview, so its new visual layout and native camera
behavior remain unverified. No workaround or production test upload was used. Real people
have not yet performed the acceptance tasks below; this is not a claim of adoption.

## What the live review found

| Priority | Observed friction | Change to pursue | Evidence |
| --- | --- | --- | --- |
| First delivery | Add here offers inspection, delivery and decision, but no progress photo. A person already viewing a place must leave it to capture reality. PMC navigation does not expose Daily Log. | Add progress photo to the same menu; retain the place automatically. Implemented in this unit. | Live Site Map → Ground Floor → Add here; `createOptions.ts`, `DailyLogScreen.tsx`, `screens.ts`. |
| Next | For You names one blocked activity. Open schedule takes the user to the full schedule; it does not focus or isolate that activity. | Open the relevant activity or filtered set, explain the cause, and link to the authorized action that resolves it. Keep a route back to the full schedule. | Live For You → Open schedule; `InboxScreen.tsx` calls only `setScreen(it.screen)`. |
| Next | Plan activity asks for **Plan start (day)** and **Plan end (day)**, initially 0 and 7, and explains the internal timeline model. | Calendar dates in the UI; preserve the existing offset contract behind the form with tested date conversion. | Live Plan activity dialog; `ScheduleScreen.tsx` / `PlanActivityModal`. |
| Next | The same plan form exposes a free-text Zone plus a location picker, and raw gate choices `na`, `wait`, `ok`, `fail`. | Choose the place once; derive its display label. Show ordinary language and fold optional links away. Keep material/team truth explicit wherever it cannot be derived. | Live Plan activity dialog; `ScheduleScreen.tsx`. |
| Later | The schedule asks users to interpret D/M/T/I/DRW indicators and dense small metadata. The blocked message says to resolve the blocker on site without a resolving action. | Lead with “What is stopping this?” and the next action; retain technical detail on demand. | Live Schedule screenshot and accessible DOM. |

These are current reproductions, not a copy of the older UX programme. In particular,
the old claims that mobile navigation is uncapped and keyboard focus is absent are no
longer accurate: see `mobileNav.ts`, `BottomTabs.tsx`, and `styles/global.css`.

## Additional source findings that matter for team adoption

These were traced in source, not exercised as production mutations:

- **Trust in completion needs its own correction unit.** Daily Log renders “Online · all
  synced” whenever online, regardless of its nonzero queue count. Its check-in handler
  assigns `8:12 AM`, while the screen claims GPS/selfie/within-60m proof. These labels must
  reflect actual recorded evidence and pending work before being relied on operationally.
  Sources: `DailyLogScreen.tsx` and `store.ts` (`checkIn`, `checkOut`).
- **Worker simplicity requires real delivery behind the buttons.** `speakJob` shows a
  toast; `workerDone` shows a sent message and resets local access. Those handlers do not
  themselves perform the claimed audio or durable work submission. Preserve the existing
  worker/device containment and resolve the dedicated worker-workflow gates; a larger
  button alone cannot solve this. Source: `store.ts` and the existing UX programme.
- **Material capture still has a detour.** `materialBlockedReason` correctly refuses a
  missing/submitted/unavailable daily log. A later unit should provide an authorized inline
  recovery path, preserving the entered context and waiting for confirmed readiness.
  Do not simply remove the guard: the server rejects those writes.
- **Photo retries still inherit the existing upload implementation.** Offline selection
  uses the existing persistent outbox; online progress-photo upload reports failure through
  a toast and asks for reselection. This unit does not make online uploads durable across
  reloads, add per-photo retry cards, or add bulk uploads. Those are appropriate follow-up
  media-reliability work before expanding capture volume.
- **Language coverage is partial.** Field screens contain English labels even though
  access and labour labels support Hindi/Gujarati. Extend the established translation
  mechanism, including validation and retry messages. Do not claim that the whole app is
  localized because the sign-in screen offers a language choice.

## Implemented: a photo from wherever work happens

From a room: **Add here → Add progress photo → Take photo / Choose photo**.
From elsewhere: **Add → Add progress photo → Take photo / Choose photo**.

| Effort | Before | This change |
| --- | --- | --- |
| Find the owning module | Photo entry is on Daily Log; its absent-log screen hides capture. | Use the shared Add entry point. |
| Preserve a room already being viewed | Navigate away and select that location again. | Room shown automatically, with Change available. |
| Start a daily log for this photo | Required to reach the old screen's picker. | Not required; progress media already supports an absent log. |
| Required typing | None for the photo itself. | None; project, author and inherited place are not re-asked. |
| Choose camera or existing image | One input with a camera capture hint. | Separate Take photo and Choose photo controls. |
| App actions starting inside a room | Varies with navigation, log state and tree depth. | Three taps to open the native picker; native camera/library actions are excluded. |

The new modal reuses `InheritedContext`, `Modal`, `Button`, `captureStamp`,
`addProgressPhoto`, and the existing outbox. Location remains optional when there is no
inherited place. Capture time and GPS come only from metadata actually present in the photo;
the time of upload is not substituted for unknown capture time.

Permission remains `media.upload` (PMC and engineer). No worker/contractor permissions are
widened. Project and generation are pinned when the modal opens, before the native picker
or FileReader can yield. They and the current role are checked again before dispatch.
Changing project, cancelling the form, or losing upload permission prevents a late read
from writing. Location controls freeze during the read. A read error keeps the form open
and permits reselection. Upload/queue outcome messages remain owned by the existing store;
closing the capture form is not presented as confirmed server success.

## The interaction standard for subsequent units

1. Start at **what needs me**, not a catalogue of modules. A task should take the user to
   the named work, with the relevant drawing, place and decision already in context.
2. Ask for the missing fact once. Inherit project, actor and selected place; derive labels
   and dates where warranted. Do not infer attendance, completion, quantities or approvals.
3. Show a short action in everyday language: take a photo, record delivery, report a problem,
   review a choice. Keep required evidence visible and optional detail folded.
4. Make ordinary capture useful immediately. A daily summary can assemble existing facts;
   a person should only resolve omissions and explicitly attest where the workflow requires it.
5. Make pending, failed and confirmed states distinguishable. A person should not have to
   remember what the application might have lost or re-enter work after every interruption.

No universal “one tap” target applies to approvals or evidence-bearing actions. Reduce
navigation and repeated entry while preserving the human decision and its attribution.

## Acceptance with actual team members

Use the same task before and after a change. Record completion time, app taps, fields typed,
location reselections, wrong records, assistance, abandonment and lost/duplicate work.
The targets below are proposed acceptance criteria, not measured results.

| Person / setting | Task | Target |
| --- | --- | --- |
| Engineer, phone at a room | Capture a progress photo at that room | No typing or repeated location choice; three app taps to the native picker. |
| Engineer, poor signal | Capture, reconnect, then find the photo | Honest queue state, one attributable record in the correct project/place. |
| PMC, desktop | Follow a blocked-work notification | Reach the named activity without searching the full register again. |
| Planner, desktop | Add work for two calendar dates | No mental conversion to timeline day offsets; location entered once. |
| Client, tablet | Understand a choice and approve it | Readable options and impacts; explicit attributable approval. |
| Mistri / worker, phone | Complete an assigned job or report a problem | Assigned-work context, familiar language and truthful durable outcomes; only after worker authentication/workflow gates clear. |

Repeat ordinary tasks over a week and record whether people complete them unaided and return
without reminders. CI cannot establish that the app has become second nature.

## Verification and review scope

- RED on the stated base, before implementation: the first four capture-path tests failed
  because `create-photo` was absent; three authorization exclusion tests passed.
- Ten capture tests cover no-log entry, location inheritance/offline queue, project switch,
  picker cancellation, read failure/retry, form cancellation, and permission loss/exclusion.
- Existing capture-context, create-control, media and photo-metadata tests remain applicable.
- Final full `pnpm check` exited **0**: 301 automation, 995 web and 804 API tests passed,
  with lint, type checks and builds passing. Native
  camera, responsive visual, screen-reader, live-PostgreSQL and independent exact-head review
  gates are not certified by these component tests.
- No dependencies, API contracts, backend writers or database migrations changed. The
  correction to older option-count assertions reflects the newly permitted menu action.
- This owner-requested unit does not advance Phase 6, clear its deployment directive, close
  the UX programme, or modify `docs/STATUS.md`. Existing wave and worker-authentication gates
  remain as recorded. The previous performance change is not included in this branch.

| Invariant | Risk and evidence |
| --- | --- |
| authorization-tenancy | Existing media policy; project generation pinned before async work; wrong-project and permission-loss tests. |
| civil-time-lifecycle | No daily-log start/submit, date conversion or invented capture timestamp; metadata parser reused. |
| concurrency-idempotency | One active file read; repeated controls disabled; existing upload/outbox identity unchanged. |
| data-integrity-conservation | Original image bytes and selected node passed through; no approval, quantity, or evidence edits. |
| offline-reconciliation | Real store test verifies `uploadMedia` queued for the chosen room without a daily log; existing replay path unchanged. |
| ui-server-parity | `MediaService.create` allows optional daily-log reference; `media.upload` role policy is the menu authority. |

Source locations are relative to the repository root: `apps/web/src/` unless otherwise
specified. Backend parity: `apps/api/src/media/media.service.ts` and
`packages/shared/src/domain/policy.ts`. The broader programme remains in
`docs/ux/UX_COMPLETION_PROGRAMME.md`.
