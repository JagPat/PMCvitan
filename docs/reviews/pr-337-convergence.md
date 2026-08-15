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
| `f1700af` | round-7 correction; Codex's review again LANDED after the two-timeout verdict (7.5 min late — the established pattern) with **4 P2 findings**, treated as the review of record | the demo store's local withdraw left the local pending notice; the migration left pre-withdrawn rows' projections servable-stale and their notices unretired; and a claimed revision re-point that the Phase-3 append-only register seal ALREADY makes unrepresentable — REFUTED WITH EVIDENCE (probe + upgrade-proof rejection + thread reply) |
| `b99f792` | round-8 correction; the late-landing review of record again (7 min): **4 P2 findings**, all verified REAL against existing seals before fixing | the QUESTION identity (`title`/`room`/`nodeId`) outside the frozen set; attribution standing (the FK proves the row, not ACTIVE); the picker rule client-only (`assertRefs` accepted withdrawn references); the entry/reverse seals blind to the legacy approval EVENTS the round-6 diagnostic itself established as evidence |
| `f841907` | round-9 correction; the FIRST verdict the orchestrator classified IN-WINDOW (attempt 2/2): **5 P2 findings**, each verified against the seal network first — four REAL, one refuted by execution | the round-9 linkability guard ran OUTSIDE the command transaction (a TOCTOU window vs a concurrent withdraw); a claimed uuid-into-text type error in the runtime tombstone that PostgreSQL's I/O-conversion assignment cast makes a non-event — REFUTED WITH EVIDENCE; the shared web selector missing the AUTH-02 pending split; the ACTIVE-membership entry read unlocked (a removal could commit mid-withdrawal); the event reverse arm INSERT-only over a table with no append-only seal |
| `3a972ae` | round-10 correction (with `origin/main` merged in — PR #339's orchestrator windows); the SECOND consecutive in-window verdict (attempt 1/2, 14 min): **3 P2 findings**, all REAL | the frozen question excluded its CHOICES (`DecisionOption` unsealed); the update path revalidated the CURRENT link, breaking edits on the allowed link-then-withdraw state; the BAKED viewer-specific readiness text survived a persona switch in the client store |
| `c2d3a1a` | round-11 correction; the third consecutive in-window verdict (attempt 1/2, 14 min): **6 P2 findings**, all REAL — the widest round since round 1 | the round-8 projection retirement WEDGED the consumer (no replacement checkpoint); a one-transaction option-edit-then-withdraw bypassed the round-11 seal; the round-11 "unchanged link" decision used a stale pre-tx read; the primary `id` outside the identity freeze (children are ON UPDATE CASCADE); approval EVENTS erasable/downgradable before withdrawing; active membership accepted as authority |
| `04bcbc3` | the round-12 correction + this audit extended; its CI api battery caught what the pre-push literal grep could not | 1 CI defect: three suites (phase3-requirements, phase4-t1-labour, projection-rebuild-upgrade) wipe decision events through a DYNAMIC table-driven `deleteMany` loop, so their resets hit the new approval-evidence seal — fixed as `4b7b9e2` |
| `4b7b9e2` | the test-only CI follow-up (the three dynamic-wipe suites join the sanctioned `wipeDecisionEvents` reset; full battery 1171/1171). It carried the convergence TRAILER but not the PACKET — past the convergence threshold every head owes both, and the gate correctly required this audit's currency | 1 gate requirement (not a Codex finding): missing packet on the head commit |
| `a58e949` | packet-only (this audit brought current through `4b7b9e2`); the fourth consecutive in-window verdict: **5 findings (1×P1, 4×P2)** — the P1 REFUTED by execution | a claimed plpgsql error on every option INSERT (OLD/NEW are NULL records since PG 11 — refuted on PostgreSQL 16.13 with the docs citation + probe); the pg_temp touch note erasable by its own session with NO privilege; an approval event re-pointable AWAY while keeping its type; the replacement generation unable to seed a row the retired generation never had; the daily-log material write accepting a withdrawn decision link |
| `ecd46af` | the round-13 correction + this audit extended; the fifth consecutive in-window verdict: **3 P2 findings** — one REFUTED by execution with a REAL adjacent gap surfaced | the rerunnable migration's identity-keyed notice retirement erasing the withdraw command's OWN stamped notice on re-runs; the suite's sequential seal toggles skipping their ENABLEs on a failed wipe; a claimed `ambiguous-raw-waiver` failure that cannot occur (distinct enclosing symbols; the check is green on the exact head) — but whose probe exposed `UPDATE_RE` blind to ALIASED set-based updates, an invisible-unwaived raw write |
| `5f9d894` | the round-14 correction + this audit extended; the sixth consecutive in-window verdict: **4 P2 findings**, all REAL | the withdrawing statement able to forge `publishedAt` (the entry freeze covered identity but not the publication fact); the repair dtos rendering `withdrawnAt` in the SESSION timezone under a non-UTC psql; TRUNCATE erasing approval events wholesale where the row-wise DELETE is refused; TRUNCATE erasing the touch notes inside the withdrawing transaction |
| (this head) | the round-15 correction + this audit extended. THE UNIT STAYS WHOLE past the advisory limit: plan §F pre-authorizes the single unit; rounds 4–15 have touched no command-semantics or §A.4 runtime-arm surface — round 15 completes the entry freeze over the publication fact, makes the projection repair session-independent, and extends the evidence seals from the row verb to the STATEMENT verb (TRUNCATE), with the register's truncate surface named as the one deliberate residual of the shared-reset contract | — |

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
  already stated elsewhere (the round-4 terminal freeze; the round-6 diagnostic).
- Round 8 reached the demo store and the migration's LAST stand-in duties, and — for the first
  time — a seal that already existed. The no-API demo path is a WRITER too and mirrors the
  command's notice retirement, multiplicity guard included (R8-F1). When the migration accepts
  a pre-withdrawn row it must retire EVERYTHING the command would have: the queued pushes
  (rounds 4–5), the bell notices (R8-F3), and the servable projection generation that still
  claims the row is pending — retired so reads fall back to canonical truth, never edited
  (R8-F2). And the claimed revision re-point (R8-F4) is REFUTED WITH EVIDENCE: the Phase-3
  append-only register seal refuses every UPDATE before the reverse arm is consulted — proven
  by a probe executing the exact attack, an upgrade-proof rejection, and answered on the
  thread. An enumeration that has begun meeting pre-existing seals is measuring its own
  completeness.
- Round 9 completed four arms of rules earlier rounds stated: the frozen record includes the
  QUESTION itself (R9-F1 — the identity twin of rounds 4/7's projectId freezes); standing, not
  existence, is what attribution means (R9-F2 — the DB twin of the round-1 locked participant
  check, with the ghost-actor forgery now answered by the seal before the FK); linkability, not
  existence, is what a NEW reference asks (R9-F3 — the server twin of round 6's picker rule,
  via the owned `decisions.linkableInProject` contract); and the legacy approval EVENTS the
  round-6 diagnostic established as evidence are counted by the entry, belt, and reverse seals
  exactly like the register (R9-F4).
- Round 10 moved the round-9 arms to their correct SCOPE — the last coat of the same root.
  A validity check is only as strong as the transaction it runs in: the linkability guard
  becomes an in-tx authority under a decision row share lock (R10-F1, the transactional twin
  of R9-F3), and the ACTIVE-standing read locks the membership row it judges (R10-F4, the
  concurrency twin of R9-F2 — proven by a held-open withdrawal that BLOCKS the concurrent
  removal). A reverse seal must cover every verb its table admits: `DecisionEvent` has no
  append-only trigger, so INSERT-only coverage left UPDATE open (R10-F5 — the register
  equivalent was round 8's REFUTED attack precisely because the register IS append-only). The
  shared selector mirrors the WHOLE server rule, not the arm this PR added (R10-F3 — the
  AUTH-02 pending split joins the round-6 withdrawn split). And a second finding met an
  already-impossible attack: the claimed uuid-into-text tombstone type error is a non-event
  under PostgreSQL's I/O-conversion assignment cast, refuted by execution (R10-F2 — pg_cast
  holds no uuid→text row; the R3-F3 probe runs the exact INSERT every round; a plan-time type
  error would have failed every withdraw probe since round 3). The
  convergence trajectory: 5 (runtime lifecycle) → 4 (mixed) → 3 (access paths/boundary) → 4
  (deployment eras) → 2 (harness completions) → 4 (a diagnostic, a documented boundary, a
  selector class, a harness hardening) → 2 (entry-transition twins of sealed arms) → 4 (arm
  completions, one refuted) → 4+1-refuted (scope/lock corrections of the round-9 arms, one
  refuted) → 3 (the question's last component, an over-reach correction, a cached-DTO tail) —
  since round 3, no finding has touched the command's semantics, the seals' INTENT, or a §A.4
  runtime arm; the later rounds each re-state an accepted rule on one more path, and two of
  rounds 8–10 contained findings the existing seal network already answers.
- Round 11 closed three tails of rules already stated. The frozen QUESTION (round 9) includes
  its CHOICES — the option rows define what was asked, so seal 5 freezes them with the same
  destructive-reset bypass contract as the delete arm (R11-F1). A guard moved to its correct
  scope (round 10) must not over-reach: link-then-withdraw is the ALLOWED state, so only a
  NEWLY introduced link is validated — the modal's re-sent current link passes (R11-F2). And
  the audience mirror (rounds 6/10) covers the BAKED text too: the readiness reason a PMC
  snapshot baked is re-redacted at read time for viewers the server would redact it from,
  via one shared pair of constants (R11-F3).
- Round 12 is the durability round: a REPAIR must heal, and EVIDENCE must be as permanent as
  the record it justifies. The round-8 retirement was honest about serving (fall back to
  canonical) but left the consumer with no checkpoint to continue from — the replacement
  generation carries the rows and checkpoint forward, correcting only the withdrawn rows,
  pinned by slice equality and a post-repair delivery that APPLIES (R12-F1). The option seal
  judged writes at write time, so the withdrawing TRANSACTION could rewrite the question first
  — every option write now leaves a per-transaction touch note and the entry seal refuses a
  withdrawal whose transaction touched the options (UPDATE, INSERT and DELETE alike); a
  publication-wide freeze was prototyped and REJECTED for breaking twelve suites' sanctioned
  resets, and the earlier-transaction edit is named for what it is — tampering with a live
  pending question, outside the withdrawal seal's scope (R12-F2). The round-11 unchanged-link decision moves under the lock it
  depends on (R12-F3 — the same stale-read root as R10-F1, one read further out). The primary
  `id` joins the frozen identity (R12-F4 — CASCADE re-keying). Approval events join the
  register in undeletability (R12-F5 — erasure is the reverse of the re-point round 10
  sealed). And standing becomes AUTHORITY: active pmc, not active anything (R12-F6 — the DB
  twin of the command's own policy).
- Round 13 measures round 12's own fixes against the network's standards — and one of them
  fell short of the privilege standard: the touch note lived in pg_temp, erasable by its
  writing session with NO privilege at all, while every other bypass in this network costs
  `DISABLE TRIGGER` ownership. The note moves to a REAL owned table whose guard refuses
  same-transaction erasure, restoring the uniform rule: blinding any seal costs the same
  ownership privilege (R13-F2). Two completions of the same shape: the round-12 event freeze
  covered type but not the event's DECISION (re-point-away laundering, R13-F3), and the
  round-12 replacement could only correct rows the retired generation HAD — the never-applied
  shape is now seeded from canonical truth through the operator diagnostic's own comparators
  (R13-F4). The daily-log material link was the last write path still validating existence
  instead of linkability — it adopts the activities authority with an audience-shaped refusal
  (R13-F5). And the round's one P1 dissolved under execution: plpgsql OLD/NEW have been NULL
  records since PostgreSQL 11, so the claimed insert-time error cannot occur — refuted with
  the docs citation, a live PG 16.13 run, and a pinning probe rather than patched around
  (R13-F1, the third refutation of the review cycle).
- Round 14 is conservatism at the edges. The rerunnable migration's retire arm was too eager —
  identity alone also matched the withdrawal notice the COMMAND writes, so an operator re-run
  ate the record's own notice; the arm now names the pending SHAPE it exists to retire
  (R14-F1). The suite's own destructive resets were the last sequential disable→wipe→enable
  paths — six sites join the R6-F4 atomic-transaction discipline the seed already pins, and a
  source pin makes the sequential shape unrepresentable (R14-F2). And the round's third
  finding predicted a failure that cannot occur — the two cancellation statements resolve to
  DIFFERENT enclosing symbols, so the one-waiver-one-site rule was never violated, proven by
  the green check on the exact head and a direct analyzer run — but refuting it exposed a REAL
  blind spot: `UPDATE_RE` could not see an ALIASED set-based update at all, so the
  subject-stamp statement was unwaived AND unflagged. The refutation and the fix ship
  together: the regex admits the alias, the statement gets its named waiver, and two
  adversarial fixtures pin the shape (R14-F3 — the fourth refutation, and the first whose
  probe found an adjacent defect the finding itself missed).
- Round 15 extends accepted rules along two axes. The entry freeze (rounds 7/9/12) gains its
  last column: the PUBLICATION FACT, forgeable in the withdrawing statement itself while the
  terminal arm froze it one transition too late (R15-F1). The projection repair becomes
  session-independent — `AT TIME ZONE 'UTC'` on a without-time-zone column re-rendered the
  stored UTC digits in the operator's psql session timezone, correct only under UTC (R15-F2).
  And the evidence seals move up a VERB: row triggers cannot see TRUNCATE, which is grantable
  separately from ownership and therefore WEAKER than the DISABLE TRIGGER boundary the
  sanctioned bypasses standardize on — two precise statement-level guards close it (approval
  events while any exist; touch notes only against the transaction that wrote them), the one
  affected sanctioned reset gains the named bypass, and the register's truncate surface is
  NAMED as the deliberate residual: forty-six shared-database resets truncate it by contract,
  and widening that contract belongs to its own review, not a correction round (R15-F3/F4).

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

Every finding from all fifteen rounds is fixed in-branch or refuted with executable evidence with reproduce-first evidence (probes,
the ratchet, or upgrade-proof stages); no finding was disputed. ONE named deferral, created by
round 3 and guarded rather than open: the three PRE-EXISTING raw `Membership` reads
(`activities.complete`, `requirements.responsible`, `inspections.assign`) predate the
participant and are exactly the precedent the withdraw check copied. They are OUT of this PR's
diff, pinned by the ratchet (the allowed list can only shrink; any new site fails the test
immediately), and routing them through `OrgsParticipant` is tracked maintenance work — moved
there rather than folded in because rewriting three independently-cleared modules' attribution
reads belongs to its own reviewed unit, not to a correction head.
