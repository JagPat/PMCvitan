# PR #247 Review Convergence

## Objective

Make the Claude-to-Codex loop converge faster while preserving every existing
product gate, exact-head review, and fail-closed merge boundary.

## Why Convergence Was Required

Codex found defects on two distinct heads:

- `893266ad2f00ac20a116d05b93bd59534dd4a7dd`: four findings in the initial
  scope and convergence policy.
- `e7a96e718abc405b017a90d5ea5f8552b1e4ca2d`: two findings in the first
  correction.

The second finding-bearing head activates the repository's convergence rule.
This packet and its commit contain the complete architectural correction rather
than another isolated patch.

## Finding Map

| Head | Finding | Architectural cause | Batched remedy | Reproduce-first proof |
| --- | --- | --- | --- | --- |
| `893266a` | Blank invariant rows passed | Scope policy looked only for invariant labels | Parse the six table rows and require non-empty risk and evidence cells | Blank-row large PR RED at base, GREEN after correction |
| `893266a` | PR code could spoof scope success | Trusted owner waited for an author-controlled check name | Trusted default-branch gate independently evaluates PR metadata and fails draft/status before review | Spoofed-green client RED at base, GREEN after correction |
| `893266a` | Review-only findings were omitted | Convergence history counted only inline comments | Count Codex review records and inline comments using the same blocking semantics | Two review records without comments RED at base, GREEN after correction |
| `893266a` | Review comments were not paginated | REST helper read only page one | Shared pagination for reviews and comments | Executable 101-record probe RED by source contract, GREEN across both endpoints |
| `e7a96e7` | A stale cumulative packet satisfied convergence | Gate inspected the cumulative PR file list | Require the convergence packet in `commit.files` for the exact head carrying the trailer | Stale cumulative packet with trailer RED at reviewed head, GREEN only when current commit changes packet |
| `e7a96e7` | Instruction text satisfied the large marker | Policy used an unanchored substring search | Require the first non-whitespace declaration to be `justified-large` | Standard leading declaration plus instructional marker RED at reviewed head, GREEN after correction |

## Invariant Audit

| Invariant | Result | Evidence |
| --- | --- | --- |
| authorization-tenancy | No product surface changed | Automation-only diff; full API check green |
| civil-time-lifecycle | No product surface changed | Automation-only diff; full API check green |
| concurrency-idempotency | Exact-head owner remains serialized | Existing recovery/owner tests plus trusted-scope tests green |
| data-integrity-conservation | No schema, migration, ledger, or projection change | Diff and migration scan clean |
| offline-reconciliation | No outbox or client reconciliation change | Full web/API check green |
| ui-server-parity | No UI or API contract change | Web/API typecheck, tests, and builds green |

## Regression Surface

- Pull requests through #246 retain their original five required checks.
- Pull requests from #247 onward receive the scope preflight and trusted scope
  re-evaluation.
- Existing exact-head recovery, review classification, and auto-merge behavior
  remains covered by the unchanged automation suite plus the new probes.
- Product CI remains mandatory after a valid scope decision.

## Remaining Risks

- The PR-side preflight is fast feedback and author-controlled; the trusted
  default-branch re-evaluation is therefore the authoritative boundary.
- Branch protection adds `review-scope` only after PR #246 terminates. Until
  then, `codex-current-head` still fails closed for every new PR.
- GitHub API shape changes remain an external dependency; pagination and exact
  commit-file behavior are pinned by executable fixtures.

## Verification

- `pnpm test:automation`: 72/72 after this convergence correction.
- `pnpm check`: exit 0.
- API unit: 680/680.
- `git diff --check`: clean.
- No migration, schema, runtime dependency, product code, or AI credential added.
