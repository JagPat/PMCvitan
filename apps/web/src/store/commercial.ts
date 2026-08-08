import type { CommercialMoneyPositionDto } from '@vitan/shared';

/**
 * Phase 5 Task 7B-i (§M) — the MONEY-POSITION bundle: what `loadCommercial()` fetches together
 * when the project carries the `commercial` capability.
 *
 * This is the commercial twin of `MaterialsView` and `LabourView`, and it is deliberately the
 * SMALLER half of §M. §M's seven tabs are two user workflows, not one:
 *
 *   - *where do we stand* — budget, committed obligation, the §J cash forecast. A PMC's question,
 *     answered by four reads over facts Tasks 1–2 and 7A already cleared. THIS bundle.
 *   - *process this vendor claim* — measurements, bills, certification, payments. A different
 *     actor with different authority, and 7B-ii's bundle.
 *
 * It is a greenfield module-query read: none of it has ever been in the legacy snapshot, so there
 * is no XOR read-ownership flag to carry and no cutover to stage. It is capability-gated on the
 * SERVER too (404 off-pilot), so a non-pilot project cannot serve it even if a client asked.
 *
 * A bare ALIAS of the server DTO rather than a restatement of its fields (Codex round 2 made the
 * read a single endpoint). Re-declaring the shape here would create a second place for it to drift,
 * which is the defect the one-serializer discipline exists to prevent one layer down.
 */
export type CommercialView = CommercialMoneyPositionDto;
