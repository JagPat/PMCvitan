import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('addProgressPhoto — local demo (no API)', () => {
  it('keeps the data URL as the photo and bumps the count', () => {
    const before = s().dailyLog!.progress;
    s().addProgressPhoto(PNG);
    expect(s().dailyLog!.photos[0].url).toBe(PNG);
    expect(s().dailyLog!.photos[0].id).toBeUndefined();
    expect(s().dailyLog!.progress).toBe(before + 1);
  });

  it('ignores a non-data-URL string (no photo added)', () => {
    s().addProgressPhoto('not-a-data-url');
    expect(s().dailyLog!.photos).toHaveLength(0);
  });
});

describe('addProgressPhoto — API mode', () => {
  it('uploads the base64 payload and stores the returned media ref', async () => {
    const gw = { uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG);
    expect(gw.uploadMedia).toHaveBeenCalledWith({ kind: 'progress', mime: 'image/png', data: 'iVBORw0KGgo=' });

    await flush();
    expect(s().dailyLog!.photos[0]).toEqual({ id: 'm1', url: '/media/m1' });
    expect(s().dailyLog!.progress).toBe(3); // seed 2 + 1
  });

  it('surfaces a failure without adding a photo', async () => {
    const gw = { uploadMedia: vi.fn().mockRejectedValue(new Error('media 500')) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG);
    await flush();
    expect(s().dailyLog!.photos).toHaveLength(0);
    expect(s().toast).toMatch(/could not upload/i);
  });
});

/**
 * Unit B — the stamp reaches the media contract, and reaching it costs nothing.
 *
 * The rejected shape of this work put an `await` (a geolocation read, up to 1.5s, behind an
 * unbounded permission query) between accepting a photo and queueing it. A reload in that
 * window lost the photo outright. The stamp is computed by the caller from bytes it had
 * already read, so this action stays synchronous end to end.
 */
describe('addProgressPhoto — the photo carries its own stamp', () => {
  const STAMP = { takenAt: '11 Aug 2026 · 9:15 AM', geoLat: 23.03, geoLng: 72.57 };

  it('sends the stamp the photo recorded', () => {
    const gw = { uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG, null, STAMP);
    expect(gw.uploadMedia).toHaveBeenCalledWith({ kind: 'progress', mime: 'image/png', data: 'iVBORw0KGgo=', ...STAMP });
  });

  it('sends no stamp keys at all when the photo recorded nothing', () => {
    const gw = { uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG, null, {});
    // absent, not null and not invented — the column stays empty
    expect(gw.uploadMedia).toHaveBeenCalledWith({ kind: 'progress', mime: 'image/png', data: 'iVBORw0KGgo=' });
  });

  it('queues an offline photo SYNCHRONOUSLY, stamp included', () => {
    s()._setGateway({ uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; st.outbox = []; });

    s().addProgressPhoto(PNG, null, STAMP);

    // no await here on purpose: nothing may sit between taking the photo in and
    // making it durable, or a reload in that window loses it
    const queued = s().outbox.filter((o) => o.t === 'uploadMedia');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ input: { ...STAMP, kind: 'progress' } });
  });

  it('says what the photo carried, not what the feature is called', async () => {
    const gw = { uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG, null, {});
    await flush();
    expect(s().toast).toBe('Progress photo uploaded — visible to PMC.');

    s().addProgressPhoto(PNG, null, STAMP);
    await flush();
    expect(s().toast).toMatch(/stamped from the photo/);
  });
});
