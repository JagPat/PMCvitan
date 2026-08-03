import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY, type MeasurementDto, type MeasurementRegisterDto } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { CLOCK, type Clock } from '../common/clock';
import { rethrowMediaRefViolation } from '../common/project-ref';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { ActivityParticipant } from '../activities/activity.participant';
import { LabourRequirementQuery } from '../labour/labour.query';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialParticipant } from './commercial.participant';
import type { CorrectMeasurementInput, TakeMeasurementInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

type MeasurementRow = {
  id: string; labourPoLineId: string; activityId: string; quantity: Prisma.Decimal;
  correctsId: string | null; reason: string | null; measuredOn: Date;
  citedOutputId: string; evidenceMediaId: string | null; takenAt: Date; takenById: string;
};

function serialize(m: MeasurementRow): MeasurementDto {
  return {
    id: m.id,
    labourPoLineId: m.labourPoLineId,
    activityId: m.activityId,
    quantity: m.quantity.toString(),
    correctsId: m.correctsId,
    reason: m.reason,
    measuredOn: toIsoCivilDate(m.measuredOn) ?? '',
    citedOutputId: m.citedOutputId,
    evidenceMediaId: m.evidenceMediaId,
    takenAt: m.takenAt.toISOString(),
    takenById: m.takenById,
  };
}

/**
 * Phase 5 Task 3 (§D) — MEASUREMENT: a contractually agreed quantity at a contract rate, taken by
 * a named person on a named date, against a named PO line.
 *
 * It is deliberately NOT `ActivityWorkOutput` (what was physically produced) and NOT
 * `LabourWorkFact` (minutes worked). Those are operational truth; a measurement is a billing fact
 * with a different unit, a different authority and a different lifecycle. Phase 5 CONSUMES the
 * operational facts rather than restating them, which is why a measurement is bounded by them.
 *
 * LABOUR ONLY, and only person-shift pricing. §D removed the output-priced shape from scope: a
 * `LabourPurchaseOrderLine` freezes `personShiftQty` and `ratePerPersonShift` and nothing else, so
 * a 100 sqm claim would have no frozen ordered quantity and no frozen ₹/sqm to verify against —
 * certification from no ordered evidence, which is what this phase exists to prevent. Material
 * lines are not measured at all: `ACCEPTED(poLine)` already IS the measurement of a delivery.
 */
@Injectable()
export class CommercialMeasurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly activities: ActivityParticipant,
    private readonly labour: LabourRequirementQuery,
    private readonly measured: CommercialMeasurementQuery,
    private readonly bills: CommercialBillQuery,
    private readonly participant: CommercialParticipant,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private assertMeasure(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.measure'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Taking a measurement for payment is a pmc/engineer surface');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  /** `MEASURED(poLine)` — ONE fold, shared with the `COMMITTED` query, so the number this write
   *  path is bounded by and the number the budget reports can never be two different sums. */
  private async measuredFor(
    tx: Prisma.TransactionClient, projectId: string, labourPoLineId: string,
  ): Promise<Prisma.Decimal> {
    return (await this.measured.measuredForPoLines(tx, projectId, [labourPoLineId])).get(labourPoLineId) ?? ZERO;
  }

  /**
   * The NET contribution one measurement row still makes to the fold: its own quantity plus every
   * correction addressed to it. A row corrected back to zero has nothing left to withdraw.
   */
  private async netOf(
    tx: Prisma.TransactionClient, projectId: string, measurementId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.measurement.findMany({
      where: { projectId, OR: [{ id: measurementId }, { correctsId: measurementId }] },
      select: { quantity: true },
    });
    return rows.reduce((acc, r) => acc.add(r.quantity), ZERO);
  }

  /**
   * §D — take a measurement against a signed-off activity.
   *
   * The four things that must ALL hold, and why none of them is redundant:
   *
   * 1. the activity is `done`, read UNDER ITS ROW LOCK. A plain status read admits the race §D
   *    names: measurement sees `done`, a rejected closing inspection reverts the sign-off, and the
   *    immutable measurement commits anyway.
   * 2. a cited `ActivityWorkOutput` EXISTS for that same activity. Sign-off alone would let a
   *    commercial actor author the only quantity evidence in the chain — a 100-shift measurement
   *    against an activity with no recorded output — so verification would later certify from
   *    commercial input rather than from the Phase-1–4 facts. The citation is a PREDICATE: it is
   *    never drawn down, so a mason line and a helper line both measure against ONE output.
   * 3. `MEASURED ≤ EFFORT` — worked minutes normalised to person-shifts and joined to THIS line
   *    through the commitment that funded the allocation. This is the quantity cap.
   * 4. `MEASURED ≤ ordered personShiftQty`. `EFFORT` alone would let 120 worked shifts be measured
   *    against a 100-shift PO, and because `COMMITTED` consumes measured person-shifts the forecast
   *    would carry 20 shifts of unauthorised work long before any bill refused them. Ordered
   *    authority bounds MEASUREMENT, not just billing.
   */
  async take(projectId: string, input: TakeMeasurementInput, user: AuthUser, idempotencyKey?: string): Promise<MeasurementDto> {
    return this.append(projectId, user, idempotencyKey, 'commercial.measurement.take', input, {
      labourPoLineId: input.labourPoLineId,
      activityId: input.activityId,
      quantity: new Prisma.Decimal(input.quantity),
      correctsId: null,
      reason: input.reason ?? null,
    });
  }

  /**
   * §D — a CORRECTION is a new row carrying a SIGNED delta and a reason, never an edit.
   *
   * The floor is what the fold already SUPPORTS. §0's zero floor is the base case — recording 100
   * then correcting −150 must be refused, because leaving `MEASURED` at −50 would permanently fail
   * `BILLED_QTY ≤ MEASURED` for work that was actually done.
   *
   * Phase 5 Task 4 raises it to the LIVE-CLAIM floor §D states, because this is the first tree in
   * which a claim can exist: refuse only if the result would fall below `BILLED_QTY` over live
   * CERTIFIED bills, and otherwise DISPUTE enough live UNCERTIFIED claims for the bound to hold.
   * An earlier plan revision refused the correction whenever live `BILLED_QTY` would exceed the
   * new total, which blocks evidence repair on the strength of a bill nobody has verified: measure
   * 100, a vendor submits a 100-shift claim, the engineer discovers the real figure is 50 — and
   * the site cannot fix its own record until the vendor's unverified claim is dealt with. §G
   * already decided this for the material side, where an acceptance reversal disputes live
   * uncertified claims and refuses only against a live certificate; the measurement path owes the
   * identical disposition (§0b: same rule, every site).
   *
   * A POSITIVE correction is still a measurement, so it re-checks the EFFORT and ordered caps.
   */
  async correct(projectId: string, input: CorrectMeasurementInput, user: AuthUser, idempotencyKey?: string): Promise<MeasurementDto> {
    const target = await this.prisma.measurement.findFirst({
      where: { projectId, id: input.measurementId },
      select: { id: true, labourPoLineId: true, activityId: true, citedOutputId: true, correctsId: true },
    });
    if (!target) throw new NotFoundException('Measurement not found in this project');
    // Codex round-3 P1 — a correction adjusts an ORIGINAL measurement, never another correction.
    // Allowing chains makes the row-level floor unsound: with A ← +1 ← −1, a direct-children `netOf`
    // reads A as 2 while its real subtree is 1, so a −2 correction to A passes the floor and eats
    // another row's evidence. Keeping the tree ONE level deep is what makes "the row it adjusts"
    // a well-defined quantity — and it is also the identity §E's `(measurementId, consumedQty)`
    // freeze will name. Getting a correction wrong is corrected by a further delta on the SAME
    // original, which nets identically and leaves the tree flat.
    if (target.correctsId) {
      throw new ConflictException(
        'This row is itself a correction — address the correction to the original measurement it adjusts, so every delta names the work it walks back',
      );
    }
    return this.append(projectId, user, idempotencyKey, 'commercial.measurement.correct', input, {
      labourPoLineId: target.labourPoLineId,
      activityId: target.activityId,
      quantity: new Prisma.Decimal(input.quantity),
      correctsId: target.id,
      reason: input.reason,
      // the correction cites the SAME progress evidence as the row it adjusts: it is a restatement
      // of one measurement, not a new claim about different work
      citedOutputId: target.citedOutputId,
    });
  }

  private async append(
    projectId: string,
    user: AuthUser,
    idempotencyKey: string | undefined,
    commandType: 'commercial.measurement.take' | 'commercial.measurement.correct',
    input: TakeMeasurementInput | CorrectMeasurementInput,
    row: {
      labourPoLineId: string; activityId: string; quantity: Prisma.Decimal;
      correctsId: string | null; reason: string | null; citedOutputId?: string;
    },
  ): Promise<MeasurementDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertMeasure(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const citedOutputId = row.citedOutputId ?? (input as TakeMeasurementInput).citedOutputId;
    if (!citedOutputId) throw new ConflictException('A measurement must cite recorded work output');
    // A correction inherits nothing here: it is taken TODAY, on the day the practice decided the
    // earlier figure was wrong. Backdating a correction to the original's date would erase the
    // fact that the record changed after the event.
    //
    // TODAY is the PROJECT's civil day, not the server's UTC date (Codex round-1 P2). A site in
    // UTC+5:30 entering a measurement at 00:30 local is still on yesterday's UTC date, and the
    // billing evidence would carry a date the site never worked. `takenAt` records the instant;
    // `measuredOn` must record the SITE's day.
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId }, select: { timeZone: true },
    });
    const measuredOnIso = 'measuredOn' in input && input.measuredOn
      ? input.measuredOn
      : this.clock.today(project.timeZone);
    const measuredOn = fromIsoCivilDate(measuredOnIso);
    if (!measuredOn) throw new ConflictException(`"${measuredOnIso}" is not a civil date`);

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType, idempotencyKey, requestHash: hashRequest(input),
      // §C rule ii — every fact records the command that produced it, and `sourceCommandId` is a
      // NOT NULL composite FK. An unkeyed call therefore reserves a SERVER one-shot command (the
      // cleared Phase-3 inventory precedent); a keyed replay is unaffected and appends nothing.
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        // §A — serialize with the PO lifecycle before ANY of the reads below, so the ordered
        // authority and the effort this measurement is bounded by cannot move underneath it.
        await lockProjectReadiness(tx, projectId);

        // (1) the activity's sign-off, UNDER ITS ROW LOCK (§D — never a plain status query)
        const activity = await this.activities.measurableTarget(tx, { projectId, activityId: row.activityId });
        if (!activity) throw new NotFoundException('Activity not found in this project');
        if (activity.status !== 'done') {
          throw new ConflictException(
            `"${activity.name}" is ${activity.status} — measuring incomplete work for payment is exactly what the closing sign-off exists to prevent`,
          );
        }

        // (2) the OUTPUT predicate — progress evidence exists, and belongs to THIS activity
        const cited = await this.activities.workOutputBelongsToActivity(
          tx, { projectId, activityId: row.activityId, outputId: citedOutputId },
        );
        if (!cited) {
          throw new ConflictException(
            'A measurement must cite recorded work output for its own activity — without it a commercial actor authors the only quantity evidence in the chain',
          );
        }

        const [lines, effort] = await Promise.all([
          this.labour.committedLinesFor(tx, projectId, [row.labourPoLineId]),
          // Codex round-1 P1 — effort SCOPED to the activity being measured. Unscoped, a caller
          // could name a different signed-off activity with its own output, satisfy the sign-off
          // and evidence checks against THAT one, and have the quantity cap met by work done on an
          // activity nobody ever signed off.
          this.labour.effortForPoLines(tx, projectId, [row.labourPoLineId], row.activityId),
        ]);
        const line = lines.get(row.labourPoLineId);
        if (!line) throw new NotFoundException('Labour purchase-order line not found in this project');
        // Codex round-1 P1 — the live-line requirement gates NEW measurement, never a REDUCING
        // correction. `assertWorkEvidenceRevisable` tells an operator to correct a measurement to
        // zero before withdrawing a sign-off; if the line had since been amended or cancelled, an
        // unconditional check made that correction impossible and left the activity permanently
        // stuck on evidence it was being told to withdraw. Reducing recorded work is always
        // permitted — it can only ever make a claim smaller.
        if (!line.live && row.quantity.greaterThan(0)) {
          throw new ConflictException('This labour purchase-order line is not live — a dead order cannot be measured against');
        }

        const before = await this.measuredFor(tx, projectId, row.labourPoLineId);
        const after = before.add(row.quantity);

        // §0 — the fold may never go NEGATIVE.
        if (after.isNegative()) {
          throw new ConflictException(
            `This correction would take measured work to ${after.toString()} person-shifts; ${before.toString()} were measured and a negative total is not a record of anything`,
          );
        }
        // Phase 5 Task 4 (§D) — and it may never fall below what a live CERTIFIED claim has
        // already consumed. Withdrawing measured work a certificate rests on requires superseding
        // that certificate first, the same ordering §E requires for accepted material.
        //
        // At the Task-4 tree this set is EMPTY by construction — `certified` is unreachable until
        // Task 5 ships the §E verdict — so the arm cannot fire here and is written over the status
        // set rather than hardcoded, so Task 5 adds the certificate WITHOUT re-deriving the floor.
        if (row.quantity.isNegative()) {
          const certified = await this.bills.certifiedBilledQtyFor(tx, projectId, row.labourPoLineId);
          if (after.lessThan(certified)) {
            throw new ConflictException(
              `This correction would take measured work to ${after.toString()} person-shifts while certified claims consume ${certified.toString()} — supersede the certificate before withdrawing the evidence it rests on`,
            );
          }
        }
        // Codex round-1 P1 — a correction is bounded by the ROW IT ADJUSTS, not merely by the
        // line's aggregate. The aggregate alone lets one row's correction eat another's evidence:
        // measure A = 1 and B = 1, then correct A by −2 and the line total is a perfectly legal 0
        // while B's payable evidence has been wiped from the fold with nothing naming or
        // justifying a correction to B.
        //
        // This is the same row-level identity §E's consumption freeze depends on — a certificate
        // records `(measurementId, consumedQty)`, so a row whose net contribution can be driven
        // negative by an unrelated correction makes that freeze unresolvable. Correcting B is a
        // real operation with a real path: address a correction TO B.
        if (row.correctsId && row.quantity.isNegative()) {
          const net = await this.netOf(tx, projectId, row.correctsId);
          const remaining = net.add(row.quantity);
          if (remaining.isNegative()) {
            throw new ConflictException(
              `Measurement ${row.correctsId} has ${net.toString()} person-shifts left to withdraw, and this correction withdraws ${row.quantity.abs().toString()} — correct the other measurements on this line individually so each reduction names the work it walks back`,
            );
          }
        }
        if (row.quantity.greaterThan(0)) {
          // (3) the EFFORT cap — worked minutes normalised to person-shifts, joined to THIS line
          const available = effort.get(row.labourPoLineId) ?? ZERO;
          if (after.greaterThan(available)) {
            throw new ConflictException(
              `Measuring ${row.quantity.toString()} would total ${after.toString()} person-shifts, but only ${available.toString()} of worked effort is attributable to this line`,
            );
          }
          // (4) the ORDERED authority cap
          // Codex round-1 P1 — the cap is the line's LIVE authority, not its frozen ordered
          // quantity. A DEFAULTED commitment authorises nothing even while the version is still
          // `issued`: the source reneged and the line can never be re-committed, so measuring its
          // historical effort would move money into received-not-billed for shifts no live order
          // covers. A closed-short version authorises only what was committed.
          if (after.greaterThan(new Prisma.Decimal(line.liveAuthority))) {
            throw new ConflictException(
              line.defaulted
                ? `This line's supplier commitment was DEFAULTED, so it authorises no work — measuring ${row.quantity.toString()} person-shifts against it would bill for an order nobody owes`
                : `Measuring ${row.quantity.toString()} would total ${after.toString()} person-shifts against a live authority of ${line.liveAuthority} — amend the purchase order to authorise more work before measuring it`,
            );
          }
        }

        const created = await tx.measurement.create({
          data: {
            projectId,
            labourPoLineId: row.labourPoLineId,
            activityId: row.activityId,
            quantity: row.quantity,
            correctsId: row.correctsId,
            reason: row.reason,
            measuredOn,
            citedOutputId,
            evidenceMediaId: 'evidenceMediaId' in input ? input.evidenceMediaId ?? null : null,
            takenById: actor.actorId,
            sourceCommandId: ctx.commandId!,
          },
          // Codex round-3 P2 — a stale or cross-project photo is a BAD REQUEST, not an internal
          // error. The composite FK is the authority (the cleared attendance-evidence precedent),
          // and this translates its P2003 to the same 400 every other media-citing path returns
          // rather than letting a plainly bad request surface as a 500 mid-transaction.
        }).catch((e) => rethrowMediaRefViolation(e));
        await recordAudit(tx, {
          projectId, actor, action: commandType, entity: 'Measurement', entityId: created.id,
        });
        // Phase 5 Task 4 (§D/§G) — a REDUCING correction withdraws billing evidence, so live
        // uncertified claims above the new total are disputed here, in the SAME transaction. The
        // participant is asked with the POST-correction fold: the guard is about the state this
        // transaction is committing, not the one it started from. The deferred DB bound seal then
        // aborts the whole transaction if the disposition left the bound broken.
        if (row.quantity.isNegative()) {
          await this.participant.assertMeasurementWithdrawable(
            tx, projectId, row.labourPoLineId, after, { actorId: actor.actorId, role: user.role },
          );
        }
        // §B — MEASURED is a `COMMITTED` fold input, so this write is a headroom mover and
        // re-evaluates in its own transaction. As the arithmetic stands it is exposure-NEUTRAL
        // (measurement is hard-capped at the ordered quantity, so the money only changes bucket),
        // but the rule is mechanical and the evaluation is idempotent — one OPEN exception per
        // head is a partial unique. See `commercial.contract.test.ts` FOLD_INPUTS.
        await this.participant.evaluateForTarget(
          tx, projectId, { actorId: actor.actorId, role: user.role },
          { labourPoLineId: row.labourPoLineId }, 'measurement',
        );
        return { resultRef: created.id, events: [] };
      },
    });

    const created = await this.prisma.measurement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return serialize(created);
  }

  /** §D — the register for ONE labour PO line, with the fold and both caps it is measured against. */
  async read(projectId: string, labourPoLineId: string, user: AuthUser): Promise<MeasurementRegisterDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    return this.prisma.$transaction(async (tx) => {
      const [rows, lines, effort] = await Promise.all([
        tx.measurement.findMany({ where: { projectId, labourPoLineId }, orderBy: { takenAt: 'asc' } }),
        this.labour.committedLinesFor(tx, projectId, [labourPoLineId]),
        this.labour.effortForPoLines(tx, projectId, [labourPoLineId]),
      ]);
      const line = lines.get(labourPoLineId);
      if (!line) throw new NotFoundException('Labour purchase-order line not found in this project');
      return {
        labourPoLineId,
        rows: rows.map(serialize),
        measured: rows.reduce((acc, r) => acc.add(r.quantity), ZERO).toString(),
        effort: (effort.get(labourPoLineId) ?? ZERO).toString(),
        orderedPersonShiftQty: line.personShiftQty,
        // Codex round-4 P2 — the register must state the authority the line CURRENTLY carries, not
        // only the quantity frozen at issue. The write path caps by `liveAuthority`, so reporting
        // the frozen order alone published a cap that was not real.
        liveAuthorityPersonShiftQty: line.liveAuthority,
        defaulted: line.defaulted,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
