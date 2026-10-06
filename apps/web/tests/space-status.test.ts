import { describe, it, expect } from 'vitest';
import { SEED_ACTIVITIES, SEED_NODES, SEED_PHASES, type Activity } from '@vitan/shared';
import { spaceStatus } from '@/lib/locationTree';

/** B8 — a space's state, phase and counts are derived from the work placed in its subtree. */
const at = (id: string, acts: Activity[] = SEED_ACTIVITIES) => spaceStatus(SEED_NODES, acts, SEED_PHASES, id);

describe('spaceStatus', () => {
  it('counts the whole subtree: an object’s work rolls up to its room and zone', () => {
    // Ground Floor holds Living Room Flooring (room) and Main Door Veneer (an object two levels down)
    expect(at('z-gf')).toEqual({ total: 2, done: 0, blocked: 0, state: 'not-started', phase: 'Finishing' });
    expect(at('r-entrance')).toMatchObject({ total: 1, state: 'not-started' });
  });

  it('blocked wins, then done; the phase is the earliest unfinished one, else the last', () => {
    expect(at('z-terrace')).toEqual({ total: 1, done: 0, blocked: 1, state: 'blocked', phase: 'Services & Waterproofing' });
    expect(at('z-sf')).toEqual({ total: 1, done: 1, blocked: 0, state: 'done', phase: 'Wet Areas & Fittings' });
  });

  it('moves with the work: starting an activity makes its space under way', () => {
    const acts = SEED_ACTIVITIES.map((a) => (a.id === 'ACT-31' ? { ...a, status: 'in-progress' as const } : a));
    expect(at('z-gf', acts)).toMatchObject({ state: 'in-progress', done: 0, total: 2 });
  });

  it('a space with no work placed says none', () => {
    expect(at('z-basement')).toEqual({ total: 0, done: 0, blocked: 0, state: 'none', phase: null });
  });
});
