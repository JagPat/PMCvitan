import { useStore } from '@/store/store';
import { captureStamp } from '@/lib/captureStamp';
import { projectScopeOf } from '@/store/projectScope';
import { emitGuideOutcome, guideRunToken } from '@/guide/outcomes';

/**
 * Reads a chosen photo and hands it to the store as a site photo, filed to `nodeId` when one is chosen and on the
 * day's log `forLog` (null: on no log). Shared by every "add a photo" control so each files the same way.
 */
export function pickProgressPhoto(file: File | null | undefined, nodeId: string | null, forLog: string | null): void {
  if (!file) return;
  // The scope this photo was CHOSEN in, captured before the read begins. `readAsDataURL`
  // is an async boundary the store cannot see across: by the time `onload` fires the user
  // may have switched projects and `useApiSync` may have installed another gateway, and
  // this photo would then be filed under a project it has nothing to do with.
  const pickedIn = projectScopeOf(useStore.getState());
  // and the day's log, chosen by the caller now, for the same reason: a refresh may bring another log before
  // `onload` (#482)
  const pickedForLog = forLog;
  // #482 in-app guide: the guide run this photo was chosen under, before the read, so a photo chosen before a run began
  // (on this screen or another) cannot finish that run when its read ends after it
  const guideRun = guideRunToken();
  const reader = new FileReader();
  reader.onerror = () => emitGuideOutcome('site-photo-add-failed', null, guideRun);
  reader.onload = () => {
    if (typeof reader.result !== 'string') {
      emitGuideOutcome('site-photo-add-failed', null, guideRun);
      return;
    }
    // The photo's OWN capture metadata, taken from the bytes this read already produced.
    // No `await` on this path on purpose: a second yield here — even one as innocent as
    // `file.slice().arrayBuffer()` — would suspend between the user choosing a photo and
    // the store queueing it, a window in which a project switch redirects the upload and
    // a reload loses the photo. `captureStamp` decodes the head of the data URL instead.
    useStore.getState().addProgressPhoto(reader.result, nodeId, captureStamp(reader.result), pickedIn, pickedForLog, guideRun);
  };
  reader.readAsDataURL(file);
}
