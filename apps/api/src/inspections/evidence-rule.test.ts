import { describe, it, expect } from 'vitest';
import { ENFORCED_RECORD_KINDS, evidenceShortfalls, recordingKindOf, type SubmittedItem } from './evidence-rule';
import type { ItemGuidanceColumns } from './guided-item';
import type { InspectionRecordKind } from '../contracts';

/** Guided site inspections, step 2b — the evidence rule as one statement, judged on its own (no database). */

const plain: ItemGuidanceColumns = { lookAt: null, passRule: null, recordKind: null, recordCount: null, recordWhen: null, recordHint: null };
const item = (id: string, state: SubmittedItem['state'], guide: Partial<ItemGuidanceColumns> = {}, note = ''): SubmittedItem =>
  ({ id, name: id, state, note, ...plain, ...guide });
const photos2Always = { recordKind: 'photo', recordCount: 2, recordWhen: 'always' };
const videoOnFail = { passRule: 'Gaps under 3 mm', recordKind: 'video', recordCount: 1, recordWhen: 'fail' };
const voiceAlways = { recordKind: 'voice', recordCount: 1, recordWhen: 'always' };
const ALL = new Set<InspectionRecordKind>(['photo', 'video', 'voice']);
const files = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe('evidence rule (guided step 2b)', () => {
  it('a file is a photo, a video or a voice note by its type', () => {
    expect(['image/jpeg', 'video/webm', 'audio/ogg', 'application/pdf'].map(recordingKindOf)).toEqual(['photo', 'video', 'voice', null]);
  });

  it('today the app records photos only, so only a photo ask is held; video and voice join with the web walk (step 4)', () => {
    expect([...ENFORCED_RECORD_KINDS]).toEqual(['photo']);
    const items = [item('A', 'pass', photos2Always), item('B', 'fail', videoOnFail, 'gap'), item('C', 'pass', voiceAlways)];
    expect(evidenceShortfalls(items, files({ B: ['image/png'] }))).toEqual([
      'These items need the recordings they ask for before you can submit: A (2 photos)',
    ]);
  });

  it('with every kind held: each item and what it lacks, and a photo is not a voice note', () => {
    const items = [item('A', 'pass', photos2Always), item('B', 'fail', videoOnFail, 'gap'), item('C', 'pass', voiceAlways)];
    expect(evidenceShortfalls(items, files({ A: ['image/png'], B: ['image/png'], C: ['image/png'] }), ALL)).toEqual([
      'These items need the recordings they ask for before you can submit: A (2 photos), B (1 video), C (1 voice note)',
    ]);
    expect(evidenceShortfalls(items, files({ A: ['image/png', 'image/jpeg'], B: ['video/webm'], C: ['audio/webm'] }), ALL)).toEqual([]);
  });

  it('a "fail" ask holds only on a fail; not applicable needs nothing, even on an "always" ask', () => {
    expect(evidenceShortfalls([item('B', 'pass', videoOnFail)], files({}), ALL)).toEqual([]);
    expect(evidenceShortfalls([item('A', 'na', photos2Always), item('C', 'na', voiceAlways)], files({}), ALL)).toEqual([]);
  });

  it('a failed guided item needs a reason, typed (more than spaces) or spoken; a plain failed item needs none', () => {
    const guided = item('E', 'fail', { lookAt: 'Sleeves in place' }, '   ');
    expect(evidenceShortfalls([guided], files({ E: ['image/png'] }))).toEqual([
      'A failed item needs a reason, typed or spoken, before you can submit: E',
    ]);
    expect(evidenceShortfalls([{ ...guided, note: 'Two sleeves missing' }], files({ E: ['image/png'] }))).toEqual([]);
    expect(evidenceShortfalls([guided], files({ E: ['audio/webm'] }))).toEqual([]);
    expect(evidenceShortfalls([item('D', 'fail')], files({ D: ['video/webm'] }))).toEqual([]);
  });

  it('a failed item with nothing linked is refused with the sentence a plain checklist always had', () => {
    expect(evidenceShortfalls([item('D', 'fail'), item('X', 'pass')], files({}))).toEqual([
      'A failed item needs linked photo evidence before you can submit: D',
    ]);
  });
});
