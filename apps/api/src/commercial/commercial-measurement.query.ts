import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

/**
 * Phase 5 Task 3 (§0 `MEASURED`) — the measurement FOLD, as an own-module read.
 *
 * Separate from `CommercialMeasurementService` on purpose: the service owns the WRITE path and
 * injects the activities participant and the labour query, while the `COMMITTED` fold needs only
 * this one number. Injecting the whole service into `CommercialBudgetQuery` would make the fold
 * depend on the participant graph it has no business knowing about, and would put a DI cycle one
 * refactor away.
 *
 * `MEASURED(poLine)` is a FOLD over signed rows with NO stored balance — the Phase-3 §C rule. A
 * correction is a negative row, so summing the column is the whole computation and there is no
 * cached total that can drift from it.
 */
@Injectable()
export class CommercialMeasurementQuery {
  /** `MEASURED(poLine)` for a set of labour PO lines. An unmeasured line folds to ZERO, present
   *  in the map — a caller reading `?? undefined` and skipping the term is the failure this
   *  avoids, the same reason `effortForPoLines` fills its absent lines. */
  async measuredForPoLines(
    tx: Prisma.TransactionClient,
    projectId: string,
    labourPoLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    if (labourPoLineIds.length === 0) return out;
    const rows = await tx.measurement.findMany({
      where: { projectId, labourPoLineId: { in: [...labourPoLineIds] } },
      select: { labourPoLineId: true, quantity: true },
    });
    for (const id of labourPoLineIds) out.set(id, ZERO);
    for (const r of rows) {
      out.set(r.labourPoLineId, (out.get(r.labourPoLineId) ?? ZERO).add(r.quantity));
    }
    return out;
  }
}
