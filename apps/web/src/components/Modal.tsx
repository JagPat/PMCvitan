import { useEffect, useRef, type ReactNode } from 'react';
import { useFocusTrap } from '@/lib/useFocusTrap';

/** Centered modal with backdrop, Escape-to-close, click-outside-to-close and
 *  the shared focus trap (Wave 0 / F-1a): focus moves in on open, Tab cycles
 *  inside, and focus returns to the opener on close. */
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
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
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-surface="light"
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
