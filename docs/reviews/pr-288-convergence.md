# PR #288 convergence audit — a claim about behaviour is only true if the behaviour was run

**Trigger:** two finding-bearing heads (`7d31788` — 2 P1; `5c5e7c7` — 2 P2). `CLAUDE.md` makes this
audit due and forbids a third isolated patch.

This is a **docs-and-tooling** PR: one state file, one gate parser, one gate test. It has no runtime
surface. That makes the root unusually clean to state, because all four findings are the same
sentence.

## The four findings are one defect

| # | The claim in prose | What the executable said |
|---|---|---|
| 1 | "the runner continues into 6B-i" | `assessRunnerState` → `work_item:phase-5-task-6b` — the **unsplit parent** |
| 2 | "with no reversal yet, no status can move backwards" | `commercial-status.ts`, same author, hours earlier, documents `paid → certified` on a release |
| 3 | "the two shapes are… the same strings `docs/STATUS.md` uses" | `TASK_REFERENCE` rejects `phase-5-task-6b` — and had since Task 5A |
| 4 | "`PAID`'s reversal term is written here now, at zero rows" | `paidFor`'s SQL is `Σ Payment`, with no reversal term and no table to read |

Every one is a **statement about machine behaviour that the machine contradicted.** Not one required
new information to catch — each was checkable, at authoring time, by running the thing being
described.

## The root, and why it is a sibling rather than a new one

PR #287's audit ended on *"a probe must execute the thing it is evidence for."* This is the same rule
one level up: **a document asserting machine behaviour is evidence only if the machine was run.**

The failure mode is identical in shape. In #287 the tests asserted a *proxy* for the invariant —
catalog counts instead of the closure, presence instead of enforcement. Here the docs asserted a
*proxy* for the behaviour — my intention, instead of the code. Both feel like verification while
checking something adjacent to the subject.

Finding 2 is the sharpest instance, because the contradicting evidence was **already in the same
branch, written by me**. Two artifacts, hours apart, saying opposite things about whether a status
can move backwards; the reviewer read both together and I never had.

## What each fix actually did — and the discipline that follows

Each correction was verified by **executing the thing**, not by re-reading it:

| # | Fix | Executed |
|---|---|---|
| 1 | `work_item: phase-5-task-6b-i` | `assessRunnerState` → `work_item:phase-5-task-6b-i` |
| 2 | non-monotonicity stated as a REQUIREMENT on the CAS | landed before `reDerive` was written, so it shaped the design; `isDerivedBillStatus` guards the family, not the direction |
| 3 | pattern admits `task-6b`, `task-6b-i` | accept/reject table over five valid and five invalid ids; test's real-shapes loop extended |
| 4 | fold term kept with the table it reads | `paidFor` docstring corrected at its origin, STATUS row corrected to match |

Finding 3 was also **wider than reported**: the reviewer flagged the new id, but `phase-5-task-6b`
was already rejected. A deferral trailer naming the unit under review could never have parsed since
Task 5A. Fixing only the reported id would have been the member; the class is "the vocabulary must
accept the ids this project actually uses", which is what the accept/reject table now pins.

## The rule this leaves behind

Before a document states what a machine does, **run the machine and paste the answer.** Concretely,
for this repository:

- a `work_item`/`next_task` change → run `assessRunnerState` and quote `nextStep`;
- a claim about what a gate accepts → run its parser over an accept/reject table;
- a claim about what a fold or query computes → read the SQL, not the docstring above it;
- a scoping claim about a sibling unit → check it against the code already on the branch.

That last one is finding 2, and it is the one worth carrying: **the contradiction was internal.**
Nothing external was needed to catch it — only holding two of my own artifacts against each other
before shipping them in the same PR.

## Open item carried forward

Root A's lesson from #287 — *fix the class, not the member* — held again here (finding 3), and the
new rule above is its verification-side twin. Both belong in the module's convergence record: the
first says where a fix must land, the second says what makes a claim about it true.
