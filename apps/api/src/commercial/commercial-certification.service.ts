import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BILL_CERTIFY_FROM, BILL_STATUSES_PAST_CERTIFICATION, ROLE_POLICY, SOD_RULES, type CertificateDto, type SodGrantDto, type SodGrantSummaryDto, type VendorBillStatus } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { hashRequest, type CommandScope } from '../platform/commands';
import { CommercialCommandRunner } from './commercial-command.runner';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { InventoryParticipant, type AcceptedEvidenceRow } from '../inventory/inventory.participant';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialStatusService } from './commercial-status.service';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import { CommercialDeductionQuery } from './commercial-deduction.query';
import { CommercialVerificationService } from './commercial-verification.service';
import { CommercialBillService } from './commercial-bill.service';
import type { CertifyBillInput, GrantSodExceptionInput, SupersedeCertificateInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

/** The rule THIS service's §I half defines. Task 6A adds `certifier-may-not-approve` beside it,
 *  and both names now live in the shared contract so a grant issued for one can never be spent on
 *  the other. */
const SOD_RULE = SOD_RULES.evidenceRecorderMayNotCertify;

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
    private readonly commands: CommercialCommandRunner,
    private readonly capabilities: CapabilitiesService,
    private readonly inventoryParticipant: InventoryParticipant,
    private readonly activities: ActivityParticipant,
    private readonly bills: CommercialBillQuery,
    private readonly measured: CommercialMeasurementQuery,
    private readonly verification: CommercialVerificationService,
    // §B's mover rule — certification moves money between §J buckets, so it discharges the
    // raise-or-clear obligation through the SAME public helper verification uses, rather than
    // growing a second copy of the fold's closure rule.
    private readonly billService: CommercialBillService,
    private readonly status: CommercialStatusService,
    // §I's approver standing is an ORGS question — `Membership`/`OrgMembership` are orgs-owned and
    // the owner states the rule. `commercial.workflowParticipants` already declares this edge.
    private readonly orgs: OrgsParticipant,
    // §H — the withholding fold that decides whether this certificate is correctable in place. Own
    // module, one owner: `supersede` asks the same question the DB seal asks.
    private readonly deductions: CommercialDeductionQuery,
  ) {}

  private assertCertify(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.certify'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Certifying a vendor claim is a pmc surface — it creates money someone may approve');
    }
  }

  private assertGrant(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.sod.grant'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Authorising a segregation-of-duties override is a pmc surface');
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

    const outcome = await this.commands.run({
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
        if (!(BILL_CERTIFY_FROM as readonly string[]).includes(bill.status)) {
          throw new ConflictException(
            `A ${bill.status} claim cannot be certified — certification applies to a VERIFIED claim, because the §E verdict is what makes it safe`,
          );
        }
        const { versionId, lines } = await this.verification.claimLines(tx, projectId, input.billId);
        // Codex round-2 — certify the claim that was READ, not whichever version is live when a
        // queued command replays. Round 1 applied this to the grant and left the act it authorises
        // unguarded; the exposure is the same and the stake is higher.
        if (input.versionId !== undefined && input.versionId !== versionId) {
          throw new ConflictException(
            'This claim was amended after you read it — certifying now would freeze evidence for a version you have not seen. Reload and certify again.',
          );
        }

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

        // §H — RE-STATE the superseded certificate's withholdings onto this one, in this
        // transaction. The plan is explicit: "supersession RE-STATES the deductions on the new
        // certificate … and `NET_PAYABLE` reads only the live certificate's rows". Dropping them
        // makes a retained balance vanish with no attributable release, which is what §H forbids —
        // and refusing the correction instead (the round-5 split) forced an append-only release row
        // claiming money came back when it had not, which is worse: false evidence in an immutable
        // ledger.
        await this.restateDeductions(tx, projectId, input.billId, certificate.id, certifiedAmount);

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
        const sod = await this.assertSegregation(tx, projectId, input.billId, versionId, actor.actorId, certificate.id);

        // §I — written in the SAME transaction as the override it authorises, bound to THAT
        // certificate by composite FK, and carrying the SAME `sourceCommandId`. An exception is
        // authority for ONE certificate produced by ONE act, never a standing waiver a later
        // override can point at (Codex round-6 P2: the database now requires that command identity
        // to match, so a forged row citing a stale command cannot pose as this act's authority).
        if (sod) {
          await tx.sodException.create({
            data: {
              projectId, certificateId: certificate.id,
              rule: sod.rule, actorId: sod.actorId, approverId: sod.approverId, reason: sod.reason,
              grantId: sod.grantId, sourceCommandId: ctx.commandId!,
            },
          });
        }

        await this.cas(tx, projectId, input.billId, 'verified', 'certified');
        // §F — certification CREATES `NET_PAYABLE`, so it is a fold-mover like the rest and
        // re-derives through the same function. At this tree the derivation agrees with the CAS
        // above (`APPROVED = 0` → `certified`), and that agreement is the point rather than a
        // reason to skip it: the arm is asserted rather than assumed, and a §H deduction landing in
        // the same transaction — which can drive `NET_PAYABLE` to zero and make the claim `paid`
        // with no cash moving — is derived rather than left contradicting its own folds.
        await this.status.reDerive(tx, projectId, input.billId, 'certified');
        // §B — the §J fold now READS this certificate, so certifying is a headroom MOVER and owes
        // the same raise-or-clear the fold's other inputs owe. It is evaluated ONCE, at the end,
        // after every write this act makes: an intermediate evaluation would read a state that
        // never existed at commit, and the register is append-only.
        //
        // With a FULL certification the exposure total is unchanged — the money moves from
        // `awaiting-certification` into `certified-payable` — so this ordinarily writes nothing.
        // That is the correct outcome, not a reason to skip the call: the mover set is derived
        // from what the fold reads (`FOLD_INPUTS`), and a term that can move exposure the day a
        // partial certificate or a §H deduction lands must discharge the obligation now, while
        // the person adding that term is not the one who has to remember.
        await this.billService.evaluateHeadsForBill(tx, projectId, actor, input.billId);
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
  /**
   * §H — carry the SUPERSEDED certificate's live ledger onto the replacement.
   *
   * Both halves move together and that is the whole rule: a retained balance is a fold over
   * deductions MINUS releases, so re-stating the deduction alone would read ₹10 retained and ₹0
   * released — clawing back money the vendor was already told it could have, with the release row
   * stranded on a superseded certificate as evidence the live truth denies. §H: "whatever
   * certificate `NET_PAYABLE` reads, it reads BOTH row kinds from."
   *
   * The superseded rows are NOT edited or deleted — they are append-only history on the certificate
   * they were taken against. This writes NEW rows carrying `restatedFromId`, which is both the audit
   * chain and (being UNIQUE) the reason one source row can never be restated twice.
   *
   * CLOSURE 5 — the copied field list is stated ONCE, here, and the database checks the copy field
   * for field against it. `phase5-t5c-deductions.test.ts` enumerates these lists against the tables'
   * real columns, so a column added later fails that test rather than silently escaping the copy.
   */
  private async restateDeductions(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
    certificateId: string,
    certifiedAmount: Prisma.Decimal,
  ): Promise<void> {
    // the certificate this one REPLACES: the most recently superseded one on this bill
    const prior = await tx.billCertificate.findFirst({
      where: { projectId, billId, supersededAt: { not: null } },
      orderBy: { supersededAt: 'desc' },
      select: { id: true },
    });
    if (!prior) return;

    // LOCK the source rows before copying them. Without it a bypass release can commit in the gap:
    // this read sees a ₹10 source deduction with no releases, a direct transaction inserts a ₹10
    // release against it and passes its bound because the restatement is still uncommitted, and
    // certification then commits a live restated deduction with no release — `NET_PAYABLE` withheld
    // while the source ledger says the money was returned. Ascending id, the repo's standard order,
    // so two certifications of sibling bills cannot deadlock against each other.
    await tx.$queryRaw`
      SELECT "id" FROM "BillDeduction"
       WHERE "projectId" = ${projectId} AND "certificateId" = ${prior.id}
       ORDER BY "id" ASC
       FOR UPDATE`;

    const rows = await tx.billDeduction.findMany({
      where: { projectId, certificateId: prior.id },
      orderBy: { recordedAt: 'asc' },
      include: { releases: { orderBy: { releasedAt: 'asc' } } },
    });
    if (rows.length === 0) return;

    // §H's floor applies to the CARRIED set too, and it is checked before anything is written: a
    // replacement certified BELOW its outstanding withholdings cannot exist, and refusing here
    // names the conflict instead of letting the deferred bound reject the whole certification with
    // an aggregate nobody can act on. Correcting downward that far means releasing first.
    const carried = rows.reduce(
      (a, d) => a.add(d.releases.reduce((r, x) => r.sub(x.amount), d.amount)),
      new Prisma.Decimal(0),
    );
    if (carried.greaterThan(certifiedAmount)) {
      throw new ConflictException(
        `This claim carries ${carried.toFixed(2)} of unreleased withholding, which a ${certifiedAmount.toFixed(2)} certificate cannot hold — release the difference before certifying a lower amount, so the money is given back attributably rather than by a certificate quietly dropping it`,
      );
    }

    for (const d of rows) {
      const restated = await tx.billDeduction.create({
        data: {
          projectId, certificateId, billId,
          // RESTATED_DEDUCTION_FIELDS — the complete copied set (CLOSURE 5)
          type: d.type, amount: d.amount, reason: d.reason,
          recordedById: d.recordedById, sourceCommandId: d.sourceCommandId,
          restatedFromId: d.id,
        },
      });
      for (const r of d.releases) {
        await tx.billDeductionRelease.create({
          data: {
            projectId, deductionId: restated.id,
            // RESTATED_RELEASE_FIELDS — the complete copied set (CLOSURE 5)
            amount: r.amount, reason: r.reason,
            releasedById: r.releasedById, sourceCommandId: r.sourceCommandId,
            restatedFromId: r.id,
          },
        });
      }
    }
  }

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

    const outcome = await this.commands.run({
      scope, actor, commandType: 'commercial.certificate.supersede', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const bill = await this.lockBill(tx, projectId, input.billId);
        // Task 6B-i — the SET, exactly as the note left here for this task said it would be.
        // §F's derivation makes `approved-for-payment`, `part-paid` and `paid` reachable, and every
        // one of them stands on a LIVE certificate, so guarding on the member would refuse a
        // correction with the false reason that no certification exists.
        if (!(BILL_STATUSES_PAST_CERTIFICATION as readonly string[]).includes(bill.status)) {
          throw new ConflictException(`A ${bill.status} claim has no live certification to supersede`);
        }

        // §0's rule that cash already gone is not corrected by correcting a document is ALREADY
        // enforced — Task 6A's bound-5 seal refuses a supersession that would leave `PAID` above the
        // `APPROVED` it drops to, which is every case where cash stands against the live
        // certificate. A service-level refusal here would restate that rule at a second site with a
        // second message, which is the drift this module keeps removing. The widened status guard
        // above does not weaken it: superseding a `part-paid` claim still meets the same seal.
        const live = await tx.billCertificate.findFirst({
          where: { projectId, billId: input.billId, supersededAt: null },
          select: { id: true },
        });
        if (!live) throw new NotFoundException(`Vendor bill ${input.billId} has no live certificate`);
        // Codex round-2 — the same rule for the document being corrected: a queued supersession
        // names the certificate its reason was written about, or it is refused.
        if (input.certificateId !== undefined && input.certificateId !== live.id) {
          throw new ConflictException(
            'This certificate was already superseded — the correction would replace a different document than the one you reviewed. Reload and supersede again.',
          );
        }

        // §H — a certificate carrying an UNRELEASED withholding is not correctable in place.
        const { count } = await tx.billCertificate.updateMany({
          where: { id: live.id, projectId, supersededAt: null },
          data: {
            supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: input.reason,
          },
        });
        if (count === 0) throw new ConflictException('This certificate was superseded concurrently — reload and retry');
        // Task 6B-i — the CAS moves from whatever DERIVED status this bill actually holds, not from
        // the one member that used to be the only possibility. `bill.status` was read under the row
        // lock above and the guard has already required it to be in the family, so this is the
        // status supersession is correcting.
        await this.cas(tx, projectId, input.billId, bill.status, 'verified');
        // §F — supersession returns the bill to the FORWARD lifecycle, and `verified` is outside
        // the derived family, so `reDerive` correctly declines to touch it. The call is kept so the
        // mover set stays complete by construction: the guard is `isDerivedBillStatus`, one rule at
        // one site, rather than each mover deciding for itself whether it is allowed to run.
        await this.status.reDerive(tx, projectId, input.billId, 'verified');
        // §B — the twin of `certify`'s evaluation: superseding puts the money back into
        // `awaiting-certification`, so the same mover obligation applies in the same transaction.
        await this.billService.evaluateHeadsForBill(tx, projectId, actor, input.billId);
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
   * The exception path is NAMED, not silent: it requires a stronger authority and writes an
   * attributable `SodException` in the SAME transaction, and by the same command, as the
   * certification it authorises. Silently allowing it is not an option; silently banning it is not
   * either, because a two-person practice must still be able to operate. Unit A shipped the refusal
   * alone — strictly stricter than this — which is what made splitting the authority check safe.
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
    billId: string,
    versionId: string,
    actorId: string,
    certificateId: string,
  ): Promise<{ grantId: string; rule: string; actorId: string; approverId: string; reason: string } | null> {
    // Codex rounds 3 and 5, twice about the same rule: the service counted the authors of positive
    // measurement corrections as evidence actors and the database seal did not, because they were
    // two implementations of one question and only the one a finding named ever got fixed. So this
    // is no longer an implementation — `phase5_t5_evidence_actors` is the single site, and the
    // commit-time seal calls exactly this function over exactly these rows.
    const actors = await tx.$queryRaw<Array<{ actor: string }>>(
      Prisma.sql`SELECT actor FROM phase5_t5_evidence_actors(${projectId}, ${certificateId})`,
    );
    if (!actors.some((a) => a.actor === actorId)) return null;

    // Codex round-7 P1 — the override is CONSUMED, never supplied. An earlier spelling took
    // `approverId` from this caller's own request and checked only that the named person held
    // standing, so a self-certifying pmc could type a colleague's id and the system would write an
    // immutable record asserting that colleague authorised it. The authority was never asked.
    //
    // A grant is the approver's OWN authenticated act. It is claimed here with a CAS on the unused
    // row, so two concurrent certifications cannot both spend one authority — an override is
    // exercised once, and `updateMany` returning 0 is that race losing rather than a lost update.
    // The grant is selected BY VERSION, not "any live grant, then check its version". A claim that
    // was authorised, amended, and authorised again legitimately has two live grants — one stale,
    // one current — and `findFirst` over the version-blind scope picks between them arbitrarily.
    // The probe for round-8's index fix caught this: it refused a perfectly good certification
    // because it had reached for the stale row. Selecting on the version is the fix; the stale-grant
    // branch below now exists only to give an ACCURATE message.
    // Codex round 10, and it is round 8's finding in a second costume. Round 8: this read selected
    // over the version-BLIND scope and compared versions afterwards, so a legitimate stale+current
    // pair resolved arbitrarily. I fixed the version and left the SHAPE — select one row, then
    // validate it — and round 9's `approverId` in the live-grant scope made the same trap reachable
    // through standing: approver A grants, A is downgraded, B grants a valid replacement, and a
    // `findFirst` that happens to return A's row refuses the whole certification.
    //
    // The shape is the defect. "Select an arbitrary candidate, then check it" answers a different
    // question from "select a candidate that is valid" whenever more than one can exist, and the
    // live-grant scope is now deliberately wide enough for more than one. So the standing filter
    // moves INTO the selection, and the stale rows are simply not candidates.
    const resolved = await this.resolveGrant(tx, projectId, billId, versionId, actorId, true);
    if (resolved.state !== 'live') {
      // The three refusals are the resolver's three non-live states, spelled once here where the
      // ACT is refused. `resolveGrant` decides WHICH state holds; this decides what that means for
      // a certification, and the read path decides what it means for a screen. One rule, two
      // consequences — rather than the read re-deriving the rule and drifting from it.
      if (resolved.state === 'approver-lost-standing') {
        throw new ForbiddenException(
          'The authorisation on this claim was granted by someone who no longer holds pmc standing on this project — a pmc with standing must authorise it again',
        );
      }
      if (resolved.state === 'stale-version') {
        throw new ConflictException(
          'The authorisation on this claim was granted against an earlier version — the claim has been amended since, so it needs authorising again',
        );
      }
      throw new ForbiddenException(
        'Segregation of duties: the actor who recorded the evidence under this claim may not certify it. '
        + 'A pmc with standing on this project may authorise it with `commercial.sod.grant`, which records '
        + 'their own reason against this claim.',
      );
    }
    const grant = resolved.grant;
    const { count } = await tx.sodGrant.updateMany({
      where: { id: grant.id, projectId, consumedAt: null },
      data: { consumedAt: new Date(), consumedByCertificateId: certificateId },
    });
    if (count === 0) {
      throw new ConflictException('That authorisation was consumed concurrently — reload and retry');
    }
    return {
      grantId: grant.id, rule: SOD_RULE, actorId, approverId: grant.approverId, reason: grant.reason,
    };
  }

  /**
   * §I — WHICH authorisation, if any, stands for this actor on this claim version.
   *
   * Extracted from `assertSegregation` rather than written beside it, because 7B-iii-f needs the
   * same answer on a READ — a certifier who has just been granted an exception cannot otherwise
   * tell whether it is live and version-matched, and "granted against an earlier version because
   * the claim was amended since" is invisible until the certification is refused. The service's
   * own history is the argument for sharing rather than re-deriving: this rule was twice TWO
   * implementations of one question, and only the one a finding named ever got fixed.
   *
   * `forUpdate` is the CALLER'S INTENT, not a second rule. A certification is an authority
   * DECISION, so it reads standing under a lock — a concurrent downgrade must not commit behind an
   * approval it granted. A screen is asking what is true now and locks nothing. The predicate is
   * identical either way; only whether the answer is held is different.
   *
   * The shape is deliberate. "Select an arbitrary candidate, then check it" answers a different
   * question from "select a candidate that is valid" whenever more than one can exist — Codex
   * rounds 8, 9 and 10 were three costumes of that one defect — so the standing filter is INSIDE
   * the selection and stale rows are simply not candidates.
   */
  async resolveGrant(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
    versionId: string,
    actorId: string,
    forUpdate: boolean,
  ): Promise<
    | { state: 'live'; grant: { id: string; approverId: string; reason: string } }
    | { state: 'none' | 'stale-version' | 'approver-lost-standing' }
  > {
    const live = await tx.sodGrant.findMany({
      where: { projectId, billId, versionId, rule: SOD_RULE, actorId, consumedAt: null },
      select: { id: true, approverId: true, reason: true },
      orderBy: { grantedAt: 'asc' },
    });
    for (const candidate of live) {
      if (await this.orgs.hasProjectRoleStanding(tx, projectId, candidate.approverId, ['pmc'], { forUpdate })) {
        return { state: 'live', grant: candidate };
      }
    }
    if (live.length > 0) return { state: 'approver-lost-standing' };
    // version-pinned: an amendment is a DIFFERENT claim, and permission to certify the one the
    // approver looked at should not silently carry over to one they never saw
    const stale = await tx.sodGrant.count({
      where: { projectId, billId, rule: SOD_RULE, actorId, consumedAt: null },
    });
    return { state: stale > 0 ? 'stale-version' : 'none' };
  }

  /**
   * §I — GRANT permission for one otherwise-forbidden certification. The AUTHENTICATED actor is the
   * authority: there is no `approverId` field, because a field is exactly what a certifier can fill
   * in with somebody else's name.
   */
  async grantSodException(
    projectId: string, input: GrantSodExceptionInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<SodGrantDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertGrant(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    const outcome = await this.commands.run({
      scope, actor, commandType: 'commercial.sod.grant', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        if (input.actorId === actor.actorId) {
          throw new ForbiddenException('A segregation-of-duties exception cannot be authorised by the actor it excuses');
        }
        // the grant names the claim's LIVE version, so it is pinned to what the approver looked at
        const version = await tx.vendorBillVersion.findFirst({
          where: { projectId, billId: input.billId, supersededAt: null },
          select: { id: true },
        });
        if (!version) throw new NotFoundException(`Vendor bill ${input.billId} has no live claim version`);
        // Codex F4 — the approver authorises the claim they READ, not whichever one is live when a
        // queued command happens to replay. A drifted version is refused rather than silently
        // re-pinned, because re-pinning is the exact thing §I's version pinning forbids.
        if (input.versionId !== undefined && input.versionId !== version.id) {
          throw new ConflictException(
            'This claim was amended after you read it — the authorisation would apply to a version you have not seen. Reload and authorise again.',
          );
        }
        // the authority must hold standing AT THE MOMENT OF GRANTING, read under the same lock the
        // certification will use — the participant, because standing is the orgs module's rule
        const entitled = await this.orgs.hasProjectRoleStanding(
          tx, projectId, actor.actorId, ['pmc'], { forUpdate: true },
        );
        if (!entitled) {
          throw new ForbiddenException('A segregation-of-duties exception must be authorised by a pmc with standing on this project');
        }
        const row = await tx.sodGrant.create({
          data: {
            // Task 6A — the rule comes from the REQUEST (defaulted to the certification rule by the
            // contract, so every Task-5 caller is unchanged). An approver authorising a store user
            // to certify has not thereby authorised anyone to approve that claim's payment, and the
            // consumption sites select on this column for exactly that reason.
            projectId, billId: input.billId, versionId: version.id, rule: input.rule ?? SOD_RULE,
            actorId: input.actorId, approverId: actor.actorId, reason: input.reason,
            sourceCommandId: ctx.commandId!,
          },
        });
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.sod.grant', entity: 'SodGrant', entityId: row.id,
        });
        return { resultRef: row.id, events: [] };
      },
    });
    const row = await this.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: outcome.resultRef! } });
    return {
      id: row.id, billId: row.billId, versionId: row.versionId, rule: row.rule,
      actorId: row.actorId, approverId: row.approverId, reason: row.reason,
      grantedAt: row.grantedAt.toISOString(),
      consumedAt: row.consumedAt?.toISOString() ?? null,
      consumedByCertificateId: row.consumedByCertificateId,
      consumedByApprovalId: row.consumedByApprovalId,
    };
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

  /**
   * §M (Task 7B-ii) — the LIVE certificate ON A GIVEN TRANSACTION, or null when none stands.
   *
   * Null rather than the route's 404: a claim before certification is an ordinary state of the
   * lifecycle page, not a missing resource. The liveness predicate travels into the query for the
   * same reason `readCertificate` carries it — resolving the live certificate and re-reading it by
   * id leaves a window in which a supersession makes history look current.
   */
  /**
   * §I — every LIVE authorisation on ONE claim version, whoever it names (Codex F3).
   *
   * `resolveGrant` answers for ONE actor and is the write path's question. This is the READ's
   * question — "what authorisations stand on this claim?" — and the two are deliberately separate
   * rather than one over-parameterised function: an authority DECISION must select a candidate
   * that is valid (standing filtered inside the selection, rounds 8–10), while a register LISTS
   * what was granted, including one whose approver has since lost standing. Collapsing them would
   * make the list silently omit a grant that exists, which is the opposite of §I's "named, not
   * silent".
   */
  async liveGrantsIn(
    tx: Prisma.TransactionClient, projectId: string, billId: string, versionId: string | null,
  ): Promise<SodGrantSummaryDto[]> {
    if (versionId === null) return [];
    const rows = await tx.sodGrant.findMany({
      where: { projectId, billId, versionId, consumedAt: null },
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    });
    // Codex round 3 — a live row is not a usable authority. The certification resolver admits only
    // the certification RULE and only an approver who still holds pmc standing, so both terms are
    // answered here, by the same rule, rather than left for a screen to guess at. Standing is the
    // ORGS module's question and no client can answer it.
    const out: SodGrantSummaryDto[] = [];
    for (const r of rows) {
      const usableForCertification = r.rule === SOD_RULE
        && await this.orgs.hasProjectRoleStanding(tx, projectId, r.approverId, ['pmc']);
      out.push({
        id: r.id, actorId: r.actorId, approverId: r.approverId,
        rule: r.rule, reason: r.reason, grantedAt: r.grantedAt.toISOString(),
        usableForCertification,
      });
    }
    return out;
  }

  async liveCertificateIn(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<CertificateDto | null> {
    return this.certificateById(projectId, { projectId, billId, supersededAt: null }, tx);
  }

  /** One certificate by identity, live or superseded — the shape both commands and the read return. */
  private async certificateById(projectId: string, certificateId: string): Promise<CertificateDto>;
  private async certificateById(
    projectId: string, where: { projectId: string; billId: string; supersededAt: null },
    db?: Prisma.TransactionClient,
  ): Promise<CertificateDto | null>;
  private async certificateById(
    projectId: string,
    target: string | { projectId: string; billId: string; supersededAt: null },
    db?: Prisma.TransactionClient,
  ): Promise<CertificateDto | null> {
    const certificateId = typeof target === 'string' ? target : null;
    // the caller's snapshot when it has one, otherwise this service's own client — so the standalone
    // route and the §M bundle read the SAME shape through the SAME query.
    const cert = await (db ?? this.prisma).billCertificate.findFirst({
      where: typeof target === 'string' ? { projectId, id: target } : target,
      include: {
        sodExceptions: true,
        acceptanceConsumption: { orderBy: { stockTransactionId: 'asc' } },
        measurementConsumption: { orderBy: { measurementId: 'asc' } },
      },
    });
    if (!cert) {
      if (certificateId === null) return null;
      throw new NotFoundException(`Certificate ${certificateId} not found in this project`);
    }
    const sod = cert.sodExceptions[0];
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
      sodException: sod
        ? {
          rule: sod.rule, actorId: sod.actorId, approverId: sod.approverId, reason: sod.reason,
          recordedAt: sod.recordedAt.toISOString(), grantId: sod.grantId,
        }
        : null,
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
