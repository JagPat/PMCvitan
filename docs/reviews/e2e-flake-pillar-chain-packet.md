# e2e flake burndown — the pillar-chain inspection trio

**Scope:** test infrastructure only. Two spec files change; **zero product/runtime code, zero
schema, zero migration**. This is the `e2e-flake-burndown` backlog item in `docs/STATUS.md`
("Convert each to a deterministic wait — reproduce-first, one family per PR"), covering the
**pillar-chain family** plus the one-block `inspections-module-query` project-switcher hardening
that shares the same open-and-pick re-render mechanism.

- `apps/web/tests/e2e-api/pillar-chain.spec.ts`
- `apps/web/tests/e2e-api/inspections-module-query.spec.ts`

## Reproduce-first honesty

A timing flake cannot be made deterministically RED: the failing interleaving belongs to the
scheduler, not to any input this suite controls. What stands in for a red reproduction is
(a) the **mechanism, traced in the product code** below — each race is a real ordering the store's
own design permits, not a guess — and (b) the **recorded CI history** of exactly these steps:

- `docs/reviews/phase-4-t3-correction-packet.md` ("CI `api-e2e` flake at `fc21a78`") names the
  trio precisely: `:231` (the re-inspection task never rendered after `send-reinspection`),
  `:261` and `:319` cascading from it, and the `DrawingRevision_drawingId_rev_key` duplicate a
  pillar-chain retry leaves behind (also seen on `main` at `5b7b8c4`, run 29995907028 — a commit
  that later received an independent GREEN SIGNAL). Same commit, push-triggered run green,
  PR-triggered run red: identical code, opposite outcomes.
- `docs/reviews/phase-4-t2-labour-procurement-packet.md` (gate battery notes) names the exact
  symptom: `getByTestId('submit-inspection')` had not yet flipped to "submitted" within the 10s
  expect wait.
- `docs/reviews/phase-2-consolidated-review-packet.md` ("One-time e2e flake") records the earliest
  sighting: the checklist submit stayed `idle` — a swallowed click during the post-upload refresh
  burst.

The retry-containment fix (point 5 below) **was** proven red→green style: a scratch copy of the
spec with a one-shot injected failure after the client approval commits (mutating the first
attempt's project) fails its head test, **skips** every dependent, and passes 10/10 on the serial
retry through the fresh-project path — exit 0. The scratch copy is not part of this PR.

## The three races (mechanism, from the code)

**Race A — the submit button stays "Submitting…"** (`:241-242`, `:270-271` pre-change). The
store's write path captures a snapshot lease **before** the request (`runRemote` /
`submitInspection` in `apps/web/src/store/store.ts`). The media upload immediately before the
submit makes the server emit `changed`; a socket-driven refresh takes a **newer** lease; the
submit's own reply then resolves `'superseded'`. The design keeps the checklist frozen and
schedules a deferred reconcile — correct product behaviour — but the button label (driven by
`checklist.submitted`, `EngineerChecklistScreen.tsx`) only flips when that reconcile lands, which
under CI load exceeds the 10s expect timeout. Deeper: on `'superseded'` the upload's *toast* fires
while the store is still stale (`consumeSnapshotResult` announces on `applied` **or**
`superseded`), so the old toast-then-click sequence could click submit while the local item still
had no photo — the fail-needs-photo guard then swallows the click entirely and no POST is ever
dispatched (the Phase-2 packet's "stayed `idle`" sighting).

**Race B — the reinspection row never renders** (`:249-250`, `:256-258` pre-change). Line `:250`
asserted a transient toast whose delivery is lease-gated; line `:258`'s Inbox row is composed
client-side from the store's `checklist` slice (`selectors.ts`, `eng-checklist`), and the fresh
ENG session's load-time snapshot races the PMC's still-in-flight `/decide` commit. The existing
`pollGate(request, 'inspection', 'fail')` samples the **readiness gate**, which can read `fail`
before the reinspection **checklist row** exists in a fresh snapshot — the poll never covered what
`:258` asserts.

**Race C — cascade + retry poison** (`:261`, `:319` pre-change). The five browser tests are one
dependent chain over one project, but ran as independent tests: when `:231` failed, `:261` and
`:319` ran against half-mutated state and failed as cascade victims. Worse, the CI single-test
retry re-ran `:319`'s POST of drawing CH-100 rev B against the already-mutated database — the
documented `DrawingRevision_drawingId_rev_key` duplicate.

## The six fixes

1. **Submit legs** (both inspection tests): the click is wrapped with `page.waitForResponse` on
   the submit POST (the proven pattern from `inspections-module-query.spec.ts`'s decide flow), and
   the label assertion is **replaced** by the new server-truth `pollChecklistSubmitted(request,
   title)` (alongside `pollGate`/`pollStatus`), which polls the snapshot's `placedInspections`
   submitted flag — server truth is not defeated by the superseded-lease branch. (The
   `data-submission` attribute was considered and rejected: it is driven by the same
   `checklist.submitted` store state as the label, so it inherits the same lag.)
2. **Decide leg**: the `/decide` POST is awaited before any assertion, and the transient
   "re-inspection task" toast assertion is replaced by durable state — the decided review (the
   only pending one) **leaves the queue**, so the review screen's empty state renders.
3. **Before the ENG session**: the new `pollEngChecklist(request, 'Re-inspection: Chain quality
   check')` polls the **engineer's own** snapshot until the reinspection checklist IS the served
   field view — only then does the browser sign in and assert the Inbox row. The gate poll is kept
   (it proves the gate); the new poll covers what `:258` actually asserts.
4. **Upload legs**: the lease-gated `/uploaded and linked/i` toast assertions are replaced by the
   durable evidence state the screen renders after the reconciled snapshot lands — the linked
   thumbnail (`Evidence 1 — Level within tolerance`). This is load-bearing beyond flake removal:
   it guarantees the store *knows* the photo before the submit click, closing the swallowed-click
   branch of Race A. (The per-item camera-count chip is driven by `InspectionItem.photos`, which
   the media-link path does not bump — the thumbnail is driven by the real
   `InspectionEvidence` linkage, the same field the OFFLINE test polls server-side.)
5. **Cascade containment**: `test.describe.configure({ mode: 'serial' })` at the top of the file —
   a failed head now **skips** its dependents instead of poisoning them. In serial mode a CI retry
   re-runs the whole file, so `beforeAll` names each attempt's chain project uniquely
   (`Chain Acceptance Site R2` on retry 1): the retry authors a **fresh** chain instead of
   re-authoring into the mutated one, where the wait-gate assertions and the unique
   `(drawing, rev)` labels no longer hold. Belt-and-braces, the two NEGATIVES drawing POSTs
   (CH-100 rev B, CH-101 rev A) additionally tolerate the server's deterministic 409
   (`DrawingRevision_drawingId_rev_key`) from a prior same-project attempt, then assert the
   governing set — which both outcomes leave identical.
6. **`inspections-module-query.spec.ts` switcher**: the un-retried read-then-click project-switch
   block is wrapped in the same `toPass()` open-and-pick retry unit `pillar-chain`'s
   `signInToChain` already uses (a post-sign-in re-render can close the just-opened dropdown
   before the option is clicked — deterministic on slow containers).

## Validation

Environment: compiled API (`node dist/main.js`) over a freshly migrated + seeded disposable
PostgreSQL (`pmcvitan_e2e`), real browser, run from the repo root exactly as
`scripts/test-api-e2e.sh` does.

- **Focused, 3 consecutive runs** (fresh seed each; allmodules read flags + legacy sender — the
  configuration whose CI runs documented the flakes): `pillar-chain.spec.ts` +
  `inspections-module-query.spec.ts` → **10/10, 10/10, 10/10** (9 pillar-chain + 1
  inspections-module-query per run).
- **Retry-containment proof** (scratch copy, one-shot failure injected after the client approval
  commits, `--retries=1`): attempt 0 fails the head, all 8 dependents **skipped** (`did not run`,
  not failed); retry #1 re-runs the whole file on the fresh `R2` project — **10/10, exit 0**
  (Playwright verdict: 1 flaky, rest passed).
- **Full `pnpm test:e2e:api:allmodules`, once**: **37/37 passed** (~1.4m), no flake.
- **Full `pnpm test:e2e:api:outbox`, once** (the other CI `api-e2e` step): **31 passed /
  6 skipped** (the module-query specs skip by design outside their mode), no flake — no re-run
  was needed; neither documented unrelated flake family (`daily-log-lost-response`,
  `project-scope` history) surfaced in these runs.
- `pnpm --filter web typecheck` EXIT 0; `pnpm --filter web lint` EXIT 0. No API/runtime file
  changed, so the backend gates are untouched by construction.

## Deliberately NOT fixed here

Per the backlog's one-family-per-PR rule:

- the **`daily-log-lost-response`** timing family (documented in the Phase-4 T1 correction
  packet) — separate PR;
- the **`project-scope` browser-history** family (documented in the Phase-3 T7 correction
  packet) — separate PR;
- the store's lease/reconcile design itself: `'superseded'` + deferred reconcile is correct
  product behaviour (a newer refresh owns the view); the tests now assert server truth and durable
  UI state instead of racing it. No product change is warranted, and none is made.
