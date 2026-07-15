import { describe, it, expect, vi } from 'vitest';
import { PhasesService } from './phases.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';

const user: AuthUser = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as AuthUser;

function make(anchor: string | null) {
  const create = vi.fn(async ({ data }: { data: unknown }) => data);
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ name: 'Priya (PMC)' })) },
    project: { findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org-test', scheduleStartDate: anchor ? new Date(`${anchor}T00:00:00.000Z`) : null })) },
    phase: { aggregate: vi.fn(async () => ({ _max: { order: 2 } })), create },
    auditLog: { create: vi.fn(async () => ({})) },
    // the platform event kernel (Phase 2 Task 4) writes through the tx — stub its stream + event steps
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  } as unknown as PrismaService;
  const svc = new PhasesService(
    prisma,
    { build: vi.fn(async () => ({})) } as unknown as SnapshotService,
    { notifyChanged: vi.fn() } as unknown as RealtimeGateway,
  );
  return { svc, create };
}

/** Codex gate finding 5: a new phase must carry REAL civil dates, not offsets alone. */
describe('PhasesService.create — canonical dates', () => {
  it('derives the civil window from the schedule anchor when only offsets are given', async () => {
    const { svc, create } = make('2026-06-01');
    await svc.create('ambli', { name: 'Finishing', plannedStart: 30, plannedEnd: 60 }, user);
    const data = create.mock.calls[0][0].data as { plannedStartDate: Date; plannedEndDate: Date };
    expect(data.plannedStartDate?.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(data.plannedEndDate?.toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('explicit ISO dates win and the legacy offsets are DERIVED from them', async () => {
    const { svc, create } = make('2026-06-01');
    await svc.create('ambli', { name: 'MEP', plannedStart: 0, plannedEnd: 0, plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-15' }, user);
    const data = create.mock.calls[0][0].data as { plannedStart: number; plannedEnd: number; plannedStartDate: Date };
    expect(data.plannedStartDate?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(data.plannedStart).toBe(61); // 2026-06-01 → 2026-08-01
    expect(data.plannedEnd).toBe(75);
  });
});
