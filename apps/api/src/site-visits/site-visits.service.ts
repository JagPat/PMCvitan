import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectTree } from '../common/tree-lock';
import { lockProjectReadiness } from '../common/readiness-lock';
import { lockStandingAnchors } from '../common/standing-anchor';
import type { AuthUser } from '../common/auth';
import { resolveActor, type Actor } from '../common/actor';
import { emitEvent } from '../platform/events';
import { lockActorStanding, lockIdentities, resolveActorEnvelope, type ActorEnvelope } from '../platform/actor-envelope';
import { executeCommand, hashRequest, peekReplay, type CommandScope, type CommandTx } from '../platform/commands';
import { VISIT_FILE_GONE_MESSAGE, VIDEO_LINK_GONE_MESSAGE } from '@vitan/shared';
import type {
  AddSiteVisitAttendeeInput, AddSiteVisitPlaceInput, CloseSiteVisitInput, EndSiteVisitFileLinkInput, EndSiteVisitInput,
  SetSiteVisitFileLinkInput, StartSiteVisitInput,
} from '../contracts';
import { SiteVisitsQueryService, type SiteVisitDto } from './site-visits.query';
import { SITE_VISIT_NOTICE_COLOR, siteVisitClosedNotice, siteVisitEndedNotice, siteVisitStartedNotice } from './site-visit-notice';
import { projectRoleChanged, projectUnavailable } from '../common/lost-project';

/** A clip's current full-video link, locked: its id, its adder and whether it is still in its adder's own hour, read
 *  on the database's clock (V2g-0, K7). */
interface FileLinkRow {
  id: string;
  addedById: string;
  inHour: boolean;
}

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
 *   the project's readiness lock → the project tree (every act on an existing visit, and a start that names a place)
 *   → the visit row → the node → OrgUserAuthority → ProjectUserStanding → the project row → UserIdentity → the event
 *   stream.
 *
 * - The readiness lock first, the protocol every membership change and archive already follows
 *   (`readiness-lock.ts`). A membership command locks its actor's identity and only then the project row (its
 *   transition seal's operability check), the reverse of the order below; holding the readiness lock first, the two
 *   never interleave (#834, Codex 4260951386). No node writer takes the readiness lock, so it cannot meet the tree
 *   lock in the other order.
 * - The tree lock before the visit row, on every act on an existing visit: a node removal holds the tree lock (and,
 *   once it has written an event, the event stream) and then reaches the row of every visit that started at that node
 *   (`startNodeId`) and every place row at it (`nodeId`), both ON DELETE SET NULL. An act that held either row and
 *   then waited on the stream deadlocked against it; under the tree lock it waits for the removal instead.
 * - The visit row next: every child write locks it before its standing, as SV1-a's triggers do.
 * - A member attendee's registers follow the visitor's, and after the project row both identities are locked in
 *   user-id order, the order SV1-a's attendee trigger takes them.
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
      return this.query.get(projectId, dto.id, user.sub, user.role);
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
    return this.query.get(projectId, dto.id, user.sub, user.role);
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
      return this.query.get(projectId, visitId, user.sub, user.role);
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
    return this.query.get(projectId, visitId, user.sub, user.role);
  }

  /** The PMC closes a visit left open (S1), with a reason. */
  async close(projectId: string, visitId: string, dto: CloseSiteVisitInput, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ visitId, ...dto });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'site-visits.close', idempotencyKey, requestHash)) {
      return this.query.get(projectId, visitId, user.sub, user.role);
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
    return this.query.get(projectId, visitId, user.sub, user.role);
  }

  /**
   * The visitor adds a place they walked: a published place of the project, at a claimed time the database accepts
   * after the start (or at its receipt, marked "after the end", once the visit has ended). A closed visit takes no edit.
   */
  async addPlace(projectId: string, visitId: string, dto: AddSiteVisitPlaceInput, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    return this.visitorEdit(projectId, visitId, 'site-visits.add-place', { visitId, ...dto }, user, idempotencyKey, async (tx, actor) => {
      const visit = await this.lockEditableVisit(tx, projectId, visitId, user);
      const placeName = await this.publishedPlace(tx, projectId, dto.nodeId);
      const envelope = await this.visitorStanding(tx, projectId, actor, user, visit);
      if (await tx.siteVisitPlace.findUnique({ where: { id: dto.id }, select: { id: true } })) {
        throw new ConflictException('This place has already been added');
      }
      if (await tx.siteVisitPlace.findFirst({ where: { projectId, visitId, nodeId: dto.nodeId, retiredAt: null }, select: { id: true } })) {
        throw new ConflictException('That place is already on this visit');
      }
      await tx.siteVisitPlace.create({
        data: { id: dto.id, projectId, visitId, nodeId: dto.nodeId, addedById: user.sub, addedClaimedAt: new Date(dto.claimedAt) },
      });
      return this.announceRow(tx, projectId, actor, envelope, visitId, 'sitevisit.place_added', { rowId: dto.id, placeName });
    });
  }

  /** The visitor retires a place added by mistake; the row stays in the record, marked retired. */
  async retirePlace(projectId: string, visitId: string, placeId: string, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    return this.visitorEdit(projectId, visitId, 'site-visits.retire-place', { visitId, placeId }, user, idempotencyKey, async (tx, actor) => {
      const visit = await this.lockEditableVisit(tx, projectId, visitId, user);
      const envelope = await this.visitorStanding(tx, projectId, actor, user, visit);
      const row = await tx.siteVisitPlace.findFirst({ where: { projectId, visitId, id: placeId }, select: { retiredAt: true } });
      if (!row) throw new NotFoundException('Place not found on this visit');
      if (row.retiredAt) throw new ConflictException('This place has already been removed');
      await tx.siteVisitPlace.update({ where: { id: placeId }, data: { retiredById: user.sub } });
      return this.announceRow(tx, projectId, actor, envelope, visitId, 'sitevisit.place_retired', { rowId: placeId });
    });
  }

  /**
   * The visitor names someone who was with them: a member of the project in a role they hold there, or a guest by
   * name. The member's standing registers are locked after the visitor's and both identities in user-id order, the
   * order SV1-a's trigger takes them, so two visitors adding each other on two projects cannot deadlock.
   */
  async addAttendee(projectId: string, visitId: string, dto: AddSiteVisitAttendeeInput, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    return this.visitorEdit(projectId, visitId, 'site-visits.add-attendee', { visitId, ...dto }, user, idempotencyKey, async (tx, actor) => {
      const visit = await this.lockEditableVisit(tx, projectId, visitId, user);
      const member = 'userId' in dto ? { userId: dto.userId, role: dto.role } : null;
      // the visitor is on the visit as its visitor; an attendee is someone with them
      if (member?.userId === user.sub) throw new BadRequestException('You are already on this visit as the visitor');
      const envelope = await this.visitorStanding(tx, projectId, actor, user, visit, member?.userId);
      if (await tx.siteVisitAttendee.findUnique({ where: { id: dto.id }, select: { id: true } })) {
        throw new ConflictException('This attendee has already been added');
      }
      if (member && await tx.siteVisitAttendee.findFirst({ where: { projectId, visitId, userId: member.userId, retiredAt: null }, select: { id: true } })) {
        throw new ConflictException('That person is already on this visit');
      }
      try {
        await tx.siteVisitAttendee.create({
          data: member
            ? { id: dto.id, projectId, visitId, userId: member.userId, role: member.role, addedById: user.sub }
            : { id: dto.id, projectId, visitId, guestName: 'guestName' in dto ? dto.guestName : '', addedById: user.sub },
        });
      } catch (error) {
        // SV1-a's trigger judges a member's standing under the locks taken above; its refusals become clear 400s
        const message = String(error);
        if (message.includes('cannot be the attendee')) throw new BadRequestException('That person is not on this project in that role');
        if (message.includes('has no account name')) throw new BadRequestException('That person has no name on their account yet');
        throw error;
      }
      return this.announceRow(tx, projectId, actor, envelope, visitId, 'sitevisit.attendee_added', { rowId: dto.id });
    });
  }

  /** The visitor retires an attendee added by mistake; the row stays in the record, marked retired. */
  async retireAttendee(projectId: string, visitId: string, attendeeId: string, user: AuthUser, idempotencyKey?: string): Promise<SiteVisitDto> {
    return this.visitorEdit(projectId, visitId, 'site-visits.retire-attendee', { visitId, attendeeId }, user, idempotencyKey, async (tx, actor) => {
      const visit = await this.lockEditableVisit(tx, projectId, visitId, user);
      const envelope = await this.visitorStanding(tx, projectId, actor, user, visit);
      const row = await tx.siteVisitAttendee.findFirst({ where: { projectId, visitId, id: attendeeId }, select: { retiredAt: true } });
      if (!row) throw new NotFoundException('Attendee not found on this visit');
      if (row.retiredAt) throw new ConflictException('This attendee has already been removed');
      await tx.siteVisitAttendee.update({ where: { id: attendeeId }, data: { retiredById: user.sub } });
      return this.announceRow(tx, projectId, actor, envelope, visitId, 'sitevisit.attendee_retired', { rowId: attendeeId });
    });
  }

  // ── a video clip's full-video link (Video V2g-1, #995) ─────────────────────────────────────────

  /**
   * Put a share link to a clip's full-quality video (Google Drive or Zoho WorkDrive) beside the clip, or replace the one
   * it has. `replaces` is the link the person saw (null when none): a link changed by someone else since is refused, so
   * nobody's link is ended unseen. A replace ends the current link and adds the new one in one transaction; the ended
   * link stays as the clip's history (V2g-0, K5/K6).
   *
   * Who (Jagrut's plan, Stage 1 6 Nov 2026): adding a link where there is none, the person who added the clip or anyone
   * who may add files to the visit (its visitor and the people recorded on it), while the visit is not closed, and the
   * PMC at any time. Replacing or taking off a link follows a visit file's removal rule (#1179, V2g-0 K7): the person who
   * added it, within the hour and while the visit is open (an ended visit's links are the PMC's, as its files are), needs no reason; the PMC may at any time, saying why
   * unless it is their own within the hour. The database judges the hour again at its own stamp.
   */
  async setFileLink(
    projectId: string, visitId: string, mediaId: string, dto: SetSiteVisitFileLinkInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<SiteVisitDto> {
    return this.visitorEdit(projectId, visitId, 'site-visits.set-file-link', { visitId, mediaId, ...dto }, user, idempotencyKey, async (tx, actor) => {
      const { visit, file, current, envelope } = await this.lockFileLink(tx, projectId, visitId, mediaId, actor, user);
      // who may act at all comes first: someone who may not touch this clip's link gets 403, never a stale-link 409 (G4)
      this.judgeFileLinkActor(visit, file, envelope.actorRole, user.sub);
      if ((current?.id ?? null) !== dto.replaces) {
        throw new ConflictException(current
          ? 'Someone else changed this video\'s full video link; look at it again'
          : 'This video\'s full video link was taken off by someone else; look at it again');
      }
      if (await tx.siteVisitMediaLink.findUnique({ where: { id: dto.id }, select: { id: true } })) {
        throw new ConflictException('This link has already been added');
      }
      this.judgeFileLinkChange(visit, current, envelope.actorRole, user.sub, dto.reason, current ? 'replacing' : null);
      if (current) await this.endLink(tx, current.id, user.sub, envelope.actorRole, dto.reason);
      try {
        // the database sets the host from the url, copies the adder's name as they stand and stamps the time (V2g-0)
        await tx.siteVisitMediaLink.create({
          data: {
            id: dto.id, projectId, mediaId, url: dto.url, host: dto.url.startsWith('https://drive.google.com/') ? 'drive' : 'zoho',
            label: dto.label ?? null, addedById: user.sub, addedByRole: envelope.actorRole,
          },
        });
      } catch (error) {
        // the partial unique index (K5) is the backstop behind the locks above: a second current link is someone else's
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('Someone else changed this video\'s full video link; look at it again');
        }
        throw error;
      }
      return { resultRef: dto.id, events: [] };
    });
  }

  /** Take a clip's full-video link off with no successor, under {@link setFileLink}'s rule. The link stays as history. */
  async endFileLink(
    projectId: string, visitId: string, mediaId: string, dto: EndSiteVisitFileLinkInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<SiteVisitDto> {
    return this.visitorEdit(projectId, visitId, 'site-visits.end-file-link', { visitId, mediaId, ...dto }, user, idempotencyKey, async (tx, actor) => {
      const { visit, file, current, envelope } = await this.lockFileLink(tx, projectId, visitId, mediaId, actor, user);
      this.judgeFileLinkActor(visit, file, envelope.actorRole, user.sub);
      if (current?.id !== dto.linkId) {
        const known = await tx.siteVisitMediaLink.findFirst({ where: { projectId, mediaId, id: dto.linkId }, select: { id: true } });
        if (!known) throw new NotFoundException(VIDEO_LINK_GONE_MESSAGE);
        throw new ConflictException('This full video link was already taken off or replaced');
      }
      this.judgeFileLinkChange(visit, current, envelope.actorRole, user.sub, dto.reason, 'removing');
      await this.endLink(tx, current.id, user.sub, envelope.actorRole, dto.reason);
      return { resultRef: current.id, events: [] };
    });
  }

  /**
   * The link writer's locks after the readiness key, in V2g-0's order: the tree and the visit row FOR UPDATE (every visit
   * act's), the file's "Media" row FOR SHARE (the media module's `media_mime_of_locked`), the file's visit link
   * ("SiteVisitMedia") FOR UPDATE, the file's current full-video link FOR UPDATE, then the
   * actor's standing (registers, project row, identity). The database's triggers take the visit, the "Media" row, the
   * file's visit link and the standing in the same order, as a file's removal does, so a raw writer waits behind this one. A file taken off the visit is not found.
   */
  private async lockFileLink(tx: CommandTx, projectId: string, visitId: string, mediaId: string, actor: Actor, user: AuthUser) {
    const visit = await this.lockVisit(tx, projectId, visitId);
    // the file's type through the media module's contract, under a share lock on its row, as the database's insert
    // trigger reads it (K2): a change of type waits for this transaction and then sees its link
    const [media] = await tx.$queryRaw<Array<{ mime: string | null }>>(Prisma.sql`SELECT media_mime_of_locked(${projectId}, ${mediaId}) AS "mime"`);
    const [file] = await tx.$queryRaw<Array<{ addedById: string }>>(Prisma.sql`
      SELECT "addedById" FROM "SiteVisitMedia" WHERE "projectId" = ${projectId} AND "visitId" = ${visitId} AND "mediaId" = ${mediaId}
         FOR UPDATE`);
    if (!file) throw new NotFoundException(VISIT_FILE_GONE_MESSAGE);
    if (!(media?.mime ?? '').startsWith('video/')) throw new BadRequestException('Only a video takes a full video link');
    const [current] = await tx.$queryRaw<FileLinkRow[]>(Prisma.sql`
      SELECT "id", "addedById", ("addedAt" + interval '1 hour' >= site_visits_now()) AS "inHour"
        FROM "SiteVisitMediaLink" WHERE "projectId" = ${projectId} AND "mediaId" = ${mediaId} AND "endedAt" IS NULL
         FOR UPDATE`);
    const envelope = await this.standing(tx, projectId, actor, user);
    const present = visit.visitorId === user.sub
      || (await tx.siteVisitAttendee.findFirst({ where: { projectId, visitId, userId: user.sub, retiredAt: null }, select: { id: true } })) !== null;
    return { visit, file: { addedById: file.addedById, present }, current: current ?? null, envelope };
  }

  /**
   * Whether this person may touch the clip's link at all (see {@link setFileLink}), judged before the link they saw is
   * compared, so someone who may not act gets 403 rather than a stale-link 409 (V2g-1 gap-check G4). The PMC always may;
   * anyone else only when they added the clip or are on the visit (its visitor, or a recorded attendee not taken off),
   * and never on a visit the PMC closed.
   */
  private judgeFileLinkActor(visit: LockedVisit, file: { addedById: string; present: boolean }, role: string, userId: string): void {
    if (role === 'pmc') return;
    if (!file.present && file.addedById !== userId) {
      throw new ForbiddenException('Only the person who added this video, the people on this visit, or the PMC may add its full video link');
    }
    if (visit.status === 'closed') throw new ConflictException('This site visit was closed by the PMC; ask the PMC to change the link');
  }

  /**
   * Whether this person may replace or take off the current link (`changing` is null when nothing ends), after
   * {@link judgeFileLinkActor}. A visit file's removal rule (#1179, `site-visit-files.participant.ts`): anyone but the
   * PMC changes only their own link, within the hour, and only while the visit is open (an ended visit is the PMC's, the
   * same 409 as a file's removal; gap-check G1). The PMC gives a reason unless the link is their own within the hour.
   */
  private judgeFileLinkChange(
    visit: LockedVisit, current: FileLinkRow | null, role: string, userId: string, reason: string | undefined,
    changing: 'replacing' | 'removing' | null,
  ): void {
    const ownInHour = current !== null && current.addedById === userId && current.inHour === true;
    if (role === 'pmc') {
      if (changing && !ownInHour && reason === undefined) throw new BadRequestException(`Say why you are ${changing} this link`);
      return;
    }
    if (current === null) return;
    if (current.addedById !== userId) throw new ForbiddenException('Only the person who added this link, or the PMC, may change it');
    if (visit.status !== 'open') throw new ConflictException('This site visit has ended; ask the PMC to change the link');
    if (!ownInHour) throw new ForbiddenException('A link can be changed only within an hour of adding it; ask the PMC');
  }

  /**
   * End a current link: the database stamps the time and copies the ender's name (K6). Only the PMC's reason is kept, as
   * on a visit file's removal line: anyone else ends only their own link within the hour, which needs none, so a link
   * ended with no reason leaves the database's CHECK (K7) to judge the hour at the end's own stamp.
   */
  private async endLink(tx: CommandTx, linkId: string, userId: string, role: string, reason: string | undefined): Promise<void> {
    try {
      await tx.siteVisitMediaLink.update({
        where: { id: linkId },
        data: { endedById: userId, endedByRole: role, reason: role === 'pmc' ? reason ?? null : null },
      });
    } catch (error) {
      // the hour ran out between the check and the end's own stamp
      const refused = error instanceof Prisma.PrismaClientUnknownRequestError || error instanceof Prisma.PrismaClientKnownRequestError;
      if (refused && /SiteVisitMediaLink_shape_check/.test(error.message)) {
        if (role === 'pmc') throw new BadRequestException('Say why you are changing this link');
        throw new ForbiddenException('A link can be changed only within an hour of adding it; ask the PMC');
      }
      throw error;
    }
  }

  // ── the visitor's edits ───────────────────────────────────────────────────────────────────────

  /** One ledgered command under the readiness lock, as every visit act is; `run` takes the rest of the order. */
  private async visitorEdit(
    projectId: string, visitId: string, commandType: string, request: Record<string, unknown>, user: AuthUser,
    idempotencyKey: string | undefined, run: (tx: CommandTx, actor: Actor) => Promise<{ resultRef: string; events: Awaited<ReturnType<typeof emitEvent>>[] }>,
  ): Promise<SiteVisitDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest(request);
    if (await peekReplay(this.prisma, scope, actor.actorId, commandType, idempotencyKey, requestHash)) {
      return this.query.get(projectId, visitId, user.sub, user.role);
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType, idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        return run(tx, actor);
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.query.get(projectId, visitId, user.sub, user.role);
  }

  /** The visit row, locked; only its visitor edits it, and a closed visit takes no edit (SV1-a, V4). */
  private async lockEditableVisit(tx: CommandTx, projectId: string, visitId: string, user: AuthUser): Promise<LockedVisit> {
    const visit = await this.lockVisit(tx, projectId, visitId);
    if (visit.visitorId !== user.sub) throw new ForbiddenException('Only the visitor can change their site visit');
    if (visit.status === 'closed') throw new ConflictException('This site visit was closed by the PMC and takes no more changes');
    return visit;
  }

  /**
   * The visitor's standing in the visit's role. With a member attendee, that member's registers follow the visitor's,
   * and after the project row both identities are locked in user-id order before the envelope re-locks the visitor's.
   */
  private async visitorStanding(
    tx: CommandTx, projectId: string, actor: Actor, user: AuthUser, visit: LockedVisit, attendeeId?: string,
  ): Promise<ActorEnvelope> {
    const envelope = await this.standing(tx, projectId, actor, user, attendeeId);
    if (envelope.actorRole !== visit.visitorRole) throw new ForbiddenException('Your role on this project has changed since this visit started');
    return envelope;
  }

  /** A child change's one event on the visit's stream, naming its row (SV1-a, V6); child changes carry no notice. */
  private async announceRow(
    tx: CommandTx, projectId: string, actor: Actor, envelope: ActorEnvelope, visitId: string,
    eventType: 'sitevisit.place_added' | 'sitevisit.place_retired' | 'sitevisit.attendee_added' | 'sitevisit.attendee_retired',
    payload: Prisma.InputJsonObject & { rowId: string },
  ) {
    const ev = await emitEvent(tx, {
      projectId, actor, eventId: randomUUID(), actorEnvelope: envelope, eventType, entityType: 'SiteVisit', entityId: visitId,
      payload, effectKey: eventType, dispatch: {},
    });
    return { resultRef: payload.rowId, events: [ev] };
  }

  // ── the lock order ────────────────────────────────────────────────────────────────────────────

  /**
   * The project's tree lock, then the visit row FOR UPDATE: the first locks of every act on an existing visit. A node
   * removal holds the tree lock before it reaches this row or a place row through their ON DELETE SET NULL keys.
   */
  private async lockVisit(tx: CommandTx, projectId: string, visitId: string): Promise<LockedVisit> {
    await lockProjectTree(tx, projectId);
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
  private async standing(tx: CommandTx, projectId: string, actor: Actor, user: AuthUser, attendeeId?: string): Promise<ActorEnvelope> {
    // #1061 — both people's anchors in ONE sorted call before either's rows: two visits naming the same two
    // people the other way round take them in the same order
    await lockStandingAnchors(tx, { read: attendeeId === undefined ? [user.sub] : [user.sub, attendeeId] });
    await lockActorStanding(tx, projectId, user.sub);
    if (attendeeId !== undefined && attendeeId !== user.sub) await lockActorStanding(tx, projectId, attendeeId);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${projectId}) AS "operable"`);
    if (state?.operable !== true) throw projectUnavailable();
    if (attendeeId !== undefined) await lockIdentities(tx, [user.sub, attendeeId]);
    const envelope = await resolveActorEnvelope(tx, projectId, actor);
    if (!envelope) throw projectRoleChanged('envelope');
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
