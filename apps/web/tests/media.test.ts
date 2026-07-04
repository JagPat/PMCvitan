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
    const before = s().dailyLog.progress;
    s().addProgressPhoto(PNG);
    expect(s().dailyLog.photos[0].url).toBe(PNG);
    expect(s().dailyLog.photos[0].id).toBeUndefined();
    expect(s().dailyLog.progress).toBe(before + 1);
  });

  it('ignores a non-data-URL string (no photo added)', () => {
    s().addProgressPhoto('not-a-data-url');
    expect(s().dailyLog.photos).toHaveLength(0);
  });
});

describe('addProgressPhoto — API mode', () => {
  it('uploads the base64 payload and stores the returned media ref', async () => {
    const gw = { uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG);
    expect(gw.uploadMedia).toHaveBeenCalledWith({ kind: 'progress', mime: 'image/png', data: 'iVBORw0KGgo=' });

    await flush();
    expect(s().dailyLog.photos[0]).toEqual({ id: 'm1', url: '/media/m1' });
    expect(s().dailyLog.progress).toBe(3); // seed 2 + 1
  });

  it('surfaces a failure without adding a photo', async () => {
    const gw = { uploadMedia: vi.fn().mockRejectedValue(new Error('media 500')) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addProgressPhoto(PNG);
    await flush();
    expect(s().dailyLog.photos).toHaveLength(0);
    expect(s().toast).toMatch(/could not upload/i);
  });
});
