# PR #272 — architectural convergence audit (Phase 5 Task 3)

Four finding-bearing heads, fifteen findings. Per `CLAUDE.md`, from the third head on this is not
another isolated patch: it names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `7be9022` | 5 | 4×P1 scope, 1×P2 civil day |
| `f0bb63f` | 2 | 1×P1 missing site, 1×P2 boundary validation |
| `fa40ccf` | 3 | 1×P1 unsound fold shape, 2×P2 the service holding a rule PostgreSQL should |
| `c8becb1` | 5 | 1×P1 a seal beaten by a snapshot, 4×P2 the same root as round 3, unfinished |

---

## The fifteen findings

| # | Head | Sev | Finding | Root |
|---|---|---|---|---|
| 1 | `7be9022` | P1 | Effort fetched by PO line alone — a caller could name a DIFFERENT signed-off activity plus its output, pass the sign-off and evidence checks against that one, and have the quantity cap satisfied by work on an activity nobody signed off | **A** |
| 2 | `7be9022` | P1 | The ordered cap compared against the FROZEN `personShiftQty`; after a capacity default the version can still read `issued` while the commitment authorises nothing | **A** |
| 3 | `7be9022` | P2 | `measuredOn` defaulted to the server's UTC date rather than the project's civil day | **A** |
| 4 | `7be9022` | P1 | The correction floor was the LINE aggregate: with A=1 and B=1, correcting A by −2 keeps the line at a legal 0 while silently wiping B's evidence | **A** |
| 5 | `7be9022` | P1 | The live-line check refused REDUCING corrections too, deadlocking against `assertWorkEvidenceRevisable` telling the operator to correct to zero first | **A** |
| 6 | `f0bb63f` | P1 | The measured floor was on close-short only; `defaultCapacity` cuts the same authority | **B** |
| 7 | `f0bb63f` | P2 | `measuredOn` accepted a well-shaped impossible date (`2026-02-31`), turning a bad request into a 500 from the shared parser | **A** |
| 8 | `fa40ccf` | P1 | A correction could target another correction, so the direct-children `netOf` floor from finding 4 was unsound over a chain | **C** |
| 9 | `fa40ccf` | P2 | A NEGATIVE original was refused only by the service; a direct insert leaves permanent corrupted evidence in an immutable table | **C** |
| 10 | `fa40ccf` | P2 | A nonexistent `evidenceMediaId` surfaced as a 500 from the raw FK violation instead of a 400 | **C** |
| 11 | `c8becb1` | P1 | Round 3's own correction-target seal was a BEFORE trigger, whose snapshot a concurrent commit can slip past | **D** |
| 12 | `c8becb1` | P2 | The cited output's FK proved project containment only, so a measurement could rest on ANOTHER activity's progress | **C** |
| 13 | `c8becb1` | P2 | A correction's FK proved the target EXISTS, not that it describes the same work | **C** |
| 14 | `c8becb1` | P2 | `MediaService.remove` had no commercial guard, so deleting a cited measurement photo returned a raw 500 | **C** |
| 15 | `c8becb1` | P2 | The register published the frozen `personShiftQty` while the write path capped by live authority | **A** |

---

## Root A — the right quantity, the wrong scope (findings 1, 2, 3, 4, 5, 7)

Six of the seven are one sentence in different words: **the bound checked the correct quantity
against the wrong scope.**

| finding | scope used | scope required |
|---|---|---|
| 1 | effort of the **line** | effort of the line **on the activity being measured** |
| 2 | the **original** order | the order's **live authority** |
| 3 | the **server's** day | the **project's** civil day |
| 4 | the **line** total | the **row being corrected** |
| 5 | **all** writes | **positive** writes |
| 7 | the date's **shape** | the date's **existence** |

Every individual check I wrote was defensible in isolation; each was reading a slightly wider or
narrower slice of the world than the rule it was enforcing. That is not six unrelated slips, it is
one habit — and the habit is writing the bound before naming precisely what it is a bound *over*.

**Closure A.** Two of the fixes deliberately adopt an EXISTING rule rather than inventing a parallel
spelling of it, which is the durable half of the correction:

- finding 2's live authority is Task 2's `liveAllocation` rule (`0` when defaulted, `committedQty`
  when closed short), now exposed once on `LabourCommittedLine.liveAuthority` so no caller re-derives
  it;
- finding 4's row-level floor is the same identity §E's `(measurementId, consumedQty)` consumption
  freeze will depend on, so Task 5 inherits it rather than adding a second notion of "which row";
- finding 7 adopts the shared `isoCivilDateSchema` instead of a local regex.

The scopes themselves are now single-sourced: `effortForPoLines` takes the activity, the labour read
contract carries `liveAuthority`, and `netOf` is the only place a row's remaining contribution is
computed.

---

## Root B — a fix that created its own missing site (finding 6)

Finding 6 deserves separating, because **round 1's own fix is what created it.** Making `defaulted`
map to a live authority of `0` turned `defaultCapacity` into an authority-cutting write — and the
measured floor was on `closeShortPo` only. §0b's rule is "same rule, every site", and I had put it
on one site because at the time only one site cut authority.

The lesson is narrower and more useful than "check every site": **a fix that changes what a value
MEANS changes which writers are subject to the rules that read it.** `liveAuthority` did not exist
before round 1; the moment it did, every writer that could move it inherited the floor. That is the
same shape as PR #270's root B (a changed fold silently created a new headroom mover), one task
later and in a different module.

**Closure B.** The floor now runs on both sites, and the operational consequence is stated in the
code rather than left for someone to discover: once real work has been measured against a line, a
supplier walking away is recorded as a CLOSE-SHORT — which keeps the committed portion — not as a
default. `default` is for a commitment that delivered nothing anyone measured. If the work is being
disclaimed rather than kept, the measurement is corrected first and the default is then free. Probe
R6 walks both orderings.

---

## Root C — the seam between the service and PostgreSQL was drawn by convenience (findings 8, 9, 10)

The three round-3 findings are one question answered wrongly three times: **which of the service and
PostgreSQL should hold this rule?** I had been answering "whichever is easier to write here", and the
correct answer is structural:

- if a LATER READ depends on the shape, PostgreSQL must hold it — a service check protects the rows
  that path writes, not the rows the read will find (findings 8, 9);
- if PostgreSQL holds it, the service must translate the refusal into the domain's language — a raw
  constraint violation reaching the client is an unhandled error, not a validated rejection (10).

Finding 8 is the sharp one, and it is **the third instance in two PRs of a fix silently introducing
an assumption it did not seal.** Round 1's fix for finding 4 replaced the line-aggregate floor with
`netOf` walking a row's DIRECT children — which is correct *if and only if* the correction tree is
one level deep. Nothing made it one level deep. The same shape as PR #270's root B (a changed fold
created a new headroom mover) and this PR's root B (a changed meaning created a new authority-cutting
writer): **the fix was right, and the precondition it acquired was left implicit.**

**Closure C.** Stated as a rule I can apply rather than a resolution to be careful:

> When a correction changes HOW a value is computed, write down the property of the stored data the
> new computation relies on, and put that property where the computation will read it — in the
> schema. If it cannot be expressed there, the computation is reading the wrong shape.

`netOf` relies on a one-level tree, so `Measurement_correction_target` makes a chain unrepresentable
at PostgreSQL rather than merely refused by the service that happens to write it. `netOf` relies on
originals being positive, so the split `Measurement_quantity_check` (`>0` for an original, `<>0` for
a correction) makes a negative original unrepresentable. And `rethrowMediaRefViolation` — already the
cleared Task-5 precedent for exactly this — turns the evidence FK's refusal into the 400 it is.

---

## Round 4 — root C was answered in ONE place, and root D names why

Three of round 4's five (12, 13, 14) are root C again, and that is the honest headline: **round 3
stated the rule and applied it only where the review had pointed.** Closure C says "if a later read
depends on the shape, PostgreSQL must hold it" — and I applied it to the two shapes findings 8 and 9
named, then stopped. The cited output's activity, the correction's work identity and the media guard
were all the same rule, all already visible in the same file, all left for the reviewer to find.

Finding 15 is root A one more time (a bound stated against the wrong scope — the register published
the frozen order while the write path enforced live authority), which is the same scope habit
surviving three rounds after its closure.

**The closure that was missing is a sweep, not another rule.** A rule I apply only at the sites a
reviewer names is not a rule, it is a patch with a paragraph attached. So round 4's corrections were
derived by enumerating EVERY reference on the table and asking the closure-C question of each,
rather than by fixing the three that were reported:

| reference | does a later read depend on it? | seal |
|---|---|---|
| `labourPoLineId` | yes | same-project composite FK |
| `activityId` | yes | same-project composite FK |
| `citedOutputId` | yes — the output must be THIS activity's | **finding 12**: 3-column FK |
| `correctsId` | yes — `netOf` and §E's freeze both key on it | **finding 13**: 5-column identity FK |
| `evidenceMediaId` | yes — the photo must outlive the measurement | **finding 14**: participant guard |
| `sourceCommandId` | yes | same-project composite FK |

## Root D — a seal a snapshot can beat is not a seal (finding 11)

Finding 11 is round 3's own fix, one level too shallow — **the fourth time in two PRs that a
correction acquired a precondition it did not state.** I put the correction-target check in a BEFORE
INSERT trigger because that is where row validation usually goes, without asking what the check
READS and who else can change it before it matters.

The reviewer's stated mechanism is not quite what PostgreSQL does, and the difference matters enough
to record rather than paper over. Measured directly (`scripts/` ground truth, reproduced in the
packet):

- a correction naming an **uncommitted** target is refused **immediately** by the FK — PostgreSQL
  does *not* block waiting for that transaction; the invisible row simply is not there;
- a correction naming a **committed** target was already refused by the BEFORE trigger.

So the exploitable window is narrower than the finding states: it is the **intra-statement** gap, the
BEFORE trigger's snapshot and the FK's check being taken at different moments, so a target that
commits between them is missed by one and accepted by the other. That window is real, it is not
reachable deterministically from a test, and it is exactly the kind of thing that is cheap to close
and expensive to discover. `DEFERRABLE INITIALLY DEFERRED` closes it by construction: at COMMIT there
is no "before" left for anything to slip into.

**Closure D.** *A check is only a seal if nothing can change its input between the check and the
commit it authorises.* Where that cannot be guaranteed, the check belongs at commit — which is the
same lesson `phase4_labour_demand_sealed` already carried, and which I did not transfer because I was
thinking about WHERE validation goes rather than WHEN its input stops moving.

---

## Three defects in my own testing, all fixed

**R3 initially PASSED against the bug it was written for.** With `Asia/Kolkata` the site date differs
from UTC only between 18:30 and 24:00 UTC, so for most of the day the probe asserted nothing. It now
picks whichever of UTC+14 / UTC−11 currently differs from UTC — at every instant at least one does —
and asserts that difference up front, so it cannot be vacuous.

Caught only because the RED proof is run rather than assumed. A probe that passes while the code is
wrong is worse than no probe, and this one would have shipped as evidence for a fix it never tested.

**The three §D upgrade-proof rejections were passing for the wrong reason.** Extending the proof for
findings 8 and 9, I found that all three existing `Measurement` hostile inserts cited an output id
`OUT-1` that the legacy fixture never creates. Every one of them was being rejected by the
`citedOutputId` foreign key — so the zero-quantity CHECK, the correction-reason CHECK and the PO-line
FK each had a green line in the proof and no evidence behind it. They would have kept passing if I
had deleted all three constraints.

Same defect as R3 in a different medium, so the closure is the shared one rather than a second patch:
**a rejection is only evidence when an otherwise-identical row is ACCEPTED.** The §D section now
inserts a coherent measurement and its signed correction first — citing the real `UPL-T5O` output on
the same activity — and every hostile row below differs from that accepted one in exactly the single
respect its label names. That also converts the section from "strict" to "precise", which is the
property the other sections' coherent-chain blocks were already established to prove.

**Round 4's first draft of probes 12 and 13 compared across PROJECTS, and passed on tenancy.** The
`measurableLine` fixture mints a fresh project each call, so my "cite the other activity's output"
and "correct a row while describing another line's work" probes were both refused by the
same-project composite FKs that already existed — green, and testing nothing about the new identity
FKs. Caught the same way as the other two: by running the RED proof rather than assuming it. Both now
build the second line INSIDE the same project (`siblingLine`), so only the seal under test can reject
them, and probe 12 additionally asserts that the same insert citing its OWN activity's output is
ACCEPTED.

That is three probes-that-proved-nothing in one PR. The pattern in all three is identical and worth
naming once: **I wrote the assertion for the mechanism I had in mind instead of constructing the
state where only that mechanism can decide the outcome.** A rejection proves nothing until an
otherwise-identical case is accepted — which is now the rule the §D upgrade-proof section and probes
12 and 13 all follow.

---

## What did NOT change

- Tasks 1 and 2 are not reopened; `20270405000000`/`20270410000000` are byte-for-byte unchanged.
- `20270415000000` is UNMERGED and part of this PR, so its `raisedBy` CHECK extension and the
  round-3 and round-4 seals are edited in place rather than amended by a second migration — one
  table, one migration. Nothing that has ever been deployed changes byte.
- Round 4 adds ONE index to an already-merged table (`ActivityWorkOutput_projectId_id_activityId_key`)
  and nothing else outside `Measurement`. Widening a unique key adds an FK target; it cannot reject a
  row that `(projectId, id)` already admitted, so no existing data can fail it.
- The `commercial` participant edge on `media` is a workflow-participant channel, not a `dependsOn`:
  commercial remains a SINK and the module graph stays acyclic.
- No readiness verdict moves. Commercial remains a SINK, and a measurement gates nothing.
- §D is still carried forward VERBATIM; none of these corrections touched the plan text.
- Task 4 has NOT begun. §D's review stop stands: no bill may consume a measurement until this head
  is independently cleared and JagPat gives an explicit GO.
