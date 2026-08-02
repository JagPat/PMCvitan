# Convergence audit — PR #268 (Phase 5 Task 1: the commercial commitment attribution)

Required by `CLAUDE.md` after two finding-bearing heads.

| Head | Findings | |
| --- | --- | --- |
| `09af9e5` | 5 | 2×P1 — activation takes no PO lifecycle lock; authority read from the legacy `User.role` column |
| `42fc16c` | 2 | 1×P1 — the standalone re-attribution takes no PO lifecycle lock |
| `b179c2d` | 2 | 2×P2 — activation admits ARCHIVED projects; amendment cost heads keyed by an id the caller cannot know |
| `c7762e0` | 3 | 3×P2 — project row not locked; membership not locked; audit attributed to the raw operator string |

5 → 2 → 2 → 3, P1s 2 → 1 → 0 → 0. The count is not the interesting part of this
audit, and by round 4 neither is the trend — see "What four rounds have actually
been about" below.
**The P1 on the second head is the SAME RULE as the P1 on the first head, at a
different site.** That is the finding behind the findings, and it is the one this
document exists to close.

## The root cause: I fixed a rule at the site the reviewer named

Round 1's F1 said: *activation's live-line reads take no lock, so a concurrent
`pos.issue` can slip between the read and the capability write.* I fixed
activation. Round 2's P1 said: *the standalone re-attribution's active-row
precondition takes no lock either.*

Both are one rule:

> **Every command that WRITES a `CommitmentAttribution` must serialize with the PO
> lifecycle**, because the set of LIVE PO lines is what the attribution invariant is
> stated over, and every PO command already holds `lockProjectReadiness`.

I had that rule available. `docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md`
§0b is *literally a table of rules and every site that must obey them*, written
because five of round 6's ten findings on PR #252 were this exact shape. Its second
row is "A status a guard depends on is read under that row's lock". I read that
section, quoted it in the PR body about a *different* rule (the eight lifecycle
sites), and then failed to apply the same discipline to the rule the reviewer had
just handed me.

**The fix that only patches the named site is not a fix; it is the next finding.**
That is why round 2 happened, and it is the only thing worth generalising from this
PR.

## What changed structurally, not just at the second site

Not two point fixes. The closure is now **mechanical**:

`apps/api/src/common/readiness-lock-coverage.test.ts` — the repository's existing §A
command-level lock enumeration — gains both commercial write paths and its count
moves 34 → 36. A third commercial command that writes an attribution without the
lock now fails **that test**, not a later review round.

That file was already the right home for this and I did not use it when I shipped
the first head. `commercial.costHead.define` is deliberately *absent* from the
enumeration, and the comment says why: it writes no attribution. A closure list that
names sites which do not need the rule is as useless as one that misses sites that
do.

| Probe | Pins |
| --- | --- |
| `CODEX F1` | activation is coherent against a concurrent `pos.issue` |
| `CODEX R2-F1` | a concurrent `pos.cancel` can never leave a dead line attributed, in either ordering |
| `CODEX R2-F1 (barrier)` | re-attribution genuinely **BLOCKS** on the lock — condition-based via `pg_stat_activity`, never a sleep |
| the §A enumeration | a future commercial write path without the lock fails CI |

## The barrier probe was wrong twice before it was right, and that is recorded

The `R2-F1 (barrier)` probe failed twice while I was writing it, for two different
reasons, and both are worth stating because a green barrier that measures nothing is
worse than no barrier:

1. **The holder's transaction expired.** Prisma's interactive-transaction default is
   5 s; the barrier polled for 10 s. The holder rolled back, released the lock, and
   the racing command sailed through — so the *absence* of a waiter looked like a
   missing lock rather than a broken harness.
2. **The holder was never proven to hold the lock.** The first spelling started the
   holder and the racing command without waiting for acquisition, so the two simply
   raced. When the racing side won, it completed and no waiter ever existed.

The second is the dangerous one: had the timing gone the other way it would have
passed, and I would have shipped a "deterministic barrier" that was a coin flip. The
probe now waits on an explicit `acquired` signal before starting the racing command.

I diagnosed both by running a standalone two-client script against live PostgreSQL
and reading `pg_stat_activity` directly, rather than assuming — the wait state is
`wait_event_type = 'Lock'`, `wait_event = 'advisory'`, exactly as the helper expects.

## Round 2's second finding — the same principle from the ownership side

R2-F2 (P2) is not a lock finding, but it is the same *category*: a rule stated in one
place and not applied where it also holds. `OrgsParticipant`'s own file header says
it:

> `Membership`, `Project` and `OrgMembership` are orgs-owned. A foreign module that
> needs to know whether a user is accountable on a project must not query those
> tables itself — **not being read-encapsulated makes a read representable, not
> legitimate; the OWNER states the rule.**

I routed the *standing* question through that participant and then resolved the
*identity* with a direct `tx.user.findFirst` from the commercial module. `User` is
orgs-owned too. The boundary analyzer did not flag it because `user` is not
read-encapsulated — which is precisely the case that header was written about.

Fixed by adding `OrgsParticipant.resolveUserIdentity`, so which column is the
identity key, whether email is unique, and whether a disabled account resolves are
orgs' semantics to state once rather than commercial's to assume.

## What did NOT drift

The §C data model is unchanged across both rounds. No finding touched the schema,
the migration, the XOR CHECK, the partial uniques, the append-only trigger or the
cost-head key freeze — and `20270401000000_phase5_t1_commercial` is byte-for-byte
what the first head shipped. Every finding in this PR has been in the **service
layer's concurrency and ownership boundaries**, not in what the database enforces.

That distinction matters for the remaining review: the part of this change that is
hardest to correct after merge (deployed migration bytes, PostgreSQL seals) has drawn
zero findings across two rounds, and the part that has drawn all seven is the part a
later commit can still fix.

## Round 3 — the same two families, and what that says

Neither round-3 finding is new in KIND, and that is the honest reading:

| Finding | Family | First seen |
| --- | --- | --- |
| activation admits archived projects | **a rule the request path enforces, not enforced on the operator path** | round 1 (F2: live standing, not `User.role`) |
| activation read `Project` directly | **an orgs-owned table read from commercial** | round 2 (R2-F2: `User` read directly) |
| amendment heads keyed by an unknowable id | a NEW family — a contract defect, not a boundary or lock one | round 3 |

The first two are the *operator-path* version of a question I have now been asked
three times: **the activation path has no request token, so every guard
`ProjectAccessService.authorize` applies for free must be re-established
explicitly, and every orgs-owned fact it needs must come from orgs.** Round 1 gave
it standing. Round 2 gave it identity. Round 3 gave it project operability. Those
are the three things `authorize` checks, and it took three rounds because I fixed
them one at a time as each was named — the exact failure this audit's first section
already indicted, appearing again while the audit that indicted it was in the diff.

So the closure this time is stated as a list rather than a patch. `authorize`
refuses on: archived-or-missing project, then inactive membership, then role. The
activation path now asks orgs all three — `isProjectOperable`, then
`hasProjectRoleStanding` with the policy's role set — before any write. There is no
fourth check in `authorize` to miss; I read it rather than inferring it.

**R3-F2 is a different and more useful kind of finding**, and worth separating from
the boundary work: the amendment cost-head map was keyed by `PurchaseOrderLine.id`
of the NEW version — rows generated inside the amend transaction. No caller could
ever supply those ids. The consequence was not a race or a leak but a **blocked
feature**: adding a line during a commercial amendment always failed "name the cost
head", and a carried line silently kept its old head, so reclassification-at-amend
was unreachable. My probes did not catch it because every one of them amended a
line that already existed and asserted the head CARRIED — which passed for the
wrong reason. The probe now asserts a head that CHANGES at amend, which the old
keying could not produce. The key is `requisitionLineId`, which the caller already
supplies in the same request; issuance keeps `poLineId` because at issue the lines
exist and are addressable.

That one is on my test design, not my reading of a rule: an assertion that a value
is UNCHANGED cannot distinguish "carried correctly" from "never looked up".

## Round 4 — and what four rounds have actually been about

Every round-4 finding is in the SAME place as rounds 2 and 3: the §L activation
path. The tally is now unambiguous.

| Round | Findings in the activation path | Elsewhere |
| --- | --- | --- |
| 1 | 3 (lock, live standing, authorize-before-empty-backfill) | 2 |
| 2 | 1 (identity through the owner) | 1 |
| 3 | 1 (archived projects) | 1 |
| 4 | **3** (project row lock, membership row lock, audit identity) | 0 |

**8 of 12 findings are one surface**, and the pattern is not "each fix was wrong".
Each fix was correct and each next finding was correct too. The pattern is that
**an operator CLI is being held to the full concurrency and authority discipline of
a request path, and it gets there one row lock at a time.**

A request gets all of this for free. `ProjectAccessService.authorize` runs on every
request and checks project-archived, then active membership, then role; the command
transaction takes `lockProjectReadiness` before touching anything; the actor is a
resolved `AuthUser`. `capability:enable` has none of that, so every one of those
guarantees has had to be rebuilt explicitly, and the reviewer has correctly found
them missing one at a time because I added them one at a time.

Round 4's three findings are the *concurrency* half of the same list round 3 closed
for *existence*: it is not enough to check archived and standing, those reads must
be taken under locks that serialize with the writers that can change them —
`Project.archivedAt` (archiving takes no readiness lock) and `Membership.role`
(`MembersService.updateRole` takes no readiness lock, unlike activation and removal
at lines 89 and 130 of the same file, which do).

So the closure is now stated as a complete table rather than a running list, and the
lock ordering is stated with it because round 4 exposed that too: round 3 put the
operable check ABOVE `lockProjectReadiness`, and round 4's row lock made that
inversion real. `readiness-lock.ts` requires the advisory lock to be the FIRST
statement of its transaction, "ahead of any row locks … so no lock-ordering deadlock
is possible". Every row lock in activation now comes after it.

| What `authorize` gives a request | How activation gets it | Locked against |
| --- | --- | --- |
| project not archived | `OrgsParticipant.isProjectOperable` | the `Project` row (`FOR UPDATE`) |
| active membership + role | `hasProjectRoleStanding(..., { forUpdate: true })` | the `Membership` / `OrgMembership` rows |
| a resolved actor | `OrgsParticipant.resolveUserIdentity` | — (identity is immutable here) |
| readiness serialization | `lockProjectReadiness`, taken FIRST | the advisory lock |

**The honest question this raises, which is the owner's and not mine.** The reason
this surface keeps producing findings is that it is an operator CLI doing work the
application otherwise only does behind `authorize` and a command transaction. The
alternative shape — activation as an ordinary authenticated command, with the CLI
reduced to calling it — would inherit all four rows of that table by construction
instead of reconstructing them. That is a design change to a cleared mechanism
(`capability:enable` is how `materials` and `labour` were both activated), so it is
not something to make mid-review. It is recorded here as the thing to decide before
Task 2 rather than discovered again in round 5.

`forUpdate` is deliberately OPT-IN and defaulted off: the cleared Phase-4 T3 repair
engine already calls `hasProjectRoleStanding`, and silently changing its locking
would change behaviour nobody asked to change. The limitation is stated in the code
rather than glossed: `FOR UPDATE` locks rows that EXIST, so it closes the downgrade
race (an UPDATE of a present row); it does not serialize a membership INSERTED after
the read, a direction that can only grant authority the operator lacked at decision
time.

## The commitment for any further round

Findings continue to be **batched** — read every one before pushing a correction —
and each is fixed with a reproduce-first probe that was RED at the reviewed head.

And the specific commitment this audit exists to make: **when a finding names a rule,
the correction closes the rule's whole site list, not the named site.** Where the
repository has a mechanical enumeration for that rule, the correction extends it, so
the closure survives me. That is what `readiness-lock-coverage.test.ts` now does for
the attribution-write rule.

Nothing here is dismissed, deferred or downgraded. `guardAgainstCurrentHeadFinding`
still fails closed on every current-head finding, and the `codex-current-head` gate
still admits only a head Codex returns clean on.

## Gates

`pnpm check` EXIT 0 · integration 73 files / 722 tests on a TRUNCATE-cleaned database
(`prisma migrate reset` is refused here as a destructive action needing human consent —
an earlier claim of a "reset database" in this PR's packet was wrong and is corrected) ·
`phase5-t1-commercial.test.ts` 23/23 · `upgrade-proof.sh` PASSED (231 assertions) ·
`test:e2e:api:allmodules` — reported honestly: 34/35 locally on this head, with the
FAILING TEST DIFFERING between runs (`inspections-module-query`, then `project-scope`
twice) and each passing when the suite is re-run or re-ordered. All are named entries
in the Maintenance queue's documented flake list, the diff contains zero web,
inspections or project-scope product code, and the same suite ran 35/35 on the three
earlier heads of this branch — including the two that already carried the shell
change. CI's own `api-e2e` job is the arbiter and has been green on every head.
Review-scope justified-large with the complete invariant matrix.
