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
  it('can raise a change request and cannot issue drawings', () => {
    expect(can('decision.change', 'consultant')).toBe(true);
    expect(can('drawing.issue', 'consultant')).toBe(false);
  });

  // Phase 6 task 4b, round 3 (Codex P1). This assertion used to read
  // `can('decision.approve','consultant') === false`, and that WAS the whole rule while every
  // decision awaited the client. It is no longer: a decision now names its own decider, which may
  // be any active member, so refusing the consultant at the ROUTE refuses the feature. What is
  // still true — and is what the original test meant — is that a consultant cannot approve a
  // decision that is not theirs; that narrowing moved to the service, where the holder is known.
  // The assertion moves with it rather than being deleted or quietly flipped.
  it('reaches the approve route (a consultant may be a NAMED decider) — the holder narrowing is the service’s', () => {
    expect(can('decision.approve', 'consultant')).toBe(true);
  });
});
