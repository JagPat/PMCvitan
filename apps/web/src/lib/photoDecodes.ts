/**
 * Whether this device can open a photo for marking: its browser decodes the file's type. The server accepts HEIC and
 * HEIF (iPhone photos), which only some browsers decode, so a caller asks before it offers markup (#1006). It reads the
 * bytes locally and sends nothing. `signal` bounds it (M3): once aborted it answers false at once, the image stops
 * loading and its object URL is let go then, so a decode that never answers holds nothing.
 */
export async function photoDecodes(blob: Blob, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const url = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => { if (!revoked) { revoked = true; URL.revokeObjectURL(url); } };
  try {
    return await new Promise<boolean>((resolve) => {
      const img = new Image();
      const settle = (ok: boolean) => {
        img.onload = null;
        img.onerror = null;
        signal?.removeEventListener('abort', aborted);
        resolve(ok);
      };
      function aborted() {
        settle(false);
        img.src = '';
        revoke();
      }
      signal?.addEventListener('abort', aborted, { once: true });
      img.onload = () => settle(true);
      img.onerror = () => settle(false);
      img.src = url;
    });
  } finally {
    setTimeout(revoke, 0);
  }
}
