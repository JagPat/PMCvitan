# PR #300 convergence audit — 7B-ii-b, and the difference between a moment and a state

Two finding-bearing heads (`79bbd66`, `01e577f`) trigger the convergence rule. Seven findings, one
P1, no P0s. They fall into three roots: one recurrence this phase has now named five times, and two
new ones — both of which are about *me being confident in writing*.

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
