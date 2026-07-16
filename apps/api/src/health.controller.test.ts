import { describe, it, expect, vi } from 'vitest';
import { HealthController } from './health.controller';
import type { OutboxOperationsService } from './platform/outbox/outbox-operations.service';

/** PR B Task 4 — /health surfaces aggregate outbox diagnostics and NEVER fails liveness. */
describe('HealthController — fail-soft outbox diagnostics', () => {
  it('reports aggregate outbox metrics when the diagnostic query succeeds', async () => {
    const ops = { metrics: vi.fn().mockResolvedValue({ pending: 2, leased: 0, dead: 1, blocked: 1, oldestPendingSeconds: 42 }) } as unknown as OutboxOperationsService;
    const r = await new HealthController(ops).health();
    expect(r).toMatchObject({ ok: true, outboxAvailable: true, outboxDead: 1, outboxBlocked: 1, outboxOldestPendingSeconds: 42 });
    expect(typeof r.uptime).toBe('number');
  });

  it('fails soft — ok:true, outboxAvailable:false, no metrics — when the diagnostic query throws', async () => {
    const ops = { metrics: vi.fn().mockRejectedValue(new Error('db unreachable')) } as unknown as OutboxOperationsService;
    const r = await new HealthController(ops).health();
    expect(r.ok).toBe(true); // liveness never fails on a diagnostic error (no restart loop)
    expect(r.outboxAvailable).toBe(false);
    expect(r.outboxDead).toBeUndefined();
  });
});
