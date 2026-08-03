# PR #274 — architectural convergence audit (Phase 5 Task 4)

Two finding-bearing heads, eight findings. Per `CLAUDE.md`, from the third head on this stops being
another isolated patch: it names the ROOT the findings share and leaves a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `61adb3d` | 4 | 1×P1 a bound reading a stale authority, 3×P2 seals that froze the wrong thing |
| `b4bb720` | 4 | 4×P2 — two of them the round-1 fixes, one level short |

---

## The eight findings

| # | Head | Sev | Finding | Root |
|---|---|---|---|---|
| 1 | `61adb3d` | P1 | The §G bound read the PO line's frozen quantity without asking whether its version was still live, and no vendor-bill trigger fired when one stopped being live | **A** |
| 2 | `61adb3d` | P2 | The lifecycle trigger validated only when `status` moved, so a bill's exit reason could be rewritten afterwards | **B** |
| 3 | `61adb3d` | P2 | The version trigger checked the immutable columns and returned, leaving `supersededById`/`supersedeReason` pre-fillable on a still-current version; and nothing forbade ZERO current versions | **B** |
| 4 | `61adb3d` | P2 | The line trigger froze UPDATE and DELETE but not INSERT, so a zero-money line could be appended to a recorded version — money check satisfied, quantity added | **B** |
| 5 | `b4bb720` | P2 | Finding 4's own fix left `lineCount` mutable: bump it and insert the extra line in one transaction and the deferred check matches | **C** |
| 6 | `b4bb720` | P2 | Finding 2's own fix keyed on "the status changed", so `disputed → resolved` still overwrote the breach reason with an amendment note | **C** |
| 7 | `b4bb720` | P2 | The PG lifecycle listed the whole §F graph, so maintenance SQL could mark a claim `verified`/`certified` in a tree with no verdict and no certificate | **A** |
| 8 | `b4bb720` | P2 | `billedAmountFor` was built and never called, so a live claim left the budget reporting billed work as unbilled | **D** |

---

## Root A — a seal that trusted a status it never read (findings 1, 7)

Both are the same sentence pointed in opposite directions: **the database enforced a rule over a
lifecycle it did not consult.**

Finding 1 is the read side. The bound check locked the PO line and folded the claims against it, but
took `qty + approvedOverage` as ordered authority without ever joining the version's status — so a
cancelled or amended version still read as full authority. Worse, nothing *fired*: `StockTransaction`
and `Measurement` were firing sites because they lower bound 2's right-hand side, and I had simply
not noticed that a PO version leaving its live set lowers bound 1's the same way. §0b's closure row
names three withdrawal paths — acceptance reversal, sign-off revert, measurement correction — and I
read that list as exhaustive. It is exhaustive *for the evidence side*. Ordered authority is a fourth.

Finding 7 is the write side. The status CHECK carried the whole §F vocabulary, correctly, because
§0's LIVE rule is defined over all of it. But the transition trigger carried the whole §F *graph*
too — including the arrows into `verified` and `certified`, which this task deliberately does not
ship. The task's own packet says "Task 4 stops SHORT of `verified`", and the database disagreed with
the packet.

**Closure.** The bound function now resolves ordered authority *through* the version status (zero
when not live), both PO-version tables are deferred firing sites, and the participant disputes the
affected claims from the one channel all eight lifecycle sites already reach. The arrows stop at
`under-verification` while the statuses stay in the vocabulary. The mechanical check is the
upgrade-proof pin `3|7|2` — three lifecycle/append-only triggers, **seven** deferred firing sites,
two partial uniques — so adding a fold input without adding its firing site fails a named assertion
rather than passing silently.

**What finding 1 also taught, and the packet records honestly:** the *consequence* Codex described
is not reachable through any service path in this tree. Three guards from three different tasks
close it — Task 2's live-commitment rule, Task 3's measured floor, Phase 3's accepted-receipts and
issued-only rules. I fixed the seal anyway, because §G asks the database to hold the bound
*independently*, and "another task's guard happens to block the only route" is not the database
holding anything. The probe pins all three guards precisely because each belongs to a different task
and any one relaxing would reopen this without a sound.

## Root B — freezing the fact and not its evidence (findings 2, 3, 4)

Three seals, one omission each, all the same omission: **I froze the thing and left the thing that
proves it writable.**

- The bill's identity was frozen; the *reason it left the live fold* was not.
- The version's immutable columns were frozen; the *supersession stamp that authorises the one
  permitted transition* was not — and the partial unique forbade two current versions while
  permitting zero.
- The line was frozen against edit and delete; the *set of lines* was not.

Each is defensible in isolation and indefensible together, which is what makes it a root rather than
three mistakes. The discipline this repository already states — AGENTS.md's "immutable after write
except a single explicit permitted transition" — is about the *transition*, and in all three cases I
protected the row and left the transition's evidence unguarded.

## Root C — the round-1 fixes, one level short (findings 5, 6)

This is the root that matters most, because it is not about vendor bills.

Finding 5 is finding 4's fix with the same defect finding 4 had: I closed the line set with a
`lineCount` and did not freeze `lineCount`. Finding 6 is finding 2's fix with the same defect
finding 2 had: I froze the reason against a same-status rewrite and left the cross-status one open.
**Both corrections reproduced the exact error class they were correcting.**

The PR-#270 audit named this in Task 2 and named it twice — a closure that was a hand-kept list, and
a label decision pushed to a caller that could not make it. The pattern is that a fix aimed at the
*reported instance* inherits the *unreported* siblings of the same shape.

**Closure, stated as a rule rather than a patch:** when a fix introduces EVIDENCE — a count, a
stamp, a reason, a fingerprint — that evidence takes the same seal as the fact it evidences, in the
same change. Mechanically: `lineCount` now sits in the version's immutable column list beside
`claimedAmount`, and the reason freeze is keyed on the *destination state* rather than on "something
moved", so both are enforced by the same trigger that enforces the fact. The upgrade proof carries
an acceptance case beside each rejection, which is what would have caught both: a seal that only
ever refuses is not shown to be precise.

## Root D — a fold with no caller (finding 8)

`billedAmountFor` was written, tested by nothing, and read by nobody, so the budget surface kept
reporting billed work as unbilled. Task 2's own DTO comment had already stated the obligation —
"Tasks 4–6 subtract `BILLED_AMOUNT` from it" — and I built the fold without discharging it.

**Closure.** The cost-head position gains §J's `awaiting-certification` bucket, and the probe asserts
the *partition* rather than the value: `committed + receivedNotBilled + awaitingCertification` totals
the received money and **headroom does not move**. That is the invariant §J actually states, and it
is the assertion a future omission trips over — a bucket added without its counterpart breaks the
sum, where a value assertion would simply be updated.

---

## What this PR got right, and should not be re-litigated

Three things survived both rounds untouched, and the audit records them so a later head does not
churn them: the DISPUTE-not-refuse disposition (§0's LIVE rule makes the seal and the dispute
consistent), the deferred-to-COMMIT shape of the bound seal (load-bearing in both directions — a
claim goes live one statement after insertion, and evidence withdrawal is disposed of in the same
transaction), and the vendor-pinning backfill with its pre-Task-4 fixture.

## The standing lesson this phase keeps re-teaching

Four probes in Task 3 and one more here passed while proving nothing — a vacuous timezone probe,
three rejections firing on the wrong FK, two identity probes comparing across projects, and in this
PR a `billedQty` helper that was material-only, so a labour line folded zero rows and reported `0`
for a claim that was live. My first F1 probe asserted exactly that `0`.

Each was caught the same way: by running the RED proof instead of assuming it. The rule was closed
once already — *a rejection is only evidence when an otherwise-identical case is ACCEPTED* — and
this PR adds its sibling, which the `billedQty` helper is the case for: **a fold helper takes its
scope explicitly rather than defaulting to one**, because a default that silently matches nothing
returns the number the probe was hoping for.

---

## Gate results at the convergence head

| Gate | Result |
|---|---|
| Focused probe suite `phase5-t4-vendor-bill.test.ts` | **23/23** — 8 of them the round-1 and round-2 findings, each RED before its fix |
| Full integration suite, pristine migrated DB | **76 files / 787 tests**, zero failures |
| `pnpm check` | EXIT 0 — web 543/543, API 718/718 |
| `upgrade-proof.sh` | PASSED — 40 Task-4 assertions, acceptance cases beside the rejections |
| `test:e2e:api:allmodules` / `:outbox` | 35/35 · 29/29 |

One `api-e2e` failure landed on the superseded head `84f5e1b` and is recorded here rather than
omitted: its Postgres logs showed only `Drawing_projectId_activityId_fkey` on `test-empty-site` and
a duplicate `DrawingRevision (drawingId, rev=B)` — the `project-scope` and `drawings-module-query`
specs, both named flake families in the maintenance queue. This PR touches no drawings,
project-scope or revision code; its only changes outside the commercial module are the two PO-line
pinning columns and the `stock.reverse` hook. The identical job passed on the next head with no e2e
or drawings file changed between them, which is the evidence — not the inference.
