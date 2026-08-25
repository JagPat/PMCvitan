/**
 * When and where a photo was taken.
 *
 * The daily log has always told the user its progress photos are "geo + time stamped".
 * They were not: `UploadMediaInput` accepts `takenAt`, `geoLat` and `geoLng`, and the
 * store sent none of them. This is the smallest thing that makes the claim true.
 *
 * Two rules shape it:
 *
 *  - **Never prompt during a capture.** Coordinates are read ONLY when the browser
 *    already holds a granted geolocation permission. A permission dialog thrown up
 *    between the shutter and the save is exactly the friction this work exists to
 *    remove, and a user who has not granted location should still get their photo.
 *  - **Never delay a capture.** The position lookup is bounded; on timeout, denial, an
 *    older browser with no Permissions API, or any error, the stamp degrades to the time
 *    alone. A photo is never lost or held up for want of a coordinate.
 */
export interface CaptureStamp {
  takenAt: string;
  geoLat?: number;
  geoLng?: number;
}

/** How long a position read may take before the photo goes without one. */
const POSITION_TIMEOUT_MS = 1500;

export async function captureStamp(now: () => Date = () => new Date()): Promise<CaptureStamp> {
  const takenAt = now().toISOString();
  const position = await grantedPosition();
  if (!position) return { takenAt };
  return { takenAt, geoLat: position.coords.latitude, geoLng: position.coords.longitude };
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
