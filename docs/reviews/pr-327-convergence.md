# PR #327 — convergence audit

Unit 6.1a, the canonical external party. Two finding-bearing heads:

| Head | Findings | Severity |
|---|---|---|
| `9a03d95` | C1–C8 | 1 × P1, 7 × P2 |
| `5fabb23` | D1–D4 | 4 × P2 |

Twelve findings. This audit is not a list of them — the packet has that. It asks what produced
them, because four distinct roots produced all twelve and three of the roots produced findings in
**both** rounds.

## Root A — the seal was scoped to the caller, not to the data

The largest root: five findings.

| Finding | Scoped to | Should have been scoped to |
|---|---|---|
| C2 | the transaction's own read | the association row, locked |
| C7 | the trigger's own snapshot | the association row, locked |
| C4 | the DELETE the seal was written for | every way a source can LEAVE, including UPDATE |
| D1 | the project being edited | the party, which is org-scoped |
| C8 | the row being protected | the operation the row must still support |

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

C2, C7 and C4 are the same error against *time* rather than *space*: a count taken before a
competing write, a snapshot taken before a competing commit, a trigger armed for one of the two
ways its subject can move. In each, the seal was written against the situation in front of the
author.

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

Three findings, and the most instructive shape.

- **D2** — the source→association key cascaded. Deleting the association therefore deleted its own
  justification, after which the deferred check counted zero sources and returned **satisfied**.
  The check was reached, ran, and passed, on precisely the state it exists to forbid.
- **C5** — `promotedOrgId` was frozen one-way with no reference check. A typo written by a repair
  is then frozen *forever*, because correcting it IS the transition the freeze refuses. Guard plus
  gap equals an unrepairable row; neither alone does that.
- **C8** — freezing the binding's party key to protect the copy made the legitimate repoint
  impossible in either order, so 6.1b could not merge exactly the firms most worth merging: the
  ones already trading on a project.

> **Rule.** After adding a guard, ask what the guard now makes impossible and what it now makes
> invisible. A protection that forbids the operation it protects, and a check that its own cascade
> can satisfy, are both failures of the same question not being asked.

## Root D — probes that did not test what they claimed

Not review findings — these I found myself, and they are recorded because the pattern recurred
four times in one unit and would otherwise read as diligence.

| Probe | What it claimed | What it did |
|---|---|---|
| C2, first draft | the release serializes | inlined the count, bypassing the method under test |
| rerun proof, fixture | the migration aborts on a blank name | failed on a NOT NULL column, planted nothing, reported a pass |
| rerun proof, assertion | no DDL blocked the retry | matched `already exists` anywhere, reading the `IF NOT EXISTS` **notice** as failure |
| rerun proof, scenario | the migration is rerunnable | aborted at the top diagnostic, so no DDL was ever reached |
| upgrade proof, after C1–C8 | the new seals hold | 528 assertions before and after — none of them touched the new seals |

The through-line: **each was a green signal produced without exercising the thing under test.** A
passing probe and a probe that passes *for the right reason* are indistinguishable from the
outside, which is why the fifth one — an unchanged assertion count across a correction — is the
one worth keeping as a habit. If a gate's output does not move when the code does, the gate is not
watching the code.

> **Rule.** Before trusting a probe, make it fail. If you cannot make it fail, you have not
> established that it can.

## What this changes for 6.1b

6.1b is the operator merge/repoint command, and three of these roots are aimed straight at it:

1. Its refusals must be scoped to the **party** (org-wide), not to the project the operator names —
   Root A, and D1 was a preview of exactly this bug in a smaller command.
2. Its ascending-`id` root locks must be asserted by a barrier that has been **seen to fail** —
   Root D, and C7 stands as a caution: I could not reproduce its interleaving and applied the lock
   on reasoning alone, which is a weaker footing than 6.1b should accept for its own.
3. Every constraint it relies on must exist in `schema.prisma`, not only in its migration —
   Root B, now enforced for the party models by `schema-migration-drift.test.ts`.

## Honest accounting

- **C7 has no red evidence.** PostgreSQL serialised the two deferred checks on every attempt. The
  lock is applied because the mechanism is sound; the probe passes at both heads and is a
  regression guard, not proof. Stated in the packet, the commit message and here.
- **Root B's wider instance is unfixed.** Phases 1–5 carry real schema/migration drift. Scoped out
  deliberately, named here so it is not lost.

Review-Convergence: complete
