import { useEffect } from 'react';
import { X } from '@/lib/icons';

/**
 * Full-screen zoomable photo viewer. Photos are first-class in the product
 * (site evidence), so any thumbnail taps open here at full size. Click the
 * backdrop or press Escape to close.
 */
export function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.86)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
    >
      <button
        onClick={onClose}
        aria-label="Close photo"
        style={{ position: 'absolute', top: 16, right: 16, width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.16)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <X size={20} />
      </button>
      <img
        src={url}
        alt="Site photo, full size"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}
      />
    </div>
  );
}
