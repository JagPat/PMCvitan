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
 */

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
export function evidenceShortfalls(items: SubmittedItem[], mimesByItem: ReadonlyMap<string, readonly string[]>): string[] {
  const noEvidence: string[] = [];
  const missingRecordings: string[] = [];
  const noReason: string[] = [];
  for (const item of items) {
    if (item.state !== 'pass' && item.state !== 'fail') continue;
    const kinds = (mimesByItem.get(item.id) ?? []).map(recordingKindOf);
    const g = guidanceColumnsOf(item);
    if (item.state === 'fail' && kinds.length === 0) noEvidence.push(item.name);
    if (g.recordKind !== null && g.recordCount !== null && (item.state === 'fail' || g.recordWhen === 'always')) {
      const kind = g.recordKind as InspectionRecordKind;
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
