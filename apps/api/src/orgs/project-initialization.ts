import { BadRequestException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

type NodeKind = 'zone' | 'room' | 'element';

export interface InitializationNode {
  source: string;
  key: string;
  parentKey: string | null;
  kind: NodeKind;
  rootParentKind?: NodeKind | null;
}

export interface InitializationPhase {
  source: string;
  name: string;
  order: number;
  plannedStart: number;
  plannedEnd: number;
}

export interface InitializationActivity {
  source: string;
  name: string;
  nodeKey?: string;
  phaseName?: string;
}

export interface InitializationInspection {
  source: string;
  title: string;
  nodeKey?: string;
}

export interface InitializationGraph {
  nodes: InitializationNode[];
  phases: InitializationPhase[];
  activities: InitializationActivity[];
  inspections: InitializationInspection[];
}

const normalizedName = (name: string): string => name.trim().toLocaleLowerCase('en-US');

const invalid = (label: string, source: string, detail: string): never => {
  throw new BadRequestException(`${label}: ${source}: ${detail}`);
};

export function validateInitializationGraph(label: string, graph: InitializationGraph): void {
  const nodesBySource = new Map<string, Map<string, InitializationNode>>();
  for (const node of graph.nodes) {
    const nodes = nodesBySource.get(node.source) ?? new Map<string, InitializationNode>();
    if (nodes.has(node.key)) invalid(label, node.source, `duplicate node key "${node.key}"`);
    nodes.set(node.key, node);
    nodesBySource.set(node.source, nodes);
  }

  const allowedParent: Record<NodeKind, NodeKind | null> = { zone: null, room: 'zone', element: 'room' };
  for (const [source, nodes] of nodesBySource) {
    for (const node of nodes.values()) {
      if (node.parentKey === node.key) invalid(label, source, `node "${node.key}" cannot parent itself`);
      const parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
      if (node.parentKey && !parent) invalid(label, source, `node "${node.key}" has missing parent "${node.parentKey}"`);
    }

    const colors = new Map<string, 'visiting' | 'visited'>();
    const visit = (node: InitializationNode): void => {
      const color = colors.get(node.key);
      if (color === 'visiting') invalid(label, source, `node "${node.key}" is in a parent cycle`);
      if (color === 'visited') return;
      colors.set(node.key, 'visiting');
      if (node.parentKey) visit(nodes.get(node.parentKey)!);
      colors.set(node.key, 'visited');
    };
    for (const node of nodes.values()) visit(node);

    for (const node of nodes.values()) {
      const parentKind = (node.parentKey ? nodes.get(node.parentKey)?.kind : node.rootParentKind) ?? null;
      if (allowedParent[node.kind] !== parentKind) {
        const parentLabel = node.parentKey ? `parent "${node.parentKey}"` : 'root';
        invalid(label, source, `node "${node.key}" has invalid ${parentLabel} kind for ${node.kind}`);
      }
    }
  }

  const phasesByName = new Map<string, InitializationPhase>();
  const phaseNamesBySource = new Map<string, Set<string>>();
  for (const phase of graph.phases) {
    const name = normalizedName(phase.name);
    const sourceNames = phaseNamesBySource.get(phase.source) ?? new Set<string>();
    if (sourceNames.has(name)) invalid(label, phase.source, `duplicate phase name "${phase.name.trim()}"`);
    sourceNames.add(name);
    phaseNamesBySource.set(phase.source, sourceNames);

    const existing = phasesByName.get(name);
    if (
      existing &&
      (existing.order !== phase.order || existing.plannedStart !== phase.plannedStart || existing.plannedEnd !== phase.plannedEnd)
    ) {
      invalid(label, phase.source, `phase "${phase.name.trim()}" conflicts with ${existing.source}`);
    }
    if (!existing) phasesByName.set(name, phase);
  }

  for (const activity of graph.activities) {
    const nodes = nodesBySource.get(activity.source) ?? new Map<string, InitializationNode>();
    if (activity.nodeKey && !nodes.has(activity.nodeKey)) {
      invalid(label, activity.source, `activity "${activity.name}" has missing node key "${activity.nodeKey}"`);
    }
    if (activity.phaseName && !phasesByName.has(normalizedName(activity.phaseName))) {
      invalid(label, activity.source, `activity "${activity.name}" has missing phase "${activity.phaseName}"`);
    }
  }

  for (const inspection of graph.inspections) {
    const nodes = nodesBySource.get(inspection.source) ?? new Map<string, InitializationNode>();
    if (inspection.nodeKey && !nodes.has(inspection.nodeKey)) {
      invalid(label, inspection.source, `inspection "${inspection.title}" has missing node key "${inspection.nodeKey}"`);
    }
  }
}

export async function lockInitializationDisplayIds(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'project-init-display-id:activity'}, 0))`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'project-init-display-id:inspection'}, 0))`);
}

type SerializableRunner = Pick<PrismaClient, '$transaction'>;
type Sleep = (delayMs: number) => Promise<void>;

const defaultSleep: Sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export async function runSerializableProjectInit<T>(
  prisma: SerializableRunner,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  sleep: Sleep = defaultSleep,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2034' || attempt === 2) throw error;
      const baseDelay = attempt === 0 ? 25 : 75;
      await sleep(baseDelay + Math.floor(random() * 26));
    }
  }
  throw new Error('project initialization retry invariant violated');
}
