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

## The finding classes this unit ships

Each rule names the PR and head whose finding produced it. **The head that CARRIES a defect is the
predecessor of the PR whose title announces the fix** — the mapping was verified against `git log`,
and it is easy to get off by one round.

| Rule | The invariant | RED at | GREEN at |
|---|---|---|---|
| **MI-001** | An object resolved by NAME inside a guard that refuses must be compared by DEFINITION *in that guard* — and the definition must actually be *compared*, not merely fetched and NULL-tested. | `a222e91` (#411) | `96c9cc4` (#412) |
| **MI-002** | A foreign key verified through `pg_constraint` must also be asked whether it ENFORCES, via `pg_trigger.tgenabled` on `tgconstraint`, *in the same guard*. | `a222e91` (#411) | `96c9cc4` (#412) |
| **MI-003** | A migration that installs seals and verifies them must have a counterpart *invoked* from `migrate.sh` after `prisma migrate deploy` succeeds — an invocation, never a diagnostic that merely names the repair procedure. | `a222e91` (#411) | `96c9cc4` (#412) |

**These three are one concern: IS THE CHECK AS WIDE AS THE OBJECT IT JUDGES?** They are the rules
the schedule-B1 lineage's sixteen heads actually produced, and they are what found the two latent
defects on already-merged migrations recorded below. Each rule's full reasoning — the exact
interleaving, what was measured, and why the narrower form passed review — is in the comment above
its implementation in `scripts/migration-lint.mjs`.

## The per-site correction — Codex findings F1, F2, F3

Codex returned seven findings against head `c6e9ff17`. **Four of them were one defect**, and it is
this linter's own subject matter one meta-level up: **a file-global test standing in for a per-site
check.**

| | The rule asked | The question that matters |
|---|---|---|
| MI-001 (F2) | does this FILE contain a definition read? | is **this guard's** object compared by definition? |
| MI-002 (F3) | does this FILE mention `tgconstraint`? | does **this key's** guard read enforcement? |
| MI-003 (F1) | does this FILE's `migrate.sh` contain the token? | did a verifier **actually run**? |
| MI-004 (F4) | does this FILE contain a `BEGIN`? | is **this statement** inside a transaction? |

*"A check narrower than the object it judges"* and *"a check wider than the site it judges"* are the
same error wearing opposite clothes: in both, the evidence and the claim are about different things.
One satisfied site silently discharged the requirement at every other site, and one correct guard
shielded an arbitrary number of defective neighbours.

**Every proof is an ADJACENT-DECOY fixture**, and that is not decoration. Each carries TWO sites —
one correctly guarded, one not. A fixture with a single unguarded site fires before *and* after the
fix and proves nothing: only a satisfied neighbour shows that the rule stopped accepting one site's
evidence for another's. Each was confirmed to produce **no finding of its rule** when run against
the `c6e9ff17` implementation before the corrected rule was written.

F1 is the expensive one. An `echo` is an executable line too — `migrate.sh:130` reads
`echo "… Repair per docs/RUNBOOK.md section B1, then redeploy."` — so a token-after-deploy test
reported GREEN whether or not anything verified anything. Identifying the *invocation* took a shell
parser (`guardedProcedureTokens`): a procedure token counts only when it stands inside the failure
branch of a command that runs something, after `prisma migrate deploy`. It **fails closed** — a
construct the parser cannot read yields no guarded tokens, so the rule fires rather than clearing.

## The scanner ships here regardless of the cut — F6, F7

Every rule's correctness rests on `migration-sql-scan.mjs` identifying statements and blocks
correctly, so the two scanner desyncs ship with the rules that stand on them rather than after:

* **F6** — dollar-tag recognition skipped line comments and literals but not BLOCK comments, so two
  comments carrying matching `$tag$` fabricated a block and swallowed the real `DO $$` opener
  between them.
* **F7** — a backslash escape inside an `E'…'` literal ended it early, so the real closing quote
  opened a runaway literal that masked everything to the next quote.

Both probes hide a **catalog guard** and prove the fix through MI-001, the rule that judges guards.
That re-expression is a direct cost of deferring MI-004: at `a8b401ba` the same two probes hid a
`SET LOCAL` and proved the fix through MI-004. **F5** (the constraint inventory required a
double-quoted name) is only observable through MI-000's totality claim, so it travels with MI-000.

## Deferred, and exactly where each one lives

**Nothing below is deferred silently, and the live defects among them stay reported.**

### MI-000 and MI-004 — deferred as COMMITTED, CORRECTED CODE at `a8b401ba`

| Rule | The invariant | RED at | GREEN at | State |
|---|---|---|---|---|
| **MI-000** | Every statement, constraint and `DO` block classifies. An unrecognised construct is a finding. | — (corpus property) | — | Implemented, corrected for F5, tests green at `a8b401ba` |
| **MI-004** | No `SET LOCAL` or `LOCK TABLE` outside the `BEGIN`…`COMMIT` it actually stands between. | `c1054005` (#410) | `2f0e2af9` (#415) | Implemented, corrected for F4 per-site, tests green at `a8b401ba` |

These two are **not prose to be re-derived.** `a8b401ba` is the immediate predecessor of this head
on this branch, and it carries their implementations, their fixtures
(`mi000-unnamed-constraints.sql`, `mi004-red-c1054005.sql`, `mi004-decoy-after-commit.sql`,
`green-2f0e2af9.sql`), their RED/GREEN and adjacent-decoy tests, and their exemption-ledger entry
(`20270826000000_phase6_t4b_approval_attribution` / MI-004, a bare top-level `LOCK TABLE`, accepted
with a recorded divergence). The follow-on unit starts from corrected code: `git show a8b401ba` is
the whole handover, and F4, F5, F6 and F7 do not need rediscovering.

**THE GAP THIS LEAVES, STATED RATHER THAN HIDDEN.** MI-001 and MI-003 decide what to ask of a `DO`
block *from its role*, so a block that classifies as nothing is checked by neither. MI-000 is the
rule that FAILS on such a block during `pnpm lint:migrations`; until it lands, only the corpus test
in `migration-lint.test.mjs` asserts the property. A new migration carrying an unrecognised
construct therefore fails `pnpm test:automation` but **not** `pnpm lint:migrations`. That is a real
weakening of the backstop and it closes when MI-000 lands.

### MI-005, MI-006, MI-007 — deferred with measured corpus evidence

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

## The two LIVE DEFECTS this unit reports and does not fix

`apps/api/prisma/**` is read-only to this unit, so both are recorded in the exemption ledger with a
written reason and pinned by a test that fails if either moves, is fixed, or is joined by a third.

* **`20270225000000_phase4_t3_correction3:169` — MI-002.** Verifies the prerequisite composite
  foreign keys by `conname` + `conrelid` + `contype='f'` + `convalidated`, and never reads
  `tgenabled`. `DISABLE TRIGGER ALL` leaves every column that guard reads unchanged while the keys
  stop enforcing, so a restored database with no containment passes the prerequisite and is
  baselined.
* **`20270920000000_decision_option_kinds:273` — MI-003.** Installs `CONSTRAINT TRIGGER`s and
  verifies them against the catalog, but names no RUNBOOK procedure and has no counterpart in
  `migrate.sh`. Once its row is in `_prisma_migrations` the seals are never checked again, so a
  restore that drops or disables them yields a green deploy.

Each needs its own unit. Shipping MI-002 and MI-003 now means those units land with a CI backstop
that proves the fix holds, rather than on an assertion.

## The measured corpus verdict, per site

15 findings across 3 migrations on `main` at `8a4b0db8` — MI-001 13, MI-002 1, MI-003 1 — every one
recorded in `scripts/migration-lint-exemptions.json` with a written, checkable reason.

The per-site binding **raised these counts sharply, and that is the rules working.** MI-001 alone
went from 4 to 13 once one guard's definition read stopped excusing every other guard in the file.
Two of those thirteen — the B1 migration's sections 1 and 9, both `pg_trigger` — were **invisible
before the correction**, excused by section 8's `pg_get_triggerdef`. Ten are in
`20270225000000_phase4_t3_correction3` (was 3), accepted because the comparison lives in the
compiled `t3c seals` verifier that gates every `migrate.sh` path. One is in
`20270920000000_decision_option_kinds`, accepted because it is a failed apply, not a false clearance.

## Review size

This unit exceeds the 1,500-line standard budget and **no `justified-large` marker is claimed for
it**. The measured figures, the seams that were built and measured rather than estimated, and what
each seam would cost are in the pull request body, which is where the review-size decision is made.

## Design: enumerate and classify, do not grep

This is deliberately **not** a list of known-bad patterns. A grep for the seven fragments the B1
lineage happened to produce would itself be a check narrower than the object it judges — the exact
defect it exists to catch. So wherever the artifact is enumerable, the linter enumerates it and
classifies **every** member:

* every top-level statement is classified by kind (`STATEMENT_KINDS`)
* every `DO` block is classified by role (`BLOCK_ROLES`), from its enclosing statement first
* every catalog object resolved by name is paired against a definition read **in its own guard**

The vocabularies were derived by enumerating the real corpus — 1,684 top-level statements across
the 91 migrations — not by guessing what SQL might contain, and that is load-bearing: a first draft
also listed nine verbs the repository has never used in a migration, every one of which would have
let a future construct through silently.

**Two rules cannot be expressed that way, and the reason is stated rather than hidden.**

* **MI-003** asks whether a migration's self-verification is reachable from `migrate.sh`. Nothing in
  the SQL names its own verifier — the link between the B1 migration and
  `dist/activities/b1/b1.cli.js` existed only in a human's head. Enumeration cannot recover a link
  never written down, so the rule reads the one the corpus already has: the shared
  `docs/RUNBOOK.md §X` procedure token both files name. A migration using no RUNBOOK procedure may
  declare it explicitly with `-- migration-invariants: deploy-verifier <token>`.
* **MI-006**, deferred, asks what Prisma's generator would *do*. Deriving that would be a second
  implementation of someone else's naming rules — the same defect one level up. #415 ships the
  honest form as probe **P37** (`prisma migrate diff`, asked of Prisma itself against a live
  database); the rule instead asks only that each hard-coded name be *pinned*.

## What it would NOT have caught

Stated plainly, because a linter trusted beyond its reach is worse than none:

* **Nothing about correctness of the rule being enforced.** MI-002 checks that a key is asked
  whether it enforces. It cannot tell you the key should not exist, or that the seal beside it is
  about the wrong thing.
* **`provolatile`, `proconfig`, ownership, the column contract.** Several B1 rounds turned on
  catalog attributes beyond the classes here.
* **An unrecognised construct, during `pnpm lint:migrations`** — that is MI-000, deferred; see the
  gap stated above.
* **Whether a definition comparison compares the RIGHT definition.** MI-001 checks that the fetched
  value is compared; not what it is compared against.
* **Anything requiring a database** — drift, real row counts, trigger state at deploy time. That is
  P37's and `b1:seals`' job.
* **The early lineage.** The findings behind #360/#361/#363 were about the migration's *semantics*
  — provenance, replay safety, linear-time walking — not its shape.

## Pre-review checklist for a new migration

Run `pnpm lint:migrations` first; it is 0.5s. Then, for what it cannot see:

1. **Every guard that refuses** — does *that guard* judge the object by definition, or by the name that found it?
2. **Every foreign key you verify** — does *that guard's* check survive `ALTER TABLE … DISABLE TRIGGER ALL`?
3. **Every seal you install** — what re-asks the question on the *next* deploy, not this one?
4. **Every `SET`/`LOCK`** — is it inert for a caller that supplies no transaction? (MI-004, deferred)
5. **Every construct the linter has never seen** — does it classify? (MI-000, deferred)
6. **Every fast path** — does the lock you are relying on serialise the *snapshot*, or just the *statement*? (MI-005, deferred)
7. **Every name you hard-code** — is it pinned where Prisma can see it? (MI-006, deferred)
8. **Every constraint over pre-existing data** — does it abort with a sample, or fail inside the DDL? (MI-007, deferred)
9. **Every catalog attribute you compare** — which is attribute N+1? Enumerating N of them is what guarantees an N+1 round.

## Exemptions

`scripts/migration-lint-exemptions.json` records migrations merged before the linter existed, with
a written reason each. They are **recorded, not suppressed**: the measured verdict over the 91
migrations on `main` at `8a4b0db8` is 15 findings across 3 files, and each is listed there with what
it is. Two are marked **LIVE DEFECT** and are reported as candidates for their own units rather than
fixed by this unit, whose file surface does not include `apps/api/prisma/**`.

Two tests keep the ledger honest: every exemption must name a real migration and a real rule with a
checkable reason, and none may be *dead* — one that suppresses nothing is a claim about the corpus
that has stopped being true, and hides the next migration that reintroduces the shape.

## Adding a rule

Prove it RED against the real historical commit that produced the finding, pin that fragment in
`scripts/fixtures/migration-lint/`, and cite the PR and head in the rule's comment. **A rule that
does not fire on the head that produced its finding is not implemented** —
`scripts/migration-lint.test.mjs` asserts exactly that, in both directions, for every rule.
