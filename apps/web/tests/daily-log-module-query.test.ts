import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleDailyLog } from '@/data/apiGateway';
import { enabledScreensFor, SCREEN_MODULE } from '@/lib/screens';
import type { DailyLog, Material } from '@vitan/shared';

/**
 * Phase 2 Task 10 — the frontend cutover for the daily-log module: manifest-driven nav + the
 * module-owned daily-log read under XOR read-ownership. The read mode is a capability flag
 * (VITE_DAILYLOG_READ) that DEFAULTS to 'snapshot' (the snapshot slice owns `dailyLog` + `materials`,
 * unchanged); 'moduleQuery' flips ownership to the module-owned `GET …/daily-log` read — fetched under
 * the SAME snapshot scope lease — and the snapshot's daily-log slice is then IGNORED. The media
 * progress PHOTOS are composed from the snapshot in BOTH modes (media owns them, not daily-log).
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const mat = (name: string): Material => ({ id: name, name, qty: '1', zone: 'GF', matched: true, swatch: 'tile' });
const core = (progress: number): Omit<DailyLog, 'photos'> => ({
  date: '01 Jun 2026', logDate: '2026-06-01', checkedIn: true, checkinTime: '09:00', submitted: true, progress,
  crew: [{ trade: 'Mason', count: 4 }], materials: [],
});

function makeSnapshot(dailyLog: DailyLog | null, materials: Material[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [],
    activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog, notifications: [], companies: [], nodes: [], photos: [], materials,
  };
}

describe('Task 10 — manifest-driven nav (daily-log screen)', () => {
  it('hides the daily-log screen when the daily-log module is DISABLED, keeps it when enabled', () => {
    expect(SCREEN_MODULE['daily-log']).toBe('daily-log');
    const withDaily = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'];
    const withoutDaily = withDaily.filter((m) => m !== 'daily-log');
    expect(enabledScreensFor('engineer', withDaily).map((m) => m.key)).toContain('daily-log');
    expect(enabledScreensFor('engineer', withoutDaily).map((m) => m.key)).not.toContain('daily-log');
  });
});

describe('Task 10 — module-owned daily-log read (XOR)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('DEFAULT (snapshot mode): the snapshot slice owns dailyLog + materials; no module fetch', async () => {
    const snapLog = { ...core(10), photos: [] } as DailyLog;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(snapLog, [mat('SNAP-MAT')])),
      dailyLog: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog?.progress).toBe(10);
    expect(s().materials.map((m) => m.name)).toEqual(['SNAP-MAT']);
    expect(gw.dailyLog).not.toHaveBeenCalled(); // no module read in snapshot mode
    expect(s().dailyLogLoad).toBe('idle'); // never leaves idle in snapshot mode
  });

  it('moduleQuery mode: the module read OWNS dailyLog + materials; the snapshot slice is IGNORED', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    // the snapshot carries the media progress photos (media-owned); its log CORE + materials are ignored
    const snapLog = { ...core(99), photos: [{ id: 'ph1', url: '/media/ph1?t=tok' }] } as DailyLog;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(snapLog, [mat('SNAP-IGNORED')])),
      dailyLog: vi.fn().mockResolvedValue({ dailyLog: core(42), materials: [mat('MOD-MAT')], source: 'projection', generation: 3 } as ModuleDailyLog),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // XOR: the module read's core + materials win; the snapshot's slice never lands…
    expect(s().dailyLog?.progress).toBe(42);
    expect(s().materials.map((m) => m.name)).toEqual(['MOD-MAT']);
    // …but the media progress PHOTOS are still composed from the snapshot (media owns them)
    expect(s().dailyLog?.photos.map((p) => p.id)).toEqual(['ph1']);
    expect(s().dailyLogLoad).toBe('ready');
    expect(s().dailyLogSource).toBe('projection');
    expect(gw.dailyLog).toHaveBeenCalledTimes(1);
  });

  it('moduleQuery mode: a FAILED module read exposes an error state and keeps the last-good slice', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    const snapLog = { ...core(99), photos: [] } as DailyLog;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(snapLog, [mat('SNAP-IGNORED')])),
      dailyLog: vi.fn().mockResolvedValueOnce({ dailyLog: core(7), materials: [mat('GOOD-MAT')], source: 'live', generation: null } as ModuleDailyLog),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().materials.map((m) => m.name)).toEqual(['GOOD-MAT']);

    // second pull: the module read fails → error state, but the good slice survives (not blanked)
    gw.dailyLog.mockRejectedValueOnce(new Error('offline'));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLogLoad).toBe('error');
    expect(s().dailyLog?.progress).toBe(7); // last-good retained
    expect(s().materials.map((m) => m.name)).toEqual(['GOOD-MAT']); // never [] nor the snapshot's
  });
});
