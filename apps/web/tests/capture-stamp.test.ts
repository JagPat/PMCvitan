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
const AT_MS = new Date('2026-08-25T06:30:00.000Z').getTime();

/** Location already granted, and a position that resolves — so geo is attached iff asked for. */
function grantLocation(): { getCurrentPosition: ReturnType<typeof vi.fn> } {
  const getCurrentPosition = vi.fn((ok: (p: unknown) => void) => ok({ coords: { latitude: 23.03, longitude: 72.51 } }));
  vi.stubGlobal('navigator', {
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: { getCurrentPosition },
  });
  return { getCurrentPosition };
}

describe('a photo carries the stamp the daily log promises', () => {
  it('always carries its capture time', async () => {
    vi.stubGlobal('navigator', {});
    const stamp = await captureStamp(null, AT);
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z' });
  });

  it('adds coordinates when location is ALREADY granted', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'granted' }) },
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 23.03, longitude: 72.51 } }),
      },
    });
    const stamp = await captureStamp(null, AT);
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z', geoLat: 23.03, geoLng: 72.51 });
  });

  it('NEVER prompts: a permission still at "prompt" is treated as a no', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'prompt' }) },
      geolocation: { getCurrentPosition },
    });
    const stamp = await captureStamp(null, AT);
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
    const stamp = await captureStamp(null, AT);
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z' });
  });

  it('survives a browser with no Permissions API', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } });
    const stamp = await captureStamp(null, AT);
    expect(stamp.geoLat).toBeUndefined();
  });
});

/**
 * Codex F1 — `capture="environment"` is a hint, not a restriction. The picker can always
 * return an existing gallery image, and stamping that with the moment it was SELECTED files
 * an old site photo under today: a false capture time, in the field the daily log orders by.
 */
describe('a chosen file keeps its own time, not the moment it was picked', () => {
  it('takes the time from the file when the file carries one', async () => {
    vi.stubGlobal('navigator', {});
    const taken = new Date('2026-08-11T09:15:00.000Z');
    const stamp = await captureStamp({ lastModified: taken.getTime() }, AT);
    expect(stamp.takenAt).toBe('2026-08-11T09:15:00.000Z');
  });

  it('does NOT claim the current position for a photo taken days ago', async () => {
    const { getCurrentPosition } = grantLocation();
    const stamp = await captureStamp({ lastModified: new Date('2026-08-11T09:15:00.000Z').getTime() }, AT);
    // where the device stands today is not where that photo was taken — so no coordinates,
    // and no reason to spend the lookup at all
    expect(stamp).toEqual({ takenAt: '2026-08-11T09:15:00.000Z' });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('still geo-stamps a live capture, whose file time IS the moment of capture', async () => {
    grantLocation();
    const stamp = await captureStamp({ lastModified: AT_MS - 1_200 }, AT);
    expect(stamp.geoLat).toBe(23.03);
    expect(stamp.takenAt).toBe(new Date(AT_MS - 1_200).toISOString());
  });

  it('falls back to now when the file time is missing, zero or not a number', async () => {
    vi.stubGlobal('navigator', {});
    for (const source of [{}, { lastModified: 0 }, { lastModified: NaN }, { lastModified: undefined }]) {
      const stamp = await captureStamp(source as { lastModified?: number }, AT);
      expect(stamp.takenAt).toBe('2026-08-25T06:30:00.000Z');
    }
  });

  it('refuses a file time in the future — a device clock running ahead', async () => {
    vi.stubGlobal('navigator', {});
    const stamp = await captureStamp({ lastModified: AT_MS + 86_400_000 }, AT);
    expect(stamp.takenAt).toBe('2026-08-25T06:30:00.000Z');
  });
});
