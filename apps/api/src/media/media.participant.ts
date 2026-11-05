import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The media module's transaction-bound WORKFLOW PARTICIPANT. Another module's write that must know about
 * photos asks here, on its own transaction, instead of reading the media-owned `Media` table (#884). A leaf
 * provider (no injected dependencies), so it creates no DI cycle with the services that call it.
 */
@Injectable()
export class MediaParticipant {
  /** How many photos are filed on `nodeIds` — the nodes delete passes the draft places it would remove, and
   *  refuses while any carries a photo (the Media FK would otherwise unfile it into the team view). */
  countOnPlaces(tx: Prisma.TransactionClient, params: { projectId: string; nodeIds: readonly string[] }): Promise<number> {
    const { projectId, nodeIds } = params;
    if (nodeIds.length === 0) return Promise.resolve(0);
    return tx.media.count({ where: { projectId, nodeId: { in: [...nodeIds] } } });
  }

  /** #482 site photos — how many progress photos are filed on the day's log `dailyLogId`, read on the caller's
   *  transaction: a submit asks here, under the log row's lock, so the count it stores is the server's own. */
  countFiledOnLog(tx: Prisma.TransactionClient, params: { projectId: string; dailyLogId: string }): Promise<number> {
    const { projectId, dailyLogId } = params;
    return tx.media.count({ where: { projectId, dailyLogId, kind: 'progress' } });
  }

  /** Guided site inspections, step 2b — the type of each of these files, read on the caller's transaction: an inspection
   *  submit asks here, under the inspection row's lock, which of its items' linked evidence is a photo, a video or a voice
   *  note. A file not in this project is left out. */
  async mimesOf(tx: Prisma.TransactionClient, params: { projectId: string; mediaIds: readonly string[] }): Promise<Map<string, string>> {
    const { projectId, mediaIds } = params;
    if (mediaIds.length === 0) return new Map();
    const rows = await tx.media.findMany({ where: { projectId, id: { in: [...mediaIds] } }, select: { id: true, mime: true } });
    return new Map(rows.map((r) => [r.id, r.mime]));
  }
}
