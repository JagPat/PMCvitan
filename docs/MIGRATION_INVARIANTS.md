# Migration invariants

`pnpm lint:migrations` — the checks that used to be found in review, one round at a time.

## Why this exists

Schedule B1 (`ActivityDependency`) ran `#354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 →
#412 → #415` and merged at the sixteenth head. Every round drew the same class of finding:

> **A check narrower than the object it judges.**

Each individual fix was correct; the next round found the same shape somewhere new — a name where a
definition was needed, a catalog row where an enforcement was needed, an apply-time guard where a
deploy-time one was needed. Six close-and-replace turnovers went into rediscovering one shape,
because nothing in the repository could *state* it. This linter states it, executably, before
review rather than after.

## The finding classes

Each rule names the PR and head whose finding produced it. **The head that CARRIES a defect is the
predecessor of the PR whose title announces the fix** — the mapping was verified against `git log`,
and it is easy to get off by one round.

| Rule | The invariant | RED at | GREEN at |
|---|---|---|---|
| **MI-000** | Every statement, constraint and `DO` block classifies. An unrecognised construct is a finding. | — (see *Design* below) | — |
| **MI-001** | An object resolved by NAME inside a guard that refuses must be compared by DEFINITION — and the definition must actually be *compared*, not merely fetched and NULL-tested. | `a222e91` (#411) | `96c9cc4` (#412) |
| **MI-002** | A foreign key verified through `pg_constraint` must also be asked whether it ENFORCES, via `pg_trigger.tgenabled` on `tgconstraint`. | `a222e91` (#411) | `96c9cc4` (#412) |
| **MI-003** | A migration that installs seals and verifies them must have a counterpart invoked from `migrate.sh` **after** `prisma migrate deploy` succeeds. | `a222e91` (#411) | `96c9cc4` (#412) |
| **MI-004** | No `SET LOCAL` or `LOCK TABLE` at top level in a file that opens no explicit transaction block. | `c1054005` (#410) | `2f0e2af9` (#415) |

Each rule's full reasoning — the exact interleaving, what was measured, and why the narrower form
passed review — is in the comment above its implementation in `scripts/migration-lint.mjs`.

**These four are one concern: A PROTECTION THAT IS PRESENT BUT INERT.** A check that looks like it
verifies, a key that looks valid but does not enforce, a guard that looks installed but is never
re-asked, a pin that looks set but does nothing. All four come from the #410 and #411→#412 rounds.

## Deferred to the follow-on unit

Three further classes the same lineage produced are DIFFERENT concerns, and were built and measured
before being split out rather than pushing this unit past the 1,500-line review budget. Their
evidence is recorded here so the next unit starts from it rather than rediscovering it:

| Rule | The invariant | RED at | GREEN at | Measured on `main` |
|---|---|---|---|---|
| **MI-005** | A trigger guard taking a fast path on an empty table must check `transaction_isolation` first — a table lock serialises the STATEMENT, not the SNAPSHOT. | `96c9cc4` (#412, finding F-B) | `2f0e2af9` (#415) | 2 sites in `20270801000000_phase6_t1a_external_party` (`IF assoc = 0 THEN RETURN NULL` in a trigger, no isolation check) — **a live defect of F-B's class** |
| **MI-006** | A foreign-key name hard-coded in a refusing inventory must be pinned with `map:` in `schema.prisma`, so Prisma's derivation cannot rename it into a startup outage. | `96c9cc4` (#412, finding F-C) | `2f0e2af9` (#415) | 3 sites in the B1 migration itself — `ActivityDependency_projectId_fkey` and the two composite keys are hard-coded but unpinned. #415 pinned only the two names that DIFFERED; these three currently agree with Prisma's derivation, so P37 passes and the dependency on that agreement is the finding |
| **MI-007** | A unique index or `UNIQUE`/`CHECK`/`EXCLUDE` constraint added to a pre-existing table needs a preceding diagnostic that ABORTS with a bounded sample. | standing rule (`docs/ARCHITECTURE.md`) | — | 14 sites across 9 migrations, all pre-dating the rule's statement; `20270826000000_phase6_t4b_approval_attribution:24` is the newest |

Two scoping facts were measured and are worth carrying forward, because both cost a full
build-and-remeasure cycle: MI-006 must fire only on a name that is **both declared and re-stated in
a refusing inventory** (the create-if-absent idiom accounts for 115 of 118 naive hits across
fourteen merged migrations, where a rename re-adds the key rather than blocking the deploy), and
MI-007 must exclude FOREIGN KEY (including it flagged seven `ON DELETE` action changes in
`20261025000000_phase2_module_boundaries` alone, a file that adds no data-validating constraint).

## Design: enumerate and classify, do not grep

This is deliberately **not** a list of known-bad patterns. A grep for the seven fragments the B1
lineage happened to produce would itself be a check narrower than the object it judges — the exact
defect it exists to catch. So wherever the artifact is enumerable, the linter enumerates it and
classifies **every** member, and an unrecognised construct is a finding demanding classification
rather than silence:

* every top-level statement is classified by kind (`STATEMENT_KINDS`)
* every constraint the file creates is classified by kind (`CONSTRAINT_KINDS`)
* every `DO` block is classified by role (`BLOCK_ROLES`), from its enclosing statement first
* every catalog object resolved by name is paired against a definition read

The vocabularies were derived by enumerating the real corpus — 1,684 top-level statements across
the 91 migrations — not by guessing what SQL might contain, and that is load-bearing: a first draft
also listed nine verbs the repository has never used in a migration, every one of which would have
let a future construct through silently. `MI-000` asserts totality over the corpus as a test, so a
construct the linter has never seen cannot pass by being unmentioned.

**Two rules cannot be expressed that way, and the reason is stated rather than hidden.**

* **MI-003** asks whether a migration's self-verification is reachable from `migrate.sh`. Nothing
  in the SQL names its own verifier — the link between the B1 migration and
  `dist/activities/b1/b1.cli.js` existed only in a human's head. Enumeration cannot recover a link
  never written down, so the rule reads the one the corpus already has: the shared
  `docs/RUNBOOK.md §X` procedure token both files name. A migration using no RUNBOOK procedure may
  declare it explicitly with `-- migration-invariants: deploy-verifier <token>`.
* **MI-006**, in the follow-on unit, asks what Prisma's generator would *do*. Deriving that would
  be a second implementation of someone else's naming rules — the same defect one level up. #415
  ships the honest form as probe **P37** (`prisma migrate diff`, asked of Prisma itself against a
  live database); the rule instead asks only that each hard-coded name be *pinned*, making the
  derivation irrelevant rather than replicated. P37 needs a database; the static half does not.

## What it would NOT have caught

Stated plainly, because a linter trusted beyond its reach is worse than none:

* **Nothing about correctness of the rule being enforced.** MI-002 checks that a key is asked
  whether it enforces. It cannot tell you the key should not exist, or that the seal beside it is
  about the wrong thing.
* **`provolatile`, `proconfig`, ownership, the column contract.** Several B1 rounds turned on
  catalog attributes beyond the classes here. MI-000 flags an unrecognised *construct*, not an
  unexamined *attribute of a recognised one*.
* **The three deferred classes above**, until the follow-on unit lands.
* **Whether a definition comparison compares the RIGHT definition.** MI-001 checks that the fetched
  value is compared; not what it is compared against.
* **Anything requiring a database** — drift, real row counts, trigger state at deploy time. That is
  P37's and `b1:seals`' job.
* **The early lineage.** The findings behind #360/#361/#363 were about the migration's *semantics*
  — provenance, replay safety, linear-time walking — not its shape.

## Pre-review checklist for a new migration

Run `pnpm lint:migrations` first; it is 0.5s. Then, for what it cannot see:

1. **Every guard that refuses** — does it judge the object by definition, or by the name that found it?
2. **Every foreign key you verify** — does the check survive `ALTER TABLE … DISABLE TRIGGER ALL`?
3. **Every seal you install** — what re-asks the question on the *next* deploy, not this one?
4. **Every `SET`/`LOCK`** — is it inert for a caller that supplies no transaction?
5. **Every fast path** — does the lock you are relying on serialise the *snapshot*, or just the *statement*? (MI-005, deferred)
6. **Every name you hard-code** — is it pinned where Prisma can see it? (MI-006, deferred)
7. **Every constraint over pre-existing data** — does it abort with a sample, or fail inside the DDL? (MI-007, deferred)
8. **Every catalog attribute you compare** — which is attribute N+1? Enumerating N of them is what guarantees an N+1 round.

## Exemptions

`scripts/migration-lint-exemptions.json` records migrations merged before the linter existed, with
a written reason each. They are **recorded, not suppressed**: the measured verdict of MI-000..MI-004
over the 91 migrations on `main` at `756563c8` was 7 findings across 3 files, and each is listed
there with what it is. Two are marked **LIVE DEFECT** — the same classes the B1 lineage found, on
merged files — and are reported as candidates for their own units rather than fixed by this unit,
whose file surface does not include `apps/api/prisma/**`.

Two tests keep the ledger honest: every exemption must name a real migration and a real rule with a
checkable reason, and none may be *dead* — one that suppresses nothing is a claim about the corpus
that has stopped being true, and hides the next migration that reintroduces the shape.

## Adding a rule

Prove it RED against the real historical commit that produced the finding, pin that fragment in
`scripts/fixtures/migration-lint/`, and cite the PR and head in the rule's comment. **A rule that
does not fire on the head that produced its finding is not implemented** —
`scripts/migration-lint.test.mjs` asserts exactly that, in both directions, for every rule.
