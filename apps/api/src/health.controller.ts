import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get } from '@nestjs/common';
import { OutboxOperationsService } from './platform/outbox/outbox-operations.service';

/**
 * Public process-health probe (Phase 0 Task 8) — used by the API-backed Playwright harness and
 * deploy smoke checks to wait for the server. It verifies the process is serving requests and adds
 * FAIL-SOFT outbox diagnostics (PR B Task 4): aggregate dead/blocked/oldest-pending counts, never
 * event payloads or push secrets. A diagnostic-query failure returns `outboxAvailable: false` with
 * HTTP 200 — it never fails liveness or triggers a restart loop.
 */
/** The behaviours this server advertises to a separately deployed web bundle, which must check for one
 *  before relying on it: the web and API deploy separately, so a bundle can reach an older API. `orgs.createProject.receipt`: a
 *  project create under an `Idempotency-Key` keeps a receipt, so a retry under the same key answers
 *  with the first create's project instead of making a second. */
export const SERVER_FEATURES = ['orgs.createProject.receipt'] as const;

export interface BuildInfo { commit: string; commitShort: string; builtAt: string }

const UNKNOWN_BUILD: BuildInfo = { commit: 'unknown', commitShort: 'unknown', builtAt: 'unknown' };

/** The deployed build (owner direction 2026-10-08): `dist/build-info.json`, written by the Dockerfile at
 *  BUILD time from Coolify's `SOURCE_COMMIT` (scripts/build-info.mjs), never read from git at runtime.
 *  Only the three fields are passed through, and only in their expected shape, so nothing else in the
 *  file can reach /health; a missing or malformed file reads "unknown". */
export function readBuildInfo(path = join(__dirname, 'build-info.json')): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const commit = typeof raw.commit === 'string' && /^[0-9a-f]{7,40}$/.test(raw.commit) ? raw.commit : 'unknown';
    const builtAt = typeof raw.builtAt === 'string' && !Number.isNaN(Date.parse(raw.builtAt)) ? raw.builtAt : 'unknown';
    return { commit, commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 7), builtAt };
  } catch {
    return UNKNOWN_BUILD;
  }
}

const BUILD = readBuildInfo();

@Controller('health')
export class HealthController {
  constructor(private readonly ops: OutboxOperationsService) {}

  @Get()
  async health(): Promise<{
    ok: true; uptime: number; features: readonly string[]; outboxAvailable: boolean;
    commit: string; commitShort: string; builtAt: string;
    outboxDead?: number; outboxBlocked?: number; outboxOldestPendingSeconds?: number | null;
  }> {
    const base = { ok: true as const, uptime: process.uptime(), features: SERVER_FEATURES, ...BUILD };
    try {
      const m = await this.ops.metrics();
      return { ...base, outboxAvailable: true, outboxDead: m.dead, outboxBlocked: m.blocked, outboxOldestPendingSeconds: m.oldestPendingSeconds };
    } catch {
      // fail-soft: the process is alive even if the outbox diagnostic query failed
      return { ...base, outboxAvailable: false };
    }
  }
}
