import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY, type CertificateDto, type VendorBillStatus } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { InventoryParticipant, type AcceptedEvidenceRow } from '../inventory/inventory.participant';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import { CommercialVerificationService } from './commercial-verification.service';
import type { CertifyBillInput, SupersedeCertificateInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

/** One measurement row a certificate is about to freeze, with how much of it it draws. */
interface MeasurementDraw {
  measurementId: string;
  consumedQty: Prisma.Decimal;
}

/** One acceptance row a certificate is about to freeze. */
interface AcceptanceDraw {
  stockTransactionId: string;
  consumedQty: Prisma.Decimal;
}

/**
 * Phase 5 Task 5B (§E/§F/§G/§I) — CERTIFICATION.
 *
 * **Certification is the first act in this phase that creates money anyone may approve.**
 * Everything before it is a claim; a certificate is an authority. That is why it freezes not just
 * an amount but WHICH EVIDENCE it consumed and HOW MUCH OF EACH — without that pair, the evidence
 * under a payable certificate can be swapped after the fact and nothing notices.
 *
 * The §E triple is NOT recomputed here in a second implementation. §E names three sites that
 * recompute it — "submission, verification and certification" — and this is the third, so it calls
 * `CommercialVerificationService.computeTriple`. A local copy would be the drift §0 exists to
 * name, and it would disagree the first time either changed.
 */
@Injectable()
export class CommercialCertificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly inventoryParticipant: InventoryParticipant,
    private readonly activities: ActivityParticipant,
    private readonly bills: CommercialBillQuery,
    private readonly measured: CommercialMeasurementQuery,
    private readonly verification: CommercialVerificationService,
    // §I's approver standing is an ORGS question — `Membership`/`OrgMembership` are orgs-owned and
    // the owner states the rule. `commercial.workflowParticipants` already declares this edge.
    private readonly orgs: OrgsParticipant,
  ) {}

  private assertCertify(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.certify'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Certifying a vendor claim is a pmc surface — it creates money someone may approve');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  // ── §E/§F — certify ──────────────────────────────────────────────────────────────────────────

  /**
   * §F — CERTIFY a verified claim. `verified → certified`, with the certificate as the fact and
   * the status as its projection (the DB refuses the status without a live certificate behind it).
   *
   * §E's lock order, in full, and every side re-read INSIDE it:
   *
   *   1. `lockProjectReadiness(projectId)`
   *   2. every contributing stock LOT, ascending by id, through `InventoryParticipant`
   *   3. EVERY PO line the bill touches — material and labour together — in ONE ascending order,
   *      taken BEFORE any per-line work (inside `computeTriple`)
   *   4. for labour, the contributing measurements
   *   5. for labour, the activity each measurement rests on
   *
   * Step 2 before step 3 is not a free choice: every inventory write already runs
   * `lockProjectReadiness → lockLot → applyReceiptProgress`, and `applyReceiptProgress` is what
   * takes the PO line. Inverting it would let certification hold a PO line waiting for a lot while
   * a concurrent rejection holds that lot waiting for the PO line.
   *
   * Step 5 is NOT covered by step 4: a measurement can be old and entirely valid while the
   * sign-off underneath it is withdrawn concurrently — certification starts from that measurement,
   * a closing inspection reverts the activity to `in_progress`, and certification commits never
   * having serialized on the status it depends on.
   */
  async certify(
    projectId: string, input: CertifyBillInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<CertificateDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertCertify(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.bill.certify', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        // 1
        await lockProjectReadiness(tx, projectId);

        // Which PO lines this claim touches, read WITHOUT any lock. It is only a plan for what to
        // lock; every fact it produces is re-read under the locks below, and the set itself is
        // re-derived and compared once the bill is held.
        const planned = await this.verification.claimLines(tx, projectId, input.billId);

        // 2 — ALL the contributing EVIDENCE, locked BEFORE the bill.
        //
        // Codex round-1 P1 and round-3 P1, which are the same finding about two different evidence
        // families. §0b says "the BILL is taken FIRST, before any foreign row", and that rule is
        // right for every OTHER commercial write — but it collides with orders that inventory and
        // §D established first and cannot be asked to change:
        //
        //   * `stock.reverse` locks the LOT, then disputes the bill through `CommercialParticipant`;
        //   * `commercial.measurement.correct` locks the ACTIVITY and inserts the correction (taking
        //     an FK row lock on the original `Measurement`), then disputes the bill the same way.
        //
        // A bill-first certifier deadlocks against BOTH: it holds bill B and waits for the lot or
        // the measurement, while the withdrawing transaction holds that row and waits to dispute B.
        //
        // Round 1 fixed the material half and left the labour half exactly as it was — the same
        // defect, one evidence family along. So the rule is now stated over EVIDENCE rather than
        // over lots: every contributing row of every family is taken before the bill, in the order
        // its own owner established. A total lock order is a property of the SYSTEM, not of one
        // module, and the module that arrives later adopts it for ALL of the orders it meets.
        const evidenceByLine = new Map<string, AcceptedEvidenceRow[]>();
        for (const poLineId of [...new Set(planned.lines.filter((l) => l.kind === 'material').map((l) => l.poLineId))].sort()) {
          evidenceByLine.set(poLineId, await this.inventoryParticipant.lockAcceptedEvidence(tx, projectId, poLineId));
        }
        // the labour half: the ACTIVITY each measurement rests on, THEN the measurements.
        //
        // Codex round-4 P1 — that order is not interchangeable, and round 3 had it backwards.
        // `CommercialMeasurementService.append` takes the activity lock through `measurableTarget`
        // and only then inserts the correction row, whose FK takes a key-share lock on the original
        // `Measurement`. A certifier holding M and waiting for A deadlocks against a correction
        // holding A and waiting for M. `revertSignOff` takes the activity first as well, so
        // activity-before-measurement is the order every writer of this pair already uses.
        //
        // The activity set therefore has to be known BEFORE anything here is locked, which is what
        // `activityIdsFor` is for — a plan, re-read under the locks it leads to.
        const labourLines = [...new Set(planned.lines.filter((l) => l.kind === 'labour').map((l) => l.poLineId))].sort();
        const plannedActivities = new Set<string>();
        for (const poLineId of labourLines) {
          for (const id of await this.measured.activityIdsFor(tx, projectId, poLineId)) plannedActivities.add(id);
        }
        for (const activityId of [...plannedActivities].sort()) {
          const target = await this.activities.measurableTarget(tx, { projectId, activityId });
          if (!target || target.status !== 'done') {
            throw new ConflictException(
              `Activity ${activityId} is ${target?.status ?? 'missing'} — a certificate cannot rest on work whose sign-off no longer stands`,
            );
          }
        }
        const measuredByLine = new Map<string, Array<{ id: string; activityId: string; quantity: Prisma.Decimal }>>();
        for (const poLineId of labourLines) {
          const rows = await this.measured.lockMeasurementsFor(tx, projectId, poLineId);
          measuredByLine.set(poLineId, rows);
          // a measurement whose activity was NOT in the unlocked plan appeared between the two
          // steps, so its sign-off was never checked under a lock. Refuse rather than lock late —
          // locking late is how the deadlock returns, exactly as on the material side.
          for (const r of rows) {
            if (!plannedActivities.has(r.activityId)) {
              throw new ConflictException('New measured work landed on this claim while certification was preparing — reload and retry');
            }
          }
        }

        // 3 — the BILL, and every side re-read under it
        const bill = await this.lockBill(tx, projectId, input.billId);
        if (bill.status !== 'verified') {
          throw new ConflictException(
            `A ${bill.status} claim cannot be certified — certification applies to a VERIFIED claim, because the §E verdict is what makes it safe`,
          );
        }
        const { versionId, lines } = await this.verification.claimLines(tx, projectId, input.billId);

        // The lots were chosen from an UNLOCKED read, so an amendment committing in between could
        // have moved the claim onto a purchase-order line whose evidence this transaction never
        // locked — and certifying it would rest on rows a concurrent reversal is free to withdraw.
        // Refuse rather than lock the difference now: locking late is how the deadlock above comes
        // back, and a caller that reloads gets a coherent plan on the next attempt.
        const plannedTargets = [...new Set(planned.lines.map((l) => `${l.kind} ${l.poLineId}`))].sort().join(',');
        const actualTargets = [...new Set(lines.map((l) => `${l.kind} ${l.poLineId}`))].sort().join(',');
        if (plannedTargets !== actualTargets) {
          throw new ConflictException('This claim was amended onto different orders while certification was preparing — reload and retry');
        }

        // 4 and the re-read of every side happen inside `computeTriple`, which takes the PO lines
        // in ONE ascending order over the whole bill
        const verdict = await this.verification.computeTriple(
          tx, projectId, input.billId, bill.vendorId, bill.status as VendorBillStatus,
        );
        if (verdict.verdict !== 'matched') {
          throw new ConflictException(
            `This claim no longer verifies — ${verdict.exceptions.join(', ')}. The evidence moved after verification, so certifying it would authorise money the evidence no longer supports.`,
          );
        }

        // 5 and 6 — the labour DRAW, decided over rows already locked in step 2
        const measurementDraws = await this.drawMeasurements(tx, projectId, lines, measuredByLine);

        // The MATERIAL draw, decided ONCE. Codex round-1 P2: §I must ask about the rows this
        // certificate actually rests on, and the previous spelling asked about every positive
        // accepted row on the line — so a store user whose acceptance was already fully consumed
        // by an earlier live certificate was refused for evidence this act does not touch. The
        // plan is computed here, the SoD check reads it, and the freeze WRITES it: one decision,
        // three readers, rather than the freeze silently disagreeing with the check that preceded it.
        const acceptanceDraws = await this.drawAcceptances(tx, projectId, lines, evidenceByLine);

        // §G bound 3 — `CERTIFIED(bill) <= BILLED_AMOUNT(bill)`. The certified amount IS that
        // fold, taken from the ONE owned place, so this command satisfies the bound BY
        // CONSTRUCTION and there is no service-side comparison to make: a check of a value
        // against itself is a branch that can never fire, which reads as a guard and is not one.
        //
        // The bound is still ENFORCED, by `phase5_t5_certified_bound_check` at COMMIT — against
        // this row and against any later amendment of the claim, which is the case the service
        // cannot see because it happens in another transaction. That is the shape every §G bound
        // in this phase has: the service refuses what it can see with a sentence, PostgreSQL
        // refuses everything, including whatever route bypassed the service.
        const certifiedAmount = await this.bills.billedAmountOfBill(tx, projectId, input.billId);

        const certificate = await tx.billCertificate.create({
          data: {
            projectId, billId: input.billId, versionId,
            certifiedAmount,
            certifiedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        for (const a of acceptanceDraws) {
          await tx.certifiedAcceptanceConsumption.create({
            data: {
              projectId, certificateId: certificate.id,
              stockTransactionId: a.stockTransactionId, consumedQty: a.consumedQty,
            },
          });
        }
        for (const m of measurementDraws) {
          await tx.certifiedMeasurementConsumption.create({
            data: {
              projectId, certificateId: certificate.id,
              measurementId: m.measurementId, consumedQty: m.consumedQty,
            },
          });
        }

        // §I — asked AFTER the freeze, and that ordering is the point rather than an accident.
        // The question "did the certifier record any of this evidence?" is a question about the
        // FROZEN ROWS, so asking it once they exist lets both layers ask it of the same rows
        // through the same function. A refusal costs nothing: it throws inside the transaction,
        // so the certificate and its freeze are never committed.
        await this.assertSegregation(tx, projectId, actor.actorId, certificate.id);

        await this.cas(tx, projectId, input.billId, 'verified', 'certified');
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.bill.certify', entity: 'BillCertificate', entityId: certificate.id,
        });
        return { resultRef: certificate.id, events: [] };
      },
    });

    // A REPLAY returns the certificate THAT CALL created, found by the original command's result
    // — never a re-read of "the live certificate for this bill". The difference is the whole point
    // of `resultRef`: certify, lose the response, supersede, certify again, then retry the first
    // key, and a bill-scoped lookup would hand back the SECOND certificate as though it were the
    // answer to a call that produced the first. §E's own root: a replay owes the caller what THAT
    // call concluded.
    return this.certificateById(projectId, outcome.resultRef!);
  }

  /**
   * §E steps 4/5 — the labour side: lock the measurements, lock the ACTIVITY each rests on, and
   * decide which rows this certificate draws on and how much of each.
   *
   * The draw is greedy over the locked rows in ascending id order, which is deterministic rather
   * than arbitrary: two certifications of the same line must not disagree about which row they
   * consumed, and the row-level freeze is only meaningful if the choice is reproducible.
   */
  private async drawMeasurements(
    tx: Prisma.TransactionClient,
    projectId: string,
    lines: ReadonlyArray<{ kind: 'material' | 'labour'; poLineId: string; claimedQty: Prisma.Decimal }>,
    measuredByLine: ReadonlyMap<string, Array<{ id: string; activityId: string; quantity: Prisma.Decimal }>>,
  ): Promise<MeasurementDraw[]> {
    const draws: MeasurementDraw[] = [];
    for (const poLineId of [...new Set(lines.filter((l) => l.kind === 'labour').map((l) => l.poLineId))].sort()) {
      // Codex round-3 P1 — the rows were LOCKED in step 2, before the bill, together with the
      // activity each rests on. This method now only DECIDES; moving the lock earlier is what makes
      // the order total against the measurement-correction path.
      const rows = measuredByLine.get(poLineId) ?? [];

      let remaining = lines
        .filter((l) => l.kind === 'labour' && l.poLineId === poLineId)
        .reduce((a, l) => a.add(l.claimedQty), ZERO);
      for (const row of rows) {
        if (remaining.lessThanOrEqualTo(0)) break;
        // what THIS certificate may draw is the row's net LESS whatever a live certificate already
        // rests on — the same `(rowId, consumedQty)` pair the freeze writes, read back
        const already = await this.consumedMeasurementQty(tx, projectId, row.id);
        const free = row.quantity.sub(already);
        if (free.lessThanOrEqualTo(0)) continue;
        const take = Prisma.Decimal.min(remaining, free);
        draws.push({ measurementId: row.id, consumedQty: take });
        remaining = remaining.sub(take);
      }
      if (remaining.greaterThan(0)) {
        throw new ConflictException(
          `Labour line ${poLineId} claims ${remaining.toString()} more person-shifts than the unconsumed measured evidence covers — another live certificate already rests on the rest`,
        );
      }
    }
    return draws;
  }

  /**
   * §E — DECIDE which acceptance rows this certificate consumes and how much of each.
   *
   * Row identity alone is too coarse and the aggregate is too weak: one 100-unit acceptance with
   * an 80-unit certificate needs the pair, so the unused 20 stays reversible while the consumed 80
   * does not. Aggregate-only would let the evidence be SWAPPED after the fact — certify 100
   * against acceptance A recorded by store user X, accept another 100 by user Y, reverse A, and
   * the aggregate is still 100 while the payable certificate rests on different rows, by a
   * different actor, than the §E triple and the §I SoD rule ever evaluated.
   *
   * Codex round-1 P2 — this DECIDES and does not WRITE. The draw is the answer to "which rows does
   * this certificate rest on", and §I asks the same question one step earlier, so computing it in
   * the writer meant the segregation check had to approximate it — and its approximation was every
   * positive row on the line, which is a strictly larger set. One decision, read by both.
   *
   * The draw is greedy over the locked rows in ascending id order: deterministic, so two
   * certifications of the same line cannot disagree about which row they consumed.
   */
  private async drawAcceptances(
    tx: Prisma.TransactionClient,
    projectId: string,
    lines: ReadonlyArray<{ kind: 'material' | 'labour'; poLineId: string; claimedQty: Prisma.Decimal }>,
    evidenceByLine: ReadonlyMap<string, AcceptedEvidenceRow[]>,
  ): Promise<AcceptanceDraw[]> {
    const draws: AcceptanceDraw[] = [];
    // per PO LINE, not per bill line: two claim lines against one order draw from ONE pool, and
    // consuming per bill line would let each take the same row's free quantity
    for (const poLineId of [...new Set(lines.filter((l) => l.kind === 'material').map((l) => l.poLineId))].sort()) {
      let remaining = lines
        .filter((l) => l.kind === 'material' && l.poLineId === poLineId)
        .reduce((a, l) => a.add(l.claimedQty), ZERO);
      for (const row of evidenceByLine.get(poLineId) ?? []) {
        if (remaining.lessThanOrEqualTo(0)) break;
        const already = await this.consumedAcceptanceQty(tx, projectId, row.id);
        const free = row.available.sub(already);
        if (free.lessThanOrEqualTo(0)) continue;
        const take = Prisma.Decimal.min(remaining, free);
        draws.push({ stockTransactionId: row.id, consumedQty: take });
        remaining = remaining.sub(take);
      }
      if (remaining.greaterThan(0)) {
        throw new ConflictException(
          `Purchase-order line ${poLineId} claims ${remaining.toString()} more than the unconsumed accepted evidence covers — another live certificate already rests on the rest`,
        );
      }
    }
    return draws;
  }

  /** How much of one acceptance row LIVE certificates already rest on (§E, `(rowId, qty)`). */
  private async consumedAcceptanceQty(
    tx: Prisma.TransactionClient, projectId: string, stockTransactionId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.certifiedAcceptanceConsumption.findMany({
      where: { projectId, stockTransactionId, certificate: { is: { supersededAt: null } } },
      select: { consumedQty: true },
    });
    return rows.reduce((a, r) => a.add(r.consumedQty), ZERO);
  }

  /** The labour twin: how much of one measurement row live certificates already rest on (§D/§E). */
  private async consumedMeasurementQty(
    tx: Prisma.TransactionClient, projectId: string, measurementId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.certifiedMeasurementConsumption.findMany({
      where: { projectId, measurementId, certificate: { is: { supersededAt: null } } },
      select: { consumedQty: true },
    });
    return rows.reduce((a, r) => a.add(r.consumedQty), ZERO);
  }

  /**
   * §F — SUPERSEDE a certificate. Past certification this is the ONLY correction path: a status
   * flip would leave the certificate, and anything hanging off it, orphaned.
   *
   * The bill returns to `verified`, which is where a corrected certification is made from. The
   * consumption rows are NOT deleted — they are append-only history — but they stop counting the
   * moment the certificate they belong to is superseded, because every consumption fold reads
   * live certificates only. That is what releases the evidence for reversal or re-certification.
   */
  async supersede(
    projectId: string, input: SupersedeCertificateInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<CertificateDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertCertify(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.certificate.supersede', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const bill = await this.lockBill(tx, projectId, input.billId);
        if (bill.status !== 'certified') {
          throw new ConflictException(`A ${bill.status} claim has no live certification to supersede`);
        }
        const live = await tx.billCertificate.findFirst({
          where: { projectId, billId: input.billId, supersededAt: null },
          select: { id: true },
        });
        if (!live) throw new NotFoundException(`Vendor bill ${input.billId} has no live certificate`);
        const { count } = await tx.billCertificate.updateMany({
          where: { id: live.id, projectId, supersededAt: null },
          data: {
            supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: input.reason,
          },
        });
        if (count === 0) throw new ConflictException('This certificate was superseded concurrently — reload and retry');
        await this.cas(tx, projectId, input.billId, 'certified', 'verified');
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.certificate.supersede', entity: 'BillCertificate', entityId: live.id,
        });
        return { resultRef: live.id, events: [] };
      },
    });
    // the SUPERSEDED certificate, by the command's own result — the same replay rule as `certify`,
    // and here it matters more: the live certificate for this bill is now a DIFFERENT row (or
    // none at all), so a bill-scoped read would answer a question nobody asked
    return this.certificateById(projectId, outcome.resultRef!);
  }

  // ── §I — segregation of duties ───────────────────────────────────────────────────────────────

  /**
   * §I — the actor who recorded the evidence under a claim may not certify it.
   *
   * **For a MATERIAL bill there is no `Measurement` row, so the ACCEPTANCE actor is the measurer**
   * — the store user who recorded `receipts.accept` may not certify the bill consuming that
   * acceptance. Without this the rule would bind labour bills and silently exempt material ones,
   * which is the larger spend.
   *
   * **This unit ships the RULE; the attributable override ships next.** §I is explicit that
   * silently banning the act is not acceptable either — a two-person practice must still be able to
   * operate — so a named exception, requiring a stronger authority and recorded with its reason
   * against the certificate, follows in its own review unit. Shipping the refusal first is what
   * makes that split safe: until the override exists this check is strictly more restrictive than
   * the finished rule, so no intermediate state of the system permits an act the finished rule
   * would refuse.
   *
   * The rows consulted are exactly the ones this certificate FROZE — not every acceptance or
   * measurement on the line. A store user whose acceptance is fully consumed by an earlier live
   * certificate is not in this certificate's evidence, and refusing them would be refusing on the
   * strength of a row this act does not rest on. That set is not described here and derived
   * elsewhere: it is `phase5_t5_evidence_actors`, and this method reads it.
   */
  private async assertSegregation(
    tx: Prisma.TransactionClient,
    projectId: string,
    actorId: string,
    certificateId: string,
  ): Promise<void> {
    // Codex rounds 3 and 5, twice about the same rule: the service counted the authors of positive
    // measurement corrections as evidence actors and the database seal did not, because they were
    // two implementations of one question and only the one a finding named ever got fixed.
    //
    // So this is no longer an implementation. `phase5_t5_evidence_actors` is the single site, and
    // the commit-time seal calls exactly this function over exactly these rows: the two layers
    // cannot disagree, and a future change to who counts as an evidence actor is ONE edit that
    // cannot half-land.
    //
    // It is asked of the FROZEN rows rather than of the draw, which is the same set — the freeze
    // above writes the draw — but stated as the certificate's own evidence, which is what §I is
    // about and what a reviewer can check without tracing how the draw was built.
    const actors = await tx.$queryRaw<Array<{ actor: string }>>(
      Prisma.sql`SELECT actor FROM phase5_t5_evidence_actors(${projectId}, ${certificateId})`,
    );
    if (actors.some((a) => a.actor === actorId)) {
      throw new ForbiddenException(
        'Segregation of duties: the actor who recorded the evidence under this claim may not certify it.',
      );
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  /** The LIVE certificate on a bill. 404 when none stands — including after a supersession. */
  async readCertificate(projectId: string, billId: string, user: AuthUser): Promise<CertificateDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    // Codex round-4 P2 — the liveness predicate travels INTO the reload. Resolving the live
    // certificate and then re-reading it by id leaves a window: a supersession committing between
    // the two reads makes this endpoint report history as current, which is the one thing a LIVE
    // read must never do. `certificateById` is right for `certify`/`supersede`, which owe the
    // caller the certificate THAT CALL made whatever its state — but this route asks a different
    // question, so it carries a different predicate.
    const cert = await this.certificateById(projectId, { projectId, billId, supersededAt: null });
    if (!cert) throw new NotFoundException(`Vendor bill ${billId} has no live certificate`);
    return cert;
  }

  /** One certificate by identity, live or superseded — the shape both commands and the read return. */
  private async certificateById(projectId: string, certificateId: string): Promise<CertificateDto>;
  private async certificateById(
    projectId: string, where: { projectId: string; billId: string; supersededAt: null },
  ): Promise<CertificateDto | null>;
  private async certificateById(
    projectId: string,
    target: string | { projectId: string; billId: string; supersededAt: null },
  ): Promise<CertificateDto | null> {
    const certificateId = typeof target === 'string' ? target : null;
    const cert = await this.prisma.billCertificate.findFirst({
      where: typeof target === 'string' ? { projectId, id: target } : target,
      include: {
        acceptanceConsumption: { orderBy: { stockTransactionId: 'asc' } },
        measurementConsumption: { orderBy: { measurementId: 'asc' } },
      },
    });
    if (!cert) {
      if (certificateId === null) return null;
      throw new NotFoundException(`Certificate ${certificateId} not found in this project`);
    }
    return {
      id: cert.id,
      billId: cert.billId,
      versionId: cert.versionId,
      certifiedAmount: cert.certifiedAmount.toString(),
      // §G bound 4 caps a later APPROVAL at `NET_PAYABLE` = this amount less unreleased
      // deductions. The deduction ledger is Task 5C's, so this increment reports the certified
      // amount and does NOT report a net payable: a `netPayable` field equal to the gross would
      // be read as a computed figure, and every consumer of it would be silently wrong the moment
      // the first deduction row existed. An absent field is a question; a wrong one is an answer.
      certifiedAt: cert.certifiedAt.toISOString(),
      certifiedById: cert.certifiedById,
      supersededAt: cert.supersededAt?.toISOString() ?? null,
      supersededById: cert.supersededById,
      supersedeReason: cert.supersedeReason,
      // §E — the frozen evidence, reported. A certificate whose consumption set is invisible is a
      // certificate nobody can audit, and this pair is exactly what the withdrawal guards refuse
      // against: a reviewer asking "why can this acceptance not be reversed" reads the answer here.
      acceptanceConsumption: cert.acceptanceConsumption.map((c) => ({
        rowId: c.stockTransactionId, consumedQty: c.consumedQty.toString(),
      })),
      measurementConsumption: cert.measurementConsumption.map((c) => ({
        rowId: c.measurementId, consumedQty: c.consumedQty.toString(),
      })),
    };
  }

  // ── shared machinery ─────────────────────────────────────────────────────────────────────────

  private async cas(
    tx: Prisma.TransactionClient, projectId: string, billId: string, from: string, to: string,
  ): Promise<void> {
    const { count } = await tx.vendorBill.updateMany({
      where: { id: billId, projectId, status: from },
      data: { status: to, statusChangedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('This claim moved concurrently — reload and retry');
  }

  /** §0b — the BILL is taken FIRST, before any foreign row, so the lock order stays total. */
  private async lockBill(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ id: string; status: string; vendorId: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; vendorId: string }>>`
      SELECT "id", "status", "vendorId" FROM "VendorBill"
       WHERE "projectId" = ${projectId} AND "id" = ${billId} FOR UPDATE`;
    const bill = rows[0];
    if (!bill) throw new NotFoundException('Vendor bill not found in this project');
    return bill;
  }
}
