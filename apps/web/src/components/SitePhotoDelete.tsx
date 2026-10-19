import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { sitePhotoDeletable, sitePhotoLabels as L, type Photo } from '@vitan/shared';

const small = { border: 'none', borderRadius: 6, padding: '6px 12px', minHeight: 44, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 11, cursor: 'pointer' } as const;

/**
 * #482 site photos (Board, 14 Oct 2026) — the Delete on a photo the server says the viewer may delete: a member's own
 * site photo for an hour after it was recorded, and for the PMC and the engineer any photo no record keeps. Asks once
 * before deleting, because a delete does not come back. A member's is gone when the hour is up.
 */
export function SitePhotoDelete({ photo }: { photo: Photo }) {
  const lang = useStore((s) => s.lang);
  const deleteSitePhoto = useStore((s) => s.deleteSitePhoto);
  const [now, setNow] = useState(() => Date.now());
  const [asking, setAsking] = useState(false);
  // on its way to the server: nothing to tap until it answers (Codex 4317884827)
  const [deleting, setDeleting] = useState(false);
  const deletable = sitePhotoDeletable(photo, now);

  // the button leaves on its own when the hour is up
  useEffect(() => {
    if (!deletable || !photo.deletableUntil) return;
    const left = Date.parse(photo.deletableUntil) - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, left) + 50);
    return () => clearTimeout(timer);
  }, [deletable, photo.deletableUntil]);

  if (!deletable || deleting) return null;
  if (!asking) {
    return (
      <button type="button" data-testid="site-photo-delete" onClick={() => setAsking(true)}
        style={{ ...small, marginTop: 6, background: 'transparent', color: 'var(--red-solid)', padding: '6px 0' }}>
        {L.delete[lang]}
      </button>
    );
  }
  return (
    <div data-testid="site-photo-delete-confirm" style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600 }}>{L.confirmDelete[lang]}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        <button type="button" data-testid="site-photo-delete-yes"
          onClick={() => {
            setAsking(false);
            setDeleting(true);
            void deleteSitePhoto(photo.id).finally(() => setDeleting(false));
          }}
          style={{ ...small, background: 'var(--red-solid)', color: '#fff' }}>
          {L.delete[lang]}
        </button>
        <button type="button" data-testid="site-photo-delete-keep" onClick={() => setAsking(false)}
          style={{ ...small, background: 'transparent', color: 'inherit', border: '1px solid var(--hairline)' }}>
          {L.keep[lang]}
        </button>
      </div>
    </div>
  );
}
