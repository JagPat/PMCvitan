import type { Photo } from '@vitan/shared';
import type { OutboxOp, UploadMediaInput } from '@/data/apiGateway';

/** #917: a site photo sent online whose answer was lost, as read from its row on this phone: its op in the outbox
 *  carries the key only. */
export type KeptSitePhoto = Pick<UploadMediaInput, 'mime' | 'data' | 'takenAt' | 'nodeId' | 'dailyLogId'> & { clientKey: string };

/**
 * #482 site photos — the site photos waiting in this device's outbox (picked with no signal), newest first, for the
 * Dashboard to show beside the recorded ones. Read from the outbox itself, so a queued photo shows after a reload
 * and leaves the list the moment its upload is sent and the outbox lets it go. A photo whose online send lost its answer
 * (#917) is queued by its key alone, and shows from `kept`, the photos read from their rows on this phone.
 */
export function queuedSitePhotos(outbox: readonly OutboxOp[], recorded: readonly Photo[] = [], kept: readonly KeptSitePhoto[] = []): Photo[] {
  // a queued upload the server already holds (its reply was lost, so it is still queued) shows once, as recorded
  const held = new Set(recorded.flatMap((p) => (p.clientKey ? [p.clientKey] : [])));
  const queued: Photo[] = [];
  for (const op of outbox) {
    const photo = op.t === 'uploadSitePhoto' ? kept.find((k) => k.clientKey === op.clientKey)
      : op.t === 'uploadMedia' && op.input.kind === 'progress' ? op.input : undefined;
    if (!photo) continue;
    const { mime, data, clientKey, takenAt, nodeId } = photo;
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

/** Whether this device still holds an upload of the photo with this key: a site photo (with its bytes, or by its key
 *  alone) or an evidence photo in the outbox. Such an op leaves the outbox only once the server has answered it, so
 *  while it is there a send may be on its way, and one sent after a delete would add the photo again. */
export function uploadQueued(outbox: readonly OutboxOp[], clientKey: string): boolean {
  return outbox.some((op) => (op.t === 'uploadMedia' && op.input.clientKey === clientKey)
    || ((op.t === 'uploadEvidence' || op.t === 'uploadSitePhoto') && op.clientKey === clientKey));
}

/** Whether a Delete of this photo must wait for its upload: the viewer's own photo (it carries their upload key) whose
 *  upload is still in the outbox or still being sent from this tab (`sending`), or, for an evidence photo, whose bytes
 *  are still pending on this device. Evidence rows live in IndexedDB and come back into the outbox only once they have
 *  been read (`pendingEvidence` is null until then), so until that read an own evidence photo waits too. */
export function deleteWaitsForUpload(
  photo: { kind: string; clientKey?: string },
  outbox: readonly OutboxOp[],
  pendingEvidence: readonly string[] | null,
  sending: readonly string[] = [],
): boolean {
  const key = photo.clientKey;
  if (!key) return false;
  if (sending.includes(key) || uploadQueued(outbox, key)) return true;
  return photo.kind === 'inspection' && (pendingEvidence === null || pendingEvidence.includes(key));
}
