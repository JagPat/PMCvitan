# PR #316 — convergence audit

Two finding-bearing heads, thirteen findings. The protocol says stop patching and say what is
actually going wrong. One root explains nine of the thirteen, and it is not "I forgot a check".

| Head | Findings |
|---|---|
| `979b49d` | 7 — the release third of the child-key division · reason required for judgement withholdings · the advance key had no release path · approve with no live payable · payment over its approval · reversal over its payment · release over its withholding |
| `df8c1bb` | 6 — withholding not gated on net payable · payment from a superseded authority · `Number` loses paisa on large values · approve from a stale claim copy · certifier self-approving · advance requires a claim to exist |

---

## Root — I applied each rule to the controls I was thinking about, not to the set

Six controls, and roughly five preconditions each: authority, pending-conflict, viewed-fact
freshness, shape, and **balance**. Thirty rule-applications. I wrote them **control by control**, so
every rule I discovered was applied to the controls in front of me at that moment and to no others.

The evidence is that the same rule keeps arriving twice:

| Rule | Applied first at | Missed at | Found by |
|---|---|---|---|
| a child-keyed command must be visible to the fold rule | payment, reversal | **release** | round 1, F1 |
| every new coalesce key needs a settling read | deduction, approve, release, pay, reverse | **advance** | round 1, F3 |
| compare the typed amount against the ledger balance | approve, pay, reverse, release (round 1) | **deduction** | round 2 |
| act only from an authoritative claim copy | the §I grant form, one unit earlier | **approve** | round 2 |

Round 1's own packet called F4–F7 "one mistake made four times" and fixed it in four places —
**and left the fifth control out of the sweep it had just named.** That is the root stated as
precisely as I can: the fix travelled to the instances I was holding in mind, and the sweep was a
sentence rather than a mechanism.

### Two of the misses are rules from the *previous* unit

- **round 1 F3** is 7B-iii-g's F2 (*a key with no release path is not pending, it is stuck*),
  recurring on a key I added one unit later.
- **round 2's stale-copy finding** is the same `arbitrateBillCopy` gate 7B-iii-g added to the §I
  grant form after its own review named it.

A lesson recorded in a packet does not travel by itself. It travels when a mechanism carries it.

---

## What changes, rather than a promise to sweep harder

**One precondition table for all six controls.** Every gate is computed in a single block keyed by
control, so a rule is written once as a row and every control that needs it takes it there. A
control missing a rule becomes a visible hole in a table instead of an absence nobody can see. This
is the same instrument round 4 of PR #312 arrived at — enumerate the artifact against every guard —
applied here at the point the enumeration is *executed* rather than described.

**Exact decimal comparison, from the module that already had it.** `lib/decimal.ts` exposes
bigint-scaled `decGt`/`decSub`; my round-1 helper converted through `Number` and lost paisa on large
values. The right tool was one import away, and reaching for `Math.round(Number(v) * 100)` on a
money surface is the same class of mistake as the rest of this audit: solving locally what the
codebase had already solved.

**The advance control moves off the claim panel.** `payAdvance` takes a `vendorId` and exists for
cash paid *before* any claim — deriving the vendor from an open claim made the workflow unreachable
in exactly the case it is for. That is not a missing check; it is a control placed inside the wrong
scope, and the table made it obvious because the advance row needs none of the claim preconditions.

**Checkable form, for the next unit:** *when a rule is discovered, apply it by editing the table row
it belongs to — never by editing the control that revealed it.*

### The mechanism caught the third recurrence before a reviewer did

Round 2's head was pushed, CI went green, and the gate then failed on an unrelated CI-settle race.
While that was being diagnosed I walked the table's rows against the shared contract — which is the
checkable form above, executed — and the same root surfaced a **third** time:

> `advance-recovery` is the one withholding type with **two** ceilings. Every other type is bounded
> by this claim's payable; a recovery is bounded by that **and** by a VENDOR-scoped pool, what the
> counterparty still owes back across every claim. R2-1 fixed the `deduct` row against `netPayable`
> and stopped there — the row was correct for three of the four types.

The bundle already carried `advance.recoverable`, and its contract comment states the exact purpose
the gate was failing to serve: *"so an operator can see the ceiling BEFORE a recovery is refused by
it rather than only in the refusal."*

This is the audit's own claim being tested rather than asserted. The first two arrivals were found
by a reviewer; the third was found by the mechanism, in the same session it was installed, on the
one row where a rule that reads as uniform is not. `bothOf` is null-propagating on purpose: an
undeterminable ceiling refuses rather than falling back to the other one.

---

## Round 3 — the root restated, and why the unit SPLITS

Three finding-bearing heads: 7 + 6 + 5 = **eighteen findings**. Round 2 said the root was *"I applied
each rule to the controls I was thinking about, not to the set"*, and installed a precondition table
so a rule is a row. That was right about **coverage** and it worked — the table caught the root's
third arrival by itself. It was not the whole story, because round 3's five findings are not missing
rows. Every one of them is a row **comparing the wrong quantity**.

| # | The gate compared… | The server actually checks… |
|---|---|---|
| F2 | `certifyPreflight.grantState` | a `certifier-may-not-approve` grant — a DIFFERENT §I rule |
| F4 | `status` / `statusChangedAt` | the claim's monotonic `lifecycleVersion` |
| F3 | `netPayable` | `netPayable − approved`, because the §F seal re-runs after the insert |
| F5 | the payment's own key | every write that retires the certificate the approval hangs off |
| F1 | "the claim read settles it" | a read that carries **this vendor**, which no claim read does once the control left the claim panel |

### The sharper root: I built each gate from the nearest available signal, not from the predicate

The table made every rule *present*. It did not make any rule *faithful*. In each case a fact that
was close at hand stood in for the fact the server actually tests — a sibling rule's grant, a status
stamp, a gross balance, a narrower key. Proxies are invisible in a precondition table, because the
row is there and it looks right.

**The corollary is the part worth keeping:** when the nearest signal is a proxy, refining the proxy
is the wrong move. The right move is to make the server hand over the predicate — which is exactly
what `7B-iii-c-ii` did one unit earlier, exposing the SoD preflight in the claim contract *before*
the client surface was built. That lesson was recorded and then not applied here.

### So the unit splits, and the seam is drawn by the findings themselves

Two of the five **cannot be fixed on the client at all**:

- **F2** — no DTO carries a `certifier-may-not-approve` grant. `certifyPreflight` resolves
  `evidence-recorder-may-not-certify`. Any client answer is a guess in both directions: a live
  certification grant would wrongly *enable* a self-approval, and a real payment grant stays
  invisible so the button wrongly *stays disabled*.
- **F4** — `VendorBillDto` carries no revision, so no comparison the client can make sees a fold
  write that moves `lifecycleVersion` without moving the status label.

And **F1** turns out to be the same shape: `POST /commercial/advances` is write-only, so there is no
read that carries a vendor's advances. Round 2 moved the advance control out of the claim panel so
it would work with no claim — and by doing so removed the only read that could ever settle its key.
The fix is not a cleverer release path; it is a read that does not exist yet.

All three land on exactly two controls — **approve** and **advance** — and that is not a coincidence.
Approve is the only command that pins a revision and the only one the certifier rule governs;
advance is the only one that names no claim. **The seam is where the client's information runs out.**

| Unit | Controls | Why it is one concern |
|---|---|---|
| **7B-iii-d** (this PR) | deduct · release · pay · reverse | every precondition is a figure the claim bundle already carries, and every key settles on the claim read |
| **7B-iii-d-ii** | approve · advance | both need a server fact this contract does not expose: the payment-rule grant state, the claim's current revision, and a read that carries a vendor's advances |

Shipping approve with a gate built on the wrong §I rule would be the write-ahead lie on the one
control that authorises money to leave. Deferring it is not descoping — it is refusing to guess at
authority, which is this repository's rule (`7B-iii-g` F6) and the reason `certifyPreflight` exists.

**Checkable form, added to round 2's:** *a gate may only compare the quantity the server compares.
If that quantity is not in the contract, the contract is the fix — never a nearer-to-hand stand-in.*

---

## What this head does NOT do

It does not add a client-side model of §I standing. The certifier-self-approval gate compares
`certifyPreflight.callerActorId` with the certificate's own `certifiedById` — two facts the server
already put in the bundle — and refuses that pairing unless a live grant is reported. It does not
attempt to decide whether an override *would* be granted; that remains the server's, per 7B-iii-g's
F6.
