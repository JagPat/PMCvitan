# Phase 5 Task 7B-v — the §I PAYMENT-rule authorisation surface

**One architectural concern:** a `certifier-may-not-approve` authorisation must name someone an
approval could actually spend it on — enforced on the server, and offered in the browser only where
the server would accept it.

Base `main` `64ce353`. The parked work is `claude/phase5-task7b-v-sod-payment-parked` at `46464da`;
the ledger this unit discharges is `docs/reviews/phase-5-t7b-v-parked-findings.md`.

## The defect, reproduced before it was fixed

`grantSodException` never read `billCertificate` at all. It checked that the named actor held
approve STANDING — true of every pmc on the project — and wrote the row. But `approve()` consults a
payment-rule grant **only** when `certificate.certifiedById === actor`, so a grant naming anybody
else authorises nothing: the named person was never blocked, their approval succeeds without
consulting it, and the row sits `consumedAt: null` for ever.

RED first against live PostgreSQL. The probe printed the accepted row before any fix existed:

```
actorId:    it-owner-…      ← named; did NOT certify
approverId: it-member-…     ← the certifier, granting
rule:       certifier-may-not-approve
consumedAt: null            ← and never can be
```

## What was built: one predicate, three consumers

The parked ledger holds five findings and they are all one shape — an incomplete precondition set
for a rule that authorises an act it does not itself perform. Round 2 enumerated three and called it
the rule; round 3 found three more. `pr-317-convergence.md` records the lineage failing at exactly
this four times, **twice inside the correction written to fix an enumeration failure**. So the fix
is not a longer list. It is removing the second list.

In `commercial-sod.ts`:

```
resolveApprovalContext(tx, folds, projectId, billId) -> ApprovalContext | null
payableGrantActor(context, callerActorId)            -> string | null
```

| Consumer | How it uses them |
|---|---|
| `approve()` | REFACTORED onto `resolveApprovalContext` — its position, certificate, `approvedSoFar`, `netPayable` and `remaining` all come from there. Behaviour unchanged. |
| `grantSodException` | requires `input.actorId === payableGrantActor(context, actor.actorId)` for the payment rule |
| `ApprovePreflightDto.grantCandidates` | the same predicate, so the read offers exactly whom the command would accept |

`payableGrantActor` returning `null` covers **no live certification** (nothing to approve), **no
remaining headroom** (§G bound 4 admits no positive amount), and **caller is the certifier** (§I
forbids a self-grant) — without any of them being a listed condition anywhere. A precondition added
to `approve()` reaches the command and the read through the shared context.

### Two details that are the design rather than the diff

**After writing the row, the command runs the SPEND path's own `resolveSodGrant` and requires
`live`.** The version, status and revision pins are therefore checked by the *actual* resolver
instead of restated at the issue site, so a pin added there later is enforced at issue
automatically. Every enumeration in this lineage lacked exactly that property: each looked complete
from the inside, and none could notice what it had not been told about.

**`unspendableGrantReason`'s last arm is general and stays true whatever the reason.** If a
precondition is added and no sentence is, the refusal degrades to accurate-and-vague rather than
confidently wrong. Naming the wrong cause is worse than naming none, because the reader acts on it.

## The five parked findings, and how each is discharged

| # | Finding | Discharged by | Evidence |
|---|---|---|---|
| **F3** | the picker offered actors `approve()` can never excuse — needs a SERVER guard | `payableGrantActor` in the command | PROBE 38 (a), RED at `64ce353` |
| **A** | the window inherited `BILL_CERTIFY_FROM`, which closes when a payment exception is needed | derived from the fact `approve()` needs — a live certified position — not a status list | PROBE 39 (a); `7B-v-1` |
| **F2** | the past-certification family admits claims whose `approvable` is already zero | `remaining <= 0` in the same predicate | PROBE 39 (b); `7B-v-1` |
| **F1** | the revision pin — status arbitration only | **already satisfied**: the form passes the bundle's `lifecycleVersion` with every grant, and it is per-claim, so the payment path inherits it | verified on `main`, not rebuilt |
| **B** | the grant key blocked behind transitions, not fold writes | **already closed on `main`** by #317 — `commercialWriteBlocked` anchors `com:sodgrant:<bill>:` and blocks behind `isClaimMoneyPending` for BOTH rules | verified in `commercialKeys.ts`, not rebuilt |

F1 and B were **checked rather than assumed**, and are recorded here as verified-not-rebuilt.
"Already fixed" is precisely the kind of claim the closing packet's own convergence audit records
this lineage getting wrong, so it is stated with where it was checked.

## The client half is subtraction

The browser no longer models this rule. `grantCandidates` is non-empty exactly when the command
would accept, so the form cannot offer what the server refuses, nor refuse what it would accept.
Three of the five findings were three attempts to derive server facts in a form; they are one
question now, and the browser asks it rather than answering it.

The name comes from the orgs candidate list certification's picker already uses, INTERSECTED with
the predicate — so a certifier who does not hold approve standing yields an empty list without that
being a second check written in the read. That is round 1 finding 6's rule: a picker built from an
approximation of an authority rule IS an authority rule, and a second one.

The payment rule's empty-state deliberately does **not** diagnose which precondition failed. The
server knows and says so when asked; guessing is how the browser came to model this rule at all.

## Behavioural changes to existing tests, stated rather than absorbed

- **`PROBE 28` amounts `100 → 90`.** Its SUBJECT is the revision counter; it used a payment-rule
  grant merely as a write that moves no status, and approving plus paying the whole payable leaves
  zero approvable, which now makes that grant correctly unspendable. The incidental write is made
  legal rather than the guard weakened to keep an old line running. Every assertion is unchanged.
- **The probe asserting the 7B-iv PARK is REPLACED, not deleted.** Its replacement records why:
  what closed the park is not a longer list of client-side checks, it is that the browser stopped
  deciding.

## Verification

| Gate | Result |
|---|---|
| `phase5-t6a-payments.test.ts` (live PG) | **39/39** — PROBE 38 RED at `64ce353` → GREEN |
| `phase5-t7bii-claim-read.test.ts` (live PG) | **28/28** — `7B-v-1` |
| web `commercial-screen` · `commercial` · `commercial-verification` | **187/187** |
| `pnpm check` | **EXIT 0** (API unit 781/781, build clean) |
| full integration suite (pristine migrated DB) | see PR body |
| `upgrade-proof.sh` | no migration in this unit; run for the standing seals |

**No migration, no schema change.** One additive contract field
(`ApprovePreflightDto.grantCandidates`), one shared predicate, one guard, one form.

## What this unit does NOT close

**7B-vi** — the §H vendor advance surface. Only `POST commercial/advances` exists; the LIST read was
removed with the control at the 7B-iv split, so 7B-vi owes the read **first**, and its coalesce
identity must be DERIVED from the whole payload rather than enumerated. Ledger:
`docs/reviews/phase-5-t7b-vi-parked-findings.md`.
