# PR #324 — convergence audit (Phase 6 architecture plan)

Two finding-bearing heads, nine findings, on a docs-only plan. **Three of the nine are one root, and
it is a root the plan could have avoided by asking a question it never asked.**

| # | Head | Finding | Root |
|---|---|---|---|
| 1 | `e222981` | derive the closed set through the permission mapping, not `ROLE_POLICY` | **A — built on `ROLE_POLICY`** |
| 2 | `e222981` | commit the §A/§C/§E decisions before handoff | scope of a plan stop |
| 3 | `e222981` | do not advance while Phase 5 remains open (STATUS) | **C — folded STATUS** |
| 4 | `e222981` | use the closed set as a deny list, not an intersection | **A — built on `ROLE_POLICY`** |
| 5 | `e222981` | keep canonical parties out of procurement ownership | layering |
| 6 | `f9a4125` | land the plan in the merged handoff shape (STATUS) | **C — folded STATUS** |
| 7 | `f9a4125` | include READ routes in the default-deny surface | **B — class named, not carried** |
| 8 | `f9a4125` | define how scoped evidence upload is allowed | **B — class named, not carried** |
| 9 | `f9a4125` | do not widen shared permissions for scoped routes | **A — built on `ROLE_POLICY`** |

Two more were **self-caught between heads** and are listed because a correction that only counts the
findings someone else made is measuring the reviewer, not the work: the vacuous-conjunct-2 gap
(fixed on `f9a4125` before review) and the capability activation trap (§L's shape, found while
scouting `capabilities.service.ts` during the gate wait, folded into this head).

## Root A — I kept adjusting the rule's relationship to `ROLE_POLICY` instead of removing it

Findings 1, 4 and 9 are all the same mistake at increasing depth, and each correction moved one
level without reaching the bottom:

- **Round 0** derived the closed set *from* `ROLE_POLICY`. Finding 1: it is keyed by permission, not
  command, and 33 of 167 mutating routes carry no permission at all.
- **Round 0** also wrote the allow rule as `ROLE_POLICY ∩ closed set`. Finding 4: the forbidden set
  was inside the allow calculation, so the one command an accidental policy edit made reachable is
  exactly the one that survives.
- **Round 1** fixed both by deriving over routes and making the rule default-deny — but left
  conjunct 2 reading `ROLE_POLICY[route.permission]`. Finding 9: satisfying that for one
  party-scoped route means adding `contractor` to a shared permission like `procurement.read`,
  which widens **every** route behind it — and `ROLE_POLICY` is global while the capability is
  per-project, so capability-OFF projects silently gain reads that are refused today.

Round 1 even *measured* the thing that should have ended it. It counted the 33 permission-less
routes, concluded "a `ROLE_POLICY`-only derivation is blind to a fifth of the surface", and then
kept `ROLE_POLICY` as conjunct 2 anyway — adding a rule ("only a `@RolesFor` route may be
allow-listed") whose only purpose was to make the surviving dependency tenable. That rule *is*
finding 9: it forced the widening.

**What replaces it.** A separate `COLLABORATOR_ROUTE_POLICY` mapping route → `{scope, roles}`, which
**replaces** the `ROLE_POLICY` decision for a collaborator principal rather than adding to it.
`ROLE_POLICY` is never widened and never consulted for one, pinned by a tripwire asserting no
`ROLE_POLICY` entry gains a collaborator role. That single change closes findings 1, 4 and 9, closes
the self-caught conjunct-2 gap (the map is total over the allow-list by construction), and makes the
allow-list able to cover the `@AllowAnyRole` routes it previously had to exclude.

> **When three successive findings are all about how your rule relates to an existing artefact, the
> finding is the dependency, not the relation.** The question round 0 never asked was not "how
> should this read `ROLE_POLICY`" but "should `ROLE_POLICY` be in this rule at all". It should not:
> it is the *internal* authority map, and the whole phase is about not widening internal authority.
> The answer was in the section heading the entire time.

Worth noting what "replaces, not adds" buys, because it is the difference between a boundary and a
decoration: an AND with `ROLE_POLICY` cannot narrow anything a collaborator can already do — a
contractor already passes `project.read` — so the phase would have closed money writes while leaving
the project snapshot reachable. Which is finding 7.

## Root B — a class measured in one section and not carried into the others

Three instances, one shape:

| Where the class was named | Where it was not carried | Finding |
|---|---|---|
| §D measured **167 mutating** routes | it never asked about the other **58 reads** — 9 of which already admit a collaborator, including `GET snapshot` and `GET shell` | 7 |
| §C excluded `media` as a scope for **reading** evidence | it never asked how evidence gets **created** — `MediaController.upload` is media-owned and `pmc`/`engineer` only | 8 |
| §D measured the **33 permission-less** routes | §B's conjunct 2 did not account for them | self-caught |

**This is rule 1 from the plan's own carried-forward list**, and the plan's own text already says
round 0 committed it — "it named hand-kept lists as the root of Phase 5's last unit, then proposed a
hand-reachable derivation for §D one paragraph later". So it happened again, in the correction
written to record it. Naming a root in prose is not the same act as searching for its other
instances, and writing the sentence down does not perform the search.

The concrete practice that would have caught all three: after measuring any set, **enumerate the
complement in the same breath** — 167 mutating implies 58 not-mutating; read-media implies
write-media; permissioned implies permission-less. Every one of these findings is a complement
nobody looked at.

## Root C — folding STATUS into the work PR removed the PR that wrote the post-merge shape

Findings 3 and 6 are both STATUS, and both are consequences of process change #37 (fold STATUS into
the work PR rather than shipping a separate flip PR).

- **3** is the historical half: the `Now` block advanced to Phase 6 while the Phase 5 table still
  carried `not_started` on parent Tasks 7 and 7B and a narrative sentence reading "PHASE 5 IS THE
  ACTIVE PHASE".
- **6** is the forward half: the block recorded `task_state: in_progress`, `work_item:
  phase-6-planning`, `open_pr: 324` — the shape it has *while the PR is open*. After merge,
  `assessRunnerState` returns `task:0` and the loop re-enters the already-merged planning item
  instead of starting 6.1.

The old separate-flip PR existed precisely to write the post-merge shape *after* the work merged.
Folding it in removed that PR without recording what it was for.

> **A folded STATUS must be committed in the shape it will have AFTER this PR merges, not the shape
> it has while the PR is open.** PR #323 is the precedent — it committed `task_state: merged`,
> `work_item: none`, `open_pr: none` while itself being an open PR.

This does sit in tension with `CLAUDE.md`'s instruction to set `open_pr` to the PR number, and with
the hourly drift shepherd that posts when live open PRs disagree with `open_pr: none`. The tension
is real and the resolution is the one #323 already took: a transient disagreement during the PR's
own life is the accepted cost of folding, because the alternative — a correct-while-open file that
is wrong the instant it merges — is a state no later PR exists to fix.

## Verification

- `assessRunnerState` on the committed file returns `next_task:phase-6-task-1`, and is
  **mutation-tested**: restoring `work_item: phase-6-planning` yields
  `work_item:phase-6-planning`, restoring `task_state: in_progress` yields `task:0`, restoring
  `open_pr: 324` yields `pr:324`. Three different wrong answers, so the check could have failed.
- The route measurements are taken by walking the same controller metadata `route-policy.test.ts`
  walks — 225 handlers, 167 mutating (134 `@RolesFor` / 22 `@AllowAnyRole` / 11 `@Public`), 58 reads
  (45 `@RolesFor`), 9 reads already admitting a collaborator role. Counted, not estimated.
- Every §A layering claim is checked against the live manifests: `orgs.dependsOn`,
  `procurement.dependsOn`, and that nothing in the graph depends on `orgs`.
- `test:automation` 200/200 on every head.

## What this audit does not claim

Nine correct findings on a plan is not a sign the plan was written carelessly, and treating it that
way would produce the wrong correction. Roots A and B are both failures of *follow-through* rather
than of judgement — a measurement taken and not used, a dependency questioned once and not again.
The fix for that is not more caution; it is the two mechanical practices above (enumerate the
complement; when the same artefact appears in three findings, delete the dependency), which are
checkable in a way "be more careful" is not.
