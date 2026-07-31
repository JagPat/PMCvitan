# Review packet — the exclusive work lease

At most one open `claude/**` pull request, as a state the runner must consult —
not a rule it is asked to remember.

## Correction round 1 — head `602c666`, five findings

All five are real. They are also **one defect**, which is why they are corrected
together rather than patched one site at a time.

> The lease was **advisory**: assessed but never held, and its verdict decorated
> the start instruction instead of gating it.

| # | Finding | Where the single defect shows |
| --- | --- | --- |
| P1 | Start instructions not gated on a blocked lease | the verdict was appended *beside* "start the next permitted work item", and `buildPostMergeContinuation` never received it at all |
| P1 | Lease never acquired before publishing new work | two backlog drains from one free state both render a start |
| P2 | Lease never released when its PR merges | a finished unit keeps blocking the next one |
| P2 | The lease holder treated as a stranger to its own PR | one call site passed an empty intent for every consumer |
| P2 | `Active work: none` matched as a substring | `nonee`, and a stale `none` line beside a held line, both read as FREE |

This is the objection PR #259 drew — *a model nothing consults governs nothing* —
recurring inside the pull request that cited it. The first version built the state
and the verdict, then left the lifecycle "as a natural follow-on". That deferral
was not a scoping decision; the lifecycle **is** the feature. Assessment without
acquisition is a comment.

## The change: the lease becomes operative

Five mechanisms, one shape — the words that start a unit are not obtainable
without the obligation that comes with them.

```js
export function startInstruction({ verdict, claimId, head })
// → { permitted, text, acquire }
```

`text` and `acquire` are returned **together**. A caller can print the start
wording only by receiving, in the same value, the lease it must persist. "Told the
runner to start but never recorded it" is not something a caller forgets — it is
something a caller must deliberately discard. `C3d` pins that the wording exists
in exactly one source file, so the pairing cannot be bypassed by retyping it.

| Mechanism | Rule |
| --- | --- |
| **Gate** | builders take `start` and use `start.text`; with no verdict at all they print `NOT ASSESSED — do not start new work` (fail closed) |
| **Acquire** | publishers persist `acquire` **before** posting. A failed post leaves the lease held — blocking and recoverable — rather than free, which duplicates and is not |
| **Pending claim** | a lease may be held before its PR exists (`Active work: pending:<claimId> …`). Without this the window between "start this unit" and "the PR is open" is unprotected, which is the window two drains both walked through |
| **Release** | `releaseOnMerge` frees the lease when the merged PR is its holder |
| **Identity** | `leaseFor(intent)` replaces a single pre-computed verdict; there is no bare `lease` to read by mistake. Each consumer states who it is |
| **Parse** | `readLease` counts candidate lines first: 0 → free, >1 → unreadable, 1 → exact-match free/held, unknown state → unreadable |

The in-run copy is what `leaseFor` reads, so a claim taken by the first drain is
visible to the second. That is the whole of finding 5.

## Two things I got wrong, recorded rather than repaired quietly

**The original `L6` pinned the defect as expected behaviour.** It asserted that a
drift handoff posted to the lease holder's own PR reads `Work lease: BLOCKED` —
which is exactly finding 4. It passed because it constructed the empty intent
itself. This is the fourth probe in this lineage to test its own fixture instead
of the code, and the first to encode a bug as a requirement. It is replaced by
`C2c`/`C2d`, which drive `handOffStatusDrift` end to end.

**My first fix for finding 4 was decorative, and the discrimination pass caught
it.** Reverting the intent left the suite green: the shepherd branch consulted the
lease *nowhere*, so passing the correct identity changed nothing observable. I had
removed the symptom by restructuring the builder and added a parameter nothing
read. The fix is now load-bearing — assessed as the PR being shepherded, a lease
naming a *different* unit is reported as the disagreement it is (`C2d`) — and
reverting the intent fails `C2c`. Had I not run the reverts, I would have shipped
a second advisory mechanism in the correction for an advisory mechanism.

## Review unit

| | |
| --- | --- |
| Base SHA | `503b10c` (`main`) |
| Corrected head | `602c666` |
| Concern | one: the lease as operative state |
| Changed files / lines | **7 files, 1,013 lines** — inside the 20-file / 1,500-line budget |
| Migrations | none |
| Product surface | none — `scripts/` automation only |

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | None — no auth, membership, org or project scoping touched. The lease governs only which automation branch may proceed, under the existing trusted-workflow identity | No `apps/api` or `apps/web` source in the diff |
| civil-time-lifecycle | The cursor carries a merge timestamp; a renderer that mangled it would rewind the backlog and re-hand-off merged work | `L4`/`L4b`/`L4e` round-trip the cursor through a lease write, a release and a pending claim; `L5` pins fallback rather than invention |
| concurrency-idempotency | Two backlog drains in one run; two writers on one issue body; a claim must be visible to whatever runs next | `C4` (second drain sees the first's claim), `C5b` (release makes the next start available), `L4c` (no lease-only writer exists) |
| data-integrity-conservation | The conserved quantity is the pair (cursor, lease). Losing either re-runs merged work or permits a second concurrent unit | `L4`/`L4b`/`L4d`/`L4e`, `C1` (corrupt or duplicated lines are unreadable, never free), `L2` (a free lease disagreeing with open PRs is reported, never assumed) |
| offline-reconciliation | None — no client outbox, IndexedDB or replay path touched | No `apps/web` source in the diff |
| ui-server-parity | None — no UI, API response, DTO or contract changes | `pnpm check` runs the full web (543/543) and API (680/680) suites unchanged |

## Verification

`scripts/autonomous-work-lease.test.mjs` — **28/28**.

### Discrimination — each mechanism reverted in turn

| Reverted | Probes that failed |
| --- | --- |
| substring `none` parse (finding 2) | `C1` |
| builder prints its own start text (finding 1) | `C3`, `C3b`, `C3d`, `C4` |
| empty intent at every call site (finding 4) | `C2c` |
| assessed but never acquired (finding 5) | `C4` |
| never released on merge (finding 3) | `C5`, `C5b` |
| — restored — | **28/28** |

Two test fakes and three literal continuation contexts had to gain `leaseFor` /
`acquire`. The call is deliberately **not** optional-chained: a context that
cannot answer "may the runner start?" must fail loudly rather than silently skip
the check. The fakes failing was the design working.

| Gate | Result |
| --- | --- |
| focused suite | **28/28** |
| `pnpm test:automation` | **199/199** |
| `pnpm check` | **EXIT 0** (web 543/543, API 680/680) |
| Migrations | none |

## Still deliberately not done

- **`docs/STATUS.md` is not simplified.** That is the owner's step 3 and a
  separate PR: it is a removal that depends on this capability existing, and it
  redesigns `assessRunnerState`'s precedence chain rather than deleting a field.
- **A pending claim is not upgraded to its PR number automatically.** Adoption is
  permitted (`C2`) and the claim never strands the runner, but writing the number
  back when the PR opens is a lifecycle refinement, not a safety property.
