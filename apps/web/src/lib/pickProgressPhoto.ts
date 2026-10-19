import { useStore } from '@/store/store';
import { captureStamp } from '@/lib/captureStamp';
import { projectScopeOf } from '@/store/projectScope';

/**
 * Reads a chosen photo and hands it to the store as a site photo, filed to `nodeId` when one is chosen.
 * Shared by every "add a photo" control so each files the same way.
 */
export function pickProgressPhoto(file: File | null | undefined, nodeId: string | null): void {
  if (!file) return;
  // The scope this photo was CHOSEN in, captured before the read begins. `readAsDataURL`
  // is an async boundary the store cannot see across: by the time `onload` fires the user
  // may have switched projects and `useApiSync` may have installed another gateway, and
  // this photo would then be filed under a project it has nothing to do with.
  const pickedIn = projectScopeOf(useStore.getState());
  // and the day's log on screen, for the same reason: a refresh may bring another log before `onload` (#482)
  const pickedForLog = useStore.getState().dailyLog?.id ?? null;
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== 'string') return;
    // The photo's OWN capture metadata, taken from the bytes this read already produced.
    // No `await` on this path on purpose: a second yield here — even one as innocent as
    // `file.slice().arrayBuffer()` — would suspend between the user choosing a photo and
    // the store queueing it, a window in which a project switch redirects the upload and
    // a reload loses the photo. `captureStamp` decodes the head of the data URL instead.
    useStore.getState().addProgressPhoto(reader.result, nodeId, captureStamp(reader.result), pickedIn, pickedForLog);
  };
  reader.readAsDataURL(file);
}
