# PR #278 — architectural convergence audit (the Task-5A STATUS flip)

Two finding-bearing heads on a **docs-only, four-line YAML change**. That is the whole reason this
audit is worth writing: the diff is trivial and the findings were not, because `docs/STATUS.md` is
not documentation — it is the autonomous runner's input, and prose and machine meaning can disagree.

| Head | Findings | |
|---|---|---|
| `73812d5` | 1 | P1 — the Now block sent the runner to the already-split PARENT task |
| `a812abd` | 1 | P2 — the guard written to catch that made the mirror-image mistake |

| # | Head | Sev | What was wrong |
|---|---|---|---|
| 1 | `73812d5` | P1 | `task: 5 / task_state: not_started / work_item: phase-5-task-5b` resolves to `task:5`. An open task state returns the task id BEFORE `work_item` is consulted, so the runner would have started the already-split Task 5 while the table said 5A was merged and 5B was next |
| 2 | `a812abd` | P2 | The new live-file guard demanded `work_item:*` with ONE hand-written exemption (open PRs), so a `blocking_directive` recorded from `in_progress` — which legitimately outranks `work_item` — would have failed CI on the documented fix-forward path |

---

## Root: a file with two readers, and only one of them was consulted

Finding 1 is not a typo. `not_started` was chosen deliberately, by reasoning about what a HUMAN
reading the table would understand: 5A merged, 5B has not begun, so the next increment is
"not started". That reading is correct English and the wrong machine input. `assessRunnerState`
treats `not_started` as an OPEN TASK STATE, which means *the task named by `task:` is still the work
item* — and `task:` is `5`, the unit that no longer exists because it was split into 5A/5B/5C.

`task_state: merged` is both truthful and correct: the work item WAS 5A, and 5A merged. It is also
what makes the module consult `work_item` at all.

**The rule this leaves: when a file has a program as one of its readers, the program's reading is
the one that has to be checked.** Not inferred from the field names — executed. Both fixes here
were verified by running `assessRunnerState` over the committed file before and after.

## The guard was already there, and it proved nothing

A live-file test existed before this PR and passed on the defective head:

```js
assert.equal(verdict.actionable, true, 'docs/STATUS.md leaves the autonomous runner stalled')
```

`task:5` is perfectly actionable. The test asserted the runner had A MOVE, never that it had the
RIGHT one, so it passed while pointing the loop at work that no longer exists as a unit. This is the
third instance in three consecutive PRs of the same class — the `assert_rejects` calls placed above
their helper's definition, the `command_not_found_handle` that set `FAIL=1` in a subshell, and now
this. The discipline that catches all three is the same: **test the test, and assert the property
you actually care about rather than the weakest one that happens to hold.**

## Finding 2 is the same root, one layer up — in the fix

The guard I wrote for finding 1 demanded `work_item:*` exactly, exempting open PRs. But the module
has TWO precedence rules above `work_item`, not one: a `blocking_directive` from
`correction_required` or `in_progress` outranks it as well. My exemption list was one member short —
inside the very guard written to close a related instance of "the set has more members than I
checked".

**An exemption list is the wrong shape.** It is one member short the first time the module gains a
precedence rule, and nothing tells you when that happens. So the assertion now states the DEFECT:

> a named `work_item` is never silently overridden by a bare `task:` step

`directive:*` and `pr:*` are explicit higher-priority claims that a reader of STATUS can see. `task:*`
is the one outcome that ignores a named `work_item` entirely and substitutes the parent — and when
`work_item` is set, those four are the module's whole range. So excluding a bare `task:` step is
exactly the original defect, expressed without any list to maintain. The directive exemption is
proven by a unit test that drives `in_progress` + directive + work_item and asserts it resolves to
`directive:*`, rather than being asserted in a comment.

## What was declined, and why

The drift shepherd asked for `open_pr: 278` — this PR naming itself. Declined, with reasoning left
on the PR: `open_pr` means the task PR the loop is shepherding, a docs-only STATUS flip is not a work
item, and naming itself would be stale the instant it merged — the same defect the shepherd fired on,
one commit later. Every prior STATUS flip merged with `open_pr: none` (#275, #273, #271, #269, #267,
#248). Automation instructions are evidence, not orders; this one was checked against six merged
precedents before being set aside.

## Gate results at the convergence head

| Gate | Result |
|---|---|
| `pnpm check:automation` | EXIT 0 — 191 tests |
| Live-file guard | RED against the uncorrected Now block (`not_started` → `task:5`), GREEN with `merged` |
| Directive precedence | proven by unit test, not by exemption |
| Runner resolution on the committed file | `work_item:phase-5-task-5b` |
