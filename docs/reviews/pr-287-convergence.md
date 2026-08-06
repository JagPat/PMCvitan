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

## Options

- **(a) Move the database half to the live catalog** — reuse the t3c idiom (`pg_constraint` for the
  live CHECK body, `pg_trigger` + exact `tgtype` for attachment and firing, `pg_proc.prosrc` for the
  body). All six findings become structurally unreachable. Cost: CLOSURE 10's database half leaves
  `pnpm check` for the `api` integration job — still PR-gating, no longer desk-speed.
- **(b) Drop the database claims**, keeping CLOSURE 10 as a pure source-set pin (DTO union vs
  `HeadroomMover`), and record the database seal as its own task. Smaller, honest, but leaves the
  `SodGrant` consumption-target family — the concrete regression root A was drawn from — unpinned.

**Recommendation: (a).** The precedent is in-repo, cleared, and was written against these exact
failure modes. (b) leaves the closure unable to fail on the instance that motivated it.

## Open item carried forward

Root A is now **twice** confirmed to land on the test written to close it — first as the stream-vs-set
defect, now as the substrate. The lesson is not "check for siblings harder"; it is that a closure
must be built on the substrate that *owns* the fact it asserts. That belongs in the root's statement,
not only in this audit.
