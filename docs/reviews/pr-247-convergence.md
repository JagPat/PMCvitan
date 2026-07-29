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
- `c9249688e5d4475e12b1af8155fdf71263d2d667`: three unique follow-up
  findings in the first convergence head, plus one merge-ref misread.
- `f50eaca4ecf49e902a2e7f192340bf603c4d7dd5`: two final-admission race
  findings after the convergence parser and pagination fixes.
- `9d0ebcb9a859c3de062e6b5dc25fcf9655d80c0c`: one recovered-status
  convergence race, plus a second merge-ref misread.

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
| `c924968` | Deleting a packet counted as changing it | Packet check ignored GitHub's file status | Reject `status: removed`; accept only an added, modified, or renamed matching packet | Removed-packet probe RED at reviewed head, GREEN after correction |
| `c924968` | Narrative marker counted as a trailer | Multiline regex matched any standalone line | Parse only the final Git trailer block and require valid token/value lines | Narrative-marker probe RED at reviewed head; final multi-trailer block GREEN |
| `c924968` | Commit file list could truncate | Exact-head commit read only the first file page | Paginate `GET /commits/{head}` at 100 files and aggregate every page | Executable 101-file commit probe RED at reviewed head, GREEN after correction |
| `f50eaca` | Same-head PR-body edit could bypass scope | Scope was evaluated only before CI and review polling | Re-fetch the live PR and re-run trusted scope immediately before clean success | Oversized live-body mutation RED at reviewed head, GREEN through final-admission helper |
| `f50eaca` | Late old-head finding could activate convergence after polling | Finding-head history was not re-read after Codex returned clean | Re-read paginated review evidence and re-run convergence immediately before clean success | Late second finding-head probe RED at reviewed head, GREEN with convergence required |
| `9d0ebcb` | Recovered clean status could bypass late convergence | Terminal-status reuse returned before the final policy recheck | Apply the same live scope and convergence admission before reusing clean status | Delayed second finding-head recovery RED at reviewed head, GREEN without merge |

## Reviewer Merge-Ref Misread

The round also claimed that the convergence head lacked the required trailer,
citing synthetic merge ref `965f8bb`. The authoritative PR head was `c924968`,
whose commit message ended with `Review-Convergence: complete`. The trusted gate
queries the PR head SHA, not GitHub's temporary merge ref. No code change was
needed for this claim; this correction commit repeats the trailer and changes
this packet so the next exact head remains independently compliant.

The next round repeated the claim using nonexistent SHA `f39451a`. GitHub's
authoritative `refs/pull/247/head` and REST PR head were `9d0ebcb`, whose final
trailer was valid. This was again a merge-checkout misread, not a gate defect.

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

- `pnpm test:automation`: 75/75 after this convergence correction.
- `pnpm check`: exit 0.
- API unit: 680/680.
- `git diff --check`: clean.
- No migration, schema, runtime dependency, product code, or AI credential added.
