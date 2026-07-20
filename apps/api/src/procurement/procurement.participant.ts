import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Phase 3 Task 2 — the procurement WORKFLOW PARTICIPANT (plan §F disposition rule).
 *
 * Cancelling a requirement that has OPEN downstream requisition lines demands an explicit
 * disposition — the lines must be cancelled (or, in later tasks, re-pointed) first. The
 * requirements cancel command invokes this procurement-owned method INSIDE its transaction
 * (the Module-3/4 owner-aligned participant pattern), so the guard reads procurement's own
 * tables from procurement-owned code, and the readiness lock both commands hold serializes
 * the check against concurrent line creation.
 */
@Injectable()
export class ProcurementParticipant {
  async assertRequirementDisposable(tx: Prisma.TransactionClient, projectId: string, requirementId: string): Promise<void> {
    // Task 3: an 'ordered' line is bound even harder downstream (live PO lines) — it
    // demands disposition exactly like an open one; only 'cancelled' lines are settled.
    const open = await tx.requisitionLine.count({
      where: {
        projectId,
        requirementId,
        status: { in: ['open', 'ordered'] },
        requisition: { status: { notIn: ['rejected', 'closed'] } },
      },
    });
    if (open > 0) {
      throw new ConflictException(
        `Requirement has ${open} open requisition line(s) — cancel or re-point them before cancelling the requirement (explicit disposition, plan §F)`,
      );
    }
  }
}
