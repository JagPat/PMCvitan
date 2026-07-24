# Phase 4 Task 2 — correction review packet (labour commercial integrity)

**Directive:** fix-forward the five independent-review findings on the labour commercial chain, each
reproduced RED first. Do not roll back PR #220, do not rewrite migration `20270201000000`, do not begin
Task 3.

- **Reviewed head (PR #220):** `846c6ff1ac0ff5e083b62fd1a4d8ce7960558110`
- **Merged / base `main`:** `aae0711a07107828f254f22bd994ee1321e07b89`
- **Correction branch:** `claude/phase4-task2-correction` (from `main` `aae0711`)
- **Correction migration:** `20270205000000_phase4_t2_correction` (additive, diagnostic-first; the 63rd migration)

## The five findings

| # | Finding | Root cause (RED at `aae0711`) | Fix |
|---|---|---|---|
| **F1** | requisition 10 → PO 10 → issue → commit → close-short → second PO 10 created DUPLICATE live capacity | `commitCapacity` never set the PO line's `committedQty` nor recomputed version status; after close-short `liveAllocation` read `committedQty=0`, freed the requisition line, and a second PO re-ordered the already-committed slice | a SINGLE transactional lifecycle — commit sets `committedQty` + recomputes version status; default releases it + recomputes; close-short keeps the committed portion; **amend/cancel refuse while a live commitment exists** (never orphaned) |
| **F2** | a raw mutation of a `LabourRequisitionLine`'s shift/fingerprint was accepted | no immutability trigger; the spec FK omitted `labourSpecFingerprint`/`shift`; `civilDate` wasn't bound to a demand slice; a PO line's copied slice identity wasn't bound to its requisition line | a `LabourRequisitionLine_frozen` trigger (only status/cancel may change) + composite FKs binding the requisition line's `(requirementId,revision,labourSpecFingerprint,shift)` → `LabourRequirementSpec` and `(requirementId,revision,civilDate)` → `LabourDemandSlice`, and the **PO line's copied `(civilDate,shift,labourSpecFingerprint)` → its requisition line** (qty excluded — a partial/split order may order fewer person-shifts) |
| **F3** | a raw `CapacityCommitment` with a slice identity ≠ its PO line was accepted | `CapacityCommitment_poLine_fkey` bound only `(projectId,poLineId)` | a composite FK binding `(projectId,poLineId,labourSpecFingerprint,civilDate,shift,personShiftQty)` → the PO line's full slice identity |
| **F4** | a raw `LabourPurchaseOrderLine` whose rate/premium came from no quote was accepted | the line copied rate/premium but referenced no quote line | new frozen `comparisonId`/`selectedQuoteId`/`selectedQuoteLineId` columns + a 4-FK provenance chain proving `poLine.comparisonId == version.comparisonId == PO.comparisonId` (approved), `selectedQuoteId == comparison.selectedQuoteId`, and the named quote line quotes this requisition line with rate/premium EQUAL the frozen terms |
| **F5** | `committedQty > personShiftQty` was accepted | only `committedQty >= 0` | `CHECK committedQty <= personShiftQty` |

## The F1 transition truth table (service, under FOR UPDATE + the readiness lock)

`committedQty(line)` = the line's LIVE (`committed|revised`) `CapacityCommitment` person-shifts, else 0.
`recompute(version)` is applied only to `issued|partially_committed|completed` versions (terminal
versions — `amended|cancelled|closed_short` — are never re-opened):

| current | event | condition | new |
|---|---|---|---|
| issued/partially_committed | commit line | Σcommitted < Σordered | partially_committed |
| issued/partially_committed | commit line | Σcommitted = Σordered | completed |
| completed | commit line | (refused — no line left to commit) | — |
| committed/revised | default | (releases committedQty→0, recompute) | issued or partially_committed |
| issued/partially_committed | closeShort | (committed lines KEEP committedQty; rest released) | closed_short |
| completed | closeShort | (refused — nothing is short) | — |
| issued | amend / cancel | a live commitment exists | REFUSED (never orphaned) |

§F bound-2 allocation counts a line's full `personShiftQty` on `issued|partially_committed|completed`,
and only `committedQty` on `closed_short` — so a committed slice is never re-ordered by a second PO.

## Reproduce-first evidence (live PostgreSQL)

`test/integration/phase4-t2-correction.test.ts` — RED at `aae0711`, GREEN after:

- **F1** invariant (intended inbound ≤ slice demand across commit + close-short + second issued PO) — RED (20 > 10) → GREEN (10).
- **F2/F3/F4/F5** hostile raw mutations rejected — RED (all accepted) → GREEN (all rejected).
- **F1 multi-line**: one commit → `partially_committed`; close-short keeps the committed line, releases the rest.
- **F1 race** commit vs close-short (10×) and commit vs amend (10×): exactly one wins; never doubles or orphans capacity.

Result: **8/8** (RED 5/8 at `aae0711` — F1..F5; the F1 probe additionally required the second PO to be
issued to make the duplicate live).

## Database-enforcement evidence

- `scripts/upgrade-proof.sh` — **PASSED**: the coherent labour chain (now carrying the F4 provenance
  columns) is accepted; F2 (frozen shift + forged fingerprint), F3 (mismatched commitment identity),
  F4 (rate not from the selected quote line) and F5 (committedQty > personShiftQty) forgeries are all
  rejected over the migrated legacy DB; every prior Phase-1..Phase-4-T2 forgery rejection survives.
- `scripts/phase4-t2-correction-abort-proof.sh` — **PASSED**: the correction ABORTS naming F5 over a
  planted violation, leaves no half-applied schema, and after the documented §P4T2C repair
  (`committedQty := personShiftQty`) REDEPLOYS cleanly — the F2/F3/F4/F5 seals install and the F4
  provenance backfills from the coherent chain. (Operator repair for every abort state: `docs/RUNBOOK.md §P4T2C`.)

## Gate battery

- `pnpm check` — EXIT 0 (web 432/432, API 642/642).
- Full PostgreSQL integration — **63 files / 550 tests** on a pristine migrated DB (+8 for `phase4-t2-correction.test.ts`).
- `upgrade-proof.sh` — PASSED (see above; the coherent chain + F2/F3/F4/F5 + reqline-slice forgery rejections, 7 correction constraints installed).
- `phase4-t2-correction-abort-proof.sh` — PASSED (see above).
- `test:e2e:api:allmodules` — 31/31; `:outbox` — 31/31 (materials-pilot 4/4).

## Scope

Additive migration only (`20270205000000`); `20270201000000`, the Prisma schema's existing relations,
the demand seal and every other PR #220 decision are unchanged apart from the three new PO-line/version
provenance columns and the F1 lifecycle wiring. Task 3 (§F bound-3 + allocation/attendance/work facts)
remains blocked.
