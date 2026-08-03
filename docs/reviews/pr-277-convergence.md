# PR #277 — architectural convergence audit (platform command-receipt seal)

Three finding-bearing heads, eight Codex findings, on a PR whose whole diff is one trigger. Per
`CLAUDE.md` this stops being another isolated patch: it names the ROOT the findings share and leaves
a mechanical closure behind.

| Head | Findings | |
|---|---|---|
| `f69a5fe` | 3 | 2×P1, 1×P2 |
| `a21d4b4` | 2 | 2×P2 — one of them the same set I had just fixed once |
| `b9e8e53` | 3 | 3×P2 — the diagnostic and the trigger disagreeing for the THIRD time, plus a guard that was itself a no-op |

| # | Head | Sev | What was wrong | The SET it belonged to |
|---|---|---|---|---|
| 1 | `f69a5fe` | P1 | The seal did not close the forgery the PR said it closed | — (see root F) |
| 2 | `f69a5fe` | P1 | Legacy incoherent receipts were WARNED about, not aborted on, under reasoning that was simply false | — (see root G) |
| 3 | `f69a5fe` | P2 | The new suite left its fixture in the shared serial database | suites that create rows in the shared DB |
| 4 | `a21d4b4` | P2 | The trigger rejected a result on `failed` and said nothing about its absence on `succeeded` | the two halves of one rule |
| 5 | `a21d4b4` | P2 | Three MORE proof scripts plant `succeeded` receipts directly; the T45 repair proof would fail | scripts that plant command receipts |
| 6 | `b9e8e53` | P2 | The new `succeeded`-needs-a-result rule went into the trigger and not into the pre-trigger diagnostic | the diagnostic and the trigger |
| 7 | `b9e8e53` | P2 | `btrim(x)` trims SPACES ONLY, so `E'\t'` counted as a result | non-blank checks in this schema |
| 8 | `b9e8e53` | P2 | `command_not_found_handle` sets `FAIL=1` in a SUBSHELL, so the guard against silent no-ops was itself a silent no-op | — (see below) |

---

## Root A again — the member, not the set (findings 3, 5)

Finding 5 is the sharpest thing in this audit, because of when it happened. The PR's own commit
message says, in as many words, that **ten fixtures were minting `succeeded` receipts and each now
reserves and completes**. I had found that set, enumerated it, fixed it — and I found it with
`grep -rn "commandExecution.create" … | head`, which truncated at ten results, plus one hand-search
of `upgrade-proof.sh`. Four other shell scripts plant receipts by raw SQL and I never looked.

So the set was not merely un-enumerated; it was enumerated WRONG by a tool whose truncation I did not
notice, and the wrong number then went into the commit message and the packet as a fact. The same
`head`-truncated grep also hid the first four TS fixtures earlier in this PR — 58 tests failed, and
even then I patched what the failure named rather than re-running the search unbounded.

**Closure: the enumeration is derived, not typed.** The complete set is
`grep -rl 'INSERT INTO "CommandExecution"\|commandExecution.create'` with no `head`, and this PR's
answer is that every one of those files now performs the protocol. But a list in an audit is the
thing that goes stale, so the real closure is the SEAL ITSELF: a script added tomorrow that mints a
receipt fails immediately and loudly, at the first statement, rather than quietly passing. The seal
is its own enumeration — which is exactly why finding 5 surfaced as "these three scripts will break"
rather than as a silent divergence.

The general rule, and the one I keep paying for: **a truncated search is a wrong answer, not a
partial one.** `head` on an exploratory grep is fine; `head` on a grep whose output becomes a claim
is a fabrication with a plausible number attached.

## Root A, twice more — and the closure that should have come first (findings 6, 7)

Finding 6 is the **third** time in this one PR that the diagnostic and the trigger have disagreed
about what a coherent receipt is. Round 1: the diagnostic warned where it should have aborted.
Round 2: a new rule went into the trigger and not the diagnostic. Round 3: the whitespace set
differed. Three rounds, one cause — they were two hand-kept copies of one predicate, asked at two
different times.

Finding 7 is root A pointing outward instead of inward: `btrim(x)` with no second argument trims
SPACES ONLY, while the twenty-odd other non-blank checks in this schema all use
`btrim(x, E' \t\n\x0B\f\r')`. I wrote a twenty-first that differed, in a PR whose own audit had
already named "fix the SET, not the member" twice.

**Closure: ONE function.** `platform_command_receipt_incoherence(status, resultRef, completedAt)`
returns NULL for a coherent row and the REASON otherwise. The trigger asks it about the row it is
about to write; the diagnostic asks it about every row already there; `RUNBOOK §CMDR`'s listing
query asks it too, so an operator's list can never disagree with what aborted. A rule added
tomorrow lands in all three at once, which is the only version of this that survives contact with
the next round.

That closure was available from the first head and I did not reach for it, because at one rule the
duplication looks free. It is not: the cost is not writing the rule twice, it is that the SECOND
site is invisible from the first when the rule changes.

## The guard that was itself a no-op (finding 8)

The round-1 head added `command_not_found_handle` so a misspelled assertion could not vanish into a
green run. Bash invokes that handler **in a separate execution environment**, so its `FAIL=1` never
reached the parent shell and the guard did nothing whatsoever.

Verified rather than argued — a five-line script reproduces it — and the fix crosses the boundary
with a file rather than a variable. More importantly the mechanism is now PROVEN at the top of every
run: a subshell invokes a deliberately missing command against a throwaway sentinel, and the proof
exits immediately if the guard fails to fire. A guard that is not itself tested is a claim.

Three instances in one PR of *a proof that passes while proving nothing* — the `assert_rejects`
placement, the shape-C fixture, and the guard written to catch the first one. The discipline that
catches all three is the same: **pair every refusal with an acceptance, and test the test.**

**And the moment the guard actually worked, it found a fourth thing — one nobody was looking for.**
The upgrade proof went red with no failed assertion, because a missing command's message goes to its
caller's stdout and plenty of callers here are redirected to `/dev/null`. So the sentinel now
records the NAME, and it named `p3`: `upgrade-proof.sh` plants its pre-Task-4 fixture through an
UNQUOTED heredoc (`<<SQL`), and a SQL comment inside it referred to the project as `` `p3` ``. In an
unquoted heredoc a backticked word is COMMAND SUBSTITUTION, not prose — so the shell had been
running `p3`, silently, on every run since that fixture was written, and the word had been quietly
deleted from the comment. Harmless here, and it would not have been if the backticks had contained
something with side effects.

Four scripts carried backticked heredoc comments, including three I had just added myself. All are
now plain text. The lasting closure is not that list, though — it is that **the guard is the
detector**: any backtick-in-unquoted-heredoc naming a command that does not exist now fails the run
by name, wherever it is added.

## Root F — a seal that does not close what it claims (finding 1)

The migration's first head said it closed the forgery Codex found under PR #276. It did not: an
operator can reserve, then complete, and no trigger can tell that apart from the application doing
the same thing. The finding is correct and, importantly, **not fully fixable at the database layer
at all** — which is why the response is three things rather than a patch:

1. **State the boundary.** No trigger distinguishes "the application ran" from "SQL that reproduced
   what the application would have written." That boundary belongs to every trigger-based seal in
   this repository; it is written down now because this is the table the others rest on.
2. **Enforce every property the protocol actually has.** The completion must come from the SAME
   TRANSACTION that reserved — Phase 2 states the protocol that way, so this is a real invariant
   that was simply missing, and without it a receipt reserved at any point in the past can be
   adopted and completed against a result chosen afterwards.
3. **Name where the remainder is answered.** A privilege grant, not a trigger: the maintenance role
   should not hold INSERT/UPDATE on this table. Recorded in `RUNBOOK §CMDR.2`.

The lesson worth carrying: **when a seal cannot close something, say so in the seal.** An overclaim
in a migration comment is worse than a gap, because the next reader stops looking.

## Root G — a false premise dressed as a decision (finding 2)

I wrote that legacy incoherent receipts could be warned about rather than aborted on, because
"neither shape can satisfy a provenance seal falsely." That was not a judgement call; it was a
factual claim, and it was false — §E's join reads `status`, `commandType` and `resultRef` and never
reads `completedAt`, so a hand-written `succeeded` receipt validates a hand-written verdict the
moment the seal installs.

What makes this its own root rather than carelessness is the SHAPE of the mistake: I reasoned about
a downstream consumer's predicate **from memory** while writing an upstream guard, and got it
wrong by one column. The consumer was in a different file, in a different PR, that I had written
myself the same day.

**Closure: when a guard's justification depends on what a consumer checks, read the consumer.** The
migration now states the consumer's exact predicate inline, so the next person can check the
reasoning against the code rather than against a claim.

## What the abort proof found in its own subject

`command-receipt-abort-proof.sh` was written to prove finding 2's fix. It failed twice on its first
runs, and both failures were real:

- **`RUNBOOK §CMDR` omitted `migrate resolve --rolled-back`.** Prisma records the aborted migration
  as failed and refuses to continue until an operator says so — exactly as §T45.1 documents for its
  own migration. The runbook I had just written would have left an operator stuck at precisely the
  moment it was supposed to help.
- **The shape-C fixture silently failed to create its citing fact**, so the "PostgreSQL refuses to
  delete a receipt a fact depends on" assertion passed while proving nothing. The fixture now fails
  the proof loudly if it does not apply.

Recorded because it is the same class as the `upgrade-proof.sh` defect this PR also fixes (five
assertions placed above `assert_rejects`'s definition, printing `command not found` to stderr while
the run reported PASSED, now caught by `command_not_found_handle`). Three instances in one PR of
**a proof that passes while proving nothing** — which is the failure mode the whole reproduce-first
discipline exists to prevent, and the reason every fix here is paired with an acceptance case rather
than only a refusal.

## A pre-existing breakage found while proving finding 5, and NOT claimed as fixed

Finding 5 named three proof scripts that plant `succeeded` receipts directly. All three now perform
the protocol, and two of them pass. **`t45-repair-proof.sh` does not — but it does not pass on
`main` either**, and the reason is upstream of anything this PR touches:

```
ERROR: there is no unique constraint matching given keys for referenced table "CommandExecution"
```

Its `build_not_yet_db` withholds `20261231000000_phase3_t45_integrity_correction` — which is the
migration that CREATES `CommandExecution_projectId_id_key` — and then applies every later migration,
several of which add composite FKs referencing `(projectId, id)`. That cannot work, and has not been
able to since the first Phase-4 migration to reference the key.

Verified rather than assumed: the script was re-run with `20270425000000` moved out of the
migrations directory entirely, and it fails at the same statement with the same error. So finding 5
is right that its fixtures would have hit the new guard, and also moot for that script today,
because it never reaches them.

**The fixture shape is fixed anyway** — it is correct, and it is what the script will need when it
is repaired — but the script is left failing and named here rather than quietly "fixed" by changing
which migrations it withholds. That is a change to a cleared proof harness with its own review
history, it is unrelated to sealing the command receipt, and inventing a fix for it inside this PR
would be exactly the scope creep the review-efficiency protocol exists to stop.

## Gate results at the convergence head

| Gate | Result |
|---|---|
| Focused `platform-command-receipt.test.ts` | **10/10** — refusals proven RED against `main`, acceptances green in both states; the result-blankness probe covers space, tab, newline, CR, vertical tab and form feed |
| `command-receipt-abort-proof.sh` | PASSED — all THREE abort shapes (incl. succeeded-without-result), the documented repair, the `resolve`-then-`deploy` sequence, and the FK refusal |
| `pnpm check` | EXIT 0 |
| Full integration suite, pristine migrated DB | 77 files |
| `upgrade-proof.sh` | PASSED, with every platform assertion actually executing and the missing-command guard self-proven at start-up |
| `t45-production-runner-proof.sh` | PASSED |
| `phase4-t3-correction3-production-runner-proof.sh` | PASSED (needs `PGUSER=postgres`; it defaults to the `vitan` role) |
| `t45-repair-proof.sh` | **FAILS — and fails identically WITHOUT this PR's migration.** See below |
