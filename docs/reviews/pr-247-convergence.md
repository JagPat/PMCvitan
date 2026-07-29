# PR #247 Review Convergence

## Objective
Faster Claude-to-Codex convergence with product CI, exact-head review, and the fail-closed merge boundary intact.

## Finding Map
| Head | Finding | Batched remedy and proof |
| --- | --- | --- |
| `893266a` | Blank evidence; spoofable scope; omitted/paginated review evidence | Require populated rows; trusted recheck; paginate both evidence channels; four probes GREEN |
| `e7a96e7` | Stale packet; buried marker | Require exact-head packet and leading declaration; both probes RED then GREEN |
| `c924968` | Deleted packet; narrative trailer; truncated files | Status-aware packet, final trailer parser, paginated files; three probes GREEN |
| `f50eaca` | Body edit and late-finding races | Revalidate live scope and convergence before success; both probes RED then GREEN |
| `9d0ebcb` | Recovered clean status bypassed convergence | Revalidate before reuse; delayed-finding recovery probe RED then GREEN |
| `b62c641` | A transient GitHub 500 stopped dispatch | Retry GETs only, bounded to three attempts; injected-500 probe RED then GREEN |
| `efdb605` | Continued text passed as exact trailer value | Unfold trailer continuations before exact comparison; probe RED then GREEN |
| `efdb605` | Thrown read failures were not retried | Retry GET fetch/read/parse exceptions only; probe RED then GREEN |
| `74c9b2c` | Final policy missed a late current-head finding | Reclassify current-head evidence in final policy; deterministic interleaving RED then GREEN |

## Invalid Reviewer Evidence
Trailer comments citing `965f8bb`, `f39451a`, `255da7d`, and `ecfe538` inspected
synthetic or nonexistent SHAs. Authoritative `refs/pull/247/head` commits carried
the required trailer. `AGENTS.md` now requires PR-head resolution; byte-identical
duplicate comments count once. No correct gate behavior was changed for them.

## Invariant Audit
No product, schema, migration, dependency, deployment, or AI credential surface changed; exact-head serialization and all five product checks remain mandatory.

## Verification
- Reproduce-first continuation and thrown-GET probes: RED then GREEN.
- Final-admission interleaving probe: RED then GREEN; automation suite green.
- `pnpm check`: exit 0; API 680/680; diff clean; standard scope at no more than 1,500 changed lines.
