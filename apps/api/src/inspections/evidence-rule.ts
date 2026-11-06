import { ENFORCED_RECORD_KINDS as SHARED_ENFORCED, judgeEvidence, type RecordingKind } from '@vitan/shared';
import type { InspectionRecordKind } from '../contracts';
import { guideOf, type ItemGuidanceColumns } from './guided-item';

/**
 * THE EVIDENCE RULE for a checklist submit, asked before the submit's transaction (an early, friendly answer) and again
 * inside it under the inspection's row lock (the authority: adding or removing evidence locks the same row first,
 * `InspectionParticipant.assertEvidenceMutable`).
 *
 * The rule itself is the shared judge (`judgeEvidence`, @vitan/shared, guided step 4a), so the web's submit guard asks
 * exactly what this refuses. Here: any failed item needs a linked recording (Task 4); an item's recording spec is held
 * when it fails, and when it passes if the spec says `always` (proposal decision 2, Jagrut 5 Nov 2026); a failed guided
 * item needs a reason, typed or spoken. A spec is enforced only for {@link ENFORCED_RECORD_KINDS} (Codex 4481441391:
 * the web records photos only until step 4b ships video and voice capture and adds both kinds in the same change).
 */

/** The record kinds a submit is held to (the shared set). */
export const ENFORCED_RECORD_KINDS: ReadonlySet<InspectionRecordKind> = SHARED_ENFORCED;

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
  const judged = judgeEvidence(
    items.map((item) => ({
      name: item.name,
      state: item.state,
      note: item.note,
      guide: guideOf(item),
      recordings: (mimesByItem.get(item.id) ?? []).map(recordingKindOf),
    })),
    enforced as ReadonlySet<RecordingKind>,
  );
  const out: string[] = [];
  // the sentence a plain checklist has always been refused with, word for word
  if (judged.noEvidence.length > 0) out.push(`A failed item needs linked photo evidence before you can submit: ${judged.noEvidence.join(', ')}`);
  if (judged.missingRecordings.length > 0) {
    const named = judged.missingRecordings.map((m) => `${m.name} (${m.count} ${KIND_WORDS[m.kind][m.count === 1 ? 0 : 1]})`);
    out.push(`These items need the recordings they ask for before you can submit: ${named.join(', ')}`);
  }
  if (judged.noReason.length > 0) out.push(`A failed item needs a reason, typed or spoken, before you can submit: ${judged.noReason.join(', ')}`);
  return out;
}
