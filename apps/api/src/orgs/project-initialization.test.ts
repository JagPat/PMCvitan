import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  lockInitializationDisplayIds,
  runSerializableProjectInit,
  validateInitializationGraph,
  type InitializationGraph,
} from './project-initialization';

const validGraph = (): InitializationGraph => ({
  nodes: [
    { source: 'module Villa copy 1', key: 'zone', parentKey: null, kind: 'zone' },
    { source: 'module Villa copy 1', key: 'room', parentKey: 'zone', kind: 'room' },
    { source: 'module Villa copy 1', key: 'door', parentKey: 'room', kind: 'element' },
  ],
  phases: [{ source: 'module Villa copy 1', name: 'Structure', order: 1, plannedStart: 2, plannedEnd: 8 }],
  activities: [{ source: 'module Villa copy 1', name: 'Install door', nodeKey: 'door', phaseName: 'Structure' }],
  inspections: [{ source: 'module Villa copy 1', title: 'Door QA', nodeKey: 'door' }],
});

function expectInvalid(graph: InitializationGraph, ...fragments: string[]): void {
  try {
    validateInitializationGraph('project initialization', graph);
    throw new Error('expected validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    for (const fragment of fragments) expect((error as Error).message).toContain(fragment);
  }
}

describe('validateInitializationGraph', () => {
  it('accepts a valid zone -> room -> element graph', () => {
    expect(() => validateInitializationGraph('project initialization', validGraph())).not.toThrow();
  });

  it('rejects duplicate node keys in one source', () => {
    const graph = validGraph();
    graph.nodes.push({ source: 'module Villa copy 1', key: 'room', parentKey: 'zone', kind: 'room' });
    expectInvalid(graph, 'module Villa copy 1', 'room');
  });

  it('rejects an orphan parent', () => {
    const graph = validGraph();
    graph.nodes[1]!.parentKey = 'missing-zone';
    expectInvalid(graph, 'module Villa copy 1', 'room', 'missing-zone');
  });

  it('rejects a self-parent', () => {
    const graph = validGraph();
    graph.nodes[1]!.parentKey = 'room';
    expectInvalid(graph, 'module Villa copy 1', 'room');
  });

  it('rejects a multi-node cycle', () => {
    const graph = validGraph();
    graph.nodes = [
      { source: 'module Cycle copy 1', key: 'a', parentKey: 'b', kind: 'room' },
      { source: 'module Cycle copy 1', key: 'b', parentKey: 'a', kind: 'room' },
    ];
    expectInvalid(graph, 'module Cycle copy 1', 'a', 'cycle');
  });

  // Nested locations (phase-6-task-2): the rule replaces the fixed map — a room may sit
  // under a room, an element under a room OR directly under a zone; an element stays a
  // LEAF and a zone stays top-level-only; depth is bounded at 5 with the level stated.
  it('accepts an element directly under a zone', () => {
    const graph = validGraph();
    graph.nodes[2]!.parentKey = 'zone';
    expect(() => validateInitializationGraph('project initialization', graph)).not.toThrow();
  });

  it('accepts a room nested under another room', () => {
    const graph = validGraph();
    graph.nodes.splice(2, 0, { source: 'module Villa copy 1', key: 'pour', parentKey: 'room', kind: 'room' });
    graph.nodes[3]!.parentKey = 'pour';
    expect(() => validateInitializationGraph('project initialization', graph)).not.toThrow();
  });

  it('rejects a room under an element (an element is a leaf)', () => {
    const graph = validGraph();
    graph.nodes.push({ source: 'module Villa copy 1', key: 'sub', parentKey: 'door', kind: 'room' });
    expectInvalid(graph, 'module Villa copy 1', 'sub', 'door');
  });

  it('rejects an element under an element (an element is a leaf)', () => {
    const graph = validGraph();
    graph.nodes.push({ source: 'module Villa copy 1', key: 'lock', parentKey: 'door', kind: 'element' });
    expectInvalid(graph, 'module Villa copy 1', 'lock', 'door');
  });

  it('rejects a zone with a parent', () => {
    const graph = validGraph();
    graph.nodes.push({ source: 'module Villa copy 1', key: 'z2', parentKey: 'room', kind: 'zone' });
    expectInvalid(graph, 'module Villa copy 1', 'z2', 'room');
  });

  it('accepts five levels and rejects the sixth, with the level stated', () => {
    const chain = (depth: number): InitializationGraph => ({
      nodes: [
        { source: 'module Tower copy 1', key: 'z', parentKey: null, kind: 'zone' },
        ...Array.from({ length: depth - 1 }, (_, i) => ({
          source: 'module Tower copy 1',
          key: `r${i}`,
          parentKey: i === 0 ? 'z' : `r${i - 1}`,
          kind: 'room' as const,
        })),
      ],
      phases: [], activities: [], inspections: [],
    });
    expect(() => validateInitializationGraph('project initialization', chain(5))).not.toThrow();
    expectInvalid(chain(6), 'module Tower copy 1', 'level 6', '5 levels');
  });

  it('counts the graft offset: a zone-anchored source starts its roots at level 2', () => {
    const graph: InitializationGraph = {
      nodes: [
        { source: 'module Wing copy 1', key: 'r0', parentKey: null, kind: 'room', rootParentKind: 'zone' },
        { source: 'module Wing copy 1', key: 'r1', parentKey: 'r0', kind: 'room' },
        { source: 'module Wing copy 1', key: 'r2', parentKey: 'r1', kind: 'room' },
        { source: 'module Wing copy 1', key: 'r3', parentKey: 'r2', kind: 'room' },
      ],
      phases: [], activities: [], inspections: [],
    };
    expect(() => validateInitializationGraph('project initialization', graph)).not.toThrow(); // levels 2..5
    graph.nodes.push({ source: 'module Wing copy 1', key: 'r4', parentKey: 'r3', kind: 'room' });
    expectInvalid(graph, 'module Wing copy 1', 'r4', 'level 6');
  });

  it.each([
    ['activity', (graph: InitializationGraph) => { graph.activities[0]!.nodeKey = 'missing-node'; }],
    ['inspection', (graph: InitializationGraph) => { graph.inspections[0]!.nodeKey = 'missing-node'; }],
  ])('rejects a missing %s nodeKey', (_kind, mutate) => {
    const graph = validGraph();
    mutate(graph);
    expectInvalid(graph, 'module Villa copy 1', 'missing-node');
  });

  it('rejects a duplicate phase name within one source', () => {
    const graph = validGraph();
    graph.phases.push({ source: 'module Villa copy 1', name: ' structure ', order: 1, plannedStart: 2, plannedEnd: 8 });
    expectInvalid(graph, 'module Villa copy 1', 'structure');
  });

  it('rejects a missing activity phaseName', () => {
    const graph = validGraph();
    graph.activities[0]!.phaseName = 'Finishing';
    expectInvalid(graph, 'module Villa copy 1', 'Finishing');
  });

  it('coalesces matching normalized phase definitions across sources', () => {
    const graph = validGraph();
    graph.phases.push({ source: 'source project Ambli', name: ' structure ', order: 1, plannedStart: 2, plannedEnd: 8 });
    expect(() => validateInitializationGraph('project initialization', graph)).not.toThrow();
  });

  it('rejects conflicting same-name phase windows across sources', () => {
    const graph = validGraph();
    graph.phases.push({ source: 'source project Ambli', name: ' structure ', order: 1, plannedStart: 3, plannedEnd: 9 });
    expectInvalid(graph, 'source project Ambli', 'structure');
  });
});

describe('runSerializableProjectInit', () => {
  const p2034 = () => new Prisma.PrismaClientKnownRequestError('serialization conflict', {
    code: 'P2034',
    clientVersion: 'test',
  });
  const p2002 = (modelName: string, target: string | string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName, target },
    });

  it('retries P2034 twice and then succeeds with Serializable transactions', async () => {
    const run = vi.fn(async () => 'created');
    const transaction = vi.fn()
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockImplementationOnce(run);
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, run, sleep, () => 0)).resolves.toBe('created');

    expect(transaction).toHaveBeenCalledTimes(3);
    for (const [, options] of transaction.mock.calls) {
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 75);
  });

  it('stops after the third P2034 attempt', async () => {
    const transaction = vi.fn().mockRejectedValue(p2034());
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, vi.fn(), sleep, () => 0)).rejects.toMatchObject({ code: 'P2034' });
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry another Prisma error code', async () => {
    const error = Object.assign(new Error('unique conflict'), { code: 'P2002' });
    const transaction = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, vi.fn(), sleep)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a plain P2034-shaped participant error', async () => {
    const error = Object.assign(new Error('participant fault'), { code: 'P2034' });
    const transaction = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, vi.fn(), sleep)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['Activity', 'Activity_pkey'],
    ['Inspection', ['id']],
  ])('retries a genuine %s display-ID primary-key conflict after atomic rollback', async (modelName, target) => {
    const conflict = p2002(modelName, target);
    const run = vi.fn(async () => 'created');
    const transaction = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(run);
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, run, sleep, () => 0)).resolves.toBe('created');

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it.each([
    ['another model primary key', p2002('Project', 'Project_pkey')],
    ['an Activity non-primary unique constraint', p2002('Activity', ['projectId', 'id'])],
    ['a P2002-shaped plain object', Object.assign(new Error('unique conflict'), { code: 'P2002', meta: { modelName: 'Activity', target: ['id'] } })],
  ])('does not retry %s', async (_label, error) => {
    const transaction = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, vi.fn(), sleep)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('bounds retry delays at 25-50 ms then 75-100 ms', async () => {
    const transaction = vi.fn().mockRejectedValue(p2034());
    const sleep = vi.fn(async () => undefined);

    await expect(runSerializableProjectInit({ $transaction: transaction } as never, vi.fn(), sleep, () => 0.999999)).rejects.toMatchObject({ code: 'P2034' });
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });
});

describe('lockInitializationDisplayIds', () => {
  it('takes ACT then INSP transaction advisory locks in fixed order', async () => {
    const executeRaw = vi.fn(async () => 0);

    await lockInitializationDisplayIds({ $executeRaw: executeRaw } as never);

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw.mock.calls.map(([query]) => query.values[0])).toEqual([
      'project-init-display-id:activity',
      'project-init-display-id:inspection',
    ]);
  });
});
