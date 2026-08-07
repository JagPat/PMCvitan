# PR #287 convergence audit — CLOSURE 10's substrate is wrong

**Trigger:** two distinct finding-bearing heads on a three-file, test-only unit
(`bfd082b` — 3 findings; `2365d13` — 3 findings). `CLAUDE.md` makes this audit due and forbids a
third isolated patch.

**Verdict: the closure is not under-patched, it is built on the wrong substrate.** CLOSURE 10 asks
questions about **live PostgreSQL object state** and answers them by **parsing migration text**.
Migration text is not the authority for that question. Every one of the six findings is a way the
text parser diverges from the catalog, and the divergences are unbounded.

## The six findings are one defect

| Round | Finding | What the parser failed to model |
|---|---|---|
| 1 | last `ADD CONSTRAINT` wins | `DROP` — a stream read as a set |
| 1 | any function mentioning the column | trigger **attachment** |
| 1 | `raisedBy` missing `HeadroomMover` | *(source-level — correctly placed, see below)* |
| 2 | commented DDL counts as live | SQL **comments** |
| 2 | named helper assumed reached | **call reachability** from the attached body |
| 2 | any trigger counts | **timing / events / deferrability** |

Each patch taught the parser one more rule of SQL. The queue behind them is not empty:
`ALTER TABLE … DISABLE TRIGGER`, schema qualification, dollar-quoted bodies containing DDL-shaped
text, `CREATE OR REPLACE` overload resolution.

## The finding that ends the argument

**41 of 80 migrations wrap DDL in conditional `DO $$ BEGIN … END $$` blocks.** Whether those
statements execute depends on runtime `IF EXISTS` predicates evaluated against the then-current
catalog. A regex stream replay cannot evaluate them **even in principle** — it has no catalog to
evaluate against. On more than half this repo's migrations the parser is not approximating the
answer, it is guessing.

That is not a defect a third patch reaches.

## The project already solved this, one module over

`src/labour/t3c/` seals triggers against the live catalog, and its design notes name — in advance —
the exact three defects Codex found here:

- `T3C_TRIGGER_SEAL_SQL` joins `pg_trigger` on `tgrelid = to_regclass($2)`: **attachment** is the
  query, not an inference (round-1 finding 2).
- `T3C_TGTYPE` pins the **exact `tgtype`**, "equality, not a bitmask", explicitly because a trigger's
  name and bound function "still say nothing about WHEN it fires" (round-2 finding 3).
- The seal compares **byte-equal `pg_proc.prosrc`** against pinned canonical bodies, because
  "`CREATE OR REPLACE FUNCTION` preserves a function's identity, so a seal that stops at the bound
  function's NAME accepts a trigger still enforcing a PRE-correction body" (round-2 finding 2).

Comments, `DROP`, and conditional `DO` blocks are all structurally irrelevant to it: the catalog is
the post-migration state, however it was reached. CLOSURE 10 reinvented this in regex, and worse.

## The substrate boundary the closure actually has

The file's header states its premise: *"structural pins over source text… they run in `pnpm check`
with no database, so they fail at the desk."* That premise is sound for CLOSURES 1–9, which assert
**source** facts — a declared command names a real handler, an enumeration in file A matches file B.
Source text **is** the authority there.

CLOSURE 10 is the first to assert **database** facts, and it inherited a substrate that cannot carry
them. The root-A rule itself is not in question — a set written in two places must agree. What is in
question is reading one of those places out of migration text.

Note the asymmetry inside the round-1 findings: `HeadroomMover` was a genuine source-to-source
comparison and needed no database. It is the one finding that did not recur.

## Selected substrate

**Option (a), authorised by JagPat on PR #287.** The closure is split along the boundary its own
findings drew:

| Half | Substrate | Home |
|---|---|---|
| Source sets (`BudgetExceptionDto.raisedBy` ↔ `HeadroomMover`) | source text, no database | `commercial.contract.test.ts` |
| Live constraints, triggers, function bodies | `pg_constraint` / `pg_trigger` / `pg_proc` after migrations | `test/integration/commercial-catalog-closure.test.ts` |

Two sets are read by both halves, so each is extracted to ONE module rather than copied — root A's
own rule applied to root A's closure: `commercial.authority-guards.ts` (the seal classification) and
`commercial.raisedby-sets.ts` (the two source enumerations).

Deployed migrations are byte-for-byte unchanged; this correction is test- and closure-only.

## Proof map

| Requirement | Evidence |
|---|---|
| live `raisedBy` CHECK matches both source sets | `pg_get_constraintdef` parsed to labels, compared to `dtoRaisedByLabels()` and `writerRaisedByLabels()` |
| XOR names every consumption target | family derived from `schema.prisma`; `SodGrant_consumed_together` read from `pg_constraint` |
| each target's trigger is really attached | `pg_trigger.tgrelid = to_regclass('"SodGrant"')` — attachment is the query, not an inference |
| enabled | `tgenabled = 'O'` |
| DEFERRABLE INITIALLY DEFERRED row constraint trigger | `tgconstraint <> 0 AND tgdeferrable AND tginitdeferred` |
| fires on UPDATE, exact timing | `tgtype = 21` (ROW+INSERT+UPDATE, AFTER) — **equality, not a bitmask** |
| canonical body | `sha256(pg_proc.prosrc)` pinned per target (t3c precedent, hashed for size) |
| named helper is reached | `prosrc LIKE '%phase5_t6a_approval_override_valid%'` on the function bound to each live caller trigger |

**Hostile behavioural probes**, each mutating the live catalog inside a transaction and rolling
back, so the removal is real rather than mocked: dropped trigger attachment (function left intact —
precisely the state the retired parser called "validated"); weakened caller with the helper still
defined (a presence test would pass); same-name INSERT-only re-declaration (attached, enabled,
deferrable, correctly bound — and every consume UPDATE sails past); dropped CHECK while the
migration text still contains its `ADD CONSTRAINT` verbatim.

**Retired-parser probes** keep the audit's central claim executable rather than asserted: the old
design is shown accepting a commented example as installed DDL, and returning a body unconditionally
for a conditional `DO $$ BEGIN … IF NOT EXISTS` block.

The pins were mutation-checked, not merely observed passing: a wrong canonical hash and a wrong
expected `tgtype` each turn the suite RED (2 failed / 9 passed), so the closure fails when the
guarantee is removed.

## Round 3 — the root goes one level deeper than substrate

The catalog head drew five more findings. None of them said "go back to text": the substrate is
right. They said the *question form* was still wrong. On the correct substrate I was still asking
**presence** questions where the invariant is **enforcement**, and still identifying objects by
**name** where a name is not an identity:

| Loose question | What it accepts |
|---|---|
| `pg_constraint WHERE conname = $1` | a same-named CHECK on any other relation |
| `pg_proc WHERE proname = $1` for the hash | an overload or another schema, while the attached body is weakened |
| `prosrc LIKE '%helper%'` | `-- helper` in a comment |
| CHECK *mentions* both targets | a weakened rule admitting both at once |
| seal *exists* by name | a function whose triggers were all dropped |

So the root is not "text vs catalog". It is **asserting that the right words are present instead of
that the rule holds** — and text-vs-catalog was only its first and largest instance. Root A again,
one level in: the comment-stripping fix landed on the migration-text reader in round 2 and the
sibling survived in `prosrc`.

The correction that follows from that: where a hostile write is possible, **prove the refusal**, and
where identity matters, **reach the object the way the database reaches it** — through `conrelid`
and `tgfoid`, never through a name.

### Round-3 proof map

| Finding | Fix | Load-bearing proof |
|---|---|---|
| CHECK lookup by name | `conrelid = to_regclass($2)` on every lookup | decoy same-named CHECK on another relation: name-lookup finds 1, relation-bound finds 0 |
| XOR only mentions targets | six-tuple **behavioural** verdict table, live expression installed verbatim on a temp table under savepoints | a weakened CHECK that still mentions both is caught: `bothTargets: accepted` |
| hash re-queried by `proname` | hash `trg.prosrc`, the body reached through `tgfoid` | same-name decoy in a second schema makes `proname` ambiguous (2 rows) while the attached body is unambiguously the weakened one |
| function seals counted by name | `FUNCTION_SEAL_CALLERS` pins each helper's live callers: relation, attached, enabled, deferred, exact `tgtype`, canonical caller body — covering all three §G bound helpers, not only the override | dropping `Payment_bound_sealed` leaves the helper defined and the caller pin fails |
| substring reachability | canonical caller-body hash (preferred) **plus** comment-stripped call-expression parse | a comment-only mention keeps the substring true and both new checks false |

Mutation-checked, not merely observed passing: a raw-substring `callsFunction`, a stale caller hash,
and a wrong expected `tgtype` each turn the suite RED (2 failed / 14 passed).

### Round 3b — finishing the same correction across all three seal kinds

The round-3 head generalized the **function** arm and left the other two loose: trigger seals were
resolved by global `tgname` and proved only `tgenabled = 'O'`, and constraint seals fell through to a
`continue`. That is the same sibling pattern one more time — the fix landed on the arm the findings
named. Concretely, dropping `PaymentApproval_authority_live` and creating an enabled same-named
trigger on any other relation left the test green while approvals no longer required a live
certificate.

There is now **no default arm**. Every non-null `AUTHORITY_GUARDS` seal must carry exactly one
explicit expected-object specification, and a seal with none fails:

| Kind | Specification | Seals |
|---|---|---|
| trigger | owning relation, enabled, exact `tgtype`, deferral, bound function, canonical body via `tgfoid` | `PaymentApproval_authority_live`, `Payment_authority_live`, `PaymentApproval_approver_not_certifier` |
| constraint | owning relation + the required **behaviour** (the single-use verdict table) | `SodGrant_consumed_together` |
| function | expected live callers, each fully pinned | the three §G bound helpers + the §I override predicate |

A staleness check runs the other way too: a specification naming a seal `AUTHORITY_GUARDS` no longer
carries fails, so the map cannot keep proving an object nothing claims.

`SINGLE_USE_VERDICTS` is stated once and asserted by both the XOR test and the constraint seal —
the rule this closure exists to enforce, applied to the closure.

Two more hostile probes: a same-named **enabled** trigger on a decoy relation while the guarded
relation has none (the retired arm passed this), and a reattachment on the wrong event that keeps
name, relation, function and enabled state while never firing on INSERT. Mutation-checked: a wrong
owning relation and a stale canonical body each turn the suite RED.

### Round 4 — the same rule applied to three more places

Four findings on the round-3 head. The first was the trigger-seal binding already fixed above; the
other three are the same root reaching further:

| Finding | Sibling it names | Fix |
|---|---|---|
| helper's OWN body unpinned | the caller pin stops one level up the call graph: a byte-identical caller can call a predicate a later migration hollowed out | `HELPER_BODIES` pins each helper's canonical `prosrc`, resolved unambiguously in `public` (exactly one row) |
| `raisedBy` parsed, not exercised | `IN (...) OR "raisedBy" IS NOT NULL` mentions the same literals and admits anything | `labelVerdicts` — every admitted label accepted, an unknown label REFUSED, against the live expression |
| `match: 'above the'` too broad | a matcher of common words silently adopts the next refusal containing them, seal and all | matcher narrowed to `raises the claim's ceiling`, **and** a new desk closure requires every matcher to hit exactly one refusal and no two rows to claim the same one |

The third is the one worth naming: fixing the broad matcher alone would have been the instance, not
the class. The closure now forbids the class.

Mutation-checked: a stale helper hash and an inverted `raisedBy` expectation each turn the suite RED.

## Options considered

- **(a) Move the database half to the live catalog** — reuse the t3c idiom (`pg_constraint` for the
  live CHECK body, `pg_trigger` + exact `tgtype` for attachment and firing, `pg_proc.prosrc` for the
  body). All six findings become structurally unreachable. Cost: CLOSURE 10's database half leaves
  `pnpm check` for the `api` integration job — still PR-gating, no longer desk-speed.
- **(b) Drop the database claims**, keeping CLOSURE 10 as a pure source-set pin (DTO union vs
  `HeadroomMover`), and record the database seal as its own task. Smaller, honest, but leaves the
  `SodGrant` consumption-target family — the concrete regression root A was drawn from — unpinned.

**Recommendation: (a)** — selected. The precedent is in-repo, cleared, and was written against these
exact failure modes. (b) leaves the closure unable to fail on the instance that motivated it.

## Final state of the closure

| Half | Substrate | What it proves |
|---|---|---|
| source | `commercial.contract.test.ts`, no database | DTO union ≡ `HeadroomMover`; no `AUTHORITY_GUARDS` matcher is ambiguous |
| database | `commercial-catalog-closure.test.ts`, live catalog | every seal ENFORCED, per kind, with no default arm |

Nine hostile probes, each mutating the live catalog inside a transaction and rolling back: dropped
attachment with the function intact · weakened caller with the helper still defined · same-name
INSERT-only redeclaration · dropped CHECK still present in migration text · decoy CHECK on another
relation · weakened XOR that still mentions both targets · same-name function decoy in a second
schema · dropped §G bound trigger with its helper intact · comment-only helper mention. Two
retired-parser probes keep the audit's central claim executable. Every pin is mutation-checked.

## Open item carried forward

Root A landed on the test written to close root A in **every round of this review** — as the
stream-vs-set defect, then the substrate, then name-vs-identity, then the untouched trigger and
constraint arms, then the helper one level down the call graph. Five rounds, one root, each time in
a place the previous fix had not reached.

Two lessons, and the second is the one that generalises:

1. A closure must be built on the substrate that **owns** the fact it asserts. Source text answers
   source questions; only the catalog answers catalog questions.
2. **Fix the class, not the member.** Every round that ended cleanly did so because the correction
   was applied to the whole set the finding was drawn from — every reader got the stream discipline,
   every seal kind got a specification, every matcher got an ambiguity check — rather than to the
   one instance named. The rounds that recurred are exactly the ones where the previous fix stopped
   at the named instance.

Both belong in root A's statement in the module's convergence record, not only in this audit.
