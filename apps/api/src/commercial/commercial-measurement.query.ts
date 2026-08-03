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

  /**
   * The NET contribution one ORIGINAL measurement row still makes to the fold: its own quantity
   * plus every correction addressed to it. A row corrected back to zero has nothing left to
   * withdraw, and nothing left for a certificate to consume.
   *
   * Owned HERE rather than on the write service because §E's row-level freeze needs the same
   * quantity §D's correction floor does, and two implementations of "what this row still
   * contributes" would disagree the first time either changed — the drift §0 exists to name.
   * `correct` keeps the tree exactly ONE level deep, which is what makes the direct-children sum
   * the whole subtree.
   */
  async netOf(
    tx: Prisma.TransactionClient, projectId: string, measurementId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.measurement.findMany({
      where: { projectId, OR: [{ id: measurementId }, { correctsId: measurementId }] },
      select: { quantity: true },
    });
    return rows.reduce((acc, r) => acc.add(r.quantity), ZERO);
  }

  /**
   * Phase 5 Task 5B (§E step 4) — LOCK the measurements behind one labour purchase-order line
   * and return each ORIGINAL row with what it still contributes, ascending by id.
   *
   * Certification consumes measurement ROWS by identity, so it must serialize against the
   * correction path that would reduce them — `commercial.measurement.correct` appends a signed
   * delta, and a certification that read the rows without locking them would freeze a consumed
   * quantity a concurrent correction had already walked back.
   *
   * **The unit is the ORIGINAL row's NET, never its raw quantity.** §D models a correction as its
   * own negative row addressed to the original, so a 100 measured and corrected −30 is a row
   * standing at 70; returning the raw 100 would let a certificate freeze evidence 30 units of
   * which had already been withdrawn. The correction rows themselves are not consumable — they
   * are not evidence, they are the amendment OF evidence — so the set returned is the originals
   * with positive residue. `FOR UPDATE` covers both, because a correction is what the lock is
   * against.
   */
  async lockMeasurementsFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    labourPoLineId: string,
  ): Promise<Array<{ id: string; activityId: string; quantity: Prisma.Decimal }>> {
    const locked = await tx.$queryRaw<Array<{
      id: string; activityId: string; quantity: Prisma.Decimal | string; correctsId: string | null;
    }>>(Prisma.sql`
      SELECT m."id" AS "id", m."activityId" AS "activityId",
             m."quantity" AS "quantity", m."correctsId" AS "correctsId"
        FROM "Measurement" m
       WHERE m."projectId" = ${projectId} AND m."labourPoLineId" = ${labourPoLineId}
       ORDER BY m."id" ASC
         FOR UPDATE`);
    const net = new Map<string, Prisma.Decimal>();
    for (const r of locked) {
      const key = r.correctsId ?? r.id;
      net.set(key, (net.get(key) ?? ZERO).add(new Prisma.Decimal(r.quantity)));
    }
    return locked
      .filter((r) => r.correctsId === null)
      .map((r) => ({ id: r.id, activityId: r.activityId, quantity: net.get(r.id) ?? ZERO }))
      .filter((r) => r.quantity.greaterThan(0));
  }
}
