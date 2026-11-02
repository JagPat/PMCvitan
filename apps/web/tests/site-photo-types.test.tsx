import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { DailyLog, Lang } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #918 — a site photo is only ever one of the types the upload takes (`RASTER_IMAGE_MIMES`, apps/api contracts.ts,
 * mirrored by `UPLOAD_IMAGE_MIMES`). The store refuses any other type before the photo is kept, queued, shown or sent, with
 * a message that says what to choose. The pickers keep `accept="image/*"` (see the last rows).
 */
await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DashboardScreen'), () => import('@/screens/DailyLogScreen'), () => import('@/guide/outcomes'));

const REFUSED = 'This photo\'s format can\'t be uploaded. Choose a JPEG, PNG or HEIC photo.';
const log = (): DailyLog => ({
  id: 'log-1', date: 'today', logDate: '2026-11-01', checkedIn: true, checkinTime: '09:00', submitted: false,
  progress: 0, photoCount: 0, myPhotoKeys: [], crew: [], materials: [], photos: [],
} as DailyLog);

async function store(opts: { api?: boolean; online?: boolean; lang?: Lang } = {}) {
  if (opts.api !== false) vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready',
    role: 'engineer', lang: opts.lang ?? 'en', online: opts.online ?? true, dailyLog: log(),
  } as never);
  const uploadMedia = vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' });
  if (opts.api !== false) useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(null), project: 'villa-b' } as never);
  return { useStore, uploadMedia };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a site photo of a type the upload does not take (#918)', () => {
  it('online: refused in the same turn, before anything is sent, kept or shown, with the message', async () => {
    const { useStore, uploadMedia } = await store();
    useStore.getState().addProgressPhoto('data:image/bmp;base64,Qk0=', null, undefined, undefined, 'log-1');
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toBe(REFUSED);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().photoUploadsSending).toEqual([]);
    expect(useStore.getState().photoUploadsInFlight).toEqual([]);
    expect(useStore.getState().dailyLog!.photos).toEqual([]);
    expect(useStore.getState().dailyLog!.progress).toBe(0);
    expect(useStore.getState().photos).toEqual([]);
  });

  it('the in-app guide\'s photo step is told it failed, for the run it was picked under', async () => {
    const { useStore } = await store();
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const told: Array<[string, number | null]> = [];
    const off = subscribeGuideOutcome((outcome, _key, run) => { told.push([outcome, run]); });
    useStore.getState().addProgressPhoto('data:image/bmp;base64,Qk0=', null, undefined, undefined, 'log-1', 7);
    off();
    expect(told).toEqual([['site-photo-add-failed', 7]]);
  });

  it('offline: nothing is queued', async () => {
    const { useStore } = await store({ online: false });
    useStore.getState().addProgressPhoto('data:image/avif;base64,AAAA', null, undefined, undefined, 'log-1');
    expect(useStore.getState().toast).toBe(REFUSED);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().syncQueue).toEqual([]);
    expect(useStore.getState().dailyLog!.photos).toEqual([]);
  });

  it('the type is compared as the server compares it: image/JPEG is refused, image/heic is taken', async () => {
    const { useStore, uploadMedia } = await store();
    useStore.getState().addProgressPhoto('data:image/JPEG;base64,AAAA');
    expect(useStore.getState().toast).toBe(REFUSED);
    useStore.getState().addProgressPhoto('data:image/heic;base64,AAAA');
    // no photo database in this test: sent in the same turn
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0]![0]).toMatchObject({ mime: 'image/heic' });
  });

  it('the local demo refuses it too, so it never shows a photo the server would refuse', async () => {
    const { useStore } = await store({ api: false });
    const before = useStore.getState().photos.length;
    useStore.getState().addProgressPhoto('data:image/svg+xml;base64,PHN2Zy8+');
    expect(useStore.getState().toast).toBe(REFUSED);
    expect(useStore.getState().photos).toHaveLength(before);
    expect(useStore.getState().dailyLog!.photos).toEqual([]);
  });

  it.each([['hi', 'इस फ़ोटो का फ़ॉर्मैट अपलोड नहीं हो सकता। JPEG, PNG या HEIC फ़ोटो चुनें।'], ['gu', 'આ ફોટાનું ફોર્મેટ અપલોડ થઈ શકતું નથી. JPEG, PNG અથવા HEIC ફોટો પસંદ કરો.']] as const)('says it in %s', async (lang, text) => {
    const { useStore } = await store({ lang });
    useStore.getState().addProgressPhoto('data:image/bmp;base64,Qk0=');
    expect(useStore.getState().toast).toBe(text);
  });
});

describe('the site photo pickers keep asking for any image (#918)', () => {
  // `image/*`, not the upload's list: naming HEIC there can stop iOS Safari from turning a library HEIC photo into the JPEG
  // every other viewer can show. The store's check above is the authority; the picker stays as it was
  it('the Dashboard\'s Add site photo', async () => {
    await store();
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('add-site-photo-file').getAttribute('accept')).toBe('image/*');
  });

  it('the Daily Log\'s progress photo', async () => {
    await store();
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect(r.getByTestId('progress-file').getAttribute('accept')).toBe('image/*');
  });
});
