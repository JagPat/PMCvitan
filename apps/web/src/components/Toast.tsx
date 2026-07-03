import { Check } from '@/lib/icons';

export function Toast({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        background: 'var(--ink)',
        color: 'var(--sidebar-text)',
        padding: '14px 20px',
        borderRadius: 12,
        boxShadow: '0 16px 40px -8px rgba(0,0,0,.5)',
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        animation: 'vpop .25s',
        maxWidth: 'min(440px, calc(100vw - 32px))',
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--green-solid)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <Check size={14} color="#fff" strokeWidth={3} />
      </span>
      <span style={{ fontSize: 13.5 }}>{message}</span>
    </div>
  );
}
