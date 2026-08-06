# PR #286 convergence audit — Phase 5 Task 6A (payment authority)

Three finding-bearing heads: `b9f9b58` (nine findings, three P1), `8c80152`
(six, four P1) and `4e80082` (four, **zero P1**). This audit became due at the
second head and is carried forward.

| Round | Findings | P1 | Root |
| --- | --- | --- | --- |
| 1 | 9 | 3 | **E** ×3, **A** ×2, four one-offs |
| 2 | 6 | 4 | **E** ×2, **A** ×2 (one of them a closure failure), **F** ×2 |
| 3 | 4 | **0** | **A** ×3 — every one a sibling of something round 2 added |

Round 2's severity went **up**, not down, and that is the number this audit had
to answer for. Round 2 was smaller but harder, and its composition is the reason:

- **two of the six findings were created by my round-1 corrections** (the
  superseded-certificate guard I added in the wrong place; the zero ceiling I
  chose for an absent membership), and
- **one was the round-1 root recurring after I had named it.**

That last one is the whole audit. Round 1's packet recorded the root as *"I
sealed the arithmetic and left the authority to the service."* I then fixed the
stale-approval rule **in the service** and never mirrored it at PostgreSQL, and
round 2 found exactly that. Naming a root is not a closure. A closure is a thing
that fails.

## Root E — a rule enforced at one layer and not at the other

Round 1, three instances: §I's certifier-vs-approver rule refused only by the
service; the superseded-approval rule refused only by the service; the
`SodException.approvalId` column added with an immutability trigger and no
insert-side validation at all.

Round 2, two instances, **both on code round 1 added**:

| Finding | Instance |
| --- | --- |
| R2 P1 | the stale-approval rule now refused by the service; the PG bound still bill-scoped, so it admits the payment whenever another live approval covers the total |
| R2 P1 | the approval-side SoD exception validated for SHAPE at PG and never for whether the approver ACTED |

The physical signature is the same both times: I answered "does the service
refuse this?" and stopped. The question a money row has to survive is "what
refuses this to a writer that never called the service?" — and for an
append-only register the answer must exist, because there is no correcting row
to write afterwards.

### The closure

**CLOSURE 9** in `commercial.contract.test.ts`: every `ConflictException` and
`ForbiddenException` the payment service raises is **read out of the source** and
must appear in `AUTHORITY_GUARDS` with one of two answers — the PostgreSQL object
that refuses the same thing (and the test proves that object exists in a
migration), or `seal: null` with a reason. Adding a guard without a row fails.
Naming a seal that does not exist fails.

Two rows carry `seal: null`, and both reasons are load-bearing rather than
convenient: standing is ORGS-owned, so a PG copy of the role predicate here would
be a second statement of a rule this module does not own; and an approval ceiling
is per-MEMBERSHIP authority that can move after the fact, so a PG check on the
money row would refuse a row that was legitimate when written.

### What writing it exposed

Answering the question for every guard surfaced **a sibling the reviewer did not
name**: `PaymentApproval` had the identical stale-certificate hole as `Payment`.
Its three-column FK proves the certificate belongs to this bill and says nothing
about it standing, and `phase5_t6a_approved_bound_check` deliberately excludes
superseded certificates — so a direct writer's approval against dead certification
passes every constraint *by being invisible to all of them*. It is inert money and
it is still a false authority in an append-only register. Sealed in this head,
`PaymentApproval_authority_live`, beside the one the finding named.

## Root A — the fix lands on the instance a finding names, the sibling survives

Named in PR #284 and still alive. Round 2's two instances:

| Finding | Instance |
| --- | --- |
| R2 P1 | `approvalCeilingFor` locked `approvalLimit` and never looked at the role — the lock protected the number, not the authority the number qualifies |
| R2 P2 | …and treated an absent membership as a **zero** ceiling, refusing the ordinary org-owner/admin arm |

These are one mistake, not two: a **fragment** of the standing predicate was
re-stated in the participant instead of asked of the one method that states it.
Re-stating a fragment loses whatever the fragment left out — here, the role arm
and the org arm, in the same six lines.

The fix is not a wider fragment. `approvalAuthorityFor` now calls
`hasProjectRoleStanding(..., { forUpdate: true })` — the rule
`ProjectAccessService.authorize` applies, org arm included, under the lock — and
reads the ceiling from the row that decision already locked.

### The instance inside the closure itself

The third round-2 finding of this shape is the one worth recording, because it
happened **inside a test written to prevent it**.

`FOLD_INPUTS` in `commercial.contract.test.ts` derives §B's mover set from what
the budget fold READS. Task 5C widened its scan from `this.bills.*` to
`this\.(?:bills|deductions)\.` — a hand-written alternation of the owners that
existed that day. Task 6A then taught the fold to read
`this.payments.approvedAmountFor`, and the test said nothing: the new owner was
not in the literal. That is precisely why round 2 found `payment_approval` missing
from the mover set, and why the budget went on reporting a breach an approval had
already cleared.

The file's own header says *"a list of sites was the same mistake one level up."*
The list had simply moved into a regex. **CLOSURE 8**: the owner set is derived
from `CommercialBudgetQuery`'s **constructor** — every injected commercial-owned
collaborator is scanned — so adding one to the constructor is what makes its
calls visible, and there is no second place to remember.

## Root F — a guard read before the lock that makes it authoritative

Two round-2 findings, and they are the same sentence about two layers.

The superseded-certificate check I added in round 1 ran **before** `lockBill`.
Reading a mutable fact ahead of the lock that serializes writes to it means the
guard can pass on something that is no longer true by the time the decision
commits.

Stated honestly, because the packet must not overclaim: `lockProjectReadiness`
is taken by `record`, `approve`, `certify` **and** `supersede`, so the
interleaving Codex describes cannot happen on the service path today, and no
probe could have caught it. That does not make the finding wrong. **A guard whose
correctness rests on a coarser lock being taken somewhere else is not a guard, it
is a coincidence** — and the coincidence is invisible to the next person who adds
a caller. The read moved under the lock, and the durable half is the PG seal above.

`PROBE 18` proves the ordering behaviourally: a second session holds the bill row
and completes a supersession without committing; the payment **blocks** (confirmed
through `pg_blocking_pids`, condition-based, never a fixed sleep); the holder
commits; the payment is then refused. At `8c80152` the guard had already passed
before the block, and no PG seal existed — so the payment committed.

## Scope decisions this round, stated rather than assumed

**The §I override is BUILT here, not deferred.** The cheaper correction was to
refuse the approval-side exception outright and let it ship with 6B — the same
staging this task already uses for the §F status derivation. The plan forbids it
in as many words: *"silently banning it is not an option, because a two-person
practice must still be able to operate"*, and *"a rule's exception record ships
with the rule, not one task later."* The `certifier-may-not-approve` rule ships in
6A, so its override ships in 6A, resting on the same grant mechanism Task 5's
certification half arrived at after its own rounds 7 and 8 — reused, not
re-derived. `grantSodExceptionSchema` gains a `rule` that defaults to the
certification rule, so every Task-5 caller is byte-for-byte unchanged.

**`CommercialPaymentQuery` is a new file for a DI reason, and the reason is the
architecture.** §B requires every writer of a fold input to re-evaluate headroom
in its own transaction, so the payment service must depend on the evaluator — and
the evaluator's budget query must read the `APPROVED` fold. Service and query in
one class closes that into a cycle. Splitting the read out is the shape the
deduction ledger already has: the fold reads a QUERY, the write path calls a
SERVICE.

**`payment_approval` can only ever LOWER exposure**, so it can clear an exception
and never raise one. It is wired and labelled anyway, exactly as `measurement`
is, because the closure's rule is mechanical — and carving out an exception on
the strength of my own arithmetic is what went wrong twice in Task 2.

## Round 3 — root A again, and what the closures did and did not catch

Four findings, **no P1**. Three are root A in its purest form: round 2 added a
thing, and the finding is about the thing standing **next to** it.

| Finding | The sibling |
| --- | --- |
| P2 | `SodGrant.consumedByApprovalId` was added under an append-only path whose seal guards its clause on `consumedByCertificateId IS NOT NULL` — so the new target skipped validation entirely |
| P2 | the `payment_approval` label was admitted by the DB CHECK and omitted from the shared DTO union |
| P2 | `approvalAuthorityFor`'s org arm relies on `forUpdate`, which locks rows that EXIST — and that arm is *defined by* the absence of one |

The fourth is older than this head: `record` has capped at the BILL since the
first commit, so a second payment could overdraw the one approval it is nested
under while the bill total stayed conserved. It is the only finding in three
rounds that is not about something a correction introduced.

### What this says about the split trigger

The paragraph this section replaces committed to splitting 6A if round 3 returned
findings on code round 2 added. Three of four do. **The split is nevertheless the
wrong response, and the reason matters more than the rule.**

That trigger was written to catch one failure mode — *"each correction adds review
surface faster than review retires it"*, the signature that ended PR #279. The
numbers say the opposite is happening: 9 → 6 → 4 findings, 3 → 4 → **0** P1s.
None of the four is a consequence of the unit being too large to reason about;
each is a narrow omission fixed in a few lines, and splitting the PR would not
have surfaced any of them earlier. A rule applied past the condition it was
written for is a ritual. JagPat was asked and chose the same.

What the round-3 findings actually indict is root A's closure, which is still
PROSE: *"when a fix names a direction, a side, or a half, write down what the
opposite one is."* Round 3 is three more instances of exactly that. The mechanical
closure for it is the open item this file carries into 6B — the two roots that
have one (E and the fold-owner set) produced no round-3 findings at all, and root
A, which has only a paragraph, produced three.

### What the closures did do

**CLOSURE 9 caught one of this round's own fixes.** Adding the approval-scoped
refusal to `record` failed the build until `AUTHORITY_GUARDS` named the PostgreSQL
object that refuses the same thing — which is precisely the behaviour root E's
closure exists for, firing on the first new guard written after it landed.

## Where this leaves the PR

Both roots that got a mechanical closure in round 2 stayed silent in round 3.
The one still carrying a prose closure produced three findings. That is a clean
enough signal to act on, and it is the first item of work in 6B rather than a
fourth restructuring of this one.
