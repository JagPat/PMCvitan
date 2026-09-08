<!-- review-size: standard -->
<!-- migration-scope: separated -->
<!-- correction-owner: claude -->

<!-- The POLICY.md links below are absolute on purpose. GitHub copies this file into a PR
     DESCRIPTION, where a relative path resolves against /pull/<number> and lands on a
     repository page instead of the file — and this template no longer restates the scope,
     marker and ownership rules, so a broken link leaves an author with nothing. -->

## Objective

One user workflow or one architectural concern:

## Review unit

- Base SHA:
- Scope:
- Changed files / changed lines:
- Split considered:
- Migration/service seam: n/a

Replaces: none

Use [docs/POLICY.md](https://github.com/JagPat/PMCvitan/blob/main/docs/POLICY.md) for scope limits, migration seams,
owner declarations and review continuity. Change the leading markers when that
contract requires it and explain the concrete boundary in this review unit.
The checklist and matrix below record evidence against that shared contract.

For an exceptional voluntary replacement, also provide `Replacement reason:`
with the concrete scope or approach benefit; preserve findings and proof links.

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

## Review continuity

Keep unresolved work on this PR and fix forward under
[the canonical review-continuity policy](https://github.com/JagPat/PMCvitan/blob/main/docs/POLICY.md#review-continuity-and-scope).
Any exceptional replacement must explain its benefit and preserve findings and proofs.
