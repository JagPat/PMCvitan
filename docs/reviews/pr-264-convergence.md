# Convergence audit — PR #264 (wiring the five-head restructure rule)

Required by `CLAUDE.md` after two distinct finding-bearing heads. This is an
architectural audit of all seven findings together, not a third isolated patch.

| Head | Findings |
| --- | --- |
| `ccbdee3` | 6 — F1 (P1), F2 (P1), F3 (P1), F4 (P1), F5 (P2), F6 (P1) |
| `77117e4` | 1 — F7 (P1) |

## The finding that is not like the others

**F1 — the gate ran in one of the two places that reach a review.**

The lifecycle check was wired into `revalidateFinalReviewPolicy` only. The normal
orchestration path went from the convergence check straight into `reviewAttempt`,
so a unit already at five critical heads was promoted for *another* Codex review,
and a finding from that review drafted the head without the lifecycle gate ever
running. That is precisely the sixth finding-bearing head this pull request
exists to prevent.

This one deserves separating out because it is **the third instance in this
workstream of the same defect shape**, and the first two are why this pull
request exists at all:

| Instance | The rule | Why it governed nothing |
| --- | --- | --- |
| #259 | `review-lifecycle.mjs`, 20 passing tests | imported by nothing but its own test |
| #263 | the same rule, six finding-bearing heads | never called, so it never fired |
| **#264 `ccbdee3`** | the rule, now wired | wired into one of the two entry points |

I wrote in the `ccbdee3` commit message that a rule nothing consults governs
nothing — and then wired it into one call site and stopped, without enumerating
the paths that reach a review. Writing the lesson down is not the same as
applying it. **The structural fix is `W10`**: it slices the source between the
promotion-path convergence call and `reviewNotBefore` and requires the lifecycle
enforcer inside that region, so a future path that promotes without consulting
the gate fails CI rather than shipping.

## The other six are one root cause

**The lifecycle record is durable state, and I treated it as a return value.**

Everything the five-head rule decides rests on a fact no single run can observe:
*this unit has already crossed its limit.* The evidence lives in comments on
earlier SHAs; the failing status belongs to a previous head; only the sticky
comment carries the crossing forward. Six of the seven findings are that record
being lost, mis-parsed, or overwritten — none of them are about the policy.

| # | P | The record fails because… | Consequence |
| --- | --- | --- | --- |
| F6 | P1 | sixteen other call sites write the sticky comment with a plain status body | any status transition erases the floor **and** the reply deadline |
| F7 | P1 | a failed sticky *read* still wrote this run's counts back | a recorded five-head floor is patched down to one visible head |
| F4 | P1 | a legacy record carries a count but no identities, and severity is keyed by identity | an already-crossed unit reads as minor and is forgiven |
| F2 | P1 | `ANY_BADGE` matched a P0 but `P1_BADGE` did not | the **most severe** findings classified as minor — fail-open at the worst moment |
| F5 | P2 | severity tracked "was a badge seen on this head", not "was every finding readable" | one badged comment vouched for an unbadged sibling |
| F3 | P1 | the record can be written but nothing re-reads it at the deadline | see below — **not fixed** |

F2 and F5 look like parsing bugs and are really the same thing: severity is read
from durable evidence spread across many comments, and both defects come from
summarising that evidence with a boolean instead of preserving what was actually
seen per head. The fix is one shape — keep the *lowest* severity and an
*unreadable* taint per head, decide at the end — and it closes both.

### What changed structurally

The point fixes are individually correct, but the reason six of them happened is
that nothing in the design said *"this is durable state with many writers."* Three
changes now say it:

1. **One writer preserves, rather than sixteen writers remembering.**
   `updateStickyComment` carries a prior metrics block forward when the incoming
   body has none. The fifteen status-only call sites are unchanged and cannot
   erase the record — they never had to know it existed. `W13` exercises the
   writer behaviourally.
2. **Unreadable is a third state, never a synonym for absent.** An absent sticky
   comment is a legitimate fresh unit and passes; a *failed read* blocks
   (`floorUnreadable`) and, since `68ee783`, writes no metrics block at all, so
   the carry-forward preserves what it could not read. `W8` and `W14`.
3. **Every fail-open default inverted.** Non-critical only when every head is
   *provably* minor; unclassifiable heads counted as unknown; unknown takes the
   longest window rather than the shortest. `W7`, `W9`, `W11`, `W12`.

### One more, found by this audit

Writing the table above sent me back through the record a human actually reads,
and both `reason` strings were wrong — same family, not a new one:

- the waiting reason interpolated `${window}` inside a **single-quoted** string,
  publishing the literal characters;
- the proceeding reason used the raw `declarationWindowMinutes` *parameter*,
  which is `null` unless a caller overrides it — so the durable justification for
  having proceeded without a human read *"within null minutes"*.

Neither changes a decision. Both are the only account a human gets of why the
loop did what it did, on the one path where it acts without them. Fixed, pinned
by `W15`, and discriminated (reverting the fix fails `W15` alone).

## Not fixed, and it needs an owner decision — F3

> `auto-merge.yml` triggers on `workflow_run` and `workflow_dispatch` only. There
> is **no schedule**, so nothing re-runs at the deadline and an unanswered unit
> sits until somebody pushes. **The window as built cannot expire on its own.**

The expiry *logic* is implemented and tested (`W5` proves an expired window
proceeds with `autonomous: true` recorded). What is missing is anything to wake
the component at the deadline. So today the owner's rule — *"if the human doesn't
reply in the given time frame, proceed as you see fit"* — degrades to "proceed at
the next push", which for an idle pull request is never.

Codex is right that this leaves the loop able to block on a human. I am not
fixing it inside this unit because the repair is a `schedule:` cron on the merge
orchestrator, and that changes **how often the component that merges pull
requests wakes up** — from event-driven only to every N minutes, on every open
pull request. On a 3-hour window, ~30-minute granularity gives ~10% accuracy.
That is a standing behavioural change to the merge path, so it is asked rather
than assumed.

Three options, for the owner:

| | Option | Cost |
| --- | --- | --- |
| 1 | `schedule: */30` on `auto-merge.yml`, guarded to do nothing unless a window is live | the merge orchestrator wakes 48×/day; the rule works as stated |
| 2 | the existing hourly handoff cron dispatches the merge workflow when it sees a live window | no new trigger on the merge path; expiry accurate to ~1 hour |
| 3 | leave it | the window is documentation, not a mechanism; a critical unit blocks until a human answers or a push happens |

**Recommendation: option 2.** The hourly cron already exists and already reads
open `claude/**` pull requests, so the accuracy is adequate for a 3-hour window
and the merge component's trigger surface is unchanged — which is the part worth
being conservative about.

Until one is chosen, the honest description of what ships is: *the loop asks a
human when a unit crosses five heads while still drawing P1s, and will proceed
autonomously once the window expires **the next time the workflow runs.*** The
`W5` probe proves the second clause; nothing proves it happens unprompted,
because it does not.

## Scope

| | |
| --- | --- |
| Base SHA | `12fd37c` (`main`) |
| Concern | one: making the merged five-head rule actually govern the loop |
| Migrations | none |
| Product surface | none — `scripts/`, `.github/`, `docs/` |
| Changed lines | 677 + this head, against `12fd37c` — six script files and this audit |

## Verification

| Gate | Result |
| --- | --- |
| `scripts/review-lifecycle-enforcement.test.mjs` | **15/15** |
| `scripts/review-lifecycle.test.mjs` | 20/20 |
| `pnpm test:automation` | **196/196** |
| `pnpm check` | **EXIT 0** |

### Discrimination — each mechanism reverted in turn

| Reverted to the defect | Probe that failed |
| --- | --- |
| lifecycle enforcer dropped from the promotion path (F1) | `W10` |
| `P1_BADGE` severity matching, so P0 reads as minor (F2) | `W9` |
| per-head "any badge seen" instead of the unreadable taint (F5) | `W12` |
| `criticalHeads` from live identities only (F4) | `W11` |
| `updateStickyComment` overwrites without carry-forward (F6) | `W13` |
| the `floorUnreadable` path writes its metrics block (F7) | `W14` |
| the reason strings' window interpolation | `W15` |
| — restored — | **15/15** |

`W1` covers the original defect — the rule existing but being called by nothing —
and fails if the enforcer is ever dropped from the final policy chain again.
