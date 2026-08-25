# Reading this repository's migrations — the parser binding

## What this unit ships

**One decision and one claim.**

* **Decision** — how this repository reads its own migrations programmatically, and with which
  parser.
* **Claim** — all 91 migrations parse with PostgreSQL's own grammar through this binding, and the
  binding neither leaks nor truncates on the largest of them.

It ships nothing else: **no sites, no line attribution, no coverage accounting, and no rule.**

## Why this exists at all

`ActivityDependency` ran #354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 → #412 → #415 and
merged only at the sixteenth head. Every round drew the same class of finding:

> **A check narrower than the object it judges.**

Each individual fix was correct. The next round found the same shape somewhere new, because nothing
in the repository could state the shape itself. The intent is to state it executably, as rules that
run before review rather than findings that arrive after it. **This unit is the parser those rules
will eventually be written against, and nothing more.**

## Why the scope is this narrow

Three pull requests in this lineage reached the two-finding-head limit and were closed:

| PR | What it carried | Why it closed |
| --- | --- | --- |
| #423 | a hand-written SQL lexer and regexes over it | seven round-2 findings, all reducing to *this linter enumerates a subset of PostgreSQL and treats the subset as the whole* — two of them the lexer desyncing on a dollar tag inside a block comment and a backslash escape ending an `E''` string early |
| #430 | the binding **plus an enforcement rule** | five findings across two heads — the rule's entry condition, its alias resolution flattening nested query scopes, its evidence gathered per statement rather than per `UNION` branch, an enablement test proving *constrained* rather than *enforcing* |
| #431 | the binding **plus site attribution and a total-coverage claim** | seven findings across two heads — dynamic SQL read as its own string literal, `LANGUAGE sql` bodies skipped entirely, multi-command dynamic SQL collapsed into one site, routine bodies located by file-wide byte equality, top-level sites reported at line 1 |

**The findings did not scatter.** Every one is the same shape as the defect the rules exist to
detect, restated as their implementation. And the last round is the clearest illustration: a
correction discovered that libpg_query omits `stmt_location` for a first statement, applied the fix
where the probe pointed, and left the identical root cause two functions away — where it put **67 of
88** first top-level sites on line 1 with the file header baked into their text.

What survived all three reviews untouched is what is here: **the choice of parser, and the two
measured defects in using it.** Attribution and coverage — where every #431 finding landed — start
again on top of a binding reviewed for what it is.

## The parser, decided by measurement

`pg-query-emscripten@5.1.0` — libpg_query 16, matching the `postgres:16` service every database job
in `.github/workflows/ci.yml` runs against.

| | install | PG grammar | PL/pgSQL |
| --- | --- | --- | --- |
| `pg-query-emscripten@5.1.0` **(chosen)** | 1.7 s, no build step, zero deps | 16 | `parsePlpgsql` |
| `libpg-query` (`pg16` 16.7.3 / `pg17` 17.7.4) | 0.9 s / 1.5 s, WASM — no node-gyp | 16 or 17 | **none, at any dist-tag** |

Install time did not decide it and neither did node-gyp, which current `libpg-query` no longer uses.
`libpg-query` exposes `parse`, `parseSync`, `loadModule` and error helpers, and **no PL/pgSQL
parser**. Every guard in this repository lives inside a `DO` block, whose body is one opaque string
literal to the SQL grammar, so it could not read a single guard. That is the measured reason.

### Two defects in the chosen library, handled rather than absorbed

* **The convenience wrappers copy input onto the WASM stack and never unwind it.** `allocate(…,
  ALLOC_STACK)`, and the `_free` that follows does not apply to a stack pointer. Measured: an
  instance dies after 44,590–62,874 cumulative input bytes — an emscripten 64 KB stack — and the
  largest migration here is 177,493 bytes, which the wrappers cannot parse **at all, on any
  instance, ever**. The binding uses the raw entry points with a **heap** allocation it frees.
  Measured after: 20,000 parses in 2.6 s with no growth, and the 177 KB file parses. The alternative
  considered and rejected was recycling the module on a byte budget, which would have hidden a
  library defect behind a magic number and still could not have parsed the largest file.
* **`parsePlpgsql` over a whole file aborts at the first routine it dislikes** and reports nothing
  about any other, so one awkward block would blind a reader to the rest of the file without saying
  so. Routines are compiled **one at a time**, from the routine's own statement text **verbatim** —
  not re-wrapped in a `DO` of our own, because a trigger function re-wrapped that way loses `NEW`
  and `OLD` and fails to compile. That is how four merged migrations were found to break.

Both are pinned by `scripts/pg-parse.test.mjs`: a decision recorded in a comment without a test to
hold it is a comment, not a property.

## Nothing here decides what SQL is

`libpg_query` **is** the PostgreSQL server's parser, compiled from the same C sources. It is asked
both questions a hand-written lexer answered by guessing — `raw_parse` for the raw tree (statement
boundaries, dollar quoting, every literal form, comments, all of it, by construction) and
`raw_parse_plpgsql` for routine bodies. The tree walk needs no list of node types: a node is
`{ NodeType: { …fields… } }` and node names are UpperCamelCase while field names are lowerCamelCase,
which is the parser's own convention across all 300-odd types. Enumerating the ones this repository
happens to use would rebuild the very defect this line of work retires.

Where the binding stops, it says so: SQL the grammar refuses and a routine body PL/pgSQL rejects both
**throw**, carrying the server's own message. Silence is the failure mode this work exists to refuse.

## What is deferred, and what has NO alarm

**This unit detects no defect.** It ships no rule, so nothing in CI fires on any of the following.
Deferring a rule did not unfind its defect; it removed the alarm, and this section is that alarm.

### Deferred work

* **Sites, line attribution and the coverage claim** — every #431 finding landed here. A site is one
  SQL query as the grammar sees it, and getting its position and its boundaries right is where the
  difficulty turned out to be: byte offsets that libpg_query omits, routine bodies located by
  content rather than by structure, dynamic SQL, `LANGUAGE sql` bodies, and routines created inside
  dynamic SQL. `git show` on the closed `claude/migration-parser-adapter` branch is the record.
* **The rules.** MI-000 (statement-kind totality), MI-002 (an object judged by NAME where a
  definition comparison was required), MI-003 (a guard verified at APPLY time and never asked again
  on a later deploy) and MI-004 (transaction scope) were written, corrected and left **green** on the
  closed `claude/migration-invariant-linter` branch at `a8b401ba`, `f3f00a88` and `08835700`. The
  enforcement rule — *a migration that verifies a prerequisite object must verify that the object
  ENFORCES, not merely that it EXISTS* — was that branch's `MI-002` and #430's `MI-001`.

**Never rebase or force-push `claude/migration-invariant-linter`, `claude/migration-invariant-linter-v2`
or `claude/migration-parser-adapter`.** Those histories are the handover.

### The live defects nothing currently detects

`apps/api/prisma/**` is read-only to this unit, so none is repaired here, and **none has a backstop**.

* **`20270225000000_phase4_t3_correction3:167`** verifies prerequisite composite foreign keys by
  `conname` + `conrelid` + `contype = 'f'` + `convalidated`, and never reads `pg_trigger.tgenabled`.
  A foreign key is implemented as internal `RI_ConstraintTrigger` rows — four per key on PG16 — and
  `ALTER TABLE … DISABLE TRIGGER ALL` switches them off while leaving every one of those columns
  byte-for-byte unchanged. A restored database with **no containment at all** passes the prerequisite
  and is baselined as correct.
* **`20270415000000_phase5_t3_measurement:39-74`** is weaker still: eight
  `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…')` guards, each followed by
  `ADD CONSTRAINT … FOREIGN KEY`, which do not even read `conrelid` — so a same-named constraint on
  any table satisfies them.
* **`20270920000000_decision_option_kinds:273`** installs `CONSTRAINT TRIGGER`s and verifies them
  against the catalog, but names no RUNBOOK procedure and has no counterpart in `migrate.sh`. Once
  its row is in `_prisma_migrations` the seals are never checked again.
