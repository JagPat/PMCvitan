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
| `e759832` / `31f3fba` | round-3 correction (same tree; re-pushed to place the trailer in the commit's final trailer block); Codex attempt on `31f3fba`: **4 P2 findings** | subjectless rows written by an OLD instance during a rolling deploy; `projectId` outside the write-once set; a scanner row committing BETWEEN the cancellation passes and the tombstone insert; queued pushes of an ALREADY-withdrawn decision that no future command will ever cancel |
| `b24d36e` | round-4 correction; Codex attempt on it: **2 P2 findings** — both deployment-harness completions of the round-3/4 arms, no runtime surface | the migration's cancellation lacked its recovery-gap tombstone arm (it only UPDATEd rows that exist); the seed's guarded decision wipe sat AFTER `membership.deleteMany()`, which the new `withdrawnById` FK refuses while a withdrawn decision exists |
| `2e15eba` | round-5 correction — the review-lifecycle limit (5 finding heads) reached; Codex attempt 2 timed out at the orchestrator but its review LANDED 43s later: **4 P2 findings**, treated as the review of record | the diagnostics accepted a pre-withdrawn row whose approval evidence is the LEGACY class (empty register, approved events/columns); the mixed-version leased-sender window; the Site Map (and same-class screens) filtering `s.decisions` outside the shared audience rule; the seed's trigger bypass not failure-safe |
| `fbe760d` | round-6 correction (the STAYS-WHOLE rationale recorded); Codex attempt on it: **2 P2 findings** — entry-transition twins of already-sealed arms | the projectId freeze fired only on already-withdrawn rows (one statement could withdraw AND move); approval columns could be ADDED in the statement that enters withdrawal (the terminal freeze covers only the withdrawal columns) |
| (this head) | the round-7 correction + this audit extended. THE UNIT STAYS WHOLE past the advisory limit: plan §F pre-authorizes the single unit (the enum and its readers are indivisible), rounds 4–7 have touched no command or runtime-arm surface — round 7 is two trigger-arm additions — and a split now would separate the readers from the status they read, the exact cut §F forbids | — |

## Root analysis — why the rounds happened, and what closes the class

Every substantive finding across all rounds is one root wearing many coats: **a terminal
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
- Round 4 found it one DEPLOYMENT ERA further out in each direction. Writers are not only the
  current code: an OLD instance in a rolling deploy materializes deliveries with the new
  column NULL (R4-F1), and PRE-MIGRATION history holds withdrawn decisions whose cancellation
  only the migration itself can ever perform, because the command that performs it has already
  happened (R4-F4). Time is not only before-vs-after this transaction: the scanner can commit
  INSIDE the cancellation's own statement sequence (R4-F3). And the row's identity is not only
  its evidence columns: the PROJECT it belongs to is what makes the register entry findable at
  all (R4-F2).
- Round 5 closed the two harness tails of exactly those arms — no runtime surface. When the
  MIGRATION stands in for the command (round-4 R4-F4), it must carry EVERY arm the command
  carries, including the round-3 recovery-gap tombstone it initially lacked (R5-F1). And a
  new FK re-orders the world for every writer that deletes its target: the destructive seed's
  membership wipe now sits BELOW the decision wipe in the dependency order, because
  `withdrawnById` made memberships load-bearing for withdrawn history (R5-F2).
- Round 6 closed four residues of the same coats. The diagnostics must judge withdrawn rows by
  EVERY approval signal the codebase has ever written, not just the register the current code
  writes (R6-F1 — the PR-#192 legacy class the entry guard already knew about, applied to the
  partial-apply state). The leased arm's guarantee names its own precondition — a sender running
  THIS code — and the deployment model is what excludes the pre-4a sender, now stated in §A.4
  and RUNBOOK §P6-4a rather than implied (R6-F2). The §A.3 reader closure includes every screen
  that renders a decision ROW, not only the log: one shared `selectVisibleDecisions` now carries
  the audience rule the four ad-hoc filters bypassed (R6-F3). And a sanctioned seal bypass must
  be UNABLE to strand the seal off — the seed's trio is one transaction whose failure rolls the
  disable back (R6-F4).
- Round 7 named the last transition: a freeze that guards the WITHDRAWN state must also guard
  the single statement that CREATES it. The projectId freeze moves into the entry arm (R7-F1),
  and the no-approval-evidence rule moves into coherence, where it judges every withdrawn write
  — entry and later alike (R7-F2). Both are trigger-arm additions mirroring rules the seals
  already stated elsewhere (the round-4 terminal freeze; the round-6 diagnostic). The
  convergence trajectory: 5 (runtime lifecycle) → 4 (mixed) → 3 (access paths/boundary) → 4
  (deployment eras) → 2 (harness completions) → 4 (a diagnostic, a documented boundary, a
  selector class, a harness hardening) → 2 (entry-transition twins of sealed arms) — since
  round 3, no finding has touched the command, the seals' INTENT, or a §A.4 runtime arm; the
  later rounds each re-state an accepted rule on one more path.

**The closing move is enumeration, not another spot fix.** The round-2 correction pins the full
matrix explicitly, and round 3 extends it along the two axes its findings named:

1. **Delivery lifecycle × creation path × deployment era**: subject present on emit-time
   (`materializeDeliveries`), recovery (`expandMissingDeliveries`), and backfill
   (pending/leased/dead) rows — and STAMPED at cancellation time onto any row an old-code
   writer materialized subjectless during a rolling deploy, copied from the row's own event
   (round 4). The cancellation mark reaches pending (neutralized), leased (pre-send check),
   dead (redrive-proof), the row that does not exist yet (round 3: the recovery-gap tombstone,
   complete by ordering since publication precedes withdrawal), AND the row that commits
   INSIDE the cancellation's own window (round 4: the passes run again after the tombstone
   insert, so every scanner interleaving ends cancelled-or-never-created — proven by the
   deterministic barrier probe). Pushes of a decision ALREADY withdrawn before the migration
   runs are cancelled BY the migration with the command's exact semantics (round 4) — ALL of
   its arms, including the recovery-gap tombstone for the event with no delivery row at all
   (round 5), with the live-decision precision assert proving recovery still owes THOSE their
   pending deliveries — since no future command will ever run for them. `succeeded` rows are
   already-sent history the design accepts.
2. **Decision-row facts the withdrawn state depends on**: `status` (terminal), the four
   evidence columns (write-once, coherent both directions), `publishedAt` (required +
   frozen), and — round 4 — `projectId` (frozen: the register entry cannot be MOVED to
   another project where the withdrawer happens to hold a membership, which would satisfy the
   FK while the record vanishes from its own register) — each sealed by trigger AND
   back-checked by an unconditional migration diagnostic for every partial-apply shape
   (value-without-columns; columns-with-orphan-evidence; withdrawn-without-publication).
   Round 3 completes the seal over the ACCESS PATHS: the DELETE arm
   (`Decision_t4a_d_no_delete`) makes the register entry unerasable, with the two destructive
   resets using the same sanctioned named-trigger bypass as their DomainEvent TRUNCATE.
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

Every finding from all seven rounds is fixed in-branch with reproduce-first evidence (probes,
the ratchet, or upgrade-proof stages); no finding was disputed. ONE named deferral, created by
round 3 and guarded rather than open: the three PRE-EXISTING raw `Membership` reads
(`activities.complete`, `requirements.responsible`, `inspections.assign`) predate the
participant and are exactly the precedent the withdraw check copied. They are OUT of this PR's
diff, pinned by the ratchet (the allowed list can only shrink; any new site fails the test
immediately), and routing them through `OrgsParticipant` is tracked maintenance work — moved
there rather than folded in because rewriting three independently-cleared modules' attribution
reads belongs to its own reviewed unit, not to a correction head.
