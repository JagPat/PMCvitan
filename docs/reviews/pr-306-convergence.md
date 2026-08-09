# PR #306 convergence audit — the pre-check that kept guessing

Four finding-bearing heads (`ee4edb1`, `b488260`, `5d20519`, …). **Twelve findings, all P2**, on a
unit whose product surface is two buttons and a form.

Not one is a wrong calculation. Every one is the same shape: **a client-side guard that
approximates a server rule instead of matching it, in front of a write-ahead outbox that has
already told the user "saved".**

## Every finding, in one table

| # | Round | Finding |
|---|---|---|
| 1 | 1 | Positive corrections were uncapped — the server treats one as another measurement and re-checks the same caps |
| 2 | 1 | The pending check was `(line, activity)` while the CAP is the line's, so a second activity queued against a remainder the first had claimed |
| 3 | 1 | The withdrawal floor ignored a live certificate's frozen `measurementConsumption` |
| 4 | 1 | A cached register whose LATEST refresh failed still authorised writes |
| 5 | 1 | The effort cap used `EFFORT(poLine)` — the line aggregate — while the server scopes effort to the ACTIVITY |
| 6 | 2 | Positive **corrections** were still absent from the pending-quantity map, so a queued +5 and a queued measurement of 5 both passed against one remaining 5 |
| 7 | 2 | Cached registers were never refreshed on the realtime `changed` path — the money bundle, the claim list and the claims all were |
| 8 | 2 | The certificate floor read only the SELECTED claim's certificate; the server refuses against any live one |
| 9 | 2 | **The Measurements tab sat inside `claimPanel`, so the advertised workflow's FIRST step required its LAST** |
| 10 | 3 | The cap RESERVATION was rebuilt from the live outbox on every read, so a money read landing after the op left the outbox dropped it while the KEY was still retained |
| 11 | 3 | Refresh on the Measurements tab reloaded the registers and the claim reads, but not the money bundle the LINE LIST is derived from |

## Root: sound, incomplete, and approximate are three different things

The rule I reached in round 2 and had to sharpen twice:

> A pre-check should refuse only what the data on screen **proves** is refused. Where it cannot
> prove anything, it should be **absent** — not approximate.

The three cases look alike in code and are not alike at all:

- **Sound and complete** — the order authority. `measured + queued + qty ≤ liveAuthority` is exact
  arithmetic on numbers the server itself published. Keep it.
- **Sound but incomplete** — the certificate floor (finding 8). It sees the selected claim's
  certificate, and global consumption is ≥ that, so every refusal it makes is a real one. It misses
  cases; it never invents one. Keep it, and *say* it is a lower bound.
- **Approximate** — the aggregate effort cap (finding 5). `EFFORT(poLine) ≥ effort(line, activity)`,
  so "qty ≤ aggregate" proves *nothing* about the rule the server applies. It could only ever be
  too permissive. **Deleted**, not tightened, and the probe now pins its absence.

The distinction is worth the words because the instinct in review is to make every guard stricter.
Two of these three needed the opposite: one needed keeping while admitting what it does not cover,
and one needed removing outright.

## Finding 9 is the important one, and it is a repeat

The Measurements tab rendered `claimPanel(…)`, so with no claim selected it said "Choose a claim".
The unit is advertised as **measure → correct → lodge → submit**, and measuring — the first step —
required a claim, the last. An engineer on a project with no claim had to create a commercial
document before they could record an operational fact.

This is the third time in this PR family that scoping §D under a claim has produced a defect:
PR #304's N3 (a draft claim's register map is empty), its O3 (the measurement's effect was
invisible), and now this. Each time I fixed the instance. The instance was never the problem:
**a measurement is a fact about a labour PO line, and the tab was scoped to the wrong noun.**

It is fixed at the noun now. The lines come from the project's live labour commitments, a selected
claim's own lines are unioned in, and `measurements` has left `CLAIM_TABS` — because a claim tab is
one whose content *is* a property of the selected claim, and this never was.

The uncomfortable part: PR #304's audit carries the carry-forward *"walk the workflow end to end,
not control by control"*, written after N3. I then shipped a unit whose first step was unreachable
and described the order it could not perform. Writing a lesson down is not the same as running it,
and the check that would have caught this is mechanical: **open the app with an empty project and
try to perform step 1.**

## Round 4 — two structures, two rules, one disagreement

Finding 10 is the sharpest instance of this PR's whole theme, and it is inside round 3's own fix.
I introduced a per-line quantity map to make the cap subtract queued work, and rebuilt it from the
live outbox on **every** read — while the KEYS were released per read, by the one read that carries
their effect. Two structures with two lifecycles: a money read landing first dropped the
reservation and left the key, so the screen freed authority it had not yet been told about.

The fix is not a third rule. The reservation is now keyed BY the coalesce key and pruned to the
surviving key set, so its lifecycle *is* the key's by construction. **Two structures with two rules
will disagree; one structure keyed by the other cannot.**

Finding 11 is the same shape as finding 7 one layer up: the line list moved to the money bundle in
round 3, and Refresh — the one control offered when a read fails — reloaded everything except the
thing the list is derived FROM. **When a surface changes where its data comes from, its recovery
path has to move with it.**

## What carries forward

1. **Sound ≠ complete ≠ approximate.** Keep the sound-but-incomplete guard and label it; delete the
   approximate one. Only "never enables what the data rules out" is non-negotiable.
2. **A guard's resource is the thing the SERVER constrains**, not the thing the key names. The line
   holds the authority; the key names a `(line, activity)` action. (Findings 2, 6.)
3. **Every write that spends a resource must be counted against it** — including the ones that
   spend it in an unexpected direction, like a positive "correction". (Finding 6.)
4. **A number the caps are computed from must be on every refresh path.** The register was the one
   read the realtime path forgot, and it is the only one the caps use. (Finding 7.)
5. **Scope the surface to the noun the domain owns.** Three findings across two PRs came from
   putting a labour-PO-line fact under a claim. Fixing the instances never fixed the noun.
   (Finding 9.)
6. **To test "can a user finish this", start from an empty project and do step 1.** No unit-level
   probe will tell you the first step needs the last one to exist.
7. **Derived state must be keyed by the thing whose lifecycle it shares.** A parallel map with its
   own rebuild rule will diverge from the set it mirrors, at exactly the moment the two are read
   together. (Finding 10.)
8. **Move the recovery path when you move the data source.** Refresh has to reload what a surface
   is derived FROM, not only the things that surface names. (Findings 7, 11.)
