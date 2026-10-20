import { type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { QW } from '@/lib/queueWords';

/**
 * WEB-02 (#792): this phone holds saved updates for this project that it cannot read. They are never written over;
 * one tap copies them aside (kept on this phone) and lets new updates be saved again.
 */
export function QueueUnreadable() {
  const listed = useStore((s) => s.queueUnreadable);
  const setAside = useStore((s) => s.setAsideUnreadableQueue);
  const lang = useStore((s) => s.lang);
  if (!listed) return null;
  return (
    <div role="alert" style={strip} data-testid="queue-unreadable">
      {/* a key listed again only because a draft in it could not be copied aside reads fine: it is not called unreadable */}
      <span>{(listed.keys.every((k) => listed.readable?.includes(k)) ? QW.notSetAside : QW.unreadable)[lang]}</span>
      {listed.failed && <span data-testid="queue-unreadable-failed">{QW.setAsideFailed[lang]}</span>}
      <button type="button" style={button} onClick={setAside}>{QW.setAside[lang]}</button>
    </div>
  );
}

const strip: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
  padding: '8px 10px',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
};
const button: CSSProperties = {
  minHeight: 44,
  padding: '6px 10px',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
