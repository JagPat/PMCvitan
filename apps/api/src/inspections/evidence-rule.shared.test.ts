import { describe, expect, it } from 'vitest';
import { judgeEvidence, recordingsAsked, evidenceHolds, ENFORCED_RECORD_KINDS, type ItemGuide, type JudgedItem } from '@vitan/shared';
import { ENFORCED_RECORD_KINDS as API_ENFORCED } from './evidence-rule';

/** Guided step 4a — the shared judge the web's submit guard and this API's refusal both ask. */
const g = (kind: 'photo' | 'video' | 'voice', count: number, when: 'always' | 'fail'): ItemGuide => ({ lookAt: null, passRule: null, record: { kind, count, when, hint: null } });
const item = (over: Partial<JudgedItem>): JudgedItem => ({ name: 'X', state: 'pass', note: '', guide: null, recordings: [], ...over });

describe('shared evidence rule', () => {
  it('is one enforced set on both sides, photo only until step 4b', () => {
    expect(API_ENFORCED).toBe(ENFORCED_RECORD_KINDS);
    expect([...ENFORCED_RECORD_KINDS]).toEqual(['photo']);
  });

  it('judges every branch with structured results', () => {
    const s = judgeEvidence([
      item({ name: 'A', state: 'fail' }),
      item({ name: 'B', state: 'pass', guide: g('photo', 2, 'always'), recordings: ['photo'] }),
      item({ name: 'C', state: 'fail', guide: g('photo', 1, 'fail'), recordings: ['photo'] }),
      item({ name: 'D', state: 'fail', guide: g('photo', 1, 'fail'), recordings: ['voice', 'photo'] }),
      item({ name: 'E', state: 'na', guide: g('photo', 3, 'always') }),
    ]);
    expect(s).toEqual({
      noEvidence: ['A'],
      missingRecordings: [{ name: 'B', kind: 'photo', count: 2, have: 1 }],
      noReason: ['C'],
    });
    expect(evidenceHolds(s)).toBe(false);
  });

  it('asks a recording only in the state that holds it, and only for an enforced kind', () => {
    expect(recordingsAsked(item({ state: 'pass', guide: g('photo', 1, 'fail') }))).toBeNull();
    expect(recordingsAsked(item({ state: 'fail', guide: g('photo', 1, 'fail') }))).toEqual({ kind: 'photo', count: 1, have: 0 });
    expect(recordingsAsked(item({ state: 'pass', guide: g('video', 1, 'always') }))).toBeNull();
    expect(recordingsAsked(item({ state: 'pass', guide: g('video', 1, 'always') }), new Set(['video']))).toEqual({ kind: 'video', count: 1, have: 0 });
  });
});
