# Phase 3 — Task 7 correction 4 packet (backward-compatible hydration of PR #207 materials outbox ops)

**Base:** `main` @ `8b7fabf` (the merge of PR #208). **Branch:** `claude/phase3-t7-correction4`.
**Reviewed lineage:** PR #208 head `994f8ec`, merge `8b7fabf`.
**Directive being served:** the narrow mechanical re-review of PR #208 returned **BLOCKED NARROWLY** — PR #208 correctly fixes all four reviewed defects and its architecture is sound, but **one P1 upgrade-path defect remains**: a materials op persisted by PR #207 (which carries only `idempotencyKey`, no `coalesceKey`) can execute twice after PR #208's hydration. This is ONE minimal compatibility correction from `main` @ `8b7fabf`. It does **not** roll back PR #208, change domain code, add a migration, or begin Phase 4.

## Vision-alignment statement

The pilot's promise (§25) is *one site running without a separate material spreadsheet, on facts the later phases inherit* — and that trust extends across a deploy: a materials command a user queued before the upgrade must survive the reload exactly once, never twice. PR #208 keyed coalescing and disable-while-pending on a new `coalesceKey`, but a command persisted by PR #207 predates that field. On the first post-upgrade reload the hydration read `coalesceKeyOf(oldOp)` as `undefined`, so `materialsPending` became `[undefined]`, the equivalent button was not disabled, and a fresh click queued a second ledger command — a double reserve when stock allowed. This correction makes hydration backward-compatible: it derives the missing `coalesceKey` from the legacy `idempotencyKey` (which used the identical business-coordinate format), preserves the `idempotencyKey` byte-for-byte so replay stays exactly-once, drops malformed rows so a `undefined` can never enter `materialsPending`, and persists the migrated queue back. One fact keeps one owner across the upgrade boundary.

## The defect

- **P1 — persisted PR #207 operations can execute twice.** During `hydrateOutbox`, a legacy materials op has no `coalesceKey`; `coalesceKeyOf(oldOp)` returned `undefined`; `materialsPending` became `[undefined]`; the equivalent button was not disabled; a new click queued a SECOND operation with a fresh ledger key; with sufficient stock, both executed and reserved twice.
- Independent reproduction (verbatim): persist a PR #207 `reserveStock` op without `coalesceKey` → `hydrateOutbox()` → observed `materialsPending: [undefined]` → click the equivalent reserve → observed outbox length 2 instead of 1.

## The fix (compatibility only — no domain change, no migration)

- **`normalizeMaterialsOutbox` (pure, in `apps/web/src/lib/materialsKeys.ts`).** Normalizes the parsed outbox before it enters state:
  - a materials op with a `coalesceKey` already (PR #208 shape) passes through unchanged;
  - a materials op with only `idempotencyKey` (PR #207 shape) gets `coalesceKey` **derived from that idempotency key** — the old `reserveKey`/`issueKey`/`consumeKey`/`requisitionKey` were renamed to `*CoalesceKey` with identical bodies, so the legacy `idempotencyKey` string IS the correct coalesce key — while the `idempotencyKey` is **preserved byte-for-byte** (replay stays exactly-once);
  - a malformed row (not an object, or a materials op with neither key) is **dropped**;
  - non-materials ops pass through untouched; it returns `changed` so the caller can persist the migrated queue.
- **`hydrateOutbox` (in `apps/web/src/store/store.ts`).** Runs `normalizeMaterialsOutbox` on the parsed queue, **persists the migrated queue back to the same scoped localStorage key** when it changed, and rebuilds `materialsPending` so that **only a materials op carrying a string coalesce key contributes** — a `undefined` can never enter `materialsPending` (defense-in-depth over the derivation).
- `isMaterialsOp` now delegates to the shared `isMaterialsOpType`, so the materials-op discriminant list has a single source.

## Reproduce-first probes → evidence (RED at pre-fix hydration → GREEN)

Table-driven over all four materials op types (`reserveStock`, `issueStock`, `consumeStock`, `createRequisition`), in `apps/web/tests/materials.test.ts`:

| Proof | Evidence |
|---|---|
| Hydration reconstructs the correct coalesce key (no `undefined` in `materialsPending`) | `correction 4: legacy <t> — …` (a): derived `coalesceKey`, `idempotencyKey` preserved, `materialsPending === [coalesceKey]`, migrated queue persisted back. |
| An equivalent click while the legacy op is pending produces no second op | `correction 4: legacy <t> — …` (b): outbox stays length 1 after the equivalent action. |
| Replay retains the original idempotency key | `correction 4: legacy <t> — …` (c): the replayed call's key equals the legacy idempotency key. |
| After confirmation removes the old op, a later legitimate action gets a fresh idempotency key | `correction 4: after a legacy op is CONFIRMED …`: replay uses the legacy key; the next reserve uses a DIFFERENT key. |
| Malformed stored ops do not introduce `undefined` pending entries | `correction 4: malformed stored materials ops are dropped …`: junk + a keyless materials op are dropped; `materialsPending` has no `undefined`. |
| Pure derivation + filtering (table-driven, no store) | `correction 4: normalizeMaterialsOutbox derives keys, preserves idempotency, and filters malformed rows`. |

**RED proof:** with the store's hydration reverted to the pre-fix `coalesceKeyOf(o)!` one-liner, the six store-level `correction 4` probes FAIL (the pure-normalizer probe still passes, as the helper exists); with the fix restored, all seven pass.

## Gate battery (base `8b7fabf`)

- `pnpm check` — **EXIT 0** (web **432/432** across 39 files + build; API **631/631**; shared build). Web unit is +7 over correction 3's 425 (the new legacy-migration probes).
- Focused web tests — `materials.test.ts` + `reservations.test.ts` **36/36**.
- `test:e2e:api:allmodules` — **31/31**; `test:e2e:api:outbox` — **25/25**. materials-pilot **4/4 in both sender modes**.
- No migration (client hydration + a pure helper over already-persisted facts), so `upgrade-proof.sh` is not applicable to this change; the additive read/lifecycle path writes no rows.

## What this correction does NOT touch

- No rollback of PR #208 (its four fixes stand; this makes their hydration upgrade-safe).
- No domain code, no schema, no migration.
- Phase 4 does not begin. This is the narrow mechanical re-review stop; after it passes, Phase 3 can receive the GREEN SIGNAL.
