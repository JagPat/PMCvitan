# Phase 2 Task 10 — Drawings module CORRECTION round 2 (C2b) — Review Packet

Follows the merged correction (PR #175, on `main` @ `488e812`). Base: latest `main`. **Not** a rollback of
#175, a Drawings redesign, a schema change, or the start of Inspections — a focused, runtime-only
correction that closes the two remaining gaps from the #175 review without reopening C1.

Branch `claude/phase2-task10-drawings-correction-2` (from `main` @ `488e812`). Two runtime files, two new
test files — **frontend only** (no `apps/api` change, no schema, **no migration**).

| Area | File |
|---|---|
| C2b-1 — `publishAllDrafts` drawing publishes are durable | `apps/web/src/store/store.ts` |
| C2b-2 — location editor honours the readiness gate | `apps/web/src/screens/DrawingsScreen.tsx` |
| C2b-1 tests (reproduce-first) | `apps/web/tests/drawings-publish-all.test.ts` (new) |
| C2b-2 tests (UI) | `apps/web/tests/drawings-location-block.test.tsx` (new) |

---

## Vision alignment

The controlled-drawing register stays a per-site operational record reached only through the module's
contract + `drawing.*` events; this correction touches no ownership, no projection shape, and no tenancy.
It hardens the **command path** already established in #175: the bulk "Publish all" now routes every
DRAWING publish through the same durable write-ahead outbox as the single publish (so a lost/uncertain
response replays the SAME op under the SAME key and publishes exactly once), and the drawing LOCATION
editor now honours the single `drawingMutationsBlocked` readiness gate that every other drawing command
already respects (so no re-file/unfile ever runs against a register the client has not actually loaded).
Human approvals stay attributable and exactly-once; migrations are untouched (this correction adds none).

---

## C2b-1 — `publishAllDrafts`: DRAWING publishes are durable write-aheads (`store.ts`)

**Gap (from the #175 review).** The bulk Publish-all published each drawing draft with a **direct**
`gw.publishDrawing(id, newIdempotencyKey())` — a fresh key minted per call, no write-ahead. A lost or
uncertain response could not be replayed under the original key, so the exactly-once guarantee that the
single-drawing publish already had did not hold for the batch.

**Fix.** The gateway branch now WRITE-AHEADS every drawing publish to the durable outbox — a
`{ t:'publishDrawing', drawingId, idempotencyKey }` op per draft with a STABLE key each, persisted to
localStorage **before any network request** — then drains them through the SAME flush/reconcile machinery
every other write-ahead command uses (`runWriteAhead` → `flushOutbox`). Key points:

- **Never a direct fresh-key publish.** The only path to the server is the outbox replay
  (`replayOutboxOp` → `gw.publishDrawing(drawingId, op.idempotencyKey)`), under the op's ORIGINAL key. A
  lost response / reload / replay reuses that key and publishes exactly once (the command ledger dedupes).
- **The flush is triggered synchronously, in THIS scope.** `flushOutbox` pins its own
  `(project, generation)` + gateway before its first await, so a project switch mid-publish leaves these
  ops queued for THIS project and **never crosses scopes nor supersedes another scope's live pull**. This
  is what the single publish (`runWriteAhead`) already does; the batch now matches it. (The earlier draft
  deferred the flush into the post-`await` continuation, which — because `getInitialState` seeds a draft
  drawing — took a lease against the NEW scope and superseded a switched-to project's snapshot pull; the
  synchronous flush removes that class of bug, proven by the unchanged `snapshot-ordering` "gap 1B".)
- **Decisions are preserved verbatim.** Decision drafts still publish directly via `gw.publishDecision`
  and reconcile once from a fresh snapshot — no new bulk API, no cross-entity transaction.
- **Honest reporting.** The batch never announces "Published N drafts" while a `publishDrawing` op is
  still queued (offline, or kept by a transient failure); it reports the honest partial state instead.

**Reproduce-first tests (`drawings-publish-all.test.ts`, 5):**
(1) a durable `publishDrawing` op per draft with DISTINCT stable keys, persisted to localStorage BEFORE
any network call; (2) a LOST response keeps the op queued under its ORIGINAL key and never shows a false
"Published"/"try again"; (3) reload (`hydrateOutbox`) + replay reuse the SAME original key; (4)
committed-but-lost — after the retry the register reconciles to ONE published drawing (same key
throughout, no premature failure); (5) a mixed decisions+drawings batch — decisions publish directly
(preserved) while the drawing reaches the server ONLY through the outbox replay under its stable key,
never a direct fresh-key call.

## C2b-2 — the location editor honours `drawingMutationsBlocked` (`DrawingsScreen.tsx`)

**Gap (from the #175 review).** `DrawingLocationBlock`'s re-file/unfile controls did not consult the
shared readiness gate, so a PMC could open the location editor and move/unfile a drawing while the
module-owned register read was idle / loading / error — i.e. against stale or absent data.

**Fix.** The block subscribes to the SINGLE shared predicate `drawingMutationsBlocked` (reactive):

- The Move / "File to a location" control is **disabled** while the register is idle/loading/error — you
  cannot even open the editor on an unsettled register.
- If the register becomes blocked **while the editor is already open**, the LocationPicker (pointer-events
  off + a guarded `onChange`) and the Unfile button **disable immediately** and a "paused" notice appears
  — every location mutation command is prevented.
- The controls **re-enable** the moment `drawingsLoad` returns to `ready`.
- The store's own defensive `fileDrawing` guard remains the backstop (unchanged from #175 / C3).

**UI tests (`drawings-location-block.test.tsx`, 7):** error/loading with last-good → Move disabled + a
click never opens the editor; register goes blocked WHILE the editor is open → Unfile disables + paused
notice + a click never reaches `fileDrawing`; ready → Move enabled and, once open, Unfile enabled with no
paused notice; recover to ready → controls unlock; snapshot mode never locks (no regression).

---

## Verification

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| Web unit suite (incl. the 12 new C2b tests) | **379 passed** |
| API unit suite | **556 passed** |
| Full integration suite (live PostgreSQL) | **306 passed** |
| `snapshot-ordering` (regression guard — "gap 1B" stale old-scope lease) | **30 passed** (unchanged) |
| `apps/api/scripts/upgrade-proof.sh` (this correction adds NO migration) | **PASSED** |
| `pnpm test:e2e:api:drawings` (controlled-drawing lifecycle — moduleQuery, rebuilt stack) | see note |

**On the E2E, in this session's runner:** the API-backed Drawings E2E is **environmentally flaky in this
container** (a manually-started dockerd with the compiled API + vite + chromium contending for CPU): each
run a *different single* spec hits a visibility/response **timeout** (a `DRAWINGS · REGISTER` header or an
`ack` POST that arrives after the 10s window), with 21–22 of 24 specs passing. This is **pre-existing and
unrelated to this change** — the identical spec fails the same way on `main` with this PR's two runtime
files stashed, and this correction touches **no** API/server code and **no** part of the acknowledge or
register-render path. On a normally-resourced CI runner the suite is green (the merged #175 packet records
`test:e2e:api:drawings` = **2 passed**); CI is the authoritative gate for this run.

**HELD for one mechanical Codex review — do not merge.** Inspections (module 3) does not start until this
correction clears review.
