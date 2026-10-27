import { useRef } from 'react';
import { useStore } from '@/store/store';
import { pickProgressPhoto } from '@/lib/pickProgressPhoto';
import { dailyLogSendPending } from '@/store/dailyLogPending';
import { todayCivil } from '@/lib/civilDate';
import { dailyLogReadMode } from '@/data/apiGateway';
import { Camera } from '@/lib/icons';
import { can, sitePhotoLabels as L } from '@vitan/shared';

/**
 * #482 site photos — one button any member the server lets upload uses to add a site photo to today's record.
 */
export function AddSitePhoto() {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  // as on the Daily Log: while the day's log is being sent, a photo would miss the count that send froze
  const sending = useStore(dailyLogSendPending);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!can('media.upload', role)) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      {/* No `capture`: on Android it forces the camera and hides the gallery. The stamp comes from
          the photo's own EXIF (lib/exif.ts), so a gallery pick is stamped just as honestly. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        data-testid="add-site-photo-file"
        style={{ display: 'none' }}
        onChange={(e) => {
          // filed on the day's log only when it is TODAY's: the latest log can be one sent on an earlier day, and a
          // photo taken now is never added to that record (#482). Under the module read the log in the store is only
          // trusted once that read has settled: before it (or after it failed) the store can still hold a log the
          // server has since replaced, so the photo goes up unfiled rather than onto the wrong record.
          const { dailyLog, dailyLogLoad, timeZone } = useStore.getState();
          const settled = dailyLogReadMode() !== 'moduleQuery' || dailyLogLoad === 'ready';
          const forLog = settled && dailyLog?.id && dailyLog.logDate === todayCivil(timeZone) ? dailyLog.id : null;
          pickProgressPhoto(e.target.files?.[0], null, forLog);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={sending}
        data-testid="add-site-photo"
        // #482 in-app guide: the button itself, so the coach mark fits it and a greyed-out button is not pointed at
        data-guide="add-site-photo"
        style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', padding: '10px 14px', minHeight: 44, borderRadius: 9, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <Camera size={14} /> {L.add[lang]}
      </button>
    </div>
  );
}
