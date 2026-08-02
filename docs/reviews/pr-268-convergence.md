# Convergence audit — PR #268 (Phase 5 Task 1: the commercial commitment attribution)

Required by `CLAUDE.md` after two finding-bearing heads.

| Head | Findings | |
| --- | --- | --- |
| `09af9e5` | 5 | 2×P1 — activation takes no PO lifecycle lock; authority read from the legacy `User.role` column |
| `42fc16c` | 2 | 1×P1 — the standalone re-attribution takes no PO lifecycle lock |

5 → 2 is a decline, but the number is not the interesting part of this audit.
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

`pnpm check` EXIT 0 · integration 73 files / 720 tests on a TRUNCATE-cleaned database
(`prisma migrate reset` is refused here as a destructive action needing human consent —
an earlier claim of a "reset database" in this PR's packet was wrong and is corrected) ·
`phase5-t1-commercial.test.ts` 18/18 · `upgrade-proof.sh` PASSED (231 assertions) ·
`test:e2e:api:allmodules` 35/35 · review-scope justified-large with the complete
invariant matrix.
