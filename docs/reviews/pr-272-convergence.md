# PR #272 — architectural convergence audit (Phase 5 Task 3)

Two finding-bearing heads, seven findings. Per `CLAUDE.md`, the third head is not another isolated
patch: this names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `7be9022` | 5 | 4×P1 scope, 1×P2 civil day |
| `f0bb63f` | 2 | 1×P1 missing site, 1×P2 boundary validation |

---

## The seven findings

| # | Head | Sev | Finding | Root |
|---|---|---|---|---|
| 1 | `7be9022` | P1 | Effort fetched by PO line alone — a caller could name a DIFFERENT signed-off activity plus its output, pass the sign-off and evidence checks against that one, and have the quantity cap satisfied by work on an activity nobody signed off | **A** |
| 2 | `7be9022` | P1 | The ordered cap compared against the FROZEN `personShiftQty`; after a capacity default the version can still read `issued` while the commitment authorises nothing | **A** |
| 3 | `7be9022` | P2 | `measuredOn` defaulted to the server's UTC date rather than the project's civil day | **A** |
| 4 | `7be9022` | P1 | The correction floor was the LINE aggregate: with A=1 and B=1, correcting A by −2 keeps the line at a legal 0 while silently wiping B's evidence | **A** |
| 5 | `7be9022` | P1 | The live-line check refused REDUCING corrections too, deadlocking against `assertWorkEvidenceRevisable` telling the operator to correct to zero first | **A** |
| 6 | `f0bb63f` | P1 | The measured floor was on close-short only; `defaultCapacity` cuts the same authority | **B** |
| 7 | `f0bb63f` | P2 | `measuredOn` accepted a well-shaped impossible date (`2026-02-31`), turning a bad request into a 500 from the shared parser | **A** |

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

## A defect in my own testing, fixed

**R3 initially PASSED against the bug it was written for.** With `Asia/Kolkata` the site date differs
from UTC only between 18:30 and 24:00 UTC, so for most of the day the probe asserted nothing. It now
picks whichever of UTC+14 / UTC−11 currently differs from UTC — at every instant at least one does —
and asserts that difference up front, so it cannot be vacuous.

Caught only because the RED proof is run rather than assumed. A probe that passes while the code is
wrong is worse than no probe, and this one would have shipped as evidence for a fix it never tested.

---

## What did NOT change

- Tasks 1 and 2 are not reopened; `20270405000000`/`20270410000000` are byte-for-byte unchanged.
- `20270415000000` is UNMERGED and part of this PR, so its `raisedBy` CHECK extension is edited in
  place rather than amended by a second migration — one table, one migration.
- No readiness verdict moves. Commercial remains a SINK, and a measurement gates nothing.
- §D is still carried forward VERBATIM; none of these corrections touched the plan text.
