<!-- review-size: standard -->

## Objective

One user workflow or one architectural concern:

## Review unit

- Base SHA:
- Scope:
- Changed files / changed lines:
- Split considered:

For a PR above 20 files or 1,500 changed lines, replace the first marker with
`<!-- review-size: justified-large -->` and explain why splitting would make the
change less safe or less reviewable.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | | |
| civil-time-lifecycle | | |
| concurrency-idempotency | | |
| data-integrity-conservation | | |
| offline-reconciliation | | |
| ui-server-parity | | |

## Verification

- [ ] Focused reproduce-first probes were RED at the stated base and GREEN here.
- [ ] `pnpm check` passed by exit code.
- [ ] Required PostgreSQL, upgrade, and browser gates passed where applicable.
- [ ] No deployed migration bytes changed.
- [ ] Review packet and `docs/STATUS.md` state are truthful.

## Convergence evidence

Leave this section empty for the initial head and first correction. After two
distinct Codex finding heads, the next correction must include a changed
`docs/reviews/*convergence*.md` packet and its head commit must carry:

`Review-Convergence: complete`
