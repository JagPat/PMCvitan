import { describe, expect, it } from 'vitest';
import type { Decision, ProjectNode } from '@vitan/shared';
import { groupDecisions, subtreeIds } from '@/lib/locationTree';

describe('location navigation scaling', () => {
  it('walks a deeply nested subtree without exhausting the call stack', () => {
    const nodes: ProjectNode[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `n${i}`, parentId: i ? `n${i - 1}` : null, name: `Node ${i}`, kind: 'room', order: i,
    }));
    const ids = [...subtreeIds(nodes, 'n0')];
    expect(ids).toHaveLength(nodes.length);
    expect(ids[0]).toBe('n0');
    expect(ids.at(-1)).toBe('n19999');
  });

  it('groups a large register without scanning all locations for every decision', () => {
    let idReads = 0;
    const size = 1_000;
    const nodes: ProjectNode[] = Array.from({ length: size }, (_, i) => ({
      get id() { idReads += 1; return `n${i}`; },
      parentId: null, name: `Room ${i}`, kind: 'room', order: i,
    }));
    const decisions = nodes.map((_, i) => ({
      id: `d${i}`, nodeId: `n${i}`, status: 'pending', room: '',
    } as Decision));
    const groups = groupDecisions(decisions, nodes, 'room');
    expect(groups).toHaveLength(size);
    expect(groups.every((g) => g.counts.pending === 1 && g.rows.length === 1)).toBe(true);
    // An operation budget, not a wall-clock threshold: independent of CI machine speed.
    expect(idReads).toBeLessThanOrEqual(size * 10);
  });

  it.each(['flat', 'status'] as const)('%s grouping does not read unused location data', (mode) => {
    const nodes: ProjectNode[] = [{
      get id(): string { throw new Error('Unnecessary location lookup'); },
      parentId: null, name: 'Room', kind: 'room', order: 0,
    }];
    const groups = groupDecisions([
      { id: 'd1', nodeId: 'n1', status: 'pending', room: '' } as Decision,
    ], nodes, mode);
    expect(groups[0].counts.pending).toBe(1);
    expect(groups[0].rows[0].subLabel).toBe('');
  });
});
