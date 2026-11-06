import { UPLOAD_IMAGE_MIMES } from '@/lib/shrinkPhoto';
import { judgeEvidence, recordingKindOf, type ChecklistItem, type EvidenceShortfalls, type RecordingKind } from '@vitan/shared';

/**
 * Guided site inspections step 4a (unit 3b) — what the phone counts as an item's recordings, so the submit guard asks
 * the server's evidence rule (`judgeEvidence`, @vitan/shared) about the same files the server will count.
 *
 * Every counted recording comes from a source that is the truth for it, and nothing is kept in step by hand
 * (notes/inspections/guided/s4/a/u3-design.md):
 * - a file the server holds and serves to this viewer: its served entry, by its served kind (`evidenceKinds`);
 * - a file the server holds and serves to this viewer by its kind alone: `hiddenEvidenceKinds`;
 * - a capture still waiting to upload, from any tab: its durable row (`status: 'pending'`), read when the guard runs,
 *   counted by its own type (only a type the upload sends), and only when the item is served with its keys and no
 *   served entry carries its replay key (`evidenceClientKeys`) — one file, counted once. The store counts these only
 *   for a submit queued behind their uploads (offline); online a submit is sent at once, so they do not count there.
 *
 * Never counted: a local `data:` thumbnail (its row is the record, and a refused or deleted capture has no pending
 * row), the legacy `photos` counter, a failed (refused) row, a row on an item served without keys.
 *
 * Fail closed, never open: an upload the server accepted leaves its durable row at once, and until a read that holds the
 * file is applied the phone counts one recording too few. The guard is then stricter than the server for that moment,
 * never looser. Online, the guard ends it itself: on a shortfall it runs one fresh read and judges again before it
 * says anything. Offline, the message stands until the next applied read (reconnecting).
 */

/** A durable evidence row as the count needs it (pending rows only). */
export interface PendingCapture {
  clientKey: string;
  inspectionId: string;
  inspectionItemId: string;
  mime: string;
}

export interface ItemRecordings {
  /** false when the server serves no kinds (an API older than step 4a): the phone then judges no recording counts */
  kindsKnown: boolean;
  /** the kind of every recording the server will count (null: a file of no recording kind) */
  recordings: Array<RecordingKind | null>;
}

/** The recordings the server will count for `it`, given the durable rows still waiting to upload. */
export function itemRecordings(it: ChecklistItem, inspectionId: string, pending: readonly PendingCapture[]): ItemRecordings {
  const kinds = it.evidenceKinds;
  const kindsKnown = Array.isArray(kinds);
  // served without keys (an API older than unit 3a), a waiting row cannot be told from its served file: none counts
  const keysKnown = Array.isArray(it.evidenceClientKeys);
  const servedKeys = new Set((it.evidenceClientKeys ?? []).filter((k): k is string => typeof k === 'string'));
  const recordings: Array<RecordingKind | null> = [];
  // a served entry keeps its position in `evidence`; a local thumbnail (`data:`) is never served, so it is skipped
  (it.evidence ?? []).forEach((url, k) => {
    if (url.startsWith('data:')) return;
    recordings.push(kindsKnown ? (kinds[k] ?? null) : null);
  });
  recordings.push(...(it.hiddenEvidenceKinds ?? []));
  if (it.id && keysKnown) {
    for (const p of pending) {
      if (p.inspectionId !== inspectionId || p.inspectionItemId !== it.id || servedKeys.has(p.clientKey)) continue;
      // only a type the upload sends counts (a row kept before the type check would be refused on upload)
      if (!UPLOAD_IMAGE_MIMES.includes(p.mime)) continue;
      recordings.push(recordingKindOf(p.mime));
    }
  }
  return { kindsKnown, recordings };
}

/**
 * Judge a checklist's items as the server will. An item served with its kinds is judged by the shared rule in full.
 * An item served without them (an API older than step 4a) is judged only by the rule the phone held before: a failed
 * item needs evidence. Its recording counts and its reason are left to the server, since the phone cannot tell a photo
 * from a video there, and never guesses (Codex 4492224945).
 */
export function judgeChecklist(
  items: readonly ChecklistItem[],
  inspectionId: string,
  pending: readonly PendingCapture[],
): EvidenceShortfalls {
  const known: Parameters<typeof judgeEvidence>[0][number][] = [];
  const noEvidence: string[] = [];
  for (const it of items) {
    const { kindsKnown, recordings } = itemRecordings(it, inspectionId, pending);
    // the one rule both kinds of item share, in checklist order (the shared judge states it the same way)
    if (it.state === 'fail' && recordings.length === 0) noEvidence.push(it.name);
    if (kindsKnown) known.push({ name: it.name, state: it.state, note: it.note, guide: it.guide ?? null, recordings });
  }
  const judged = judgeEvidence(known);
  return { noEvidence, missingRecordings: judged.missingRecordings, noReason: judged.noReason };
}

/** Whether the judge found anything the server would refuse. */
export function evidenceShortfall(s: EvidenceShortfalls): boolean {
  return s.noEvidence.length > 0 || s.missingRecordings.length > 0 || s.noReason.length > 0;
}
