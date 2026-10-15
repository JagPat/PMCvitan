import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { pathOf } from '@/lib/locationTree';
import { pickProgressPhoto } from '@/lib/pickProgressPhoto';
import { dailyLogSendPending } from '@/store/dailyLogPending';
import { Camera } from '@/lib/icons';
import { can, sitePhotoLabels as L } from '@vitan/shared';

/**
 * One button any member the server lets upload uses to add a site photo to today's record, with an
 * optional place. The place list is the published places only; no place is created from here.
 */
export function AddSitePhoto() {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const nodes = useStore(useShallow((s) => s.nodes));
  // as on the Daily Log: while the day's log is being sent, a photo would miss the count that send froze
  const sending = useStore(dailyLogSendPending);
  const fileRef = useRef<HTMLInputElement>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  if (!can('media.upload', role)) return null;

  const places = nodes
    .filter((n) => !n.draft)
    .map((n) => ({ id: n.id, label: pathOf(nodes, n.id).join(' › ') }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // a place removed or unpublished since it was chosen falls back to no place, so the photo still uploads
  const placeId = places.some((p) => p.id === nodeId) ? nodeId : null;

  return (
    <div data-guide="add-site-photo" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
      {/* No `capture`: on Android it forces the camera and hides the gallery. The stamp comes from
          the photo's own EXIF (lib/exif.ts), so a gallery pick is stamped just as honestly. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        data-testid="add-site-photo-file"
        style={{ display: 'none' }}
        onChange={(e) => {
          pickProgressPhoto(e.target.files?.[0], placeId);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={sending}
        data-testid="add-site-photo"
        style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', padding: '10px 14px', minHeight: 44, borderRadius: 9, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <Camera size={14} /> {L.add[lang]}
      </button>
      {places.length > 0 && (
        <select
          aria-label={L.place[lang]}
          data-testid="add-site-photo-place"
          value={placeId ?? ''}
          onChange={(e) => setNodeId(e.target.value || null)}
          style={{ height: 44, maxWidth: '100%', padding: '0 10px', borderRadius: 9, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--ink)' }}
        >
          <option value="">{L.place[lang]}</option>
          {places.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}
