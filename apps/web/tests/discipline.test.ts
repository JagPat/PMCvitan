import { describe, it, expect } from 'vitest';
import { drawingDisciplineFor, can } from '@vitan/shared';

describe('drawingDisciplineFor — consultant discipline → drawing register bucket', () => {
  it('maps MEP-family disciplines (incl. lighting/plumbing/HVAC) to the MEP set', () => {
    for (const d of ['mep', 'plumbing', 'electrical', 'hvac', 'lighting']) {
      expect(drawingDisciplineFor(d)).toBe('mep');
    }
  });
  it('maps architect/interior/facade to architectural, structural to structural', () => {
    expect(drawingDisciplineFor('architect')).toBe('architectural');
    expect(drawingDisciplineFor('interior')).toBe('architectural');
    expect(drawingDisciplineFor('facade')).toBe('architectural');
    expect(drawingDisciplineFor('structural')).toBe('structural');
  });
  it('falls back to "other" for anything unlisted / undefined', () => {
    expect(drawingDisciplineFor('acoustics')).toBe('other');
    expect(drawingDisciplineFor(undefined)).toBe('other');
    expect(drawingDisciplineFor('landscape')).toBe('other');
  });
});

describe('consultant permissions', () => {
  it('can raise a change request but cannot approve decisions or issue drawings', () => {
    expect(can('decision.change', 'consultant')).toBe(true);
    expect(can('decision.approve', 'consultant')).toBe(false);
    expect(can('drawing.issue', 'consultant')).toBe(false);
  });
});
