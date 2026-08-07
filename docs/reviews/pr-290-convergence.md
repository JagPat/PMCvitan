# PR #290 convergence audit — the STATUS record for 6B-i

Two finding-bearing heads (`cc9ca42`, `f8b5599`) trigger the convergence rule on
a documentation PR. That is worth pausing on rather than treating as paperwork:
this PR changes no runtime code, and it still produced two P1s.

## The findings

| # | Source | Head | P | Finding |
|---|---|---|---|---|
| 1 | Codex | `cc9ca42` | P1 | `task_state: merged` with `work_item` still naming the merged unit — `assessRunnerState` consults `work_item` before `next_task`, so the runner re-enters finished work |
| 2 | JagPat | `cc9ca42` | — | Three stale counts contradicting the current-head figures beside them |
| 3 | Codex | `f8b5599` | P1 | The pin written for finding 1 **describes** the defect instead of **enforcing** the invariant — the stale shape still passes |

## The root — a test that states a behaviour is not a test that prevents one

Findings 1 and 3 are one root, and 3 is the sharper half because it is the fix
for 1 failing in the same way.

The fix for finding 1 added a pin asserting *both directions*: that an uncleared
flip resolves to `work_item:<merged unit>` and a cleared one resolves to
`next_task:<successor>`. That reads like rigour — the defect direction asserted
so the fix is proven against the failure it prevents — and it is the same
two-directions discipline PR #289's audit established for barrier probes.

It is not the same thing. A barrier probe's two halves both assert what must be
TRUE. This pin's first half asserts what the resolver DOES with a bad input, over
a **fixture**. The live document is never consulted, so the next merge flip with
exactly the stale shape passes it — and the pre-existing live-file guard cannot
catch it either, because that guard rejects only `task:*` and a stale flip
resolves to `work_item:*`. CI would have certified a STATUS file that sends the
runner backwards, which is the precise outcome the pin was written to prevent.

**A fixture can only demonstrate. Enforcement has to read the artifact.**

### Mechanical closure

A new test reads the LIVE `docs/STATUS.md`: when `task_state` is `merged`,
`work_item` must be `none`, and the resolved next step must not be a
`work_item:*`. Mutation-verified — reintroducing the stale value into the real
document fails CI by name:

```
docs/STATUS.md records task_state: merged while work_item still names
'phase-5-task-6b-i'. `assessRunnerState` consults work_item BEFORE next_task, so
the runner would re-enter the unit that just merged instead of advancing.
```

The fixture-level pin is KEPT, because it explains *why* the rule exists in a way
the live guard cannot — it shows the resolution the invariant prevents. What
changed is that it is no longer the only thing standing there.

## Why this matters more than its size suggests

Both P1s are in the mechanism the autonomous loop uses to decide what to do next.
A wrong `work_item` does not fail loudly: every field is individually valid,
preferring a named follow-on is the correct default, and the runner would simply
have re-derived a status derivation that was already merged and cleared — quietly
burning a cycle on finished work while payment reversals waited.

That is the same class as PR #289's root B, one layer up from code: a guarantee
recorded rather than exercised. The difference here is that the recording *was* a
test, which is the most convincing way to be wrong.

## The test if this recurs

If a future finding is "the pin passes on the state it was written to reject",
the correction is not another fixture. It is to make the guard read the artifact
the rule is about.
