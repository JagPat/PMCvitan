# Migration invariants

**How this repository knows its database is still guarded — and why it stopped trying to prove that
by reading SQL.**

## The question

Schedule B1 (`ActivityDependency`) ran `#354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 →
#412 → #415` and merged at the sixteenth head. Every round drew the same class of finding:

> **A check narrower than the object it judges.**

A constraint resolved by NAME where its DEFINITION was the guarantee. A foreign key verified VALID
without being asked whether it ENFORCES. A seal verified while its migration applied and never
asked about again. Each fix was correct; the next round found the shape somewhere new.

## The four units that tried to read it, and why they are retired

| Unit | Approach | Outcome |
|---|---|---|
| **#423** | hand-written SQL lexer + rules MI-000…MI-004 | closed at the two-finding-head limit |
| **#430** | libpg_query binding + an enforcement rule | closed at the limit |
| **#431** | binding + site attribution + a coverage claim | closed at the limit |
| **#432 → #433** | binding only; no rule, no sites, no coverage | #433 merged, and **detected nothing** |

**Four PRs, sixteen findings, and not one rule ever merged.** Every finding reduced to *a check
narrower than the object it judges* — the defect the rules existed to detect, restated as their
implementation. The last two rounds found it in the TESTS: a probe that searched source text for a
guard's message, and a leak probe that passed with the fix deleted.

That is not bad luck across four attempts. **Any static reader must MODEL the objects it reasons
about, and a model is narrower than the thing it models**, so the method returns its own reflection
however well it is written. A fifth attempt inherits it.

It also protected the wrong thing. A migration's source being well-shaped is not the property
anyone needs. The property is **this database is guarded right now**, and what breaks it is a bad
restore, a `prisma db push`, or an `ALTER TABLE … DISABLE TRIGGER ALL` — none of which touch the
source a linter reads.

**Retired, by JagPat's decision.** `scripts/pg-parse.mjs` and its `pg-query-emscripten` dependency
are removed with this unit: #433 shipped them, nothing consumed them, and dead machinery for an
abandoned approach is how the next attempt starts. **Never rebase or force-push
`claude/migration-invariant-linter`, `claude/migration-invariant-linter-v2`,
`claude/migration-parser-adapter` or `claude/migration-parser-binding`** — those four histories are
the handover record, and every rule ever written for them is committed there:

* MI-001 / MI-002 (name-over-definition; FK enforcement) — `d750175d`, with their exemption ledger
* MI-003 (apply-time-only seal) with its `migrate.sh` shell parser — `08835700`
* MI-000 (totality) and MI-004 (transaction scope) — `a8b401ba`
* MI-005 / MI-006 / MI-007 with measured corpus evidence — `a8b401ba`

## What replaces them

**Ask the catalog, not the files — on every deploy, about everything.**

`seals armed` (`apps/api/src/platform/seals/`) asks PostgreSQL whether every enforcement object in
the `public` schema is switched on. `scripts/migrate.sh` runs it on the ordinary success path,
beside `t45`, `t2c`, `t3c seals` and `b1 seals`.

**Total by construction: you cannot be narrower than the object you judge when the object IS the
catalog and you asked it.** There is no inventory to maintain, no snapshot to regenerate, no site
attribution and no coverage accounting — the three surfaces that drew the findings that closed #431
and #432. Measured on a ledger-complete database: **1,051 enforcement objects** — 387 foreign keys,
187 user triggers, 180 CHECKs, 132 primary keys, 165 plpgsql bodies.

Four mechanisms leave an object present in the catalog and not enforcing. Each is real and each was
reproduced against a live PG16 before the check was written:

| | Mechanism | Why a catalog-reading guard misses it |
|---|---|---|
| **F1** | trigger `DISABLED` | it still exists; only `tgenabled` moved |
| **F2** | foreign key blinded by `DISABLE TRIGGER ALL` | `conname`, `contype`, `conrelid`, `confrelid` **and `convalidated`** are byte-for-byte unchanged |
| **F3** | constraint added `NOT VALID`, never validated | it is present and enforces nothing for rows already there |
| **F4** | `relhastriggers = false` | every trigger row survives intact and PostgreSQL skips all of them |

`apps/api/scripts/armed-seals-falsification-proof.sh` drives the **real** `migrate.sh` over a
ledger-complete database, applies each mechanism in turn, and requires a refusal that NAMES the
object — then requires a pass once repaired, so the check is proven **precise and not merely
strict**. Its CI wiring is pinned by `scripts/ci-baseline-proof-wiring.test.mjs`, so deleting the
step turns a required job red.

### What this deliberately does not claim

It verifies that an object is **armed**, not that its **definition** is the one the migration
installed. A body hollowed by `CREATE OR REPLACE` keeps its name, OID, volatility and search_path
pin, and this check cannot see it — measured: the digest changes, `migrate.sh` exits 0. That
question needs a canonical expectation to compare against. `t3c seals` and `b1 seals` already
answer it for their own migrations, which is why all three run: **they compose.** Extending
canonical-body verification to the whole catalog is the natural next unit, and claiming it here
would be the very thing this file refuses.

## The live defects, and what backstops them now

`apps/api/prisma/**` is read-only to this unit, so none is repaired here.

* **`20270225000000_phase4_t3_correction3:167`** verifies prerequisite composite foreign keys by
  `conname` + `conrelid` + `contype='f'` + `convalidated`, never reading `tgenabled`. **Now
  backstopped (F2):** a deploy over a database whose keys were blinded is refused, even though this
  migration's own guard would still pass.
* **`20270415000000_phase5_t3_measurement:39-74`** — eight `IF NOT EXISTS (… WHERE conname = '…')`
  guards that do not read `conrelid`, so a same-named constraint on any table satisfies them.
  **Not backstopped.** This is a *false clearance at apply time*, not an unarmed object; it needs
  the canonical-definition unit above.
* **`20270920000000_decision_option_kinds:273`** installs `CONSTRAINT TRIGGER`s, verifies them once
  while applying, and names no deploy-time counterpart. **Now backstopped (F1)** — and this is the
  measurement that produced this unit: with those two seals disabled, `migrate.sh` exited 0 and
  never named them.

## If a deploy refuses

See `docs/RUNBOOK.md §SEALS`. The refusal names every object and why it does not enforce; the
repair is to re-arm or re-validate it and redeploy. **Never** repair by weakening the check.

## Adding an enforcement object

Nothing to register. Install it in a migration and the catalog carries it into the inventory on the
next deploy — that is the point of asking the catalog rather than keeping a list. If you add a
constraint *kind* PostgreSQL has never had, `seals armed` reports it as `unclassified` and fails,
rather than skipping the row: a kind nobody reasoned about is exactly how a check ends up narrower
than the object it judges.
