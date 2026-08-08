# PR #300 convergence audit — 7B-ii-b, and the difference between a moment and a state

Three finding-bearing heads (`79bbd66`, `01e577f`, `102252d`). **Eleven findings**, one P1, no P0s,
across four roots: one recurrence this phase has now named five times, and three new ones — all
three of which are about *me being confident in writing*.

The third round is the one that changes the reading. Its four findings were not new ground: **three
of them were defects in, or one step beside, the fixes I had just shipped.** A correction that is
locally right and globally incomplete is the through-line of this PR, and §"Root F" below is the
attempt to say why.

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

## What carries forward

1. **A fixture you type out encodes your belief; a fixture you derive encodes the contract.** Prefer
   the second wherever a type exists to derive from. (Root D, and the answer to F1.)
2. **"Has it happened" and "is it true" are different questions.** When the answer to the first is
   used as a proxy for the second, it goes stale the moment the state moves. (Root E.)
3. **Getting a hazard right in one place is not internalising it.** G3 sat one function from the
   token that exists for the same hazard.
4. **Check that a verification command verifies.** `tsc -p` on a solution file exits 0 having read
   nothing; so does a grep with no positive twin. Both were on this PR.
5. **Root A is not subtle and will recur again.** Its only reliable defence is a single source, not
   vigilance.
6. **When you write a principle down, enumerate its instances before moving on.** Both root-F
   findings had exactly two instances and I fixed one of each. (Root F.)
7. **A fix is a new opportunity for the same class of bug.** Three of round three's four findings
   were in or beside round two's fixes: an incomplete condition, an over-corrected preference, and a
   principle applied once. Re-read a correction as if someone else wrote it.
