/**
 * Whether this device can open a photo for marking: its browser decodes the file's type. The server accepts HEIC and
 * HEIF (iPhone photos), which only some browsers decode, so a caller asks before it offers markup (#1006). It reads the
 * bytes locally and sends nothing.
 */
export async function photoDecodes(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
