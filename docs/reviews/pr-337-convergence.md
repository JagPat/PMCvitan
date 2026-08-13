# PR #337 convergence audit — phase-6 unit 4a, `decisions.withdraw`

Required by the review-efficiency protocol: two distinct finding-bearing heads on one PR mean
the next correction is not another isolated patch — it carries this architectural audit and the
`Review-Convergence: complete` trailer.

## Head table

| head | verdict | findings |
|---|---|---|
| `afcf611` | (staged-red shape commit — not reviewed; the probes' honest baseline) | — |
| `1517309` | CI failure (web typecheck TS2783; api battery on the stale DecisionDto shape pin) | 2 CI defects, fixed as `e7aac75` + `ea3391d` |
| `ea3391d` | Codex attempt 1: **5 P2 findings** | recovery-scanner subject; migration diagnostics gated on column existence; dead rows outside the cancellation mark; org-admin-without-membership FK rollback; readiness-reason disclosure to non-pmc viewers |
| `1fb4e54` | Codex attempt 2: **4 findings (1×P1, 3×P2)** | orphan withdrawal evidence outside the diagnostics; `publishedAt` neither required nor frozen on withdrawn rows; the `justified-large` marker absent from the packet; dead rows outside the subject BACKFILL |
| (this head) | the round-2 correction + this audit | — |

## Root analysis — why two rounds, and what closes the class

Every substantive finding across both rounds is one root wearing five coats: **a terminal
status is a NETWORK of facts, and each fact lives in more lifecycle states and creation paths
than the happy path exercises.** The unit's design centred on the emit-time, active-row,
project-member, pmc-viewer case; each round found the SAME invariant one state further out:

- The cancellation subject: designed at the emit-time materializer (round 0), missed the
  RECOVERY creation path (round-1 F1), then the BACKFILL's dead rows (round-2 F4).
- The cancellation mark: designed for pending rows, missed leased (round 0 caught in-plan),
  then dead + redrive (round-1 F3).
- The migration diagnostics: designed for the clean and fully-applied states, missed the
  columns-absent partial apply (round-1 F2), then the columns-present-orphan-evidence partial
  apply (round-2 F1).
- The evidence freeze: designed over the four withdrawal columns, missed that the PUBLICATION
  fact is equally load-bearing for the record's visibility (round-2 F2).
- The actor: designed for members, missed the org-admin authorization path that carries no
  membership row (round-1 F4).
- The audience: designed for the decision row and notice, missed the DERIVED readiness reason
  (round-1 F5).

**The closing move is enumeration, not another spot fix.** The round-2 correction pins the full
matrix explicitly:

1. **Delivery lifecycle × creation path**: subject present on emit-time (`materializeDeliveries`),
   recovery (`expandMissingDeliveries`), and backfill (pending/leased/dead) rows; the
   cancellation mark reaches pending (neutralized), leased (pre-send check), and dead
   (redrive-proof) rows; `succeeded` rows are already-sent history the design accepts.
2. **Decision-row facts the withdrawn state depends on**: `status` (terminal), the four
   evidence columns (write-once, coherent both directions), and `publishedAt` (required +
   frozen) — each sealed by trigger AND back-checked by an unconditional migration diagnostic
   for every partial-apply shape (value-without-columns; columns-with-orphan-evidence;
   withdrawn-without-publication).
3. **Actor paths**: member (attributed via the FK), org-admin-without-membership (refused with
   an answer under the row lock — the `activities.complete` precedent), ghost (FK-refused).
4. **Viewer audiences**: pmc (full row + notice + honest reason), every other role (no row, no
   notice, redacted fail-closed reason) — at the serializer, the snapshot notice filter, the
   readiness bake, the start refusal, and the web demo derivation.

The remaining known boundary is stated, not hidden: the check→send in-flight residual
(plan §A.4) — unrecallable by design, identical to the already-sent case.

## Deferral ledger

Nothing deferred. Every finding from both rounds is fixed in-branch with reproduce-first
evidence (probes or upgrade-proof stages); no finding was disputed.
