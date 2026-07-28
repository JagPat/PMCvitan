# Phase 4 Task 6 — Frontend surfaces + pilot acceptance chain (§J) — Review Packet

Vision alignment: Phase 4 fills the "Team" readiness gate with the same canonical, transactional,
lock-protected discipline Phase 3 gave the "Material" gate. Task 6 is the §J FRONTEND completion:
the ONE capability-gated Labour hub plus the extended Schedule/DailyLog/Team/Inbox surfaces and the
offline/idempotent field ops, proven by a real-browser live-PG acceptance chain in BOTH capability
states. It is read + UI over the already-cleared Tasks 1–5 facts — **no domain schema, no
migration, no API change**. One project = one site; project records never become global; one fact
has one canonical owner (every number this UI shows is a server read; no verdict is derived in the
browser); attributable approvals preserved (every command carries the session identity + an
Idempotency-Key); tenant isolation unchanged (the store's project-scope teardown covers the new
labour state).

Base: `main` `d8a9c50` (Task 5 merged + cleared). Branch: `claude/phase4-task6`. Draft PR: #246.

## 1. What this PR contains

### The Labour hub (§J — the ONE new screen)

`apps/web/src/screens/LabourScreen.tsx` — capability-gated (`SCREEN_CAPABILITY.labour='labour'`),
cloning the Materials hub idioms exactly: seven tabs **readiness · demand · suppliers ·
commitments · allocation · attendance · productivity**; summary tiles from the server forecast;
honest `reading` / `unavailable+Retry` / `stale+Retry` load states; every action button disabled
while its coalesce key is pending. The readiness tab shows the SERVER's `labour.readiness`
FORECAST verdicts (`ready`/`at-risk`/`blocked` + reason + covering date); the EXECUTION Team gate
that authorizes `activities.start` is evaluated server-side in-tx (Task 4) and reaches the
Schedule through the baked `ActivityReadiness.team` — the browser never derives either.

Operational commands (each ONE server command; no browser-side fan-out):

- **allocate** — per demand slice, choose an active worker → `labour.allocation.allocate`
  (`allocateCoalesceKey(activity, requirement, civilDate, worker)`).
- **muster (manual exception)** — worker + shift + a REQUIRED attributable reason →
  `labour.attendance.record` with `manualReason` (`musterCoalesceKey(worker, civilDate, shift)`).
  The canonical §H path — the worker's OWN bound device — is server truth cleared in Task 3; the
  hub records only the explicit pmc exception, and the button stays disabled without a reason.
- **record work** — bounded minutes input (1–720, default 480) per ACTIVE allocation →
  `labour.work.record` (`workCoalesceKey(allocation, minutes)`).
- **raise labour requisition** — one command carrying the requirement's explicit
  `(civilDate, personShiftQty)` slices → `labour.requisition.create`
  (`labourRequisitionCoalesceKey(lines)`, content-deterministic + order-insensitive).

### The store labour slice (the cleared materials discipline, cloned)

- `store/labour.ts` — `LabourView` (readiness + shared type-neutral requirements + workforce +
  catalog + requisitions + POs + commitments + §C capacity facts + today's presence +
  productivity), all greenfield module-query reads.
- `store/store.ts` — `loadLabour()` with latest-request ownership (`labourLoadSeq`) + project-scope
  guard + stale-while-revalidate + last-good-on-error; `dispatchLabour()` (capability guard →
  coalesce vs the durable outbox + `labourPending` → write-ahead); the labour flush hook (resolved
  coalesce keys unblock buttons, ANY attempted labour op — success, terminal drop, or transient —
  reloads the labour truth, scope-guarded); `hydrateOutbox` runs `normalizeLabourOutbox` (labour
  ops are BORN two-keyed — a malformed row is dropped, never replayed with broken identity) and
  rebuilds `labourPending`; `loadShell` triggers the bundle when the shell reports `labour`.
- `lib/labourKeys.ts` — the labour twin of `materialsKeys.ts`, born already carrying the PR-#208
  two-key split (fresh `idempotencyKey` per deliberate action; deterministic `coalesceKey` for
  equivalent-action-while-pending dedupe).
- `data/apiGateway.ts` — 10 labour reads, 4 outbox field commands, 4 direct roster commands, 4
  `OutboxOp` variants + replay cases (route JSON chased with a snapshot refetch; the labour
  reconcile hook reloads the bundle).
- `store/projectScope.ts` — `labourView`/`labourPending` join `ProjectDataState` and `labourLoad`
  joins `ModuleReadState`, so every scope change tears the labour state down.

### Extended surfaces (§J table)

| §J surface | Delivered as |
|---|---|
| Capability gate + nav | `lib/screens.ts`: `SCREEN_META.labour`, `SCREEN_CAPABILITY.labour='labour'`, `SCREEN_MODULE.labour=null` (module filter no-op — the capability gates), `screensFor` pmc + engineer; `useNavItems` labour badge = at-risk + blocked forecast count |
| Inbox | `store/selectors.ts` — the `labour-shortage` action (pmc/engineer, `labourView` null-guard is the off-pilot gate, counts blocked/at-risk from the server forecast, red when anything is blocked, worst reason in the detail, jumps to the hub) |
| Site Schedule Team gate | **No frontend change needed** — `gatesFor` already reads `readiness.team` verbatim, and Task 4's read-path bake derives the Team gate server-side on-pilot. The e2e proves the derived gate by starting the activity through it. |
| Daily Log attendance | `DailyLogScreen.tsx` — a pilot-only per-worker presence section from the labour-owned `labour.presence` read (musters + unresolved mismatches, en/hi/gu `labourLabels`); the aggregate `CrewRow` steppers are UNTOUCHED and stay display-only; `labourView` is null off-pilot so the non-pilot daily log renders byte-identically |
| Team roster | `TeamScreen.tsx` — the labour roster section (workers + crews from `labour.workforce`, pmc onboarding against the `labour.catalog` trade/skill pickers, device→worker binding via `orgs.workerDevice.bind`) |
| Team Access onboarding | **Deliberately homed on the Team screen** (documented deviation): TeamAccess is the AUTH step machine whose anonymous QR/tap device flow must stay byte-identical (§D/§H — Task 1/3 proofs); worker onboarding + device binding are pmc ROSTER authority, so they live next to the human team roster. No TeamAccess change. |
| i18n | `packages/shared/src/i18n/dictionary.ts` — `labourLabels` (attendance/present/crew/worker/shifts/mismatch) en/hi/gu + the `labour` i18next namespace |

### Honest §J residuals (stated, not hidden)

- The manual-exception muster form ships WITHOUT inline photo capture. `evidenceMediaId` is
  server-supported (Task-3 F2: same-project Media FK + delete seal) and the op rides the same
  durable outbox as daily-log field captures, but wiring an offline photo→muster two-step was
  deferred rather than half-built: the §H TRUSTED evidence path is the worker's own bound device
  (server-sealed), and the manual path already REQUIRES an attributable reason.
- Crew-level allocate/`formCrew` UI is not on the hub (the gateway carries `formCrew`/
  `addCrewMember`; crew expansion is server truth cleared in Task 3). The hub allocates named
  workers — the §C atomic capacity source.

## 2. Tests

### `apps/web/tests/labour.test.ts` — 26 probes

- **§D nav gating** — hidden without the capability (even with every module enabled), shown for
  pmc + engineer with it, never for client/contractor/consultant, and materials↔labour gate
  INDEPENDENTLY.
- **Inbox** — one `labour-shortage` item (red when blocked / amber at-risk-only, worst reason,
  counts), absent when ready / no bundle / other roles.
- **loadLabour** — off-pilot no-op (and materials-only no-op); full bundle → `ready` (presence
  called with today's civil date); failure keeps last-good + `error`; an OLDER late success AND an
  OLDER late failure never overwrite a NEWER result; `loadShell` triggers the bundle.
- **Field ops** — exact inputs for allocate/muster/work/requisition; inert off-pilot; PROBE 5a
  (double-click coalesces to ONE command), PROBE 5b (transient failure replays the SAME
  idempotency key), PROBE 6 (terminal 4xx drops the op, clears pending, refreshes truth), PROBE 7
  (a scope switch mid-command never mutates or toasts the new scope), DIRECTIVE #1 (two legitimate
  identical actions separated by a confirmed completion use DIFFERENT keys), DIRECTIVE #4 (a
  transient failure retains the op + refreshes truth, no success toast).
- **Hydration** — persisted two-key labour ops rebuild `labourPending` + stay coalesced + replay
  the ORIGINAL key; a malformed labour op (missing either key) is dropped and persisted back;
  `normalizeLabourOutbox` table probes + requisition-key order-insensitivity.

### `apps/web/tests/e2e-api/labour-pilot.spec.ts` — the §J acceptance chain (real browser, live PG)

1. **The principal Phase-4 vertical chain** — labour requirement (one slice dated today) → the §F
   commercial fixture (requisition → submit → approve → RFQ → vendor + profile → quote →
   comparison → approve → PO → issue → capacity commitment promised today) → the hub shows
   **AT-RISK** → the BROWSER allocates the named worker → **READY** (the visible forecast
   transition) → the BROWSER records the same-day manual muster → **`activities.start` succeeds**
   (the in-tx execution Team gate green — allocated AND present today) → the BROWSER records 480
   worked minutes → a §I output lands → the productivity tab shows the derived join.
2. **Shortfall** — an uncommitted labour requirement is BLOCKED, surfaces the `labour-shortage`
   Inbox card on the For-You home, and the demand tab raises ONE labour requisition that appears
   under suppliers.
3. **Roster** — the Team screen onboards a worker against the catalog; the workforce register
   confirms it.
4. **INERT** — the plain project has NO Labour nav and `GET …/labour/readiness` 404s.

Determinism: the browser context is pinned to UTC and the pilot project is created with
`timeZone:'UTC'`, so the spec's, the server's and the browser's civil "today" agree at any
wall-clock moment (execution coverage and the muster form both key on today). Each test provisions
its OWN tagged trade/worker/activity; the suite ran clean twice CONSECUTIVELY against the same DB
(4/4 + 4/4).

## 3. Gate battery

- **`pnpm check` EXIT 0** — automation 53/53, web lint (oxlint) + `tsc -b` typecheck clean, web
  **458/458** (432 existing + the 26 new labour probes), web build clean, API unit **680/680**.
- **Full integration on a pristine migrated DB** — **71 files / 693 tests** passed (the API is
  untouched by this PR; the counts match the Task-5 merge exactly).
- **`upgrade-proof.sh` PASSED** — no migration in this PR; every prior Phase-1..Phase-4-T5
  seal/forgery rejection survives verbatim.
- **`test:e2e:api:allmodules` 35/35** and **`test:e2e:api:allmodules:outbox` 35/35** — both full
  suites CLEAN, each including `labour-pilot.spec.ts` (4 tests) and `materials-pilot.spec.ts`.
  Honest flake record: four earlier legacy-mode runs each failed ONE long-standing
  timing-sensitive legacy test (`project-scope` browser-history/empty-project twice,
  `pillar-chain` inspection once, `drawings-module-query` once — never a labour surface), every
  failing test passing on the other runs; the `project-scope` history failure was REPRODUCED with
  an identical goBack signature on the UNCHANGED base (`d8a9c50`, changes stashed, fresh seed),
  proving the flake is pre-existing and not attributable to this PR. The final clean runs above
  are complete, unedited suite executions.
- **`labour-pilot.spec.ts` re-runnability** — 4/4 twice CONSECUTIVELY against the same DB during
  iteration, before the full-suite runs.

## 4. Files touched

Frontend + shared + tests + docs only. `packages/shared`: `domain/types.ts` (`ScreenKey` +
`'labour'`), `i18n/dictionary.ts` (`labourLabels`). `apps/web/src`: `lib/labourKeys.ts` (NEW),
`lib/screens.ts`, `data/apiGateway.ts`, `store/labour.ts` (NEW), `store/store.ts`,
`store/projectScope.ts`, `store/selectors.ts`, `layout/useNavItems.ts`, `layout/ScreenView.tsx`,
`screens/LabourScreen.tsx` (NEW), `screens/DailyLogScreen.tsx`, `screens/TeamScreen.tsx`.
`apps/web/tests`: `labour.test.ts` (NEW), `e2e-api/labour-pilot.spec.ts` (NEW). Docs:
`docs/STATUS.md`, `docs/AUTONOMOUS_LOOP.md`, `CLAUDE.md`, this packet, and
`docs/reviews/phase-4-consolidated-review-packet.md`. **No `apps/api` change; no migration.**

## 5. Codex correction round 1 (the six current-head findings on `d538c15`)

The independent Codex review of head `d538c15` returned six findings — two P1 (incompatible
workers offerable; commitment drawdown never wired) and four P2 (browser-local muster dates;
engineer manual muster 403s; labour deep links accepted on non-pilot projects; stale allocation
counts). All six are corrected on this head, each reproduced RED at `d538c15` first (12 behaviour
probes failed against the stashed pre-fix source; all green after). The correction is frontend +
tests + docs ONLY — no `apps/api` change, no migration, no shared-contract change.

### F-TZ (P2) — muster/presence dates use the PROJECT timezone

`apps/web/src/lib/civilDate.ts` (NEW): `todayCivil(timeZone, now)` resolves the civil date in the
project's IANA zone via `Intl.DateTimeFormat('en-CA', { timeZone })`, falling back to the
browser-local date only when the zone is unknown (local demo / pre-snapshot). The store gains
`timeZone` (project-owned identity, `null` until known) adopted from `snap.project.timeZone` in
`applySnapshot`; `loadLabour`'s presence read and the hub's "MARK PRESENT — {today}" + muster
command now derive today from it. A US browser at 20:30 on the 28th musters against the site's
29th. Probes: fixed-instant table (Kolkata crossing midnight before UTC; LA a day behind;
unknown-zone fallback) + a store probe asserting `labourPresence` receives `todayCivil(tz)` for a
zone chosen at runtime to DIFFER from the browser-local date (the UTC-12/UTC+14 26-hour spread
guarantees one always differs).

### F1 (P1) — only compatible workers may satisfy a demand slice

`apps/web/src/lib/labourSelection.ts` (NEW, pure): `buildWorkerFingerprints` computes every
fingerprint a worker's own (trade, skills) identity can satisfy — per shift, the bare-trade
identity plus one per declared skill — with the SAME shared `computeLabourSpecFingerprint` the
server pins; `loadLabour` computes it once per bundle into `LabourView.workerFingerprints`.
`compatibleWorkerIds` admits a worker iff one of their fingerprints equals the requirement's HEAD
fingerprint or the target of an ACTIVE approved substitution whose source IS the current head
(the Phase-3 T6-F2 rule; revoked or foreign-requirement substitutions never apply; revoked
workers never offered). The hub's allocate picker offers ONLY those workers ("No compatible
workers" otherwise), and a previously-picked worker who becomes incompatible is dropped, never
submitted. Probes: mason/electrician exclusion, skilled-vs-bare identity, substitution
admit/revoke/head-moved/foreign-requirement, store fingerprint identity, rendered picker
inclusion/exclusion + the empty-picker state, and the e2e roster now onboards an
incompatible-trade worker and asserts the real browser select omits them.

### F2 (P1) — allocation draws down the covering commitment

`pickCommitmentFor` selects the live same-slice commitment (exact fingerprint + civil date +
shift, `committed|revised`) with undrawn quantity — draws counted over ALL allocations naming the
commitment regardless of status, so a delivered-then-released draw stays consumed (the Task-4
round-2 rule) — deterministically (lowest id). The hub passes its id through
`allocateWorker(..., capacityCommitmentId)` into the outbox op, so the server's §F bound-3
drawdown actually runs; own-workforce allocation passes none. The slice line surfaces
"supplier capacity available". Probes: picker unit table (same-slice only, exhausted, released-
stays-consumed, defaulted, remainder), store payload with/without the id, and the e2e now asserts
the REAL allocation row is supplier-capacity-backed (`capacityCommitmentId` set server-side +
"supplier capacity" rendered) after the browser allocate.

### F6 (P2) — the allocated count matches the server's coverage rule

`allocatedCountFor` counts ONLY active allocations bound to the requirement's CURRENT activity
AND a currently-satisfying fingerprint (head or active substitution target) on that civil date —
a row stranded by a revision (old activity or old trade/skill/shift) is not "allocated", so the
hub can no longer show 1/1 for a slice readiness reports blocked. Probes: unit table (stranded
activity, stranded fingerprint, released, wrong slice/requirement, substitution target counted,
revoked substitution not) + rendered `allocated 0/1` for a stranded row and `1/1` for a current
one.

### F-PMC (P2) — manual muster is pmc-only

The MARK PRESENT form renders only for `role === 'pmc'` — the server treats a manual muster as a
`labour.override` exception (pmc-only), so an engineer's click was a guaranteed terminal 403 the
outbox discards. Probes: rendered hub with role engineer has NO muster form/testids; pmc keeps
it.

### F-deeplink (P2) — capability-gated screens bounce by capability in RouteBridge

The store gains `capabilitiesKnown` (project-owned, reset on every scope change; set when the
shell reports). `RouteBridge`'s screen guard now filters `screensFor(role)` by
`SCREEN_CAPABILITY` once capabilities are KNOWN: a direct `/projects/<non-pilot>/labour` (or
`/materials`) URL is redirected to the role default instead of landing on a permanently-loading
hub; while capabilities are UNKNOWN (cold load, shell in flight or failed) nothing is bounced, so
a pilot deep link survives shell latency — and the moment the shell reports no capability, the
provisionally-accepted screen is ejected. Probes: routeBridge render tests for all four states
(known-absent bounce; pilot lands; unknown-not-bounced-then-ejected; materials covered too) + the
e2e INERT test now drives a real `/labour` deep link on the non-pilot project through the
sign-in gate (the project-scope cold-deep-link pattern — a full reload drops the in-memory
token) and sees the route leave `/labour` for a `/for-you` role home with the hub never
rendered. Two probe-authoring iterations were caught by the battery itself and are recorded
honestly: the first navigated without re-authenticating (the page sat on the sign-in gate — no
shell, no bounce expected while capabilities are unknown), and the second over-claimed
SAME-project scoping (a fresh login scopes to the account's SERVER-designated home project —
the pre-existing "authentication lands on the server project" behaviour — so a cross-home
deep link ejects onto the home project's role default; the finding's claim is only that the
dead hub is never served, and the same-project eject IS pinned by the jsdom probes where the
session already holds the project).

### Round-1 gate battery (this head)

- Reproduce-first: **12 behaviour probes RED** with the pre-fix source stashed at `d538c15`
  (4 routeBridge, 3 store, 5 rendered-hub) → all GREEN on this head; the pure-helper tables are
  new files and green by construction.
- `pnpm check` EXIT 0 — web **481/481** (458 + the 23 correction probes), API unit 680/680.
- Full integration on a pristine migrated DB — **71 files / 693 tests** (API untouched).
- `upgrade-proof.sh` PASSED (no migration; unchanged).
- `test:e2e:api:allmodules` (legacy) **35/35** CLEAN, `labour-pilot.spec.ts` carrying the three
  new in-browser assertions (F1 roster exclusion, F2 supplier-backed allocation, F-deeplink
  bounce).
- `test:e2e:api:allmodules:outbox` — the **labour-pilot suite passed 4/4 in BOTH outbox
  attempts** (incl. the corrected deep-link probe), but each attempt failed the SAME three
  pre-existing `pillar-chain` inspection tests (22/23/25 — the checklist submit button never
  left `idle`; the long-documented timing-sensitive family, no labour surface). Non-attribution
  was PROVEN, not assumed: the UNCHANGED base `d538c15` — whose full outbox suite ran 35/35
  clean earlier the same day — was re-run with this correction stashed and failed the IDENTICAL
  trio with the identical signature, demonstrating container timing drift, not a diff effect.
  The required GitHub CI on a fresh runner executes the same suites on the pushed head and the
  exact-head gate demands it green regardless — that run is the deciding evidence for this
  suite.

## 6. Codex correction round 2 (the seven current-head findings on `17fc0f0`)

Codex's re-review of the round-1 head closed all six round-1 findings and raised seven new P2s —
all in the labour UI/store staying truthful to server rules it had not yet mirrored. All seven
are corrected on this head, each reproduced RED at `17fc0f0` first (11 behaviour probes fail
against the stashed pre-fix source; all green after). Frontend + tests + docs ONLY. The two
findings that assert server behaviour were VERIFIED against `labour-capacity.service.ts` before
coding, and one round-1 probe that had pinned the WRONG drawdown rule is reversed with the
citation.

### R2-A — a `changed` ping refreshes the labour bundle

`useApiSync.refresh()` now calls `loadLabour()` alongside `requestFreshSnapshot()` +
`loadMaterials()` — the labour DTOs are module-query-only (never in the snapshot), so another
client's allocation/muster/revision otherwise left `labourView` and the Labour/Inbox badges
stale until a manual refresh. Capability-guarded — a no-op off-pilot. Probe:
`labour-socket-refresh.test.ts` (the drawings socket harness) — `changed` AND reconnect both run
the labour loader.

### R2-B — a REVISED commitment is never offered

The server accepts only `status === 'committed'` for `capacityCommitmentId`
(`labour-capacity.service.ts` line 317); the round-1 helper also admitted `revised`, a
deterministic terminal 409. `pickCommitmentFor` now filters to committed-only (a committed
sibling is still picked over a revised one).

### R2-E — a RELEASED draw frees the commitment

The server's bound-3 drawdown counts ONLY `status: 'active'` rows under the commitment
`FOR UPDATE` (line 327) — releasing a supplier-backed worker who never worked re-advertises the
capacity, and the round-1 helper (counting every draw regardless of status) suppressed the
commitment id on the replacement, stranding it. The helper now counts active draws only; the
round-1 probe that asserted released-stays-consumed is REVERSED with the server citation (that
rule belongs to the FORECAST's coverage, not allocation).

### R2-C — pickers respect the worker's active window

New pure `workerActiveOn(w, civilDate)`: the server refuses allocation AND attendance outside
`[activeFrom, activeTo]` with terminal 400s the outbox drops (service lines 302/441). The
allocation offer is filtered per SLICE date and the manual-muster picker by project-today; a
stale muster pick of a now-ineligible worker can no longer submit. Probes: the boundary table
(before/first/last/after/open-ended/revoked) + both rendered pickers excluding a future-dated
worker.

### R2-F — a booked worker is not offered twice

New pure `bookedWorkerIds(allocations, civilDate, shift)`: §C's one-live-allocation partial
unique makes a second active allocation for the same worker/date/shift a certain 409, so the
per-slice offer excludes workers already ACTIVE on that (civilDate, shift) anywhere in the
project (a released row frees them). Probes: the unit table + the rendered picker excluding a
worker allocated to a DIFFERENT requirement on the same slice.

### R2-G — a full slice closes the allocate action

The server caps only supplier drawdown — an own-workforce allocation past the demand would
strand a worker on an already-ready slice. At `allocated n/n` the picker + button disable with
an explicit "Fully allocated" and the supplier hint is suppressed; under-allocated slices are
unchanged. Probes: rendered full-slice (disabled + no hint) and under-allocated (enabled +
hint) states.

### R2-D — the snapshot that DELIVERS the timezone reloads presence

On a cold pilot boot `loadShell()` can trigger the first `loadLabour()` before any snapshot has
populated `timeZone`, so that load's presence read fell back to the browser's civil day — and
nothing reloaded it. `acceptSnapshot` (the ONE ordered apply path) now reloads the labour bundle
when an applied snapshot CHANGES the known timezone (capability-guarded; both boot orders
converge; an unchanged-tz snapshot never reloads). `timeZone` also joins every scope teardown
(auth adoption, switch, sign-out) so a new project's zone is honestly unknown until its own
snapshot lands. Probes: the tz-delivery reload (presence re-read for the SITE's day; no reload
on unchanged tz) + the off-pilot no-op.

### Round-2 gate battery (this head)

- Reproduce-first: **11 behaviour probes RED** with the pre-fix source stashed at `17fc0f0` →
  all GREEN on this head.
- `pnpm check` EXIT 0 — web **491/491** (481 + the 10 round-2 probes), API unit 680/680.
- Full integration on a pristine migrated DB — **71 files / 693 tests** (API untouched).
- `upgrade-proof.sh` PASSED (no migration; unchanged).
- e2e: `test:e2e:api:allmodules` (legacy) **35/35** CLEAN; `:outbox` 33/35 — the
  **labour-pilot suite passed 4/4 in BOTH modes** (8/8 across the two gates, exercising every
  round-2 UI change in a real browser), and the two outbox failures were `drawings-module-query`
  and `project-scope` "empty project is truthful" — BOTH long-documented pre-existing
  timing-sensitive legacy tests (each already in the d538c15 honest flake record), NEITHER a
  labour surface, and a DIFFERENT random pair from the pillar-chain trio that failed the round-1
  outbox runs and was base-proven environmental (that trio passed this run). The container's
  outbox-mode timing degradation is established by the round-1 base proof; fresh-runner CI on
  the pushed head is the deciding evidence the exact-head gate requires green regardless.

## 7. Codex correction round 3 (the six current-head findings on `0172dc2`)

Codex reviewed head `0172dc2` and returned six findings — one P1 on command identity under
offline replay, five P2 on demand/commercial-chain truth mirroring. Each was reproduced RED
first (source stashed at `0172dc2`, probes run: **13 web probes failed + the API stale-pin
probe allocated silently instead of refusing** — reproducing the exact P1 harm), then fixed:

### R3-1 (P1) — allocation commands PIN the selected requirement head

The allocate command carried only `(activityId, requirementId, civilDate, workerId)`; the
server derived `originRevision`/`labourSpecFingerprint` from the CURRENT head at execution
time. An allocation queued offline and replayed after a revision would therefore insert the
stale worker as coverage for the NEW trade/skill/shift whenever activity + date still matched.
Fix, both sides of the contract:

- `allocateLabourSchema` gains an optional `originRevision` (`apps/api/src/contracts.ts`), and
  `LabourCapacityService.allocate` — after resolving the head through
  `ActivityParticipant.labourRequirementHead` inside the readiness-locked transaction — refuses
  a pinned revision that is not the live head with a deterministic **409** (terminal: the
  client outbox drops it and the flush reconciles). An UNPINNED command (a pre-round-3
  persisted queue entry) keeps byte-identical semantics; the allocation's shift/fingerprint
  stay SERVER-derived.
- The store's `allocateWorker` now takes and ALWAYS sends the head revision the UI displayed
  (`store.ts`, `apiGateway.ts` `AllocateLabourInput.originRevision`), and the hub passes
  `r.revision` (`LabourScreen.tsx`).
- Probes: live-PG `phase4-t6-allocation-pin.test.ts` — matching pin allocates; omitted pin
  unchanged; **stale pin after a mason→carpenter revision is a 409 with ZERO rows** and the
  same command re-pinned to the live head succeeds (the refusal is head drift, not the
  worker). Web: the dispatched input carries `originRevision` (store probe + drawdown probe).

### R3-2 (P2) — worked slices are already FULL

The allocate-stop (`full`) used `allocatedCountFor` (ACTIVE rows only), while canonical
coverage counts `sourced = |allocated ∪ worked|` — so a worked-then-released one-person slice
showed `allocated 0/1` and offered ANOTHER allocation against demand readiness already
considers delivered. New `sourcedCountFor` (`lib/labourSelection.ts`) mirrors
`labour-coverage.service.ts` exactly: DISTINCT workers, active-compatible allocations ∪ work
facts recorded under compatible allocations of the slice (work survives release; stranded
rows never count). The slice line stays honest — `allocated 0/1 · 1/1 sourced incl. delivered
work` — and the picker/button close. Probes: unit (union/distinct/stranded table) + rendered.

### R3-3 (P2) — a WORKED release stays DRAWN

`pickCommitmentFor` freed a commitment on ANY release, but the forecast keeps a commitment
consumed once ANY work fact was recorded under its draw — re-offering the id after
allocate→work→release would overdraw delivered supplier capacity. The helper now takes the
work facts and counts a draw while its allocation is ACTIVE **or worked**; only a NO-WORK
release frees the commitment (the round-2 probe now states that carve-out explicitly).
Probes: worked release → null on a qty-1 commitment; unrelated work fact → still offered;
qty-2 with one worked release → remainder offered.

### R3-4 (P2) — raise only the UNREQUISITIONED residual

The demand tab always sent the FULL demand slices; with a 1-person open line already in the
chain, re-raising a 3-person slice is the server's §F bound-1 `1 + 3 > 3` terminal 409. New
`unrequisitionedLines` mirrors the bound-1 counting rule exactly — existing `open`/`ordered`
lines on the SAME `(requirementId, revision, civilDate)` count against the ceiling, cancelled
lines and other revisions do not — and the button sends only the positive residuals,
disappearing entirely once the chain holds the full demand. Probes: unit (residual /
ordered-counts / cancelled-ignored / other-revision-ignored / two-requisitions-sum → []) +
rendered (partial → residual 2 dispatched; full → button gone).

### R3-5 (P2) — onboarding stamps the PROJECT civil day

`TeamScreen`'s roster onboarding stamped `activeFrom` with the browser/UTC date; a viewer
behind the site's timezone minted a worker active only from TOMORROW who then failed the
active-window check for the site's today. Now `todayCivil(timeZone)` (the F-TZ helper).
Probe: fake clock at `2026-07-28T20:00:00Z` + `Asia/Kolkata` → onboard dispatches
`activeFrom: '2026-07-29'` (the browser/UTC stamp would be `2026-07-28`).

### R3-6 (P2) — no ACTUAL work before the shift

Record work was enabled for every active allocation, including future-dated bookings — a
click minted delivered-work evidence (work facts drive productivity §I and Team coverage)
before the shift occurred. The input + button are disabled when the allocation's civil date
is after the project's today, labelled `Future shift`. Probe: rendered — tomorrow's
allocation disabled/`Future shift`, today's enabled.

### Round-3 gate battery (this head)

- Reproduce-first: **13 web probes + the API stale-pin probe RED** with the pre-fix source
  stashed at `0172dc2` (the stale allocation landed SILENTLY — the exact P1 harm) → all GREEN
  on this head (focused web labour suites 61/61; `phase4-t6-allocation-pin` 2/2).
- `pnpm check` EXIT 0 — web **498/498** (491 + the round-3 probes), API unit 680/680.
- Full integration on a pristine migrated DB (psql-recreated + `migrate deploy`) — **72 files
  / 695 tests** (+1 file / +2 tests for the live-PG allocation-pin probes).
- `upgrade-proof.sh` PASSED (no migration in this PR; regression only).
- e2e: `test:e2e:api:allmodules` (legacy) — first run 33/35 with the two failures being the
  long-documented `inspections-module-query` and `project-scope` history timing flakes
  (NEITHER a labour surface; both in the honest flake record since `d538c15`), clean re-run
  **35/35**; `:outbox` **35/35** CLEAN first run. The **labour-pilot suite passed 4/4 in BOTH
  modes** — including the browser allocate (now revision-pinned), the residual-only
  requisition raise, and the roster onboarding this round changed.

## 8. Codex correction round 4 (the four current-head findings on `c1f4c40`)

Codex reviewed head `c1f4c40` (after the gate's double-timeout + the documented recovery
dispatch) and returned four P2 findings, all in the round-3 additions. Each reproduced RED
first (source stashed at `c1f4c40`: the four probes + two signature-updated probes failed),
then fixed — both server-rule mirrors verified against the cited service code before coding:

### R4-1 — a REJECTED/CLOSED requisition no longer holds the residual

`unrequisitionedLines` counted every `open`/`ordered` line, but the server's §F bound-1 count
filters `requisition.status NOT IN ('rejected','closed')`
(`labour-procurement.service.ts:258-262`) — a rejected requisition's lines stay `open` in the
DTO while its demand is re-sourceable, so the helper computed zero residual and the raise
button never came back. The helper now skips dead parents. Probes: rejected/closed release the
full residual; draft/submitted/approved still hold it; mixed dead+live sums correctly.

### R4-2 — a LATE arrival promise is never offered for drawdown

`pickCommitmentFor` admitted any committed same-slice commitment, but forecast eligibility
requires `latestPromise <= civilDate` (own civil date when no promise exists —
`labour-coverage.service.ts:292-304`): drawing capacity whose supplier arrives after the slice
would let a blocked activity read as sourced. The picker now applies the same bound. Probes:
promise after the slice → null; on/before → offered; no promise → own-date fallback offered;
an on-time sibling beats the late one.

### R4-3 — Record work parses the FULL numeric string

`Number.parseInt` truncated `'1e2'`→1 and `'7.5'`→7 with `valid` still true, so an intended
100 minutes could be recorded as 1 — a corrupted `LabourWorkFact` feeding §I productivity.
The input now parses with `Number` over the whole string (empty → invalid): `'7.5'` disables
the action, `'1e2'` records the real 100. Rendered probe covers all three shapes.

### R4-4 — the allocate coalesce identity carries the SELECTED revision

`allocateCoalesceKey` omitted the revision, so a stale rev-N op queued offline swallowed a
legitimate rev-N+1 action for the same worker/slice (the stale op replays, 409s on head drift
and drops — leaving NOTHING queued for the new head). The key now includes `originRevision`
(store + hub pass it; persisted ops keep their stored keys byte-for-byte — the normalizer never
recomputes, so hydration is unchanged). Probes: rev-1 vs rev-2 keys differ; with a rev-1 op
held in flight the rev-2 action queues as a SECOND op with a distinct key; a same-revision
duplicate still coalesces.

### Round-4 gate battery (this head)

- Reproduce-first: the four R4 probes + two signature-updated probes **RED** with the pre-fix
  source stashed at `c1f4c40` → all GREEN on this head (focused labour suites 65/65).
- `pnpm check` EXIT 0 — web **502/502** (498 + the round-4 probes), API unit 680/680.
- Full integration on a pristine migrated DB — **72 files / 695 tests** (API untouched this
  round; web-only changes).
- `upgrade-proof.sh` PASSED (no migration; regression only).
- e2e: `test:e2e:api:allmodules` (legacy) **35/35** CLEAN first run; `:outbox` **35/35** CLEAN
  first run — the **labour-pilot suite 4/4 in BOTH modes**, exercising the revision-keyed
  allocate and the residual requisition raise this round touched.

## 9. Codex correction round 5 (the three current-head findings on `8ef0c52`)

Codex's round-5 review reached `8ef0c52` late (after the gate's second double-timeout + the
documented recovery dispatch; the orchestrator republished the late-arriving findings as the
required failure). Three P2 findings, all reproduced RED first (source stashed at `8ef0c52`:
5 probes failed), then fixed:

### R5-1 — in-flight allocations close the slice for EVERY worker

The allocate guard was keyed to the SELECTED worker (`pending(aKey)`), so while W1's command
was in flight the user could pick W2 (a different key) and queue a second own-workforce
allocation against a 1-person slice — a 2/1 over-allocation the server accepts (it caps only
supplier drawdown). New `isAllocatePendingForSlice` (`lib/labourKeys.ts`, which owns the key
format) matches ANY worker/revision for the `(activityId, requirementId, civilDate)` slice;
the stop is now `sourced + slicePending >= personShiftQty`, with an honest `N allocating…`
hint on the slice line. Probes: key-matcher table + rendered (in-flight W1 disables the picker
and button for W2).

### R5-2 — the roster onboarding key is held until CONFIRMED success

`onboardLabourWorker` minted a fresh idempotency key inside each submit; a committed-but-lost
`/labour/workers` response was reported as failure, and the retry's NEW key minted a SECOND
`Worker` identity (the roster has no natural uniqueness on name/trade). The store now holds
ONE key per submitted form (`labourOnboardPending` — project-scoped, torn down on scope
change): a retry of the SAME form reuses the key verbatim (the ledger replays — no duplicate),
a CONFIRMED success clears it (a later deliberate identical onboarding — a genuinely distinct
same-name worker — mints a fresh key), and a CHANGED form is a different command. Probe: lost
response → retry same key; after confirmation → third submit gets a new key.

### R5-3 — a WORKED-then-released allocation keeps the worker booked for the shift

`bookedWorkerIds` counted ACTIVE allocations only, so after allocate→work→release the worker
was re-offered for a second same-`(civilDate, shift)` slice — coverage still counts their
delivered work for the ORIGINAL slice, so one person could satisfy two same-shift
person-shifts. The helper now takes the work facts: a released allocation with a work fact
stays booked; only a NO-WORK release frees the worker (per shift — another day is unaffected).
Probes: worked release booked · unrelated fact not · other-day free · the R2 no-work-release
carve-out restated.

### Round-5 gate battery (this head)

- **Reproduce-first**: the five R5 probes RED at `8ef0c52` (`5 failed | 64 passed` with the
  web fixes stashed) → GREEN restored: `labour.test.ts` + `labour-screen.test.tsx` **69/69**.
- `pnpm check` **EXIT 0** — web **506/506** (42 files), API **680/680** (55 files), builds clean.
- Full API integration on a pristine migrated DB (psql drop/create + `prisma migrate deploy`):
  **72 files / 695 tests** passing.
- `upgrade-proof.sh` **PASSED** (no migration in this round; every prior seal survives).
- `test:e2e:api:allmodules` (legacy): first run 34/35 (the documented `project-scope`
  history flake — no labour surface), clean re-run **35/35**. labour-pilot 4/4.
- `test:e2e:api:allmodules:outbox`: two runs on the container's five-suite-old accumulated DB
  failed in the documented timing families (`pillar-chain` inspection chain ×3 +
  `inspections-module-query`/`drawings-module-query`); on a FRESHLY recreated DB the entire
  pillar chain passed (34/35 — isolating the residual to the documented
  `inspections-module-query` project-switcher timeout, no labour surface), and the deciding
  re-run was clean **35/35**. labour-pilot 4/4. Fresh-runner CI is the deciding gate evidence.

## §10 — Codex correction round 6 (five findings on `8a4b3ef`)

Each finding verified against the cited server code BEFORE the fix, and all five reproduced
RED at `8a4b3ef` (pre-fix `apps/web/src` restored: **9 failed | 68 passed** across the two
labour suites) → GREEN with the fixes: **77/77**.

### R6-1 — a STALE-revision pending op must not fill current demand

Round 5's slice-wide pending stop counted queued allocate keys for ANY revision, so a rev-1 op
still in the durable outbox made a one-person rev-2 slice read as full — suppressing exactly
the current-head allocation the revision-keyed coalesce identity (round 4) exists to preserve.
`isAllocatePendingForSlice` now takes the SELECTED revision and prefix-matches
`lab:alloc:<act>:<req>@<rev>:<date>:` (a `crew:<id>` subject, which contains ':', now also
matches — a latent parser gap closed). The stale op still replays, 409s on head drift and
drops. Probes: key-matcher table (stale-rev false · current-rev true · crew subject) +
rendered (a rev-99 pending key leaves the rev-1 slice fully allocatable, no "allocating…").

### R6-2 — already-mustered workers leave the manual attendance picker

A second muster for the same (worker, project day, shift) is the server's deterministic 409
("already recorded — revoke it to correct it", `labour-capacity.service.ts:466`) the outbox
drops as terminal. `musteredWorkerIds` filters the `labour.presence` musters (active only —
the read excludes revoked rows) by the SELECTED shift, and the picker offers only workers
without one; the night shift re-offers a day-mustered worker. Probes: helper table + rendered
shift-switch.

### R6-3 — the commitment picker RESERVES pending supplier draws

A queued allocate op carrying a `capacityCommitmentId` was invisible to `pickCommitmentFor`,
so a second worker chosen before the labour reload re-picked the same fully-drawn commitment —
the flush then 409s the second command under §F bound 3 when own-workforce would have covered
the remaining demand. The screen folds the durable outbox's allocate ops into a per-commitment
`pendingDraws` map the picker subtracts alongside committed draws. Probes: picker table
(1-qty reserved → null; 2-qty with one pending → offered; active+pending combine) + rendered
(queued draw → the next allocate goes own-workforce with NO supplier hint; control passes the
id through).

### R6-4 — the device-bind holds ONE idempotency key until CONFIRMED success

The bind CAS succeeds once (`worker-devices.service.ts:47` — a same-pair re-bind is "already
bound to this worker" 409), so a committed-but-lost response retried with a FRESH key reported
failure for a binding that succeeded. `bindLabourDevice` now mirrors the round-5 onboarding
discipline: ONE key per submitted `(deviceId, workerId)` pair (project-scoped
`labourBindPending`, torn down on scope change), reused verbatim on retry so the command
ledger replays the original success; only a CONFIRMED success clears it. Probe: reject-once →
same key on retry → confirmed → a different pair mints a fresh key.

### R6-5 — Record work caps at the REMAINING shift minutes

The entry validated only `1..720` while the server's guardrail is CUMULATIVE
(`SHIFT_MINUTES = 720`, Σ workedMinutes per worker/date/shift across ALL allocations,
re-derived under the worker lock — `labour-capacity.service.ts:548-551`): after a recorded
480, the default 480 was a certain terminal 409. `remainingShiftMinutes` mirrors the
cumulative rule; the input defaults to `min(480, remainder)`, shows "`N` left this shift",
refuses an over-remainder entry, and a full shift disables the row as "Shift full". Probes:
helper table (multi-allocation sum · other worker/day excluded · floors at 0) + rendered
(240-remainder default + 241 refused + 240 recorded; 720 recorded → Shift full).

### Round-6 gate battery (this head)

- **Reproduce-first**: pre-fix `apps/web/src` restored at `8a4b3ef` → **9 failed | 68 passed**
  across the two labour suites; fixes restored → **77/77** GREEN.
- `pnpm check` **EXIT 0** — web **514/514** (42 files), API **680/680** (55 files), builds clean.
- Full API integration on a pristine migrated DB (psql drop/create + `prisma migrate deploy`):
  **72 files / 695 tests** passing.
- `upgrade-proof.sh` **PASSED** (no migration in this round; every prior seal survives).
- `test:e2e:api:allmodules` (legacy): **35/35** CLEAN first run; labour-pilot 4/4.
- `test:e2e:api:allmodules:outbox`: first run 34/35 (the documented timing-sensitive
  `cross-cutting-surfaces` response-capture step — no labour surface), clean re-run **35/35**;
  labour-pilot 4/4.

## §11 — Codex correction round 7 (three findings on `b2beb4c`)

One SERVER-side gap (verified in `labour-capacity.service.ts` before coding — `recordWork`
selected the allocation's `status` and never checked it) and two outbox-visibility gaps in the
hub. Reproduce-first: the API probe run LIVE against the unmodified service (the released-
allocation work fact was ACCEPTED → 409 after the fix), and the web probes RED at `b2beb4c`
(pre-fix `apps/web/src` restored: **4 failed | 77 passed**) → GREEN with the fixes: **81/81**.

### R7-1 — effort against a RELEASED allocation is refused (server)

A work op queued while the allocation was active and flushed AFTER a no-work release still
appended a `LabourWorkFact` — resurrecting delivered-effort evidence (§A worked-counts-as-
coverage + §I productivity) that the release was meant to remove. `recordWork` now refuses any
non-active allocation with a deterministic 409 (terminal — the outbox drops it), evaluated
under the readiness lock the release command also holds, so the two can never interleave. A
keyed replay of an op that COMMITTED while active is untouched (the ledger returns the
recorded result without re-running the check). Probe (`phase4-t6-allocation-pin.test.ts`):
allocate → release(no work) → record 409 + zero facts; control — an active allocation records.

### R7-2 — pending worker bookings reserved across slices (web)

`bookedWorkerIds` sees only committed state, so a worker with an allocate op still in flight
stayed offerable for a SECOND same-(date, shift) slice — a different requirement means a
different coalesce key, both queue, and the flush's second command is the server's
one-live-allocation 409, dropped. `pendingBookedWorkerIds` folds the durable outbox's allocate
ops into the per-slice booking set (the op carries no shift — it is resolved through the op's
requirement in the CURRENT view; an op whose requirement left the view books conservatively).
Probes: helper table (this-shift booked · other-shift free · unknown-requirement conservative ·
other-date free · crew op ignored) + rendered (two same-day mason slices; the in-flight worker
is absent from the second picker, the second mason offered).

### R7-3 — the work row stays disabled while ANY record is pending (web)

The work coalesce key carries the MINUTES, so editing the input while the first record was in
flight re-enabled the button and queued a SECOND distinct command (two facts, or a
cumulative-cap 409, for a user trying to correct the pending entry). `hasPendingWorkFor`
disables the row while any queued work op targets this allocation OR another allocation of the
same `(worker, civilDate, shift)` (the server's cumulative frame); `isWorkPendingForAllocation`
pins the minutes-agnostic key match. Probes: helper tables + rendered (pending 480 → edit to
240 → still disabled, no second dispatch).

### Round-7 gate battery (this head) — ALL CLEAN, single pass

- **Reproduce-first**: the API probe run LIVE against the unmodified service (the released-
  allocation work fact ACCEPTED → 409 after the fix); the web probes at `b2beb4c` with the
  pre-fix src restored → **4 failed | 77 passed**; fixes restored → **81/81** GREEN.
- `pnpm check` **EXIT 0** — web **518/518** (42 files), API **680/680** (55 files), builds clean.
- Full API integration on a pristine migrated DB (psql drop/create + `prisma migrate deploy`):
  **72 files / 696 tests** passing (+1 — the R7-1 released-allocation refusal probe).
- `upgrade-proof.sh` **PASSED** (no migration in this round; every prior seal survives).
- `test:e2e:api:allmodules` (legacy): **35/35** CLEAN first run; labour-pilot 4/4.
- `test:e2e:api:allmodules:outbox`: **35/35** CLEAN first run; labour-pilot 4/4.

## §12 — Codex correction round 8 (four findings on `0a35642`)

One SERVER-side verification gap (the allocate contract accepted no statement of WHICH spec
identity the picker satisfied, so a substitution revoked between render and flush was silently
re-based onto the head) and three outbox/staleness gaps in the hub. Reproduce-first: pre-fix
`apps/api/src` + `apps/web/src` restored at `0a35642` → API pin suite **1 failed | 3 passed**,
web labour suites **5 failed | 79 passed**; fixes restored → API **4/4**, web **84/84** GREEN.

### R8-1 — one held roster key PER pending form signature (web)

The rounds-5/6 held-key discipline stored ONE `{sig, key}` slot per roster command, so
submitting worker B while worker A's onboard was still unresolved OVERWROTE A's held key — a
retry of A then drew a FRESH key and the ledger executed it a second time (duplicate Worker;
for bind, the false "already bound" 409). `labourOnboardPending`/`labourBindPending` are now
`Record<signature, key>` maps: each distinct form signature holds its OWN key (reused verbatim
on its retry, deleted only by ITS confirmed success or scope teardown), and interleaved forms
never disturb each other. Probe: submit A (lost response) → submit B → retry A: B's key differs
from A's, A's retry reuses A's original key byte-for-byte.

### R8-2 — field-op buttons stay held until the fresh bundle APPLIES (web)

The flush hook cleared resolved labour coalesce keys as soon as the command settled, but the
hub's rows still rendered the PRE-command bundle until `loadLabour` returned — a re-enabled
button over stale truth invited the same action again (a second allocate = the server's
one-live-allocation 409; a second muster = the duplicate-muster 409). The flush no longer
filters `labourPending` at settle time; it only triggers the scope-guarded reload, and
`loadLabour`'s APPLY step rebuilds `labourPending` from the live outbox (a settled op is gone
from the outbox, so its key drops exactly when the fresh truth lands; a still-queued op keeps
its key). Probe: flush with the reload response HELD → op resolved from the outbox but the
coalesce key still pending (button disabled) → release the reload → pending empty.

### R8-3 — stale-revision pending bookings never book (web)

`pendingBookedWorkerIds` folded EVERY queued allocate op into the per-slice booking set, but an
op pinned to `originRevision` N is a deterministic head-drift 409 once the requirement is
revised to N+1 — the worker it names was reserved for a command that can only be dropped.
The fold now skips an op whose `originRevision` no longer matches the CURRENT revision of its
requirement in view (the flush will shed it); an op whose requirement has LEFT the view still
books conservatively (no revision to compare — never free a worker on missing evidence).
Probe rows: stale-revision op NOT booked; unpinned/unknown-requirement ops still booked.

### R8-4 — the allocation basis is VERIFIED, the frozen identity stays the HEAD (server + web)

Finding: the hub offered a worker via an ACTIVE `ApprovedSkillSubstitution` but the allocate
command carried no fingerprint at all — the server allocated on the head spec regardless, so a
substitution revoked between render and flush produced an allocation whose §B authorization no
longer existed, indistinguishable from a directly-qualified one. The correction is
**verify-the-basis**, NOT freeze-the-substitute: `labour.allocate` gains an optional
`labourSpecFingerprint` (the UI now states the basis it rendered — the head fingerprint when
the worker satisfies it directly, else the substitution target that qualified them), and the
server 409s unless that basis IS the head identity or an ACTIVE (unrevoked) approved
substitution from it, re-checked in-tx under the readiness lock. The PERSISTED
`WorkerAllocation.labourSpecFingerprint` remains the HEAD identity: the merged Task-3
migration `20270210000000` seals `WorkerAllocation_spec_fkey (projectId, requirementId,
originRevision, labourSpecFingerprint) → LabourRequirementSpec(projectId, requirementId,
revision, labourSpecFingerprint)` — allocation identity == head spec identity is a
PG-enforced, independently-cleared §C invariant, verified on every deploy by the T3C seal
registry (`t3c-diagnostics.ts` `T3C_PREREQUISITE_FK_SEALS`), and a Task-6 UI round does not
reverse a cleared Task-3 seal. Substitution provenance already lives first-class in the
`ApprovedSkillSubstitution` register (who approved, what widening, when revoked); an
allocation made under an authority the pmc later regrets is undone by the existing
`allocation.release` lever. Probes: allocate via an ACTIVE substitution basis → accepted AND
the persisted fingerprint IS the head (FK truth); revoke the substitution → same basis 409;
unknown 64-hex basis → 409; explicit head basis → accepted. Rendered: a carpenter offered
through a substitution dispatches WITH the substitution-target basis; a directly-qualified
worker dispatches the head basis and keeps its commitment draw.

### Round-8 gate battery (this head)

- **Reproduce-first**: pre-fix src restored at `0a35642` → API pin suite **1 failed | 3
  passed**, web labour suites **5 failed | 79 passed**; fixes restored → API **4/4**, web
  **84/84**, typecheck clean.
- `pnpm check` **EXIT 0** — web **521/521** (42 files, +3 round-8 probes), API **680/680**
  (55 files), builds clean.
- Full API integration on a pristine migrated DB (psql drop/create + `prisma migrate deploy`):
  **72 files / 697 tests** passing (+1 — the R8-4 basis-verification probe).
- `upgrade-proof.sh` **PASSED** (no migration in this round; every prior seal survives).
- `test:e2e:api:allmodules` (legacy): **35/35**; labour-pilot 4/4. One first run failed on the
  documented `inspections-module-query` switcher timeout plus a `daily-log-module-query`
  visibility miss — neither a labour surface, both clean on the single deciding re-run.
- `test:e2e:api:allmodules:outbox`: **35/35** CLEAN first run; labour-pilot 4/4.
