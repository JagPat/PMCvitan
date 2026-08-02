import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY } from '@vitan/shared';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';

/** The acting identity a lifecycle site passes in; the participant never re-derives it. */
export interface AttributionActor {
  readonly actorId: string;
  readonly role: string;
}

/** ONE attribution target. The XOR is a PG CHECK; this type makes it unrepresentable in TS too. */
export type AttributionTarget = { poLineId: string } | { labourPoLineId: string };

/**
 * Phase 5 Task 1 — the COMMERCIAL workflow participant (plan §C/§K).
 *
 * §C: "a live PO line can never be unattributed", and that has to hold from the FIRST INSTANT
 * the line is live. A PO version becomes live at `pos.issue` (and at labour PO issue), so if
 * the first attribution were a separate commercial command, every newly issued order would be a
 * live unattributed obligation until someone ran it — `COMMITTED(costHead)` reading ₹0 for a
 * real ₹100 order, the budget exception never firing and the cash forecast short by the whole
 * amount. So the initial attribution is written HERE, inside the issuing transaction, and all
 * four lifecycle sites (issue · amend · cancel · close-short) — material AND labour, eight sites
 * in total — go through this one channel. §0b's closure row is the acceptance criterion.
 *
 * Procurement and Labour therefore declare `commercial` in their `workflowParticipants`. Neither
 * is a `dependsOn` edge: nobody READS commercial, which is what makes it a SINK, and participant
 * channels are cycle-exempt (the cleared `activities → labour`, `media → inventory` precedent).
 *
 * AUTHORITY FOLLOWS THE WRITE, NOT THE ROUTE (§C, probe 5ar). This participant enforces
 * `commercial.attribute` on the ACTING actor exactly as the standalone re-attribution route
 * does — otherwise a user holding PO-issue authority but not `commercial.attribute` chooses the
 * cost head during `pos.issue` and mutates budget evidence through a side door.
 */
@Injectable()
export class CommercialParticipant {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** Off-pilot this whole surface does not exist: the caller's transaction is untouched (§D). */
  async isActive(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
    return this.capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY, tx);
  }

  /** §C/§I — the WRITE carries the authority, whichever route reached it. */
  private assertAttributeAuthority(actor: AttributionActor): void {
    if (!(ROLE_POLICY['commercial.attribute'] as readonly string[]).includes(actor.role)) {
      throw new ForbiddenException(
        'Attributing a vendor commitment to a cost head requires `commercial.attribute` — issuing a purchase order does not confer it',
      );
    }
  }

  private where(projectId: string, target: AttributionTarget): Prisma.CommitmentAttributionWhereInput {
    return 'poLineId' in target
      ? { projectId, poLineId: target.poLineId, supersededAt: null }
      : { projectId, labourPoLineId: target.labourPoLineId, supersededAt: null };
  }

  private async activeFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    target: AttributionTarget,
  ): Promise<{ id: string; costHeadCode: string } | null> {
    return tx.commitmentAttribution.findFirst({
      where: this.where(projectId, target),
      select: { id: true, costHeadCode: true },
    });
  }

  private async assertCostHead(tx: Prisma.TransactionClient, projectId: string, code: string): Promise<void> {
    const head = await tx.costHead.findUnique({ where: { projectId_code: { projectId, code } }, select: { code: true } });
    if (!head) {
      throw new ConflictException(
        `Cost head "${code}" is not defined in this project — define it before attributing a commitment to it`,
      );
    }
  }

  /**
   * ISSUE — write the initial active attribution for each line of a version that is becoming
   * live, in the issuing transaction. Idempotent under command replay: a line that already
   * carries an ACTIVE attribution to the SAME head is left alone (the partial unique would
   * otherwise turn a replay into a 500), while a different head is a caller error, not a silent
   * re-attribution — reclassification is `reattribute`, which leaves evidence.
   */
  async attribute(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    rows: ReadonlyArray<{ target: AttributionTarget; costHeadCode: string; reason: string }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    this.assertAttributeAuthority(actor);
    for (const row of rows) {
      await this.assertCostHead(tx, projectId, row.costHeadCode);
      const active = await this.activeFor(tx, projectId, row.target);
      if (active) {
        if (active.costHeadCode === row.costHeadCode) continue;
        throw new ConflictException(
          `This commitment is already attributed to "${active.costHeadCode}" — re-attribute it explicitly so the reclassification leaves evidence`,
        );
      }
      await tx.commitmentAttribution.create({
        data: {
          projectId,
          ...('poLineId' in row.target ? { poLineId: row.target.poLineId } : { labourPoLineId: row.target.labourPoLineId }),
          costHeadCode: row.costHeadCode,
          reason: row.reason,
          createdById: actor.actorId,
        },
      });
    }
  }

  /**
   * AMEND / CLOSE-SHORT — an ATOMIC REPLACEMENT: supersede each `from` line's active attribution
   * and insert the replacement for its `to` line, in ONE transaction. §C: a bare revocation would
   * drop a live vendor obligation out of every budget and forecast, so there is no "release and
   * attribute later" path.
   *
   * An amendment retains v1's line and issues v2's, so BOTH attributions would otherwise stay
   * active and the committed total would read ₹200 for a ₹100 order. Passing v1's line as `from`
   * and v2's as `to` is what keeps exactly one live. A close-short passes the SAME line on both
   * sides: the obligation changed size, and superseding-then-reinserting records that
   * attributably instead of leaving a stamp-free row behind a changed amount.
   *
   * A `from` line with no active attribution is NOT an error — the capability may have been
   * enabled after that version was issued, or the line may already have been released. The
   * replacement is still written, because the invariant is about the LIVE line.
   */
  async replaceAttribution(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    rows: ReadonlyArray<{ from: AttributionTarget; to: AttributionTarget; costHeadCode?: string; reason: string }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    this.assertAttributeAuthority(actor);
    for (const row of rows) {
      const active = await this.activeFor(tx, projectId, row.from);
      const code = row.costHeadCode ?? active?.costHeadCode;
      if (!code) {
        throw new ConflictException(
          'This commitment carries no attribution to carry forward — supply the cost head that will hold the amended obligation',
        );
      }
      await this.assertCostHead(tx, projectId, code);
      if (active) await this.supersede(tx, projectId, actor, active.id, row.reason);
      await tx.commitmentAttribution.create({
        data: {
          projectId,
          ...('poLineId' in row.to ? { poLineId: row.to.poLineId } : { labourPoLineId: row.to.labourPoLineId }),
          costHeadCode: code,
          reason: row.reason,
          createdById: actor.actorId,
        },
      });
    }
  }

  /**
   * CANCEL — supersede without replacement. This is the ONE site where that is correct, and it
   * is not the "revocable to nothing" §C forbids: a cancelled version is no longer live, so the
   * obligation it carried no longer exists. Leaving the attribution active would make `COMMITTED`
   * report a commitment against an order nobody owes.
   */
  async releaseAttribution(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    targets: ReadonlyArray<AttributionTarget>,
    reason: string,
  ): Promise<void> {
    if (targets.length === 0) return;
    this.assertAttributeAuthority(actor);
    for (const target of targets) {
      const active = await this.activeFor(tx, projectId, target);
      if (active) await this.supersede(tx, projectId, actor, active.id, reason);
    }
  }

  /**
   * The ONE permitted UPDATE, guarded as a CAS on `supersededAt IS NULL`. The database refuses a
   * second stamp too (the append-only trigger), but a 409 is the honest answer to a concurrent
   * lifecycle command racing this one — a raw trigger error is a 500.
   */
  private async supersede(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    id: string,
    reason: string,
  ): Promise<void> {
    const { count } = await tx.commitmentAttribution.updateMany({
      where: { id, projectId, supersededAt: null },
      data: { supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: reason },
    });
    if (count === 0) {
      throw new ConflictException('This attribution was superseded concurrently — reload and retry');
    }
  }
}
