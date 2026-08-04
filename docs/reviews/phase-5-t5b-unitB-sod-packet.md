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
   certifier recorded frozen evidence; exactly one; naming the rule; produced by the certificate's
   own COMMAND RECEIPT **run by that certifier** (round 11); and resting on a GRANT the approver
   themselves issued, this act consumed, and whose **reason it carries verbatim** (round 11).
   Standing is deliberately NOT decided here — see round 11 below.
2. the two declarations arm (c) needs.

The live-version check (a), the exact-evidence check (b) and the early return for superseded history
are byte-for-byte unit A's.

## Invariant matrix

| # | Invariant | Where it is enforced | Where it is proven |
|---|---|---|---|
| 1 | The evidence recorder may not certify — unless a named override says otherwise | `assertSegregation` + arm (c), both reading `phase5_t5_evidence_actors` | PROBE 8, PROBE 9, R2-F2 |
| 2 | An override exists IF AND ONLY IF the certifier recorded frozen evidence | the biconditional, fired from `BillCertificate`, `VendorBillVersion`, both consumption tables AND `SodException` | R5-F2 (both directions); upgrade proof |
| 3 | Exactly ONE override per certificate, naming the rule it overrides | `SodException_certificate_rule_key` + the count arm | R3-F2/F3, R5-F2; upgrade proof |
| 4 | The approver has pmc standing, by the ORGS module's rule | `OrgsParticipant.hasProjectRoleStanding` — ONE implementation, behind the owner's boundary, invoked by `commercial.sod.grant` | R1-F6, R4-F3 (membership precedence, both directions) |
| 5 | No commercial seal reads an orgs-owned table | the standing predicate is REMOVED; the seal requires the grant, and only a standing-checked command can produce one | **R11-F1** (asserted over `pg_proc`, so it covers what is INSTALLED); upgrade proof (the approver holds no `Membership` row and the act is still accepted) |
| 6 | Standing is decided under a LOCK, where it is decided | `forUpdate: true` in `grantSodException`, at the moment the authority is issued | **R6-F1/R11-F1** (RED: the grant is issued behind a downgrade that was in flight) |
| 7 | The override comes from the certificate's own COMMAND RECEIPT, run by the CERTIFIER | `ce."resultRef" = p_certificate` **and** `ce."actorId" = v_certifier` in arm (c) | **R6-F4**, **R7-P1** (RED: a stale-command override is accepted); **R11-F2** (RED: a receipt run by someone else is accepted) |
| 7c | The override carries the APPROVER'S reason, not one the certifier wrote | `g."reason" = s."reason"` in the grant clause | **R11-F3** (RED: a real grant is consumed while the recorded justification is rewritten) |
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

## Codex round 11 — the duplicate I had been protecting

Three findings, and the first one undoes a structure five earlier rounds had been maintaining.

**P2 — a commercial seal read orgs-owned tables.** `phase5_t5_pmc_standing` read `Membership` and
`OrgMembership` and re-implemented the module's precedence semantics inside COMMERCIAL's SQL. That
is the cross-module synchronous read `AGENTS.md` forbids. The cleared phase-3 precedent (an FK from
`ActivityRequirement` to `Membership`) is a different thing: declarative, carrying no policy.

Rounds 3–5 had repeatedly found "one rule, two implementations" — and for standing I answered by
PINNING the duplicate with a correspondence probe rather than removing it, because "a trigger cannot
call TypeScript". **The question I never asked was whether the trigger needed to decide at all.** It
did not: a `commercial.sod.grant` receipt exists only because the command ran, and that command asks
the owner under `forUpdate: true`. The seal checks provenance, the service checks authority — which
is what every other cleared seal in Phases 3–5 already does.

So the predicate is gone, and with it round 6's `FOR UPDATE` on the standing rows and round 5's
correspondence probe. Neither is a regression smuggled through: round 6 asked that IF this predicate
reads standing it must lock it, and round 5's probe existed to pin a duplicate. The concurrency
guarantee did not disappear — it has one home now, and `R6-F1/R11-F1` moves to it, proving the GRANT
command blocks on the membership row and refuses an authority issued behind a downgrade in flight.

What it gives up, plainly: a direct-SQL writer can no longer be caught by this seal naming a non-pmc
approver. That writer could equally insert an active pmc `Membership` row and satisfy the old
predicate, so the check was never load-bearing against its own threat model.

**P2 ×2 — a binding proves only what it binds.** Arm (c) bound the certificate to its receipt on
type, status and result but not on WHO RAN IT, and bound the exception to its grant on approver,
actor, rule, bill and version but not on the REASON. Both unbound fields are ones a reader trusts:
§I is a rule about which person acted, and `certificateById` reports the exception's reason as the
authorisation — so the justification was the one field the person being excused could still write.
The certify-receipt half is round 8's own correction failing to travel BACKWARDS to the sibling three
clauses above it.

**Three probes had to be retargeted rather than left green.** With the standing clause gone, round
6's seal forgery, round 4's precedence forgery and round 3's no-standing arm are all still refused —
by the GRANT clause, for a reason none of them names. Each now asserts what it actually causes. That
is the seventh entry in this task's "passed while proving nothing" list, and the first one caught
before it was written rather than after.

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
| `phase5-t5b-certification.test.ts` | **49/49** on live PostgreSQL |
| Reproduce-first, round 11 | the two binding clauses stripped from the INSTALLED seal → **R11-F2 and R11-F3 both commit the forgery** |
| Full integration, pristine migrated DB | see the PR thread |
| `upgrade-proof.sh` | **PASSED** — the recorder-certified act refused WITHOUT an override and ACCEPTED with one (by an approver holding NO membership row, which is the boundary proof), plus both round-11 forgeries rejected |

## Scope

One migration (`20270515000000`), two schema models (`SodException`, `SodGrant`), one new command
with its route and permission, the override branch of one service method, the contract pair, six
tripwire updates, the 38-file TRUNCATE sweep, eleven probes and the upgrade-proof §I block. One
concern throughout: **who may certify, and on whose authority.**
