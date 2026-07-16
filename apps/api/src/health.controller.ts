import { Controller, Get } from '@nestjs/common';
import { OutboxOperationsService } from './platform/outbox/outbox-operations.service';

/**
 * Public process-health probe (Phase 0 Task 8) — used by the API-backed Playwright harness and
 * deploy smoke checks to wait for the server. It verifies the process is serving requests and adds
 * FAIL-SOFT outbox diagnostics (PR B Task 4): aggregate dead/blocked/oldest-pending counts, never
 * event payloads or push secrets. A diagnostic-query failure returns `outboxAvailable: false` with
 * HTTP 200 — it never fails liveness or triggers a restart loop.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly ops: OutboxOperationsService) {}

  @Get()
  async health(): Promise<{
    ok: true; uptime: number; outboxAvailable: boolean;
    outboxDead?: number; outboxBlocked?: number; outboxOldestPendingSeconds?: number | null;
  }> {
    const base = { ok: true as const, uptime: process.uptime() };
    try {
      const m = await this.ops.metrics();
      return { ...base, outboxAvailable: true, outboxDead: m.dead, outboxBlocked: m.blocked, outboxOldestPendingSeconds: m.oldestPendingSeconds };
    } catch {
      // fail-soft: the process is alive even if the outbox diagnostic query failed
      return { ...base, outboxAvailable: false };
    }
  }
}
