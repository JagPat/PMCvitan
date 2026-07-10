import { describe, it, expect } from 'vitest';
import { nextSeqId } from './ids';

describe('nextSeqId', () => {
  it('increments past the highest numeric suffix', () => {
    expect(nextSeqId('DL-', ['DL-014', 'DL-020', 'DL-003'])).toBe('DL-021');
  });
  it('starts at 001 when none exist', () => {
    expect(nextSeqId('ACT-', [])).toBe('ACT-001');
  });
  it('ignores other prefixes and malformed suffixes', () => {
    expect(nextSeqId('ACT-', ['DL-050', 'ACT-2', 'ACT-xx', 'INSP-9'])).toBe('ACT-003');
  });
});
