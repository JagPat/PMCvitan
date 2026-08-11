# PR #327 — convergence audit

Unit 6.1a, the canonical external party. Four finding-bearing heads:

| Head | Findings | Severity |
|---|---|---|
| `9a03d95` | C1–C8 | 1 × P1, 7 × P2 |
| `5fabb23` | D1–D4 | 4 × P2 |
| `31babd0` | E1–E3 | 3 × P2 |
| `87ac4f5` | F1 | 1 × P2 |

Sixteen findings. This audit is not a list of them — the packet has that. It asks what produced
them, because four roots produced all sixteen, and three of the four produced findings in EVERY
round. A root that recurs after being named is the strongest signal in this document: it means the
naming was not yet specific enough to act on.

**F1 is the sharpest instance of that, because it is Root A landing on the seal that closed
Root C.** E1 added the origin-side obligation; F1 says that obligation was armed only against the
tables an origin is *written* on, while it can equally be broken by removing the source. Same
error, one round later, inside the fix for the round before. It is written up in full under Root A,
not given a root of its own, because inventing a fifth root would hide the recurrence that is the
actual finding.

## Root A — the seal was scoped to the caller, not to the data

The largest root: eight findings, in all four rounds.

| Finding | Scoped to | Should have been scoped to |
|---|---|---|
| C2 | the transaction's own read | the association row, locked |
| C7 | the trigger's own snapshot | the association row, locked |
| C4 | the DELETE the seal was written for | every way a source can LEAVE, including UPDATE |
| D1 | the project being edited | the party, which is org-scoped |
| C8 | the row being protected | the operation the row must still support |
| E2 | the count's own snapshot | the party root, locked against a concurrent attach |
| E3 | the row as read BEFORE the transaction | the row as it is INSIDE the transaction |
| F1 | the tables an origin is WRITTEN on | every table whose write can break the obligation |

**D1 is the purest statement of it.** `ExternalParty.name` is one row, one name, read by every
project the firm reaches. The sole-source check counted sources `WHERE projectId = <the project
being edited>` — the scope the *caller* had, not the scope the *data* has. So once 6.1b repoints a
project-A company onto a party already bound on project B, project A sees one local source, calls
itself the sole evidence, and renames the firm project B depends on.

The check was correct for a world in which parties are project-scoped. Parties are not
project-scoped; that is the entire point of §A.

> **Rule.** A check's scope is a property of the DATA it protects, never of the caller that
> happens to invoke it. When those two differ, the caller's scope is always the smaller one, and
> the gap is always silent.

C2, C7, C4, E2 and E3 are the same error against *time* rather than *space*: a count taken before a
competing write, a snapshot taken before a competing commit, a trigger armed for one of the two
ways its subject can move, a row read before the transaction that protects it. In each, the seal
was written against the situation in front of the author.

**E3 deserves singling out because it is Root A applied to my own fix.** D1's correction moved the
rename's scope from the project to the party — and still passed the party id from a read taken
*outside* the transaction. The scope was corrected in space and left wrong in time. Widening a
check without asking when its inputs were read is half a fix.

### F1 — the same error, one round later, inside the previous round's fix

E1's seal says: a live origin must have a source. I attached it to `ProjectCompany` and
`ProjectVendor`, because writing an origin is how you come to owe a source. That is the scope of
the **author's** situation, not of the **obligation**. An obligation between two rows can be broken
from either end, and the other end — removing the source — ran only the *association* check, which
asks a different question entirely:

| Check | Question | Answer when the company's source is deleted |
|---|---|---|
| association | does `(project, party)` have ≥1 source, of **either** kind? | yes — the vendor's | ✓ satisfied |
| origin | does **this company** have its own source? | no | never asked |

So for a firm reached both ways on one project — the main contractor who also supplies, an entirely
ordinary arrangement — deleting the company's source is accepted. The `ProjectCompany` is left
naming a party nothing records: exactly the state E1 exists to forbid.

And it is not merely untidy, because of a detail in the fix for D1.
`renamePartyForSoleSource` computes `others = sources - 1`. That `- 1` reads *"one of these rows is
me"* — an inference that is true only while the caller **has** a source. Strip it and a company
with no evidence at all counts the vendor's row as its own, concludes it is the sole justification,
and renames the firm the binding depends on. D1 was the same rename authorised by the wrong
*scope*; F1 is the same rename authorised by a *phantom*.

> **Rule.** An invariant between two rows can be violated from both ends. Attaching its check to
> the end you happened to be writing is not enforcing it — it is enforcing it against yourself.

The fix is one function fired from all four tables, deriving its subject from `TG_TABLE_NAME`
(`NEW` on an origin write, `OLD."projectCompanyId"`/`OLD."projectVendorId"` on a source leaving),
rather than a second function for the removal side. Two copies of one obligation are two things
that can drift, and the E1/F1 pair is a demonstration of what that drift costs.

Worth recording that the check's shape is what keeps it off the legitimate path: it asks *"is the
origin sourced now?"*, not *"did this row justify something?"*. Deleting a company cascades its
source away, and at COMMIT there is no origin left to owe anything — so the ordinary deletion still
works. A check written the other way would have refused every company removal in the product, which
is Root C's trap (the guard forbidding the operation it protects) and was live in this codebase two
rounds ago as C8.

## Root B — a constraint in SQL is not a constraint

D3 and D4. The correction added `ExternalParty_promotedOrgId_fkey` and switched the binding's
party key to `ON UPDATE CASCADE` in hand-written SQL, and left `schema.prisma` describing neither.

What makes this worth a root rather than a slip is **what failed to catch it**. Both survived:

- `pnpm check` (EXIT 0)
- the full integration suite (88 files, 1081 tests)
- `upgrade-proof.sh` (534 assertions)
- the C1 rerun proof, which compares a retried schema against a clean apply

Every one of those runs against the **migrated database**, where the constraints genuinely are
present. None of them reads `schema.prisma`, which is what the *next* generated migration diffs
against. The seal was real and simultaneously one `prisma migrate dev` from being dropped.

> **Rule.** A gate that only ever observes the migrated database cannot see schema drift. If the
> model is the source of truth for future migrations, something has to assert against the model.

Closed by `schema-migration-drift.test.ts`, which pins each party seal on **both** sides — the
live `pg_constraint` row and the declaration in `schema.prisma`.

A blanket `prisma migrate diff` assertion was written first and rejected: it reports substantial
pre-existing drift across Phases 1–5 (composite keys this repository writes by hand and Prisma
renders differently), so it would have failed this PR on five phases of unrelated history.
**That drift is a real finding about the repository and is recorded here rather than silently
dropped** — it deserves its own unit, and baselining it under an exemption list would have been
Root A one level up: scoping the check to what was convenient.

## Root C — the guard's own mechanism opened the hole

Four findings, and the most instructive shape.

- **D2** — the source→association key cascaded. Deleting the association therefore deleted its own
  justification, after which the deferred check counted zero sources and returned **satisfied**.
  The check was reached, ran, and passed, on precisely the state it exists to forbid.
- **C5** — `promotedOrgId` was frozen one-way with no reference check. A typo written by a repair
  is then frozen *forever*, because correcting it IS the transition the freeze refuses. Guard plus
  gap equals an unrepairable row; neither alone does that.
- **C8** — freezing the binding's party key to protect the copy made the legitimate repoint
  impossible in either order, so 6.1b could not merge exactly the firms most worth merging: the
  ones already trading on a project.

- **E1** — the obligation "this firm is reachable here" is three statements, and only two were
  sealed. A SOURCE needs an origin (the origin FK); an ASSOCIATION needs a source (the sourced
  trigger). Nothing required an ORIGIN to have a source. Every trigger hung off the two tables a
  hand-written insert simply never writes, so a directory row could name a party and commit with
  no association at all — a firm the directory plainly has and the resolver cannot see.

> **Rule.** After adding a guard, ask what the guard now makes impossible and what it now makes
> invisible. A protection that forbids the operation it protects, and a check that its own cascade
> can satisfy, are both failures of the same question not being asked.

> **Rule (E1).** When an invariant spans N tables, enumerate the N implications and check each has
> an owner. Sealing "A implies B" and "B implies C" leaves "C implies B" unguarded, and the hole is
> exactly where nobody writes through the service.

**The most direct evidence E1 was reachable is that I wrote an instance of it.**
`phase2-snapshot-shape.test.ts` created a `ProjectCompany` with a party and no source — by hand,
two rounds before the seal that now refuses it, while I was fixing a different finding. The fixture
now builds the full chain.

## Root D — probes that did not test what they claimed

Not review findings — these I found myself, and they are recorded because the pattern recurred
seven times in one unit and would otherwise read as diligence.

| Probe | What it claimed | What it did |
|---|---|---|
| C2, first draft | the release serializes | inlined the count, bypassing the method under test |
| rerun proof, fixture | the migration aborts on a blank name | failed on a NOT NULL column, planted nothing, reported a pass |
| rerun proof, assertion | no DDL blocked the retry | matched `already exists` anywhere, reading the `IF NOT EXISTS` **notice** as failure |
| rerun proof, scenario | the migration is rerunnable | aborted at the top diagnostic, so no DDL was ever reached |
| upgrade proof, after C1–C8 | the new seals hold | 528 assertions before and after — none of them touched the new seals |
| upgrade proof, after E1–E3 | the new seal holds | 534 before and after: **the same lesson, one round later** |
| E2/E3, first drafts | the races are closed | committed T2 before T1 began, so both passed at the unfixed head |
| the two teardown fixtures | they set up what the app sets up | wrote the party chain across FOUR transactions, a state no service path produces |
| F1 control, first draft | the legitimate removals still commit | asserted a raw delete of the LAST binding, which no service performs and the association seal correctly refuses |

The through-line: **each was a green signal produced without exercising the thing under test.** A
passing probe and a probe that passes *for the right reason* are indistinguishable from the
outside, which is why the fifth one — an unchanged assertion count across a correction — is the
one worth keeping as a habit. If a gate's output does not move when the code does, the gate is not
watching the code.

> **Rule.** Before trusting a probe, make it fail. If you cannot make it fail, you have not
> established that it can.

**This root repeated after being written down**, which is the finding about the finding. The
E-round upgrade-proof extension was skipped for exactly the reason the C-round one had been — the
suite was green, so the gate looked done — and the E2/E3 probes passed at the unfixed head for
exactly the reason C2's first draft had. Naming a habit is not the same as having it; the
assertion-count check (does the gate's output MOVE when the code moves?) is the mechanical version
and is now the thing actually relied on.

**The F round is the first where it was applied before the claim rather than after the reminder**,
so it is worth stating what "applied" concretely meant, since the previous two rounds show that
intending it is not enough:

1. the probe was written and run at `87ac4f5` **first**, and failed with `expected the write to be
   REFUSED, and it was accepted` — the finding reproduced, not merely believed;
2. the suite count **moved**, 12 → 14, and the upgrade proof **moved**, 536 → 540;
3. the migration was then `git stash`ed and the upgrade proof re-run, which turned exactly the
   three new F1 rejection assertions red and left the positive control green — so the new
   assertions are demonstrably watching the new seal, which is the thing 528→528 and 534→534 could
   not tell me;
4. the one false step (the control asserting a delete no service performs) was caught by running
   it, in the same minute, and is in the table above rather than quietly repaired.

Step 3 is the one that was missing twice. An assertion count that moves proves new assertions were
added; only reverting the fix proves they test it.

## What this changes for 6.1b

6.1b is the operator merge/repoint command, and three of these roots are aimed straight at it:

1. Its refusals must be scoped to the **party** (org-wide), not to the project the operator names —
   Root A, and D1 was a preview of exactly this bug in a smaller command.
2. Its ascending-`id` root locks must be asserted by a barrier that has been **seen to fail** —
   Root D, and C7 stands as a caution: I could not reproduce its interleaving and applied the lock
   on reasoning alone, which is a weaker footing than 6.1b should accept for its own.
3. Every constraint it relies on must exist in `schema.prisma`, not only in its migration —
   Root B, now enforced for the party models by `schema-migration-drift.test.ts`.
4. For every obligation it introduces, both ends must be enumerated and each given an owner —
   Root A via F1. 6.1b's merge moves sources between parties, which is precisely the operation that
   can satisfy one end of an obligation while breaking the other, and it is the operation E1's seal
   was blind to.

F1 also leaves 6.1b a concrete piece of work rather than only a caution.
`renamePartyForSoleSource` still infers the caller's own evidence from `sources - 1`. That
inference is now *true*, because the origin obligation is sealed on both ends and a live company
always has exactly one source — but it is true by distant consequence rather than by construction.
6.1b should pass the caller's source identity and count the others directly. It is not corrected
here because it is not what makes the state unreachable, and widening this head beyond the finding
is how a fourth round becomes a fifth.

## The evidence obligation is PER HEAD, and I proved that the hard way

The E-round correction carried this audit and the `Review-Convergence: complete` trailer. Then the
integration suite found two teardown defects, I fixed them in a follow-up commit, pushed — and the
gate refused the head: *"3 finding heads require convergence evidence; missing trailer and packet."*

It was right. `assessConvergence` reads `headMessage` and `changedFiles` — **this commit's** message
and **this commit's** files. Convergence evidence is not a thing a branch accumulates; it is a
property the head must carry, every time the head moves. I satisfied the obligation once and
assumed it stayed satisfied, which is the same shape as the earlier trailer bug where a blank line
stopped it parsing: **a requirement met at one moment, assumed to hold at the next.**

That is Root A in the process rather than the code — a check scoped to the moment the author was
looking at, rather than to the thing it protects.

> **Rule.** After any push that moves the head, re-ask every per-head obligation. "I already did
> that" is a claim about a different commit.

## The two teardown fixtures, and why they belong in Root D

E1's seal — an origin must have a source — turned two fixtures red, and both were mine:

- `phase2-snapshot-shape.test.ts` built the party chain as four separate top-level Prisma calls.
  Four calls are four transactions, so the association committed alone, before the source existed.
- the same suite's `afterAll` deleted the company in its own transaction, cascading the source away
  and orphaning the association.

Both were the seal working. `CompaniesService.add` writes all four rows together and `remove`
deletes-and-releases together, precisely because the checks are DEFERRED — and deferred means
"checked at the end of THIS transaction", not "checked eventually". A fixture that skips the
transaction is not reproducing what the application does; it is constructing a state the
application cannot reach and then asserting against it.

Worth noting how they presented: `Test Files 1 failed | Tests 28 passed`. Every test green, the
file red — a shape that is only ever a hook, and the second time this unit that signature pointed
straight at the cause.

## Honest accounting

- **C7 has no red evidence.** PostgreSQL serialised the two deferred checks on every attempt. The
  lock is applied because the mechanism is sound; the probe passes at both heads and is a
  regression guard, not proof. Stated in the packet, the commit message and here.
- **Root B's wider instance is unfixed.** Phases 1–5 carry real schema/migration drift. Scoped out
  deliberately, named here so it is not lost.

Review-Convergence: complete
