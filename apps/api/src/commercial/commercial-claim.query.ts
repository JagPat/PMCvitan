import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY, type CertifyPreflightDto, type CommercialClaimDto, type MeasurementRegisterDto, type VendorBillDto } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialBillService } from './commercial-bill.service';
import { CommercialVerificationService } from './commercial-verification.service';
import { CommercialCertificationService } from './commercial-certification.service';
import { CommercialDeductionService } from './commercial-deduction.service';
import { CommercialPaymentService } from './commercial-payment.service';
import { CommercialMeasurementService } from './commercial-measurement.service';

/**
 * Phase 5 Task 7B-ii (§M) — ONE CLAIM'S WHOLE LIFECYCLE, from one repeatable-read transaction.
 *
 * The §M hub's claim page is the accountant's workflow: the claim and its versions (§D/§F), the §E
 * verification triple, the live §E certificate, the §H deduction ledger with its `NET_PAYABLE`, the
 * §G approvals and payments, and the §D measurement register behind each labour line it bills.
 *
 * Assembled from six HTTP reads that page contradicts itself, and not hypothetically: `approvable`
 * is derived from the deduction ledger's `netPayable`, so a release or a recovery committing
 * between the two makes the screen state a payable and an approvable that were never true
 * together. Every one of those reads ALREADY opens a repeatable-read snapshot for precisely this
 * reason at its own level — `commercial.payments` carries the comment spelling it out. This class
 * is that rule applied one layer up, which is the move `commercial.money-position` made for the
 * §B/§C/§J page one tab over.
 *
 * WHY A SEPARATE CLASS. `CommercialBillService` owns the claim and would be the natural home, but
 * the verification, certification and deduction services all inject IT — assembling here would
 * close a Nest dependency cycle. This class is injected by nothing but the controller, so the graph
 * stays acyclic, and it composes the `...In(tx, …)` helpers those services own rather than
 * re-deriving anything: no fold, no predicate and no serializer is written twice.
 */
@Injectable()
export class CommercialClaimQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly bills: CommercialBillService,
    private readonly verification: CommercialVerificationService,
    private readonly certification: CommercialCertificationService,
    private readonly deductions: CommercialDeductionService,
    private readonly payments: CommercialPaymentService,
    private readonly measurements: CommercialMeasurementService,
  ) {}

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  async readClaim(projectId: string, billId: string, user: AuthUser): Promise<CommercialClaimDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);

    return this.prisma.$transaction(async (tx) => {
      // The bill FIRST: it is the one read that decides whether this claim exists at all, and every
      // helper below would otherwise raise its own not-found with its own wording for the same
      // missing row.
      const bill = await this.bills.billIn(tx, projectId, billId);
      const [verification, certificate, deductions, payments] = await Promise.all([
        this.verification.verificationIn(tx, projectId, billId),
        this.certification.liveCertificateIn(tx, projectId, billId),
        this.deductions.deductionLedgerIn(tx, projectId, billId),
        this.payments.paymentLedgerIn(tx, projectId, billId),
      ]);

      // §D — the measured evidence behind the LABOUR lines this claim CURRENTLY bills.
      //
      // The source is the version the serializer marks `live`, NOT the highest-numbered one. Those
      // are different: `live` is `supersededAt === null && isLiveBillStatus(status)`, so a DISPUTED
      // or REJECTED claim has no live version at all, and its top version's lines are in no fold.
      // Reading `versions.at(-1)` would present those registers as "what this claim measures",
      // which is a stronger statement than the data supports — and the flag exists precisely
      // because liveness is not derivable from position. A claim with no live version therefore
      // reports no measurements; its full version history is carried above for anyone
      // investigating why it stopped being live.
      //
      // Material lines carry no measurement — their evidence is accepted stock, which the §E
      // verification triple above already reports — so a material-only claim yields an empty map
      // rather than a set of empty registers that would read as "measured nothing" instead of
      // "measurement does not apply".
      const labourLineIds = labourLinesOfLiveVersion(bill);
      const registers = await Promise.all(
        labourLineIds.map(async (id) => [id, await this.measurements.registerIn(tx, projectId, id)] as const),
      );
      const measurements: Record<string, MeasurementRegisterDto> = {};
      for (const [id, register] of registers) measurements[id] = register;

      // §I — the CALLER'S own authorisation state on this claim's live version, resolved by the
      // same `resolveGrant` the certification command uses. Read WITHOUT `FOR UPDATE`: a screen is
      // asking what is true now and holds nothing, while a certification is an authority decision
      // and locks. Same predicate, different intent — which is why the lock is a parameter rather
      // than a second function.
      //
      // The live version is the one the grant is pinned to. A claim with NO live version (disputed,
      // rejected) cannot be certified at all, so there is nothing to authorise and `none` is the
      // honest answer rather than a lookup against a version the claim has moved past.
      const liveVersionId = bill.versions.find((v) => v.live)?.id ?? null;
      // Codex F2 — `user.sub` IS the actor id, so the old `resolveActor` call bought nothing but a
      // `user.findUnique` on the ROOT client while this transaction holds its own connection: a
      // read outside the snapshot this method exists to assemble, and a second checkout that can
      // self-block on a saturated pool. `resolveActor` resolves a display NAME, which no part of
      // this answer uses.
      // §I — the claim REVISION this bundle was read at, from the SAME repeatable-read snapshot as
      // everything else here, so what a reader echoes belongs with the figures beside it.
      const claimNow = await tx.vendorBill.findFirst({
        where: { projectId, id: billId }, select: { status: true, lifecycleVersion: true },
      });
      const asOf = { status: claimNow?.status ?? '', lifecycleVersion: claimNow?.lifecycleVersion ?? 0 };
      const resolved = liveVersionId === null
        ? ({ state: 'none' } as const)
        : await this.certification.resolveGrant(tx, projectId, billId, liveVersionId, user.sub, false, asOf);
      const certifyPreflight: CertifyPreflightDto = {
        grantState: resolved.state,
        grantId: resolved.state === 'live' ? resolved.grant.id : null,
        callerActorId: user.sub,
        // published so an authorisation can pin WHICH passage of the claim its approver saw —
        // neither the version nor the status can carry that, because both are re-enterable
        lifecycleVersion: asOf.lifecycleVersion,
      };

      return {
        bill, verification, certificate, deductions, payments, measurements,
        certifyPreflight,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}

/**
 * The labour PO lines whose §D register belongs to THIS claim, deduplicated and ordered.
 *
 * Exported and pure because the rule it encodes is the one this class got WRONG first: the source is
 * the version the serializer marks `live`, not the highest-numbered one. Those differ —
 * `live` is `supersededAt === null && isLiveBillStatus(status)`, so a DISPUTED or REJECTED claim has
 * NO live version and its top version's lines sit in no fold. `versions.at(-1)` would present those
 * registers as "what this claim measures", a stronger statement than the data supports.
 *
 * It is a separate function so that rule can be tested against a claim that actually HAS labour
 * lines on a non-live version. The live-PG fixture for this suite bills material only, so the
 * integration probe covering the same code path passes whichever version it picks — it would have
 * ratified the bug. A pure function over the DTO tests the distinction itself.
 */
export function labourLinesOfLiveVersion(bill: VendorBillDto): string[] {
  const live = bill.versions.find((v) => v.live);
  return [...new Set(
    (live?.lines ?? [])
      .filter((l) => l.type === 'labour' && l.labourPoLineId !== null)
      .map((l) => l.labourPoLineId as string),
  )].sort();
}
