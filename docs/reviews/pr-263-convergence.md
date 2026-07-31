# Convergence audit — PR #263 (risk-based CI)

Required by `CLAUDE.md` after two distinct finding-bearing heads. This is an
architectural audit, not a third isolated patch.

| Head | Findings |
| --- | --- |
| `13135fc` | 7 (F1–F7) |
| `50ef5e0` | 3 (N1–N3) |

## Ten findings, two root causes

Seven of the ten are two recurring mistakes, not ten independent bugs.

### Root cause A — "safe by location, not by consumer" (4 instances)

| Finding | Path called safe | What actually consumes it |
| --- | --- | --- |
| F1 | `scripts/` | `scripts/test-api-e2e.sh` **is** the api-e2e runner |
| F3 | `.github/` | `ci.yml` defines every product job's commands |
| F5 | `apps/api/` (generic) | the upgrade-proof job runs `apps/api/scripts/upgrade-proof.sh` |
| N3 | `docs/**.md` | an API integration test reads `docs/RUNBOOK.md` |

Each time I asserted safety from **where a file lives** rather than **what reads
it**, and each fix was a point correction that left the method intact — so the
method produced the next instance. F1/F3 were already "fixed by subtraction" in
round 1, and N3 still appeared, because `docs/` was never re-examined under the
same lens.

**Structural fix (this head):** the safe set is now *self-verifying*. `R18`
scans the real product test sources for reads of any path the classifier calls
safe and fails if one is not in the `DOCS_CONSUMERS` register. Instance five
fails CI instead of shipping. The register currently holds exactly one entry —
verified against the tree, not asserted.

This converts a claim I kept getting wrong into a claim the build checks.

### Root cause B — composition with the existing gate machinery (3 instances)

| Finding | What I reasoned about in isolation |
| --- | --- |
| F6 | a classification skip reads as MISSING to `summarizeRequiredChecks` |
| N1 | a base retarget forces the full battery — and my `&&` silently narrowed it |
| N2 | `battery-plan` counts a FAILED run as coverage; all-skips then reads green |

`classify` does not stand alone: it composes with `battery-plan` (which decides
whether this head is covered) and with the orchestrator (which decides what
"covered" means). I designed the new gate against each of those separately.

**Structural fix (this head):** the three composition points are now explicit
and each has a probe — `R16` (twin publishes the name), `R17` (retarget forces
all, and the twins stand down), `R19` (a battery-plan skip cannot mask a red
head). The remaining three findings (F2 injection, F4 renames, F7 truncation)
are input-pipeline hardening and share no root cause.

## The honest status of the original safety claim

The first packet led with: *unknown widens, so cheaper CI never means weaker CI.*

That claim was **overstated**, twice over:

1. It is only as strong as the *known* set, and the known set was wrong four times.
2. F2 showed the widening path was itself a narrowing primitive — an unknown
   filename containing `\nsuites=` could blank the output.

Both are now closed, and the claim is no longer a matter of my judgement: the
safe set is enforced by `R18` against the real tree, and the output is
unforgeable by construction. That is the difference between this head and the
previous two.

## Was abandoning the right call instead?

Considered seriously, because the alternative to converging is stopping.

Against: statically deciding test impact is a genuinely hard problem, normally
solved with dependency analysis rather than a hand-written map — and my map was
wrong four times.

For continuing: the consumer-scan makes the failure mode *loud* rather than
silent, which is the property that was missing. A wrong map that fails CI is
categorically different from a wrong map that skips a suite quietly. With that
in place the residual risk is bounded by something the build checks, not by my
inspection.

If the next review is still finding-bearing on the classifier's *safety* (rather
than its plumbing), the recommendation flips to abandoning path-based
classification and keeping only the `quality-gate` consolidation, which has
been finding-free since it was introduced.

## Verification

| Gate | Result |
| --- | --- |
| focused suite | **29/29** (20 → 26 → 29 across the three heads) |
| `pnpm test:automation` | **200/200** |
| `pnpm check` | see the commit; EXIT 0 |

Each of the three new fixes reverted in turn fails its own probe (`R17`, `R18`,
`R19`); the five from round 1 remain discriminated.
