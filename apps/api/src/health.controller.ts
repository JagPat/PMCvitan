import { Controller, Get } from '@nestjs/common';

/**
 * Public process-health probe (Phase 0 Task 8) — used by the API-backed
 * Playwright harness and deploy smoke checks to wait for the server. It
 * verifies ONLY that the process is serving requests: no auth, no database
 * touch, no contents exposed. Readiness that checks PostgreSQL stays a
 * separate concern (the deploy runs prisma migrate before starting the app).
 */
@Controller('health')
export class HealthController {
  @Get()
  health(): { ok: true; uptime: number } {
    return { ok: true, uptime: process.uptime() };
  }
}
