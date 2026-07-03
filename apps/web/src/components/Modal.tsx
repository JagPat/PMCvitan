import { useEffect, type ReactNode } from 'react';

/** Centered modal with backdrop, Escape-to-close and click-outside-to-close. */
export function Modal({
  onClose,
  children,
  maxWidth = 420,
  labelledBy,
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  labelledBy?: string;
}) {
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
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(35,33,28,.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        animation: 'vfade .18s',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--panel)',
          borderRadius: 18,
          maxWidth,
          width: '100%',
          overflow: 'hidden',
          boxShadow: 'var(--sh-modal)',
          animation: 'vpop .22s',
        }}
      >
        {children}
      </div>
    </div>
  );
}
