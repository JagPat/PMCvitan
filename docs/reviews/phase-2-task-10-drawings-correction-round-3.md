# Phase 2 Task 10 — Drawings correction round 3 (C2c) — Review Packet

Terminal completion-accounting fix following the #176 mechanical review. Base: latest `main` @ `4b70397`.
**Not** a redesign, a schema change, a hashing change, or a readiness-guard change — one small runtime PR.
Branch `claude/phase2-task10-drawings-correction-3` (from `main` @ `4b70397`). Frontend only; no migration.

---

## Defect (P2, from the #176 mechanical review)

`publishAllDrafts` treated "no `publishDrawing` op remains in the outbox" as success. But `flushOutbox`
also removes **terminally-rejected 4xx** ops (it drops them so they never wedge the queue), so queue
absence does **not** prove publication. Reproduction: decisions=[] + one draft drawing; make
`gateway.publishDrawing` reject `{status: 422}`; call `publishAllDrafts()` → the drawing stayed a draft and
the op was discarded, yet the toast said "Published 1 draft".

## Fix

- **`flushOutbox` now resolves a structured `OutboxFlushResult`** — `{ ran, scopeMoved, succeededKeys,
  droppedKeys, pendingKeys }`, keyed by each processed op's idempotency key. `succeededKeys` = replayed OK,
  `droppedKeys` = terminally rejected (a 4xx, discarded), `pendingKeys` = still queued (transient stop /
  scope-moved remainder). `ran:false` = coalesced behind an in-flight flush, no gateway, or nothing to
  flush. Every existing caller ignores the return, so this is additive.
- **`publishAllDrafts` captures the exact keys it created** (`drawingKeys`) and classifies **only those**:
  - any targeted key in `droppedKeys` → an honest **rejection / partial-failure** message; **never**
    overwritten by "Published N". Singular ("The drawing draft was rejected and not published…"), all
    ("All N drawing drafts were rejected…"), or partial ("N … rejected … the rest went through …").
  - else a decision failed → the existing "Could not publish every draft … try again." message.
  - else any targeted key still in the queue → the existing syncing / offline message.
  - else (decisions OK **and every** targeted drawing op confirmed succeeded, or no drawings) → "Published N".
- **Preserved:** scope pinning + synchronous flush, durable stable keys, the direct decision-publish path,
  and all existing generic outbox behavior (the flush's own batch summary, drop/dead-letter, rerun).

## Reproduce-first tests (`drawings-publish-all.test.ts`)

1. **One drawing + terminal 422** — the op is discarded yet the drawing stays a **draft**; the toast is an
   explicit "rejected and not published", **never** "Published 1 draft".
2. **Two drawings, one success + one terminal 422** — the successful drawing is **published**, the rejected
   one stays a **draft**; **no** complete-success; an explicit **partial-failure** message ("… the rest …").
3. The existing lost-response, reload/replay, mixed-batch, location-control, and snapshot-ordering tests
   remain green (regression guard).

---

## Verification

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| Web unit (incl. the 2 new terminal-drop tests) | **381 passed** |
| API unit | **556 passed** |
| Full integration suite (live PostgreSQL) | **306 passed** |
| `snapshot-ordering` + `drawings-location-block` + `drawings-publish-all` | **44 passed** |
| `apps/api/scripts/upgrade-proof.sh` (adds NO migration) | **PASSED** |
| `pnpm test:e2e:api:drawings` (moduleQuery) | env-flaky in this runner — CI authoritative |

The API-backed Drawings E2E is environmentally flaky in this session's runner (a manually-started dockerd
with the compiled API + vite + chromium contending for CPU; different single spec times out per run). It is
unrelated to this change — frontend-only, no server/acknowledge/register-render path touched. CI is the
authoritative gate.

**HELD for one mechanical review of this terminal branch — do not merge.** Inspections does not start yet.
