# PMCvitan Agent Entry Point

Before architecture or implementation work, read:

1. `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
2. The ACTIVE plan: `docs/superpowers/plans/2026-07-15-phase-2-platform-modularization.md` — the **proposed Phase 2 plan (pending its own independent review; implementation begins only after that review clears)**. Prior phases are complete and historical: Phase 0 (`2026-07-12-phase-0-trust-foundation.md`) cleared at `main` `5d6f08b`; Phase 1 (`2026-07-13-phase-1-existing-pillars.md`) cleared at `main` `cff18c4` with the round-14 **GREEN SIGNAL** (effective runtime head `302b24a`; evidence in `docs/reviews/phase-1-review-packet.md`).
3. `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/TENANCY.md`, `docs/TEMPLATES.md`, and `docs/ROADMAP.md`

Git is the project memory. Revalidate findings against current `main`; do not rely on chat history. One project represents one site. Project operational records never become global. One fact has one canonical owner. Preserve attributable human approvals. Use additive migrations and prove tenant isolation against PostgreSQL.

Before every PR, include the vision-alignment statement and review packet required by the active plan. A task is not complete until its focused tests and `pnpm check` pass.
