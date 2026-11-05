import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { tallyOpenWork, type OpenWorkCounts } from '../common/open-work';

/**
 * Redbracket ID A4b-2 — the site-visits module's answer to the operator door's list of retired accounts: the visits
 * still OPEN that only their visitor can end or change (`site-visits.service.ts`, "Only the visitor can end their site
 * visit"), per project. An ended or closed visit waits on nobody it names.
 */
@Injectable()
export class SiteVisitsParticipant {
  async openWorkOf(db: Prisma.TransactionClient, userIds: string[]): Promise<OpenWorkCounts> {
    const counts: OpenWorkCounts = new Map();
    if (userIds.length === 0) return counts;
    const open = await db.siteVisit.findMany({
      where: { visitorId: { in: userIds }, status: 'open' },
      select: { projectId: true, visitorId: true },
    });
    for (const v of open) tallyOpenWork(counts, v.visitorId, v.projectId);
    return counts;
  }
}
