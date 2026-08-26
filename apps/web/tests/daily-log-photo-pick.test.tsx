import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { DailyLog } from '@vitan/shared';

/**
 * Codex F1 on `20311f92` — the picker must not yield again before queueing the photo.
 *
 * The rejected shape read the file a SECOND time (`file.slice().arrayBuffer()`) to find EXIF,
 * suspending the handler after the data URL was already in hand. In that window a project
 * switch redirects the upload — `gateway` is a mutable module binding — and a reload loses the
 * selection outright. The stamp now comes from the bytes the first read already produced, so
 * `addProgressPhoto` is reached in the SAME turn as `reader.onload`.
 *
 * The probe asserts exactly that: no `await`, no timer, no flush between the read completing
 * and the store being called.
 */

const log = (): DailyLog => ({
  date: '11 Aug 2026', logDate: '2026-08-11', checkedIn: true, checkinTime: '09:00', submitted: false,
  progress: 0, crew: [], materials: [], photos: [],
});

/** A FileReader whose `onload` fires the moment the test releases it, synchronously. */
function stubFileReader(dataUrl: string): { release: () => void } {
  let fire: () => void = () => {};
  class SyncFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL() {
      fire = () => {
        this.result = dataUrl;
        this.onload?.();
      };
    }
  }
  vi.stubGlobal('FileReader', SyncFileReader);
  return { release: () => fire() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('picking a progress photo reaches the store in one turn', () => {
  it('calls addProgressPhoto synchronously from the read, with the photo’s own stamp', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'villa-b',
      projectLoadState: 'ready',
      role: 'engineer',
      dailyLog: log(),
    });

    const addProgressPhoto = vi.fn();
    useStore.setState({ addProgressPhoto } as never);

    // a real JPEG carrying a real EXIF capture time, so the stamp is not a stub
    const { readExif } = await import('@/lib/exif');
    const jpeg = jpegWithCaptureTime();
    expect(readExif(jpeg)?.takenAtLocal).toBe('2026:08:11 09:15:30');

    const { release } = stubFileReader(dataUrlOf(jpeg));
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);

    const input = r.getByTestId('progress-file');
    fireEvent.change(input, { target: { files: [new File([], 'site.jpg', { type: 'image/jpeg' })] } });

    release(); // the read completes — everything after this must happen in THIS turn

    // deliberately no await, no flush, no timer: a yield here would hide the defect
    expect(addProgressPhoto).toHaveBeenCalledTimes(1);
    const [, , stamp] = addProgressPhoto.mock.calls[0];
    expect(stamp).toEqual({ takenAt: '11 Aug 2026 · 9:15 AM' });
  });
});

// ---- a JPEG with one EXIF DateTimeOriginal, built rather than checked in ----

function jpegWithCaptureTime(): Uint8Array {
  const ascii = [...'2026:08:11 09:15:30'].map((c) => c.charCodeAt(0)).concat(0);
  const ifd0Size = 2 + 12 + 4;
  const exifIfdAt = 8 + ifd0Size;
  const exifIfdSize = 2 + 12 + 4;
  const asciiAt = exifIfdAt + exifIfdSize;

  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) => tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);

  tiff.push(0x49, 0x49); u16(42); u32(8);            // 'II', magic, IFD0 at 8
  u16(1); u16(0x8769); u16(4); u32(1); u32(exifIfdAt); u32(0);   // IFD0 → Exif IFD
  u16(1); u16(0x9003); u16(2); u32(ascii.length); u32(asciiAt); u32(0); // DateTimeOriginal
  tiff.push(...ascii);

  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const size = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, size >> 8, size & 0xff, ...payload, 0xff, 0xd9]);
}

function dataUrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
