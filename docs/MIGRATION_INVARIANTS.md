# Migration invariants — the parser adapter, and what still has no alarm

## Why this exists

`ActivityDependency` ran #354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 → #412 → #415 and
merged only at the sixteenth head. Every round drew the same class of finding:

> **A check narrower than the object it judges.**

Each individual fix was correct. The next round found the same shape somewhere new, because nothing
in the repository could state the shape itself. The intent is to state it executably, as rules that
run before review rather than findings that arrive after it.

**This unit ships the foundation those rules stand on, and no rule.** That split is not tidiness; it
is what two closed pull requests measured.

## What this unit claims

> For all 91 migrations, every SQL query in the file is either a **site** a rule can be asked about,
> or an **unreadable fragment** reported at its line with the reason it could not be read.

Nothing else. There is no rule here, and therefore no exemption ledger — an exemption exists only to
record a judged finding, and nothing here judges anything.

### Why that claim is worth its own unit

A check that runs over a corpus it has only partly read reports *clean* about SQL nobody looked at.
That is not a coverage gap, it is a **false report** — and it is the same shape as the defect the
rules exist to catch, one level up. It is also not hypothetical. In the closed lineage of this work
the same file produced it twice, and both times the run reported total coverage:

| What was silently unread | How it reported |
| --- | --- |
| a PL/pgSQL `EXECUTE` — the SQL is carried **as a value**, so parsing the expression parsed the string *literal* | a fully-parsed site naming no relation at all |
| a `CREATE FUNCTION … LANGUAGE sql` body — skipped by a bare `continue`, while `CreateFunctionStmt` is *also* excluded from top-level sites | no site, no fragment, no count — absent from every list |

The second is worth dwelling on. **Five** such bodies are in this corpus, and they are not trivial:
one runs `INSERT INTO "VendorBillRevision"`, others join `pg_constraint`, `"SodException"` and
`"PaymentApproval"`. A migration can define a SQL helper that queries the catalog and call it from a
later `DO` guard; the call site shows only the call. So the coverage claim is made **executable
before any rule reads it**, rather than assumed by the first rule that runs.

## How the adapter reads

`scripts/pg-parse.mjs` wraps `pg-query-emscripten@5.1.0` — libpg_query 16, matching the `postgres:16`
service every database job in `.github/workflows/ci.yml` runs against. **Nothing here decides what
SQL is.** PR #423 hand-wrote a SQL lexer and regexes over it, reached the two-finding-head limit and
was closed; all seven of its round-2 findings reduce to *this linter enumerates a subset of
PostgreSQL and treats the subset as the whole*. Two of them were the lexer desyncing on constructs
nobody had told it about — a dollar tag inside a block comment, a backslash escape ending an `E''`
string early. A hand-written subset of a grammar cannot be argued into completeness. **The lexer is
not carried forward in any form.**

### A site is one query

A site is one SQL query as the grammar sees it: a top-level statement, one expression inside a
PL/pgSQL routine, or one statement of a SQL-language body. That granularity is the correction #423
failed twice to make — its evidence was gathered per *file*, then per *block*, so one correct guard
discharged the requirement for every defective neighbour beside it. Every site carries its own text
and its own line, so it can be identified, reported and opened.

### Every branch is total

| Position | How it is read |
| --- | --- |
| `DO $$ … $$` | compiled by the PL/pgSQL parser |
| `CREATE FUNCTION … LANGUAGE plpgsql` | compiled by the PL/pgSQL parser |
| `CREATE FUNCTION … LANGUAGE sql` | parsed by the SQL grammar; its statements become sites |
| any other language | **`language-unsupported` fragment** — named, never stepped over |
| `EXECUTE '<constant>'` | the constant folds to the statement it always is, parsed for real |
| `EXECUTE format(…)`, `EXECUTE r.ddl` | **`dynamic-unresolved` fragment** — it has no text until the migration runs |
| a PL/pgSQL statement kind not in `PLPGSQL_STATEMENT_KINDS` | **throws**, naming itself |

The last row is the point of the table, not the rows above it: the absent `default:` case. PL/pgSQL
has dynamic-SQL statements this repository has never used — `FOR … IN EXECUTE`, `OPEN … FOR
EXECUTE`, `RETURN QUERY EXECUTE` — and each would otherwise arrive looking like an ordinary
expression. A file the grammar refuses outright throws and names itself. Silence is the failure mode
this unit exists to refuse.

### Two measured properties of the binding, handled rather than absorbed

* The convenience wrappers copy input onto the **WASM stack** and never unwind it. An instance dies
  after 44,590–62,874 cumulative bytes, and the 177,493-byte
  `20270930000000_schedule_dependency_graph` cannot be parsed by them at all, on any instance, ever.
  The adapter uses the raw entry points with a **heap** allocation it frees — 20,000 parses in 2.6 s
  with no growth, and the 177 KB file parses.
* Handed a whole file, `parsePlpgsql` aborts at the first routine it dislikes and reports nothing
  about any other. The adapter compiles **one routine at a time**, from that routine's own statement
  text sliced by the byte offsets the raw parser reported.

`libpg-query` was measured as the alternative and rejected on one fact: it ships **no PL/pgSQL
parser** at any dist-tag. Every guard in this repository lives inside a `DO` block, whose body is one
opaque string literal to the SQL grammar, so it could not see a single site.

## The measured corpus

**91 migrations · 338 routines · 4,101 sites · 11 unreadable fragments · 1.4 s**

`scripts/migration-readability.test.mjs` pins all four, and pins the fragments as an **exact
`<migration>:<line>` set** rather than a count — a count would let one unreadable construct be
swapped for another without a diff. The eleven are SQL built at run time from values that do not
exist until the migration runs: ten `format(…)` and one `r.ddl`.

Before the SQL-language bodies were read the same corpus measured **333 routines and 4,096 sites**,
and reported the difference nowhere at all.

## What has NO alarm — stated, not omitted

**This unit detects no defect.** It ships no rule, so nothing in CI fires on any of the following.
Deferring a rule did not unfind its defect; it removed the alarm, and that is what this section is.

### The rules, and where their work lives

Written, corrected and left **green** on the closed `claude/migration-invariant-linter` branch, whose
history *is* their handover — `git show <sha>` is the whole thing. **Never rebase or force-push that
branch.**

| Rule | What it detects | Deferred at |
| --- | --- | --- |
| MI-000 | a statement kind the linter has never been taught, passing silently instead of failing | `a8b401ba` |
| MI-002 | an object judged by NAME where a definition comparison was required | `f3f00a88` |
| MI-003 | a guard verified at APPLY time and never asked again on any later deploy | `08835700` |
| MI-004 | transaction scope — a diagnostic and the seal it justifies in different transactions | `a8b401ba` |

The enforcement rule — *a migration that verifies a prerequisite object must verify that the object
ENFORCES, not merely that it EXISTS* — was that branch's `MI-002` and PR #430's `MI-001`. **It is
deferred here**, with its full finding history on the closed PRs #423 and #430.

### The live defects nothing currently detects

`apps/api/prisma/**` is read-only to this unit, so none is repaired here. **None has a backstop.**

* **`20270225000000_phase4_t3_correction3:167`.** Verifies prerequisite composite foreign keys by
  `conname` + `conrelid` + `contype = 'f'` + `convalidated`, and never reads `pg_trigger.tgenabled`.
  A foreign key is implemented as internal `RI_ConstraintTrigger` rows — four per key on PG16 — and
  `ALTER TABLE … DISABLE TRIGGER ALL` switches them off while leaving every one of those columns
  byte-for-byte unchanged. A restored database with **no containment at all** passes the
  prerequisite and is baselined as correct.
* **`20270415000000_phase5_t3_measurement:39-74`.** Eight `IF NOT EXISTS (SELECT 1 FROM pg_constraint
  WHERE conname = '…')` guards, each immediately followed by `ADD CONSTRAINT … FOREIGN KEY`. These
  are **weaker than the case above** — they do not even read `conrelid`, so a same-named constraint
  on any table satisfies them, and after a restore that leaves a key present but disabled the guard
  skips its own `ADD CONSTRAINT`. Found by Codex on PR #430 while reviewing a rule that *missed*
  them: the rule required `contype = 'f'` to be spelled, so a guard that identifies a foreign key by
  name alone fell outside it — the rule's entry condition being narrower than the object it judges,
  which is the very shape it was written to catch.
* **`20270920000000_decision_option_kinds:273`.** Installs `CONSTRAINT TRIGGER`s and verifies them
  against the catalog, but names no RUNBOOK procedure and has no counterpart in `migrate.sh`. Once
  its row is in `_prisma_migrations` the seals are never checked again, so a restore that drops or
  disables them yields a green deploy. Detected only by the deferred MI-003.

## Why the rule is not in this unit

PR #430 carried the adapter *and* the enforcement rule. It reached the two-finding-head limit and was
closed. Its second head drew five findings; four were the same family again — the rule's entry
condition, its alias resolution flattening nested query scopes, its evidence gathered per statement
rather than per `UNION` branch, and an enablement test that proved the value was *constrained* rather
than *enforcing*.

That is where the difficulty is, and the unit at 1,500 changed lines had no room left to address it.
So the foundation lands first, with its own coverage claim proven, and the rule lands on top of an
adapter that has been reviewed for what it reads.

## Adding a rule, when one lands

1. Find the real historical commit that produced the finding and pin the defective fragment in
   `scripts/fixtures/` as a verbatim extract with its PR, head and line range.
2. Pin the head that fixed it as the GREEN fixture.
3. Write a probe that would pass against a **coarser** version of your rule — the adjacent-decoy
   shape — and assert the per-site verdicts.
4. Cite the PR and head in the rule's comment.

A rule that does not fire on the head that produced its finding is not implemented.
