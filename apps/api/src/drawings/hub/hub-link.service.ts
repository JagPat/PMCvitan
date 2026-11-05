import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import { resolveActor } from '../../common/actor';
import type { AuthUser } from '../../common/auth';
import { lockOrgStanding, lockProjectReadiness } from '../../common/readiness-lock';
import { recordAudit } from '../../platform/audit';
import { executeCommand, hashRequest, peekReplay, type CommandTx } from '../../platform/commands';
import { resolveWebAppUrl } from '../../config';
import { readHubClientConfig, type HubClientConfig } from './hub-config';
import {
  clipHubText,
  hubCallRetryable,
  linkHubProject,
  listHubProjects,
  unlinkHubProject,
  type HubCallFailure,
  type HubProject,
} from './hub-projects';

/**
 * #1118 U7a L1b — an org owner or admin links a PMC project to its Hub project, or unlinks it (notes/hub/u7a/plan.md §4).
 *
 * Who: an owner or admin of `HUB_ORG_ID`'s company only, for a live project of that company. Closed (any of the four
 * client variables unset or malformed) or another company: 404, as if the routes did not exist. A member who is not an
 * owner or admin: 403. Both are checked before the transaction (a cheap refusal), and authoritatively under the locks.
 * A keyed request that already committed replays before any of these checks, so a lost answer can always be recovered.
 *
 * Locks before Hub: every link and unlink takes, first, the company's standing key (so the owner/admin answer holds),
 * then the project's readiness key, the live project row (`FOR NO KEY UPDATE`, so an archive waits) and the link row
 * (`FOR UPDATE`, the lock the receiver reads), in the order every writer takes them. Only then is Hub called, so nothing
 * Hub is told can be undone by a role change or an archive in between, and since every link command of the company
 * holds the standing key, Hub's one `pmc` link per Hub project and PMC's link events change together, one command at a
 * time. The cost: the company's standing writers (membership and project creation) wait for at most the Hub calls.
 *
 * - Link: refused (409) when the project is linked to another Hub project (unlink first), when another PMC project holds
 *   that Hub project, or when the project already has Hub drawings from another Hub project. Then Hub is asked for the
 *   project (its number and name, and that the office token reaches it), then Hub links it (`POST …/links/pmc`, an
 *   upsert), and only then PMC writes the `linked` event with that number and name. Linked to it already: no new event,
 *   and Hub's link is written again, so a retry repairs a Hub that lost it.
 * - Unlink: PMC's side decides and commits first: the `unlinked` event and its audit row, under the locks, with no Hub
 *   call. Only after that commit is Hub's link removed, in a second transaction that takes the company's standing key
 *   and the link row again, so no link command runs meanwhile, and that writes nothing. Its target is the Hub project
 *   that this command's own `unlinked` event ended (the event before it), whatever happened since: a relink of this
 *   project to another Hub project between the two transactions leaves that old Hub link to be removed, not kept. It
 *   is kept only while a project of the company holds that Hub project again (then Hub's one `pmc` link is that
 *   holder's). So a failed PMC write never leaves Hub cleared, and a failed Hub call never leaves PMC linked. The answer
 *   says whether Hub's link is gone. Already unlinked (or a replayed key): only Hub's removal is tried again, for the
 *   same target, so the screen's Retry clears Hub.
 *
 * Holders are a company's own: a Hub project id names a project in the Hub connected for that company, so another
 * company's links never refuse, mark or keep anything here.
 *
 * The receiver takes the project's readiness key before it reads the link row, so a delivery that arrives while a link
 * holds it (through its Hub calls, before its first link row exists) waits and then judges what the link committed.
 *
 * A Hub link without its PMC twin is harmless: the receiver needs both. A Hub failure is a 503 the screen can retry
 * (Hub unreachable, slow or 5xx), a 503 that needs an operator (Hub refused the office token), or a 502 (Hub refused the
 * call). Nothing here logs; no answer carries the token, a Hub URL, or Hub's words.
 */

/** The transaction holds a pooled connection (and the locks) through at most two Hub calls of {@link HUB_CALL_TIMEOUT_MS} each. */
export const HUB_LINK_TX_TIMEOUT_MS = 30_000;
/** What Hub keeps of a link's label (Hub clips it there). */
export const HUB_LINK_LABEL_MAX = 64;

export type HubProjectChoice = HubProject & { linked: 'this' | 'other' | null };
export type HubUnlinkResult = { hubCleared: boolean };


function hubFailure(f: { failure: HubCallFailure; status?: number }): HttpException {
  if (f.failure === 'refused') {
    return new ServiceUnavailableException({ code: 'hub_key_refused', message: "Hub refused PMC's key. An operator needs to renew it." });
  }
  if (hubCallRetryable(f.failure, f.status)) {
    return new ServiceUnavailableException({ code: 'hub_unavailable', message: "Hub isn't answering. Try again in a moment." });
  }
  return new BadGatewayException({ code: 'hub_refused', message: 'Hub could not do this. Try again later.' });
}

/** The address Hub shows for the PMC side of the link: PMC's web app, when it is https (Hub accepts nothing else). */
function pmcAddress(): string | null {
  const url = resolveWebAppUrl();
  return url && url.startsWith('https://') ? url : null;
}

@Injectable()
export class HubLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgsParticipant,
  ) {}

  /** The Hub client config for `orgId`; 404 while Hub is not connected or for any other company. */
  private client(orgId: string): HubClientConfig {
    const hub = readHubClientConfig();
    if (!hub.open || hub.config.orgId !== orgId) throw new NotFoundException();
    return hub.config;
  }

  /** Owner or admin of `orgId` (else 403), and `projectId` a live project of it (else 404). */
  private async authorize(db: Prisma.TransactionClient, orgId: string, userId: string, projectId: string) {
    if (!(await this.orgs.administersAnyOf(db, userId, [orgId]))) {
      throw new ForbiddenException('Only a company owner or admin can link a project to Hub');
    }
    const project = await this.orgs.liveProjectOfOrg(db, orgId, projectId, false);
    if (!project) throw new NotFoundException('Project not found in this company');
    return project;
  }

  /** The Hub projects PMC's office token reaches, each marked when a PMC project holds it. */
  async listProjects(orgId: string, user: AuthUser, projectId: string): Promise<{ projects: HubProjectChoice[] }> {
    const config = this.client(orgId);
    await this.authorize(this.prisma, orgId, user.sub, projectId);
    const listed = await listHubProjects(config);
    if (!listed.ok) throw hubFailure(listed);
    const holders = await activeHolders(this.prisma, orgId, listed.value.map((p) => p.id));
    return {
      projects: listed.value.map((p) => {
        const holder = holders.get(p.id);
        return { ...p, linked: holder === undefined ? null : holder === projectId ? 'this' : 'other' };
      }),
    };
  }

  async link(orgId: string, user: AuthUser, projectId: string, hubProjectId: string, idempotencyKey?: string): Promise<{ link: HubLinkView }> {
    const scope = { scopeKind: 'project' as const, projectId };
    const requestHash = hashRequest({ orgId, projectId, hubProjectId });
    // a committed keyed link replays before any check that may have changed since (Hub's config, the person's role)
    const replay = await peekReplay(this.prisma, scope, user.sub, 'drawings.hubLink', idempotencyKey, requestHash);
    const config = replay ? null : this.client(orgId);
    if (!replay) await this.authorize(this.prisma, orgId, user.sub, projectId);
    const actor = await resolveActor(this.prisma, user);

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'drawings.hubLink',
      idempotencyKey,
      requestHash,
      transact: (fn) => this.prisma.$transaction(fn, { timeout: HUB_LINK_TX_TIMEOUT_MS }),
      run: async (tx) => {
        if (!config) throw new NotFoundException();
        // every lock first, so nothing Hub is told can be undone by a role change or an archive in the meantime
        const project = await this.lockForWrite(tx, orgId, user.sub, projectId);
        await linkRefusal(tx, orgId, projectId, hubProjectId);

        const listed = await listHubProjects(config);
        if (!listed.ok) throw hubFailure(listed);
        const hubProject = listed.value.find((p) => p.id === hubProjectId);
        if (!hubProject) {
          throw new BadRequestException({ code: 'hub_project_unavailable', message: "That Hub project is archived, or PMC's Hub key doesn't reach it" });
        }
        const label = clipHubText(project.siteCode, HUB_LINK_LABEL_MAX) ?? clipHubText(project.name, HUB_LINK_LABEL_MAX) ?? projectId;
        const linked = await linkHubProject(config, hubProjectId, { externalId: projectId, url: pmcAddress(), label });
        if (!linked.ok) throw hubFailure(linked);

        // PMC's side, under the same locks
        const latest = await latestEvent(tx, projectId);
        // the receipt names the link event this command committed (or found), so its answer never depends on a later one
        if (latest?.kind === 'linked') return { resultRef: String(latest.seq) };
        if (!latest) await tx.drawingHubLink.create({ data: { projectId, orgId } });
        const seq = (latest?.seq ?? 0) + 1;
        await tx.drawingHubLinkEvent.create({
          data: {
            projectId,
            seq,
            prevSeq: latest?.seq ?? null,
            kind: 'linked',
            hubProjectId,
            hubProjectNumber: hubProject.number,
            hubProjectName: hubProject.name,
            byUserId: user.sub,
          },
        });
        await recordAudit(tx, {
          projectId,
          actor,
          action: 'drawing.hub_linked',
          entity: 'DrawingHubLinkEvent',
          entityId: `${projectId}:${seq}`,
          payload: { hubProjectId, hubProjectNumber: hubProject.number, hubProjectName: hubProject.name },
        });
        return { resultRef: String(seq) };
      },
    });
    // events are insert-only, so the event this command committed reads the same however many commands came after it
    const view = await readHubLinkEvent(this.prisma, projectId, Number(outcome.resultRef));
    if (!view) throw new NotFoundException();
    return { link: view };
  }

  async unlink(orgId: string, user: AuthUser, projectId: string, idempotencyKey?: string, expected?: string): Promise<HubUnlinkResult> {
    const scope = { scopeKind: 'project' as const, projectId };
    // the hash leaves out the link the person saw: the key names the attempt, and the previous release hashed an unlink as
    // { orgId, projectId }, so a retry that lands on either release during a rolling deploy replays the same committed
    // unlink instead of a same-key/different-request 409 (#1353 Codex 4481199107)
    const requestHash = hashRequest({ orgId, projectId });
    // a committed keyed unlink replays before any check that may have changed since
    const replay = await peekReplay(this.prisma, scope, user.sub, 'drawings.hubUnlink', idempotencyKey, requestHash);
    const config = replay ? null : this.client(orgId);
    if (!replay) await this.authorize(this.prisma, orgId, user.sub, projectId);
    const actor = await resolveActor(this.prisma, user);

    // PMC's side first, committed with no Hub call: the unlink is decided here
    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'drawings.hubUnlink',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        if (!config) throw new NotFoundException();
        await this.lockForWrite(tx, orgId, user.sub, projectId);
        const latest = await latestEvent(tx, projectId);
        if (!latest) throw new ConflictException({ code: 'hub_not_linked', message: 'This project is not linked to a Hub project' });
        // the link the person saw and chose to unlink: still this project's, or the one its last unlink ended (a retry of
        // Hub's side); another admin's change meanwhile is refused, never unlinked unseen (#1353 Codex 4480498892)
        if (expected !== undefined) {
          const shown = latest.kind === 'linked' ? latest.hubProjectId : await endedByUnlink(tx, projectId, latest.seq);
          if (shown !== expected) {
            throw new ConflictException({ code: 'hub_link_changed', message: "This project's Hub link has changed. Refresh and try again." });
          }
        }
        if (latest.kind !== 'linked') return { resultRef: String(latest.seq) };
        const seq = latest.seq + 1;
        await tx.drawingHubLinkEvent.create({ data: { projectId, seq, prevSeq: latest.seq, kind: 'unlinked', byUserId: user.sub } });
        await recordAudit(tx, {
          projectId,
          actor,
          action: 'drawing.hub_unlinked',
          entity: 'DrawingHubLinkEvent',
          entityId: `${projectId}:${seq}`,
          payload: { hubProjectId: latest.hubProjectId },
        });
        return { resultRef: String(seq) };
      },
    });
    // then Hub's side, only after PMC's unlink has committed: the Hub project this command's own unlink event ended
    return { hubCleared: await this.clearHubLink(orgId, user.sub, projectId, Number(outcome.resultRef)) };
  }

  /**
   * After an unlink has committed: removes Hub's `pmc` link from the Hub project that unlink event `unlinkSeq` ended (the
   * link event just before it), and says whether Hub is left with no link of this project's to that Hub project. Its
   * own transaction, which writes nothing: the company's standing key (so no link command of the company runs
   * meanwhile, and the owner/admin answer holds) and the link row. The target is fixed by the unlink's own event, never
   * by the project's latest one, so a relink to another Hub project in between never leaves the old Hub link behind.
   * Hub is called only while Hub is connected for this company and the person is still an owner or admin, and only
   * while no project of the company holds that Hub project again: then Hub's one `pmc` link is that holder's (this
   * project's own, after a relink to the same Hub project), and not ours to remove (true). Otherwise false means
   * nothing it may do now: the screen offers Retry.
   */
  private async clearHubLink(orgId: string, userId: string, projectId: string, unlinkSeq: number): Promise<boolean> {
    const hub = readHubClientConfig();
    if (!hub.open || hub.config.orgId !== orgId) return false;
    const config = hub.config;
    return this.prisma.$transaction(async (tx) => {
      await lockOrgStanding(tx, orgId);
      if (!(await this.orgs.administersAnyOf(tx, userId, [orgId]))) return false;
      await tx.$queryRaw(Prisma.sql`SELECT "projectId" FROM "DrawingHubLink" WHERE "projectId" = ${projectId} FOR UPDATE`);
      const target = await endedByUnlink(tx, projectId, unlinkSeq);
      if (!target) return true;
      if ((await activeHolders(tx, orgId, [target])).has(target)) return true;
      return (await unlinkHubProject(config, target)).ok;
    }, { timeout: HUB_LINK_TX_TIMEOUT_MS });
  }

  /**
   * The locks every link and unlink takes before calling Hub, in the order every writer takes them: the company's
   * standing key (so the owner/admin answer holds), the project's readiness key, the live project row, the link row.
   */
  private async lockForWrite(tx: CommandTx, orgId: string, userId: string, projectId: string): Promise<{ name: string; siteCode: string }> {
    await lockOrgStanding(tx, orgId);
    if (!(await this.orgs.administersAnyOf(tx, userId, [orgId]))) {
      throw new ForbiddenException('Only a company owner or admin can link a project to Hub');
    }
    await lockProjectReadiness(tx, projectId);
    const project = await this.orgs.liveProjectOfOrg(tx, orgId, projectId, true);
    if (!project) throw new NotFoundException('Project not found in this company');
    // the receiver reads this row FOR UPDATE; a link event's insert takes KEY SHARE on it, so this is the same lock it waits on
    await tx.$queryRaw(Prisma.sql`SELECT "projectId" FROM "DrawingHubLink" WHERE "projectId" = ${projectId} FOR UPDATE`);
    return project;
  }
}

type LatestEvent = { seq: number; kind: string; hubProjectId: string | null };

function latestEvent(db: Prisma.TransactionClient, projectId: string): Promise<LatestEvent | null> {
  return db.drawingHubLinkEvent.findFirst({ where: { projectId }, orderBy: { seq: 'desc' }, select: { seq: true, kind: true, hubProjectId: true } });
}

/**
 * For each Hub project id, the project of `orgId` whose latest link event links it (at most one: the link command keeps
 * it so). Only that company's links count: a Hub project id names a project in the Hub connected for the link's own
 * company, so another company's links (kept from an earlier connection, or a Hub connected for it) never mark this
 * company's list, refuse its link or keep its Hub link, nor say anything about that company.
 */
async function activeHolders(db: Prisma.TransactionClient, orgId: string, hubProjectIds: readonly string[]): Promise<Map<string, string>> {
  if (hubProjectIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ projectId: string; hubProjectId: string }>>(Prisma.sql`
    SELECT e."projectId", e."hubProjectId" FROM "DrawingHubLinkEvent" e
    JOIN "DrawingHubLink" l ON l."projectId" = e."projectId" AND l."orgId" = ${orgId}
    WHERE e."kind" = 'linked' AND e."hubProjectId" IN (${Prisma.join([...hubProjectIds])})
      AND NOT EXISTS (SELECT 1 FROM "DrawingHubLinkEvent" n WHERE n."projectId" = e."projectId" AND n."seq" > e."seq")
    ORDER BY e."projectId"`);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.hubProjectId)) out.set(r.hubProjectId, r.projectId);
  return out;
}

/** Why `projectId` may not be linked to `hubProjectId` now (a 409), or its latest link event when it may. */
async function linkRefusal(db: Prisma.TransactionClient, orgId: string, projectId: string, hubProjectId: string): Promise<LatestEvent | null> {
  const latest = await latestEvent(db, projectId);
  if (latest?.kind === 'linked' && latest.hubProjectId !== hubProjectId) {
    throw new ConflictException({ code: 'hub_linked_elsewhere', message: 'This project is linked to another Hub project. Unlink it first.' });
  }
  const holder = (await activeHolders(db, orgId, [hubProjectId])).get(hubProjectId);
  if (holder !== undefined && holder !== projectId) {
    throw new ConflictException({ code: 'hub_project_taken', message: 'Another PMC project is linked to that Hub project' });
  }
  // a project's Hub drawings come from one Hub project; moving them is U7b's renumbering (plan Q-L)
  const foreign = await db.hubDrawing.findFirst({ where: { projectId, hubProjectId: { not: hubProjectId } }, select: { drawingId: true } });
  if (foreign) {
    throw new ConflictException({ code: 'hub_drawings_elsewhere', message: 'This project has drawings from another Hub project, so it cannot be linked to this one yet' });
  }
  return latest;
}

/**
 * The Hub project that unlink event `unlinkSeq` of the project ended: the link event just before it (events alternate,
 * starting with a link). Null when `unlinkSeq` is not an unlink of this project.
 */
async function endedByUnlink(db: Prisma.TransactionClient, projectId: string, unlinkSeq: number): Promise<string | null> {
  if (!Number.isSafeInteger(unlinkSeq) || unlinkSeq < 2) return null;
  const events = await db.drawingHubLinkEvent.findMany({
    where: { projectId, seq: { in: [unlinkSeq - 1, unlinkSeq] } },
    select: { seq: true, kind: true, hubProjectId: true },
  });
  const unlink = events.find((e) => e.seq === unlinkSeq);
  const ended = events.find((e) => e.seq === unlinkSeq - 1);
  if (unlink?.kind !== 'unlinked' || ended?.kind !== 'linked') return null;
  return ended.hubProjectId;
}

/** #1118 U7a — a project's active Hub link as screens show it: Hub's id, and the number and name kept at link time. */
export type HubLinkView = { hubProjectId: string; number: string | null; name: string | null; linkedAt: string };

/** Link event `seq` of the project as a {@link HubLinkView}, or null when it is not a link. */
async function readHubLinkEvent(db: Prisma.TransactionClient, projectId: string, seq: number): Promise<HubLinkView | null> {
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  const ev = await db.drawingHubLinkEvent.findUnique({
    where: { projectId_seq: { projectId, seq } },
    select: { kind: true, hubProjectId: true, hubProjectNumber: true, hubProjectName: true, at: true },
  });
  if (ev?.kind !== 'linked' || !ev.hubProjectId) return null;
  return { hubProjectId: ev.hubProjectId, number: ev.hubProjectNumber, name: ev.hubProjectName, linkedAt: ev.at.toISOString() };
}

/** The project's active Hub link (its latest event, when that is a link), or null. Reads PMC only, never Hub. */
export async function readHubLink(db: Prisma.TransactionClient, projectId: string): Promise<HubLinkView | null> {
  const latest = await db.drawingHubLinkEvent.findFirst({
    where: { projectId },
    orderBy: { seq: 'desc' },
    select: { kind: true, hubProjectId: true, hubProjectNumber: true, hubProjectName: true, at: true },
  });
  if (latest?.kind !== 'linked' || !latest.hubProjectId) return null;
  return { hubProjectId: latest.hubProjectId, number: latest.hubProjectNumber, name: latest.hubProjectName, linkedAt: latest.at.toISOString() };
}
