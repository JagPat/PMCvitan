/**
 * When and where a photo was taken.
 *
 * The daily log has always told the user its progress photos are "geo + time stamped".
 * They were not: `UploadMediaInput` accepts `takenAt`, `geoLat` and `geoLng`, and the
 * store sent none of them. This is the smallest thing that makes the claim true.
 *
 * Three rules shape it:
 *
 *  - **Never prompt during a capture.** Coordinates are read ONLY when the browser
 *    already holds a granted geolocation permission. A permission dialog thrown up
 *    between the shutter and the save is exactly the friction this work exists to
 *    remove, and a user who has not granted location should still get their photo.
 *  - **Never delay a capture.** The position lookup is bounded; on timeout, denial, an
 *    older browser with no Permissions API, or any error, the stamp degrades to the time
 *    alone. A photo is never lost or held up for want of a coordinate.
 *  - **Never claim more than the file supports.** `capture="environment"` is a hint, not
 *    a restriction: the picker can always return an existing gallery image. Stamping one
 *    with the wall-clock moment it was *selected* would file an old site photo under
 *    today, which is worse than no stamp at all — it is a false one, and it is the
 *    ordering the whole daily log reads by. So the time comes from the FILE when the file
 *    carries one, and the coordinates are attached only to a live capture (below).
 */
export interface CaptureStamp {
  takenAt: string;
  geoLat?: number;
  geoLng?: number;
}

/** What the picker knows about the chosen file. `File` satisfies this structurally. */
export interface CaptureSource {
  /** `File.lastModified`, epoch ms — the file's own recorded time. */
  lastModified?: number;
}

/** How long a position read may take before the photo goes without one. */
const POSITION_TIMEOUT_MS = 1500;

/**
 * How far behind "now" a file's own time may be and still be treated as a live capture.
 * Generous enough to cover a slow read and a slow save, far short of a photo picked out
 * of the gallery hours or days later.
 */
const LIVE_CAPTURE_MS = 2 * 60_000;

export async function captureStamp(
  source?: CaptureSource | null,
  now: () => Date = () => new Date(),
): Promise<CaptureStamp> {
  const at = now();
  const fileTime = usableFileTime(source, at);
  const takenAt = (fileTime ?? at).toISOString();
  // A photo taken days ago was not taken where the device is standing now. Coordinates
  // read at selection time would be a second false claim on top of the first, so an
  // older file carries its time alone — and skipping the lookup makes the pick faster.
  if (fileTime && at.getTime() - fileTime.getTime() > LIVE_CAPTURE_MS) return { takenAt };
  const position = await grantedPosition();
  if (!position) return { takenAt };
  return { takenAt, geoLat: position.coords.latitude, geoLng: position.coords.longitude };
}

/**
 * The file's own recorded time, or null to fall back to now.
 *
 * This is `lastModified`, not an EXIF capture time: for a photo the camera has just
 * written it IS the moment of capture, and for one picked from the gallery it is that
 * file's own time rather than today's. Parsing EXIF to do better is a bigger change than
 * this correction; what matters here is that the value is never simply invented.
 *
 * A missing, zero or non-finite value tells us nothing. A value in the future (a device
 * clock running ahead) is refused too — evidence dated after the moment it was filed is
 * not a stamp anyone can read.
 */
function usableFileTime(source: CaptureSource | null | undefined, at: Date): Date | null {
  const ms = source?.lastModified;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms > at.getTime()) return null;
  return new Date(ms);
}

/** The current position, but only if location is ALREADY granted — never a fresh prompt. */
async function grantedPosition(): Promise<GeolocationPosition | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions) return null;
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    // 'prompt' is a no: asking is what we are refusing to do here.
    if (status.state !== 'granted') return null;
    return await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        () => resolve(null),
        { timeout: POSITION_TIMEOUT_MS, maximumAge: 60_000 },
      );
    });
  } catch {
    // a browser without the Permissions API, or one that throws on an unknown name
    return null;
  }
}
