# Convergence audit — PR #265 (asking the five-head rule)

Required by `CLAUDE.md` after two finding-bearing heads. Both findings are P2 and
both are the same defect seen twice, which is what this audit is for: not two
patches, one root cause.

| Head | Findings |
| --- | --- |
| `072a1d5` | 1 — P2, the advisory reached only the Actions log |
| `92f2a57` | 1 — P2, the advisory was snapshotted before the review that could cause the crossing |

## The root cause: I built the signal and then under-delivered it, twice

This unit exists because a rule that nothing calls governs nothing. That was the
lesson of #259 and #263, and I wrote it into this unit's own commit message.

Both findings here are the *same lesson one step further out*: a signal nobody
receives informs nothing.

| Head | Where the signal stopped |
| --- | --- |
| `072a1d5` | written to the Actions log — which neither the loop's actors nor humans read |
| `92f2a57` | written to the sticky, but computed too early to include the crossing that had just happened |

The first is a wrong *channel*. The second is a wrong *moment*. Neither is a bug
in what the rule computes — `observeReviewLifecycle` was correct from the first
head and neither round touched it. The defect both times was in the last mile:
getting a correct verdict to a place and a time where it changes what happens
next.

That is worth naming, because it is the exact failure this unit was built to fix.
I fixed "the rule is never asked" and then twice shipped "the answer never
arrives". The audit's conclusion is that **delivery is part of the rule**, not a
presentation detail bolted on after.

### What changed structurally

Not two point fixes. One rule, applied at every site:

> The advisory is computed at the moment it is published, and published where the
> reader is.

- `reportReviewLifecycle` **returns** the advisory rather than writing it, so the
  helper cannot race the status writes it would otherwise interleave with, and
  the caller decides where it lands.
- `statusBody` renders it beside `Next:` — because `Next:` is what it qualifies.
  "Keep correcting" reads differently on a unit that has spent its head budget.
- Every sticky whose state tells the loop to **keep correcting** carries it, and
  nothing else does. Those are the states the advisory contradicts.
- Every sticky written **after findings land** recomputes via `freshAdvisory`
  rather than carrying a snapshot, because the finding that just arrived may *be*
  the crossing. The one pre-review sticky keeps the snapshot, since it is written
  before the review that could cross the limit — and `L8` pins that asymmetry in
  both directions so neither drifts.

`L7` and `L8` are the durable form of the lesson: `L7` fails if the advisory
stops reaching a PR-visible channel, `L8` fails if any post-finding sticky goes
back to a stale value.

## What did NOT drift

The boundary held under both rounds. Neither finding asked this unit to block,
and it still does not. `L6` — the observation never blocks and never throws —
passed unchanged throughout, and the deferred half (declaration channel, reply
window, durable record, expiry sweep, recovery path) remains entirely in unit 2.

This is the measurable difference from #264. There, the equivalent two rounds
produced P1s in the record-lifetime machinery, each caused by the previous round's
fix. Here two rounds produced two P2s in the delivery path, both fixed without
touching the verdict logic, and both caught within seconds by existing tests when
I mis-edited while threading.

| | #264 (both halves) | #265 (unit 1) |
| --- | --- | --- |
| Rounds so far | 12 | 2 |
| P1s | 6, four caused by the prior fix | 0 |
| Lines | 3,223 | 577 |
| Findings' locus | record lifetime / recovery | advisory delivery |

## Standing questions

None open. Both findings are closed with discriminated probes, and neither
touched `observeReviewLifecycle`, whose behaviour is unchanged from `072a1d5`.
