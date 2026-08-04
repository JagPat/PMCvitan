# Phase 5 Task 5B, unit B — §I's attributable override

Unit A (PR #280, merged) shipped §I's RULE: a certifier who recorded any of a certificate's frozen
evidence is refused, in the service and at PostgreSQL. This unit adds the second half — the NAMED
exception that lets a two-person practice proceed anyway.

## Vision alignment

§I exists because a role list cannot express "not the person who recorded *this* evidence". On a
small practice the same PMC often accepts the material and certifies the bill, and both of the easy
answers are wrong: silently allowing it removes the only control on self-certified spend, and
silently banning it stops the practice from operating. So the act is permitted with a **named,
attributable override** — a stronger authority, a reason, recorded against that one certificate, in
the same transaction and by the same command as the certification it excuses.

## Why this shipped second, and why that order is the safe one

PR #279 carried certification through six finding-bearing heads and twenty-eight findings; **eleven
of them were in §I**. The split isolates that concern so its review can converge.

**Unit A ships the refusal; unit B ships the override.** Between the two merges the system is
STRICTLY MORE restrictive than the finished rule — a certifier who recorded evidence is refused with
no exception path at all — so no intermediate state permits an act the finished rule would refuse.
The reverse order, or shipping the override alone, would each have opened a window. That asymmetry
is what makes splitting an authority check legitimate rather than shipping it in halves.

## On replacing `phase5_t5_certificate_complete_check`

PostgreSQL has no way to add a clause to a function: `CREATE OR REPLACE` takes a whole body. An
earlier head of this task pasted a stale copy of `phase5_t4_bill_lifecycle` from another branch and
**silently deleted five correction rounds of cleared Task-5A work** — the migration applied green,
and only a test suite noticed.

So this unit's body is unit A's **verbatim**, with one named delta, and the diff is checked in as
evidence rather than asserted in prose: `docs/reviews/phase-5-t5b-unitB-complete-check.diff`. Two
hunks, both inside arm (c):

1. §I's unconditional refusal becomes the BICONDITIONAL — an override exists **if and only if** the
   certifier recorded frozen evidence; exactly one; naming the rule; from an approver with standing;
   produced by the certificate's own COMMAND RECEIPT; and resting on a GRANT the approver themselves
   issued and this act consumed.
2. the two declarations arm (c) needs.

The live-version check (a), the exact-evidence check (b) and the early return for superseded history
are byte-for-byte unit A's.

## Invariant matrix

| # | Invariant | Where it is enforced | Where it is proven |
|---|---|---|---|
| 1 | The evidence recorder may not certify — unless a named override says otherwise | `assertSegregation` + arm (c), both reading `phase5_t5_evidence_actors` | PROBE 8, PROBE 9, R2-F2 |
| 2 | An override exists IF AND ONLY IF the certifier recorded frozen evidence | the biconditional, fired from `BillCertificate`, `VendorBillVersion`, both consumption tables AND `SodException` | R5-F2 (both directions); upgrade proof |
| 3 | Exactly ONE override per certificate, naming the rule it overrides | `SodException_certificate_rule_key` + the count arm | R3-F2/F3, R5-F2; upgrade proof |
| 4 | The approver has pmc standing, by the ORGS module's rule | `OrgsParticipant.hasProjectRoleStanding` (service) and `phase5_t5_pmc_standing` (seal) | R1-F6, R4-F3 (membership precedence, both directions), R5-RESTRUCTURE |
| 5 | Those two implementations agree on every shape | two implementations, PINNED — a trigger cannot call the owner | R5-RESTRUCTURE (cell-by-cell over a matrix that separates them) |
| 6 | Standing is decided under a LOCK, in the seal as well as the service | `FOR UPDATE` inside `phase5_t5_pmc_standing` | **R6-F1** (RED: the forged certificate commits with a downgraded approver) |
| 7 | The override comes from the certificate's own COMMAND RECEIPT | `ce."resultRef" = p_certificate` in arm (c) — matching ids are not provenance | **R6-F4**, **R7-P1** (RED: a stale-command override is accepted) |
| 7b | The APPROVER actually acted — the override rests on a grant they issued and this act consumed | `SodGrant` + the grant clause in arm (c) | **R7-F1** ×2 (no forgeable field; no grant → refused; self-grant refused; single-use; version-pinned) |
| 8 | An override cannot be appended to a certificate that needed none, or to history | the reverse arm + `phase5_t5_assert_certificate_open`, fired from `SodException` | R5-F2; upgrade proof (both) |
| 9 | The override is append-only, with a non-blank reason and a different approver | `SodException_append_only`, the two non-blank CHECKs, `SodException_actor_is_not_approver` | PROBE 8, PROBE 12; upgrade proof |
| 10 | `SodException` and `SodGrant` upgrade ROW-FREE over a legacy database | the migration's two closing `DO` blocks | upgrade proof |

## Codex round 7 — and the finding that changed the design

Round 7 raised three, and one of them is the sharpest in this task:

**P1 — the approver never acted.** `certify` took `sodOverride: { approverId, reason }` from the
CERTIFIER'S OWN request and checked only that the named person held standing. A self-certifying pmc
could type a colleague's user id and the system would write an immutable, attributable record
asserting that colleague authorised it. §I's entire control is "a stronger authority said yes"; the
authority was never asked, and the audit trail carried their name anyway. Every seal above was
busy proving the override was *well-formed* while none of them asked whether it was *real*.

The plan says the override "is only legitimate because it writes a sealed `SodException`", and never
specifies how consent is obtained — so the mechanism was a design decision rather than a defect with
one right answer. JagPat chose the **two-step grant**, and that is what this unit now ships:

- `commercial.sod.grant` is the APPROVER's own command. The authenticated actor IS the authority, so
  there is no `approverId` field anywhere for a certifier to fill in with somebody else's name.
- `certify` takes the bill and nothing else. It CONSUMES a standing grant; the old shape is not even
  expressible, because the contract is `.strict()`.
- A grant is scoped to one `(bill, claim VERSION, rule, actor)`, single-use, and `approverId <>
  actorId` at PostgreSQL. Version-pinned because an amendment is a different claim: permission to
  certify the one the approver looked at must not carry over to one they never saw.
- The seal requires the exception's grant to agree with the certificate on approver, actor, rule,
  bill and version, and to have been consumed BY THAT CERTIFICATE.

**P1 — matching ids are not provenance.** Round 6's fix compared `SodException.sourceCommandId` with
`BillCertificate.sourceCommandId`, which two rows can satisfy by both copying the same STALE command.
The RECEIPT is the authority: `executeCommand` writes `status`/`resultRef` inside the same
transaction as the act, so the seal now requires a `succeeded` `commercial.bill.certify` receipt
whose `resultRef` names this certificate.

**P2 — a probe that described an assertion it never made.** The R1-F6 probe built a no-standing
fixture and stopped: no `certify` call, no rejection asserted, and a comment claiming the guarantee.
It travelled through six review rounds in that state. It now makes the call and asserts the refusal.

**Two accepted arms had to move, and that is the fix working rather than coverage lost.** After the
receipt check, a forged certificate can no longer borrow a real command's provenance — so
`forge('proper', …)` and `forge('same-cmd', …)` are now refused too. Their acceptance is asserted on
the service-made certificate whose receipt genuinely produced it.

## The two round-6 findings, and what their probes actually prove

**F1 — standing read without `FOR UPDATE`.** The first version of this probe **passed against the
defect**, and that is worth recording rather than hiding: it drove `certification.certify`, which
already asks `OrgsParticipant.hasProjectRoleStanding` with `forUpdate: true`, so it blocked on the
participant's lock and proved the round-1 fix rather than the round-6 one. The finding is about the
SQL seal — the path that enforces §I for a direct-SQL or future writer, where nothing has pre-locked
anything. The probe now drives a complete direct-SQL act with `SET CONSTRAINTS ALL IMMEDIATE` while
a membership downgrade is held uncommitted, and without the lock it fails on the OUTCOME: the
certificate commits with an approver whose standing had been withdrawn.

**The limit of that lock is stated rather than papered over.** `FOR UPDATE` locks rows that EXIST,
so it serializes a downgrade or removal of standing, not the INSERT of a membership that did not
exist when the decision was made. That is exactly the guarantee `hasProjectRoleStanding` gives, and
matching the owner's semantics is the bar: a seal stricter than the owner's rule would refuse acts
the owner permits, which is the disagreement this predicate exists to avoid.

**F4 — the override not bound to the certifying command.** A forged certificate could cite a stale
`sourceCommandId` on its override row and leave the durable trail answering "which command
authorised this?" with someone else's command. Arm (c) now requires the two to match, proven RED and
paired with the matching-provenance case being ACCEPTED so the seal is precise rather than strict.

## One behavioural change worth naming

Unit A's §I refusal message was "…who recorded evidence it rests on — §I refuses the act". With an
override path in existence the refusal now names it: "…with no attributable
`evidence-recorder-may-not-certify` exception from the same command granted by a pmc with standing".
Two probes assert that message and were updated with the change rather than around it.

## Gate results

| Gate | Result |
|---|---|
| `pnpm check` | **EXIT 0** — web 543/543, API 724/724, both builds clean |
| `phase5-t5b-certification.test.ts` | **43/43** on live PostgreSQL |
| Reproduce-first | `phase5_t5_pmc_standing` reverted to an unlocked read and the command-provenance clause dropped → **both R6 probes RED**, F1 on the outcome |
| Full integration, pristine migrated DB | see the PR thread |
| `upgrade-proof.sh` | **PASSED** — the recorder-certified act refused WITHOUT an override and ACCEPTED with one, plus the register's own seals |

## Scope

One migration (`20270515000000`), two schema models (`SodException`, `SodGrant`), one new command
with its route and permission, the override branch of one service method, the contract pair, six
tripwire updates, the 38-file TRUNCATE sweep, nine probes and the upgrade-proof §I block. One
concern throughout: **who may certify, and on whose authority.**
