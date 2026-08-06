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

## Open item carried forward

Root A is now **twice** confirmed to land on the test written to close it — first as the stream-vs-set
defect, now as the substrate. The lesson is not "check for siblings harder"; it is that a closure
must be built on the substrate that *owns* the fact it asserts. That belongs in the root's statement,
not only in this audit.
