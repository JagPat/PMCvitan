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
| `74af426` | round-2 correction + this audit; Codex attempt on it: **3 P2 findings** | DELETE outside the terminal seal; the round-1 attribution fix's raw `Membership` read (an undeclared decisions→orgs edge); the recovery scanner resurrecting a push whose delivery row did not exist at cancellation time |
| (this head) | the round-3 correction + this audit extended | — |

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
  membership row (round-1 F4) — and the round-1 FIX itself reached into the orgs-owned
  `Membership` table with raw SQL, an undeclared synchronous edge (round-3): closing a
  behavioural gap must not open a structural one.
- The audience: designed for the decision row and notice, missed the DERIVED readiness reason
  (round-1 F5).
- Round 3 found the same root one access path further out in each direction: the register
  entry's protection covered UPDATE but not DELETE (R3-F1); the cancellation covered every
  delivery row that EXISTS but not the one the recovery scanner would create later (R3-F3).
  A terminal fact's seal is complete only over every access path — update, delete, and the
  row-creation path itself.

**The closing move is enumeration, not another spot fix.** The round-2 correction pins the full
matrix explicitly, and round 3 extends it along the two axes its findings named:

1. **Delivery lifecycle × creation path**: subject present on emit-time (`materializeDeliveries`),
   recovery (`expandMissingDeliveries`), and backfill (pending/leased/dead) rows; the
   cancellation mark reaches pending (neutralized), leased (pre-send check), dead
   (redrive-proof), AND the row that does not exist yet (round 3: the cancellation
   materializes the recovery-gap delivery itself, already cancelled — complete by ordering,
   since publication precedes withdrawal; single-winner against a concurrent scanner via the
   `(eventId, consumer)` unique); `succeeded` rows are already-sent history the design accepts.
2. **Decision-row facts the withdrawn state depends on**: `status` (terminal), the four
   evidence columns (write-once, coherent both directions), and `publishedAt` (required +
   frozen) — each sealed by trigger AND back-checked by an unconditional migration diagnostic
   for every partial-apply shape (value-without-columns; columns-with-orphan-evidence;
   withdrawn-without-publication). Round 3 completes the seal over the ACCESS PATHS: the
   DELETE arm (`Decision_t4a_d_no_delete`) makes the register entry unerasable, with the two
   destructive resets using the same sanctioned named-trigger bypass as their DomainEvent
   TRUNCATE.
3. **Actor paths**: member (attributed via the FK), org-admin-without-membership (refused with
   an answer under the row lock), ghost (FK-refused) — and the QUESTION itself now asked of
   its owner (round 3): `OrgsParticipant.lockActiveMembership` under the declared
   decisions → orgs participant edge, with a cross-module-graph RATCHET pinning raw
   `Membership` SQL to the orgs module plus the three pre-existing legacy sites, so the class
   cannot silently regrow.
4. **Viewer audiences**: pmc (full row + notice + honest reason), every other role (no row, no
   notice, redacted fail-closed reason) — at the serializer, the snapshot notice filter, the
   readiness bake, the start refusal, and the web demo derivation.

The remaining known boundary is stated, not hidden: the check→send in-flight residual
(plan §A.4) — unrecallable by design, identical to the already-sent case.

## Deferral ledger

Every finding from all three rounds is fixed in-branch with reproduce-first evidence (probes,
the ratchet, or upgrade-proof stages); no finding was disputed. ONE named deferral, created by
round 3 and guarded rather than open: the three PRE-EXISTING raw `Membership` reads
(`activities.complete`, `requirements.responsible`, `inspections.assign`) predate the
participant and are exactly the precedent the withdraw check copied. They are OUT of this PR's
diff, pinned by the ratchet (the allowed list can only shrink; any new site fails the test
immediately), and routing them through `OrgsParticipant` is tracked maintenance work — moved
there rather than folded in because rewriting three independently-cleared modules' attribution
reads belongs to its own reviewed unit, not to a correction head.
