# PR #247 Review Convergence

## Objective
Make the Claude-to-Codex loop converge faster while preserving product CI,
exact-head review, and the fail-closed merge boundary.

## Finding History
Finding-bearing heads: `893266a`, `e7a96e7`, `c924968`, `f50eaca`, `9d0ebcb`,
and `efdb605`. Head `6a98a1b` had only duplicated synthetic-merge claims. The
second finding head activated the convergence packet and trailer requirement.

## Finding Map
| Head | Finding | Batched remedy and proof |
| --- | --- | --- |
| `893266a` | Blank invariant rows passed | Require risk and evidence cells; blank-row probe RED then GREEN |
| `893266a` | PR code could spoof scope success | Trusted owner re-evaluates PR metadata; spoofed-green probe RED then GREEN |
| `893266a` | Review-only findings were omitted | Count blocking review records and inline comments; review-only probe GREEN |
| `893266a` | Review comments were not paginated | Shared pagination; executable 101-record probe GREEN |
| `e7a96e7` | A stale packet satisfied convergence | Require packet in exact-head commit files; stale-packet probe RED then GREEN |
| `e7a96e7` | Instruction text satisfied the marker | Require the leading declaration; buried-marker probe RED then GREEN |
| `c924968` | A deleted packet counted as changed | Reject removed packets; deletion probe RED then GREEN |
| `c924968` | Narrative text counted as a trailer | Parse only the final Git trailer block; narrative probe RED then GREEN |
| `c924968` | Commit files could truncate | Paginate exact-head commit files; executable 101-file probe GREEN |
| `f50eaca` | Body edits could bypass scope | Revalidate the live body before clean success; mutation probe RED then GREEN |
| `f50eaca` | Late findings could bypass convergence | Reload history before clean success; late-finding probe RED then GREEN |
| `9d0ebcb` | Recovered clean status bypassed convergence | Revalidate before reuse; delayed-finding recovery probe RED then GREEN |
| `b62c641` | A transient GitHub 500 stopped dispatch | Retry GETs only, bounded to three attempts; injected-500 probe RED then GREEN |
| `efdb605` | Continued text passed as exact trailer value | Unfold trailer continuations before exact comparison; probe RED then GREEN |
| `efdb605` | Thrown read failures were not retried | Retry GET fetch/read/parse exceptions only; probe RED then GREEN |

## Invalid Reviewer Evidence
Trailer comments citing `965f8bb`, `f39451a`, `255da7d`, and `ecfe538` inspected
synthetic or nonexistent SHAs. Authoritative `refs/pull/247/head` commits carried
the required trailer. `AGENTS.md` now requires PR-head resolution; byte-identical
duplicate comments count once. No correct gate behavior was changed for them.

## Invariant Audit
No product authorization, civil-time, data, outbox, UI, API, schema, migration,
runtime dependency, deployment, or AI credential surface changed. Exact-head
serialization and all five product checks remain mandatory.

## Operational Risks
- Trusted default-branch evaluation remains authoritative over PR-side preflight.
- Add `review-scope` to branch protection only after grandfathered PR #246 ends.
- GitHub API behavior remains external; pagination and transient reads are tested.

## Verification
- Reproduce-first continuation and thrown-GET probes: RED then GREEN.
- `pnpm test:automation`: green.
- `pnpm check`: exit 0; API unit 680/680.
- `git diff --check`: clean; standard scope at no more than 1,500 changed lines.
