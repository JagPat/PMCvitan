# Migration invariants

`pnpm lint:migrations` reads every file under `apps/api/prisma/migrations/` and refuses the ones
that carry a known-defective shape. It runs in the required `automation` job, on every SHA.

## Why it exists

`ActivityDependency` ran #354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 → #412 → #415 and
merged only at the sixteenth head. Every round drew the same class of finding:

> **A check narrower than the object it judges.**

Each individual fix was correct. The next round found the same shape somewhere new, because nothing
in the repository could state the shape itself. Sixteen heads is what it costs to rediscover a class
one instance at a time. This linter states the class executably, before review rather than after.

## How it decides

Nothing here decides what SQL is. `scripts/pg-parse.mjs` hands each rule **PostgreSQL's own parse
tree**, via `libpg_query` — the server's parser, compiled from the same C sources — and the rules ask
structural questions of it. A `contype = 'f'` predicate is found as a comparison node with a column
on one side and a string constant on the other, not as text that looked like one.

This is the second attempt. **PR #423 hand-wrote a SQL lexer and a set of regexes over it, and was
closed at the two-finding-head limit.** All seven of its round-2 findings reduce to one sentence:

> This linter enumerates a subset of PostgreSQL and treats the subset as the whole.

Which is the defect class the linter exists to detect, restated as its own implementation. Two of
those findings were the lexer desyncing on constructs nobody had told it about — a dollar tag inside
a block comment, and a backslash escape ending an `E''` string early. A hand-written subset of a
grammar cannot be argued into completeness; it can only be extended each time reality exceeds it.
The lexer is not carried forward in any form.

### A site is one query

The rules judge **sites**. A site is one SQL query as the grammar sees it: a top-level statement, or
one expression inside one PL/pgSQL routine. Four of #423's seven findings were a single defect, one
meta-level up from this linter's own subject:

> **Evidence gathered at a coarser granularity than the thing being judged.**

Its proof that "this place checks enablement" was first file-global and then, after a correction,
block-global. A file that verified key A correctly and key B presence-only passed, because
`tgenabled` appeared *somewhere*. `scripts/fixtures/migration-lint/mi001-decoy-adjacent-guard.sql`
holds both resolutions in a **single `DO $$ … $$` block** and the test asserts the rule fires on one
and not the other — a fixture that split them across blocks or files would pass against both of the
implementations it exists to refuse.

## The rules

### MI-001 — verify that the object ENFORCES, not merely that it EXISTS · **SHIPPED**

A migration that verifies a prerequisite database object must verify that the object acts.

RED at `a222e91` (PR #411). Section 1e verified five foreign keys through `pg_constraint` — by
`conname`, `conrelid`, `contype = 'f'` and the `confrelid` OID — and read what it found as proof
that the table has containment. It does not prove that. A foreign key is *implemented* as internal
`RI_ConstraintTrigger` rows — measured on PostgreSQL 16: **four per key** — and
`ALTER TABLE … DISABLE TRIGGER ALL`, which a failed restore and several ordinary superuser recovery
procedures run, switches all four off while leaving `pg_get_constraintdef`, `confrelid`, `contype`
and `convalidated` byte-for-byte identical. A key that enforces nothing satisfies every column that
guard reads, so a restored database with no containment at all is certified as the prerequisite and
baselined as correct.

GREEN at `96c9cc4` (PR #412), which joins `pg_trigger` on `tgconstraint` and refuses a key whose
`tgenabled` says it does not act.

The rule fires on a query that reads `pg_constraint` and compares `contype` against `'f'` without
reading `pg_trigger.tgenabled` through `tgconstraint` **in that same query**. Both halves of the
evidence are required and neither is decoration: `tgenabled` alone would accept the enablement of
some unrelated trigger read nearby, and `tgconstraint` alone reaches the key's own triggers and then
never asks whether they are switched on.

Fixtures: `mi001-red-a222e91.sql`, `mi001-green-96c9cc4.sql`, `mi001-decoy-adjacent-guard.sql`.

### What this unit does NOT cover

Four further rules were written, corrected and left **green** on the closed
`claude/migration-invariant-linter` branch. That branch's history *is* their handover —
`git show <sha>` is the whole thing, and none of the fixes from those rounds needs rediscovering.
**Never rebase or force-push that branch.**

| Rule | What it detects | Deferred at |
| --- | --- | --- |
| MI-000 | a statement kind the linter has never been taught, passing silently instead of failing | `a8b401ba` |
| MI-002 | an object judged by NAME where a definition comparison was required | `f3f00a88` |
| MI-003 | a guard verified at APPLY time and never asked again on any later deploy | `08835700` |
| MI-004 | transaction scope — a diagnostic and the seal it justifies in different transactions | `a8b401ba` |

**On the numbering.** Those rule IDs are the ones that branch used, and they are kept here so the
SHAs stay readable against it. In that numbering the enforcement rule was `MI-002` and `MI-001` was
the name-over-definition rule; this unit ships the enforcement rule as **MI-001**, per the owner's
re-cut. Nothing on that branch shipped; everything in the table above is deferred.

Because MI-000 is deferred, an unrecognised construct is not *failed* — but it is not skipped
either: `scripts/migration-lint.test.mjs` asserts that every migration parses and that **zero**
fragments are unreadable, so a construct this adapter cannot read fails `pnpm test:automation`. It
does not fail `pnpm lint:migrations`.

## The live defects — one with a backstop here, one without

`apps/api/prisma/**` is read-only to this unit, so neither is repaired here. **They are not
symmetrical, and a reader must not assume coverage this unit does not have.**

* **`20270225000000_phase4_t3_correction3:167` — MI-001. BACKSTOPPED BY THIS UNIT.** Verifies the
  prerequisite composite foreign keys by `conname` + `conrelid` + `contype = 'f'` + `convalidated`,
  and never reads `tgenabled`. `DISABLE TRIGGER ALL` leaves every column that guard reads unchanged
  while the keys stop enforcing, so a restored database with no containment passes the prerequisite
  and is baselined. It is recorded in `scripts/migration-lint-exemptions.json`, **printed as a LIVE
  DEFECT notice on every run of the linter**, and pinned by a test — so the unit that fixes it lands
  against a CI check rather than against an assertion.
* **`20270920000000_decision_option_kinds:273` — MI-003. NO BACKSTOP IN THIS UNIT.** Installs
  `CONSTRAINT TRIGGER`s and verifies them against the catalog, but names no RUNBOOK procedure and
  has no counterpart in `migrate.sh`. Once its row is in `_prisma_migrations` the seals are never
  checked again, so a restore that drops or disables them yields a green deploy. **MI-003 is
  deferred, so nothing in CI fires on this today** — and it has no exemption entry, because an
  exemption for a rule that does not run would suppress nothing and the no-dead-exemption test would
  refuse it. Deferring the rule did not unfind the defect; it removed the alarm. The backstop
  arrives with MI-003.

## The measured corpus verdict

Over the 91 migrations on `main` at `959393d9`, MI-001 raises **two findings**, both recorded in
`scripts/migration-lint-exemptions.json` with a written reason:

| Site | Verdict |
| --- | --- |
| `20270225000000_phase4_t3_correction3:167` | LIVE DEFECT — reported, not repaired here |
| `20270930000000_schedule_dependency_graph:797` | ACCEPTED — section 1e' compares the key's TARGET by OID; section 1e'', the next statement in the SAME block over the SAME five keys, asks the enforcement question |

The rule does not read that neighbour on 1e''s behalf, and it must not — that is precisely the
coarser-than-the-site evidence #423 was closed for. The judgement that the neighbour covers the site
is a human one, so it is written down where a reviewer sees it.

An exemption suppresses the **build failure** and nothing else. Every entry is printed on every run,
in the same output as a failing finding. Two tests keep the ledger honest: each entry must name a
real migration and a real rule with a checkable reason, and none may be dead.

## The parser

`pg-query-emscripten@5.1.0` — libpg_query 16, matching the `postgres:16` service every database job
in `.github/workflows/ci.yml` runs against. Both candidates were measured:

| | install | PG grammar | PL/pgSQL |
| --- | --- | --- | --- |
| `pg-query-emscripten@5.1.0` | 1.7 s, no build step, zero dependencies | 16 | `parsePlpgsql` |
| `libpg-query` (`pg16` 16.7.3, `pg17` 17.7.4) | 0.9 s / 1.5 s, WASM — no node-gyp any more | 16 or 17 | **none** |

Install time did not decide it and neither did node-gyp, which current `libpg-query` no longer uses.
`libpg-query` exposes `parse`, `parseSync`, `loadModule` and error helpers, and **no PL/pgSQL parser
at any dist-tag**. Every guard in this repository lives inside a `DO` block, whose body is one opaque
string literal to the SQL grammar, so a parser that cannot compile PL/pgSQL cannot see a single site
this linter judges.

Two things about the chosen binding were measured and are handled in `scripts/pg-parse.mjs` rather
than absorbed:

* Its convenience wrappers copy the input onto the **WASM stack** (`allocate(…, ALLOC_STACK)`) and
  never unwind it. Measured: an instance dies after 44,590–62,874 cumulative input bytes — a 64 KB
  emscripten stack — and the largest migration here is 177,493 bytes, which those wrappers cannot
  parse at all, on any instance. The adapter calls the raw entry points with a **heap** allocation
  it frees. Measured after the change: 20,000 parses in 2.6 s with no growth, and the 177 KB file
  parses.
* Handed the whole file, `parsePlpgsql` aborts at the first routine it dislikes and reports nothing
  about any other. One awkward block would blind the linter to the rest of the file without saying
  so. The adapter compiles **one routine at a time**, from that routine's own statement text sliced
  by the byte offsets the raw parser reported.

Measured over the corpus: 91 migrations, 333 PL/pgSQL routines, 4,107 sites, **0 unreadable
fragments**, 1.4 s.

## Adding a rule

1. Find the real historical commit that produced the finding, and pin the defective fragment in
   `scripts/fixtures/migration-lint/` as a verbatim extract with its PR, head and line range.
2. Pin the head that fixed it as the GREEN fixture.
3. Write a probe that would pass against the coarser version of your rule — the adjacent-decoy
   shape — and assert the per-site verdicts.
4. Cite the PR and head in the rule's comment.

A rule that does not fire on the head that produced its finding is not implemented, and
`scripts/migration-lint.test.mjs` asserts that in both directions.
