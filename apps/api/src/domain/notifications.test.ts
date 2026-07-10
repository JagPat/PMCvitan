import { describe, it, expect } from 'vitest';
import { pendingDecisionNotice, isPendingDecisionNotice } from './notifications';

describe('pending-decision notice (AUTH-02 leak guard)', () => {
  it('builds and recognises its own text (filter can never drift from producer)', () => {
    const text = pendingDecisionNotice('Master Bath Flooring');
    expect(text).toBe('Decision awaiting approval: Master Bath Flooring');
    expect(isPendingDecisionNotice(text)).toBe(true);
  });

  it('does not match unrelated notifications (kept for non-pmc/client roles)', () => {
    expect(isPendingDecisionNotice('Client approved Master Bath Flooring — Italian Marble')).toBe(false);
    expect(isPendingDecisionNotice('Inspection approved. Contractor and client notified.')).toBe(false);
    expect(isPendingDecisionNotice('Mismatch flagged on DL-014')).toBe(false);
  });
});
