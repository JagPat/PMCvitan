import type { InspectionRecordKind } from '../contracts';
import { guidanceColumnsOf, isGuidedRow, type ItemGuidanceColumns } from './guided-item';

/**
 * THE EVIDENCE RULE for a checklist submit — one statement, asked before the submit's transaction (an early, friendly
 * answer) and again inside it under the inspection's row lock (the authority: adding or removing evidence locks the
 * same row first, `InspectionParticipant.assertEvidenceMutable`).
 *
 * - Any FAILED item needs at least one linked recording (Task 4; a photo before guided inspections, now any recording).
 * - Guided site inspections, step 2b (proposal decision 2, Jagrut 5 Nov 2026: "a pass needs the recordings its item
 *   asks for"): an item with a record spec needs `recordCount` linked recordings of its kind (photo, video or voice)
 *   when it fails, and also when it passes if the spec says `always`. Not applicable needs none.
 * - A failed GUIDED item also needs a reason, typed (its note) or spoken (a linked voice recording). A plain item is
 *   judged as before.
 *
 * A record spec is enforced only for the kinds the app can record ({@link ENFORCED_RECORD_KINDS}): today's checklist
 * screen attaches photos only, so an item asking for a video or a voice note is not held to it until the web walk
 * (guided step 4) ships their capture and adds both kinds here in the same change (Codex 4481441391).
 */

/** The record kinds a submit is held to. Step 4 (the web walk, which records video and voice) adds 'video' and 'voice'. */
export const ENFORCED_RECORD_KINDS: ReadonlySet<InspectionRecordKind> = new Set<InspectionRecordKind>(['photo']);

/** The kind of recording a stored file is, by its type; null for anything else. */
export function recordingKindOf(mime: string): InspectionRecordKind | null {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return null;
}

const KIND_WORDS: Record<InspectionRecordKind, [string, string]> = {
  photo: ['photo', 'photos'],
  video: ['video', 'videos'],
  voice: ['voice note', 'voice notes'],
};

export interface SubmittedItem extends ItemGuidanceColumns {
  id: string;
  name: string;
  /** the state the submit sets */
  state: 'pass' | 'fail' | 'na' | null;
  /** the note the submit sets */
  note: string;
}

/** What the submit must refuse, as the sentences it says (empty: the evidence rule holds). `mimesByItem` holds the
 *  type of every file linked to each item as evidence. Items are judged in the order given (checklist order). */
export function evidenceShortfalls(
  items: SubmittedItem[],
  mimesByItem: ReadonlyMap<string, readonly string[]>,
  enforced: ReadonlySet<InspectionRecordKind> = ENFORCED_RECORD_KINDS,
): string[] {
  const noEvidence: string[] = [];
  const missingRecordings: string[] = [];
  const noReason: string[] = [];
  for (const item of items) {
    if (item.state !== 'pass' && item.state !== 'fail') continue;
    const kinds = (mimesByItem.get(item.id) ?? []).map(recordingKindOf);
    const g = guidanceColumnsOf(item);
    if (item.state === 'fail' && kinds.length === 0) noEvidence.push(item.name);
    const kind = g.recordKind as InspectionRecordKind | null;
    if (kind !== null && enforced.has(kind) && g.recordCount !== null && (item.state === 'fail' || g.recordWhen === 'always')) {
      const have = kinds.filter((k) => k === kind).length;
      if (have < g.recordCount) missingRecordings.push(`${item.name} (${g.recordCount} ${KIND_WORDS[kind][g.recordCount === 1 ? 0 : 1]})`);
    }
    if (item.state === 'fail' && isGuidedRow(g) && item.note.trim() === '' && !kinds.includes('voice')) noReason.push(item.name);
  }
  const out: string[] = [];
  // the sentence a plain checklist has always been refused with, word for word
  if (noEvidence.length > 0) out.push(`A failed item needs linked photo evidence before you can submit: ${noEvidence.join(', ')}`);
  if (missingRecordings.length > 0) out.push(`These items need the recordings they ask for before you can submit: ${missingRecordings.join(', ')}`);
  if (noReason.length > 0) out.push(`A failed item needs a reason, typed or spoken, before you can submit: ${noReason.join(', ')}`);
  return out;
}
