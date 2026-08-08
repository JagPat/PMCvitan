# PR #300 convergence audit — 7B-ii-b, and the difference between a moment and a state

Four finding-bearing heads (`79bbd66`, `01e577f`, `102252d`, `6d7f546`). **Fourteen findings**, one
P1, no P0s, across six roots: one recurrence this phase has now named five times, and five new ones
— most of which are about *me being confident in writing*.

The third round is the one that changes the reading. Its four findings were not new ground: **three
of them were defects in, or one step beside, the fixes I had just shipped.** A correction that is
locally right and globally incomplete is the through-line of this PR, and §"Root F" below is the
attempt to say why.

The fourth round is the one that changes the *response*. Rounds two and three each patched a branch;
round four's I3 was the **third** finding on this PR of one shape — a state falling through every
guard and rendering an empty panel — and a third patch would have been the wrong move for a reason
the first two rounds prove. So the shape is closed structurally instead (§"Root H"), and the same
decision is applied to all three resources on the screen rather than the one the finding named. The
untouched third instance — the money bundle, on the tab this hub *opens* on — was found by counting
instances rather than by review, which is the first time on this PR that the carry-forward list paid
for itself before a reviewer did.

## Every finding, in one table

| # | Head | P | Finding |
|---|---|---|---|
| F1 | `79bbd66` | P1 | `GET /commercial/bills` returns the wrapper `VendorBillListDto`; the gateway typed it as a bare array, so the store held an object the screen maps over |
| F2 | `79bbd66` | P2 | A failed refresh over a loaded claim warned on Certification only — not on Payments, where `approvable` lives |
| F3 | `79bbd66` | P2 | A project switch left `selectedBillId` pointing at another site's claim; the guard then rendered "Loading the claim…" forever, with nothing loading and no Retry |
| F4 | `79bbd66` | P2 | The Claims row rendered the list's `status` while the tabs rendered the claim's — one workflow, two answers |
| G1 | `01e577f` | P2 | A scope reset under an open Claims tab left the panel rendering **nothing** — no rows, no loading, no error, no empty state |
| G2 | `01e577f` | P2 | The realtime ping never refreshed an already-open claim list, so a claim another user recorded stayed invisible until a page reload |
| G3 | `01e577f` | P2 | The ping refreshed only claims with an *arrived* lifecycle, so one whose first read was in flight missed the invalidation and landed stale as `ready` |
| H1 | `102252d` | P2 | A cached claim list whose refresh **failed** rendered "No vendor claim has been recorded yet" with no warning and no retry |
| H2 | `102252d` | P2 | The whole claim workflow sat inside `{commercial && …}`, so a failed money-position read hid tabs whose own reads were fine |
| H3 | `102252d` | P2 | G1's effect omitted `capabilities` — on the real switch path it fired once into a capability-gated no-op and never again, leaving the blank panel G1 was meant to fix |
| H4 | `102252d` | P2 | F4's fix preferred the claim bundle *always*, so a **stale** claim overrode a freshly refreshed list row — the mirror of the bug it fixed |
| I1 | `6d7f546` | P2 | The page-level Refresh drove the money bundle only, so on a claim tab it re-read nothing that was on screen and left the open claim as stale as it found it |
| I2 | `6d7f546` | P2 | A refresh over a cached claim held its status at `ready`, so a lifecycle carried over from an earlier visit was indistinguishable from one a completed read had just confirmed |
| I3 | `6d7f546` | P2 | After a shell failure the list is `idle` with the capability absent, so no branch matched and the Claims panel rendered an **empty div** — no explanation, no retry |

## Root A (recurrence) — one fact in two places, allowed to drift

**F2 and F4.** Staleness was implemented per-tab when it is a property of the *claim*; bill status
was read from the list on one surface and from the claim bundle on another.

This is `pr-297-convergence.md`'s root A in its fifth appearance this phase, and the closure is the
same one that keeps working: **make one thing the source.** The stale banner is hoisted into a
`claimPanel` wrapper every claim tab renders through, so it cannot be present on one tab and absent
on another. The selected row reads `claim.bill` when a claim is loaded, so the freshest read wins
for the row it describes.

Nothing new to learn here — which is itself worth stating. This root does not recur because it is
subtle. It recurs because writing the same fact twice is *locally* the shortest path every time.

## Root D (new) — a test written from the same misunderstanding as the code confirms it

**F1 and F3**, and this is the one I would keep if I could keep only one.

- **F1**: I typed the gateway as `VendorBillDto[]`. I then wrote the store test's mock as
  `mockResolvedValue([...])` — a bare array. The mock and the bug came from one misunderstanding,
  written minutes apart, so the test agreed with my error instead of with the server. It passed. The
  Claims tab would have thrown on first contact with the real API.
- **F3**: fixing the first head's crash, I decided a permanent "Loading the claim…" was an
  acceptable end state, and then wrote a render probe that **asserted that state as correct**. Codex
  read it as what it is: a stuck tab with nothing loading and no Retry.

The shape: *a test authored by the same person, at the same time, from the same belief, cannot
falsify that belief.* Reproduce-first does not help — both probes were written before their fixes
and both went red-then-green. The belief was upstream of the probe.

The closure is to **derive the fixture from the contract instead of typing it out**. Both gateway
stubs are now `Partial<ApiGateway>` with `vi.fn<ApiGateway['method']>()`, so the compiler refuses a
stub promising a shape the gateway never returns — mutation-tested by reverting the gateway and
watching `tsc -b` name the gateway, the store destructure, **and the mock itself**. Where a fixture
cannot be derived (F3's "what should this state look like?"), nothing mechanical helps, and the
honest record is that an independent reader caught it.

A related process defect belongs here rather than in its own section: on the first head I repeatedly
ran `npx tsc --noEmit -p tsconfig.json` in `apps/web` and reported it clean. That file is a solution
config with `files: []` — **the command checked nothing.** Only `pnpm check` (`tsc -b`) was ever a
real gate. Same shape one floor down: I believed I had verified something, and the thing I used to
verify it was chosen by the same belief.

## Root E (new) — a one-shot trigger standing in for a continuing condition

**G1, G2 and G3.** All three are places where I asked *"has this happened?"* when the question was
*"is this true now?"*

| Site | What I wrote | What it stood for | When it stopped tracking |
|---|---|---|---|
| G1 | load the list on the tab **click**, if `idle` | "the user is looking at the list" | a scope reset while the tab is already open — no click follows |
| G2 | never refresh the list on a ping | "nobody has opened the list" | the moment someone opens it |
| G3 | refresh the claims in `commercialClaims` | "the claims the user has open" | a claim whose first read is still in flight has no key yet |

I wrote a confident justification for each. G2's is quotable: *"a ping is not evidence anyone is
looking at it."* That sentence is true before the tab is opened and false forever after, and I wrote
it as though it were timeless.

The closure is to **express the condition, not the event**. G1's click handler is deleted, not
supplemented — a second trigger beside the first would leave the same gap for the next state change
— and replaced by an effect on `inClaimWorkflow && billsLoad === 'idle'`, which re-fires whenever
that becomes true again, whatever made it true. G2 tests `commercialBillsLoad !== 'idle'`, which
*means* "this scope has fetched the list". G3 keys on the union of `commercialClaims` and
`commercialClaimLoad` — **intent, not results**.

G3 deserves one more sentence, because it is the sharpest self-indictment in the set. The per-claim
load token exists *precisely* because I reasoned about in-flight reads: an older response must not
overwrite a newer one. I got that right, wrote it up, and then — one function away, in the same
change — keyed the refresh set on results rather than intent, so the in-flight case I had just
finished thinking about was the one I missed. Getting a hazard right once in one place is not the
same as having internalised it.

## Root F (new) — stating a principle is not applying it

**H1 and H2**, and both are quotable against me because I wrote the principle down *in this PR* and
then applied it to exactly the case in front of me.

- **H1.** Round two's commit message says: *"Staleness is a property of the CLAIM, not of one tab, so
  the banner is hoisted and every panel renders through it."* Correct — and the claim LIST, which has
  the identical stale-while-revalidate shape one component over, got no banner at all. An open Claims
  tab could render "No vendor claim has been recorded yet" after a failed refresh: not a stale
  number, a **false statement about the world**, with no indication and no retry.
- **H2.** The PR body argues at length that the claim workflow is independent of the money position —
  *"nothing in it is derived from the money position, so a shared snapshot would buy no consistency"*
  — and I proved it in the **loader** while rendering every tab inside `{commercial && …}`. So a
  failed `/commercial/money-position` hid the entire claim workflow behind a headroom retry. The
  independence was real one layer down and absent one layer up.

The shape: *a principle articulated while fixing one instance gets applied to that instance only.*
Writing it down feels like generalising. It is not; it is narrating.

The defence is cheap and I did not do it: **when you state a principle, enumerate what it covers
before you move on.** "Staleness belongs to the thing, not the tab" has two instances on this screen
— claim and list. "This workflow is independent of that one" has two layers — load and render. Both
lists are two items long and both took thirty seconds to write once asked.

## Root E, second appearance — and both of round three's other findings

**H3 and H4** are root E again, which is why it gets no new letter.

- **H3.** Round two's fix replaced a one-shot trigger with a condition — the right move — and the
  condition was **incomplete**. `loadCommercialBills()` is itself capability-gated, and a project
  switch resets capabilities and the list *together*: the effect fired once into a no-op, and when
  the shell later reported the new project's capability, neither watched dependency had changed. The
  blank panel G1 existed to remove came straight back. Expressing a condition instead of an event is
  half the work; the condition also has to name every term it depends on.
- **H4.** F4 fixed "the row is older than the claim" by preferring the claim **always** — so after a
  successful list refresh and a failed claim refresh, the claim is the older of the two and overrode
  a fresher row. "Has a claim" was standing in for "the claim is fresher": a proxy for the real
  condition, which is root E's exact definition.

And one more instance of **root D**, caught during this round's own RED verification rather than by
review: the first H3 probe used a stub that resolved unconditionally, so it counted a call the real
capability-gated loader would have no-opped — and passed with the bug in place. The stub now records
the capability state at call time. Third time on this PR that a stub which did not model the thing it
stood for agreed with the defect.

## Root E, fourth appearance — and the point at which narrowing a proxy stops being a fix

**I2**, and it is the same predicate for the third time.

F4 asked "which of the list row and the claim bundle is fresher?" and answered **"whichever has a
claim"**. H4 said that was too broad and narrowed it to **"whichever has a claim that did not
error"**. I2 shows the narrowing still wrong: during a joint refresh the list can come back first
with `paid` while the claim bundle held from an earlier visit still reads `certified` and has not
errored at all — so the row goes on stating a lifecycle the list has already superseded, on the
screen where someone authorises payment.

Three answers to one question, each a property of the *reads* standing in for a property of *time*.
The fix is not a fourth narrowing. The store now records **when each of the two reads last
succeeded**, on one monotonic counter shared by both, and the row compares two facts. Nothing is
inferred from an error, from a status, or from a bundle merely existing.

The second half of I2 is the same root in the status field. `loadCommercialClaim` held the status at
`ready` through a refresh, which was stale-while-revalidate implemented one field too far left: the
guard bought nothing (every consumer already gates blanking on the **value**) and cost the only
signal that says a read is in flight. **The status says what the read is doing; the value says what
we have.** Both now do exactly one job, and all three commercial loaders were changed together
rather than the one the finding named.

And a note that belongs under root D as much as here: the probe covering that behaviour **asserted
the defect**. `expect(s().commercialLoad, 'a refresh blanked the money already on screen').toBe(
'ready')` was written from the belief that produced the code, so it did not merely fail to catch the
bug — it pinned it, and any future correction would have had to argue with a green test. Fourth time
on this PR that a test written beside the code agreed with it.

## Root G (new) — adding a second thing does not update the code that speaks for "everything"

**I1.** The page-level Refresh was written when this hub had money tabs only. 7B-ii added a whole
second workflow beside them — its own tabs, its own loaders, its own scope teardown, its own realtime
invalidation, all wired — and never revisited the one control whose job is *"re-read what I am
looking at"*. So Refresh on the Payments tab re-read the money position and left the open claim
untouched.

This is the exact inverse of `pr-297-convergence.md`'s root B (*becoming a new consumer of something
is the signal to re-check its declaration*): **becoming a new sibling of something is the signal to
re-check what the code that serves "all of it" actually covers.** It is also 7B-i round 1's shape one
floor down — there the new hub was added to some of the places the other hubs live; here the new
workflow was added to some of the places the money tabs live.

The fix names the tab's own resources, and takes the opportunity to retire a second proxy in the same
function: the gate was `capabilitiesKnown`, standing in for "the loader will do something", when the
loaders gate on `capabilities.includes('commercial')`. Known-but-not-yet-reporting is precisely the
state where they are inert — so the old Refresh was a dead button exactly when it was needed. Naming
the loader's own condition is H3's lesson, applied to a different caller.

## Root H (new) — a set of guards enumerates the states you thought of

**I3**, and it is the third instance on this PR: **G1** (a scope reset under an open tab), **H3** (a
capability-gated loader no-opping), **I3** (a shell failure leaving the list `idle` off-pilot). Three
different causes, one outcome — a state matched no `&&` guard, `(bills ?? []).map` over `null`
rendered nothing, and the panel was blank with no explanation and no way out.

The first two were patched with better conditions, and both patches were correct. The third proves
that patching is the wrong response, because the defect is not in any one condition: independent
guards **enumerate the states someone thought of**, and there is no place in that shape for the state
nobody thought of. A fourth branch would fix I3 and leave the shape intact for I4.

So the decision is made once, over the whole space, in one total function:

```
viewOf(value, status, willLoad) → { show: 'content', value, stale, refreshing } | { show: 'loading' } | { show: 'unavailable' }
```

Three things make it a closure rather than a tidier spelling. It is a **discriminated union**, so the
callers `switch` and TypeScript's exhaustiveness check enforces coverage instead of memory. It takes
**`willLoad`** — the term I3 turns on and the one a status cannot supply, since `idle` is hopeful when
something is about to fetch and dead when nothing is — and each caller passes the same condition its
own loader gates on. And it separates **value** from **status**, which is where root E's second half
lands: the value decides whether there is something to show, the status decides what to say about it.

Two consequences worth stating because neither was in the finding:

- The claim's `claimPanel` wrapper and `claimGuard` fallback are now **one** function. Two functions
  that are only correct when used together are one function written twice, and the pairing —
  `{claim ? claimPanel(…) : claimGuard()}`, spelled out at three call sites — is what let a state
  fall between them. The panel now takes what to render *with* a claim and decides every other case
  itself, so no call site can get the pairing wrong.
- **The money bundle had the same hole**, and no finding named it. `reading = (idle || loading) &&
  !commercial` renders "Loading the money position…" forever when a capability-gated
  `loadCommercial()` will never fetch — the permanent spinner of F3, on the tab this hub opens on. It
  was found by doing what carry-forward #6 says to do: count the instances before moving on. There
  were three. All three now decide the same way.

## What carries forward

1. **A fixture you type out encodes your belief; a fixture you derive encodes the contract.** Prefer
   the second wherever a type exists to derive from. (Root D, and the answer to F1.)
2. **"Has it happened" and "is it true" are different questions.** When the answer to the first is
   used as a proxy for the second, it goes stale the moment the state moves. (Root E.)
3. **Getting a hazard right in one place is not internalising it.** G3 sat one function from the
   token that exists for the same hazard.
4. **Check that a verification command verifies.** `tsc -p` on a solution file exits 0 having read
   nothing; so does a grep with no positive twin. Both were on this PR — and so, a third time, was
   the `Review-Convergence: complete` trailer on the round-4 head: the line was *present* and the
   gate still rejected it, because a blank line above `Co-Authored-By` split the message into two
   paragraphs and git parses only the last. Earlier heads on this PR were checked with
   `git interpret-trailers --parse`; this one was checked by looking at it. **Present is not
   parsed**, and the difference is one command.
5. **Root A is not subtle and will recur again.** Its only reliable defence is a single source, not
   vigilance.
6. **When you write a principle down, enumerate its instances before moving on.** Both root-F
   findings had exactly two instances and I fixed one of each. (Root F.)
7. **A fix is a new opportunity for the same class of bug.** Three of round three's four findings
   were in or beside round two's fixes: an incomplete condition, an over-corrected preference, and a
   principle applied once. Re-read a correction as if someone else wrote it.
8. **The third instance of a shape is a design signal, not a third patch.** Two corrections to a
   condition are ordinary; a third means the defect is in the shape, and the fix is to make the
   property structural — a total function with an exhaustive `switch`, not another branch. (Root H.)
9. **Narrowing a proxy is not replacing it.** F4 → H4 → I2 were three answers to *"which read is
   newer?"*, each derived from something that is not time. If a question has a fact that can be
   recorded, record it; a heuristic that has been narrowed twice is telling you it was the wrong
   kind of answer. (Root E.)
10. **Status and value answer different questions.** "What is the read doing" and "what do we hold"
    must never be collapsed into one field to serve one screen's convenience — the collapse always
    costs the signal someone needed on the screen where it matters most.
11. **Adding a sibling is the signal to re-check whatever speaks for "everything".** A new tab, a new
    resource, a new workflow inherits the wiring you remember to give it; the controls written before
    it — a Refresh, a teardown, an invalidation — have to be re-read against the new list. (Root G;
    the inverse of pr-297's root B.)
