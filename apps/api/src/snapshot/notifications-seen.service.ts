import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import type { AuthUser } from '../common/auth';
import { readViewerFeed, servedNotifications } from './served-notifications';

/**
 * Top 10 #4b unit C (#778) — the bell's "seen" mark: `POST /projects/:projectId/notifications/seen`.
 *
 * The contract (owner record #482 6110925123, carrying proposal revisions 2–4):
 *
 * - **Who.** The viewer is the verified token (`sub`, `role`); the body carries notice ids only. A
 *   worker device token holds no `User` row and is never served the feed, so it confirms nothing.
 * - **Eligibility.** The submitted ids that unit B's shared definition serves to this viewer, judged
 *   at ONE named REPEATABLE READ snapshot of the feed and the decision slice (`readViewerFeed`).
 *   That is historical evidence — "served, and then seen" — not a promise that the notice is still
 *   visible when the write commits: a notice hidden after that read may still receive its receipt.
 * - **Durability.** The receipts are written in a separate READ COMMITTED transaction, and the
 *   response is sent only after it commits. `confirmed` lists exactly the submitted eligible ids that
 *   hold a durable receipt for this viewer at that commit.
 * - **No oracle.** An id that is hidden, foreign, unknown or deleted at the eligibility read is
 *   simply absent from `confirmed`, identically. An earlier receipt for an id that is hidden at the
 *   read does not confirm it.
 * - **Standing, under the established lock order.** The write locks the viewer's `OrgUserAuthority`
 *   row for the project's org, then their `ProjectUserStanding` rows, FOR SHARE (the actor envelope's
 *   order, `platform/actor-envelope.ts`), then the project row through `phase6_project_operable`, and
 *   requires `platform_user_holds_role_windowed(project, sub, token role)`. A concurrent removal,
 *   demotion, re-role or archive therefore either waits for this commit (the viewer was authorized at
 *   it) or committed first and the mark is refused 403. A phantom grant (a membership granted to a
 *   membership-less org admin) reads nothing this writes, so a mark that did not see it is validly
 *   ordered before it. The receipt table's own BEFORE INSERT trigger re-checks standing as a backstop.
 * - **Notice rows are locked FOR KEY SHARE after the project**, so a concurrent delete either waits for
 *   this commit (and cascades the receipt) or committed first (and the id is not inserted). Project
 *   before notice is the receipt INSERT's own order: its BEFORE trigger's operability check runs
 *   before the foreign-key check takes the notice row.
 * - **Failure.** A serialization failure or deadlock is retried once internally, then answered 409;
 *   no standing 403; a malformed or oversized body 400 (the controller's schema). Every refusal
 *   rolls the whole write back, so it confirms and records nothing.
 * - **Convergence.** `createMany` with `skipDuplicates` (`INSERT … ON CONFLICT DO NOTHING`): a retry, a double tap or two tabs converge on
 *   one receipt per (notice, viewer).
 */
@Injectable()
export class NotificationsSeenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly decisionsQuery: DecisionsQueryService,
  ) {}

  async markSeen(projectId: string, user: AuthUser, ids: readonly string[]): Promise<{ confirmed: string[] }> {
    if (user.worker) return { confirmed: [] };
    const submitted = [...new Set(ids)];

    // eligibility, at the named REPEATABLE READ snapshot of the feed and the decision slice
    const read = await readViewerFeed(this.prisma, this.decisionsQuery, projectId, user.role, user.sub);
    const served = new Set(servedNotifications(read, user.role, user.sub, this.decisionsQuery).map((n) => n.id));
    const eligible = submitted.filter((id) => served.has(id));

    for (let attempt = 0; ; attempt += 1) {
      try {
        const confirmed = await this.prisma.$transaction(
          (tx) => this.write(tx, projectId, user, eligible),
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 30_000 },
        );
        return { confirmed };
      } catch (error) {
        if (!isRetryableWriteFailure(error)) throw error;
        if (attempt >= 1) throw new ConflictException('The notices could not be marked seen; try again');
      }
    }
  }

  /** The READ COMMITTED write: standing under the lock order, then the receipts, then what is durable. */
  private async write(tx: Prisma.TransactionClient, projectId: string, user: AuthUser, eligible: readonly string[]): Promise<string[]> {
    // OrgUserAuthority BEFORE ProjectUserStanding: the OrgMembership projection writers' order
    await tx.$queryRaw(Prisma.sql`
      SELECT 1 FROM "OrgUserAuthority" a
        JOIN "ProjectOrg" po ON po."orgId" = a."orgId"
       WHERE po."projectId" = ${projectId} AND a."userId" = ${user.sub}
         FOR SHARE OF a`);
    await tx.$queryRaw(Prisma.sql`
      SELECT 1 FROM "ProjectUserStanding"
       WHERE "projectId" = ${projectId} AND "userId" = ${user.sub}
         FOR SHARE`);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean; holds: boolean }>>(Prisma.sql`
      SELECT phase6_project_operable(${projectId}) AS "operable",
             platform_user_holds_role_windowed(${projectId}, ${user.sub}, ${user.role}) AS "holds"`);
    if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
    if (state?.holds !== true) throw new ForbiddenException('Project access has been removed');
    if (eligible.length === 0) return [];

    // the notices that still exist, held against a concurrent delete until this commits
    const present = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Notification"
       WHERE "projectId" = ${projectId} AND "id" IN (${Prisma.join(eligible)})
         FOR KEY SHARE`);
    if (present.length > 0) {
      // INSERT … ON CONFLICT DO NOTHING
      await tx.notificationReceipt.createMany({
        data: present.map((r) => ({ notificationId: r.id, userId: user.sub, projectId })),
        skipDuplicates: true,
      });
    }
    const durable = await tx.notificationReceipt.findMany({
      where: { projectId, userId: user.sub, notificationId: { in: [...eligible] } },
      select: { notificationId: true },
    });
    const held = new Set(durable.map((r) => r.notificationId));
    return eligible.filter((id) => held.has(id));
  }
}

/** A serialization failure or deadlock, through Prisma's transaction or a raw statement's SQLSTATE. */
export function isRetryableWriteFailure(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return error.code === 'P2010' && (code === '40001' || code === '40P01');
}
