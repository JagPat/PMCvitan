<!-- review-size: standard -->
<!-- migration-scope: separated -->
<!-- correction-owner: claude -->

## Objective

One user workflow or one architectural concern:

## Review unit

- Base SHA:
- Scope:
- Changed files / changed lines:
- Split considered:
- Migration/service seam: n/a

Replaces: none

For a PR above 20 files or 1,500 changed lines, replace the first marker with
`<!-- review-size: justified-large -->` and explain why splitting would make the
change less safe or less reviewable.

Keep migration review units separate from service/UI changes when there is a
viable seam. Only replace the second marker with
`<!-- migration-scope: inseparable -->` when they cannot be reviewed safely
apart, and explain that boundary in `Migration/service seam`.

Declare which agent will fix this PR's review findings. Replace the third marker
with `<!-- correction-owner: cursor -->` when a Cursor agent owns the
corrections; keep `<!-- correction-owner: claude -->` when Claude Code web
Auto-fix does. The declaration is required, is validated by `review-scope`
before any expensive job runs, and decides every correction notice the
controller publishes — an undeclared, unknown, or self-contradicting owner is
refused, and a `claude/**` branch may only declare `claude`. GitHub cannot start
a Cursor session, so a Cursor-owned finding is routed to Cursor by name with the
notice saying so — a human resumes it. Only an undeclared or malformed marker is
reported as `correction_stalled`. Declaring the wrong owner sends the correction
to the wrong agent.

## Pre-review checklist

- [ ] `concurrency-serialization` — locks precede guarded reads; race probes use barriers and assert the terminal invariant.
- [ ] `old-release-migration-compatibility` — the migration is additive and safe while the old release is still serving.
- [ ] `trigger-alternate-writers` — triggers, jobs, imports, and every alternate writer preserve the same invariant.
- [ ] `authorization-tenancy` — each new read and write enforces the correct actor and tenant boundary.
- [ ] `ci-reproduce-first` — the failure is RED at the base, GREEN here, and the required CI battery is selected.

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

## Review-round reset

After the second finding-bearing Codex head, do not push another correction to
this PR. Close it and open a newly scoped replacement from current `main`,
carrying only the unresolved unit and changing `Replaces: none` to this PR's
number. The replacement receives a fresh comprehensive review; no safety check
is waived.
