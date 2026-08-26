# Schema-enforcement convergence — one relation universe

**Unit:** #437 (`Replaces: #436`) · **Cause:** four findings, one defect · **Remedy:** state the
universe once and derive every clause from it.

## The four findings were one defect

| | Finding | Head | Seam it exposed |
|---|---|---|---|
| 1 | cross-schema referenced tables excluded from the bypass scan | `af93acdc` | schema filter |
| 2 | repair statement interpolated raw catalog text into a literal *and* a quoted identifier | `af93acdc` | identifier quoting |
| 3 | `relkind` filter excluded foreign tables | `20e80b3c` | relation kind |
| 4 | applicability gate still counted only `relkind IN ('r','p')` | `c8be27a2` | relation kind, one level up |
| 5 | a sequence-only schema counted as applicable, so `verify` exited 0 instead of 4 | `c14f9ea1` | applicability admitted relations no clause judges |
| 6 | a disabled trigger on a cross-schema parent was printed under the application schema | `c14f9ea1` | the widened reach outran the diagnostic |

Findings 5 and 6 came from the convergence head itself and are recorded here rather than in a
separate packet, because they are the same story: **5** is the universe admitting members no clause
judges, and **6** is a clause reaching further than its diagnostic could describe. Both are the cost
of widening, found where widening was applied.

Findings 1, 3 and 4 are the same question asked in three places — **which relations does this check
judge?** — answered three different ways, in three separate filters. Widening one left the others
behind, so each correct fix exposed the next seam. Finding 2 is the same failure in a different
register: the repair string was built from catalog text the check had not decided how to treat.

**This is not four bugs that happened to land near each other.** Clause 4 was bolted onto
scaffolding written for ordinary tables in one schema, and every place that scaffolding stated its
own reach became a place the two could disagree.

## The remedy

`UNIVERSE` in `enforcement-check.ts` states membership **once**:

> a relation is in the universe when it is IN the application schema, or when an application-schema
> FOREIGN KEY references it.

Applicability, clause 1's reach, clause 4's reach and every count now read that one definition.
There is **no `relkind` filter anywhere** — `grep -c "relkind IN"` over the check returns 0.

That absence is the substance, not a tidy-up. Foreign tables carry row triggers (verified on PG16),
views carry `INSTEAD OF` triggers, partitioned tables carry both. Any list of "kinds that can be
sealed" is a list a later PostgreSQL outgrows — enumerating them is exactly what produced findings 3
and 4. Membership is *"PostgreSQL has a `pg_class` row for it here"*; what a clause **asks** of a
member is driven by what that member **has** — triggers present, a flag off, a key unvalidated —
never by what kind it is. A relation with no triggers has nothing to bypass and is never reported.

Finding 2 is closed in the same spirit: the repair is built by PostgreSQL
(`quote_literal(format('%I.%I', …))`), not by string concatenation that has to anticipate which
characters need escaping.

## RED reproduction

| Probe | RED at | Nature |
|---|---|---|
| **1** truly empty schema stays NOT APPLICABLE | `c8be27a2` | **rename only** — `counts.tables` → `counts.relations`. The *behaviour* is unchanged and deliberately so; this probe exists to prove the widening did not cost it. |
| **2** schema holding only a foreign table | `c8be27a2` | **behavioural** — was `applicable: false`, bypass unreported, preflight accepted it |
| **3** schema holding only a trigger-bearing view | `c8be27a2` | **behavioural** — same short circuit, one relkind over |
| **4** cross-schema referenced parent | `af93acdc` | behavioural (fixed in `20e80b3c`, retained) |
| **5** quoted identifiers | `af93acdc` | behavioural (fixed in `20e80b3c`, retained) |
| **6** sequence-only schema stays NOT APPLICABLE | `c14f9ea1` | behavioural — was applicable, `verify` exited 0 where the contract says 4 |
| **7** cross-schema disabled trigger named in its own schema | `c14f9ea1` | behavioural — was printed as `public."Ref"` for a trigger on `othr."Ref"` |

Probes 2 and 3 are the finding-4 reproduction. Probe 1 is honestly labelled: it goes red on a field
rename, not on a behaviour change, and claiming otherwise would overstate the evidence.

Every probe asserts `disabledTriggers.total === 0` in its own state. That is what proves clause 4 is
not redundant with clause 1 — without it, a probe could pass because some *other* clause fired.

## Regression surface

The widening touches the applicability contract, which is load-bearing:
`enforcement.cli.ts` gates `ok` on `report.enforcing && (report.applicable || cmd === 'preflight')`
and exits 4; `migrate.sh` reads it at three sites (preflight, post-deploy verify, post-baseline
verify).

**Applicability changed only for schemas that hold relations but no ordinary tables.** A fresh
database holds no relations at all, so it still reads not-applicable:

* `schema-enforcement-production-runner-proof.sh` — **14 states, 0 failures**, including **A**
  (fresh/empty passes preflight), **G** (empty fails `verify` with exit 4) and **D2**.
* `schema-enforcement.test.ts` — **18/18**.
* `counts.tables` → `counts.relations` is a report-shape change; the `note` string now reads
  *relations* and says the universe includes referenced parents.

## Remaining risk, stated

1. ~~**A schema holding only non-relational objects** … so no deploy behaviour changes.~~
   **THAT CLAIM WAS WRONG, and Codex found it (finding 5).** Deploy behaviour *did* change: a
   sequence-only schema read applicable, so `verify` exited 0 where the contract says 4, and a
   deploy that created only non-table objects would have passed the final gate. Corrected: a
   relation counts toward applicability only if it carries at least one trigger or constraint —
   still derived from what a relation HAS, not from a list of relkinds. MEASURED: all 132 relations
   in the migrated schema carry one, so nothing real is excluded. The lesson kept: "the boundary
   moved but nothing depends on it" is a claim that has to be checked against the contract, not
   asserted from the shape of the diff.
2. **`counts.relations` counts every `pg_class` row in the schema**, so it is larger than the old
   table count and is not a table census. The `note` says so; a reader expecting "tables" gets
   "relations".
3. **Clause 1 now reaches cross-schema parents.** A disabled *user* trigger on a referenced table in
   another schema is now a finding. That is the consistent reading of one universe, and it is a
   widening: a schema that legitimately parks a disabled trigger on a table this application
   references will now be refused. No such case exists in this repository — measured, not assumed —
   but it is the change most likely to surprise. **Finding 6 was the other half of this risk that I
   did not see:** the reach widened but `TriggerFinding` still carried no schema, so the diagnostic
   named a cross-schema trigger under the application schema. Widening a reach obliges widening
   everything downstream that describes what it found.
4. **The universe is a closed rule, not a proof of totality.** It says which relations are judged. A
   future defect class that is not about relation membership — a seal that is present, armed and
   correct but semantically wrong — is outside it, as `enforcement-check.ts` already states.
