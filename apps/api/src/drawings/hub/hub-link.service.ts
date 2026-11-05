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
 * #1118 U7a L1 — an org owner or admin links a PMC project to its Hub project, or unlinks it (notes/hub/u7a/plan.md §4).
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
 * - Unlink: Hub's link is removed first (unless another PMC project holds that Hub project now), then PMC writes the
 *   `unlinked` event whether Hub answered or not: PMC's side decides. The answer says whether Hub's link is gone. Already
 *   unlinked: only Hub's removal is tried again.
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
    const holders = await activeHolders(this.prisma, listed.value.map((p) => p.id));
    return {
      projects: listed.value.map((p) => {
        const holder = holders.get(p.id);
        return { ...p, linked: holder === undefined ? null : holder === projectId ? 'this' : 'other' };
      }),
    };
  }

  async link(orgId: string, user: AuthUser, projectId: string, hubProjectId: string, idempotencyKey?: string): Promise<{ link: HubLinkView | null }> {
    const scope = { scopeKind: 'project' as const, projectId };
    const requestHash = hashRequest({ orgId, projectId, hubProjectId });
    // a committed keyed link replays before any check that may have changed since (Hub's config, the person's role)
    const replay = await peekReplay(this.prisma, scope, user.sub, 'drawings.hubLink', idempotencyKey, requestHash);
    const config = replay ? null : this.client(orgId);
    if (!replay) await this.authorize(this.prisma, orgId, user.sub, projectId);
    const actor = await resolveActor(this.prisma, user);

    await executeCommand(this.prisma, {
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
        await linkRefusal(tx, projectId, hubProjectId);

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
        if (latest?.kind === 'linked') return { resultRef: hubProjectId };
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
        return { resultRef: hubProjectId };
      },
    });
    return { link: await readHubLink(this.prisma, projectId) };
  }

  async unlink(orgId: string, user: AuthUser, projectId: string, idempotencyKey?: string): Promise<HubUnlinkResult> {
    const scope = { scopeKind: 'project' as const, projectId };
    const requestHash = hashRequest({ orgId, projectId });
    // a committed keyed unlink replays (with its answer) before any check that may have changed since
    const replay = await peekReplay(this.prisma, scope, user.sub, 'drawings.hubUnlink', idempotencyKey, requestHash);
    const config = replay ? null : this.client(orgId);
    if (!replay) await this.authorize(this.prisma, orgId, user.sub, projectId);
    const actor = await resolveActor(this.prisma, user);

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'drawings.hubUnlink',
      idempotencyKey,
      requestHash,
      transact: (fn) => this.prisma.$transaction(fn, { timeout: HUB_LINK_TX_TIMEOUT_MS }),
      run: async (tx) => {
        if (!config) throw new NotFoundException();
        // every lock first, so nothing Hub is told can be undone by a role change or an archive in the meantime
        await this.lockForWrite(tx, orgId, user.sub, projectId);
        const latest = await latestEvent(tx, projectId);
        if (!latest) throw new ConflictException({ code: 'hub_not_linked', message: 'This project is not linked to a Hub project' });
        // the Hub project this project was last linked to: events alternate, so an unlink's previous event is that link
        const target = latest.kind === 'linked'
          ? latest.hubProjectId
          : (await tx.drawingHubLinkEvent.findUnique({ where: { projectId_seq: { projectId, seq: latest.seq - 1 } }, select: { hubProjectId: true } }))?.hubProjectId;
        if (!target) throw new ConflictException({ code: 'hub_not_linked', message: 'This project is not linked to a Hub project' });

        // Hub's side first. Its one `pmc` link on that Hub project is another PMC project's once that project holds it,
        // and then is not ours to remove
        const holder = (await activeHolders(tx, [target])).get(target);
        const hubCleared = holder !== undefined && holder !== projectId ? true : (await unlinkHubProject(config, target)).ok;

        if (latest.kind === 'linked') {
          const seq = latest.seq + 1;
          await tx.drawingHubLinkEvent.create({ data: { projectId, seq, prevSeq: latest.seq, kind: 'unlinked', byUserId: user.sub } });
          await recordAudit(tx, {
            projectId,
            actor,
            action: 'drawing.hub_unlinked',
            entity: 'DrawingHubLinkEvent',
            entityId: `${projectId}:${seq}`,
            payload: { hubProjectId: target, hubCleared },
          });
        }
        return { resultRef: hubCleared ? 'hub-cleared' : 'hub-kept' };
      },
    });
    return { hubCleared: outcome.resultRef === 'hub-cleared' };
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

/** For each Hub project id, the PMC project whose latest link event links it (at most one: the link command keeps it so). */
async function activeHolders(db: Prisma.TransactionClient, hubProjectIds: readonly string[]): Promise<Map<string, string>> {
  if (hubProjectIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ projectId: string; hubProjectId: string }>>(Prisma.sql`
    SELECT e."projectId", e."hubProjectId" FROM "DrawingHubLinkEvent" e
    WHERE e."kind" = 'linked' AND e."hubProjectId" IN (${Prisma.join([...hubProjectIds])})
      AND NOT EXISTS (SELECT 1 FROM "DrawingHubLinkEvent" n WHERE n."projectId" = e."projectId" AND n."seq" > e."seq")
    ORDER BY e."projectId"`);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.hubProjectId)) out.set(r.hubProjectId, r.projectId);
  return out;
}

/** Why `projectId` may not be linked to `hubProjectId` now (a 409), or its latest link event when it may. */
async function linkRefusal(db: Prisma.TransactionClient, projectId: string, hubProjectId: string): Promise<LatestEvent | null> {
  const latest = await latestEvent(db, projectId);
  if (latest?.kind === 'linked' && latest.hubProjectId !== hubProjectId) {
    throw new ConflictException({ code: 'hub_linked_elsewhere', message: 'This project is linked to another Hub project. Unlink it first.' });
  }
  const holder = (await activeHolders(db, [hubProjectId])).get(hubProjectId);
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

/** #1118 U7a — a project's active Hub link as screens show it: Hub's id, and the number and name kept at link time. */
export type HubLinkView = { hubProjectId: string; number: string | null; name: string | null; linkedAt: string };

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
