import type { Prisma } from '@prisma/client';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4c — the PLATFORM's notification-feed query. `Notification` and
 * `DomainEvent` are platform-owned, so this is where the feed is read.
 *
 * The snapshot runs it inside the SAME REPEATABLE READ transaction as the decisions module's own
 * query for the viewer's decision slice (§A.3 obligation 7, "the readers"; #558's review round 1,
 * finding 6, and round 2, finding 4). A kinded notice's visibility is judged against its decision,
 * so the notice and the decision must be read in one snapshot: two independent READ COMMITTED reads
 * let a withdrawal commit between them and a notice be authorized against the decision as it stood
 * before. Two owner queries in one snapshot, and no cross-module join.
 */
type FeedClient = Pick<Prisma.TransactionClient, 'notification' | 'domainEvent'>;

/** A feed row as stored: kind-less rows carry no event; kinded rows are bound to one. */
export type FeedNotice = Awaited<ReturnType<typeof readNotificationFeed>>[number];

/** The project's notices, newest first (the delivered order). */
export function readNotificationFeed(client: FeedClient, projectId: string) {
  return client.notification.findMany({ where: { projectId }, orderBy: { at: 'desc' } });
}

/** The events kinded notices are bound to, by id: the type, the payload and the catalog key they
 *  were emitted under (`dispatchIntent.effectKey`). */
export async function readFeedEvents(
  client: FeedClient,
  projectId: string,
  eventIds: readonly string[],
): Promise<Map<string, { eventType: string; payload: unknown; effectKey: string | null }>> {
  if (eventIds.length === 0) return new Map();
  const rows = await client.domainEvent.findMany({
    where: { projectId, eventId: { in: [...eventIds] } },
    select: { eventId: true, eventType: true, payload: true, dispatchIntent: true },
  });
  return new Map(rows.map((e) => {
    const intent = e.dispatchIntent as { effectKey?: unknown } | null;
    const effectKey = intent && typeof intent.effectKey === 'string' ? intent.effectKey : null;
    return [e.eventId, { eventType: e.eventType, payload: e.payload, effectKey }];
  }));
}
