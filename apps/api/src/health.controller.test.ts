import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { HealthController, readBuildInfo } from './health.controller';
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

  it('advertises the keyed project-create receipt in both branches, for the separately deployed web bundle', async () => {
    const up = { metrics: vi.fn().mockResolvedValue({ pending: 0, leased: 0, dead: 0, blocked: 0, oldestPendingSeconds: null }) } as unknown as OutboxOperationsService;
    const down = { metrics: vi.fn().mockRejectedValue(new Error('db unreachable')) } as unknown as OutboxOperationsService;
    expect((await new HealthController(up).health()).features).toContain('orgs.createProject.receipt');
    expect((await new HealthController(down).health()).features).toContain('orgs.createProject.receipt');
  });
});

describe('HealthController — deployed build', () => {
  const file = (content: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'build-info-')), 'build-info.json');
    writeFileSync(path, content);
    return path;
  };

  it('reads the build-time commit and time, and passes nothing else through', () => {
    const sha = 'a08f896' + '0'.repeat(33);
    const info = readBuildInfo(file(JSON.stringify({ commit: sha, builtAt: '2026-10-08T12:00:00.000Z', secret: 'x' })));
    expect(info).toEqual({ commit: sha, commitShort: 'a08f896', builtAt: '2026-10-08T12:00:00.000Z' });
  });

  it('reads "unknown" for a missing file, a malformed file or a non-hex commit', () => {
    const unknown = { commit: 'unknown', commitShort: 'unknown', builtAt: 'unknown' };
    expect(readBuildInfo(join(tmpdir(), 'no-such-dir', 'build-info.json'))).toEqual(unknown);
    expect(readBuildInfo(file('not json'))).toEqual(unknown);
    expect(readBuildInfo(file(JSON.stringify({ commit: 'DATABASE_URL=x', builtAt: 'later' })))).toEqual(unknown);
  });

  it('includes commit, commitShort and builtAt on /health', async () => {
    const ops = { metrics: vi.fn().mockRejectedValue(new Error('db unreachable')) } as unknown as OutboxOperationsService;
    const r = await new HealthController(ops).health();
    expect(r).toHaveProperty('commit');
    expect(r).toHaveProperty('commitShort');
    expect(r).toHaveProperty('builtAt');
  });
});
