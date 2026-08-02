# PR #272 — architectural convergence audit (Phase 5 Task 3)

Three finding-bearing heads, ten findings. Per `CLAUDE.md`, from the third head on this is not
another isolated patch: it names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `7be9022` | 5 | 4×P1 scope, 1×P2 civil day |
| `f0bb63f` | 2 | 1×P1 missing site, 1×P2 boundary validation |
| `fa40ccf` | 3 | 1×P1 unsound fold shape, 2×P2 the service holding a rule PostgreSQL should |

---

## The ten findings

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

## Two defects in my own testing, both fixed

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

---

## What did NOT change

- Tasks 1 and 2 are not reopened; `20270405000000`/`20270410000000` are byte-for-byte unchanged.
- `20270415000000` is UNMERGED and part of this PR, so its `raisedBy` CHECK extension and the two
  round-3 seals are edited in place rather than amended by a second migration — one table, one
  migration. Nothing that has ever been deployed changes byte.
- No readiness verdict moves. Commercial remains a SINK, and a measurement gates nothing.
- §D is still carried forward VERBATIM; none of these corrections touched the plan text.
- Task 4 has NOT begun. §D's review stop stands: no bill may consume a measurement until this head
  is independently cleared and JagPat gives an explicit GO.
