import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectTree } from '../common/tree-lock';
import { lockProjectReadiness } from '../common/readiness-lock';
import type { AuthUser } from '../common/auth';
import { resolveActor, type Actor } from '../common/actor';
import { emitEvent } from '../platform/events';
import { lockActorStanding, resolveActorEnvelope, type ActorEnvelope } from '../platform/actor-envelope';
import { executeCommand, hashRequest, peekReplay, type CommandScope, type CommandTx } from '../platform/commands';
import type { CloseSiteVisitInput, EndSiteVisitInput, StartSiteVisitInput } from '../contracts';
import { SiteVisitsQueryService, type SiteVisitDto } from './site-visits.query';
import { SITE_VISIT_NOTICE_COLOR, siteVisitClosedNotice, siteVisitEndedNotice, siteVisitStartedNotice } from './site-visit-notice';

/** The visit row a later act reads, locked. */
interface LockedVisit {
  id: string;
  visitorId: string;
  visitorName: string;
  visitorRole: string;
  status: string;
  lateEndClaimedAt: Date | null;
}

/**
 * Site Visits SV1-b (#792) — the commands that write a visit: start, end (or, after a PMC's close, the visitor's late
 * end) and close. PostgreSQL enforces every rule on the record (SV1-a); this service asks the same questions first so
 * a refusal is a clear 4xx, and takes the locks in ONE order so two valid acts never deadlock:
 *
 *   the project's readiness lock → the visit row (an act on an existing visit) → the project tree (a start that names
 *   a place) → the node → OrgUserAuthority → ProjectUserStanding → the project row → UserIdentity → the event stream.
 *
 * - The readiness lock first, the protocol every membership change and archive already follows
 *   (`readiness-lock.ts`). A membership command locks its actor's identity and only then the project row (its
 *   transition seal's operability check), the reverse of the order below; holding the readiness lock first, the two
 *   never interleave (#834, Codex 4260951386). No node writer takes the readiness lock, so it cannot meet the tree
 *   lock in the other order.
 * - The visit row next: every child write (SV1-b's next unit) locks it before its standing, as SV1-a's triggers do.
 * - The tree lock before the node (#834, Codex 4260951368): every node writer (create, rename, move, remove) takes
 *   the project's tree lock first and the actor's identity later, at its event. A start that locked the identity and
 *   then waited on the node it names deadlocked against the same PMC removing that node. Under the tree lock the two
 *   serialize: the removal commits first (the start is refused, the place is gone) or waits for the start.
 * - The registers, the project row, then the identity: the actor envelope's order with the project row before the
 *   identity, as an archive and the envelope seal take them (SV1-a, V2).
 */
@Injectable()
export class SiteVisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: SiteVisitsQueryService,
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /** Start a visit (the PMC or a consultant, D5/Q3). One open visit per visitor per project (S2). */
  async start(projectId: string, dto: StartSiteVisitInput, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest(dto);
    if (await peekReplay(this.prisma, scope, actor.actorId, 'site-visits.start', idempotencyKey, requestHash)) {
      return this.query.get(projectId, dto.id);
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'site-visits.start', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        let placeName: string | null = null;
        if (dto.nodeId !== undefined) {
          await lockProjectTree(tx, projectId);
          placeName = await this.publishedPlace(tx, projectId, dto.nodeId);
        }
        const envelope = await this.standing(tx, projectId, actor, user);
        const taken = await tx.siteVisit.findUnique({ where: { id: dto.id }, select: { id: true } });
        if (taken) throw new ConflictException('This visit has already been started');
        const open = await tx.siteVisit.findFirst({ where: { projectId, visitorId: user.sub, status: 'open' }, select: { id: true } });
        if (open) throw new ConflictException('You already have a site visit open on this project; end it first');
        await tx.siteVisit.create({
          data: {
            id: dto.id, projectId, visitorId: user.sub, visitorRole: envelope.actorRole,
            startClaimedAt: new Date(dto.claimedAt), startNodeId: dto.nodeId ?? null,
            locationKind: dto.location ? 'device' : 'none',
            locLat: dto.location?.lat ?? null, locLng: dto.location?.lng ?? null,
            locAccuracyM: dto.location?.accuracyM ?? null, locAt: dto.location ? new Date(dto.location.at) : null,
          },
        });
        const ev = await this.announce(tx, projectId, actor, envelope, dto.id, 'sitevisit.started',
          placeName ? { placeName } : {}, siteVisitStartedNotice(envelope.actorName, placeName));
        return { resultRef: dto.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.query.get(projectId, dto.id);
  }

  /**
   * End the visitor's own visit. On a visit a PMC has already closed, the same act records the visitor's LATE end once
   * (an offline device ending after the close): the close stands and the visit stays closed.
   */
  async end(projectId: string, visitId: string, dto: EndSiteVisitInput, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ visitId, ...dto });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'site-visits.end', idempotencyKey, requestHash)) {
      return this.query.get(projectId, visitId);
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'site-visits.end', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const visit = await this.lockVisit(tx, projectId, visitId);
        if (visit.visitorId !== user.sub) throw new ForbiddenException('Only the visitor can end their site visit');
        const envelope = await this.standing(tx, projectId, actor, user);
        // the end is attributed in the role the visit was started in (SV1-a, V6)
        if (envelope.actorRole !== visit.visitorRole) throw new ForbiddenException('Your role on this project has changed since this visit started');
        const claimedAt = new Date(dto.claimedAt);
        if (visit.status === 'open') {
          await tx.siteVisit.update({ where: { id: visitId }, data: { status: 'ended', endClaimedAt: claimedAt } });
          const ev = await this.announce(tx, projectId, actor, envelope, visitId, 'sitevisit.ended', {}, siteVisitEndedNotice(envelope.actorName));
          return { resultRef: visitId, events: [ev] };
        }
        if (visit.status === 'closed' && visit.lateEndClaimedAt === null) {
          await tx.siteVisit.update({ where: { id: visitId }, data: { lateEndClaimedAt: claimedAt } });
          const ev = await this.announce(tx, projectId, actor, envelope, visitId, 'sitevisit.late_end_recorded', {}, null);
          return { resultRef: visitId, events: [ev] };
        }
        throw new ConflictException('This site visit has already ended');
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.query.get(projectId, visitId);
  }

  /** The PMC closes a visit left open (S1), with a reason. */
  async close(projectId: string, visitId: string, dto: CloseSiteVisitInput, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ visitId, ...dto });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'site-visits.close', idempotencyKey, requestHash)) {
      return this.query.get(projectId, visitId);
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'site-visits.close', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const visit = await this.lockVisit(tx, projectId, visitId);
        const envelope = await this.standing(tx, projectId, actor, user);
        if (envelope.actorRole !== 'pmc') throw new ForbiddenException('Only the PMC can close a site visit');
        if (visit.status !== 'open') throw new ConflictException('Only an open site visit can be closed');
        await tx.siteVisit.update({ where: { id: visitId }, data: { status: 'closed', closedById: user.sub, closeReason: dto.reason } });
        const ev = await this.announce(tx, projectId, actor, envelope, visitId, 'sitevisit.closed',
          { visitorName: visit.visitorName }, siteVisitClosedNotice(visit.visitorName));
        return { resultRef: visitId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.query.get(projectId, visitId);
  }

  // ── the lock order ────────────────────────────────────────────────────────────────────────────

  /** The visit row, FOR UPDATE: the first lock of every act on an existing visit. */
  private async lockVisit(tx: CommandTx, projectId: string, visitId: string): Promise<LockedVisit> {
    const [visit] = await tx.$queryRaw<LockedVisit[]>(Prisma.sql`
      SELECT "id", "visitorId", "visitorName", "visitorRole", "status", "lateEndClaimedAt"
        FROM "SiteVisit" WHERE "projectId" = ${projectId} AND "id" = ${visitId}
         FOR UPDATE`);
    if (!visit) throw new NotFoundException('Site visit not found');
    return visit;
  }

  /** The node's current name through the nodes module's contract, locked FOR SHARE (under the tree lock). */
  private async publishedPlace(tx: CommandTx, projectId: string, nodeId: string): Promise<string> {
    try {
      const [row] = await tx.$queryRaw<Array<{ name: string }>>(Prisma.sql`SELECT nodes_published_name_locked(${projectId}, ${nodeId}) AS "name"`);
      return row!.name;
    } catch (error) {
      if (String(error).includes('nodes: node')) throw new BadRequestException('That place is not a published place on this project');
      throw error;
    }
  }

  /**
   * The actor's standing, under the envelope's register order with the project row before the identity: the two
   * registers FOR SHARE, the project row (the operability check), then the envelope (the identity FOR UPDATE).
   */
  private async standing(tx: CommandTx, projectId: string, actor: Actor, user: AuthUser): Promise<ActorEnvelope> {
    await lockActorStanding(tx, projectId, user.sub);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${projectId}) AS "operable"`);
    if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
    const envelope = await resolveActorEnvelope(tx, projectId, actor);
    if (!envelope) throw new ForbiddenException('Your role on this project has changed; sign in again');
    return envelope;
  }

  /** The act's one event on the visit's stream and, for start, end and close, its one kinded notice (SV1-a, V6). */
  private async announce(
    tx: CommandTx, projectId: string, actor: Actor, envelope: ActorEnvelope, visitId: string,
    eventType: 'sitevisit.started' | 'sitevisit.ended' | 'sitevisit.closed' | 'sitevisit.late_end_recorded',
    payload: Prisma.InputJsonObject, notice: string | null,
  ) {
    const eventId = randomUUID();
    const ev = await emitEvent(tx, {
      projectId, actor, eventId, actorEnvelope: envelope, eventType, entityType: 'SiteVisit', entityId: visitId,
      payload, effectKey: eventType, dispatch: {},
    });
    if (notice !== null) {
      await tx.notification.create({
        data: { projectId, text: notice, color: SITE_VISIT_NOTICE_COLOR, time: 'just now', kind: eventType, eventId },
      });
    }
    return ev;
  }
}
