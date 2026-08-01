# Convergence audit — PR #264 (wiring the five-head restructure rule)

Required by `CLAUDE.md` after two distinct finding-bearing heads. This is an
architectural audit of all twenty-eight findings together, not a series of isolated
patches. Round 3 matters most: it is the audit's own root cause, reproduced by
the fix written for it.

| Head | Findings |
| --- | --- |
| `ccbdee3` | 6 — F1 (P1), F2 (P1), F3 (P1), F4 (P1), F5 (P2), F6 (P1) |
| `77117e4` | 1 — F7 (P1) |
| `e2941ab` | 4 — R1 (P1), R2 (P1), R3 (P1), R4 (P2) |
| `0a7589a` | 4 — two already in progress (F3, the unclassifiable status), two new (P2, P2) |
| `ad290cc` | 3 — all P2, all durable-record handling |
| `1c6cdaa` | 3 — all P2; one a direct miss against the owner's stated design |
| `af81b9b` | 1 — P2, write ordering |
| `442759b` | 2 — **one P1**, caused by the previous round's fix |
| `651c58f` | 2 — **one P1**; the owner chose RESTRUCTURE over a fifth patch |
| `81ce79e` | 2 — **one P1**; the restructure modelled one of two request endings |

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
| F3 | P1 | the record can be written but nothing re-reads it at the deadline | **fixed in round 4** — the `*/15` fallback sweep |

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

### The one the audit found that mattered — a fabricated human approval

Checking the claim *"a human answers by adding a marker to the PR body"* rather
than restating it turned up the worst defect this unit had.

The request comment tells a human to use an exact marker. The answer was read
from the **PR body**. So any prose *explaining how to answer contained an
answer* — and the first draft of this pull request's own description documented
the mechanism, which would have declared `continue` on its own behalf.

```
restructureDeclaration('A human answers by adding <!-- review-restructure:
  continue --> to the body.')            ->  'continue'
```

That is a **fabricated human approval**, in a repository whose standing rule is
that human approvals stay attributable. And the framing was wrong beneath the
bug: the PR body is written by Claude, so a decision read out of it is the loop
approving itself, quoting hazard or not. It is not a weak channel — it is not a
human channel at all.

Fixed structurally, three independent mechanisms, each discriminated:

| Mechanism | Closes |
| --- | --- |
| the answer is read from a **comment**, never the body | the loop cannot author its own approval |
| the author must be a non-bot with `OWNER`/`MEMBER`/`COLLABORATOR` association | the asker cannot answer itself; nor can a passer-by |
| markers inside code spans and fences are being *shown*, not used | documenting the mechanism is not invoking it |

`W16` covers all four cases plus the positive control (a real maintainer comment
still works — the gate is closed, not welded shut); `W17` pins latest-answer-wins
so a maintainer can change their mind by posting again rather than editing
history. `declaredBy` now records **who** decided, which is what "attributable"
requires and what the previous version could not have reported.

Worth noting how this survived: the declaration path had **no coverage in the
policy model's own 20 tests**. `review-lifecycle.test.mjs` never exercised a
declaration at all, which is why swapping the entire channel broke nothing there.
The rule that governed nothing also tested nothing about the part a human touches.

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

## Round 3 — four findings on `e2941ab`, and I caused all four

Codex returned four findings on the head that fixed the attribution defect. They
are not a new root cause. **They are the audit's own root cause, reproduced by
the fix for it.**

The thesis above is: *the lifecycle record is durable state, and I treated it as
a return value.* I then added a **second** read of durable state — the maintainer
declaration — and gave it none of the properties the first read had been
corrected into having:

| # | P | The new read… | Same as |
| --- | --- | --- | --- |
| R1 | P1 | fails **open**: `catch { issueComments = [] }` made a transport error indistinguishable from silence, and silence is what expiry consumes | F7, one function earlier |
| R2 | P1 | reads only the **first 100 comments**, so a floor or a `restructure` past the page boundary reads as absent | new, and it applies to the sticky floor too |
| R3 | P1 | accepts a declaration of **any age**, so a marker written while discussing the mechanism answers a request that did not exist yet | new |
| R4 | P2 | the timeout path returns **before the only sticky write**, so the override claimed by the reason string was never recorded | F6, inverted |

R1 is the one worth dwelling on. I had already written, twelve lines above the
defect, that a failed sticky read must not be mistaken for "no record" — and then
wrote `catch { issueComments = [] }` for the new read in the same function. The
lesson was on the screen. Applying it to the case in front of me is a different
act from having learned it, and this is the second time in this unit that gap has
produced a finding (the first was F1, wiring the rule into one call site after
writing that a rule nothing consults governs nothing).

R4 is a truthfulness defect, not only a missing write: the reason string asserted
*"records that it did"* about a record that did not exist. A claim to have
recorded something is worth less than nothing when it **is** the only record.

### The fixes

- **R2** — `issueComments` pages to exhaustion. A failed page **throws** rather
  than returning a short list, so the caller can distinguish "read everything"
  from "read some of it" — which is exactly what R1's fix depends on. Past a
  2000-comment bound it throws too: returning what it has would be the same
  silent truncation. `W21`.
- **R1** — a failed read sets `declarationsUnreadable`, and the model blocks on it
  with its own reason, next to the `floorUnreadable` branch it should have
  matched from the start. `W18`.
- **R3** — a declaration must postdate the recorded `declarationRequestedAt`.
  Before any request exists, nothing can answer it. An **edit** counts (a
  maintainer may answer by editing), so the comparison uses the later of
  `created_at`/`updated_at`; an undated comment cannot be shown to postdate
  anything and does not count. `W19`.
- **R4** — the autonomous override writes a durable `lifecycle_autonomous` record
  carrying `autonomousAt` and the tier, stamped once, before returning. `W20`.

Each reverted alone fails its own probe and no other.

### A bookkeeping miss the hourly shepherd caught, not me

`docs/STATUS.md` still recorded `open_pr: 263` after #263 merged and this unit
opened. `CLAUDE.md` requires `open_pr` to move in the **same change** that opens
the pull request; I did not do it, so the runner's recorded work item named a
merged PR while the live one went untracked. `task_state: in_review` was already
correct. Corrected, and verified with the runner's own parser rather than by
reading the file — `assessRunnerState(parseStatusNow(STATUS))` now returns
`nextStep: "pr:264"`, the exact next step the shepherd asked for.

It belongs in this audit because the PR description carries a checkbox asserting
that the packet and STATUS state are truthful, and while `open_pr` named a merged
PR that assertion was false — ticked by me. The repair is to correct the record,
not to let the checkbox cover for it.

### An observation on the convergence protocol itself

That STATUS fix is what produced this head. `hasPacket` is computed from
`changedFiles` — deliberately scoped to *this head's commit* — so **every** head
past the threshold must carry the audit, including a one-line bookkeeping commit
that has nothing to audit. This head exists because the previous one touched only
`docs/STATUS.md`.

I do not think that is wrong, and I am not proposing a change: the rule keeps the
audit current with the head under review, which is the whole point of pinning
review evidence to an exact SHA. It is worth recording as a known cost — routine
follow-ups inside a converged unit are not free, so they are worth batching. The
alternative (judging the packet on the cumulative diff) would let the audit go
stale while the head moves, which is the failure this protocol exists to prevent.

## Round 4 — F3 is now FIXED, on the owner's design

The owner rejected my recommendation, and was right to. I had proposed an hourly
cron and framed the choice as "how often should the merge component wake". That
framing was wrong: **this loop is event-driven, and a timer must never be the
driver.** Waiting for a tick to do work an event already announced is pure idle
time — something finishes, and the loop sits until the next tick.

The correct shape, which is what ships:

> Events drive everything and react immediately. The timer is a **fallback for
> the silent case only** — and expiry is exactly that case, because a deadline
> passing is *defined* by nobody doing anything, so there is no event to fire.
> Fifteen minutes, because noticing a 3-hour deadline an hour late wastes most
> of a fourth hour.

`schedule: */15` on `auto-merge.yml` runs `window-sweep`, which:

- reads one pull-request list plus one sticky comment per open `claude/**` unit,
  and **writes nothing** unless a window has actually run out (`W22`);
- **decides nothing itself** — it re-dispatches the ordinary gate on the same
  head, so the exact-head gate remains the only authority and still fails closed
  (`W23`, `W26`);
- **terminates**, because R4's `autonomousAt` record marks the window spent, so a
  woken unit is never re-woken (`W23`);
- **reports** a unit whose record it could not read, rather than passing over it
  silently — "found nothing" and "could not look" are different facts (`W25`).

`declarationWindowMinutes` is now recorded beside the request stamp, so the sweep
answers "has this run out?" from the sticky comment alone — no review re-read, no
severity recomputation, on every open unit every fifteen minutes.

**One thing this exposed that the owner's design surfaced and mine would not
have:** the lifecycle block wrote its status as `lifecycle: …`, outside the
`review:` vocabulary that `isTerminalReviewStatus` recognises. So the block was
never classified as terminal at all — the state machine could neither see it nor
resume from it, and the sweep would have had nothing to act on even with a
perfect timer. It is now `review: lifecycle — …` and resumable, because
**resuming is not approving**: a dispatch only makes the gate run again, and the
gate re-decides from the record, so an unexpired window blocks a second time
(`W24`). Codex independently reported this same defect on `0a7589a`.

## Round 4 findings — two already fixed, two new

Codex reviewed `0a7589a` (the head before the sweep) and returned four. Two were
the work already in progress: the missing wake-up (F3 itself) and the
unclassifiable lifecycle status above. Two were new and real:

- **Sticky writer pagination (P2).** I paginated `stickyComment` and
  `issueComments` and left `updateStickyComment` reading one page. That is worse
  than paginating neither: past a hundred comments the writer would not find the
  sticky it means to patch, POST a second one, and every lifecycle read — which
  *does* page — would keep returning the original. The floor and the deadline
  would be written to a comment nothing reads. `W28`.
- **Review containers counted as unreadable findings (P2 as rated — worse in
  practice).** Every Codex review is posted as a wrapper whose body carries no
  badge, with the findings as inline comments. Counting the wrapper as an
  unreadable finding tainted **every reviewed head** as unknown, so a unit
  carrying nothing but P2s would still stop and ask a human. That is the owner's
  critical-only rule defeated in the **normal** case, not an edge case. My
  probes missed it because every one of them passed `reviews: []`; `W27` uses the
  real container shape, including the end-to-end five-P2-heads case.

## Round 6 — the timer was doing a job the event should have done

Three more P2s. The one that matters is a **direct miss against the owner's own
instruction**, and it is worth stating plainly because I had the design in
writing and implemented only half of it.

The owner's words were: *events should trigger the reaction… it is a fallback way,
so if there is no activity happening, then you trigger the manual scan.* I built
the fallback scan and never wired the event. So a maintainer who answered
`continue` two minutes after being asked would still have watched the unit sit
draft for the remaining 178 minutes — **the timer behaving as the driver, which
is exactly what the instruction ruled out.** `issue_comment` now wakes the gate
the moment an answer is posted; the sweep remains the fallback for when that
event never arrives.

That is the third time in this unit I have written a principle down and then
under-applied it (F1 wired one of two call sites; R1 fail-open one function after
the fail-closed rule). The habit is real: **I stop at the first correct instance
rather than enumerating every place the principle applies.**

The other two:

- **The sticky picker took the first match.** `find()` over an ascending list
  returns the STALE original when the earlier one-page writer bug left a second,
  record-bearing comment behind. A five-head crossing then reads as absent. The
  newest record-bearing sticky now wins for BOTH the reader and the writer, which
  also consolidates a duplicated pair instead of forking it further (`W32`).
- **The sweep woke only on expiry.** A `floorUnreadable` block — a transient API
  failure — had no autonomous recovery at all: one CI event failed and the unit
  sat until a push. The status vocabulary now distinguishes three kinds of
  lifecycle block (wait, unreadable, declared restructure) and the sweep wakes the
  first two while never touching the third (`W33`).

**`W26` broke on a legitimate edit** — it matched `if: github.event_name ==
'schedule'` verbatim and the second trigger made the condition multi-line. That is
the fifth position-coupled pin in this workstream to fail on a change that did not
touch its subject. Re-anchored on the signals the condition must carry, not its
text.

## Round 7 — one P2, and the write order was backwards

The failing status was published BEFORE the record it depends on. A transient
sticky-write failure therefore left a head marked "waiting" carrying no
`declarationRequestedAt` — no window to expire, no request for an answer to
postdate — so nothing in the sweep could ever find it actionable and the unit
sat draft until somebody pushed. The stall the sweep exists to prevent,
reintroduced through the ordering of two adjacent writes.

Two changes, both discriminated by `W34`:

- **The record is written first.** The sweep reads it to decide whether a blocked
  unit is actionable, so it must exist before the block that needs it. Now the
  most a sticky failure can cost is the status, and a head with no status is
  picked up by the ordinary path on the next event.
- **The sweep self-heals a head already in that shape.** A published wait with no
  recorded request is an *incomplete* record, not a patient one; it is woken so
  the gate can write what is missing.

This closes the last shape in a family the whole unit has been circling: **the
durable record and the thing that depends on it must be written in dependency
order, and every state that can be reached must have a path out.** Rounds 4–7
have each found one more corner of it — an unwritten override, an unread window,
a stale duplicate, and now a record written too late.

## Round 8 — a P1, and the previous round caused it

**Round 7's fix produced round 8's P1.** That is the signature I abandoned #263
over, so it deserves to be stated first and plainly rather than buried under the
correction.

Round 7 found: the status was published before the record, so a sticky-write
failure left a block the sweep could not act on. I fixed it **twice** — reordered
the writes, *and* taught the sweep to self-heal a block whose record is missing.
The second fix alone was sufficient. The first only **moved** the failure: a throw
now left the earlier `pending` status as the latest, and the sweep only wakes
retryable *terminal* statuses, so the unit sat exactly as before, one layer deeper.

So the correction is a **subtraction**: revert the reordering, keep the
self-healing. The block is published first — because the sweep knows how to
recover a block whose record is missing — and the record write is best-effort,
reported rather than thrown. Losing the record costs one sweep cycle; losing the
block costs the unit.

The second finding is the same over-reach seen from the other side: the
self-healing keyed on *"no lifecycle metrics"*, which is equally true of an
ordinary `review: Codex review timed out after two attempts`. Unscoped, the sweep
re-ran the whole review loop every fifteen minutes while Codex was unhealthy —
**overriding a two-attempt safety cap it has no business touching.** Now scoped to
lifecycle waits (`W35`), which narrows the false positive without losing the fix.

### What this round says about the unit

Both findings come from one habit, and it is not the same habit as rounds 1–6.
Those were *under*-application — a principle stated and applied in one place.
This round is **over**-application: fixing a problem twice, where the second fix
creates a new failure mode the first already covered. The two are opposite
errors with the same cause — not checking whether the fix I already have is
sufficient before adding another.

The remedy that generalises: **when a fix has two candidate mechanisms, ship the
one that makes the bad state recoverable, not the one that tries to prevent it.**
Prevention has to enumerate every path; recovery only has to recognise the state.

## Round 9 — the owner called RESTRUCTURE, and it ends the family

A second consecutive P1, and unlike round 8 the fixes would have been additive.
I stopped and asked; the owner chose to restructure the record rather than patch
a fourth instance. That was the right call and this section records why.

### The bug family, stated once

The durable record mixed **two lifetimes in one flat object**:

| Lifetime | Fields | Resets |
| --- | --- | --- |
| cumulative | `findingHeads`, `findingHeadIds`, `findingsPerHead`, `firstSeenAt` | never |
| request-scoped | `declarationRequestedAt`, `declarationWindowMinutes`, `autonomousAt`, `autonomousTier` | every new request |

Three writers each did `{ ...recordedMetrics, ... }`. Every one of them silently
carried request-scoped fields across request boundaries. That is not four bugs;
it is one shape found four times:

| Round | Instance |
| --- | --- |
| 5 | the recorded window was written and never read back |
| 7 | the record was written after the block that depends on it |
| 8 | reverting that left the permissive paths unguarded |
| 9 | a spent `autonomousAt` survived into a NEW window, so `expiredWindow` returned null forever and the unit sat on a wait nothing could end |

### What changed

**Request-scoped fields now live under one key**, `lifecycleRequest`. Opening a
request writes that object **whole**, so a field from the previous request cannot
survive into the next — the mistake is unrepresentable rather than something each
writer must remember. `W36`.

**`liveLifecycleRequest`** is the one accessor for *"what are we waiting on now"*.
A request carrying `autonomousAt` is spent, and its stamp and window no longer
govern the next one. This was the actual P1: I first fixed only the write side, and
`W36` caught that a fresh 360-minute window still came out expired because it was
measured from a stamp four hundred minutes old.

**One writer, `recordLifecycle`, and it never throws.** All three paths use it.
Round 8 guarded the blocking path; round 9 found the other two unguarded — the
same under-application caught one path at a time. `W38` exercises all three.

**Legacy flat records normalise on read.** A pull request mid-flight when this
ships carries the old shape; discarding it would drop a live window and re-ask a
human already asked. The flat copies are dropped on write so they cannot shadow
the nested one. `W37`.

### Two things the probes caught that I had wrong

`W14` caught a **real regression**: wrapping the write in `if (!floorUnreadable)`
skipped it entirely, so a unit with an unreadable floor stopped reporting why it
was blocked. Writing no *record* and writing *nothing* are different, and only one
is correct.

And after changing the shape I updated two of three readers, leaving
`requestedAt` on the flat field — the same under-application again. The fix was to
enumerate every reader with a grep rather than fix them as tests failed.

## Round 10 — the restructure modelled ONE of two endings

A third consecutive P1. The round-9 restructure was right and it closed the
family it targeted, but it defined how a request ENDS with a single stamp:

| Ending | Stamp | Modelled in round 9? |
| --- | --- | --- |
| the window ran out and the loop overrode it | `autonomousAt` | yes |
| **a maintainer answered it** | — | **no** |

So an answered request stayed live. The same comment kept postdating it, and on
the next correction head the gate re-read that one old `continue` and admitted
the head without a fresh decision. **One answer authorised unlimited future
critical heads** — the exact opposite of what asking a human is for.

`consumedAt` is now the second ending, and `liveLifecycleRequest` treats either
stamp as over. The next block opens a fresh request, so old evidence fails closed
on a new head while a new answer still works — the gate is closed, not welded
shut (`W39`).

The second finding is the round-8 P2 again, on the paths I did not scope: I
guarded `incomplete` and left `expired` and `answered` open, so an ordinary
`review: Codex review timed out after two attempts` could still be woken whenever
a lifecycle request happened to be recorded — re-running the review loop every
fifteen minutes and bypassing the two-attempt cap. **Scoping one of three reasons
was the same miss as scoping none.** The guard is now singular and above all of
them (`W40`).

### The pattern, now unmistakable

| Round | Shape |
| --- | --- |
| 1–7 | a principle stated, applied in ONE place |
| 8 | a problem fixed TWICE, the second fix creating a new failure |
| 9 | a shape restructured, with two of three readers updated |
| 10 | a lifetime modelled, with one of two endings covered |

Every one is the same error: **I stop at the first correct instance instead of
enumerating the complete set.** The remedy that has actually worked, twice now, is
mechanical — grep for every reader before changing a shape; list every way a
state can end before modelling one. Where I have done that, the fix has held.

## The original F3 record — superseded, kept for the reasoning

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
| `scripts/review-lifecycle-enforcement.test.mjs` | **40/40** |
| `scripts/review-lifecycle.test.mjs` | 20/20 |
| `pnpm test:automation` | **221/221** |
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
| the declaration read from the PR body | `W16` |
| bots and non-maintainers accepted as declarers | `W16` |
| markers in code spans treated as declarations | `W16` |
| — restored — | **17/17** |

`W1` covers the original defect — the rule existing but being called by nothing —
and fails if the enforcer is ever dropped from the final policy chain again.
