import type { ItemGuide } from './types';

/**
 * Guided site inspections — THE EVIDENCE RULE for a checklist submit, judged the same on the phone and on the server.
 * The API asks it before and inside the submit's transaction and refuses with its sentences; the web asks it before it
 * sends (or queues) a submit, so a submit the phone holds is never refused by a rule the phone did not know (a refusal
 * is final for a queued act).
 *
 * - Any FAILED item needs at least one linked recording.
 * - An item whose guidance asks for recordings needs that many of that kind when it fails, and also when it passes if
 *   the guidance says `always`. Not applicable needs none.
 * - A failed GUIDED item also needs a reason, typed (its note) or spoken (a linked voice recording).
 *
 * A recording spec is enforced only for the kinds the app can record ({@link ENFORCED_RECORD_KINDS}).
 */

export type RecordingKind = 'photo' | 'video' | 'voice';

/** The record kinds a submit is held to. The web walk adds 'video' and 'voice' with their capture (guided step 4b). */
export const ENFORCED_RECORD_KINDS: ReadonlySet<RecordingKind> = new Set<RecordingKind>(['photo']);

/** One item as the rule judges it: the state and note being submitted, its guidance, and the kind of each linked
 *  recording (null for a file that is no recording kind). */
export interface JudgedItem {
  name: string;
  state: 'pass' | 'fail' | 'na' | null;
  note: string;
  guide: ItemGuide | null;
  recordings: ReadonlyArray<RecordingKind | null>;
}

export interface EvidenceShortfalls {
  /** failed items with no linked recording at all */
  noEvidence: string[];
  /** items short of the recordings their guidance asks for */
  missingRecordings: Array<{ name: string; kind: RecordingKind; count: number; have: number }>;
  /** failed guided items with no reason, typed or spoken */
  noReason: string[];
}

/** Whether the rule holds (nothing is short). */
export function evidenceHolds(s: EvidenceShortfalls): boolean {
  return s.noEvidence.length === 0 && s.missingRecordings.length === 0 && s.noReason.length === 0;
}

/** What one item still needs for its guidance's recordings, in the state given (null: nothing asked, or not enforced). */
export function recordingsAsked(
  item: Pick<JudgedItem, 'state' | 'guide' | 'recordings'>,
  enforced: ReadonlySet<RecordingKind> = ENFORCED_RECORD_KINDS,
): { kind: RecordingKind; count: number; have: number } | null {
  const spec = item.guide?.record ?? null;
  if (spec === null || !enforced.has(spec.kind)) return null;
  if (item.state !== 'fail' && !(item.state === 'pass' && spec.when === 'always')) return null;
  return { kind: spec.kind, count: spec.count, have: item.recordings.filter((k) => k === spec.kind).length };
}

/** Judge a submit's items, in checklist order. */
export function judgeEvidence(
  items: readonly JudgedItem[],
  enforced: ReadonlySet<RecordingKind> = ENFORCED_RECORD_KINDS,
): EvidenceShortfalls {
  const out: EvidenceShortfalls = { noEvidence: [], missingRecordings: [], noReason: [] };
  for (const item of items) {
    if (item.state !== 'pass' && item.state !== 'fail') continue;
    if (item.state === 'fail' && item.recordings.length === 0) out.noEvidence.push(item.name);
    const asked = recordingsAsked(item, enforced);
    if (asked && asked.have < asked.count) out.missingRecordings.push({ name: item.name, ...asked });
    if (item.state === 'fail' && item.guide !== null && item.note.trim() === '' && !item.recordings.includes('voice')) out.noReason.push(item.name);
  }
  return out;
}
