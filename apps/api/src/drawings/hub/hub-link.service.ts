import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import type { AuthUser } from '../../common/auth';
import { readHubClientConfig, type HubClientConfig } from './hub-config';
import { hubCallRetryable, listHubProjects, type HubCallFailure, type HubProject } from './hub-projects';

/**
 * #1118 U7a L1a — the read side of linking a PMC project to its Hub project (notes/hub/u7a/plan.md §4): the Hub projects
 * PMC's office token reaches, for the link screen, and the project's active link as PMC's own events record it. The
 * link and unlink commands come in L1b; nothing here writes, in PMC or in Hub.
 *
 * Who: an owner or admin of `HUB_ORG_ID`'s company only, for a live project of that company. Closed (any of the four
 * client variables unset or malformed) or another company: 404, as if the route did not exist. A member who is not an
 * owner or admin: 403. Hub unreachable, slow or 5xx: 503 the screen can retry; Hub refused the office token: 503 that
 * needs an operator; Hub refused the call: 502. Nothing here logs; no answer carries the token, a Hub URL, or Hub's
 * words.
 */

export type HubProjectChoice = HubProject & { linked: 'this' | 'other' | null };

function hubFailure(f: { failure: HubCallFailure; status?: number }): HttpException {
  if (f.failure === 'refused') {
    return new ServiceUnavailableException({ code: 'hub_key_refused', message: "Hub refused PMC's key. An operator needs to renew it." });
  }
  if (hubCallRetryable(f.failure, f.status)) {
    return new ServiceUnavailableException({ code: 'hub_unavailable', message: "Hub isn't answering. Try again in a moment." });
  }
  return new BadGatewayException({ code: 'hub_refused', message: 'Hub could not do this. Try again later.' });
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
