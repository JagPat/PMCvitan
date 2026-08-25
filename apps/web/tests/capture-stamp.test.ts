import { describe, it, expect, afterEach, vi } from 'vitest';
import { captureStamp } from '@/lib/captureStamp';

/**
 * Unit C — the stamp a progress photo carries.
 *
 * The daily log told the user its photos were "geo + time stamped" while the store sent
 * none of `takenAt`/`geoLat`/`geoLng`, all three of which `UploadMediaInput` has always
 * accepted. These probes pin the two rules that make the claim true without making capture
 * worse: never raise a permission dialog, and never let a coordinate delay a photo.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = () => new Date('2026-08-25T06:30:00.000Z');

describe('a photo carries the stamp the daily log promises', () => {
  it('always carries its capture time', async () => {
    vi.stubGlobal('navigator', {});
    const stamp = await captureStamp(AT);
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z' });
  });

  it('adds coordinates when location is ALREADY granted', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'granted' }) },
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 23.03, longitude: 72.51 } }),
      },
    });
    const stamp = await captureStamp(AT);
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z', geoLat: 23.03, geoLng: 72.51 });
  });

  it('NEVER prompts: a permission still at "prompt" is treated as a no', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'prompt' }) },
      geolocation: { getCurrentPosition },
    });
    const stamp = await captureStamp(AT);
    expect(stamp.geoLat).toBeUndefined();
    // the point of the rule: the capture never raises a permission dialog
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('degrades to the time alone when the position read fails', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'granted' }) },
      geolocation: {
        getCurrentPosition: (_ok: unknown, fail: () => void) => fail(),
      },
    });
    const stamp = await captureStamp(AT);
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z' });
  });

  it('survives a browser with no Permissions API', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } });
    const stamp = await captureStamp(AT);
    expect(stamp.geoLat).toBeUndefined();
  });
});

