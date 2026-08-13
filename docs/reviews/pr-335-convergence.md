# PR #335 — convergence audit (the phase-6-task-4 decision-workflow plan)

Owed at the second finding-bearing head. Docs-only diff: the 3-finding-head plan
review cap applies, and this PR touches `docs/STATUS.md`, so a
`Review-Deferred-To-Probes` head would first have to revert the STATUS edit (the
escape the plan's §F pre-declares). **The cap is now REACHED: three
finding-bearing heads.** If the next review finds, the head that answers it MUST
carry the deferral trailer and therefore MUST first revert the STATUS edit, the
flip landing as the immediate tiny follow-up PR.

| head | role | findings | outcome |
|---|---|---|---|
| `45cecf2` | the plan + the flip to `task: 4 / in_progress` | 13 (6 P1, 7 P2) | corrected on `6229248` |
| `6229248` | round-1 batch + a 3-site same-class sweep | 20, in TWO deliveries (10:13Z: 2 P1 + 8 P2; 10:26Z: 10 P2 — the first Codex attempt timed out, the retry was triggered, and BOTH eventually delivered against this same head) | first ten corrected on `eda4127`; all twenty corrected on `2932234` |
| `2932234` | round-2 batch, both deliveries folded | 10 (3 P1, 7 P2) | corrected on `e33c5ac` |
| `e33c5ac` | round-3 batch | the GATE, not Codex: `convergence_required` — the cap's deferral owed | the two-step executed on `4f97dc5` |
| `4f97dc5` | STATUS reverted + the deferral trailer | 5 (2 P1, 3 P2) — delivered 45s AFTER the orchestrator's two-attempt timeout marked the head `blocked`; the review is real and is answered, the timeout artifact resets with the next push | corrected on `ac164c5` |
| `ac164c5` | round-4 batch | 6 (1 P1, 5 P2) — the review lifecycle reports the head LIMIT (5 of 5) and advises a split | the SPLIT, on `f87be65` |
| `f87be65` | the SPLIT: frame + 4a only | 4 (1 P1, 3 P2) — three on the 4a design, one on the deferral mechanics | corrected on `a9ec22d` |
| `a9ec22d` | round-6 batch | 4 (1 P1, 3 P2) — second-order refinements of round-6's own additions | corrected on `7fdbeed` |
| `7fdbeed` | round-7 batch | 4 distinct, all P2 (the status reported 6; two comments were double-delivered) — third-order refinements, severity now declining | corrected on `ec5445d` |
| `ec5445d` | round-8 batch | 1 (P1) — the legacy-data hole in the entry seal | corrected on this head |

`eda4127` (the first-ten correction) was pushed between the two deliveries and
SUPERSEDED before receiving any verdict of its own — the second delivery
critiques text that survives into it, so waiting for its review would only have
re-collected known findings at the cost of the last in-cap head. One
finding-bearing head, two deliveries, one full correction: `6229248` counts
ONCE against the cap.

## Round 1 — the design was checked against itself, not against the code it lands in

Thirteen findings, and the pattern is uniform: each one is a place where the
plan stated a sound invariant and the EXISTING code's concrete mechanics defeat
it as stated.

- The withdrawal notice leaked because the snapshot's stripping recognizes ONE
  text shape (`isPendingDecisionNotice`) — the design said "append the truth",
  the code delivers appended text to everyone.
- "Options min(0)" was legal at the contract while `create` still derives
  `photoSwatch` from `options[0]` — schema green, product path throws.
- "Push only the decider" was impossible on a push spine that persists ROLE
  audiences and links no user.
- The architect DECIDER value was schedulable two units before the architect
  ROLE could authenticate.
- "The switch is architect presence" ignored that `Membership` soft-removes.
- The composite membership FK had no candidate key to land on.
- The `pending`-proves-never-approved proof collided with a countersign flow
  that had no state to live in.
- The forward-vs-approve interleaving, the `recorded` terminal seal, the exact
  `btrim` whitespace set, the orgs participant edge left conditional, and an
  API/web split that the SHARED enum makes impossible — same class throughout.

The correction batched all thirteen, and the self-review then swept the CLASS
the staging findings exemplified (an authority named before its role exists)
rather than only the two named instances — two further sites (§C's requester
set, §B.3's decider aside) carried it and were fixed unprompted, which is the
pr-334 round-4 lesson (gate the class, not the instance) applied at authoring
time.

## Round 2 — the machinery the plan BORROWS has contracts of its own

Ten findings on the corrected head, and the class shifts one level: round 1 was
"the new value versus the existing readers"; round 2 is "the reused machinery
versus its own obligations".

- **`change` is not just a status — it is a status backed by exactly one open
  `ChangeRequest`** (`approve()` rolls back otherwise; the serializer renders
  the reason from that row). Reject-back landing in `change` without creating
  the request would render nothing and make re-approval impossible. Both
  disagreement outcomes now create the open request in-tx, and P33 drives both
  paths end-to-end through re-approval and countersign.
- **Forward-on had no defined completion.** `awaiting_countersign` is the
  architect's action item; re-pointing the holder while keeping that status
  hands the new decider a decision they cannot act on. Both disagreement
  outcomes now share one shape (`change` + open request + the holder rule).
- **The presence switch has WRITERS.** `MembersService.updateRole` mutates the
  role lock-free, so the switch could flip between an approve's read and its
  commit. The switch's writers now take the same readiness lock, with a
  both-directions barrier probe (P36).
- **A terminal status is not frozen evidence.** The seal refused transitions
  out of `withdrawn` while leaving `withdrawnById`/`withdrawReason` rewritable
  under it. Write-once now means the columns (P8).
- **A record's publish still ran the pending machinery** — the "awaiting
  approval" notice and the pending push fired for a decision nobody can
  approve; the none-decider branch now suppresses both (P18).
- **A draft record would have UNBLOCKED an activity gate** (`statusOf` is blind
  to draftness; `recorded → na` would satisfy the gate with evidence the team
  cannot see) — the recorded arm now consults the draft flag (P20).
- **A recommendation by INDEX binds to nothing** — now a same-decision option
  FK (P27). **A membership-keyed push target drops the org-admin requester** —
  now a user-level target (P26). **The forward reason and target** joined the
  non-blank and active-member disciplines their siblings already carry (P30,
  P34).

The second delivery (10:26Z) extended the same two classes and is folded into
this same round's correction:

- **Three more audience readers the decider must carry**: the persisted bell
  notice and its stripping predicate; the `change`/reapproval surfaces (the
  same obligation, reopened); and `countPending`, which takes only `projectId`
  and would hand a same-role non-decider a project-wide portfolio count — the
  count now takes the VIEWER (P22).
- **The route ceiling above the service rule**: `decision.approve` admits only
  client/pmc at the ROUTE, so a contractor decider would 403 before the new
  authority check ever ran — the policy widens to the decider-role union, the
  service narrows (the ceiling-then-narrow shape, P16).
- **Two attribution/emission gaps in forwarding**: the chain must record the
  DISPLACED holder and the ACTING forwarder as distinct facts, and a holder
  move must EMIT (`decision.forwarded`, invalidate + targeted push) or every
  surface stays stale until a reload (P34).
- **Three seals finished**: the never-approved seal made bidirectional (no
  approval revision INSERT against a withdrawn decision, P8); the consultation
  child carrying its OWN `projectId` so both composite FKs can exist (P27);
  consultations refused on `withdrawn`/`approved`/`recorded` so the visibility
  widening cannot leak what §A hides (P25). Plus the retry-safe
  `ADD VALUE IF NOT EXISTS` enum form, spelled.

## Round 3 — the registers the design TRUSTS, and the escape hatches it forgot

Ten findings on the round-2 head, the class one level deeper again: round 1 was
the new value against existing readers, round 2 the borrowed machinery's own
contracts, round 3 is what the design's TRUST ANCHORS and ESCAPE PATHS imply.

- **The approval register is a provenance TARGET** (P1): Phase-3 spec
  provenance FKs any `DecisionApprovalRevision` as "an approval that really
  happened" — a pre-countersign revision could be pinned downstream while the
  gate still waits. The register row gains `finalized` (born true outside a
  chain — byte-identical today; flipped true by the countersign as its one
  sealed transition), and provenance re-points onto the CHECK-pinned
  `(id, finalized=true)` composite — the exact `comparisonStatus` pattern this
  repository already proved (P31).
- **The holder is a trust anchor with no seal** (P1): `deciderKind`/
  `deciderMembershipId` decide approval authority, counts and pushes, yet
  nothing bound their mutation to the forward act — a trigger now refuses any
  holder change without the same-tx `DecisionForward` row (P34).
- **The ordinary escape hatch completed an approval without its countersign**
  (P1): `withdrawChange` restores `change → approved`, so withdrawing an
  architect's rejection request would have skipped the chain. The request now
  carries an immutable `origin`, and `withdrawChange` refuses
  `countersign_rejection` (P33).
- The staging class struck a THIRD time — 4c's eligibility set named 4d's
  `awaiting_countersign` — and is fixed the same way as its siblings: the arm
  ships with the value (the class evidently needs its own authoring rule: **no
  unit's rule may name a later unit's value, checked per unit, not per
  finding**).
- The rest: the stale client pending notice is RETIRED at withdraw (a bell item
  demanding approval of an unopenable decision is a false instruction, not
  history — reversing an earlier head's "keep as history" call, stamp-based
  with a guarded legacy text-shape path, P10); forwards are legal only in open
  holder states (P30); the countersign transition emits its own
  `decision.awaiting_countersign` instead of lying with `decision.approved`
  (P31); consultation responses re-check eligibility at RESPONSE time (P25);
  the response row carries the child keys its same-decision option FK needs
  (P27); and the disagreement request populates `ChangeRequest`'s required
  impact fields honestly (P33).

## The rule this audit adds

Round 1's failure: enumerating the readers of a NEW value while checking the
design only against itself. Round 2's failure, one level up: **reusing an
existing state, filter, spine or table borrows its ENTIRE contract — the rows
it implies, the writers it has, the blindness it carries — and a plan that
names the reuse must name the inherited obligations with it.** `change` implies
an open request; a role switch implies its role-writers; a terminal status
implies frozen evidence; a push spine implies its addressing model. The §A.3
reader-table discipline extends to borrowed machinery: for every reused
mechanism, enumerate what it assumes, who writes it, and what it cannot see.

## The deferral — executed, with its ledger

The gate enforced the cap on the round-3 correction head itself
(`convergence_required`: "after 3 finding-bearing heads a docs-only review must
hand its remaining open questions to named probes instead of answering them
with more prose"), and it refuses the deferral trailer from a diff touching
`docs/STATUS.md`. So the two-step §F pre-declared is now EXECUTED on this head:

1. The `docs/STATUS.md` edit is REVERTED — this PR lands the plan + this audit
   only, and the flip to `task: 4 / in_progress / phase_plan: <the plan>` lands
   as the immediate tiny follow-up PR after merge (the `phase_plan` pin is
   satisfied there: the plan file resolves on `main` at that moment).
2. The head carries `Review-Deferred-To-Probes: phase-6-task-4` — the task
   whose review stops RUN the probes that adjudicate everything this review
   opened.

**Round 4, post-deferral (5 findings on the deferral head itself).** Each is
answered the way the deferral demands — a design decision bound to a named
probe, never a prose-only round: the holder columns are WRITE-ONCE from 4b
(the seal was 4d-scheduled while the trust began in 4b — the freeze comes
first, 4d opens the one forward-act door; P17/P34); a QUEUED
`decision.published` push claimed after a withdrawal is dropped by a send-time
guard, recorded (P10); the `ChangeRequest` evidence set freezes for ALL
origins, not only the new one (P33); consultation eligibility requires
PUBLISHED, not merely open-status — a draft's `pending` would have leaked an
author-private title (P25); and the generic forward EXCLUDES
`awaiting_countersign` — that status routes only through the architect's own
moves, or the new holder is stranded in someone else's action item (P30).

## Round 5 — the head limit, and the split along the findings' own seam

Six findings on the round-4 head (1 P1, 5 P2), and the review lifecycle reports
the five-head limit with the advice to split. The seam is in the findings' own
distribution: **§A (unit 4a) has drawn ZERO findings since round 3, while every
round-4 and round-5 finding lands on the 4b–4d design prose** — the countersign
finality seal, consultation push/lock windows, holder-membership removal, the
finality FK key shape, queued-push holder drift, generic forwards from the
countersign state. This is the 7B-iii-b / 7B-iii-f situation exactly (both
split at their round 5, both along the seam the findings drew), and the same
move is taken: **the plan narrows to the programme frame + the full 4a design;
units 4b–4d keep their scope and receive their design in a dedicated follow-up
plan unit.** The superseded 4b–4d prose remains readable at head `ac164c5`.

**The round-5 findings are NOT dismissed — they are BINDING obligations on the
4b–4d plan**, recorded here with their answers-in-principle:

1. (P1) `status='approved'` under an active chain must be DB-sealed behind the
   countersign fact — a transition out of `awaiting_countersign` into
   `approved` is refused unless the head revision is `finalized=true`.
2. The send-time eligibility guard generalizes to EVERY targeted decision push
   (consultation events included), not only `decision.published` — the class,
   not the instance.
3. Removing a membership that is the CURRENT HOLDER of an open decision is
   refused through the orgs participant; the escape in 4b is withdraw-and-
   reissue (4a ships it), and from 4d, forward — never a silent orphaning.
4. The claim-time predicate for a targeted pending push also verifies the
   persisted target still matches the CURRENT holder (a forward between commit
   and claim re-targets or drops, recorded).
5. Consultation request/response eligibility is checked UNDER the decision row
   lock (the lock-before-read rule), with a request-vs-withdraw barrier probe.
6. The finality FK cannot target `(id, finalized)` — the existing spec
   provenance identifies approvals by their provenance columns, so the
   register's candidate key is those columns WIDENED by `finalized` (or the
   provenance rows additionally store the server-resolved revision id); the
   4b–4d plan states the exact key after reading the Phase-3 provenance shape.

**The deferral ledger, post-split.** 4a's questions are the plan's P1–P14, each
with its red site, executed at 4a's own staged baseline. The 4b–4d questions —
all of rounds 1–5's findings on those units, including the six above — bind
NAMED probes P15–P42, listed one-per-question in the plan's §E (Codex, round 6:
a deferred question binds to a probe the runner can execute, never to a future
promise); the 4b–4d plan unit elaborates each probe's red site and staging, and
its review stop is equally inside `phase-6-task-4` (the trailer's target).

## Round 6 — the narrowed diff, and the guard that crossed a boundary

Four findings on the split head (1 P1, 3 P2), three on the shipped 4a design
and one on the deferral mechanics — all corrected on this head:

1. The round-4 send-time guard would have had the PLATFORM relay reading a
   decisions table. Inverted: the push intent carries a platform-owned SUBJECT
   key, and the WITHDRAW TRANSACTION cancels its own decision's pending pushes
   through a narrow platform-owned operation — each module touches only its own
   tables (P10).
2. (P1) Deferred questions must bind to probes the runner can EXECUTE — the
   4b–4d probes are now NAMED in this plan's §E (P15–P42), one per question;
   the future plan elaborates, it does not invent.
3. Every new column joins the enum value in the retry-safe form
   (`ADD COLUMN IF NOT EXISTS`) — a partial deploy completes on re-run.
4. `approve` validates `prior ∈ {pending, change}` BEFORE its CAS, so a stale
   approval replayed against a withdrawn decision is a deliberate 409 with no
   register side effects, never a raw trigger failure mid-write (P3). The binding, by round-3 finding (rounds 1–2 bind identically
through their sections): the holder-mutation seal → P34; provisional approvals
as provenance → P31 (the `finalized` CHECK-pinned composite, hostile inserts);
`withdrawChange` on disagreement requests → P33; open-state-only forwards →
P30; the countersign emission → P31; the retired pending notice → P10; late
consultation responses → P25; the response's child keys → P27; the impact
fields → P33; the 4c/4d staging arm → the per-unit staging rule + 4d's
eligibility probe. Each runs RED-FIRST at its unit's staged baseline
(4a: P1–P14; 4b: P15–P22; 4c: P23–P27; 4d: P28–P36), inside `phase-6-task-4`'s
own exact-head review stops, which fail closed exactly like this one.

## Round 7 — second-order refinements of round 6's own additions

Four findings on the round-6 head (1 P1), each sharpening a mechanism round 6
introduced, corrected on this head:

1. The pending-only cancellation missed a delivery LEASED just before the
   withdraw commits — the send path now re-checks its OWN row's cancellation
   mark after the lease and before notify (platform-internal), with BOTH
   orderings probed (P10).
2. (P1) The reverse never-approved trigger read the decision's status without
   locking it — an uncommitted withdrawal and a hostile revision insert could
   both commit under READ COMMITTED. The trigger takes the decision row's
   `FOR UPDATE` before reading (the Phase-4 bound-3 precedent), barrier-raced
   in both orderings (P8).
3. The outbox SUBJECT column/index joins the retry-safe migration inventory —
   cancel-by-subject without its column finds nothing (§A.6).
4. `withdrawnById` is FK-backed — presence alone let hostile SQL attribute the
   permanent register to a nonexistent actor (P8).

## Round 8 — the boundary stated honestly, and the migration's own past

Four distinct findings on the round-7 head (all P2; the status reported six —
two comments were double-delivered), each again a refinement of the previous
round's own additions, corrected on this head:

1. Even the post-lease pre-send check cannot serialize with the withdrawal
   COMMIT — a cancellation landing between that check and the external notify
   call is unrecallable, exactly like an already-sent push, and closing it
   would put external I/O inside the withdraw transaction. Taken as Codex
   offers: the invariant is RESTATED at its true boundary (no stale push whose
   delivery had not passed its final pre-send check at withdraw-commit time;
   the check→send residual is documented, not probed) — the honest-residual
   discipline, not an overclaim (P10).
2. The subject key must reach BACKWARD: pre-migration durable
   `decision.published` deliveries get their subject BACKFILLED from their own
   `DomainEvent` entity id, deterministically, in the same guarded form —
   else a publish committed before the deploy escapes cancellation (§A.6).
3. The new FK/CHECK constraints join the retry-safe inventory with named
   `pg_constraint`-guarded `DO` blocks — an aborted deploy must not fail its
   re-run on its own earlier constraint (§A.6).
4. The withdrawal evidence travels through the CONTRACT: `DecisionDto`/shared
   `Decision`/`serializeDecision` gain the withdrawal fields (pmc audience),
   and P14 pins the API response, not merely the rendered chip (§A.5).

## Round 9 — the seal's proof was true of new data and false of history

One finding (P1), corrected on this head: the never-approved seal inferred
"never approved" from an EMPTY register — true for every row 4a creates, false
for history, because the Phase-3 approval-history backfill (PR #192)
deliberately registered only PROVABLE legacy approvals, leaving `approved`
rows with empty registers that hostile SQL could have withdrawn through every
existing check. The entry seal now admits `withdrawn` ONLY from a published
`pending` source row (the DB mirror of the service CAS), keeping the register
check as the second arm, with the legacy approved-empty-register hostile
UPDATE probed (P8). The lesson is round 3's trust-anchor rule pointed at
TIME: a derivation that holds by construction for new rows must be re-proven
against every historical state the migrations have left behind.

## Status

Sixty-seven distinct findings across nine finding-bearing heads (13 + 20 + 10 +
5 + 6 + 4 + 4 + 4 + 1; round 2 doubled and one round-7 comment pair
double-delivered — delivery artifacts recorded, each head counted once). The
4a design absorbed rounds 1–3, stayed clean through 4–5 (the 4b–4d seam the
five-head-limit SPLIT followed), and rounds 6–8 refined the shipped 4a text
with strictly narrowing scope and severity (1 P1 → 1 P1 → all P2), each round
landing on the immediately previous round's own additions. This PR ships the
programme frame + the implementation-ready 4a design + this audit; the STATUS
flip follows as the immediate tiny PR; the 4b–4d design ships in its own plan
unit. Nothing is dismissed — the deferral trailer stands, and every open
question is bound to a NAMED probe: P1–P14 in this plan for 4a, P15–P42 listed
in §E for 4b–4d, each elaborated and executed at its unit's own review stop.

Review-Convergence: complete
