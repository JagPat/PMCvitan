import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { recordAudit } from '../platform/audit';
import { executeCommand, hashRequest } from '../platform/commands';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';

export interface MergePartiesResult {
  survivingPartyId: string;
  absorbedPartyId: string;
  /** The absorbed party's name, captured under the lock BEFORE its row is deleted — after the
   *  merge there is nowhere else to read it, and "which firm name was folded away" is the part of
   *  the operator's judgement a reader will actually need. */
  absorbedName: string;
  repointed: { companies: number; vendors: number; associations: number };
}

/**
 * Phase 6 unit 6.1b (§A) — the operator MERGE/REPOINT command.
 *
 * 6.1a deliberately created one party per existing row and merged NOTHING, because deciding that
 * two rows are the same firm is a human judgement a migration must not fabricate. The cost of that
 * correctness is that a firm which is both a `Vendor` and a `ProjectCompany` currently has TWO
 * canonical identities, and a grant bound to one cannot prove ownership of rows linked to the
 * other — so a firm-wide revocation would reach half the real firm. This command is where the
 * operator records that judgement, and it ships in 6.1 rather than "later" precisely so the
 * canonical identity is reachable before anything relies on it.
 *
 * What it still does NOT do is decide which rows are one firm. That stays with the operator.
 */
@Injectable()
export class PartyMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly procurement: ProcurementParticipant,
  ) {}

  async merge(
    orgId: string,
    input: { survivingPartyId: string; absorbedPartyId: string },
    user: AuthUser,
    idempotencyKey?: string,
  ): Promise<MergePartiesResult> {
    const { survivingPartyId, absorbedPartyId } = input;
    if (survivingPartyId === absorbedPartyId) {
      throw new BadRequestException('A party cannot be merged into itself');
    }

    const actor = await resolveActor(this.prisma, user);
    const outcome = await executeCommand(this.prisma, {
      scope: { scopeKind: 'org', organizationId: orgId }, actor,
      commandType: 'orgs.party.merge',
      idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        // Authority is checked INSIDE the transaction, against a LOCKED membership row. Read on the
        // top-level client beforehand it is a promise about a moment that has already passed: T1
        // reads owner/admin, T2 revokes or downgrades that same `OrgMembership` and commits, and T1
        // then deletes and repoints firm identity as a user who is no longer an admin. Nothing T1
        // read was wrong; it was read too early. That is the same error 6.1a's E3 named one command
        // over — a check whose inputs were taken outside the transaction that protects them.
        //
        // Taken FIRST, before the party roots, so the order is global: membership → party → origins.
        await this.assertOrgAdmin(tx, orgId, user);
        const result = await this.runMerge(tx, orgId, survivingPartyId, absorbedPartyId);
        // `projectId: null` is the honest value, not a gap: a party is org-scoped and this merge
        // moves rows across every project the firm reaches, so no single project owns the act.
        // The operator's judgement — WHICH identity absorbed which, and how much moved — is the
        // fact worth keeping, and it is kept here rather than in a tombstone row.
        await recordAudit(tx, {
          projectId: null, actor, action: 'party.merge',
          entity: 'ExternalParty', entityId: survivingPartyId,
          payload: { orgId, absorbedPartyId, absorbedName: result.absorbedName, ...result.repointed },
        });
        return { resultRef: survivingPartyId, value: result, events: [] };
      },
    });
    // A keyed REPLAY returns `resultRef` with `value: undefined` — the transaction did not run
    // again, so there is no fresh result to hand back. Casting the undefined would have returned it
    // as if it were the documented shape. The merge's own audit row already records everything the
    // caller is owed, including the absorbed party's NAME, which is unreadable by then because the
    // row is gone: so a replay re-reads the recorded fact rather than fabricating or omitting it.
    if (outcome.replayed) return this.recordedMerge(orgId, survivingPartyId, absorbedPartyId);
    return outcome.value as MergePartiesResult;
  }

  /** Rebuild a completed merge's result from the audit row it wrote. */
  private async recordedMerge(
    orgId: string,
    survivingPartyId: string,
    absorbedPartyId: string,
  ): Promise<MergePartiesResult> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        action: 'party.merge', entity: 'ExternalParty', entityId: survivingPartyId,
        AND: [
          { payload: { path: ['orgId'], equals: orgId } },
          { payload: { path: ['absorbedPartyId'], equals: absorbedPartyId } },
        ],
      },
      orderBy: { at: 'desc' },
    });
    if (!row) {
      // The receipt says this merge committed, so its audit row committed in the same transaction.
      // Missing means the two disagree, which is a fact worth surfacing rather than papering over
      // with a plausible-looking reconstruction.
      throw new ConflictException(
        'This merge has a completed receipt but no audit record — the two disagree, so the result '
          + 'cannot be reported truthfully. Investigate before retrying.',
      );
    }
    const p = row.payload as { absorbedName?: string; companies?: number; vendors?: number; associations?: number };
    return {
      survivingPartyId,
      absorbedPartyId,
      absorbedName: p.absorbedName ?? '',
      repointed: { companies: p.companies ?? 0, vendors: p.vendors ?? 0, associations: p.associations ?? 0 },
    };
  }

  private async runMerge(
    tx: Prisma.TransactionClient,
    orgId: string,
    survivingPartyId: string,
    absorbedPartyId: string,
  ): Promise<MergePartiesResult> {
    // ── 1. LOCK BOTH ROOTS, IN ASCENDING `id` ORDER, BEFORE READING ANY REFERENCE ────────────
    //
    // One transaction is NOT enough on its own, and this is the defect the lock exists for. With
    // party A on a `Vendor` and party B on a `ProjectCompany`, an operator running A→B and another
    // running B→A touch DISJOINT initial row sets: neither blocks the other, both commit, and the
    // duplicate firm has been reconciled into a different duplicate — the vendor now on B, the
    // company now on A. Nothing either transaction read was wrong; they simply never met.
    //
    // Locking both roots makes them meet. The ASCENDING order is what makes it deadlock-free: two
    // transactions naming the same pair in opposite directions would otherwise each hold the row
    // the other wants. This is the same stable-ascending-lock guardrail Phase 4 used for crew
    // expansion, and it carries the same obligation — a barrier probe that has been SEEN to fail,
    // not a lock applied on reasoning alone (6.1a's C7 is the cautionary case).
    const [first, second] = [survivingPartyId, absorbedPartyId].sort();
    const locked = await tx.$queryRaw<Array<{ id: string; orgId: string; name: string; promotedOrgId: string | null }>>`
      SELECT "id", "orgId", "name", "promotedOrgId" FROM "ExternalParty"
       WHERE "id" IN (${first}, ${second})
       ORDER BY "id"
       FOR UPDATE`;

    const surviving = locked.find((p) => p.id === survivingPartyId);
    const absorbed = locked.find((p) => p.id === absorbedPartyId);
    if (!surviving || !absorbed) throw new NotFoundException('Party not found');

    // ── 2. REFUSALS, all evaluated against the LOCKED rows ───────────────────────────────────
    //
    // Scoped to the PARTY (org-wide), never to a project the operator happens to name: a party is
    // org-scoped, and 6.1a's D1 was exactly this error one command over — a project-scoped count
    // renaming a firm another project depended on.
    if (surviving.orgId !== orgId || absorbed.orgId !== orgId) {
      throw new ForbiddenException('Both parties must belong to this organisation');
    }
    // §E — the promotion seam. `promotedOrgId` is the stable link to a future tenant and the merge
    // OUTLIVES this unit. Merging a promoted party either strands that link on an identity which no
    // longer owns the vendor/company references, or moves a TENANT relationship as a side effect of
    // data cleanup. Both are authority decisions disguised as housekeeping, so neither is allowed.
    for (const p of [surviving, absorbed]) {
      if (p.promotedOrgId !== null) {
        throw new ConflictException(
          `Party ${p.id} is promoted to a tenant organisation and cannot be merged — resolve the promotion first`,
        );
      }
    }

    // ── 3. THE SAME-PROJECT COLLISION, decided BEFORE anything moves ─────────────────────────
    //
    // `ProjectCompany` and `ProjectVendor` each carry a unique `(projectId, partyId)`, so two
    // directory rows (or two bindings) for one party on one project are unrepresentable. That seal
    // is what turns this from an undesirable outcome into a refusal — but PostgreSQL would surface
    // it as an opaque unique violation partway through the repoint, naming an index rather than the
    // decision the operator has to make. So the collision is detected here, while nothing has moved,
    // and reported in the operator's vocabulary.
    const collisions = await this.collidingProjects(tx, orgId, survivingPartyId, absorbedPartyId);
    if (collisions.length > 0) {
      throw new ConflictException(
        `Both parties are already present on ${collisions.length === 1 ? 'project' : 'projects'} `
          + `${collisions.join(', ')}. Merging would put two records of one firm on the same project, `
          + 'which the (projectId, partyId) seal forbids. Remove or repoint the duplicate rows on '
          + 'those projects first, then merge.',
      );
    }

    // ── 4. ENSURE THE SURVIVOR'S ASSOCIATION EXISTS ON EVERY PROJECT THE ABSORBED PARTY REACHES ─
    //
    // Order is forced by the FKs, which are NOT deferrable. `ProjectPartyCompanySource` carries
    // BOTH `(projectId, partyId) → ProjectParty` and `(orgId, projectId, partyId, projectCompanyId)
    // → ProjectCompany`, and the origin FK cascades on update. So moving `ProjectCompany.partyId`
    // drags the source row's `partyId` with it, and at that instant the source must already find a
    // `ProjectParty` row for the SURVIVING party — or the association FK rejects the statement
    // mid-transaction. Creating the associations first is what makes step 5 legal.
    const absorbedProjects = await this.projectsReached(tx, orgId, absorbedPartyId);
    for (const projectId of absorbedProjects) {
      await tx.projectParty.upsert({
        where: { projectId_partyId: { projectId, partyId: survivingPartyId } },
        create: { orgId, projectId, partyId: survivingPartyId },
        update: {},
      });
    }

    // ── 5. REPOINT EVERY COPY ────────────────────────────────────────────────────────────────
    //
    // The list is `Vendor`, `ProjectVendor`, `ProjectCompany`, `ProjectParty` and both source
    // tables — anything not repointed becomes a stranded reference. Two statements cover five of
    // them, because the ON UPDATE CASCADE chains do the rest:
    //
    //   ProjectCompany.partyId → ProjectPartyCompanySource.partyId
    //   Vendor.partyId → ProjectVendor.partyId → ProjectPartyVendorSource.partyId
    //
    // `Vendor` is procurement-owned, so it moves through the participant rather than a direct write.
    const { count: companies } = await tx.projectCompany.updateMany({
      where: { orgId, partyId: absorbedPartyId },
      data: { partyId: survivingPartyId },
    });
    const { vendors } = await this.procurement.repointVendorParty(tx, {
      orgId, fromPartyId: absorbedPartyId, toPartyId: survivingPartyId,
    });

    // ── 6. DROP THE ABSORBED ASSOCIATIONS — REQUIRED, NOT CLEANUP ────────────────────────────
    //
    // The cascaded source updates in step 5 fire `phase6_project_party_sourced` with TG_OP=UPDATE,
    // which targets the association the source LEFT (OLD = the absorbed party) and refuses if that
    // association still exists with zero sources. It only passes because that trigger is
    // DEFERRABLE INITIALLY DEFERRED and these rows are gone by COMMIT. In other words the seal C4
    // added in 6.1a is what obliges the merge to tidy up after itself, and skipping this line does
    // not leave a stranded association — it aborts the whole merge at commit.
    const { count: associations } = await tx.projectParty.deleteMany({
      where: { orgId, partyId: absorbedPartyId },
    });

    // ── 7. THE ABSORBED IDENTITY ITSELF ──────────────────────────────────────────────────────
    //
    // Deleted rather than tombstoned. It now has no references by construction (steps 5 and 6 moved
    // every one, and `ExternalParty` has no other referent in this phase), and a retained empty
    // identity is a row a later surface can still resolve, grant against, or merge a second time.
    // The operator's judgement is preserved in the audit record, which names both ids — that is the
    // attributable fact worth keeping, not an orphaned party row.
    await tx.externalParty.delete({ where: { id: absorbedPartyId } });

    return {
      survivingPartyId,
      absorbedPartyId,
      absorbedName: absorbed.name,
      repointed: { companies, vendors, associations },
    };
  }

  /** The projects an absorbed party reaches through EITHER origin kind. */
  private async projectsReached(
    tx: Prisma.TransactionClient,
    orgId: string,
    partyId: string,
  ): Promise<string[]> {
    const [associations, bound] = await Promise.all([
      tx.projectParty.findMany({ where: { orgId, partyId }, select: { projectId: true } }),
      this.procurement.projectsBoundToParty(tx, orgId, partyId),
    ]);
    return [...new Set([...associations.map((a) => a.projectId), ...bound])];
  }

  /**
   * Projects where BOTH parties already hold a directory row or a binding — the states the
   * `(projectId, partyId)` uniques make unrepresentable once the repoint lands.
   */
  private async collidingProjects(
    tx: Prisma.TransactionClient,
    orgId: string,
    survivingPartyId: string,
    absorbedPartyId: string,
  ): Promise<string[]> {
    const [survivingCompanies, absorbedCompanies, survivingBound, absorbedBound] = await Promise.all([
      tx.projectCompany.findMany({ where: { orgId, partyId: survivingPartyId }, select: { projectId: true } }),
      tx.projectCompany.findMany({ where: { orgId, partyId: absorbedPartyId }, select: { projectId: true } }),
      this.procurement.projectsBoundToParty(tx, orgId, survivingPartyId),
      this.procurement.projectsBoundToParty(tx, orgId, absorbedPartyId),
    ]);
    const companyClash = intersect(survivingCompanies.map((c) => c.projectId), absorbedCompanies.map((c) => c.projectId));
    const vendorClash = intersect(survivingBound, absorbedBound);
    return [...new Set([...companyClash, ...vendorClash])].sort();
  }

  /**
   * The caller's org standing, read UNDER A ROW LOCK inside the merge's own transaction. A
   * concurrent `orgs.removeOrgMember` or `orgs.updateOrgMemberRole` on this same membership now
   * blocks here until the merge commits or rolls back, instead of slipping between the check and
   * the repoint.
   */
  private async assertOrgAdmin(tx: Prisma.TransactionClient, orgId: string, user: AuthUser): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ role: string }>>`
      SELECT "role" FROM "OrgMembership"
       WHERE "orgId" = ${orgId} AND "userId" = ${user.sub}
       FOR UPDATE`;
    const role = rows[0]?.role;
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Merging firm identities is an org owner/admin action');
    }
  }
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}
