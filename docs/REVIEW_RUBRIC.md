# Review rubric — whole-file self-review before a push

Read [POLICY.md](POLICY.md) first; this rubric is how an author reviews their own diff and how a
reviewer reads it. Run it on the WHOLE of every touched file, not on the changed hunks (five of
#590's six round-2 findings sat in untouched lines); repeat until a pass finds nothing, then push once.

## The six invariants (one row each in the PR's invariant matrix)

| Invariant | Ask of every touched file |
| --- | --- |
| authorization-tenancy | Does every read and write bind the project and org the row belongs to? Can a composite key be satisfied across projects? |
| civil-time-lifecycle | Which clock decides "in this transaction" or "at commit"? Is `xmin` read as a transition anywhere? |
| concurrency-idempotency | Is the row locked BEFORE its status is read? Is a re-run a no-op? Do deferred triggers fire in the order the writer assumes? |
| data-integrity-conservation | For every fact: is its counterpart (event, audit row, transition) COUNTED in the same transaction, on every writer branch, not found by type? |
| offline-reconciliation | Does a previous-release or prior-generation writer still commit through the drain? Does a replayed command produce one fact? |
| ui-server-parity | Does the client render exactly what the server now refuses or admits? |

## The eight finding families and their probes

Each family names the probe that turns the question into a failing test first (helpers in
`apps/api/test/invariants/probes.ts`, shown RED then GREEN in `process-invariant-probes.test.ts`;
`lockOrderProbe` arrives in its own unit, `reform-1b`).

| Family | The question | Probe |
| --- | --- | --- |
| missing-counterpart | A fact written with NO event, NO audit row or NO transition: who refuses it at commit? | `pairingMatrix` negative `missing-counterpart`, owed by every writer branch |
| identity / recipient / actor binding | Does the event name THIS row, target THIS recipient and carry THIS actor? A same-type event for the same decision is not this fact's. | `pairingMatrix` negatives `wrong-identity`, `wrong-audience`, `wrong-actor`, owed by every writer branch (`REQUIRED_NEGATIVES`; a writer's own negatives add to them, never replace them) |
| no-op transition | Does a `SET x = x` touch satisfy a rule that means "moved"? Transitions are recorded where `OLD` is in hand. | `noOpUpdateProbe` |
| shared-function / alternate-writer coverage | A trigger installed on two tables, or a key with two writer branches: does EACH branch have its own arm, in BOTH write orders? | `pairingMatrix` over the compiled (key, writer branch) pairs |
| lock order / concurrency | Is the guard's lock taken before its read, and held through its mutation? Show the interleaving. | `lockOrderProbe` (arrives in `reform-1b`: a real lock wait, never a sleep; a competing writer held pending through the guard's transaction, its order asserted) |
| migration immutability / replay | Are deployed bytes unchanged (POLICY: deployed migrations are immutable)? Does the new migration apply twice? | bytes: `git diff --name-only <base>...HEAD -- apps/api/prisma/migrations/` names only NEW directories (a reviewer-read rule until the migration-manifest unit lands its CI check); replay only: `rerunTwice` |
| whitespace / input constraints | Does a non-blank CHECK reject the whole ASCII whitespace set? | `whitespaceCheckProbe` |
| previous-generation compatibility | Does the still-serving release's exact bundle commit at the prior generation? | `pairingMatrix` `priorWriter` |

## The self-review pass

1. List every writer branch beneath each flagged key (the compiled catalog is the population, not
   your memory). For each: fact, audit row, transition, event, and the seal that refuses each
   absence. A branch with no seal named is a finding.
2. For each binding, name the dimensions: identity, recipient, actor, project, generation. A
   dimension not bound is a finding, whether or not a reviewer has asked for it yet.
3. For each `xmin` read: is it a write, or a transition? Only a recorder with `OLD` proves a move.
4. For each lock: which statement takes it, which statement reads the status, in that order?
5. For each new migration: `git diff --name-only <base>...HEAD -- apps/api/prisma/migrations/` names
   only new directories (deployed bytes never change, POLICY); `rerunTwice` proves replay, never bytes.
6. For each CHECK on user text: `btrim(x, E' \t\n\x0B\f\r')`, never `btrim(x)`.
7. Run only the focused suites the diff touches (a PostgreSQL suite: `pnpm --filter api exec vitest
   run --config vitest.integration.config.ts <file>`); the full battery runs in GitHub. Push once.

## Review output expectations

- First reviewed head: one comprehensive pass over the entire diff and all six invariants, reported
  together. Correction heads: the delta, every prior finding, and the adjacent invariants the
  correction can affect; continue on the same PR. Rank by severity (correctness, data integrity,
  ordering first), give the concrete failure (inputs or interleaving), no style nits beside
  substantive findings, say plainly when there are none, cite the POLICY rule violated.
- A family-wide correction answers the family, not the line: a finding on one dimension of a
  binding means auditing every dimension on every branch before pushing.
- Dispute path: reply on the thread with a concrete counterexample (inputs, interleaving or a
  test). No label and no gate state reads a dispute: the finding blocks that head until a new
  head answers it or the repository owner rules on the thread. The cap is not dismissal.
