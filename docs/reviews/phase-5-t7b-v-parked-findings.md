# 7B-v — the §I PAYMENT-rule authorisation surface, parked whole with its findings

The work is parked on **`claude/phase5-task7b-v-sod-payment-parked` at `46464da`** — the exact head
Codex reviewed. That branch carries the `certifier-may-not-approve` grant surface **complete and
unfixed**, so nothing known-broken shipped in PR #317 and nothing has to be reconstructed from
memory later. This note is the durable record on `main`; the branch is the code.

The 7B-iii-f precedent, applied for the same reason it was set: when the §I authorisation surface
keeps drawing findings, it gets its own reviewer rather than a third patch inside someone else's
unit.

## Why it was parked rather than patched again

Rounds 2 and 3 produced **five** findings on this one surface, and every one was the same shape —
an incomplete precondition set for a rule that authorises an act it does not itself perform:

| Round | Finding | The precondition that was missing |
|---|---|---|
| 2 | A | the WINDOW — it inherited `BILL_CERTIFY_FROM`, which has closed exactly when a payment exception is needed |
| 2 | B | the CONFLICT SET — it yielded to §F transitions but not to the fold writes that also move the pinned revision |
| 3 | F1 | the REVISION PIN — the gate arbitrated on status only, so a bundle at revision 4 could issue a grant the server rejects as `stale-version` |
| 3 | F2 | the REMAINING HEADROOM — the whole past-certification status family admits claims whose `approvable` is already zero, where no positive approval can ever be accepted |
| 3 | F3 | WHO IT CAN EXCUSE — `approve()` consumes a grant only when `certificate.certifiedById === actor`, so naming anyone else writes an authorisation nobody can spend |

Round 2's own convergence audit named the rule *"re-derive every precondition per rule — the window,
the conflicts, and the sentence that explains the refusal"* and listed exactly three. Round 3 found
three more. **The audit committed the error it was describing:** it enumerated the preconditions in
mind rather than deriving the set.

## What the next unit should do instead of enumerating again

Derive the grant's preconditions from **what the server does with it when it is spent**, as one
predicate rather than a list. A payment-rule authorisation is issuable only if, at spend time, it
could actually be consumed:

1. the act is legal (the claim is past certification),
2. a positive amount remains approvable,
3. the actor IS the certifier the rule blocks (`claim.certificate.certifiedById`),
4. the pins still match the server's current reading (status **and** revision).

F3 additionally requires a **server guard**, and PR #318's review confirmed it is still open on
`main`: `commercial.sod.grant` checks the excused actor's STANDING for the act, but not that — for
`certifier-may-not-approve` — they are the certifier, while `approve()` consumes the grant only when
`certificate.certifiedById === actor`. A pmc can therefore record a payment-rule grant naming any
approver and it is never spendable. The picker narrowing is not the authority, and a command that
accepts an unspendable grant is the defect whether or not a form offers it. That server
change is why this could not stay inside PR #317, which is read + UI over already-cleared facts. It
is the 7B-iii-h / 7B-iii-g seam exactly.

## The gap that ships meanwhile, stated rather than hidden

PR #317's grant form issues `evidence-recorder-may-not-certify` only, and says so on the surface.
The payments tab still reports the `certifier-may-not-approve` refusal **accurately** — it is a true
refusal — but a one-person pilot site cannot self-serve that remedy in the browser until 7B-v lands.
Both §I rules remain issuable through the API, which is how the pilot acceptance chain exercises
them.

An accurate refusal with no in-app remedy is a gap. A form that offers the authority and writes a
grant nobody can spend is a defect. This parks the second in favour of the first.
