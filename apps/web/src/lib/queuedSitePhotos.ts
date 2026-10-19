import type { Photo } from '@vitan/shared';
import type { OutboxOp } from '@/data/apiGateway';

/**
 * #482 site photos — the site photos waiting in this device's outbox (picked with no signal), newest first, for the
 * Dashboard to show beside the recorded ones. Read from the outbox itself, so a queued photo shows after a reload
 * and leaves the list the moment its upload is sent and the outbox lets it go.
 */
export function queuedSitePhotos(outbox: readonly OutboxOp[], recorded: readonly Photo[] = []): Photo[] {
  // a queued upload the server already holds (its reply was lost, so it is still queued) shows once, as recorded
  const held = new Set(recorded.flatMap((p) => (p.clientKey ? [p.clientKey] : [])));
  const queued: Photo[] = [];
  for (const op of outbox) {
    if (op.t !== 'uploadMedia' || op.input.kind !== 'progress') continue;
    const { mime, data, clientKey, takenAt, nodeId } = op.input;
    if (clientKey && held.has(clientKey)) continue;
    queued.unshift({
      id: `queued-${clientKey ?? queued.length}`,
      url: `data:${mime};base64,${data}`,
      kind: 'progress',
      ...(takenAt ? { takenAt } : {}),
      ...(nodeId ? { nodeId } : {}),
    });
  }
  return queued;
}
