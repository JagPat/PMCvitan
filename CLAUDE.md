# PMCvitan Agent Entry Point

Before architecture or implementation work, read:

1. `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
2. The ACTIVE plan: `docs/superpowers/plans/2026-07-13-phase-1-existing-pillars.md` (Phase 0 — `2026-07-12-phase-0-trust-foundation.md` — is complete and historical; its gate cleared at `main` commit `5d6f08b`)
3. `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/TENANCY.md`, `docs/TEMPLATES.md`, and `docs/ROADMAP.md`

Git is the project memory. Revalidate findings against current `main`; do not rely on chat history. One project represents one site. Project operational records never become global. One fact has one canonical owner. Preserve attributable human approvals. Use additive migrations and prove tenant isolation against PostgreSQL.

Before every PR, include the vision-alignment statement and review packet required by the active plan. A task is not complete until its focused tests and `pnpm check` pass.
